// ==UserScript==
// @name         DeepSeek 网页版翻译桥（Zotero）
// @namespace    zotero-deepseek-web-translate
// @version      0.1.7
// @description  在 chat.deepseek.com 页面里接收本地中转服务的翻译任务，自动发送并抓回译文，供 Zotero 插件使用。免费，不需要 API Key。
// @author       local
// @match        https://chat.deepseek.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * 工作原理
 * ------------------------------------------------------------------
 * 1. 每 10 秒向本地中转服务（默认 http://127.0.0.1:8765）发心跳；
 * 2. 长轮询 /v1/bridge/next 领任务；
 * 3. 把 prompt 填进 DeepSeek 输入框并发送；
 * 4. 用 MutationObserver 盯着最后一个回答块，等「停止生成」消失且文本稳定；
 * 5. 把回答回传到 /v1/bridge/result。
 *
 * DeepSeek 网页改版后如果失灵，通常只需要改下面的 SELECTORS 区域。
 */

(function () {
  'use strict';

  // ================= 可调参数 =================
  const BRIDGE = (localStorage.getItem('dswt.bridge') || 'http://127.0.0.1:8765').replace(/\/+$/, '');

  const CONFIG = {
    pollWaitSec: 25,        // 长轮询等待秒数
    heartbeatMs: 10000,     // 心跳间隔
    newChatEvery: 6,        // 同一会话最多连续翻译几段后新开对话
    stepTimeoutMs: 180000,  // 单段最长等待（全文翻译的块）
    selectionTimeoutMs: 45000, // 划词单次最长等待（比全文短，卡住要尽快报错）
    idleStableMs: 1600,     // 文本停止变化多久算结束（能识别“停止生成”按钮时）
    idleStableFallbackMs: 2500, // 识别不到按钮时用更保守的窗口（原来是 6000，太慢）
    debug: true
  };

  const SELECTORS = {
    input: 'textarea, [contenteditable="true"]',
    answer: '.ds-markdown, [class*="ds-markdown"], [class*="markdown"]',
    newChat: '新对话,新的对话,开启新对话,New chat',
    stop: /停止生成|停止回答|Stop generating|Stop/i,
    toggleIgnore: /深度思考|联网搜索|上传|附件|文件|语音|麦克风|登录|设置|头像/i
  };

  // ================= 基础工具 =================
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let debugLast = 0;
  function log(...args) {
    if (!CONFIG.debug) return;
    console.log('%c[翻译桥]', 'color:#2b6cb0', ...args);
    // 不再按时间节流：调用点本身已经控制了频率（等待日志 5 秒一次），
    // 之前 800ms 的节流会把「检测到图标 / 判定完成」这种紧挨着的关键日志吞掉。
    try {
      gm('POST', '/v1/bridge/log', { message: args.map((a) => String(a)).join(' ') }, 5000).catch(() => {});
    }
    catch (e) { /* ignore */ }
  }

  function gm(method, urlPath, data, timeout) {
    return new Promise((resolve, reject) => {
      try {
        GM_xmlhttpRequest({
          method,
          url: BRIDGE + urlPath,
          headers: data ? { 'Content-Type': 'application/json' } : undefined,
          data: data ? JSON.stringify(data) : undefined,
          timeout: timeout || 30000,
          onload(res) {
            let parsed = null;
            try { parsed = JSON.parse(res.responseText); } catch (e) { /* 非 JSON */ }
            resolve({ status: res.status, data: parsed, text: res.responseText });
          },
          onerror(res) { reject(new Error('无法连接本地中转服务 ' + BRIDGE)); },
          ontimeout() { reject(new Error('请求中转服务超时')); }
        });
      }
      catch (e) {
        reject(e);
      }
    });
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
  }

  function labelOf(el) {
    if (!el) return '';
    const attrs = [
      el.getAttribute && el.getAttribute('aria-label'),
      el.getAttribute && el.getAttribute('title'),
      el.getAttribute && el.getAttribute('data-testid')
    ].filter(Boolean).join(' ');

    // 必须用 innerText 而不是 textContent：
    // textContent 会把 display:none 的后代也算进来，导致「停止生成」按钮消失后
    // 外层容器仍然被判定为“正在生成”，等待永远结束不了。
    let text = '';
    try {
      text = (typeof el.innerText === 'string' ? el.innerText : el.textContent) || '';
    }
    catch (e) { text = ''; }
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > 120) text = ''; // 大容器不算按钮标签

    return (attrs + ' ' + text).replace(/\s+/g, ' ').trim().slice(0, 120);
  }

  function findClickable(predicate, root) {
    const scope = root || document;
    const nodes = Array.from(scope.querySelectorAll('button, [role="button"], [role="switch"], a, div[class*="button"], div[class*="chip"]'));
    for (const node of nodes) {
      if (!visible(node)) continue;
      if (predicate(node)) return node;
    }
    return null;
  }

  // ================= 页面状态徽标 =================
  let badge = null;
  let paused = false;

  const BADGE_COLORS = {
    ok: '#15803d',
    busy: '#b45309',
    bad: '#b91c1c',
    warn: '#6b7280',
    idle: '#6b7280'
  };

  function ensureBadge() {
    if (badge && badge.isConnected) return badge;
    badge = document.createElement('div');
    badge.id = 'dswt-bridge-badge';
    badge.style.cssText = [
      'position:fixed', 'left:12px', 'bottom:12px', 'z-index:2147483647',
      'padding:5px 11px', 'border-radius:999px', 'color:#fff', 'background:#6b7280',
      'font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif',
      'box-shadow:0 4px 16px rgba(0,0,0,.28)', 'cursor:pointer', 'user-select:none',
      'opacity:.95', 'max-width:70vw', 'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis'
    ].join(';');
    badge.title = '点击暂停 / 继续接收翻译任务（当前中转服务：' + BRIDGE + '）';
    badge.addEventListener('click', () => {
      paused = !paused;
      setBadge(paused ? '已暂停' : '待命中', paused ? 'warn' : 'ok');
    });
    document.documentElement.appendChild(badge);
    return badge;
  }

  function setBadge(text, kind) {
    try {
      const el = ensureBadge();
      el.textContent = '翻译桥 · ' + text;
      el.style.background = BADGE_COLORS[kind] || BADGE_COLORS.idle;
    }
    catch (e) { /* ignore */ }
  }

  // ================= 输入框 / 发送 =================
  function findInput() {
    const nodes = Array.from(document.querySelectorAll(SELECTORS.input)).filter(visible);
    if (!nodes.length) return null;
    // 选面积最大的那个（DeepSeek 主输入框）
    return nodes.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return (rb.width * rb.height) - (ra.width * ra.height);
    })[0];
  }

  function setInputValue(el, value) {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    // contenteditable 兜底
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, value);
    }
    catch (e) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
    }
  }

  function setInputValueFallback(el, value) {
    try {
      el.focus();
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, value);
    }
    catch (e) { /* ignore */ }
  }

  function findSendButton(input) {
    let scope = input;
    for (let depth = 0; depth < 7 && scope; depth++) {
      scope = scope.parentElement;
      if (!scope) break;
      const candidates = Array.from(scope.querySelectorAll('button, [role="button"]')).filter(visible);
      if (!candidates.length) continue;

      const named = candidates.find((el) => /发送|send/i.test(labelOf(el)));
      if (named) return named;

      const plausible = candidates.filter((el) => {
        const text = labelOf(el);
        if (SELECTORS.toggleIgnore.test(text)) return false;
        if (SELECTORS.stop.test(text)) return false;
        return !!el.querySelector('svg');
      });
      if (plausible.length) return plausible[plausible.length - 1];
    }
    return null;
  }

  function pressEnter(el) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  function inputIsEmpty(el) {
    if (!el) return true;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return !el.value.trim();
    return !(el.textContent || '').trim();
  }

  /**
   * 写入 prompt 并发送，带「回读校验」和「发送校验」。
   *
   * 0.1.2 之前这里只看"输入框是否为空"就认为发送成功 —— 如果写值失败，
   * 输入框本来就是空的，于是立刻返回 true，然后干等一个永远不会来的回答。
   */
  async function sendPrompt(prompt) {
    const input = findInput();
    if (!input) {
      throw new Error('没找到输入框：可能没有登录 DeepSeek，或页面还没加载完。');
    }

    setInputValue(input, prompt);
    await sleep(250);

    // 回读：文字真的进去了吗
    if (!readInputValue(input).trim()) {
      setInputValueFallback(input, prompt);
      await sleep(250);
      if (!readInputValue(input).trim()) {
        throw new Error('没能把文字写进输入框（页面结构可能变了）');
      }
    }

    const beforeCount = answerBlocks().length;
    const beforeText = lastNonEmptyAnswer().text;

    const sendBtn = findSendButton(input);
    if (sendBtn) sendBtn.click();
    else pressEnter(input);

    const start = Date.now();
    while (Date.now() - start < 8000) {
      await sleep(250);
      const emptied = !readInputValue(input).trim();
      const grew = answerBlocks().length > beforeCount || lastNonEmptyAnswer().text !== beforeText;
      if (emptied && grew) return true;
      // 输入框清空了，但新内容还没渲染出来：也认为发出去了
      if (emptied && Date.now() - start > 4000) return true;
    }

    // 输入框里还有字，说明根本没发出去
    if (readInputValue(input).trim()) {
      pressEnter(input);
      await sleep(800);
      if (readInputValue(input).trim()) {
        throw new Error('文字已写进输入框但没能发送出去（没找到发送按钮？）');
      }
      return true;
    }

    return true;
  }

  // ================= 回答块 / 生成状态 =================
  function answerBlocks() {
    let blocks = Array.from(document.querySelectorAll('.ds-markdown'));
    if (!blocks.length) blocks = Array.from(document.querySelectorAll(SELECTORS.answer));
    if (!blocks.length) {
      // 最后一层兜底：有些版本把回答放进普通消息容器里
      blocks = Array.from(document.querySelectorAll(
        '[data-message-author-role="assistant"], [class*="message"] [class*="content"], [class*="answer"]'
      ));
    }
    return blocks.filter(visible);
  }

  /**
   * 取「最后一个有内容的回答块」。
   *
   * 不能直接取最后一个块：DeepSeek 会在回答下方再插一个空的 .ds-markdown
   * （操作栏/相关推荐之类），最后一块的 innerText 是空字符串，
   * 于是永远判定为“还没抓到内容”——这正是 0.1.2 之前的死锁原因。
   */
  function lastNonEmptyAnswer() {
    const blocks = answerBlocks();
    for (let i = blocks.length - 1; i >= 0; i--) {
      const text = (blocks[i].innerText || '').trim();
      if (text) return { el: blocks[i], text: blocks[i].innerText };
    }
    return { el: null, text: '' };
  }

  function readInputValue(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
    return el.textContent || '';
  }

  function isGenerating() {
    return !!findClickable((el) => SELECTORS.stop.test(labelOf(el)) && !/深度思考/.test(labelOf(el)));
  }

  /**
   * 数一下「最后一条回答下方」的操作图标有几个。
   *
   * DeepSeek 写完会在回答下方渲染一排图标（复制/重新生成/赞/踩/朗读/分享），
   * 生成过程中没有。这些图标通常是 <div class="icon"> + <svg>，
   * 既没有 aria-label 也不是 <button>，所以直接数 svg，再按宿主按钮去重。
   */
  function actionIconsBelowAnswer() {
    const last = lastNonEmptyAnswer();
    if (!last.el) return 0;

    let answerRect;
    try {
      answerRect = last.el.getBoundingClientRect();
    }
    catch (e) {
      return 0;
    }

    const input = findInput();
    let inputTop = Infinity;
    try {
      if (input) inputTop = input.getBoundingClientRect().top;
    }
    catch (e) { /* ignore */ }

    const seen = new Set();
    let count = 0;
    const nodes = document.querySelectorAll('svg, button, [role="button"], [class*="icon"]');

    for (const el of nodes) {
      if (!visible(el)) continue;

      let rect;
      try {
        rect = el.getBoundingClientRect();
      }
      catch (e) {
        continue;
      }

      if (rect.width > 80 || rect.height > 80) continue;      // 只要小图标
      if (rect.top < answerRect.bottom - 4) continue;         // 必须在回答下方
      if (rect.top > answerRect.bottom + 160) continue;       // 也不能太远
      if (rect.top >= inputTop - 4) continue;                 // 排除输入区那一排
      if (el.closest && el.closest('form, [class*="input"], [class*="send"], [class*="chat-input"]')) continue;

      const host = (el.closest && el.closest('button, [role="button"]')) || el;
      if (seen.has(host)) continue;
      seen.add(host);
      count++;
    }
    return count;
  }

  function disableToggles() {
    const patterns = [/深度思考/, /联网搜索/];
    for (const re of patterns) {
      const btn = findClickable((el) => re.test(labelOf(el)));
      if (!btn) continue;
      const cls = String(btn.className || '');
      const on = btn.getAttribute('aria-pressed') === 'true' ||
        btn.getAttribute('data-state') === 'on' ||
        /(^|[\s_-])(on|active|selected|checked|enabled)([\s_-]|$)/i.test(cls);
      if (on) {
        log('尝试关闭开关：' + re.source);
        btn.click();
      }
    }
  }

  async function tryNewChat() {
    const names = SELECTORS.newChat.split(',');
    const btn = findClickable((el) => {
      const text = (el.textContent || '').trim();
      return names.some((n) => text === n || text === n + '（');
    });
    if (btn) {
      log('新开对话');
      btn.click();
      await sleep(1200);
      return true;
    }
    log('没找到“新对话”按钮，继续在当前会话里翻译');
    return false;
  }

  function cleanAnswer(text) {
    return String(text || '')
      .replace(/\u200b/g, '')
      .replace(/已深度思考（用时\s*\d+\s*秒）/g, '')
      .replace(/^已阅读\s*\d+\s*个网页\s*/m, '')
      .replace(/[（(]?citation[:：]\s*\d+[)）]?/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * 等 DeepSeek 把答案写完。
   * 主要靠 MutationObserver（不受后台标签页定时器节流影响），
   * 定时器只作为兜底与“稳定期”判定。
   */
  function waitForAnswer(baselineText, stepTimeoutMs) {
    const timeoutMs = stepTimeoutMs || CONFIG.stepTimeoutMs;
    return new Promise((resolve, reject) => {
      let lastText = '';
      let lastChangeAt = Date.now();
      let sawStopButton = isGenerating();
      let finished = false;
      let trailingTimer = null;
      const deadline = Date.now() + timeoutMs;
      const startedAt = Date.now();

      const ticker = setInterval(check, 500);

      function cleanup() {
        try { observer.disconnect(); } catch (e) { /* ignore */ }
        clearInterval(ticker);
        if (trailingTimer) {
          clearTimeout(trailingTimer);
          trailingTimer = null;
        }
      }

      function finish(text) {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(cleanAnswer(text));
      }

      function fail(err) {
        if (finished) return;
        finished = true;
        cleanup();
        reject(err);
      }

      let lastLogAt = 0;
      let lastActionCheckAt = 0;
      let lastIconCount = -1;
      let lastRunAt = 0;

      function check() {
        if (finished) return;
        // DOM 变动很频繁，最多每 100ms 跑一次；被跳过的这次安排一个尾随检查，
        // 否则「最后一个变化」（比如操作栏出现）可能被吞掉，只能等被节流的定时器。
        const now = Date.now();
        if (now - lastRunAt < 100) {
          if (!trailingTimer) {
            trailingTimer = setTimeout(function () {
              trailingTimer = null;
              check();
            }, 120);
          }
          return;
        }
        lastRunAt = now;

        const last = lastNonEmptyAnswer();
        const text = last.text || '';

        if (text && text.trim() !== baselineText) {
          if (text !== lastText) {
            lastText = text;
            lastChangeAt = now;
          }

          const generating = isGenerating();
          if (generating) sawStopButton = true;

          const idleNeeded = sawStopButton ? CONFIG.idleStableMs : CONFIG.idleStableFallbackMs;
          const quietFor = now - lastChangeAt;
          const answerAge = now - startedAt;

          // 操作栏检测要扫全页图标，只在文本短暂停顿后查，且最多 0.3 秒一次
          let actionIcons = -1;
          if (answerAge > 600 && quietFor >= 150 && now - lastActionCheckAt > 300) {
            lastActionCheckAt = now;
            actionIcons = actionIconsBelowAnswer();
            if (actionIcons > 0 && actionIcons !== lastIconCount) {
              lastIconCount = actionIcons;
              log('回答下方检测到 ' + actionIcons + ' 个图标');
            }
          }

          // 完成判定，任意一条满足就收：
          //   1. 回答下方出现 ≥3 个操作图标 + 文本 0.3 秒没变  → 语义信号，最快
          //   2. 没在生成 + 文本稳定（1.6s / 识别不到停止按钮时 2.5s）
          //   3. 文本 15 秒完全没变化 → 极端兜底
          let decidedBy = '';
          if (actionIcons >= 3 && quietFor >= 300) {
            decidedBy = '操作栏(' + actionIcons + ')';
          }
          else if (!generating && quietFor >= idleNeeded) {
            decidedBy = '静止 ' + (quietFor / 1000).toFixed(1) + 's';
          }
          else if (quietFor >= 15000) {
            decidedBy = '静止 15s 兜底';
          }

          if (answerAge > 1200 && decidedBy) {
            log('判定完成（' + decidedBy + '）· 共 ' + lastText.length + ' 字');
            finish(lastText);
            return;
          }

          if (now - lastLogAt > 5000) {
            lastLogAt = now;
            log('等待回答… 已收 ' + lastText.length + ' 字 · 生成中=' + generating +
              ' · 静止 ' + Math.round(quietFor / 1000) + 's');
          }
        }
        else if (now - lastLogAt > 5000) {
          lastLogAt = now;
          log('等待回答… 尚未抓到内容（候选块 ' + answerBlocks().length + ' 个）');
        }

        if (now > deadline) {
          if (lastText.trim()) finish(lastText);
          else fail(new Error('等待 DeepSeek 回复超时（' + Math.round(timeoutMs / 1000) +
            ' 秒）：页面上没抓到回答内容，可能是网页结构变了'));
        }
      }

      const observer = new MutationObserver(() => check());
      try {
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      }
      catch (e) { /* ignore */ }
      check();
    });
  }

  // ================= 单次问答 =================
  let turnsInChat = 0;

  async function ask(prompt, kind) {
    if (!findInput()) {
      throw new Error('页面上没有输入框：请确认已登录 https://chat.deepseek.com');
    }
    if (turnsInChat >= CONFIG.newChatEvery) {
      await tryNewChat();
      turnsInChat = 0;
    }
    disableToggles();

    // 基线取「最后一个有内容的块」，不能用最后一个块（可能是空块）
    const baselineText = (lastNonEmptyAnswer().text || '').trim();
    const stepTimeout = kind === 'selection' ? CONFIG.selectionTimeoutMs : CONFIG.stepTimeoutMs;

    await sendPrompt(prompt);
    const answer = await waitForAnswer(baselineText, stepTimeout);
    turnsInChat += 1;

    if (!answer) throw new Error('抓到的译文为空（页面结构可能变了）');
    return answer;
  }

  // ================= 任务循环 =================
  async function handleJob(job) {
    const short = String(job.id || '').slice(0, 6);
    try {
      setBadge('翻译中 ' + short, 'busy');
      log('开始任务 ' + short + ' · ' + job.prompt.length + ' 字');
      const answer = await ask(job.prompt, job.kind);
      await gm('POST', '/v1/bridge/result', { id: job.id, ok: true, text: answer }, 20000);
      log('完成任务 ' + short + ' · ' + answer.length + ' 字');
      setBadge('已完成 ' + short, 'ok');
    }
    catch (e) {
      log('任务失败 ' + short + '：' + e.message);
      setBadge('失败：' + String(e.message).slice(0, 28), 'bad');
      try {
        await gm('POST', '/v1/bridge/result', { id: job.id, ok: false, error: e.message }, 20000);
      }
      catch (e2) { /* 中转服务可能已停 */ }
    }
    setTimeout(() => {
      if (!paused) setBadge('待命中', 'ok');
    }, 3000);
  }

  async function loop() {
    let firstRun = true;
    while (true) {
      if (paused) {
        await sleep(1000);
        continue;
      }
      try {
        const res = await gm('GET', '/v1/bridge/next?wait=' + CONFIG.pollWaitSec, null, (CONFIG.pollWaitSec + 20) * 1000);
        if (res.status === 403) {
          setBadge('中转服务拒绝该来源', 'bad');
          await sleep(8000);
          continue;
        }
        if (!res.data || !res.data.ok) {
          setBadge('中转服务返回异常', 'bad');
          await sleep(4000);
          continue;
        }
        if (!res.data.job) {
          if (firstRun) {
            firstRun = false;
            log('已连接到中转服务 ' + BRIDGE);
          }
          setBadge(document.hidden ? '待命中（标签页在后台）' : '待命中', 'ok');
          continue;
        }
        firstRun = false;
        await handleJob(res.data.job);
      }
      catch (e) {
        setBadge('未连接中转服务', 'bad');
        log('连接失败：' + e.message);
        await sleep(5000);
      }
    }
  }

  function heartbeatLoop() {
    setInterval(async () => {
      try {
        await gm('POST', '/v1/bridge/heartbeat', {}, 8000);
      }
      catch (e) {
        setBadge('未连接中转服务', 'bad');
      }
    }, CONFIG.heartbeatMs);
  }

  // ================= 启动 =================
  function boot() {
    ensureBadge();
    setBadge('连接中…', 'idle');
    heartbeatLoop();
    loop();

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        log('标签页进入后台：Chrome 可能对定时器节流，长时间翻译建议把窗口保持可见');
      }
    });

    // 页面切换会话后重置计数
    window.addEventListener('hashchange', () => { turnsInChat = 0; });

    console.log('%c[DeepSeek 翻译桥] 已加载，中转服务：' + BRIDGE, 'color:#15803d;font-weight:bold');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  }
  else {
    boot();
  }
})();
