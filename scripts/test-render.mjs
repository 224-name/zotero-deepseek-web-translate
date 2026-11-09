/**
 * 渲染层冒烟测试
 *
 *   node scripts/test-render.mjs
 *
 * 用极简 DOM 打桩加载 bootstrap.js，把划词弹窗的渲染函数真跑一遍。
 * 目的：抓住「变量名写错 / 引用了不存在的节点」这类只有真机才暴露、
 * 单元测试又测不到的运行时错误（0.2.0 的 `box is not defined` 就是这种）。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'plugin', 'bootstrap.js'), 'utf8');

// ---------------- 最小 DOM 打桩 ----------------

function makeNode(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    children: [],
    attrs: {},
    textContent: '',
    className: '',
    isConnected: true,
    parentNode: null,
    style: {},
    setAttribute(key, value) { this.attrs[key] = value; },
    getAttribute(key) { return this.attrs[key]; },
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    addEventListener() {},
    // 刻意不实现 replaceChildren：真机上 `el.replaceChildren.apply(el, 沙箱数组)`
    // 会抛 "Permission denied to access property length"（跨 compartment），
    // 所以渲染代码必须用 appendChild 逐个挂。谁再用 replaceChildren，这里就会报错。
    get firstChild() { return this.children[0] || null; },
    querySelectorAll() { return []; }
  };
}

function makeDoc() {
  const body = makeNode('body');
  return {
    body,
    documentElement: { clientWidth: 900, clientHeight: 700 },
    createElement: (tag) => makeNode(tag),
    querySelectorAll: () => []
  };
}

// ---------------- 加载 bootstrap.js ----------------

const sandbox = {
  Zotero: {
    debug() {},
    // 渲染期不应该有被吞掉的异常；有就直接抛出来让测试失败
    logError(error) {
      throw new Error('渲染过程中抛出异常: ' + (error && error.message || error));
    },
    getMainWindow() { return null; }
  },
  Services: {
    prefs: {
      PREF_STRING: 32,
      PREF_INT: 64,
      PREF_BOOL: 128,
      getPrefType() { return 0; } // 一律走默认值
    }
  },
  APP_SHUTDOWN: 3,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  TextEncoder
};

vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'bootstrap.js' });

const {
  showDictResult,
  showTextResult,
  showError,
  showManualButton,
  showLoading,
  stopTicker,
  looksLikeWord,
  runSelectionTranslation,
  ensureRenderTarget,
  paintResult
} = sandbox;

// ---------------- 断言 ----------------

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  }
  catch (e) {
    failures++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}\n        ${e.message}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  }
  catch (e) {
    failures++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}\n        ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const doc = makeDoc();

console.log('\n[1] 单词判定');

check('单个英文单词走词典模式', () => {
  assertEqual(looksLikeWord('macroscale'), true, 'macroscale');
  assertEqual(looksLikeWord('section'), true, 'section');
  assertEqual(looksLikeWord("don't"), true, "don't");
});

check('短语 / 数字 / 中文不走词典模式', () => {
  assertEqual(looksLikeWord('fluid flow'), false, '双词短语');
  assertEqual(looksLikeWord('Section 2.1'), false, '带数字');
  assertEqual(looksLikeWord('部分'), false, '中文');
  assertEqual(looksLikeWord(''), false, '空串');
});

console.log('\n[2] 弹窗渲染');

check('showDictResult 渲染多义项（曾因 box 未定义而抛错）', () => {
  const job = { text: 'section', doc, box: doc.createElement('div'), token: 1 };
  showDictResult(doc, job, {
    kind: 'dict',
    senses: [
      { pos: 'n.', meaning: '部分；段；部门' },
      { pos: 'v.', meaning: '区分；作截面图' }
    ]
  });
  // 头部 + 2 行义项 + 底部按钮行
  assertEqual(job.box.children.length, 4, '子节点数');
  assertEqual(job.box.children[0].textContent, 'section', '头部应为原词');
  const firstRow = job.box.children[1];
  assert(firstRow.children.some((c) => c.textContent === 'n.'), '缺少词性');
  assert(firstRow.children.some((c) => c.textContent === '部分；段；部门'), '缺少释义');
});

check('showTextResult 渲染译文', () => {
  const job = { text: 'x', doc, box: doc.createElement('div') };
  showTextResult(doc, job, { kind: 'text', text: '这是一段译文。' });
  assertEqual(job.box.children[0].textContent, '这是一段译文。', '译文内容');
});

check('showTextResult 长文本加滚动高度限制', () => {
  const job = { text: 'x', doc, box: doc.createElement('div') };
  showTextResult(doc, job, { kind: 'text', text: '长'.repeat(400) });
  assert(String(job.box.children[0].attrs.style).includes('overflow:auto'), '缺少滚动样式');
});

check('showError 显示错误且带重试', () => {
  const job = { text: 'x', doc, box: doc.createElement('div') };
  showError(doc, job.box, '连接超时', job);
  assert(String(job.box.children[0].textContent).includes('连接超时'), '缺少错误信息');
  assertEqual(job.box.children.length, 2, '错误信息 + 按钮行');
});

check('showManualButton 只画一个按钮', () => {
  const job = { text: 'x', doc, box: doc.createElement('div') };
  showManualButton(doc, job.box, job, 12);
  assertEqual(job.box.children.length, 1, '子节点数');
  assertEqual(job.box.children[0].children.length, 1, '应只有一个按钮');
});

console.log('\n[3] 加载态计时器');

check('showLoading 启动计时器且文案含“翻译中”', () => {
  const job = { text: 'x', doc, box: doc.createElement('div') };
  showLoading(doc, job);
  assert(job.timer, '未启动计时器');
  assert(String(job.box.children[0].textContent).includes('翻译中'), '缺少加载文案');
  stopTicker(job);
  assertEqual(job.timer, null, '计时器未清空');
});

check('stopTicker 对没有计时器的 job 是安全的', () => {
  stopTicker({});
  stopTicker(null);
});

console.log('\n[3.5] 弹窗被重建时的兜底');

check('盒子脱离页面时 ensureRenderTarget 会生成浮层', () => {
  const localDoc = makeDoc();
  const deadBox = localDoc.createElement('div');
  deadBox.isConnected = false;
  const job = { text: 'x', doc: localDoc, box: deadBox, anchorRect: { left: 40, top: 120 } };

  const target = ensureRenderTarget(job);
  assert(target, '没有返回渲染目标');
  assertEqual(job.box, target, 'job.box 应指向新目标');
  assert(job.fallback, '没有记录浮层');
  assertEqual(localDoc.body.children.length, 1, '浮层未挂到 body');
  assert(target.isConnected, '新目标不可见');
});

check('盒子还在页面上时 ensureRenderTarget 原样返回', () => {
  const localDoc = makeDoc();
  const aliveBox = localDoc.createElement('div');
  const job = { text: 'x', doc: localDoc, box: aliveBox };
  const target = ensureRenderTarget(job);
  assertEqual(target, aliveBox, '不应替换有效盒子');
  assertEqual(localDoc.body.children.length, 0, '不应创建浮层');
});

check('兜底浮层可以正常渲染结果', () => {
  const localDoc = makeDoc();
  const deadBox = localDoc.createElement('div');
  deadBox.isConnected = false;
  const job = { text: 'issue', doc: localDoc, box: deadBox };
  job.box = ensureRenderTarget(job);
  showDictResult(localDoc, job, { kind: 'dict', senses: [{ pos: 'n.', meaning: '问题' }] });
  assert(job.box.children.length >= 2, '浮层里没有渲染出内容');
});

check('paintResult 遇到失效盒子会自动换浮层', () => {
  const localDoc = makeDoc();
  const deadBox = localDoc.createElement('div');
  deadBox.isConnected = false;
  const job = { text: 'x', doc: localDoc, box: deadBox };
  paintResult(job, { kind: 'text', text: '兜底译文' });
  assert(job.fallback, '没有生成兜底浮层');
  assertEqual(job.box.children[0].textContent, '兜底译文', '浮层内容不对');
});

console.log('\n[4] 完整划词流程（命中缓存）');
await checkAsync('runSelectionTranslation 命中缓存后立即渲染并停表', async () => {
  const job = { text: 'cached phrase', doc, box: doc.createElement('div'), token: 1 };
  sandbox.DSWT.state.selectionCache.set('text|简体中文|cached phrase', {
    kind: 'text',
    text: '缓存里的译文'
  });
  await runSelectionTranslation(job);
  assertEqual(job.box.children[0].textContent, '缓存里的译文', '译文内容');
  assertEqual(job.timer, null, '计时器应已停止');
});

await checkAsync('字典词命中缓存时渲染成多义项', async () => {
  const job = { text: 'cacheword', doc, box: doc.createElement('div'), token: 1 };
  sandbox.DSWT.state.selectionCache.set('word|简体中文|cacheword', {
    kind: 'dict',
    senses: [{ pos: 'adj.', meaning: '宏观的' }]
  });
  await runSelectionTranslation(job);
  assertEqual(job.box.children.length, 3, '头部 + 1 义项 + 按钮行');
  assertEqual(job.box.children[1].children[1].textContent, '宏观的', '释义内容');
});

// 防止有计时器残留把进程挂住
for (const job of Object.values(sandbox.DSWT.state)) {
  if (job && job.timer) stopTicker(job);
}

if (failures) {
  console.error(`\n\x1b[31m${failures} 项失败\x1b[0m\n`);
  process.exit(1);
}
console.log('\n\x1b[32m渲染层冒烟测试全部通过\x1b[0m\n');
process.exit(0);
