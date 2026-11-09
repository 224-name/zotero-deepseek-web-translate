/**
 * core.js 单元测试（不依赖 Zotero）
 *
 *   node scripts/test-core.mjs
 *
 * 除了断言纯逻辑，还会把样例 HTML / DOCX 写到 dist/test/ 供人工检查。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const corePath = path.join(root, 'plugin', 'content', 'core.js');

const context = vm.createContext({ TextEncoder, console });
vm.runInContext(fs.readFileSync(corePath, 'utf8'), context, { filename: corePath });
const core = context.DSWTCore;

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } catch (e) {
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

console.log('\n[1] normalizeText');

const messy = [
  'Deep Learning for',
  'Natural Language Processing',
  '',
  '12',
  'Abstract: this paper studies the inter-',
  'national benchmark of neural machine trans-',
  'lation systems. We propose a new method.',
  '第 3 页',
  'Page 4 of 12',
  '第一章 绪论',
  '近年来，深度学习在自然语言处理领域取得了',
  '长足进步。',
].join('\n');

const normalized = core.normalizeText(messy);
console.log('  ---- 规整结果 ----');
normalized.split('\n').forEach((l) => console.log('  | ' + l));
console.log('  ------------------');

check('剔除纯页码行', () => {
  assert(!/^12$/m.test(normalized), '页码 12 未被剔除');
  assert(!/第 3 页/.test(normalized), '中文页码未被剔除');
  assert(!/Page 4 of 12/.test(normalized), '英文页码未被剔除');
});

check('修复行尾连字符断词', () => {
  assert(/international/.test(normalized), 'inter-national 未合并');
  assert(/translation/.test(normalized), 'trans-lation 未合并');
});

check('中文跨行直接拼接', () => {
  assert(/近年来，深度学习在自然语言处理领域取得了长足进步。/.test(normalized), '中文断行未拼接');
});

check('不产生空段落', () => {
  assert(normalized.split('\n').every((l) => l.trim().length > 0), '存在空段落');
});

check('标题行独立成段', () => {
  const lines = normalized.split('\n');
  assert(lines.includes('第一章 绪论'), `"第一章 绪论" 未独立成行: ${JSON.stringify(lines)}`);
  assert(lines.includes('Deep Learning for Natural Language Processing'), '英文标题未独立成行');
});

console.log('\n[2] splitParagraphs / buildChunks');

check('段落切分', () => {
  const paras = core.splitParagraphs('第一段。\n第二段。\n\n第三段。');
  assertEqual(paras.length, 3, '段落数');
  assertEqual(paras[2], '第三段。', '第三段内容');
});

check('分块大小不超限', () => {
  const paras = core.splitParagraphs(normalized);
  const { chunks, totalChars } = core.buildChunks(paras, { chunkSize: 300, maxChunks: 100 });
  assert(chunks.length > 0, '没有生成任何分块');
  for (const c of chunks) {
    assert(c.length <= 300, `分块长度 ${c.length} 超过 300`);
  }
  console.log(`  分块数=${chunks.length}, 字符数=${totalChars}`);
});

check('超长段落被硬切', () => {
  const long = 'a'.repeat(3000);
  const { chunks } = core.buildChunks([long], { chunkSize: 500, maxChunks: 100 });
  assert(chunks.length >= 6, `硬切块数不足: ${chunks.length}`);
  assert(chunks.every((c) => c.length <= 500), '硬切后仍超限');
});

check('maxChunks 截断生效', () => {
  const paras = Array.from({ length: 50 }, (_, i) => `这是第${i}段，` + '内容'.repeat(400));
  const { chunks, truncated } = core.buildChunks(paras, { chunkSize: 500, maxChunks: 5 });
  assertEqual(chunks.length, 5, '截断后块数');
  assertEqual(truncated, true, 'truncated 标记');
});

check('分块内容不丢字（未截断时）', () => {
  const sample = ['AAA。'.repeat(50), 'BBB。'.repeat(50)];
  const { chunks } = core.buildChunks(sample, { chunkSize: 400, maxChunks: 100 });
  const joined = chunks.join('').replace(/\n/g, '');
  const expect = sample.join('').replace(/\n/g, '');
  assertEqual(joined.length, expect.length, '合并后长度');
});

console.log('\n[3] buildPrompt');
check('包含目标语言与分隔标记', () => {
  const prompt = core.buildPrompt('hello world', { targetLang: '简体中文', style: 'academic' });
  assert(prompt.includes('简体中文'), '缺少目标语言');
  assert(prompt.includes('<<<') && prompt.includes('>>>'), '缺少分隔标记');
  assert(prompt.includes('hello world'), '缺少原文');
  assert(/只输出译文/.test(prompt), '缺少只输出译文的约束');
});

check('划词模式附加说明', () => {
  const prompt = core.buildPrompt('partial sentence', { forSelection: true });
  assert(prompt.includes('选中的片段'), '缺少划词说明');
});

console.log('\n[3.5] 词典模式（单词多义项）');

check('词典 prompt 规定了「词性|释义」格式', () => {
  const prompt = core.buildDictPrompt('section', { targetLang: '简体中文' });
  assert(prompt.includes('section'), '缺少单词');
  assert(prompt.includes('词性|释义'), '缺少格式说明');
  assert(prompt.includes('不要音标'), '缺少音标约束');
  assert(prompt.includes('简体中文'), '缺少目标语言');
});

check('解析标准输出（竖线分隔）', () => {
  const r = core.parseDictResult('n.|部分；段；部门\nv.|把…切成片；作截面图');
  assertEqual(r.senses.length, 2, '义项数');
  assertEqual(r.senses[0].pos, 'n.', '第一行词性');
  assertEqual(r.senses[0].meaning, '部分；段；部门', '第一行释义');
  assertEqual(r.senses[1].pos, 'v.', '第二行词性');
});

check('解析容错：markdown 列表 / 编号 / 加粗 / 代码块', () => {
  const raw = '```\n- **n.** 部分；段\n1. v. 区分；划分\n```';
  const r = core.parseDictResult(raw);
  assertEqual(r.senses.length, 2, '义项数');
  assertEqual(r.senses[0].pos, 'n.', '列表符号或加粗未剥离');
  assertEqual(r.senses[0].meaning, '部分；段', '释义解析错误');
  assertEqual(r.senses[1].pos, 'v.', '编号未剥离');
});

check('解析容错：全角冒号与中文分隔', () => {
  const r = core.parseDictResult('adj.：坚固的；结实的');
  assertEqual(r.senses.length, 1, '义项数');
  assertEqual(r.senses[0].pos, 'adj.', '词性');
  assertEqual(r.senses[0].meaning, '坚固的；结实的', '释义');
});

check('非词典格式时 senses 为空（调用方回退成普通译文）', () => {
  const r = core.parseDictResult('这只是一句普通的译文，没有词性。');
  assertEqual(r.senses.length, 0, '不应解析出义项');
  assert(r.raw.includes('普通'), 'raw 应保留原文');
});

check('义项数量上限', () => {
  const raw = ['n.|一', 'v.|二', 'adj.|三', 'adv.|四', 'prep.|五', 'conj.|六', 'pron.|七'].join('\n');
  const r = core.parseDictResult(raw);
  assert(r.senses.length <= 6, `义项过多: ${r.senses.length}`);
});

console.log('\n[4] 文档生成');

const sampleDoc = {
  title: 'Attention Is All You Need（双语对照样例）',
  meta: 'Vaswani et al. · NeurIPS 2017 · arXiv:1706.03762',
  providerLabel: 'DeepSeek 网页版',
  generatedAt: '2026-11-09 10:40',
  isoTime: '2026-11-09T02:40:00Z',
  truncated: false,
  pairs: [
    {
      source:
        'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder.',
      translation:
        '主流的序列转换模型基于复杂的循环或卷积神经网络，这些网络包含一个编码器和一个解码器。',
      error: null,
    },
    {
      source:
        'We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.\n\nExperiments on two machine translation tasks show these models to be superior in quality.',
      translation:
        '我们提出了一种新的简单网络结构——Transformer，它完全基于注意力机制，彻底摒弃了循环与卷积。\n\n在两个机器翻译任务上的实验表明，这类模型在质量上更优。',
      error: null,
    },
    { source: '（这一段的翻译故意失败，用于检查错误样式。）', translation: '', error: '中继服务超时（180s）' },
  ],
};

const outDir = path.join(root, 'dist', 'test');
fs.mkdirSync(outDir, { recursive: true });

const html = core.buildHtml(sampleDoc);
fs.writeFileSync(path.join(outDir, 'bilingual-sample.html'), html, 'utf8');
check('HTML 结构完整', () => {
  assert(html.startsWith('<!DOCTYPE html>'), 'DOCTYPE 缺失');
  assert(html.includes('<h1>'), '缺少标题');
  assertEqual((html.match(/class="pair"/g) || []).length, 3, 'pair 数量');
  assert(html.includes('本段翻译失败'), '缺少错误提示');
  assert(html.includes('Attention Is All You Need'), '缺少标题文本');
});

const md = core.buildMarkdown(sampleDoc);
fs.writeFileSync(path.join(outDir, 'bilingual-sample.md'), md, 'utf8');
check('Markdown 生成', () => {
  assert(md.startsWith('# '), '缺少一级标题');
  assert(md.includes('**译文**'), '缺少译文标记');
});

const docx = core.buildDocx(sampleDoc);
fs.writeFileSync(path.join(outDir, 'bilingual-sample.docx'), Buffer.from(docx));
check('DOCX 基本结构', () => {
  assert(docx.length > 2000, `docx 太小: ${docx.length}`);
  assertEqual(docx[0], 0x50, 'ZIP 头 P');
  assertEqual(docx[1], 0x4b, 'ZIP 头 K');
  assert(docx.length < 5 * 1024 * 1024, 'docx 过大');
});

check('XML 特殊字符转义', () => {
  const tricky = {
    ...sampleDoc,
    pairs: [{ source: 'a < b & c > d "quote"', translation: '<w:t>非法</w:t> & 结束', error: null }],
  };
  const bytes = core.buildDocx(tricky);
  const text = Buffer.from(bytes).toString('latin1');
  assert(text.includes('a &lt; b &amp; c &gt; d'), '源文本未正确转义');
  assert(!text.includes('<w:t>非法</w:t>'), '译文未正确转义');
});

console.log(`\n产物已写入: ${outDir}`);
if (failures) {
  console.error(`\n\x1b[31m${failures} 个断言失败\x1b[0m\n`);
  process.exit(1);
}
console.log('\n\x1b[32m全部通过\x1b[0m\n');
