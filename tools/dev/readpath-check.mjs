/*
 * 进程内端到端：复刻服务端 /api/file 的读取逻辑 + 前端渲染器，
 * 不开服务、不 spawn 子进程，直接得出"浏览器会看到什么"。
 *
 *   node tools/dev/readpath-check.mjs <文件...>
 *
 * 这段读取逻辑与 server.mjs 的 /api/file 处理器保持一致；若两边出现分歧，
 * 以 server.mjs 为准（改这里也要改那边）。
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createGrabber } from '../lib/template.mjs';

/* ---- 从 server.mjs 抠出前端渲染器（与服务端同一份代码）---- */
const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server.mjs');
const src = fs.readFileSync(serverPath, 'utf8');
const grabTemplate = createGrabber(src);
const sandbox = { window: null, console };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(grabTemplate('HIGHLIGHT_JS'), sandbox);
vm.runInContext(grabTemplate('MD_CORE_JS'), sandbox);

/* ---- 复刻 /api/file 的读取与解码 ---- */
function apiReadFile(abs) {
  const buf = fs.readFileSync(abs);
  let text = buf.toString('utf8');
  let encoding = 'utf8';
  if (text.indexOf('\uFFFD') >= 0) {
    try {
      text = new TextDecoder('gbk', { fatal: false }).decode(buf);
      encoding = 'gbk';
    } catch { /* keep utf8 */ }
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return { text, encoding, size: buf.length };
}

const files = process.argv.slice(2);
if (!files.length) { console.error('用法: node tools/readpath-check.mjs <文件...>'); process.exit(1); }

let fails = 0;
for (const f of files) {
  const abs = path.resolve(f);
  console.log('='.repeat(74));
  console.log('文件: ' + abs);
  if (!fs.existsSync(abs)) { console.log('  ✗ 不存在'); fails++; continue; }

  const raw = fs.readFileSync(abs);
  const bom = raw.length >= 3 && raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF;
  console.log('  磁盘: ' + raw.length + ' 字节  BOM=' + bom);

  const { text, encoding } = apiReadFile(abs);
  console.log('  服务端解码: encoding=' + encoding + '  字符数=' + text.length);
  console.log('  前 60 字符: ' + JSON.stringify(text.slice(0, 60)));

  if (text.length === 0) { console.log('  ✗ 读出来是空字符串'); fails++; continue; }

  const out = sandbox.mdview.parse(text, { dir: path.dirname(abs) });
  console.log('  渲染: HTML=' + out.html.length + ' 字符, 标题=' + out.headings.length +
    ', 段落/块=' + (out.html.match(/<(h[1-6]|p|ul|ol|pre|blockquote|table|hr|div)\b/g) || []).length);
  console.log('  渲染前 120 字符: ' + JSON.stringify(out.html.slice(0, 120).replace(/\n/g, ' ')));
  if (out.html.length === 0) { console.log('  ✗ 渲染为空'); fails++; continue; }
  console.log('  ✓ 链路正常');
}

console.log('\n' + (fails ? fails + ' 个文件有问题' : '全部正常'));
process.exitCode = fails ? 1 : 0;
