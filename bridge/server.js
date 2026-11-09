#!/usr/bin/env node
/**
 * DeepSeek 网页版翻译中转服务
 * ------------------------------------------------------------------
 * 作用：Zotero 插件把要翻译的文本 POST 过来 → 本服务排队 → 浏览器里的
 *      油猴脚本把任务取走、在 DeepSeek 网页版里发送、抓回结果 → 回传。
 *
 * 特点：零依赖（只用 Node 内置模块），只监听 127.0.0.1，不对外暴露。
 *
 * 用法：
 *   node server.js            # 默认 8765 端口
 *   node server.js 9000       # 指定端口
 *   set DSWT_PORT=9000 && node server.js
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = '0.1.0';
const HOST = process.env.DSWT_HOST || '127.0.0.1';
const PORT = parseInt(process.env.DSWT_PORT || process.argv[2] || '8765', 10);
const USERSCRIPT_PATH = path.join(__dirname, 'deepseek-bridge.user.js');
const CONNECTED_WINDOW_MS = 25000; // 超过这个时间没心跳就算掉线
const DEFAULT_TIMEOUT_MS = 240000;
const MAX_BODY = 1024 * 1024;

// ------------------------------------------------------------------
// 状态
// ------------------------------------------------------------------

const jobs = new Map();
const pendingQueue = [];
const pollers = [];
const stats = { done: 0, failed: 0, startedAt: Date.now() };
let lastHeartbeat = 0;
let activeJobId = null;
let lastError = '';

// ------------------------------------------------------------------
// 小工具
// ------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(...args) {
  console.log('[' + nowIso() + ']', ...args);
}

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(body);
}

function html(res, status, body) {
  const buf = Buffer.from(body, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store'
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大（上限 1MB）'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      }
      catch (e) {
        reject(new Error('JSON 解析失败：' + e.message));
      }
    });
    req.on('error', reject);
  });
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin === 'null') return true;
  if (/^(moz|chrome|safari-web)-extension:\/\//.test(origin)) return true;
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return true;
  if (/^https:\/\/chat\.deepseek\.com$/.test(origin)) return true;
  return false;
}

function isConnected() {
  return Date.now() - lastHeartbeat < CONNECTED_WINDOW_MS;
}

function touchHeartbeat() {
  lastHeartbeat = Date.now();
}

// ------------------------------------------------------------------
// 任务队列
// ------------------------------------------------------------------

function takeJob() {
  while (pendingQueue.length) {
    const id = pendingQueue.shift();
    const job = jobs.get(id);
    if (!job || job.status !== 'pending') continue;
    job.status = 'running';
    job.startedAt = Date.now();
    activeJobId = job.id;
    log('派发任务 ' + job.id.slice(0, 8) + ' · ' + job.prompt.length + ' 字');
    return job;
  }
  return null;
}

function wakePollers() {
  while (pendingQueue.length && pollers.length) {
    const poller = pollers.shift();
    clearTimeout(poller.timer);
    const job = takeJob();
    if (!job) break;
    json(poller.res, 200, {
      ok: true,
      job: { id: job.id, prompt: job.prompt, kind: job.kind, targetLang: job.targetLang }
    });
  }
}

function settleJob(job, ok, payload) {
  if (job.settled) return;
  job.settled = true;
  clearTimeout(job.timer);
  jobs.delete(job.id);
  if (activeJobId === job.id) activeJobId = null;

  job.finishedAt = Date.now();
  job.status = ok ? 'done' : 'error';

  if (ok) {
    stats.done++;
    job.translation = String(payload || '').trim();
    log('完成任务 ' + job.id.slice(0, 8) + ' · ' + job.translation.length + ' 字 · ' +
      ((job.finishedAt - job.startedAt) / 1000).toFixed(1) + 's');
    job.resolve(job.translation);
  }
  else {
    stats.failed++;
    lastError = String(payload || '未知错误');
    log('任务失败 ' + job.id.slice(0, 8) + ' · ' + lastError);
    job.reject(new Error(lastError));
  }
}

function enqueueJob(prompt, targetLang, timeoutMs, kind) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const job = {
      id,
      prompt,
      kind: kind || 'text',
      targetLang: targetLang || '简体中文',
      status: 'pending',
      createdAt: Date.now(),
      settled: false,
      resolve,
      reject,
      timer: null
    };
    jobs.set(id, job);
    pendingQueue.push(id);

    job.timer = setTimeout(() => {
      if (job.settled) return;
      settleJob(job, false,
        '等待浏览器端返回超时（' + Math.round(timeoutMs / 1000) + ' 秒）。' +
        '常见原因：DeepSeek 页面卡住/被限流、标签页被关掉、或网页改版导致脚本抓不到结果。');
    }, timeoutMs);
    if (job.timer.unref) job.timer.unref();

    log('收到任务 ' + id.slice(0, 8) + ' · ' + prompt.length + ' 字 · 队首 ' +
      (pendingQueue.length === 1 ? '是' : '否（前面还有 ' + (pendingQueue.length - 1) + ' 个）'));

    wakePollers();
  });
}

// ------------------------------------------------------------------
// 页面
// ------------------------------------------------------------------

function renderStatusPage() {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>DeepSeek 网页翻译 · 中转服务</title><style>' +
    'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    'background:#0f172a;color:#e2e8f0;font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}' +
    '.card{width:min(680px,92vw);background:#16213b;border:1px solid #263252;border-radius:14px;padding:26px 28px;' +
    'box-shadow:0 20px 60px rgba(0,0,0,.45)}' +
    'h1{margin:0 0 4px;font-size:18px;letter-spacing:.3px}' +
    '.sub{color:#8ea0c0;font-size:12px;margin-bottom:20px}' +
    '.row{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px dashed #263252}' +
    '.row:last-child{border-bottom:0}' +
    '.k{color:#93a5c4}.v{font-variant-numeric:tabular-nums}' +
    '.ok{color:#43d17a;font-weight:600}.bad{color:#ff7a70;font-weight:600}' +
    '.hint{margin-top:18px;padding:12px 14px;background:#101a30;border:1px solid #263252;border-radius:10px;' +
    'font-size:12.5px;color:#a9b8d4}' +
    'a{color:#7db3ff;text-decoration:none}a:hover{text-decoration:underline}' +
    'code{background:#0b1327;padding:1px 5px;border-radius:4px;color:#cfe0ff;font-size:12px}' +
    '</style></head><body><div class="card">' +
    '<h1>DeepSeek 网页翻译 · 中转服务</h1>' +
    '<div class="sub">v' + VERSION + ' · 只在本机监听，不对外网开放</div>' +
    '<div class="row"><span class="k">浏览器标签页</span><span class="v" id="conn">检测中…</span></div>' +
    '<div class="row"><span class="k">排队 / 进行中</span><span class="v" id="queue">-</span></div>' +
    '<div class="row"><span class="k">已完成 / 失败</span><span class="v" id="stat">-</span></div>' +
    '<div class="row"><span class="k">最近一次错误</span><span class="v" id="err" style="text-align:right;max-width:60%">-</span></div>' +
    '<div class="hint" id="hint"></div>' +
    '<div class="hint">油猴脚本安装地址：<a href="/deepseek-bridge.user.js">/deepseek-bridge.user.js</a><br>' +
    '需要先装 <a href="https://www.tampermonkey.net/" target="_blank" rel="noreferrer">Tampermonkey</a>，' +
    '再打开 <code>https://chat.deepseek.com</code> 登录。</div>' +
    '</div><script>' +
    'async function tick(){' +
    'try{const r=await fetch("/v1/health",{cache:"no-store"});const d=await r.json();' +
    'const c=document.getElementById("conn");' +
    'if(d.userscript.connected){c.className="v ok";c.textContent="已连接";}' +
    'else{c.className="v bad";c.textContent="未连接（"+(d.userscript.lastSeenAgoMs==null?"从未":Math.round(d.userscript.lastSeenAgoMs/1000)+" 秒前")+"）";}' +
    'document.getElementById("queue").textContent=d.queue.pending+" / "+d.queue.running;' +
    'document.getElementById("stat").textContent=d.stats.done+" / "+d.stats.failed;' +
    'document.getElementById("err").textContent=d.lastError||"-";' +
    'document.getElementById("hint").innerHTML=d.userscript.connected?' +
    '"状态正常，可以在 Zotero 里右键文献选择「DeepSeek 全文翻译（生成双语文档）」。":' +
    '"请打开 <code>https://chat.deepseek.com</code> 并登录，确认页面左下角出现绿色「桥已连接」。";' +
    '}catch(e){document.getElementById("conn").textContent="服务无响应";}}' +
    'tick();setInterval(tick,2000);' +
    '</script></body></html>';
}

// ------------------------------------------------------------------
// 路由
// ------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://127.0.0.1');
  }
  catch (e) {
    return json(res, 400, { ok: false, error: '非法 URL' });
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Max-Age': '600'
    });
    return res.end();
  }

  if (req.method === 'POST' && !originAllowed(req)) {
    log('拒绝来源：' + req.headers.origin);
    return json(res, 403, { ok: false, error: '不允许的来源：' + req.headers.origin });
  }

  try {
    // ---------- 状态页 ----------
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return html(res, 200, renderStatusPage());
    }

    // ---------- 油猴脚本 ----------
    if (req.method === 'GET' && url.pathname === '/deepseek-bridge.user.js') {
      if (!fs.existsSync(USERSCRIPT_PATH)) {
        return json(res, 404, { ok: false, error: '找不到油猴脚本文件：' + USERSCRIPT_PATH });
      }
      const content = fs.readFileSync(USERSCRIPT_PATH);
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': content.length,
        'Cache-Control': 'no-store'
      });
      return res.end(content);
    }

    // ---------- 健康检查 ----------
    if (req.method === 'GET' && url.pathname === '/v1/health') {
      const lastSeenAgoMs = lastHeartbeat ? Date.now() - lastHeartbeat : null;
      return json(res, 200, {
        ok: true,
        version: VERSION,
        pid: process.pid,
        uptimeSec: Math.round((Date.now() - stats.startedAt) / 1000),
        userscript: { connected: isConnected(), lastSeenAgoMs },
        queue: { pending: pendingQueue.length, running: activeJobId ? 1 : 0 },
        stats: { done: stats.done, failed: stats.failed },
        lastError
      });
    }

    // ---------- Zotero 插件：提交翻译 ----------
    if (req.method === 'POST' && url.pathname === '/v1/translate') {
      const body = await readBody(req);
      const prompt = typeof body.prompt === 'string' ? body.prompt : '';
      if (!prompt.trim()) {
        return json(res, 400, { ok: false, error: '缺少 prompt 字段' });
      }
      if (!isConnected()) {
        const ago = lastHeartbeat ? Math.round((Date.now() - lastHeartbeat) / 1000) + ' 秒前' : '从未';
        return json(res, 503, {
          ok: false,
          error: '浏览器里的 DeepSeek 标签页还没连上中转服务（最近心跳：' + ago + '）。\n' +
            '请：1) 安装并启用油猴脚本；2) 打开 https://chat.deepseek.com 并登录；' +
            '3) 确认页面左下角出现绿色「桥已连接」。'
        });
      }

      const timeoutMs = Math.min(Math.max(parseInt(body.timeoutMs, 10) || DEFAULT_TIMEOUT_MS, 30000), 900000);
      log('收到翻译请求 · ' + prompt.length + ' 字 · 目标语言 ' + (body.targetLang || '简体中文'));

      try {
        const translation = await enqueueJob(prompt, body.targetLang, timeoutMs, body.kind);
        log('已回传插件 · ' + translation.length + ' 字（若插件界面仍不动，问题在插件侧渲染）');
        return json(res, 200, { ok: true, translation, engine: 'deepseek-web' });
      }
      catch (e) {
        log('回传失败 · ' + e.message);
        return json(res, 504, { ok: false, error: e.message });
      }
    }

    // ---------- 油猴脚本：取任务（长轮询） ----------
    if (req.method === 'GET' && url.pathname === '/v1/bridge/next') {
      touchHeartbeat();
      const job = takeJob();
      if (job) {
        return json(res, 200, {
          ok: true,
          job: { id: job.id, prompt: job.prompt, kind: job.kind, targetLang: job.targetLang }
        });
      }

      const waitSec = Math.min(Math.max(parseInt(url.searchParams.get('wait'), 10) || 25, 1), 60);
      const poller = { res, timer: null };
      poller.timer = setTimeout(() => {
        const idx = pollers.indexOf(poller);
        if (idx >= 0) pollers.splice(idx, 1);
        if (!res.writableEnded) json(res, 200, { ok: true, job: null });
      }, waitSec * 1000);
      if (poller.timer.unref) poller.timer.unref();
      pollers.push(poller);
      req.on('close', () => {
        clearTimeout(poller.timer);
        const idx = pollers.indexOf(poller);
        if (idx >= 0) pollers.splice(idx, 1);
      });
      return;
    }

    // ---------- 油猴脚本：回传结果 ----------
    if (req.method === 'POST' && url.pathname === '/v1/bridge/result') {
      touchHeartbeat();
      const body = await readBody(req);
      const job = jobs.get(body.id);
      if (!job) {
        return json(res, 404, { ok: false, error: '任务不存在或已超时' });
      }
      if (body.ok) {
        const text = String(body.text || '').trim();
        if (!text) {
          settleJob(job, false, '浏览器端返回了空译文');
          return json(res, 200, { ok: true, accepted: false });
        }
        settleJob(job, true, text);
      }
      else {
        settleJob(job, false, String(body.error || '浏览器端翻译失败'));
      }
      return json(res, 200, { ok: true, accepted: true });
    }

    // ---------- 油猴脚本：心跳 ----------
    if (req.method === 'POST' && url.pathname === '/v1/bridge/heartbeat') {
      touchHeartbeat();
      return json(res, 200, {
        ok: true,
        pending: pendingQueue.length,
        running: activeJobId ? 1 : 0
      });
    }

    // ---------- 油猴脚本 / 插件：日志 ----------
    if (req.method === 'POST' && url.pathname === '/v1/bridge/log') {
      try {
        const body = await readBody(req);
        const source = body.source === 'zotero' ? 'zotero ' : 'userscript';
        // 插件发的日志不代表浏览器在线，不能刷新心跳
        if (body.source !== 'zotero') touchHeartbeat();
        const msg = String(body.message || '').slice(0, 500);
        if (msg) console.log('[' + nowIso() + '] [' + source + '] ' + msg);
      }
      catch (e) { /* 日志失败无所谓 */ }
      return json(res, 200, { ok: true });
    }

    // ---------- 其他 ----------
    return json(res, 404, { ok: false, error: '未知接口：' + req.method + ' ' + url.pathname });
  }
  catch (e) {
    log('处理请求出错：' + e.message);
    try {
      return json(res, 500, { ok: false, error: e.message });
    }
    catch (e2) { /* 响应可能已发出 */ }
  }
});

// ------------------------------------------------------------------
// 启动
// ------------------------------------------------------------------

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('\n[启动失败] 端口 ' + PORT + ' 已被占用。');
    console.error('可能已经有一个中转服务在运行了（先看看 http://127.0.0.1:' + PORT + '/ ）。');
    console.error('要换端口：node server.js 8766\n');
  }
  else {
    console.error('[启动失败]', e);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const base = 'http://' + HOST + ':' + PORT;
  console.log('');
  console.log('============================================================');
  console.log(' DeepSeek 网页版翻译中转服务 v' + VERSION);
  console.log('------------------------------------------------------------');
  console.log(' 监听地址   ' + base);
  console.log(' 状态页     ' + base + '/');
  console.log(' 油猴脚本   ' + base + '/deepseek-bridge.user.js');
  console.log('------------------------------------------------------------');
  console.log(' 接下来：');
  console.log('   1. 浏览器安装 Tampermonkey（油猴扩展）');
  console.log('   2. 打开上面的“油猴脚本”地址 → 点“安装”');
  console.log('   3. 打开 https://chat.deepseek.com 并登录');
  console.log('   4. 页面左下角出现绿色「桥已连接」就绪');
  console.log('   5. 回到 Zotero：右键文献 → DeepSeek 全文翻译');
  console.log('============================================================');
  console.log(' 按 Ctrl+C 停止服务');
  console.log('');
});

function shutdown() {
  console.log('\n正在关闭中转服务…');
  for (const poller of pollers) {
    clearTimeout(poller.timer);
    try { json(poller.res, 200, { ok: true, job: null }); } catch (e) { /* ignore */ }
  }
  pollers.length = 0;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
