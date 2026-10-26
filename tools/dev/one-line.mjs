/*
 * 最小复现：只解析一行，看是否真的卡住。
 *   node tools/dev/one-line.mjs <文件> <行号>
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

const file = process.argv[2];
const want = Number(process.argv[3] || 0);
console.log('读取: ' + file);
const raw = fs.readFileSync(file);
console.log('字节数: ' + raw.length);
const text = raw.toString('utf8');
const lines = text.split(/\r?\n/);
console.log('行数: ' + lines.length);
const line = lines[want];
console.log('第 ' + want + ' 行(' + line.length + ' 字符): ' + JSON.stringify(line));

console.log('解析前...');
const t0 = Date.now();
const out = sandbox.mdview.parse(line, { dir: path.dirname(file) });
console.log('解析完成 ' + (Date.now() - t0) + 'ms');
console.log('HTML: ' + JSON.stringify(out.html.slice(0, 200)));

console.log('现在解析整篇...');
const t1 = Date.now();
const whole = sandbox.mdview.parse(text, { dir: path.dirname(file) });
console.log('整篇完成 ' + (Date.now() - t1) + 'ms  HTML=' + whole.html.length);
