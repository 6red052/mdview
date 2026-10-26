/*
 * 最小复现 BOM 死循环：
 *   node tools/check/bom.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createGrabber } from '../lib/template.mjs';

const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server.mjs');
const src = fs.readFileSync(serverPath, 'utf8');
const grabTemplate = createGrabber(src);
const sandbox = { window: null, console };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(grabTemplate('HIGHLIGHT_JS'), sandbox);
vm.runInContext(grabTemplate('MD_CORE_JS'), sandbox);
const parse = (s) => sandbox.mdview.parse(s, { dir: '.' });

// 每条用例单独跑，前面加标记以便知道死在哪条
const cases = [
  ['纯标题（正常）', '# 标题'],
  ['标题前有 BOM', '\uFEFF# 标题'],
  ['只有 BOM', '\uFEFF'],
  ['BOM + 普通段落', '\uFEFF这是正文'],
  ['BOM 在第二行', '第一行\n\uFEFF第二行'],
  ['BOM 在中间', '前面\n\uFEFF后面'],
  ['零宽空格 U+200B', '\u200B# 标题'],
  ['BOM + 引用', '\uFEFF> 引用'],
  ['BOM + 列表', '\uFEFF- 项目'],
  ['BOM + 表格', '\uFEFF| a | b |\n|---|---|\n| 1 | 2 |'],
];

for (const [name, input] of cases) {
  process.stdout.write('  ' + name + ' ... ');
  const t0 = Date.now();
  const out = parse(input);
  console.log('OK ' + (Date.now() - t0) + 'ms  html=' + out.html.length);
}
console.log('全部通过（没有死循环）');
