/*
 * Renders the test fixture with the REAL scripts served by mdview.
 * Pulls the page over HTTP, extracts <script> blocks, runs them under a
 * minimal window stub, then prints and inspects the produced HTML.
 *
 *   node server.mjs serve --port 7799 examples\test-fixture.md
 *   node tools/render-check.mjs [port] [fixture-path]
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2] || 7799);
const base = 'http://127.0.0.1:' + port;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(repoRoot, 'examples', 'test-fixture.md');

const page = await (await fetch(`${base}/view?f=${encodeURIComponent(fixture)}`)).text();
const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (scripts.length !== 4) throw new Error('expected 4 script blocks, got ' + scripts.length);

const sandbox = { window: null, document: undefined, location: { search: '', hash: '' }, history: {} };
sandbox.window = sandbox;
sandbox.navigator = { clipboard: null };
sandbox.localStorage = { getItem: () => null, setItem: () => {} };
sandbox.setTimeout = setTimeout;
sandbox.clearTimeout = clearTimeout;

const { createContext, runInContext } = await import('node:vm');
const ctx = createContext(sandbox);

// boot + highlighter + markdown core only; the UI script needs a real DOM.
for (let i = 0; i < 3; i++) runInContext(scripts[i], ctx, { filename: 'served-script-' + i + '.js' });

if (typeof sandbox.mdviewHighlight !== 'function') throw new Error('mdviewHighlight missing');
if (!sandbox.mdview || typeof sandbox.mdview.parse !== 'function') throw new Error('mdview.parse missing');

const md = await (await fetch(`${base}/api/file?f=${encodeURIComponent(fixture)}`)).json();
const out = sandbox.mdview.parse(md.content, { dir: path.dirname(md.path) });
const html = out.html;

// The relative link assertion depends on where this repo lives, so build it.
const expectedRelLink = path
  .join(path.dirname(md.path), 'sub', 'other.md')
  .replace(/\\/g, '/');
const escapedRelLink = expectedRelLink.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const checks = [
  ['h1 + id', /<h1 id="mdview-测试文档"/],
  ['h2', /<h2 id="二级标题"/],
  ['bold', /<strong>粗体<\/strong>/],
  ['italic', /<em>斜体<\/em>/],
  ['strikethrough', /<del>删除线<\/del>/],
  ['mark', /<mark>高亮<\/mark>/],
  ['inline code', /<code class="md-code-inline">行内代码<\/code>/],
  ['external link has target', /class="md-a md-ext"[^>]*target="_blank"/],
  ['blockquote', /<blockquote class="md-quote">/],
  ['nested blockquote', /<blockquote class="md-quote">[\s\S]*<blockquote/],
  ['task done', /class="md-task md-task-done"[\s\S]*checked/],
  ['task open', /class="md-task"[^>]*><input type="checkbox" disabled>/],
  ['nested ul', /<ul class="md-list md-ul">[\s\S]*<ul class="md-list md-ul">/],
  ['ordered list', /<ol class="md-list md-ol">/],
  ['js highlight keyword', /hl-kw">function<\/span>/],
  ['js highlight string', /hl-str">/],
  ['js highlight comment', /hl-com">\/\/ JavaScript/],
  ['python highlight', /data-lang="python"/],
  ['sql highlight', /hl-kw">SELECT<\/span>/],
  ['plain fence kept', /无语言标记的代码块/],
  ['table', /<table class="md-table">/],
  ['table thead', /<thead><tr><th style="text-align:left">功能<\/th>/],
  ['table alignment right', /text-align:right/],
  ['hr', /<hr class="md-hr">/],
  ['raw html escaped', /&lt;span class=&quot;x&quot;&gt;/],
  ['relative md link rewritten', new RegExp('class="md-a md-local"[^>]*data-md="' + escapedRelLink + '"')],
  ['anchor link', /class="md-a md-anchor" href="#mdview-测试文档"/],
  ['autolink', /href="https:\/\/nodejs\.org\/dist\/"/],
  ['robots safe: no literal script tag in rendered html', /^(?![\s\S]*<script)[\s\S]*$/],
  ['image rewritten to /asset', /<img class="md-img" src="\/asset\?p=/],

  ['no javascript: url', /^(?![\s\S]*javascript:)/],
];

let pass = 0, fail = 0;
for (const [name, re] of checks) {
  const ok = re.test(html);
  if (ok) pass++; else fail++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name);
}

console.log('\nheadings:', out.headings.map((h) => h.level + ':' + h.id).join(' '));
console.log('images captured:', JSON.stringify(out.images));
console.log(`\n${pass} passed, ${fail} failed`);

if (process.env.DUMP) {
  console.log('\n----- rendered html -----\n' + html);
}
process.exitCode = fail ? 1 : 0;
