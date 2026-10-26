/*
 * 验证"带 BOM 的文件能正常打开"—— 走运行中的服务，用前端真实渲染器。
 *
 *   node server.mjs serve --port 7801 examples\bom-sample.md
 *   node tools/bom-e2e-check.mjs 7801 examples\bom-sample.md
 *
 * 这个用例是为了回归 E16（1.0.0 的 BOM 死循环白屏）。旧版跑它会在
 * 拉取页面后永久卡住，所以外面必须配超时。
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const port = Number(process.argv[2] || 7799);
const file = path.resolve(process.argv[3] || 'examples/bom-sample.md');
const base = 'http://127.0.0.1:' + port;

let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
};

const buf = fs.readFileSync(file);
check('样本文件确实带 BOM', buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF,
  [...buf.slice(0, 3)].map((b) => b.toString(16)).join(' '));

const page = await (await fetch(base + '/')).text();
const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
check('页面含 4 个脚本块', scripts.length === 4, String(scripts.length));

const sandbox = { window: null, console };
sandbox.window = sandbox;
vm.createContext(sandbox);

const t0 = Date.now();
for (let i = 0; i < 3; i++) vm.runInContext(scripts[i], sandbox);
check('前端渲染器加载完成（未卡死）', typeof sandbox.mdview?.parse === 'function');

const api = await (await fetch(base + '/api/file?f=' + encodeURIComponent(file))).json();
check('服务端能读到 BOM 文件', typeof api.content === 'string' && api.content.length > 0,
  'content 长度 ' + (api.content || '').length);
check('服务端已剥掉开头 BOM', api.content.charCodeAt(0) !== 0xFEFF,
  '首字符 U+' + (api.content || '').charCodeAt(0).toString(16));

const t1 = Date.now();
const out = sandbox.mdview.parse(api.content, { dir: path.dirname(file) });
const ms = Date.now() - t1;
check('解析在 50ms 内完成（旧版会永久卡住）', ms < 50, ms + 'ms');
check('产出了 HTML', out.html.length > 0, out.html.length + ' 字符');
check('识别出了标题', out.headings.length >= 1, out.headings.map((h) => h.text).join(' / '));
check('渲染结果里不含 U+FEFF 残留', out.html.indexOf('\uFEFF') < 0);
check('总耗时正常', Date.now() - t0 < 3000, (Date.now() - t0) + 'ms');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
