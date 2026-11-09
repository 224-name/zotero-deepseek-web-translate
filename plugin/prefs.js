// DeepSeek 网页翻译 — 默认偏好
// Zotero 7+ 会自动读取插件根目录下的 prefs.js 作为默认值。
// 注意：数值类偏好也用字符串保存，避免 pref 类型不一致导致的写入失败。

pref("extensions.zotero.deepseekweb.provider", "web");
pref("extensions.zotero.deepseekweb.bridgeUrl", "http://127.0.0.1:8765");
pref("extensions.zotero.deepseekweb.apiBase", "https://api.deepseek.com/v1");
pref("extensions.zotero.deepseekweb.apiKey", "");
pref("extensions.zotero.deepseekweb.apiModel", "deepseek-chat");
pref("extensions.zotero.deepseekweb.targetLang", "简体中文");
pref("extensions.zotero.deepseekweb.promptStyle", "academic");
pref("extensions.zotero.deepseekweb.chunkSize", "1200");
pref("extensions.zotero.deepseekweb.timeoutSec", "180");
pref("extensions.zotero.deepseekweb.maxChunks", "150");
pref("extensions.zotero.deepseekweb.outputFormat", "docx");
pref("extensions.zotero.deepseekweb.selectionLabel", "译");
pref("extensions.zotero.deepseekweb.selectionAuto", true);
pref("extensions.zotero.deepseekweb.selectionAutoCopy", false);
