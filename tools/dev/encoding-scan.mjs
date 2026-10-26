/*
 * 编码体检：扫描指定目录下的 .md，判断每个文件到底是 UTF-8 还是 GBK/其它。
 *
 *   node tools/dev/encoding-scan.mjs <目录> [最多显示条数]
 *
 * 判断方式：
 *   - UTF-8 合法序列 -> utf-8
 *   - 否则尝试用 gbk 解出中文 -> gbk（这类文件在只按 UTF-8 读的查看器里必然乱码）
 *   - 都不是 -> unknown
 * 同时报告 BOM、是否含替换字符 U+FFFD、以及首个非 ASCII 字符的位置。
 */

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const limit = Number(process.argv[3] || 40);

const SKIP = new Set(['node_modules', '.git', '.svn', 'dist', 'build', '__pycache__', '.venv', 'venv']);

function walk(dir, out, depth = 0) {
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    if (it.name.startsWith('.')) continue;
    const full = path.join(dir, it.name);
    if (it.isDirectory()) {
      if (SKIP.has(it.name) || depth > 6) continue;
      walk(full, out, depth + 1);
    } else if (it.isFile() && /\.(md|markdown|mdown|mkd|mdx|text)$/i.test(it.name)) {
      out.push(full);
    }
  }
  return out;
}

function classify(buf) {
  const hasBom = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
  const body = hasBom ? buf.subarray(3) : buf;

  // 严格 UTF-8 校验
  let utf8Valid = true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    utf8Valid = false;
  }

  let encoding = utf8Valid ? 'utf-8' : 'other';
  let sample = '';
  if (utf8Valid) {
    sample = body.toString('utf8').slice(0, 80);
    const bad = (sample.match(/\uFFFD/g) || []).length;
    if (bad > 0) encoding = 'utf-8(有替换字符)';
  } else {
    // 试试 GBK 能不能解出合理中文
    try {
      const gbk = new TextDecoder('gbk', { fatal: false }).decode(body);
      const cjk = (gbk.match(/[\u4e00-\u9fa5]/g) || []).length;
      const replacement = (gbk.match(/\uFFFD/g) || []).length;
      if (cjk > 0 && replacement === 0) {
        encoding = 'gbk';
        sample = gbk.slice(0, 80);
      } else {
        sample = gbk.slice(0, 80);
      }
    } catch {
      sample = body.toString('latin1').slice(0, 80);
    }
  }

  // 首个非 ASCII 字节的位置（用于判断是不是"前面全是英文，后面突然中文"）
  let firstNonAscii = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i] > 0x7F) { firstNonAscii = i; break; }
  }

  return { hasBom, encoding, sample, firstNonAscii };
}

const files = walk(root, []);
console.log('扫描目录: ' + root);
console.log('找到 ' + files.length + ' 个 Markdown 文件\n');

const rows = [];
for (const f of files) {
  const buf = fs.readFileSync(f);
  const info = classify(buf);
  rows.push({ f, size: buf.length, ...info });
}

const tally = {};
for (const r of rows) tally[r.encoding] = (tally[r.encoding] || 0) + 1;
console.log('编码分布:');
for (const [k, v] of Object.entries(tally)) console.log('  ' + k.padEnd(20) + v + ' 个');
console.log('');

// 先列出"非 utf-8"的，它们才是问题的根源
const suspicious = rows.filter((r) => !r.encoding.startsWith('utf-8'));
if (suspicious.length) {
  console.log('=== 非 UTF-8 文件（在只按 UTF-8 读的查看器里会乱码）===');
  for (const r of suspicious.slice(0, limit)) {
    console.log('  ' + path.relative(root, r.f));
    console.log('      编码=' + r.encoding + '  ' + r.size + 'B  BOM=' + r.hasBom + '  首个非ASCII字节位置=' + r.firstNonAscii);
    console.log('      内容样本: ' + JSON.stringify(r.sample.slice(0, 60)));
  }
  console.log('');
}

console.log('=== 前 ' + limit + ' 个文件明细 ===');
for (const r of rows.slice(0, limit)) {
  console.log(
    '  ' + r.encoding.padEnd(18) +
    String(r.size).padStart(7) + 'B  BOM=' + (r.hasBom ? 'Y' : 'N') +
    '  非ASCII@' + String(r.firstNonAscii).padStart(6) +
    '  ' + path.relative(root, r.f)
  );
}
