/**
 * DeepSeek 网页翻译 for Zotero — 纯逻辑核心
 *
 * 这个文件刻意不依赖任何 Zotero API，因此可以：
 *   1. 在插件沙箱里通过 Services.scriptloader.loadSubScript 加载；
 *   2. 在 Node 里直接 eval 做单元测试（scripts/test-core.mjs）。
 *
 * 暴露的全局变量：DSWTCore
 */
var DSWTCore = (function () {
  'use strict';

  var VERSION = '0.1.0';

  // ============================================================
  // 一、文本规整与分块
  // ============================================================

  // 只有整行就是一个章节名时才算标题，避免 "Abstract: this paper ..." 被误判
  var HEADING_WORDS = /^(abstract|keywords?|introduction|related work|background|methods?|materials? and methods?|experiments?|results?|discussion|conclusions?|references?|acknowledge?ments?|appendix|supplementary)\s*[:\uff1a]?$/i;
  var HEADING_CN = /^(\u6458\u8981|\u5173\u952e\u8bcd|\u5173\u952e\u5b57|\u5f15\u8a00|\u7eea\u8bba|\u524d\u8a00|\u76f8\u5173\u5de5\u4f5c|\u7814\u7a76\u65b9\u6cd5|\u6750\u6599\u4e0e\u65b9\u6cd5|\u5b9e\u9a8c|\u7ed3\u679c|\u8ba8\u8bba|\u7ed3\u8bba|\u53c2\u8003\u6587\u732e|\u81f4\u8c22|\u9644\u5f55)\s*[:\uff1a]?$/;

  /**
   * 判断一行是否像标题（标题不应被并入相邻段落）
   */
  function looksLikeHeading(line) {
    if (line.length > 60) return false;
    // "第一章 绪论" / "3.2 Method" / "IV. RESULTS"
    if (/^第\s*[一二三四五六七八九十百零\d]+\s*[章节部分篇条]/.test(line)) return true;
    if (/^(\d+(\.\d+)*)[.、]?\s+\S/.test(line)) return true;
    if (/^[IVX]{1,6}[.、]\s+\S/.test(line)) return true;
    // 常见章节名（中英文）
    if (HEADING_WORDS.test(line) || HEADING_CN.test(line)) return true;
    // 全大写短行，如 "REFERENCES"
    if (line.length <= 40 && /^[A-Z][A-Z0-9\s\-–—:,.&()]{2,}$/.test(line)) return true;
    return false;
  }

  /**
   * 规整 PDF 文本层提取出来的脏文本：
   *  - 统一换行、压缩空白、剔除控制字符
   *  - 丢掉纯页码行（"12" / "- 12 -" / "第 3 页" / "Page 3 of 12"）
   *  - 修复英文行尾连字符断词
   *  - 把被硬换行打断的句子重新接回段
   *
   * @param {string} raw
   * @returns {string} 段落之间用单个 \n 分隔
   */
  function normalizeText(raw) {
    if (raw === null || raw === undefined) return '';
    var text = String(raw)
      .replace(/\r\n?/g, '\n')
      .replace(/\u00ad/g, '') // soft hyphen
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/\u00a0/g, ' ');

    var lines = text.split('\n').map(function (line) {
      return line.replace(/[ \t]+/g, ' ').trim();
    });

    var out = [];
    var buf = '';

    function flush() {
      if (buf) {
        out.push(buf);
        buf = '';
      }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line) {
        flush();
        continue;
      }

      // 纯页码 / 页眉页脚
      if (/^[-\u2013\u2014\u00b7\u2022\s]*\d{1,4}[-\u2013\u2014\u00b7\u2022\s]*$/.test(line)) continue;
      if (/^\u7b2c\s*\d+\s*\u9875(\s*[\/\u5171]\s*\u5171?\s*\d+\s*\u9875)?$/.test(line)) continue;
      if (/^page\s*\d+(\s*(of|\/)\s*\d+)?$/i.test(line)) continue;

      // 标题行：独立成段，不与上下文合并
      if (looksLikeHeading(line)) {
        flush();
        out.push(line);
        continue;
      }

      if (!buf) {
        buf = line;
        continue;
      }

      if (/[A-Za-z]-$/.test(buf)) {
        // 英文行尾断词：inter-\nnational -> international
        buf = buf.slice(0, -1) + line;
      } else if (/[\u4e00-\u9fff]$/.test(buf) || /^[\u4e00-\u9fff]/.test(line)) {
        // 中文换行不产生空格
        buf += line;
      } else {
        buf += ' ' + line;
      }

      // 一句结束且已经攒够长度，就断成一段，避免整页糊成一段
      if (buf.length >= 160 && /[\u3002\uff01\uff1f.!?\uff1b;]["'\u201d\u2019\u300d\u300f\uff09)]?$/.test(buf)) {
        flush();
      } else if (buf.length >= 900) {
        flush();
      }
    }
    flush();

    return out.join('\n');
  }

  /**
   * 按换行切成段落数组（段落内部的换行已由 normalizeText 合并）
   */
  function splitParagraphs(text) {
    if (!text) return [];
    return String(text)
      .split(/\n+/)
      .map(function (s) { return s.replace(/[ \t]+/g, ' ').trim(); })
      .filter(function (s) { return s.length > 0; });
  }

  /**
   * 超长段落按句子边界切成若干块；单句仍超长则硬切
   */
  function splitLongParagraph(paragraph, size) {
    var p = String(paragraph);
    if (p.length <= size) return [p];

    var sentences = p.match(/[^\u3002\uff01\uff1f!?\uff1b;]+[\u3002\uff01\uff1f!?\uff1b;]?/g) || [p];
    var pieces = [];
    var cur = '';

    for (var i = 0; i < sentences.length; i++) {
      var s = sentences[i];
      if (!s) continue;
      if (s.length > size) {
        if (cur) {
          pieces.push(cur);
          cur = '';
        }
        for (var j = 0; j < s.length; j += size) {
          pieces.push(s.slice(j, j + size));
        }
        continue;
      }
      if (!cur) {
        cur = s;
      } else if (cur.length + s.length <= size) {
        cur += s;
      } else {
        pieces.push(cur);
        cur = s;
      }
    }
    if (cur) pieces.push(cur);
    return pieces;
  }

  /**
   * 把段落合并成大小接近 chunkSize 的翻译单元
   *
   * @param {string[]} paragraphs
   * @param {{chunkSize?: number, maxChunks?: number}} [options]
   * @returns {{chunks: string[], truncated: boolean, totalChars: number, chunkSize: number}}
   */
  function buildChunks(paragraphs, options) {
    options = options || {};
    var size = Math.max(200, parseInt(options.chunkSize, 10) || 1200);
    var maxChunks = Math.max(1, parseInt(options.maxChunks, 10) || 500);

    var chunks = [];
    var cur = '';
    var totalChars = 0;

    for (var i = 0; i < paragraphs.length; i++) {
      var pieces = splitLongParagraph(String(paragraphs[i]).trim(), size);
      for (var k = 0; k < pieces.length; k++) {
        var piece = pieces[k];
        if (!piece) continue;
        totalChars += piece.length;

        if (!cur) {
          cur = piece;
        } else if (cur.length + 1 + piece.length <= size) {
          cur += '\n' + piece;
        } else {
          chunks.push(cur);
          cur = piece;
        }
      }
    }
    if (cur) chunks.push(cur);

    var truncated = false;
    if (chunks.length > maxChunks) {
      chunks = chunks.slice(0, maxChunks);
      truncated = true;
    }

    return {
      chunks: chunks,
      truncated: truncated,
      totalChars: totalChars,
      chunkSize: size
    };
  }

  // ============================================================
  // 二、Prompt 构造
  // ============================================================

  var STYLE_LINES = {
    academic: '译文应为规范的学术书面语：术语准确、句式严谨、逻辑清晰。',
    fluent: '译文应通顺自然、符合目标语言的表达习惯，可以适当调整语序。',
    literal: '译文以直译为主，尽量贴近原文的语序与句式，便于逐句对照。'
  };

  function buildSystemPrompt() {
    return '你是一名严谨的学术文献翻译引擎。你只输出译文本身，绝不输出解释、说明或原文。';
  }

  /**
   * @param {string} text
   * @param {{targetLang?: string, style?: string, forSelection?: boolean}} [options]
   */
  function buildPrompt(text, options) {
    options = options || {};
    var targetLang = options.targetLang || '\u7b80\u4f53\u4e2d\u6587';
    var style = STYLE_LINES[options.style] || STYLE_LINES.academic;

    var lines = [
      '你是一名专业的学术文献翻译引擎。请直接把下面 <<< 与 >>> 之间的文本翻译成' + targetLang + '。',
      '',
      '要求：',
      '1. 只输出译文本身。不要输出任何解释、说明、前言、后记、小标题，也不要重复原文。',
      '2. ' + style,
      '3. 专业术语使用学界通用译法；首次出现的关键术语可用括号保留英文原词。',
      '4. 公式、变量名、数字、单位、文献引用编号（如 [1]、[12-14]）一律保持原样。',
      '5. 保留原文的段落划分、编号与列表结构。',
      '6. 如果原文是标题或章节名，译文保持简洁，不要加句号。',
      '7. PDF 文本层可能有乱码、断行或多余空格，请按语义整理，不要臆造不存在的内容。'
    ];
    if (options.forSelection) {
      lines.push('8. 这是从文献中选中的片段，可能从句子中间开始或结束，只翻译给出的内容即可。');
    }
    lines.push('');
    lines.push('<<<');
    lines.push(String(text === null || text === undefined ? '' : text));
    lines.push('>>>');
    return lines.join('\n');
  }

  // ============================================================
  // 二·五、词典模式（单个英文单词 → 多义项 + 词性）
  // ============================================================

  /**
   * 单词释义的 prompt：要求模型按「词性|释义」每行一条输出。
   * 刻意不用 JSON——网页版偶尔会多吐一句解释或包个代码块，逐行解析更耐操。
   *
   * @param {string} word
   * @param {{targetLang?: string}} [options]
   */
  function buildDictPrompt(word, options) {
    options = options || {};
    var targetLang = options.targetLang || '\u7b80\u4f53\u4e2d\u6587';
    return [
      '\u4f60\u662f\u4e00\u540d\u8bcd\u5178\u7f16\u7e82\u8005\u3002\u8bf7\u7ed9\u51fa\u82f1\u8bed\u5355\u8bcd\u300c' + word + '\u300d\u7684\u91ca\u4e49\u3002',
      '',
      '\u8f93\u51fa\u683c\u5f0f\uff08\u4e25\u683c\u9075\u5b88\uff0c\u53ea\u8f93\u51fa\u8fd9\u4e9b\u884c\uff0c\u4e0d\u8981\u4efb\u4f55\u5176\u5b83\u6587\u5b57\uff09\uff1a',
      '\u6bcf\u884c\u4e00\u4e2a\u4e49\u9879\uff0c\u683c\u5f0f\u4e3a\uff1a\u8bcd\u6027|\u91ca\u4e49',
      '\u8981\u6c42\uff1a',
      '1. \u6700\u591a 4 \u884c\uff0c\u6309\u5e38\u7528\u7a0b\u5ea6\u4ece\u9ad8\u5230\u4f4e\u6392\u5e8f\u3002',
      '2. \u8bcd\u6027\u7528 n. / v. / adj. / adv. / prep. / conj. / pron. \u7b49\u7f29\u5199\u3002',
      '3. \u91ca\u4e49\u7528' + targetLang + '\uff0c\u591a\u4e2a\u8fd1\u4e49\u91ca\u4e49\u7528\u300c\uff1b\u300d\u5206\u9694\uff0c\u5355\u884c\u4e0d\u8d85\u8fc7 25 \u4e2a\u5b57\u3002',
      '4. \u4f18\u5148\u7ed9\u51fa\u8fd9\u4e2a\u8bcd\u5728\u5b66\u672f\u6587\u732e\u4e2d\u7684\u542b\u4e49\u3002',
      '5. \u4e0d\u8981\u97f3\u6807\u3001\u4f8b\u53e5\u3001\u7f16\u53f7\u3001\u52a0\u7c97\u6216 markdown \u7b26\u53f7\u3002',
      '',
      '\u793a\u4f8b\uff1a',
      'n.|\u90e8\u5206\uff1b\u6bb5\uff1b\u90e8\u95e8\uff1b\u533a\u57df',
      'v.|\u628a\u2026\u5207\u6210\u7247\uff1b\u4f5c\u622a\u9762\u56fe'
    ].join('\n');
  }

  /**
   * 解析词典输出。容忍 markdown 列表符号、编号、以及「n. 释义」这种缺竖线的写法。
   *
   * @param {string} raw
   * @returns {{senses: Array<{pos: string, meaning: string}>, raw: string}}
   */
  function parseDictResult(raw) {
    var text = String(raw === null || raw === undefined ? '' : raw)
      .replace(/\r\n?/g, '\n')
      .replace(/```[a-zA-Z]*/g, '')
      .replace(/\*\*/g, '')
      .trim();

    var lines = text.split('\n').map(function (line) {
      return line.trim();
    }).filter(Boolean);

    function stripBullet(line) {
      return line
        .replace(/^[-*\u2022\u00b7\u25cf\u25aa\s]+/, '')
        .replace(/^\d+[.\u3001)\uff09]\s*/, '')
        .replace(/^\(\d+\)\s*/, '')
        .trim();
    }

    var senses = [];
    for (var i = 0; i < lines.length; i++) {
      var line = stripBullet(lines[i]);
      if (!line) continue;
      var match = line.match(/^([a-zA-Z]{1,5}\.)\s*[|\uff5c:\uff1a]\s*(.+)$/);
      if (!match) match = line.match(/^([a-zA-Z]{1,5}\.)\s+(.+)$/);
      if (!match) continue;
      var meaning = match[2].replace(/^[|\uff5c:\uff1a\s]+/, '').trim();
      if (!meaning) continue;
      senses.push({ pos: match[1], meaning: meaning });
      if (senses.length >= 6) break;
    }

    return { senses: senses, raw: text };
  }

  // ============================================================
  // 三、输出：HTML / Markdown
  // ============================================================

  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function buildHtml(doc) {
    doc = doc || {};
    var pairs = doc.pairs || [];
    var title = doc.title || '\u672a\u547d\u540d\u6587\u732e';
    var meta = doc.meta || '';
    var generatedAt = doc.generatedAt || '';
    var providerLabel = doc.providerLabel || '';
    var truncated = !!doc.truncated;

    var css = [
      ':root{color-scheme:light}',
      '*{box-sizing:border-box}',
      'body{margin:0;padding:32px 20px 80px;background:#f5f5f2;color:#1b1b1b;',
      'font:16px/1.8 "Noto Serif SC","Songti SC","Source Han Serif SC",SimSun,Georgia,serif}',
      '.page{max-width:820px;margin:0 auto;background:#fff;padding:48px 56px 64px;border-radius:4px;',
      'box-shadow:0 1px 4px rgba(0,0,0,.08)}',
      'h1{font-size:25px;line-height:1.4;margin:0 0 12px;font-weight:700}',
      '.meta{color:#5f5f5f;font-size:13px;line-height:1.9;margin-bottom:4px}',
      '.hint{color:#8a8a8a;font-size:12px;line-height:1.9;margin:16px 0 30px;padding-bottom:16px;',
      'border-bottom:1px solid #e6e6e6}',
      '.pair{margin:0 0 26px}',
      '.src{color:#6d6d6d;font-size:14px;line-height:1.7;padding-left:12px;border-left:3px solid #d9d9d9;',
      'margin-bottom:8px;white-space:pre-wrap;word-break:break-word}',
      '.dst{white-space:pre-wrap;word-break:break-word}',
      '.err{color:#b42318;background:#fff5f3;border:1px solid #ffd8d0;border-radius:4px;padding:6px 10px;font-size:13px}',
      '@media print{body{background:#fff;padding:0;font-size:11.5pt}',
      '.page{box-shadow:none;border-radius:0;max-width:none;padding:0}',
      '.pair{page-break-inside:avoid}}',
      '@media (max-width:600px){.page{padding:24px 18px}h1{font-size:21px}}'
    ].join('');

    var body = [];
    body.push('<div class="page">');
    body.push('<h1>' + escapeHtml(title) + '</h1>');
    if (meta) body.push('<div class="meta">' + escapeHtml(meta) + '</div>');

    var info = [];
    if (providerLabel) info.push('\u7ffb\u8bd1\u5f15\u64ce\uff1a' + providerLabel);
    if (generatedAt) info.push('\u751f\u6210\u65f6\u95f4\uff1a' + generatedAt);
    if (truncated) info.push('\u6ce8\u610f\uff1a\u539f\u6587\u8fc7\u957f\uff0c\u4ec5\u7ffb\u8bd1\u4e86\u524d\u9762\u90e8\u5206');
    body.push('<div class="hint">' + escapeHtml(info.join('\u3000|\u3000')) +
      '<br>\u7070\u8272\u5c0f\u5b57\u4e3a\u539f\u6587\uff0c\u9ed1\u5b57\u4e3a\u8bd1\u6587\u3002\u6d4f\u89c8\u5668\u4e2d\u6309 Ctrl+P \u53ef\u5b58\u4e3a PDF\u3002</div>');

    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i] || {};
      body.push('<div class="pair">');
      body.push('<div class="src">' + escapeHtml(p.source || '') + '</div>');
      if (p.error) {
        body.push('<div class="err">\u672c\u6bb5\u7ffb\u8bd1\u5931\u8d25\uff1a' + escapeHtml(p.error) + '</div>');
      } else {
        body.push('<div class="dst">' + escapeHtml(p.translation || '') + '</div>');
      }
      body.push('</div>');
    }
    body.push('</div>');

    return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<title>' + escapeHtml(title) + ' \u2014 \u53cc\u8bed\u5bf9\u7167</title>\n' +
      '<style>' + css + '</style>\n</head>\n<body>\n' + body.join('\n') + '\n</body>\n</html>\n';
  }

  function buildMarkdown(doc) {
    doc = doc || {};
    var pairs = doc.pairs || [];
    var out = [];
    out.push('# ' + (doc.title || '\u672a\u547d\u540d\u6587\u732e'));
    if (doc.meta) out.push('> ' + String(doc.meta).replace(/\n/g, ' '));
    var info = [];
    if (doc.providerLabel) info.push('\u7ffb\u8bd1\u5f15\u64ce\uff1a' + doc.providerLabel);
    if (doc.generatedAt) info.push('\u751f\u6210\u65f6\u95f4\uff1a' + doc.generatedAt);
    if (doc.truncated) info.push('\u539f\u6587\u8fc7\u957f\uff0c\u5df2\u622a\u65ad');
    if (info.length) out.push('> ' + info.join('\u3000|\u3000'));
    out.push('');
    out.push('---');
    out.push('');
    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i] || {};
      out.push('**\u539f\u6587**');
      out.push('');
      out.push(String(p.source || '').trim());
      out.push('');
      if (p.error) {
        out.push('**[TL;DR] \u672c\u6bb5\u7ffb\u8bd1\u5931\u8d25**\uff1a' + p.error);
      } else {
        out.push('**\u8bd1\u6587**');
        out.push('');
        out.push(String(p.translation || '').trim());
      }
      out.push('');
      out.push('---');
      out.push('');
    }
    return out.join('\n');
  }

  // ============================================================
  // 四、输出：DOCX（自带最小 OOXML + 无依赖 ZIP 写入器）
  // ============================================================

  function escapeXml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var CRC_TABLE = null;
  function crc32(bytes) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) {
          c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        CRC_TABLE[n] = c >>> 0;
      }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /**
   * 生成一个只使用 store（不压缩）方式的最小 ZIP。
   * Word / WPS / LibreOffice 都能正常打开 store 方式的 docx。
   *
   * @param {{name: string, data: Uint8Array}[]} entries
   * @returns {Uint8Array}
   */
  function zipStore(entries) {
    var enc = new TextEncoder();
    var localParts = [];
    var centralParts = [];
    var offset = 0;

    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var nameBytes = enc.encode(entry.name);
      var data = entry.data;
      var crc = crc32(data);

      var local = new Uint8Array(30 + nameBytes.length);
      var lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true); // signature
      lv.setUint16(4, 20, true);         // version needed
      lv.setUint16(6, 0x0800, true);     // flag: UTF-8 names
      lv.setUint16(8, 0, true);          // method: store
      lv.setUint16(10, 0, true);         // mod time
      lv.setUint16(12, 0x21, true);      // mod date (1980-01-01)
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);

      localParts.push(local);
      localParts.push(data);

      var central = new Uint8Array(46 + nameBytes.length);
      var cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true); // signature
      cv.setUint16(4, 20, true);         // version made by
      cv.setUint16(6, 20, true);         // version needed
      cv.setUint16(8, 0x0800, true);     // flags
      cv.setUint16(10, 0, true);         // method
      cv.setUint16(12, 0, true);         // time
      cv.setUint16(14, 0x21, true);      // date
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);         // extra len
      cv.setUint16(32, 0, true);         // comment len
      cv.setUint16(34, 0, true);         // disk
      cv.setUint16(36, 0, true);         // internal attrs
      cv.setUint32(38, 0, true);         // external attrs
      cv.setUint32(42, offset, true);    // local header offset
      central.set(nameBytes, 46);

      centralParts.push(central);

      offset += local.length + data.length;
    }

    var centralSize = 0;
    for (var c = 0; c < centralParts.length; c++) centralSize += centralParts[c].length;

    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    var total = offset + centralSize + eocd.length;
    var result = new Uint8Array(total);
    var pos = 0;
    var all = localParts.concat(centralParts, [eocd]);
    for (var a = 0; a < all.length; a++) {
      result.set(all[a], pos);
      pos += all[a].length;
    }
    return result;
  }

  function docxRun(text) {
    var t = escapeXml(text).replace(/\n/g, '</w:t><w:br/><w:t xml:space="preserve">');
    return '<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="\u5b8b\u4f53"/>' +
      '</w:rPr><w:t xml:space="preserve">' + t + '</w:t></w:r>';
  }

  function docxParagraph(text, styleId) {
    var t = String(text === null || text === undefined ? '' : text);
    if (!t) return '<w:p><w:pPr><w:pStyle w:val="' + styleId + '"/></w:pPr></w:p>';
    return '<w:p><w:pPr><w:pStyle w:val="' + styleId + '"/></w:pPr>' + docxRun(t) + '</w:p>';
  }

  function docxStyles() {
    function style(id, name, opts) {
      opts = opts || {};
      var pPr = '<w:pPr>' +
        (opts.jc ? '<w:jc w:val="' + opts.jc + '"/>' : '') +
        (opts.borderBottom ? '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D9D9D9"/></w:pBdr>' : '') +
        '<w:spacing w:before="' + (opts.before || 0) + '" w:after="' + (opts.after || 0) + '"' +
        (opts.line ? ' w:line="' + opts.line + '" w:lineRule="auto"' : '') + '/>' +
        '</w:pPr>';
      var rPr = '<w:rPr>' +
        (opts.bold ? '<w:b/>' : '') +
        (opts.color ? '<w:color w:val="' + opts.color + '"/>' : '') +
        (opts.size ? '<w:sz w:val="' + opts.size + '"/><w:szCs w:val="' + opts.size + '"/>' : '') +
        '</w:rPr>';
      return '<w:style w:type="paragraph" w:styleId="' + id + '">' +
        '<w:name w:val="' + name + '"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
        pPr + rPr + '</w:style>';
    }

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:docDefaults>' +
      '<w:rPrDefault><w:rPr>' +
      '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="\u5b8b\u4f53" w:cs="Times New Roman"/>' +
      '<w:sz w:val="22"/><w:szCs w:val="22"/>' +
      '<w:lang w:val="en-US" w:eastAsia="zh-CN"/>' +
      '</w:rPr></w:rPrDefault>' +
      '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="330" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
      '</w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
      '<w:name w:val="Normal"/><w:qFormat/></w:style>' +
      style('DSWTTitle', 'DSWT Title', { jc: 'center', after: 240, bold: true, size: 36, line: 300 }) +
      style('DSWTSub', 'DSWT Subtitle', { jc: 'center', after: 180, color: '666666', size: 18 }) +
      style('DSWTRule', 'DSWT Rule', { after: 240, borderBottom: true, size: 18 }) +
      style('DSWTSource', 'DSWT Source', { after: 60, color: '606060', size: 19, line: 300 }) +
      style('DSWTTrans', 'DSWT Translation', { after: 300, size: 22, line: 340 }) +
      style('DSWTError', 'DSWT Error', { after: 300, color: 'B42318', size: 19 }) +
      '</w:styles>';
  }

  function w3cNow(iso) {
    var d = iso ? new Date(iso) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    return d.toISOString().replace(/\.\d+Z$/, 'Z');
  }

  /**
   * 生成双语文档（.docx）
   *
   * @param {{title?: string, meta?: string, pairs?: Array, generatedAt?: string,
   *          providerLabel?: string, truncated?: boolean, isoTime?: string}} doc
   * @returns {Uint8Array}
   */
  function buildDocx(doc) {
    doc = doc || {};
    var pairs = doc.pairs || [];
    var title = doc.title || '\u672a\u547d\u540d\u6587\u732e';
    var meta = doc.meta || '';
    var body = [];

    body.push(docxParagraph(title, 'DSWTTitle'));
    if (meta) body.push(docxParagraph(meta, 'DSWTSub'));

    var info = ['\u7070\u8272\u5c0f\u5b57\u4e3a\u539f\u6587\uff0c\u9ed1\u5b57\u4e3a\u8bd1\u6587'];
    if (doc.providerLabel) info.push('\u7ffb\u8bd1\u5f15\u64ce\uff1a' + doc.providerLabel);
    if (doc.generatedAt) info.push('\u751f\u6210\u65f6\u95f4\uff1a' + doc.generatedAt);
    if (doc.truncated) info.push('\u539f\u6587\u8fc7\u957f\uff0c\u4ec5\u7ffb\u8bd1\u4e86\u524d\u9762\u90e8\u5206');
    body.push(docxParagraph(info.join('\u3000|\u3000'), 'DSWTSub'));
    body.push('<w:p><w:pPr><w:pStyle w:val="DSWTRule"/></w:pPr></w:p>');

    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i] || {};
      body.push(docxParagraph(p.source || '', 'DSWTSource'));
      if (p.error) {
        body.push(docxParagraph('\uff3b\u672c\u6bb5\u7ffb\u8bd1\u5931\u8d25\uff1a' + p.error + '\uff3d', 'DSWTError'));
      } else {
        body.push(docxParagraph(p.translation || '', 'DSWTTrans'));
      }
    }
    if (!pairs.length) {
      body.push(docxParagraph('\uff08\u6ca1\u6709\u53ef\u7ffb\u8bd1\u7684\u5185\u5bb9\uff09', 'DSWTTrans'));
    }

    var documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<w:body>' + body.join('') +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
      '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" ' +
      'w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>' +
      '</w:body></w:document>';

    var contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '</Types>';

    var rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '</Relationships>';

    var docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>';

    var coreXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
      '<cp:coreProperties ' +
      'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
      'xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:dcmitype="http://purl.org/dc/dcmitype/" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      '<dc:title>' + escapeXml(title) + '</dc:title>' +
      '<dc:creator>DeepSeek \u7f51\u9875\u7ffb\u8bd1 (Zotero)</dc:creator>' +
      '<cp:lastModifiedBy>DeepSeek \u7f51\u9875\u7ffb\u8bd1 (Zotero)</cp:lastModifiedBy>' +
      '<dcterms:created xsi:type="dcterms:W3CDTF">' + w3cNow(doc.isoTime) + '</dcterms:created>' +
      '<dcterms:modified xsi:type="dcterms:W3CDTF">' + w3cNow(doc.isoTime) + '</dcterms:modified>' +
      '</cp:coreProperties>';

    var enc = new TextEncoder();
    return zipStore([
      { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
      { name: '_rels/.rels', data: enc.encode(rootRels) },
      { name: 'docProps/core.xml', data: enc.encode(coreXml) },
      { name: 'word/document.xml', data: enc.encode(documentXml) },
      { name: 'word/styles.xml', data: enc.encode(docxStyles()) },
      { name: 'word/_rels/document.xml.rels', data: enc.encode(docRels) }
    ]);
  }

  // ============================================================
  // 五、导出
  // ============================================================

  return {
    VERSION: VERSION,
    normalizeText: normalizeText,
    splitParagraphs: splitParagraphs,
    splitLongParagraph: splitLongParagraph,
    buildChunks: buildChunks,
    buildPrompt: buildPrompt,
    buildDictPrompt: buildDictPrompt,
    parseDictResult: parseDictResult,
    buildSystemPrompt: buildSystemPrompt,
    buildHtml: buildHtml,
    buildMarkdown: buildMarkdown,
    buildDocx: buildDocx,
    zipStore: zipStore,
    escapeHtml: escapeHtml,
    escapeXml: escapeXml
  };
})();
