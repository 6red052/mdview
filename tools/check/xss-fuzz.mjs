/*
 * 渲染器的 XSS / 链接注入回归：25 组攻击性输入，逐条检查产出的 HTML。
 *
 *   node tools/check/xss-fuzz.mjs
 *
 * 判定方式不是"抓关键字"，而是解析产出的标签：
 *   1. 不允许出现 script / iframe / object / embed / base / form 这些标签；
 *   2. 任何 href/src 的属性值都不允许是 javascript: / vbscript: / data: / blob:；
 *   3. 事件处理属性（on*）一律不允许出现。
 * 文本里被转义成 &lt;script&gt; 的字面量不算问题，所以只看标签与属性。
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

const parse = (s) => sandbox.mdview.parse(s, { dir: '.' }).html;

const FORBIDDEN_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'base', 'form', 'meta', 'link']);
const BAD_SCHEME = /^\s*(javascript|vbscript|data|blob|file):/i;

const CASES = [
  ['裸 script', '<script>alert(1)</script>'],
  ['img onerror', '<img src=x onerror=alert(1)>'],
  ['svg onload', '<svg onload=alert(1)>'],
  ['javascript: 链接', '[x](javascript:alert(1))'],
  ['大小写混淆', '[x](JaVaScRiPt:alert(1))'],
  ['vbscript:', '[x](vbscript:msgbox(1))'],
  ['data:text/html', '[x](data:text/html,<script>alert(1)</script>)'],
  ['data:image/svg+xml', '![x](data:image/svg+xml,<svg onload=alert(1)>)'],
  ['图片 javascript:', '![x](javascript:alert(1))'],
  ['raw a href', '<a href="javascript:alert(1)">x</a>'],
  ['强调里的 script', '**<script>alert(1)</script>**'],
  ['标题里的 script', '# <script>alert(1)</script>'],
  ['列表里的 img', '- <img src=x onerror=alert(1)>'],
  ['表格里的 script', '| a | b |\n|---|---|\n| <script>alert(1)</script> | x |'],
  ['引用里的 svg', '> <svg onload=alert(1)>'],
  ['围栏里的 script', '```html\n<script>alert(1)</script>\n```'],
  ['协议相对', '[x](//evil.example/p)'],
  ['尖括号包裹', '[x](<javascript:alert(1)>)'],
  ['引号逃逸', '[x](" onmouseover="alert(1))'],
  ['iframe', '<iframe src=javascript:alert(1)>'],
  ['object', '<object data=javascript:alert(1)>'],
  ['file 协议（应被丢弃）', '[x](file:///C:/Windows/win.ini)'],
  ['图片协议相对', '![x](//evil.example/a.png)'],
  ['math 嵌套', '<math><mtext><script>alert(1)</script></mtext></math>'],
  ['制表符混淆', '[x](java\tscript:alert(1))'],
];

let pass = 0, fail = 0;
const bad = (name, why) => { fail++; console.log('  FAIL  ' + name + '  → ' + why); };
const ok = (name) => { pass++; console.log('  PASS  ' + name); };

for (const [name, md] of CASES) {
  let html;
  try { html = parse(md); } catch (e) { bad(name, '解析抛异常: ' + e.message); continue; }

  const tags = [...html.matchAll(/<\s*([a-zA-Z][\w-]*)([^>]*)>/g)];
  let problem = null;
  for (const t of tags) {
    const tag = t[1].toLowerCase();
    const attrs = t[2] || '';
    if (FORBIDDEN_TAGS.has(tag)) { problem = '出现禁止标签 <' + tag + '>'; break; }
    const ev = /\s(on[a-z]+)\s*=/i.exec(attrs);
    if (ev) { problem = '出现事件属性 ' + ev[1]; break; }
    const url = /\s(href|src)\s*=\s*"([^"]*)"/gi;
    let m;
    while ((m = url.exec(attrs)) !== null) {
      if (BAD_SCHEME.test(m[2])) { problem = m[1] + ' 带有危险协议: ' + m[2].slice(0, 40); break; }
    }
    if (problem) break;
  }
  if (problem) bad(name, problem); else ok(name);
}

// 另外确认正常内容没被弄坏：转义后的 < > 应该以实体形式保留
const plain = parse('普通段落 <b>不是标签</b> 与 `code <x>`');
if (plain.includes('<b>') || plain.includes('<x>')) bad('正常内容仍被转义', '产出了真实标签');
else ok('正常内容仍被转义');

// <code> 里的行内 HTML 必须是转义文本
const codeHtml = parse('`<script>alert(1)</script>`');
if (/<script/i.test(codeHtml)) bad('行内代码里的 script', '未转义');
else ok('行内代码里的 script');

// file: 链接整条丢弃（浏览器本来也会拦，留着只是坏链接）
const fileLink = parse('[x](file:///C:/a.pdf)');
if (/file:/i.test(fileLink)) bad('file: 链接被丢弃', '产出里仍有 file:');
else ok('file: 链接被丢弃');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
