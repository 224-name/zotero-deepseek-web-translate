/*
 * DeepSeek 网页翻译 for Zotero
 * bootstrap.js — 插件主逻辑
 *
 * 设计要点：
 *   1. 翻译后端可切换：web（本地中转服务 + 浏览器里的 DeepSeek 网页版，免费）
 *      或 openai（任何 OpenAI 兼容接口，如 DeepSeek API / Ollama / 免费额度的国产模型）。
 *   2. 全文翻译只取 PDF 文字层，不走 OCR；按段落切块后逐块翻译，
 *      最后生成「原文 + 译文」对照的 .docx（失败时回退 .html）。
 *   3. 划词翻译挂在 Zotero 阅读器的文本选择弹窗上：选中即翻译，结果直接画进弹窗；
 *      选中的是单个英文单词时走词典模式（多义项 + 词性）。
 */

var DSWT = {
	id: 'zotero-deepseek-web-translate@local',
	version: '',
	rootURI: '',
	core: null,
	readerHandlers: [],
	state: {
		running: false,
		cancel: false,
		selectionSeq: 0,
		selectionJob: null,
		selectionCache: new Map()
	}
};

// 注意：这里所有顶层声明都用 var —— 插件被“禁用→重新启用”时 bootstrap.js 会在
// 同一个沙箱里重新求值，顶层 const/let 会因重复声明而直接报错。
var DSWT_PREF_PREFIX = 'extensions.zotero.deepseekweb.';

// ============================================================
// 基础工具
// ============================================================

// 把关键日志同时写一份到临时目录，出问题时直接把这个文件发出来即可
// 路径：%TEMP%\deepseek-web-translate.log
var DSWT_LOG_BUFFER = [];
var DSWT_LOG_TIMER = null;

function dswtLog(msg) {
	try {
		Zotero.debug('[DSWT] ' + msg);
	}
	catch (e) { /* ignore */ }

	// 同时发到本地中转服务，这样插件和油猴的日志出现在同一个黑窗口里，排查不用来回切换
	try {
		const base = strPref('bridgeUrl', 'http://127.0.0.1:8765').trim().replace(/\/+$/, '');
		if (base && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) {
			Zotero.HTTP.request('POST', base + '/v1/bridge/log', {
				body: JSON.stringify({ source: 'zotero', message: String(msg).slice(0, 300) }),
				headers: { 'Content-Type': 'application/json' },
				timeout: 4000,
				successCodes: false
			}).then(null, function () { /* 中转没开就算了 */ });
		}
	}
	catch (e) { /* ignore */ }

	try {
		const time = new Date().toTimeString().slice(0, 8);
		DSWT_LOG_BUFFER.push(time + '  ' + msg);
		if (DSWT_LOG_BUFFER.length > 200) DSWT_LOG_BUFFER.shift();
		if (!DSWT_LOG_TIMER) DSWT_LOG_TIMER = setTimeout(flushDswtLog, 600);
	}
	catch (e) { /* ignore */ }
}

async function flushDswtLog() {
	DSWT_LOG_TIMER = null;
	if (!DSWT_LOG_BUFFER.length) return;
	const lines = DSWT_LOG_BUFFER.splice(0);
	try {
		const path = PathUtils.join(Zotero.getTempDirectory().path, 'deepseek-web-translate.log');
		let old = '';
		try {
			old = await Zotero.File.getContentsAsync(path);
		}
		catch (e) { /* 文件还不存在 */ }
		// 日志文件压在 64 KB 以内，超过就只保留最后 32 KB，避免长期占用磁盘
		if (old && old.length > 65536) old = old.slice(-32768);
		await Zotero.File.putContentsAsync(path, (old || '') + lines.join('\n') + '\n');
	}
	catch (e) { /* 记不下来就算了，不能影响主流程 */ }
}

function dswtReadPref(key, fallback) {
	const name = DSWT_PREF_PREFIX + key;
	try {
		switch (Services.prefs.getPrefType(name)) {
			case Services.prefs.PREF_STRING:
				return Services.prefs.getStringPref(name);
			case Services.prefs.PREF_INT:
				return Services.prefs.getIntPref(name);
			case Services.prefs.PREF_BOOL:
				return Services.prefs.getBoolPref(name);
			default:
				return fallback;
		}
	}
	catch (e) {
		return fallback;
	}
}

function strPref(key, fallback) {
	const v = dswtReadPref(key, fallback);
	return v === undefined || v === null ? fallback : String(v);
}

function intPref(key, fallback) {
	const n = parseInt(dswtReadPref(key, fallback), 10);
	return isNaN(n) ? fallback : n;
}

function boolPref(key, fallback) {
	const v = dswtReadPref(key, fallback);
	return typeof v === 'boolean' ? v : fallback;
}

function sleep(ms) {
	return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/**
 * 给任意 Promise 加一道硬超时：底层 XHR 就算永远不 settle，界面也不会一直转圈。
 */
function withTimeout(promise, ms, message) {
	return new Promise(function (resolve, reject) {
		let settled = false;
		const timer = setTimeout(function () {
			if (settled) return;
			settled = true;
			reject(fatal(message));
		}, ms);

		promise.then(function (value) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		}, function (error) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
	});
}

function fatal(message) {
	const err = new Error(message);
	err.fatal = true;
	return err;
}

function cleanError(e) {
	let msg = '';
	try {
		msg = (e && (e.message || e.msg)) ? String(e.message || e.msg) : String(e);
	}
	catch (x) {
		msg = '未知错误';
	}
	msg = msg.replace(/\s+/g, ' ').trim();
	if (msg.length > 400) msg = msg.slice(0, 400) + '…';
	return msg || '未知错误';
}

function formatDateTime(date) {
	const p = function (n) { return String(n).padStart(2, '0'); };
	return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate()) +
		' ' + p(date.getHours()) + ':' + p(date.getMinutes());
}

function providerLabel() {
	if (strPref('provider', 'web') === 'openai') {
		return 'API · ' + strPref('apiModel', 'deepseek-chat');
	}
	return 'DeepSeek 网页版（免费）';
}

// ============================================================
// HTTP
// ============================================================

/**
 * 发一个 JSON 请求。成功返回解析后的对象；失败抛出可读的错误。
 */
async function httpJson(method, url, body, timeout) {
	let xhr = null;
	try {
		xhr = await Zotero.HTTP.request(method, url, {
			body: body === undefined ? undefined : JSON.stringify(body),
			headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
			responseType: 'json',
			timeout: timeout || 60000,
			successCodes: false
		});
	}
	catch (e) {
		if (e && e.xmlhttp) {
			xhr = e.xmlhttp;
		}
		else if (e && e.name === 'TimeoutException') {
			throw fatal('请求超时（' + Math.round((timeout || 60000) / 1000) + ' 秒）：' + url);
		}
		else {
			throw fatal('网络请求失败：' + cleanError(e));
		}
	}

	let data = xhr.response;
	if (typeof data === 'string') {
		try { data = JSON.parse(data); }
		catch (e) { /* 保留原始字符串 */ }
	}

	if (!xhr.status || xhr.status < 200 || xhr.status >= 300) {
		const msg = (data && (data.error || data.message)) || ('HTTP ' + xhr.status + ' ' + (xhr.statusText || ''));
		throw fatal(String(msg));
	}
	return data;
}

// ============================================================
// 翻译后端
// ============================================================

async function translatePrompt(prompt, options) {
	options = options || {};
	if (strPref('provider', 'web') === 'openai') {
		return callOpenAI(prompt, options);
	}
	return callBridge(prompt, options);
}

async function callBridge(prompt, options) {
	const base = strPref('bridgeUrl', 'http://127.0.0.1:8765').trim().replace(/\/+$/, '');
	if (!base) {
		throw fatal('还没有设置本地中转服务地址。请打开「编辑 → 设置 → DeepSeek 网页翻译」填写，默认 http://127.0.0.1:8765');
	}

	const baseTimeout = (intPref('timeoutSec', 180) + 60) * 1000;
	const timeout = (options && options.timeoutMs)
		? Math.min(options.timeoutMs, baseTimeout)
		: baseTimeout;
	const kind = (options && options.kind) || 'text';
	let data;
	try {
		data = await httpJson('POST', base + '/v1/translate', {
			prompt: prompt,
			targetLang: strPref('targetLang', '简体中文'),
			kind: kind,
			// 让中转服务比插件早 10 秒放弃，这样拿到的是中转给的更具体的错误
			timeoutMs: Math.max(15000, timeout - 10000)
		}, timeout);
	}
	catch (e) {
		const msg = cleanError(e);
		if (/请求超时/.test(msg)) {
			throw fatal('等中转服务超时（' + Math.round(timeout / 1000) + ' 秒）。\n' +
				'网页版可能卡住了：看一眼中转服务窗口的日志，或点「重试」。');
		}
		if (/网络请求失败|Failed|Connection|refused|NS_ERROR/i.test(msg)) {
			throw fatal('连不上本地中转服务 ' + base + '。\n' +
				'请先双击运行 bridge\\start-bridge.cmd，并保持一个已登录 DeepSeek 的浏览器标签页开着。\n' +
				'原始错误：' + msg);
		}
		throw e;
	}

	if (!data || !data.ok) {
		throw fatal((data && data.error) || '中转服务没有返回译文');
	}
	const out = String(data.translation || '').trim();
	if (!out) throw fatal('中转服务返回了空译文');
	return out;
}

async function callOpenAI(prompt, options) {
	let base = strPref('apiBase', 'https://api.deepseek.com/v1').trim().replace(/\/+$/, '');
	if (!base) throw fatal('还没有设置 API 地址。请打开「编辑 → 设置 → DeepSeek 网页翻译」填写。');
	const endpoint = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';

	const headers = { 'Content-Type': 'application/json' };
	const key = strPref('apiKey', '').trim();
	if (key) headers.Authorization = 'Bearer ' + key;

	const payload = {
		model: strPref('apiModel', 'deepseek-chat'),
		messages: [
			{ role: 'system', content: DSWT.core.buildSystemPrompt() },
			{ role: 'user', content: prompt }
		],
		temperature: 0.2,
		stream: false
	};

	const baseTimeout = (intPref('timeoutSec', 180) + 30) * 1000;
	const timeout = (options && options.timeoutMs)
		? Math.min(options.timeoutMs, baseTimeout)
		: baseTimeout;
	let data;
	try {
		data = await httpJson('POST', endpoint, payload, timeout);
	}
	catch (e) {
		throw fatal('API 请求失败：' + cleanError(e));
	}

	const choice = data && data.choices && data.choices[0];
	const content = choice && ((choice.message && choice.message.content) || choice.text);
	if (!content) {
		throw fatal('API 返回内容为空：' + JSON.stringify(data).slice(0, 300));
	}
	return String(content).trim();
}

// ============================================================
// 从附件取文本
// ============================================================

function normalizeFullTextResult(res) {
	if (!res) return '';
	if (typeof res === 'string') return res;
	if (typeof res.text === 'string') return res.text;
	if (typeof res.content === 'string') return res.content;
	if (Array.isArray(res)) {
		return res.map(function (part) {
			if (typeof part === 'string') return part;
			if (part && typeof part.text === 'string') return part.text;
			if (part && typeof part.content === 'string') return part.content;
			return '';
		}).filter(Boolean).join('\n');
	}
	return '';
}

async function readFulltextCache(attachment) {
	// 优先用 Zotero 的全文缓存（如果索引过）
	try {
		if (typeof Zotero.Fulltext.getItemCacheFile === 'function') {
			const cacheFile = Zotero.Fulltext.getItemCacheFile(attachment);
			if (cacheFile) {
				const text = await Zotero.File.getContentsAsync(cacheFile);
				if (text && text.trim()) return text;
			}
		}
	}
	catch (e) { /* 继续尝试后面的办法 */ }

	try {
		const dir = Zotero.getStorageDirectory().clone();
		dir.append(attachment.key);
		const file = dir.clone();
		file.append('.zotero-ft-cache');
		const text = await Zotero.File.getContentsAsync(file.path);
		if (text && text.trim()) return text;
	}
	catch (e) { /* ignore */ }
	return '';
}

async function getAttachmentText(attachment) {
	let text = '';
	if (attachment.isPDFAttachment && attachment.isPDFAttachment()) {
		try {
			const res = await Zotero.PDFWorker.getFullText(attachment.id);
			text = normalizeFullTextResult(res);
		}
		catch (e) {
			dswtLog('PDFWorker.getFullText 失败：' + cleanError(e));
		}
		if (text && text.trim()) return text;
		return await readFulltextCache(attachment);
	}

	// 纯文本类附件直接读文件
	const type = String(attachment.attachmentContentType || '');
	if (/^text\//.test(type) || /\.(txt|md|markdown|html?)$/i.test(attachment.attachmentFilename || '')) {
		try {
			return await Zotero.File.getContentsAsync(await attachment.getFilePathAsync());
		}
		catch (e) { /* ignore */ }
	}
	return '';
}

// ============================================================
// 文档元信息
// ============================================================

function safeField(item, field) {
	try {
		const v = item.getField(field);
		return v === undefined || v === null ? '' : String(v);
	}
	catch (e) {
		return '';
	}
}

function describeAttachment(attachment) {
	const parent = attachment.parentItem;
	let title = '';
	let meta = '';
	if (parent) {
		title = safeField(parent, 'title');
		const creators = (parent.getCreators() || []).map(function (c) {
			if (c.name) return c.name;
			return [c.firstName, c.lastName].filter(Boolean).join(' ');
		}).filter(Boolean);
		const yearMatch = safeField(parent, 'date').match(/\d{4}/);
		const year = yearMatch ? yearMatch[0] : '';
		const pub = safeField(parent, 'publicationTitle') || safeField(parent, 'publisher') || safeField(parent, 'conferenceName');
		const parts = [];
		if (creators.length) {
			parts.push(creators.slice(0, 3).join(', ') + (creators.length > 3 ? ' 等' : ''));
		}
		if (year) parts.push(year);
		if (pub) parts.push(pub);
		meta = parts.join(' · ');
	}
	if (!title) {
		title = attachment.getField('title') || attachment.attachmentFilename || '未命名文献';
	}
	return { title: title, meta: meta };
}

// ============================================================
// 全文翻译
// ============================================================

function findPdfAttachment(item) {
	if (!item) return null;
	try {
		if (item.isAttachment && item.isAttachment()) {
			if (item.isPDFAttachment && item.isPDFAttachment()) return item;
			return null;
		}
		if (item.isRegularItem && item.isRegularItem()) {
			const ids = item.getAttachments() || [];
			let fallback = null;
			for (const id of ids) {
				const att = Zotero.Items.get(id);
				if (!att || !att.isPDFAttachment || !att.isPDFAttachment()) continue;
				if (!fallback) fallback = att;
				if (att.attachmentLinkMode !== Zotero.Attachments.LINK_MODE_LINKED_FILE) return att;
			}
			return fallback;
		}
	}
	catch (e) {
		dswtLog('findPdfAttachment: ' + cleanError(e));
	}
	return null;
}

async function translateChunkWithRetry(text, retries) {
	const prompt = DSWT.core.buildPrompt(text, {
		targetLang: strPref('targetLang', '简体中文'),
		style: strPref('promptStyle', 'academic')
	});

	let lastErr = null;
	for (let attempt = 0; attempt <= retries; attempt++) {
		if (DSWT.state.cancel) throw fatal('已取消');
		try {
			const out = await translatePrompt(prompt);
			if (!out || !out.trim()) throw new Error('译文为空');
			return out.trim();
		}
		catch (e) {
			lastErr = e;
			if (e && e.fatal) throw e;
			dswtLog('第 ' + (attempt + 1) + ' 次翻译失败：' + cleanError(e));
			if (attempt < retries) await sleep(1500 * (attempt + 1));
		}
	}
	throw lastErr || new Error('翻译失败');
}

async function importAsChild(attachment, filePath, title, fileBaseName) {
	const options = { file: filePath, title: title, fileBaseName: fileBaseName };
	if (attachment.parentItemID) options.parentItemID = attachment.parentItemID;
	else options.libraryID = attachment.libraryID;

	const item = await Zotero.Attachments.importFromFile(options);
	if (!item) throw new Error('导入生成的文档失败');
	try {
		if (item.getField('title') !== title) {
			item.setField('title', title);
			await item.saveTx();
		}
	}
	catch (e) { /* 标题设置失败不影响主流程 */ }
	return item;
}

async function writeDocx(attachment, docData) {
	const bytes = DSWT.core.buildDocx(docData);
	const tmpName = 'dswt-' + Zotero.Utilities.randomString(8) + '.docx';
	const path = PathUtils.join(Zotero.getTempDirectory().path, tmpName);
	await IOUtils.write(path, bytes);

	const baseName = Zotero.File.getValidFileName('DeepSeek双语对照-' + docData.title).slice(0, 70);
	try {
		return await importAsChild(attachment, path, docData.title + '（双语对照）', baseName);
	}
	finally {
		// 导入会把文件复制进 Zotero 存储目录，临时文件必须删掉，否则 %TEMP% 会越攒越多
		try { await IOUtils.remove(path, { ignoreAbsent: true }); }
		catch (e) { dswtLog('删除临时 docx 失败：' + cleanError(e)); }
	}
}

async function writeHtml(attachment, docData) {
	const html = DSWT.core.buildHtml(docData);
	const tmpName = 'dswt-' + Zotero.Utilities.randomString(8) + '.html';
	const path = PathUtils.join(Zotero.getTempDirectory().path, tmpName);
	await Zotero.File.putContentsAsync(path, html);

	const baseName = Zotero.File.getValidFileName('DeepSeek双语对照-' + docData.title).slice(0, 70);
	try {
		return await importAsChild(attachment, path, docData.title + '（双语对照）', baseName);
	}
	finally {
		try { await IOUtils.remove(path, { ignoreAbsent: true }); }
		catch (e) { dswtLog('删除临时 html 失败：' + cleanError(e)); }
	}
}

/**
 * 翻译单个附件并生成对照文档
 * @returns {Promise<{title: string, chunks: number, failed: number}>}
 */
async function translateOneAttachment(attachment, line) {
	if (!DSWT.core) throw new Error('插件核心未加载');

	line.setText('正在提取 PDF 文字…');
	line.setProgress(1);
	const raw = await getAttachmentText(attachment);
	if (!raw || raw.trim().length < 30) {
		throw new Error('没能从这个附件里提取到文字。扫描版 PDF 需要先做 OCR（Zotero 里可用「识别文字」功能），或者换一个有文字层的版本。');
	}

	const normalized = DSWT.core.normalizeText(raw);
	const paragraphs = DSWT.core.splitParagraphs(normalized);
	if (!paragraphs.length) throw new Error('提取到的文字为空');

	const built = DSWT.core.buildChunks(paragraphs, {
		chunkSize: intPref('chunkSize', 1200),
		maxChunks: intPref('maxChunks', 150)
	});
	const chunks = built.chunks;
	if (!chunks.length) throw new Error('分块失败');

	dswtLog('待翻译 ' + chunks.length + ' 块，共 ' + built.totalChars + ' 字');

	const pairs = [];
	let failed = 0;
	let consecutiveFailures = 0;

	for (let i = 0; i < chunks.length; i++) {
		if (DSWT.state.cancel) throw fatal('已取消');
		const pct = Math.round((i / chunks.length) * 100);
		line.setText('翻译第 ' + (i + 1) + '/' + chunks.length + ' 段（' + pct + '%）');
		line.setProgress(Math.max(2, Math.min(99, pct)));

		try {
			const translation = await translateChunkWithRetry(chunks[i], 2);
			pairs.push({ source: chunks[i], translation: translation, error: null });
			consecutiveFailures = 0;
		}
		catch (e) {
			if (e && e.fatal && DSWT.state.cancel) throw e;
			if (e && e.fatal && /连不上|没有设置|API 请求失败/.test(cleanError(e))) throw e;
			consecutiveFailures++;
			failed++;
			pairs.push({ source: chunks[i], translation: '', error: cleanError(e) });
			dswtLog('第 ' + (i + 1) + ' 段失败：' + cleanError(e));
			if (consecutiveFailures >= 3) {
				throw new Error('连续 ' + consecutiveFailures + ' 段翻译失败，已中止。最后错误：' + cleanError(e));
			}
		}
	}

	if (!pairs.length) throw new Error('没有任何段落翻译成功');

	line.setText('正在生成对照文档…');
	line.setProgress(99);

	const described = describeAttachment(attachment);
	const now = new Date();
	const docData = {
		title: described.title,
		meta: described.meta,
		pairs: pairs,
		providerLabel: providerLabel(),
		generatedAt: formatDateTime(now),
		isoTime: now.toISOString(),
		truncated: built.truncated
	};

	const made = [];
	const fmt = strPref('outputFormat', 'docx');
	if (fmt === 'docx' || fmt === 'both') {
		try {
			made.push(await writeDocx(attachment, docData));
			dswtLog('已生成 docx');
		}
		catch (e) {
			Zotero.logError(e);
			dswtLog('docx 生成失败，回退 HTML：' + cleanError(e));
		}
	}
	if (fmt === 'html' || fmt === 'both' || !made.length) {
		made.push(await writeHtml(attachment, docData));
		dswtLog('已生成 html');
	}
	if (!made.length) throw new Error('文档生成失败');

	line.setProgress(100);
	return { title: docData.title, chunks: chunks.length, failed: failed, item: made[0] };
}

/**
 * 批量翻译（一次只跑一个任务）
 */
async function runFullTranslation(attachments) {
	if (DSWT.state.running) {
		notify('已经有一个翻译任务在进行中了。可以在「工具 → 取消正在进行的 DeepSeek 翻译」里中止。', true);
		return;
	}

	DSWT.state.running = true;
	DSWT.state.cancel = false;

	const pw = new Zotero.ProgressWindow({ closeOnClick: false });
	let line = null;
	try {
		pw.changeHeadline('DeepSeek 全文翻译');
		pw.show();
		line = new pw.ItemProgress('document', '准备中…');

		for (let i = 0; i < attachments.length; i++) {
			if (DSWT.state.cancel) break;
			const attachment = attachments[i];
			const described = describeAttachment(attachment);
			line.setText(described.title);
			line.setProgress(0);
			try {
				const result = await translateOneAttachment(attachment, line);
				line.setProgress(100);
				line.setText('完成：' + result.title +
					(result.failed ? '（' + result.failed + ' 段失败）' : ''));
			}
			catch (e) {
				if (DSWT.state.cancel) {
					line.setText('已取消');
					break;
				}
				Zotero.logError(e);
				const message = cleanError(e);
				line.setError();
				line.setText('失败：' + message.slice(0, 120));
				notify('「' + described.title + '」翻译失败：\n' + message, true);
			}
		}
		if (DSWT.state.cancel) {
			line.setText('已取消');
		}
	}
	catch (e) {
		Zotero.logError(e);
		notify('翻译任务出错：' + cleanError(e), true);
	}
	finally {
		DSWT.state.running = false;
		DSWT.state.cancel = false;
		try { pw.startCloseTimer(6000); }
		catch (e) { /* ignore */ }
	}
}

function notify(text, isError) {
	try {
		const pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline(isError ? 'DeepSeek 翻译 · 出错了' : 'DeepSeek 翻译');
		pw.addDescription(String(text).slice(0, 800));
		const line = new pw.ItemProgress('document', isError ? '请检查后重试' : '完成');
		if (isError) line.setError();
		else line.setProgress(100);
		pw.show();
		pw.startCloseTimer(isError ? 10000 : 3500);
	}
	catch (e) {
		Zotero.logError(e);
	}
}

// ============================================================
// 连接自检
// ============================================================

async function runSelfCheck() {
	if (strPref('provider', 'web') === 'openai') {
		const base = strPref('apiBase', '');
		const key = strPref('apiKey', '');
		if (!base) {
			notify('当前是 API 模式，但还没填 API 地址。\n示例：https://api.deepseek.com/v1', true);
			return;
		}
		if (!key && !/localhost|127\.0\.0\.1/.test(base)) {
			notify('当前是 API 模式，但没有填 API Key。\n如果用的是本机 Ollama 之类不需要 Key 的服务，可以忽略这一条。', true);
			return;
		}
		notify('API 模式配置看起来没问题：\n' + base + '\n模型：' + strPref('apiModel', 'deepseek-chat') +
			'\n\n真正的连通性要等第一次翻译时才能确认。');
		return;
	}

	const base = strPref('bridgeUrl', 'http://127.0.0.1:8765').trim().replace(/\/+$/, '');
	try {
		const data = await httpJson('GET', base + '/v1/health', undefined, 8000);
		const connected = !!(data && data.userscript && data.userscript.connected);
		if (connected) {
			notify('一切正常：\n中转服务 ' + base + ' 在运行，浏览器里的 DeepSeek 标签页已连接。');
		}
		else {
			notify('中转服务已在 ' + base + ' 运行，但浏览器里的 DeepSeek 标签页还没有连上。\n\n请检查：\n' +
				'1. 已安装油猴（Tampermonkey）并启用「DeepSeek 网页版翻译桥」脚本；\n' +
				'2. 浏览器打开了 https://chat.deepseek.com 并已登录；\n' +
				'3. 该页面左下角出现绿色的「桥已连接」标识。', true);
		}
	}
	catch (e) {
		notify('连不上中转服务 ' + base + '。\n\n请先双击运行：\nbridge\\start-bridge.cmd\n\n原始错误：' + cleanError(e), true);
	}
}

// ============================================================
// 菜单
// ============================================================

var DSWT_MENU_IDS = {
	item: 'dswt-itemmenu-fulltext',
	toolsSep: 'dswt-tools-sep',
	toolsSettings: 'dswt-tools-settings',
	toolsCheck: 'dswt-tools-check',
	toolsCancel: 'dswt-tools-cancel'
};

function makeMenuItem(doc, id, label, handler) {
	const item = doc.createXULElement('menuitem');
	item.id = id;
	item.setAttribute('label', label);
	item.addEventListener('command', function (event) {
		try {
			handler(event);
		}
		catch (e) {
			Zotero.logError(e);
			notify('操作失败：' + cleanError(e), true);
		}
	});
	return item;
}

function addMenus(win) {
	const doc = win && win.document;
	if (!doc) return;

	if (!doc.getElementById(DSWT_MENU_IDS.item)) {
		const itemMenu = doc.getElementById('zotero-itemmenu');
		if (itemMenu) {
			itemMenu.appendChild(makeMenuItem(doc, DSWT_MENU_IDS.item,
				'DeepSeek 全文翻译（生成双语文档）',
				function () { translateSelectedItems(win); }));
		}
	}

	if (!doc.getElementById(DSWT_MENU_IDS.toolsSettings)) {
		const tools = doc.getElementById('menu_ToolsPopup');
		if (tools) {
			const sep = doc.createXULElement('menuseparator');
			sep.id = DSWT_MENU_IDS.toolsSep;
			tools.appendChild(sep);

			tools.appendChild(makeMenuItem(doc, DSWT_MENU_IDS.toolsSettings,
				'DeepSeek 网页翻译设置…',
				function () {
					try {
						Zotero.Utilities.Internal.openPreferences('zotero-prefpane-deepseekweb');
					}
					catch (e) {
						Zotero.logError(e);
						notify('打开设置失败：' + cleanError(e), true);
					}
				}));

			tools.appendChild(makeMenuItem(doc, DSWT_MENU_IDS.toolsCheck,
				'DeepSeek 翻译连接自检',
				function () { runSelfCheck(); }));

			tools.appendChild(makeMenuItem(doc, DSWT_MENU_IDS.toolsCancel,
				'取消正在进行的 DeepSeek 翻译',
				function () {
					if (!DSWT.state.running) {
						notify('当前没有正在进行的翻译任务。');
						return;
					}
					DSWT.state.cancel = true;
					notify('已请求取消，正在结束当前段落…');
				}));
		}
	}
}

function removeMenus(win) {
	const doc = win && win.document;
	if (!doc) return;
	Object.keys(DSWT_MENU_IDS).forEach(function (key) {
		const el = doc.getElementById(DSWT_MENU_IDS[key]);
		if (el && el.parentNode) el.parentNode.removeChild(el);
	});
}

async function translateSelectedItems(win) {
	if (DSWT.state.running) {
		notify('已经有一个翻译任务在进行中了。可以在「工具」菜单里取消。', true);
		return;
	}

	let items = [];
	try {
		items = win.ZoteroPane ? win.ZoteroPane.getSelectedItems() : [];
	}
	catch (e) {
		dswtLog('读取选中条目失败：' + cleanError(e));
	}
	if (!items.length) {
		notify('请先在中间的文献列表里选中一个条目或 PDF 附件。', true);
		return;
	}

	const attachments = [];
	for (const item of items) {
		const att = findPdfAttachment(item);
		if (att && !attachments.some(function (a) { return a.id === att.id; })) {
			attachments.push(att);
		}
	}
	if (!attachments.length) {
		notify('选中的条目里没有找到 PDF 附件。\n目前全文翻译只支持带文字层的 PDF。', true);
		return;
	}

	await runFullTranslation(attachments);
}

// ============================================================
// 阅读器：划词翻译 + 工具栏按钮
// ============================================================

// ------------------------------------------------------------------
// 划词翻译：结果直接渲染进 Zotero 的选词弹窗（不再另外弹浮窗）
// ------------------------------------------------------------------

var DSWT_BOX_WIDTH = '322px';
var DSWT_MAX_AUTO_LEN = 600; // 超过这个长度不自动翻译，改为显示按钮
var DSWT_SELECTION_TIMEOUT = 90000; // 划词请求最长等 90 秒（浏览器端 45 秒、中转 80 秒，这里留余量）

function copyText(text) {
	try {
		Zotero.Utilities.Internal.copyTextToClipboard(String(text));
		return true;
	}
	catch (e) { /* 尝试下一种方式 */ }

	try {
		const win = Zotero.getMainWindow();
		if (win && win.navigator && win.navigator.clipboard) {
			win.navigator.clipboard.writeText(String(text));
			return true;
		}
	}
	catch (e) { /* ignore */ }
	return false;
}

/**
 * 选中的是不是"一个英文单词"——是的话走词典模式（多义项 + 词性）
 */
function looksLikeWord(text) {
	const t = String(text || '').trim();
	if (!t || t.length > 40) return false;
	if (/\s/.test(t)) return false;
	return /^[A-Za-z][A-Za-z'\u2019.\-]*$/.test(t);
}

function createSelectionBox(doc) {
	const box = doc.createElement('div');
	box.className = 'dswt-box';
	box.setAttribute('style', [
		'box-sizing:border-box',
		// 0.2.9 曾改成 width:100% 想跟着弹窗变宽，实测反而更差，回退为固定宽度。
		'width:' + DSWT_BOX_WIDTH,
		'max-width:100%',
		'margin:2px',
		'font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif',
		'color:#1b1b1b',
		'user-select:text'
	].join(';'));
	return box;
}

function boxLine(doc, text, extraStyle) {
	const el = doc.createElement('div');
	el.setAttribute('style', 'white-space:pre-wrap;word-break:break-word;' + (extraStyle || ''));
	el.textContent = text;
	return el;
}

/**
 * 用节点数组替换容器内容。
 *
 * 这里绝对不能写 `el.replaceChildren.apply(el, nodes)`：
 * el 是阅读器 iframe（内容进程）里的 DOM 元素，nodes 是插件沙箱里的数组，
 * Gecko 会去读沙箱数组的 length，直接抛
 * "Permission denied to access property \"length\""。
 * 逐个 appendChild 就没有跨 compartment 的序列转换问题。
 */
function setBoxChildren(el, nodes) {
	try {
		while (el.firstChild) el.removeChild(el.firstChild);
	}
	catch (e) { /* ignore */ }

	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i];
		if (!node) continue;
		try {
			el.appendChild(node);
		}
		catch (e) { /* 单个节点失败不影响其它 */ }
	}
}

function boxButton(doc, label, onClick) {	const btn = doc.createElement('button');
	btn.type = 'button';
	btn.textContent = label;
	btn.setAttribute('style', [
		'border:1px solid #d8dce2', 'background:#f7f8fa', 'color:#374151',
		'border-radius:5px', 'padding:2px 9px', 'font-size:11.5px',
		'line-height:1.7', 'cursor:pointer'
	].join(';'));
	btn.addEventListener('click', function (event) {
		event.preventDefault();
		event.stopPropagation();
		onClick();
	});
	return btn;
}

function resultPlainText(result) {
	if (!result) return '';
	if (result.kind === 'dict') {
		return result.senses.map(function (sense) {
			return (sense.pos ? sense.pos + ' ' : '') + sense.meaning;
		}).join('\n');
	}
	return result.text || '';
}

function boxFooter(doc, job, result) {
	const foot = doc.createElement('div');
	foot.setAttribute('style', 'display:flex;gap:6px;align-items:center;margin-top:6px');

	const copyBtn = boxButton(doc, '复制', function () {
		copyText(resultPlainText(result));
		copyBtn.textContent = '已复制';
		setTimeout(function () { copyBtn.textContent = '复制'; }, 1200);
	});
	foot.appendChild(copyBtn);
	foot.appendChild(boxButton(doc, '重试', function () {
		runSelectionTranslation(job, { force: true });
	}));

	return foot;
}

function stopTicker(job) {
	if (job && job.timer) {
		clearInterval(job.timer);
		job.timer = null;
	}
}

/**
 * 确保结果有地方可画。
 *
 * Zotero 会在某些时机重建选词弹窗的 DOM（但不会再次触发 renderTextSelectionPopup），
 * 我们 append 进去的盒子就成了孤儿：计时器停止刷新、译文写进失效节点、
 * 用户看到的就是永远停在「翻译中… N 秒」。
 * 这里在盒子失效时，就地生成一个浮层顶上，保证结果一定看得见。
 */
function ensureRenderTarget(job, force) {
	const doc = job.doc;
	if (!force && job.box && job.box.isConnected) return job.box;

	dswtLog('结果盒子已脱离页面，改用浮层兜底显示');

	// 之前生成过的浮层先清掉，避免叠好几层
	if (job.fallback && job.fallback.parentNode) {
		job.fallback.parentNode.removeChild(job.fallback);
		job.fallback = null;
	}

	const wrap = doc.createElement('div');
	wrap.className = 'dswt-fallback';

	const rect = job.anchorRect || {};
	const viewWidth = doc.documentElement ? doc.documentElement.clientWidth : 900;
	const viewHeight = doc.documentElement ? doc.documentElement.clientHeight : 700;
	const left = Math.max(8, Math.min(Number(rect.left) || 80, viewWidth - 336));
	const top = Math.max(8, Math.min(Number(rect.top) || 80, viewHeight - 180));

	wrap.setAttribute('style', [
		'position:fixed',
		'left:' + Math.round(left) + 'px',
		'top:' + Math.round(top) + 'px',
		'width:322px',
		'z-index:2147483000',
		'background:#fff',
		'color:#1b1b1b',
		'border:1px solid rgba(0,0,0,.16)',
		'border-radius:10px',
		'box-shadow:0 10px 30px rgba(0,0,0,.25)',
		'padding:9px 11px 8px',
		'font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif',
		'user-select:text'
	].join(';'));

	const close = doc.createElement('button');
	close.type = 'button';
	close.textContent = '✕';
	close.title = '关闭';
	close.setAttribute('style',
		'position:absolute;right:5px;top:3px;border:0;background:transparent;cursor:pointer;' +
		'color:#9aa3af;font-size:12px;padding:2px 4px');
	close.addEventListener('click', function (event) {
		event.preventDefault();
		event.stopPropagation();
		if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
	});

	const content = doc.createElement('div');
	content.setAttribute('style', 'padding-right:14px');

	wrap.appendChild(close);
	wrap.appendChild(content);
	doc.body.appendChild(wrap);

	job.fallback = wrap;
	job.box = content;
	return content;
}

/**
 * 画结果：先画进原盒子；万一画完发现盒子在渲染瞬间失效了，
 * 强制换浮层再画一次（这种情况在 Zotero 重建弹窗时确实会碰到）。
 */
function paintResult(job, result) {
	job.box = ensureRenderTarget(job);
	renderSelectionResult(job, result);
	if (!job.box.isConnected) {
		job.box = ensureRenderTarget(job, true);
		renderSelectionResult(job, result);
	}
}

function paintError(job, message) {
	job.box = ensureRenderTarget(job);
	showError(job.doc, job.box, message, job);
	if (!job.box.isConnected) {
		job.box = ensureRenderTarget(job, true);
		showError(job.doc, job.box, message, job);
	}
}

function showLoading(doc, job) {
	const started = Date.now();
	stopTicker(job);

	const paint = function () {
		try {
			// 弹窗被关掉（盒子脱离文档）就停掉计时器，避免空转
			if (!job.box || !job.box.isConnected) {
				stopTicker(job);
				dswtLog('计时器停止：结果盒子已脱离页面（结果回来时会改用浮层显示）');
				return;
			}
			const seconds = Math.round((Date.now() - started) / 1000);
			let text = '翻译中…';
			if (seconds >= 3) text += ' ' + seconds + ' 秒';
			if (seconds >= 45) text += '（较慢，可看中转服务窗口的日志）';
			setBoxChildren(job.box, [boxLine(doc, text, 'color:#8b93a1;font-size:12.5px')]);
		}
		catch (e) {
			stopTicker(job);
			dswtLog('计时器异常停止：' + cleanError(e));
		}
	};

	paint();
	job.timer = setInterval(paint, 1000);
}

function showManualButton(doc, box, job, length) {
	const wrap = doc.createElement('div');
	wrap.setAttribute('style', 'display:flex;align-items:center;gap:8px');

	if (length > DSWT_MAX_AUTO_LEN) {
		const tip = doc.createElement('span');
		tip.setAttribute('style', 'color:#8b93a1;font-size:11.5px');
		tip.textContent = '已选 ' + length + ' 字符';
		wrap.appendChild(tip);
	}

	wrap.appendChild(boxButton(doc, strPref('selectionLabel', '译'), function () {
		runSelectionTranslation(job);
	}));
	setBoxChildren(box, [wrap]);
}

function showDictResult(doc, job, result) {
	stopTicker(job);
	const children = [];

	const head = doc.createElement('div');
	head.setAttribute('style', 'font-size:11.5px;color:#8b93a1;margin-bottom:1px;font-style:italic');
	head.textContent = job.text;
	children.push(head);

	for (const sense of result.senses) {
		const row = doc.createElement('div');
		row.setAttribute('style', 'display:flex;gap:7px;align-items:flex-start;margin:1px 0');

		const pos = doc.createElement('span');
		pos.setAttribute('style',
			'flex:0 0 auto;min-width:26px;color:#7c5c26;font-style:italic;font-size:12px;line-height:1.7');
		pos.textContent = sense.pos || '';
		row.appendChild(pos);

		const meaning = doc.createElement('span');
		meaning.setAttribute('style', 'flex:1 1 auto;word-break:break-word');
		meaning.textContent = sense.meaning;
		row.appendChild(meaning);

		children.push(row);
	}

	children.push(boxFooter(doc, job, result));
	setBoxChildren(job.box, children);
}

function showTextResult(doc, job, result) {
	stopTicker(job);
	const text = String(result.text || '');
	const style = text.length > 240
		? 'font-size:13px;max-height:220px;overflow:auto;'
		: 'font-size:13px;';

	const children = [boxLine(doc, text, style)];
	children.push(boxFooter(doc, job, result));
	setBoxChildren(job.box, children);
}

function showError(doc, box, message, job) {
	stopTicker(job);
	const children = [boxLine(doc, '翻译失败：' + message, 'color:#b42318;font-size:12.5px;')];
	const foot = doc.createElement('div');
	foot.setAttribute('style', 'display:flex;gap:6px;margin-top:6px');
	foot.appendChild(boxButton(doc, '重试', function () {
		runSelectionTranslation(job, { force: true });
	}));
	children.push(foot);
	setBoxChildren(box, children);
}

/**
 * 翻译一段选中文字，并把结果画进它自己的弹窗盒子。
 *
 * 刻意不做「令牌过期就丢弃」的判断：每个 job 只往自己的盒子写，
 * 旧弹窗被销毁时盒子也一起没了，多写一次没有副作用；
 * 反过来，误判一次就会让界面永远停在「翻译中…」。
 */
async function runSelectionTranslation(job, options) {
	options = options || {};
	const doc = job.doc;
	const targetLang = strPref('targetLang', '简体中文');
	const isWord = looksLikeWord(job.text);
	const cacheKey = (isWord ? 'word|' : 'text|') + targetLang + '|' + job.text;

	showLoading(doc, job);

	try {
		// 命中缓存直接出结果（重复选中同一个词时几乎无延迟）
		if (!options.force && DSWT.state.selectionCache.has(cacheKey)) {
			paintResult(job, DSWT.state.selectionCache.get(cacheKey));
			return;
		}

		dswtLog('划词开始：' + job.text.length + ' 字 · ' + (isWord ? '词典模式' : '句子模式') +
			' · ' + providerLabel());

		let prompt;
		if (isWord) {
			prompt = DSWT.core.buildDictPrompt(job.text, { targetLang: targetLang });
		}
		else {
			prompt = DSWT.core.buildPrompt(job.text, {
				targetLang: targetLang,
				style: strPref('promptStyle', 'academic'),
				forSelection: true
			});
		}

		// 双保险：HTTP 层有 timeout，这里再加一道「无论底层怎么卡都不会超过 N 秒」的硬超时
		raw = await withTimeout(
			translatePrompt(prompt, { kind: 'selection', timeoutMs: DSWT_SELECTION_TIMEOUT }),
			DSWT_SELECTION_TIMEOUT + 5000,
			'划词等待超时（' + Math.round(DSWT_SELECTION_TIMEOUT / 1000) + ' 秒），可以点「重试」'
		);
		dswtLog('划词返回：' + String(raw || '').length + ' 字');

		let result;
		if (isWord) {
			const parsed = DSWT.core.parseDictResult(raw);
			result = parsed.senses.length
				? { kind: 'dict', senses: parsed.senses }
				: { kind: 'text', text: String(parsed.raw || raw || '').trim() };
		}
		else {
			result = { kind: 'text', text: String(raw || '').trim() };
		}

		DSWT.state.selectionCache.set(cacheKey, result);
		if (DSWT.state.selectionCache.size > 200) {
			const oldest = DSWT.state.selectionCache.keys().next().value;
			DSWT.state.selectionCache.delete(oldest);
		}

		dswtLog('准备渲染 · 类型=' + result.kind + ' · 盒子已挂载=' + job.box.isConnected);
		paintResult(job, result);
		dswtLog('渲染完成');

		if (boolPref('selectionAutoCopy', false)) {
			copyText(resultPlainText(result));
		}
	}
	catch (e) {
		Zotero.logError(e);
		dswtLog('划词失败：' + cleanError(e));
		// 渲染阶段也可能抛错，这里统一兜底，绝不让界面停在加载态
		try {
			paintError(job, cleanError(e));
		}
		catch (e2) {
			Zotero.logError(e2);
		}
	}
}

function renderSelectionResult(job, result) {
	if (result.kind === 'dict') {
		showDictResult(job.doc, job, result);
	}
	else {
		showTextResult(job.doc, job, result);
	}
}

function onRenderTextSelectionPopup(event) {
	try {
		const doc = event && event.doc;
		const params = event && event.params;
		const append = event && event.append;
		if (!doc || typeof append !== 'function') return;

		const text = ((params && params.annotation && params.annotation.text) || '').trim();
		if (!text) return;

		// 同一个弹窗里只保留一个结果盒子；旧的兜底浮层也一并清掉
		for (const selector of ['.dswt-box', '.dswt-fallback']) {
			const olds = doc.querySelectorAll(selector);
			for (const old of olds) {
				if (old.parentNode) old.parentNode.removeChild(old);
			}
		}

		const box = createSelectionBox(doc);
		append(box);

		// 记住盒子位置：万一弹窗被重建，浮层兜底就画在原地
		let anchorRect = null;
		try {
			const rect = box.getBoundingClientRect();
			anchorRect = { left: rect.left, top: rect.bottom + 6 };
		}
		catch (e) { /* ignore */ }

		const job = {
			text: text,
			doc: doc,
			box: box,
			anchorRect: anchorRect,
			token: DSWT.state.selectionSeq + 1
		};
		DSWT.state.selectionSeq = job.token;
		DSWT.state.selectionJob = job;
		dswtLog('弹窗触发 · ' + text.length + ' 字 · seq=' + job.token +
			' · 自动翻译=' + boolPref('selectionAuto', true));

		const auto = boolPref('selectionAuto', true);
		if (auto && text.length <= DSWT_MAX_AUTO_LEN) {
			showLoading(doc, job);
			// 拖选时弹窗会反复重建，稍等一下再发请求，避免连发
			setTimeout(function () {
				// 只有「当前这一次选择」才发请求，拖选过程中的中间态直接跳过
				if (job.token === DSWT.state.selectionSeq) {
					runSelectionTranslation(job);
				}
			}, 300);
		}
		else {
			showManualButton(doc, box, job, text.length);
		}
	}
	catch (e) {
		Zotero.logError(e);
	}
}

function readerAttachment(reader) {
	try {
		if (!reader) return null;
		if (reader._item && reader._item.id) return reader._item;
		if (reader.itemID) return Zotero.Items.get(reader.itemID) || null;
	}
	catch (e) {
		dswtLog('readerAttachment: ' + cleanError(e));
	}
	return null;
}

function onRenderToolbar(event) {
	try {
		const doc = event && event.doc;
		const append = event && event.append;
		if (!doc || typeof append !== 'function') return;
		if (doc.getElementById('dswt-toolbar-button')) return;

		const button = doc.createElement('button');
		button.id = 'dswt-toolbar-button';
		button.type = 'button';
		button.textContent = '全文翻译';
		button.title = 'DeepSeek 全文翻译：只翻译文字部分，生成双语文档';
		button.setAttribute('style', [
			'height:24px', 'padding:0 8px', 'margin:0 4px',
			'border:1px solid rgba(0,0,0,.15)', 'border-radius:5px',
			'background:rgba(255,255,255,.92)', 'color:#1f2937',
			'font:12px/1 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
			'cursor:pointer'
		].join(';'));

		button.addEventListener('click', function (clickEvent) {
			clickEvent.preventDefault();
			clickEvent.stopPropagation();
			const attachment = readerAttachment(event.reader);
			if (!attachment) {
				notify('没有找到这个阅读器对应的附件。', true);
				return;
			}
			const pdf = findPdfAttachment(attachment);
			if (!pdf) {
				notify('当前文档不是带文字层的 PDF，暂不支持全文翻译。', true);
				return;
			}
			runFullTranslation([pdf]);
		});

		append(button);
	}
	catch (e) {
		Zotero.logError(e);
	}
}

// ============================================================
// 生命周期
// ============================================================

function install() {}

async function startup({ id, version, resourceURI, rootURI }) {
	await Zotero.initializationPromise;

	if (!rootURI && resourceURI) rootURI = resourceURI.spec;

	DSWT.id = id;
	DSWT.version = version;
	DSWT.rootURI = rootURI;

	// 加载纯逻辑核心
	const scope = {};
	Services.scriptloader.loadSubScript(rootURI + 'content/core.js', scope);
	if (!scope.DSWTCore) throw new Error('core.js 加载失败');
	DSWT.core = scope.DSWTCore;

	// 注册偏好面板
	try {
		await Zotero.PreferencePanes.register({
			pluginID: id,
			src: 'content/preferences.xhtml',
			id: 'zotero-prefpane-deepseekweb',
			label: 'DeepSeek 网页翻译',
			image: 'content/icon.svg'
		});
	}
	catch (e) {
		Zotero.logError(e);
		dswtLog('注册偏好面板失败：' + cleanError(e));
	}

	// 阅读器事件
	try {
		if (Zotero.Reader && Zotero.Reader.registerEventListener) {
			Zotero.Reader.registerEventListener('renderTextSelectionPopup', onRenderTextSelectionPopup, id);
			Zotero.Reader.registerEventListener('renderToolbar', onRenderToolbar, id);
			DSWT.readerHandlers = [
				['renderTextSelectionPopup', onRenderTextSelectionPopup],
				['renderToolbar', onRenderToolbar]
			];
		}
	}
	catch (e) {
		Zotero.logError(e);
	}

	// 偏好面板里的按钮需要访问这里
	Zotero.DeepSeekWebTranslate = {
		version: version,
		testConnection: function () { return runSelfCheck(); },
		translateCurrentSelection: function () { return null; }
	};

	for (const win of Zotero.getMainWindows()) {
		try { addMenus(win); } catch (e) { Zotero.logError(e); }
	}

	dswtLog('已启动 v' + version);
}

function onMainWindowLoad({ window }) {
	try {
		addMenus(window);
	}
	catch (e) {
		Zotero.logError(e);
	}
}

function onMainWindowUnload({ window }) {
	try {
		removeMenus(window);
	}
	catch (e) {
		Zotero.logError(e);
	}
}

function shutdown({ id, version, resourceURI, rootURI }, reason) {
	if (reason === APP_SHUTDOWN) return;

	DSWT.state.cancel = true;

	for (const win of Zotero.getMainWindows()) {
		try { removeMenus(win); } catch (e) { /* ignore */ }
	}

	try {
		if (Zotero.Reader && Zotero.Reader.unregisterEventListener) {
			for (const [type, handler] of DSWT.readerHandlers) {
				Zotero.Reader.unregisterEventListener(type, handler);
			}
		}
	}
	catch (e) {
		Zotero.logError(e);
	}
	DSWT.readerHandlers = [];

	try {
		if (Zotero.DeepSeekWebTranslate) delete Zotero.DeepSeekWebTranslate;
	}
	catch (e) { /* ignore */ }

	DSWT.core = null;
}

function uninstall() {}
