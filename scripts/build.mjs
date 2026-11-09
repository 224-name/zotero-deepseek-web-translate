/**
 * 打包插件目录为 Zotero 可安装的 .xpi（本质是 zip）
 *
 *   node scripts/build.mjs
 *
 * 输出：dist/deepseek-web-translate-<version>.xpi
 * 注意：不使用任何第三方依赖，自带最小 ZIP 写入器，条目名统一用 /。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const pluginDir = path.join(root, 'plugin');
const distDir = path.join(root, 'dist');

// ---------------- CRC32 ----------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------- 最小 ZIP ----------------
function makeZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const data = file.data;
    const crc = crc32(data);

    let body = data;
    let method = 0;
    if (data.length > 200) {
      const deflated = zlib.deflateRawSync(data, { level: 9 });
      if (deflated.length < data.length) {
        body = deflated;
        method = 8;
      }
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);      // version needed
    local.writeUInt16LE(0x0800, 6);  // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);      // time
    local.writeUInt16LE(0x21, 12);   // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);         // version made by
    cd.writeUInt16LE(20, 6);         // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);         // extra len
    cd.writeUInt16LE(0, 32);         // comment len
    cd.writeUInt16LE(0, 34);         // disk start
    cd.writeUInt16LE(0, 36);         // internal attrs
    cd.writeUInt32LE(0, 38);         // external attrs
    cd.writeUInt32LE(offset, 42);    // local header offset
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, centralBuf, eocd]);
}

// ---------------- 收集文件 ----------------
function walk(dir, base) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = base ? base + '/' + entry.name : entry.name;
    if (entry.isDirectory()) out.push(...walk(full, rel));
    else if (entry.isFile()) out.push({ name: rel, full });
  }
  return out;
}

const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));

// ---- 校验 Zotero 的 manifest 必填字段 ----
// 依据 Zotero 自带 Gecko 的 Extension.sys.mjs：
//   id / update_url / strict_max_version 三者缺一，安装时会报“可能无法与该版本的 Zotero 兼容”。
const REQUIRED = [
  ['manifest_version', manifest.manifest_version],
  ['name', manifest.name],
  ['version', manifest.version],
  ['applications.zotero.id', manifest.applications?.zotero?.id],
  ['applications.zotero.update_url', manifest.applications?.zotero?.update_url],
  ['applications.zotero.strict_max_version', manifest.applications?.zotero?.strict_max_version]
];
const missing = REQUIRED.filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error('\n[打包中止] manifest.json 缺少 Zotero 必填字段：');
  for (const k of missing) console.error('  - ' + k);
  console.error('');
  process.exit(1);
}
if (manifest.manifest_version !== 2) {
  console.error(`\n[打包中止] Zotero 插件要求 manifest_version 为 2，当前为 ${manifest.manifest_version}\n`);
  process.exit(1);
}
if (!fs.existsSync(path.join(pluginDir, 'bootstrap.js'))) {
  console.error('\n[打包中止] 插件根目录缺少 bootstrap.js\n');
  process.exit(1);
}

const files = walk(pluginDir, '').map((f) => ({ name: f.name, data: fs.readFileSync(f.full) }));

// 图标等静态资源必须真的存在，否则安装后显示异常
for (const rel of Object.values(manifest.icons || {})) {
  if (!files.some((f) => f.name === rel)) {
    console.error(`\n[打包中止] manifest.json 引用的图标不存在：${rel}\n`);
    process.exit(1);
  }
}

// manifest.json 放到最前面（惯例）
files.sort((a, b) => (a.name === 'manifest.json' ? -1 : b.name === 'manifest.json' ? 1 : a.name.localeCompare(b.name)));

fs.mkdirSync(distDir, { recursive: true });
const outName = `deepseek-web-translate-${manifest.version}.xpi`;
const outPath = path.join(distDir, outName);
fs.writeFileSync(outPath, makeZip(files));

console.log('已打包 ' + files.length + ' 个文件 → ' + path.relative(root, outPath));
console.log('大小 ' + (fs.statSync(outPath).size / 1024).toFixed(1) + ' KB');
for (const f of files) console.log('  + ' + f.name + '  (' + f.data.length + ' B)');
