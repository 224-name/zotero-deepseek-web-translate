/**
 * 中转服务端到端测试：真的把 server.js 跑起来，用一个假油猴客户端验证完整链路。
 *
 *   node scripts/test-bridge.mjs
 *
 * 注意：Windows 沙箱下不能用 piped stdio 启动子进程，这里统一用 stdio: 'ignore'，
 * 子进程与测试之间只通过 HTTP 通信。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'bridge', 'server.js');

const PORT = 8800 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    failures++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? '\n        ' + detail : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jsonFetch(url, options = {}) {
  const res = await fetch(url, options);
  let data = null;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch (e) {
    data = text;
  }
  return { status: res.status, data, text };
}

async function waitForServer(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await jsonFetch(`${BASE}/v1/health`);
      if (res.status === 200) return true;
    } catch (e) {
      /* 还没起来 */
    }
    await sleep(120);
  }
  return false;
}

/** 假油猴客户端：领一个任务并回传指定结果 */
async function fakeUserscriptOnce({ mode = 'ok', delayMs = 150 } = {}) {
  const res = await jsonFetch(`${BASE}/v1/bridge/next?wait=8`);
  const job = res.data && res.data.job;
  if (!job) return null;
  await sleep(delayMs);
  const body = mode === 'ok'
    ? { id: job.id, ok: true, text: '【译】' + job.prompt.slice(-24) }
    : { id: job.id, ok: false, error: '模拟失败：页面抓不到回答' };
  await jsonFetch(`${BASE}/v1/bridge/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return job;
}

const server = spawn(process.execPath, [serverPath], {
  env: { ...process.env, DSWT_PORT: String(PORT) },
  stdio: 'ignore',
});

try {
  console.log(`\n启动中转服务 :${PORT} …`);
  const up = await waitForServer();
  if (!up) {
    console.error('\x1b[31m服务没能启动\x1b[0m');
    process.exit(1);
  }
  console.log('服务已启动\n');

  console.log('[1] 健康检查与初始状态');
  {
    const res = await jsonFetch(`${BASE}/v1/health`);
    check('GET /v1/health 返回 200', res.status === 200);
    check('version 字段存在', typeof res.data.version === 'string');
    check('初始未连接浏览器', res.data.userscript.connected === false);
    check('队列为空', res.data.queue.pending === 0 && res.data.queue.running === 0);
  }

  console.log('\n[2] 浏览器未连接时应快速失败');
  {
    const res = await jsonFetch(`${BASE}/v1/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello', targetLang: '简体中文' }),
    });
    check('返回 503', res.status === 503, `实际 ${res.status}`);
    check('提示语友好（提到油猴/标签页）', /油猴|标签页/.test(String(res.data.error)));
    check('ok 为 false', res.data.ok === false);
  }

  console.log('\n[3] 心跳后应显示已连接');
  {
    await jsonFetch(`${BASE}/v1/bridge/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const res = await jsonFetch(`${BASE}/v1/health`);
    check('userscript.connected 为 true', res.data.userscript.connected === true);
    check('lastSeenAgoMs 很小', res.data.userscript.lastSeenAgoMs < 5000, String(res.data.userscript.lastSeenAgoMs));
  }

  console.log('\n[4] 完整链路：提交 → 派发 → 回传 → 返回译文');
  {
    const translatePromise = jsonFetch(`${BASE}/v1/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'The quick brown fox jumps over the lazy dog.', targetLang: '简体中文' }),
    });
    await sleep(150);
    const job = await fakeUserscriptOnce({ mode: 'ok' });
    check('假油猴领到了任务', !!job);
    check('任务带 prompt', !!(job && job.prompt.includes('quick brown fox')));

    const res = await translatePromise;
    check('插件侧收到 200', res.status === 200, `实际 ${res.status}`);
    check('ok=true', res.data.ok === true);
    check('译文由浏览器端产生', String(res.data.translation).startsWith('【译】'), JSON.stringify(res.data.translation));
    const health = await jsonFetch(`${BASE}/v1/health`);
    check('完成计数 +1', health.data.stats.done === 1);
    check('队列已清空', health.data.queue.pending === 0 && health.data.queue.running === 0);
  }

  console.log('\n[5] 浏览器端报错的传播');
  {
    const translatePromise = jsonFetch(`${BASE}/v1/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'second request', targetLang: '简体中文' }),
    });
    await sleep(150);
    await fakeUserscriptOnce({ mode: 'fail' });
    const res = await translatePromise;
    check('插件侧收到错误状态', res.status === 504, `实际 ${res.status}`);
    check('错误信息被透传', /模拟失败/.test(String(res.data.error)), JSON.stringify(res.data));
    const health = await jsonFetch(`${BASE}/v1/health`);
    check('失败计数 +1', health.data.stats.failed === 1);
  }

  console.log('\n[6] 多个任务排队');
  {
    const p1 = jsonFetch(`${BASE}/v1/translate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'task one', targetLang: '简体中文' }),
    });
    const p2 = jsonFetch(`${BASE}/v1/translate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'task two', targetLang: '简体中文' }),
    });
    await sleep(200);
    const health = await jsonFetch(`${BASE}/v1/health`);
    check('排队中有 2 个任务', health.data.queue.pending === 2, JSON.stringify(health.data.queue));

    const j1 = await fakeUserscriptOnce({ mode: 'ok' });
    const j2 = await fakeUserscriptOnce({ mode: 'ok' });
    check('两个任务都被领到', !!j1 && !!j2);
    check('先来先服务', !!(j1 && j1.prompt.includes('task one')), j1 && j1.prompt);
    const [r1, r2] = await Promise.all([p1, p2]);
    check('两个请求都成功', r1.status === 200 && r2.status === 200);
  }

  console.log('\n[7] 静态资源与来源校验');
  {
    const us = await jsonFetch(`${BASE}/deepseek-bridge.user.js`);
    check('油猴脚本可下载', us.status === 200 && us.text.includes('==UserScript=='));
    check('脚本里带 @connect 127.0.0.1', us.text.includes('@connect      127.0.0.1'));

    const page = await jsonFetch(`${BASE}/`);
    check('状态页可访问', page.status === 200 && page.text.includes('中转服务'));

    const evil = await jsonFetch(`${BASE}/v1/bridge/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
      body: '{}',
    });
    check('陌生 Origin 被拒绝', evil.status === 403, `实际 ${evil.status}`);

    const unknown = await jsonFetch(`${BASE}/nope`);
    check('未知路由返回 404', unknown.status === 404);
  }
}
catch (e) {
  failures++;
  console.error('\n\x1b[31m测试异常：\x1b[0m', e);
}
finally {
  server.kill();
  await sleep(300);
}

if (failures) {
  console.error(`\n\x1b[31m${failures} 项失败\x1b[0m\n`);
  process.exit(1);
}
console.log('\n\x1b[32m中转服务端到端测试全部通过\x1b[0m\n');
