#!/usr/bin/env node
/*
 * mdview — zero-dependency local Markdown viewer.
 *
 *   mdview <file.md>          open a file in the browser (starts the server if needed)
 *   mdview <folder>           browse every Markdown file under a folder
 *   mdview serve [--port N]   run the server in the foreground
 *   mdview stop               stop the background server
 *   mdview status             show server state
 *   mdview --help
 *
 * Everything stays on 127.0.0.1. No telemetry, no network, no dependencies.
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// SEA（单文件 exe）检测。Node 20.12+ 才有 node:sea，且官方 API 是 isSea()，
// 不是 process.isSea —— 后者在 Node 24 上是 undefined，写它会永远走进假分支。
let IS_SEA = false;
try {
  const sea = await import('node:sea');
  IS_SEA = typeof sea.isSea === 'function' ? sea.isSea() : false;
} catch { /* 老版本 Node 或模块不存在：按普通脚本处理 */ }

/** argv[0]-style prefix used to re-invoke this program for the background server. */
function selfInvocation() {
  if (IS_SEA) return { file: process.execPath, prefix: [] };
  return { file: process.execPath, prefix: [fileURLToPath(import.meta.url)] };
}
const APP_VERSION = '1.0.0';
const DEFAULT_PORT = 7717;
// Every request that changes state on behalf of the page must carry this
// header. A browser cannot attach a custom header to a cross-origin request
// without a CORS preflight first, so a hostile page cannot drive those
// endpoints even if it manages to reach 127.0.0.1.
const CLIENT_HEADER = 'x-mdview';
// Fallback retirement for the background server. Normally it exits much sooner:
// as soon as the last browser tab has been closed for TAB_GRACE_MS. Override
// with MDVIEW_IDLE_MINUTES (0 disables the idle timeout entirely).
const idleTimeoutMs = (() => {
  const raw = process.env.MDVIEW_IDLE_MINUTES;
  if (raw === undefined || raw === '') return 15 * 60 * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 15 * 60 * 1000;
  return n === 0 ? Infinity : n * 60 * 1000;
})();
const IDLE_MINUTES_LABEL = idleTimeoutMs === Infinity ? '永不（已禁用空闲退出）' : Math.round(idleTimeoutMs / 60000) + ' 分钟';
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_TREE_ENTRIES = 6000;
// 目录遍历的兜底上限：只看 Markdown 条目数不够，一个塞满非 md 文件的大目录
// （或指向 C:\Windows 的 junction）会让 /api/tree 跑几十秒。
const MAX_TREE_VISITED = 20000;
const TREE_TIME_BUDGET_MS = 8000;
const MD_EXT = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mdx', '.mdtext', '.text']);
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '$RECYCLE.BIN', 'System Volume Information',
  '.idea', '.vscode', '.next', '.cache', '__pycache__', 'dist', '.venv', 'venv',
]);
// 允许交给系统默认程序打开的类型。不在这张表里的一律拒绝——尤其是不让
// 文档里一个链接就把 .exe / .lnk / .bat 执行起来。
// .svg 故意不放进来：它是活动内容（可含脚本），而 /api/open 会用 file:// 源
// 打开它，绕开 /asset 的 CSP 沙箱。图片场景走 <img> + /asset 就够。
const OPENABLE_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico',
  '.pdf', '.mp4', '.webm', '.mp3', '.wav', '.ogg',
  '.zip', '.7z', '.rar', '.txt', '.log',
]);

// 可以内联返回（被 <img>/<video>/<audio> 直接用）的类型。
// 其余一律 application/octet-stream + attachment：本地 .html 绝不能在
// 127.0.0.1 这个源里被当成活动内容执行。
// .svg 允许内联（当图片用），但响应总是带 CSP sandbox，直接导航过去也执行不了脚本。
const INLINE_ASSET_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.svg',
  '.pdf', '.mp4', '.webm', '.mp3', '.wav', '.ogg',
]);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

/* ------------------------------------------------------------------ state */

const HOME = os.homedir();
const DATA_DIR = process.env.MDVIEW_HOME
  ? path.resolve(process.env.MDVIEW_HOME)
  : path.join(process.env.LOCALAPPDATA || path.join(HOME, '.local', 'share'), 'mdview');
const STATE_FILE = path.join(DATA_DIR, 'server.json');
const LOG_FILE = path.join(DATA_DIR, 'server.log');

function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (raw && typeof raw.port === 'number' && raw.port > 0) return raw;
  } catch { /* no state yet */ }
  return null;
}

function writeState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function isAlive(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 900 },
      (res) => { res.resume(); resolve(res.statusCode === 200); },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/* ---------------------------------------------------------------- utility */

const norm = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '') || '/';

/**
 * 解析 reparse point（Windows 的 junction / 符号链接）。
 *
 * 白名单如果只比较路径字符串，一个指向白名单外的 junction 就能把
 * C:\Windows 变成"允许目录的子目录"。所以判断前后都用真实路径再比一次。
 * 解析失败时退回原值，让后续 stat 去报错。
 */
function realPathOf(p) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Browsers and URLSearchParams hand us forward slashes even for Windows paths,
 * and path.resolve() keeps them, which makes fs.stat() fail. Normalize first.
 * On Windows a "/" can never be part of a file name, so this is always safe.
 */
function toNative(p) {
  const s = String(p);
  if (process.platform !== 'win32') return s;
  return s.replace(/\//g, '\\');
}

function isInside(child, parent) {
  const c = norm(child).toLowerCase();
  const p = norm(parent).toLowerCase();
  return c === p || c.startsWith(p + '/');
}

function isMarkdown(p) {
  return MD_EXT.has(path.extname(p).toLowerCase());
}

function humanSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * Paths travel as base64url tokens so that "?" and "#" in file names survive a
 * URL (the URL codec percent-encodes them fine, but "/view?f=<path>" is much
 * easier to build and share). Plain paths also arrive here — from the CLI and
 * from hand-typed URLs — so only decode when the value cannot be a path: a real
 * path always contains a separator, a drive colon or a dot.
 */
function decodeToken(token) {
  const s = String(token == null ? '' : token);
  if (!s) return null;
  if (/[\\/:.]/.test(s)) return s;
  if (!/^[A-Za-z0-9_-]+$/.test(s) || s.length < 16) return s;
  try {
    const decoded = Buffer.from(s, 'base64url').toString('utf8');
    if (/^[A-Za-z]:[\\/]/.test(decoded) || decoded.startsWith('/') || decoded.startsWith('\\\\')) {
      return decoded;
    }
  } catch { /* fall through and treat it as a plain value */ }
  return null;
}

function encodeToken(absPath) {
  return Buffer.from(absPath, 'utf8').toString('base64url');
}

/**
 * Open a URL or file with the OS default handler, detached from this process.
 *
 * Windows goes through rundll32's FileProtocolHandler instead of
 * `cmd /c start "<url>"`: cmd re-parses its command line, and "&" is a legal
 * character in a Windows file name, so a path like `notes\a & b.pdf` would be
 * split into two commands. rundll32 receives the argument verbatim — no shell
 * sits between us and the handler.
 */
function openExternal(url) {
  try {
    // 测试钩子：`npm test` 里不要真的把记事本/浏览器拉起来。
    // 只认这一个精确值，生产环境不会设置它。
    if (process.env.MDVIEW_NO_OPEN === '1') return true;
    if (process.platform === 'win32') {
      const child = spawn('rundll32', ['url.dll,FileProtocolHandler', url], {
        detached: true, stdio: 'ignore', windowsHide: true,
      });
      child.unref();
      return true;
    }
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------- markdown source */

// Offline syntax highlighter (no CDN). Small, regex driven, purely cosmetic.
const HIGHLIGHT_JS = String.raw`
(function () {
  var KW = {
    js: 'var,let,const,function,return,if,else,for,while,do,break,continue,new,delete,typeof,instanceof,in,of,class,extends,super,this,null,undefined,true,false,try,catch,finally,throw,switch,case,default,yield,await,async,import,export,from,static,get,set,void',
    ts: 'var,let,const,function,return,if,else,for,while,do,break,continue,new,delete,typeof,instanceof,in,of,class,extends,super,this,null,undefined,true,false,try,catch,finally,throw,switch,case,default,yield,await,async,import,export,from,static,get,set,void,interface,type,enum,implements,declare,namespace,public,private,protected,readonly,abstract,as,satisfies',
    py: 'def,class,return,if,elif,else,for,while,break,continue,import,from,as,pass,raise,try,except,finally,with,lambda,yield,global,nonlocal,assert,del,in,is,not,and,or,None,True,False,async,await,match,case,self',
    rb: 'def,class,module,end,if,elsif,else,unless,while,until,for,do,return,yield,begin,rescue,ensure,raise,require,attr_accessor,attr_reader,attr_writer,nil,true,false,self,new,super,lambda,proc',
    go: 'package,import,func,var,const,type,struct,interface,map,chan,go,defer,return,if,else,for,range,break,continue,switch,case,default,select,nil,true,false,string,int,int64,float64,bool,byte,rune,error,make,new,len,cap,append,copy,delete,panic,recover',
    rs: 'fn,let,mut,const,struct,enum,impl,trait,for,while,loop,if,else,match,return,use,mod,pub,crate,self,super,as,where,dyn,ref,move,async,await,unsafe,static,type,Box,Vec,String,Option,Result,Some,None,Ok,Err,true,false',
    java: 'public,private,protected,class,interface,extends,implements,new,return,if,else,for,while,do,switch,case,default,break,continue,try,catch,finally,throw,throws,static,final,void,int,long,double,float,boolean,char,byte,short,String,import,package,this,super,null,true,false,abstract,synchronized,volatile,transient,instanceof,enum,record,var',
    c: 'int,long,short,char,float,double,void,struct,union,enum,typedef,static,const,unsigned,signed,return,if,else,for,while,do,switch,case,default,break,continue,goto,sizeof,extern,register,volatile,inline,NULL,true,false,class,public,private,protected,namespace,template,using,new,delete,this,nullptr,try,catch,throw,auto,bool',
    sh: 'if,then,else,elif,fi,for,while,do,done,case,esac,function,return,exit,local,export,readonly,declare,source,alias,echo,cd,set,unset,trap,in',
    sql: 'SELECT,FROM,WHERE,INSERT,INTO,VALUES,UPDATE,SET,DELETE,CREATE,TABLE,INDEX,VIEW,DROP,ALTER,JOIN,LEFT,RIGHT,INNER,OUTER,ON,GROUP,BY,ORDER,HAVING,LIMIT,OFFSET,AS,AND,OR,NOT,NULL,PRIMARY,KEY,FOREIGN,REFERENCES,DEFAULT,DISTINCT,UNION,ALL,CASE,WHEN,THEN,END',
    css: '',
    json: 'true,false,null',
  };
  var ALIAS = {
    javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js',
    typescript: 'ts', tsx: 'ts',
    python: 'py', py3: 'py',
    ruby: 'rb',
    golang: 'go',
    rust: 'rs',
    'c++': 'c', cpp: 'c', cxx: 'c', hpp: 'c', 'c#': 'c', cs: 'c', csharp: 'c', objc: 'c', h: 'c',
    java: 'java', kotlin: 'java', kt: 'java', scala: 'java', groovy: 'java',
    bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', powershell: 'sh', ps1: 'sh', bat: 'sh', cmd: 'sh', dockerfile: 'sh', yaml: 'sh', yml: 'sh', toml: 'sh', ini: 'sh', conf: 'sh', properties: 'sh', makefile: 'sh', make: 'sh', graphql: 'sh', gql: 'sh',
    sql: 'sql', mysql: 'sql', postgres: 'sql', postgresql: 'sql', plsql: 'sql',
    json5: 'json', jsonc: 'json', json: 'json',
    css: 'css', scss: 'css', less: 'css', sass: 'css',
    html: 'html', htm: 'html', xml: 'html', xhtml: 'html', svg: 'html', vue: 'html', markdown: 'md', md: 'md',
  };
  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function span(cls, text) { return '<span class="hl-' + cls + '">' + esc(text) + '</span>'; }
  function highlightRules(src, rules) {
    var out = '', i = 0;
    while (i < src.length) {
      var matched = false;
      for (var r = 0; r < rules.length; r++) {
        var rule = rules[r];
        rule.re.lastIndex = i;
        var m = rule.re.exec(src);
        if (m && m.index === i) {
          out += rule.cls ? span(rule.cls, m[0]) : esc(m[0]);
          i += m[0].length;
          matched = true;
          break;
        }
      }
      if (!matched) { out += esc(src[i]); i += 1; }
    }
    return out;
  }
  function buildRules(kw, flags) {
    var rules = [];
    rules.push({ re: /\/\*[\s\S]*?\*\//y, cls: 'com' });
    rules.push({ re: /\/\/[^\n]*/y, cls: 'com' });
    rules.push({ re: /#[^\n]*/y, cls: 'com' });
    rules.push({ re: /--[^\n]*/y, cls: 'com' });
    rules.push({ re: /"(?:\\.|[^"\\\n])*"/y, cls: 'str' });
    rules.push({ re: /'(?:\\.|[^'\\\n])*'/y, cls: 'str' });
    if (kw) {
      // keyword lists are comma separated: build a real alternation
      var words = String(kw).split(",").filter(function (w) { return w.trim().length > 0; });
      rules.push({ re: new RegExp("(?:\\b(?:" + words.join("|") + ")\\b)", "y" + (flags || "")), cls: "kw" });
    }
    rules.push({ re: /\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y, cls: 'num' });
    // 名字长度设上限：不加界时，一行 20 万个字母会让 [\w$]* 逐位置回溯，
    // 单个代码块就能把页面冻住几十秒（实测 199k 字符约 69 秒）。120 够覆盖
    // 正常函数名，同时把最坏情况压在百毫秒级。
    rules.push({ re: /[A-Za-z_$][\w$]{0,120}(?=\s*\()/y, cls: 'fn' });
    return rules;
  }
  var cache = {};
  function rulesFor(lang) {
    var key = ALIAS[lang] !== undefined ? ALIAS[lang] : lang;
    if (cache[key]) return cache[key];
    var rules;
    if (key === 'html') {
      rules = [
        { re: /<!--[\s\S]*?-->/y, cls: 'com' },
        { re: /"(?:\\.|[^"\\])*"/y, cls: 'str' },
        { re: /'(?:\\.|[^'\\])*'/y, cls: 'str' },
        { re: /<\/?[A-Za-z][\w:-]*/y, cls: 'kw' },
        { re: /\/?>/y, cls: 'kw' },
        { re: /[A-Za-z_:][\w:.-]*(?==)/y, cls: 'fn' },
      ];
    } else if (key === 'md') {
      rules = [
        { re: /^#{1,6}[^\n]*/my, cls: 'kw' },
        { re: /\*\*[^*\n]+\*\*/y, cls: 'str' },
        { re: /\`[^\`\n]*\`/y, cls: 'fn' },
        { re: /^\s*[-*+]\s/my, cls: 'kw' },
      ];
    } else if (key === 'css') {
      rules = [
        { re: /\/\*[\s\S]*?\*\//y, cls: 'com' },
        { re: /"(?:\\.|[^"\\])*"/y, cls: 'str' },
        { re: /'(?:\\.|[^'\\])*'/y, cls: 'str' },
        { re: /@[\w-]+/y, cls: 'kw' },
        { re: /[.#]?[-\w]+(?=\s*\{)/y, cls: 'fn' },
        { re: /-?[a-zA-Z-]+(?=\s*:)/y, cls: 'kw' },
        { re: /#[0-9a-fA-F]{3,8}\b/y, cls: 'num' },
        { re: /\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?\b/y, cls: 'num' },
      ];
    } else {
      rules = buildRules(KW[key] || '', key === 'sql' ? 'i' : '');
    }
    cache[key] = rules;
    return rules;
  }
  function highlight(code, lang) {
    try {
      if (!code) return '';
      if (code.length > 200000) return esc(code);
      return highlightRules(code, rulesFor(String(lang || 'plain').toLowerCase()));
    } catch (e) {
      return esc(code);
    }
  }
  window.mdviewHighlight = highlight;
})();
`;

const MD_CORE_JS = String.raw`
(function () {
  'use strict';
  var TOKEN = { asset: null, md: 0 };

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escAttr(s) { return esc(s); }
  function slug(s) {
    var base = String(s).toLowerCase().trim()
      .replace(/[^\w\u4e00-\u9fa5\- ]+/g, '')
      .replace(/\s+/g, '-').replace(/^-+|-+$/g, '');
    return base || 'section';
  }
  function safeUrl(href) {
    var u = String(href).trim();
    // file: 也一并丢弃：从 http 页面导航到 file:// 会被浏览器拦住，留着只是一个
    // 点了没反应的坏链接。要打开本地文件请用相对/绝对路径（走 /api/open）。
    if (/^\s*(javascript|vbscript|data|blob|file)\s*:/i.test(u)) return null;
    return u;
  }
  function isExternal(u) {
    return /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(u) || /^(?:https?|mailto|tel|ftp):/i.test(u);
  }
  function isLocalMarkdown(u) {
    var clean = u.split('#')[0].split('?')[0].toLowerCase();
    return /\.(md|markdown|mdown|mkd|mdx|mdtext|text)$/.test(clean);
  }
  function viewerUrl(abs) { return '/view?f=' + encodeURIComponent(abs); }
  function assetUrl(abs) {
    return '/asset?p=' + encodeURIComponent(abs) + '&t=' + encodeURIComponent(TOKEN.asset);
  }
  function resolveRelative(fromDir, rel) {
    var s = String(rel).replace(/\\/g, '/');
    if (/^[a-zA-Z]:\//.test(s)) return s;
    var base = String(fromDir || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (s.charAt(0) === '/') {
      var drive = (base.match(/^[a-zA-Z]:/) || [''])[0];
      return drive + s;
    }
    var parts = base.split('/');
    s.split('/').forEach(function (seg) {
      if (seg === '' || seg === '.') return;
      if (seg === '..') { if (parts.length > 1) parts.pop(); return; }
      parts.push(seg);
    });
    return parts.join('/');
  }
  /** Keep forward slashes: they are what the server normalizes back anyway. */
  function toSlashes(p) { return String(p).replace(/\\/g, '/'); }

  /* ------------------------------------------------------------ inline --- */
  function parseInline(src, ctx) {
    TOKEN.md += 1;
    var store = [];
    function stash(html) {
      var key = '\u0000T' + (store.length) + '\u0000';
      store.push(html);
      return key;
    }
    var text = String(src == null ? '' : src);

    // 1. protect code spans
    text = text.replace(/(\`+)([\s\S]*?)\1/g, function (m, ticks, code) {
      var lang = null, body = code;
      var mm = /^([A-Za-z0-9_+#.-]+)\s*\n([\s\S]*)$/.exec(code);
      if (mm) { lang = mm[1]; body = mm[2]; }
      var inner = lang && window.mdviewHighlight
        ? window.mdviewHighlight(body, lang)
        : esc(body);
      return stash('<code class="md-code-inline">' + inner + '</code>');
    });

    // 2. images before links
    text = text.replace(/!\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+["']([^"']*)["'])?\s*\)/g,
      function (m, alt, url, title) {
        var u = safeUrl(url.replace(/^<|>$/g, ''));
        if (!u) return esc(alt || '');
        var src2;
        // safeUrl 已经丢弃 data:，所以这里只有外链和本地资源两种。
        if (isExternal(u)) src2 = u;
        else if (u.charAt(0) === '#') return stash('<span class="md-broken">[图片] ' + esc(alt || '') + '</span>');
        else {
          var abs = resolveRelative(ctx.dir, u);
          src2 = assetUrl(abs);
          ctx.images.push({ rel: u, abs: abs });
        }
        var t = title ? ' title="' + escAttr(title) + '"' : '';
        return stash('<img class="md-img" src="' + escAttr(src2) + '" alt="' + escAttr(alt || '') + '"' + t +
          ' data-path="' + escAttr(toSlashes(resolveRelative(ctx.dir, u))) + '" loading="lazy">');
      });

    // 3. links
    text = text.replace(/\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+["']([^"']*)["'])?\s*\)/g,
      function (m, label, url, title) {
        var u = safeUrl(url.replace(/^<|>$/g, ''));
        var labelHtml = parseInline(label, ctx);
        if (!u) return labelHtml;
        var t = title ? ' title="' + escAttr(title) + '"' : '';
        if (u.charAt(0) === '#') return stash('<a class="md-a md-anchor" href="' + escAttr(u) + '"' + t + '>' + labelHtml + '</a>');
        if (isExternal(u)) return stash('<a class="md-a md-ext" href="' + escAttr(u) + '" target="_blank" rel="noopener noreferrer"' + t + '>' + labelHtml + '</a>');
        var hash = '';
        var hashIdx = u.indexOf('#');
        var filePart = u, frag = '';
        if (hashIdx >= 0) { filePart = u.slice(0, hashIdx); frag = u.slice(hashIdx); }
        if (filePart === '') return stash('<a class="md-a md-anchor" href="' + escAttr(frag) + '"' + t + '>' + labelHtml + '</a>');
        // A malformed escape such as "a%ZZ.md" must not take the whole page
        // down with it: fall back to the raw text and let the request 404.
        var abs;
        try { abs = resolveRelative(ctx.dir, decodeURIComponent(filePart)); }
        catch (e) { abs = resolveRelative(ctx.dir, filePart); }
        if (isLocalMarkdown(abs)) {
          return stash('<a class="md-a md-local" href="' + escAttr(viewerUrl(abs) + frag) + '" data-md="' + escAttr(toSlashes(abs)) + '"' + t + '>' + labelHtml + '</a>');
        }
        // 绝对路径也走 md-file（点击时请求 /api/open，仍受类型白名单约束）。
        // 以前这里生成 file:// 链接，但现代浏览器禁止从 http 页面导航到 file://，
        // 点了没反应 —— 等于一个坏链接，不如交给同一个打开流程。
        return stash('<a class="md-a md-file" href="' + escAttr(assetUrl(abs)) + '" data-abs="' + escAttr(abs) + '"' + t + '>' + labelHtml + '</a>');
      });

    // 4. autolinks
    text = text.replace(/<((?:https?|mailto):[^\s<>]+)>/g, function (m, u) {
      return stash('<a class="md-a md-ext" href="' + escAttr(u) + '" target="_blank" rel="noopener noreferrer">' + esc(u) + '</a>');
    });
    text = text.replace(/(?<![\w/@.])((?:https?:\/\/)[^\s<>()（）]+)/g, function (m, u) {
      var trail = '';
      var mTrail = /[.,;:!?、。]+$/.exec(u);
      if (mTrail) { trail = mTrail[0]; u = u.slice(0, -trail.length); }
      return stash('<a class="md-a md-ext" href="' + escAttr(u) + '" target="_blank" rel="noopener noreferrer">' + esc(u) + '</a>') + trail;
    });

    // 5. escape everything that is left
    text = esc(text);

    // 6. emphasis on escaped text
    text = text
      .replace(/\*\*\*([^\s*][\s\S]*?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*([^\s*][\s\S]*?)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^\s_][\s\S]*?)__/g, '<strong>$1</strong>')
      .replace(/(^|[^\w*])\*([^\s*][^*\n]*?)\*(?=[^\w*]|$)/g, '$1<em>$2</em>')
      .replace(/(^|[^\w_])_([^\s_][^_\n]*?)_(?=[^\w_]|$)/g, '$1<em>$2</em>')
      .replace(/~~([\s\S]+?)~~/g, '<del>$1</del>')
      .replace(/==([\s\S]+?)==/g, '<mark>$1</mark>');

    // 7. explicit line breaks
    text = text.replace(/ {2,}\n/g, '<br>\n').replace(/\\\n/g, '<br>\n');

    // 8. restore stashed html
    text = text.replace(/\u0000T(\d+)\u0000/g, function (m, i) { return store[Number(i)] || ''; });
    return text;
  }

  /* ------------------------------------------------------------- blocks -- */
  function parseMarkdown(src, opts) {
    var options = opts || {};
    var ctx = { dir: options.dir || '', images: [] };
    // 递归深度上限：引用和嵌套列表会递归调用本函数，8000 层引用足以爆栈。
    // 超过上限就把剩余内容当字面文本吐出去，宁可显示得丑，也不能白屏。
    var depth = options.depth || 0;
    ctx.depth = depth;
    if (depth > 32) {
      return { html: '<p class="md-deep">' + esc(String(src == null ? '' : src)) + '</p>', images: [], headings: [] };
    }
    // Strip invisible/zero-width characters before anything else. U+FEFF is the
    // dangerous one: JavaScript's \s treats it as whitespace, so a file that
    // starts with a UTF-8 BOM matched the "paragraph ends here" test but not the
    // "paragraph continues" test, and the block loop spun forever on i = 0 —
    // which showed up as a blank page for any BOM-prefixed file.
    var cleaned = String(src == null ? '' : src)
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000\uFEFF\u200B-\u200F\u2060\u180E]/g, '');
    var lines = cleaned.split('\n');
    var html = [];
    var headings = [];
    var usedSlugs = Object.create(null);
    var i = 0;
    // Hard stop: every branch below must advance the line index. If some future
    // input ever slips past the guards, render the rest as literal text instead
    // of freezing the page forever (a frozen page looks like an empty document).
    var guardMax = lines.length * 8 + 1000;
    var guard = 0;

    function uniqueSlug(t) {
      var s = slug(t);
      if (usedSlugs[s] === undefined) { usedSlugs[s] = 1; return s; }
      usedSlugs[s] += 1;
      return s + '-' + usedSlugs[s];
    }

    function paragraph(buf) {
      if (!buf.length) return;
      html.push('<p>' + parseInline(buf.join('\n'), ctx) + '</p>');
    }

    while (i < lines.length) {
      guard += 1;
      if (guard > guardMax) {
        html.push('<pre class="md-pre md-pre-literal"><code class="hljs">' +
          (window.mdviewHighlight ? window.mdviewHighlight(lines.slice(i).join('\n'), '') : esc(lines.slice(i).join('\n'))) +
          '</code></pre>');
        break;
      }
      var line = lines[i];

      if (/^\s*$/.test(line)) { i += 1; continue; }

      // fenced code
      var fence = /^\s*(\`{3,}|~{3,})\s*([^\s\`]*)\s*$/.exec(line);
      if (fence) {
        var marker = fence[1].charAt(0);
        var lang = fence[2] || '';
        var buffer = [];
        i += 1;
        while (i < lines.length) {
          var closing = new RegExp('^\\s*' + (marker === '\`' ? '\`{3,}' : '~{3,}') + '\\s*$');
          if (closing.test(lines[i])) { i += 1; break; }
          buffer.push(lines[i]);
          i += 1;
        }
        var code = buffer.join('\n');
        var label = lang ? '<span class="md-lang">' + esc(lang) + '</span>' : '';
        var body = window.mdviewHighlight ? window.mdviewHighlight(code, lang) : esc(code);
        html.push('<div class="md-pre-wrap">' + label +
          '<button class="md-copy" type="button" data-copy="1">复制</button>' +
          '<pre class="md-pre"><code class="hljs" data-lang="' + escAttr(lang) + '">' + body + '</code></pre></div>');
        continue;
      }

      // heading
      var h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (h) {
        var level = h[1].length;
        var content = h[2];
        // strip inline code/marks for a clean slug
        var plain = content.replace(/\`([^\`]*)\`/g, '$1').replace(/[*_~]/g, '').trim();
        var id = uniqueSlug(plain);
        headings.push({ level: level, text: plain, id: id });
        html.push('<h' + level + ' id="' + escAttr(id) + '" class="md-h md-h' + level + '">' +
          '<a class="md-anchor-link" href="#' + escAttr(id) + '" aria-hidden="true">#</a>' +
          parseInline(content, ctx) + '</h' + level + '>');
        i += 1;
        continue;
      }

      // setext heading
      if (/^\s*(=+|-{3,})\s*$/.test(lines[i + 1] || '') && !/^\s*[-*+]\s/.test(line) && line.trim() !== '') {
        var lvl = /^\s*=+/.test(lines[i + 1]) ? 1 : 2;
        var sid = uniqueSlug(line.trim());
        headings.push({ level: lvl, text: line.trim(), id: sid });
        html.push('<h' + lvl + ' id="' + escAttr(sid) + '" class="md-h md-h' + lvl + '">' + parseInline(line.trim(), ctx) + '</h' + lvl + '>');
        i += 2;
        continue;
      }

      // horizontal rule
      if (/^\s*(?:\*\s*){3,}$/.test(line) || /^\s*(?:-\s*){3,}$/.test(line) || /^\s*(?:_\s*){3,}$/.test(line)) {
        html.push('<hr class="md-hr">');
        i += 1;
        continue;
      }

      // table
      if (line.indexOf('|') >= 0 && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] || '') && lines[i + 1].indexOf('-') >= 0) {
        var headCells = splitRow(line);
        var aligns = splitRow(lines[i + 1]).map(function (c) {
          var s = c.trim();
          var left = s.charAt(0) === ':';
          var right = s.charAt(s.length - 1) === ':';
          if (left && right) return 'center';
          if (right) return 'right';
          if (left) return 'left';
          return '';
        });
        i += 2;
        var rows = [];
        while (i < lines.length && lines[i].indexOf('|') >= 0 && !/^\s*$/.test(lines[i])) {
          rows.push(splitRow(lines[i]));
          i += 1;
        }
        var thead = '<thead><tr>' + headCells.map(function (c, idx) {
          var a = aligns[idx];
          return '<th' + (a ? ' style="text-align:' + a + '"' : '') + '>' + parseInline(c.trim(), ctx) + '</th>';
        }).join('') + '</tr></thead>';
        var tbody = '<tbody>' + rows.map(function (r) {
          var cells = [];
          for (var k = 0; k < headCells.length; k++) {
            var a2 = aligns[k];
            cells.push('<td' + (a2 ? ' style="text-align:' + a2 + '"' : '') + '>' + parseInline((r[k] || '').trim(), ctx) + '</td>');
          }
          return '<tr>' + cells.join('') + '</tr>';
        }).join('') + '</tbody>';
        html.push('<div class="md-table-wrap"><table class="md-table">' + thead + tbody + '</table></div>');
        continue;
      }

      // blockquote
      if (/^\s{0,3}>/.test(line)) {
        var q = [];
        while (i < lines.length && (/^\s{0,3}>/.test(lines[i]) || (/^\s*$/.test(lines[i]) && /^\s{0,3}>/.test(lines[i + 1] || '')))) {
          q.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
          i += 1;
        }
        var inner = parseMarkdown(q.join('\n'), { dir: ctx.dir, depth: depth + 1 });
        ctx.images = ctx.images.concat(inner.images);
        html.push('<blockquote class="md-quote">' + inner.html + '</blockquote>');
        continue;
      }

      // lists (with nesting by indentation)
      if (/^\s*(?:[-*+]|\d{1,9}[.)])\s+/.test(line)) {
        var listOut = parseList(lines, i, ctx);
        html.push(listOut.html);
        i = listOut.next;
        continue;
      }

      // HTML block: rendered as visible literal text (safe by design), except a
      // bare autolink such as <https://example.com>, which is prose, not markup.
      if (/^\s*</.test(line) && !/^\s*<(?:https?|mailto|ftp|tel):/i.test(line)) {
        var hb = [];
        while (i < lines.length && !/^\s*$/.test(lines[i])) { hb.push(lines[i]); i += 1; }
        html.push('<pre class="md-pre md-pre-literal"><code class="hljs" data-lang="html">' +
          (window.mdviewHighlight ? window.mdviewHighlight(hb.join('\n'), 'html') : esc(hb.join('\n'))) + '</code></pre>');
        continue;
      }

      // paragraph
      var pbuf = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) &&
        !/^\s*(?:#{1,6}\s|>|\`{3,}|~{3,}|[-*+]\s|\d{1,9}[.)]\s)/.test(lines[i]) &&
        !/^\s*(?:\*\s*){3,}$/.test(lines[i])) {
        pbuf.push(lines[i]);
        i += 1;
      }
      paragraph(pbuf);
    }

    return { html: html.join('\n'), headings: headings, images: ctx.images };
  }

  function splitRow(line) {
    var s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    var cells = [], cur = '', inCode = false;
    for (var k = 0; k < s.length; k++) {
      var ch = s.charAt(k);
      if (ch === '\\' && s.charAt(k + 1) === '|') { cur += '|'; k += 1; continue; }
      if (ch === '\`') inCode = !inCode;
      if (ch === '|' && !inCode) { cells.push(cur); cur = ''; continue; }
      cur += ch;
    }
    cells.push(cur);
    return cells;
  }

  function parseList(lines, start, ctx) {
    var first = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[start]);
    var baseIndent = first[1].length;
    var ordered = /\d/.test(first[2]);
    var startNum = ordered ? parseInt(first[2], 10) : 1;
    var items = [];
    var i = start;

    while (i < lines.length) {
      var m = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[i]);
      if (!m || m[1].length < baseIndent) break;
      if (m[1].length > baseIndent) { // nested content belongs to previous item
        if (!items.length) break;
        items[items.length - 1].push(lines[i].slice(baseIndent));
        i += 1;
        continue;
      }
      if (/\d/.test(m[2]) !== ordered) break;
      var chunks = [m[3]];
      i += 1;
      while (i < lines.length) {
        if (/^\s*$/.test(lines[i])) {
          var nxt = lines[i + 1] || '';
          if (/^\s*(?:[-*+]|\d{1,9}[.)])\s+/.test(nxt) && (nxt.match(/^\s*/)[0].length === baseIndent)) break;
          if (/^\s*$/.test(nxt)) break;
          chunks.push('');
          i += 1;
          continue;
        }
        var nm = /^(\s*)([-*+]|\d{1,9}[.)])\s+/.exec(lines[i]);
        if (nm && nm[1].length === baseIndent) break;
        if (/^\s*(?:#{1,6}\s|>|\`{3,})/.test(lines[i]) && lines[i].match(/^\s*/)[0].length <= baseIndent) break;
        chunks.push(lines[i].length > baseIndent + 2 ? lines[i].slice(baseIndent + 2) : lines[i].trim());
        i += 1;
      }
      items.push(chunks);
    }

    var html = ordered
      ? '<ol class="md-list md-ol"' + (startNum !== 1 ? ' start="' + startNum + '"' : '') + '>'
      : '<ul class="md-list md-ul">';

    items.forEach(function (chunks) {
      var raw = chunks.join('\n');
      var task = /^\[([ xX])\]\s+([\s\S]*)$/.exec(raw);
      var cls = '', checkbox = '';
      if (task) {
        cls = ' class="md-task' + (task[1].toLowerCase() === 'x' ? ' md-task-done' : '') + '"';
        checkbox = '<input type="checkbox" disabled' + (task[1].toLowerCase() === 'x' ? ' checked' : '') + '> ';
        raw = task[2];
      }
      var looksBlocky = /\n\s*\n/.test(raw) || /^\s*(?:[-*+]|\d{1,9}[.)])\s+/m.test(raw) ||
        /^\s*(?:\`{3,}|>|#{1,6}\s)/m.test(raw);
      var inner;
      if (looksBlocky) {
        var sub = parseMarkdown(raw, { dir: ctx.dir, depth: (ctx.depth || 0) + 1 });
        ctx.images = ctx.images.concat(sub.images);
        inner = sub.html;
        // unwrap a single leading paragraph for tighter list rendering
        inner = inner.replace(/^<p>([\s\S]*?)<\/p>/, function (mm, p) { return p; });
      } else {
        inner = parseInline(raw.replace(/\n/g, ' '), ctx);
      }
      html += '<li' + cls + '>' + checkbox + inner + '</li>';
    });

    return { html: html + (ordered ? '</ol>' : '</ul>'), next: i };
  }

  window.mdview = {
    parse: parseMarkdown,
    highlight: window.mdviewHighlight,
    setTokens: function (t) { TOKEN = { asset: t.asset, md: 0 }; },
    slug: slug,
    esc: esc
  };
})();
`;

const MD_CSS = String.raw`
:root {
  --bg: #ffffff;
  --bg-soft: #f6f7f9;
  --bg-sink: #eceef2;
  --fg: #1f2328;
  --fg-soft: #59636e;
  --fg-faint: #8b949e;
  --border: #d8dee4;
  --accent: #0b6bcb;
  --accent-soft: rgba(11, 107, 203, 0.12);
  --code-bg: #f3f5f8;
  --shadow: 0 6px 24px rgba(15, 23, 42, 0.08);
  --radius: 10px;
}
html[data-theme="dark"] {
  --bg: #14171c;
  --bg-soft: #1a1e24;
  --bg-sink: #0f1216;
  --fg: #dfe4ea;
  --fg-soft: #a7b0bd;
  --fg-faint: #78828f;
  --border: #2b3138;
  --accent: #63a9ff;
  --accent-soft: rgba(99, 169, 255, 0.16);
  --code-bg: #1b2027;
  --shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", Roboto, Helvetica, Arial, sans-serif;
  font-size: 16px;
  line-height: 1.7;
  -webkit-font-smoothing: antialiased;
}
button { font: inherit; color: inherit; }

/* ------------------------------------------------------------- app shell */
.app { display: flex; flex-direction: column; height: 100vh; }
.topbar {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-soft);
  flex: 0 0 auto;
  position: sticky; top: 0; z-index: 20;
}
.brand { display: flex; align-items: center; gap: 8px; font-weight: 650; letter-spacing: .2px; }
.brand .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
.crumb {
  display: flex; align-items: center; gap: 4px;
  min-width: 0; flex: 1 1 auto;
  font-size: 13px; color: var(--fg-soft);
  overflow: hidden; white-space: nowrap;
}
.crumb b { color: var(--fg); font-weight: 600; }
.crumb .sep { color: var(--fg-faint); }
.crumb .seg { overflow: hidden; text-overflow: ellipsis; }
.tools { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.btn {
  border: 1px solid var(--border); background: var(--bg);
  border-radius: 8px; padding: 5px 10px; cursor: pointer;
  font-size: 13px; line-height: 1.4; white-space: nowrap;
  transition: background .12s, border-color .12s, color .12s;
}
.btn:hover { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
.btn.on { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
.btn.icon { padding: 5px 8px; }

/* 打开文件的下拉：专注模式下最主要的切换入口 */
.menu-wrap { position: relative; }
.menu {
  position: absolute; right: 0; top: calc(100% + 6px);
  min-width: 340px; max-width: 520px;
  background: var(--bg); border: 1px solid var(--border);
  border-radius: var(--radius); box-shadow: var(--shadow);
  padding: 6px; z-index: 60;
  max-height: 70vh; overflow: auto;
}
.menu.hidden { display: none; }
.menu .menu-title {
  font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
  color: var(--fg-faint); padding: 6px 8px 4px;
}
.menu .menu-item {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px; border-radius: 6px; cursor: pointer;
  color: var(--fg); font-size: 13.5px; text-decoration: none;
}
.menu .menu-item:hover { background: var(--bg-sink); }
.menu .menu-item .mi-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.menu .menu-item .mi-path {
  margin-left: auto; font-size: 11px; color: var(--fg-faint);
  max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl;
}
.menu .menu-item.current { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.menu .menu-sep { height: 1px; background: var(--border); margin: 5px 4px; }
.menu .menu-empty { padding: 8px; font-size: 12.5px; color: var(--fg-faint); }
.searchbox { position: relative; }
.searchbox input {
  width: 190px; padding: 5px 10px; font-size: 13px;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg); color: var(--fg); outline: none;
}
.searchbox input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }

.body { display: flex; flex: 1 1 auto; min-height: 0; }
.sidebar {
  width: 288px; flex: 0 0 auto;
  border-right: 1px solid var(--border);
  background: var(--bg-soft);
  display: flex; flex-direction: column; min-height: 0;
  transition: margin-left .18s ease, opacity .18s ease;
}
.sidebar.hidden { margin-left: -288px; opacity: 0; pointer-events: none; }
.side-head {
  padding: 8px 10px; font-size: 12px; text-transform: uppercase;
  letter-spacing: .08em; color: var(--fg-faint);
  display: flex; justify-content: space-between; align-items: center;
  border-bottom: 1px solid var(--border);
}
/* 侧栏顶部的「最近打开」，专治"切走以后找不回来" */
.side-recents { border-bottom: 1px solid var(--border); padding: 4px 6px 8px; flex: 0 0 auto; max-height: 42%; overflow: auto; }
.side-recents:empty { display: none; }
.side-recents .sr-title {
  font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
  color: var(--fg-faint); padding: 6px 6px 4px;
}
.side-recents .sr-item {
  display: flex; align-items: center; gap: 6px;
  padding: 3px 6px; border-radius: 6px; cursor: pointer;
  color: var(--fg-soft); text-decoration: none; font-size: 13px;
}
.side-recents .sr-item:hover { background: var(--bg-sink); color: var(--fg); }
.side-recents .sr-item.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.side-recents .sr-item .sr-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side-recents .sr-item .sr-dir { margin-left: auto; font-size: 11px; color: var(--fg-faint); max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; }
.tree { overflow: auto; padding: 6px 4px 18px; flex: 1 1 auto; font-size: 13.5px; }.tree ul { list-style: none; margin: 0; padding-left: 12px; }
.tree > ul { padding-left: 4px; }
.tree li { margin: 1px 0; }
.tree .row {
  display: flex; align-items: center; gap: 6px;
  padding: 3px 6px; border-radius: 6px; cursor: pointer;
  color: var(--fg-soft); text-decoration: none; overflow: hidden;
}
.tree .row:hover { background: var(--bg-sink); color: var(--fg); }
.tree .row.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.tree .row .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree .row .badge { margin-left: auto; font-size: 11px; color: var(--fg-faint); }
.tree .row .chev { width: 12px; text-align: center; color: var(--fg-faint); font-size: 10px; }
.tree .dir > .row { font-weight: 600; color: var(--fg); }
.tree .empty { color: var(--fg-faint); padding: 6px 10px; font-size: 12.5px; }
.side-foot {
  border-top: 1px solid var(--border); padding: 7px 10px;
  font-size: 11.5px; color: var(--fg-faint);
  display: flex; justify-content: space-between; gap: 8px;
}

/* -------------------------------------------------------------- content */
.main { flex: 1 1 auto; min-width: 0; overflow: auto; scroll-behavior: smooth; }
.doc-wrap { display: flex; justify-content: center; align-items: flex-start; }
.doc {
  max-width: 900px; width: 100%; padding: 40px 48px 120px;
  min-width: 0;
}
.toc {
  position: sticky; top: 0; width: 240px; flex: 0 0 auto;
  padding: 40px 16px 60px 0; font-size: 13px;
  max-height: 100vh; overflow: auto;
}
.toc.hidden { display: none; }
.toc .toc-title { font-size: 11.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--fg-faint); margin-bottom: 8px; }
.toc a {
  display: block; padding: 2px 8px; border-left: 2px solid var(--border);
  color: var(--fg-soft); text-decoration: none;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.toc a:hover { color: var(--accent); border-left-color: var(--accent); }
.toc a.active { color: var(--accent); border-left-color: var(--accent); font-weight: 600; }
.toc .lvl-1 { padding-left: 8px; font-weight: 600; }
.toc .lvl-2 { padding-left: 18px; }
.toc .lvl-3 { padding-left: 30px; }
.toc .lvl-4, .toc .lvl-5, .toc .lvl-6 { padding-left: 42px; color: var(--fg-faint); }

.doc h1, .doc h2, .doc h3, .doc h4, .doc h5, .doc h6 {
  line-height: 1.3; margin: 1.6em 0 .6em; font-weight: 680; position: relative;
  scroll-margin-top: 72px;
}
.doc h1 { font-size: 2em; margin-top: .2em; padding-bottom: .3em; border-bottom: 1px solid var(--border); }
.doc h2 { font-size: 1.5em; padding-bottom: .25em; border-bottom: 1px solid var(--border); }
.doc h3 { font-size: 1.22em; }
.doc h4 { font-size: 1.05em; }
.doc h5, .doc h6 { font-size: 1em; color: var(--fg-soft); }
.doc .md-anchor-link {
  position: absolute; left: -0.85em; width: .85em;
  color: var(--fg-faint); text-decoration: none; opacity: 0; font-weight: 400;
}
.doc .md-h:hover .md-anchor-link { opacity: 1; }
.doc p { margin: .8em 0; }
.doc a.md-a { color: var(--accent); text-decoration: none; border-bottom: 1px solid transparent; }
.doc a.md-a:hover { border-bottom-color: var(--accent); }
.doc a.md-ext::after { content: "↗"; font-size: .8em; margin-left: 2px; opacity: .7; }
.doc a.md-file::after { content: "📎"; font-size: .85em; margin-left: 3px; opacity: .8; }
.doc ul.md-ul, .doc ol.md-ol { margin: .7em 0; padding-left: 1.6em; }
.doc li { margin: .28em 0; }
.doc li.md-task { list-style: none; margin-left: -1.35em; }
.doc li.md-task input { margin-right: 6px; vertical-align: middle; }
.doc li.md-task-done { color: var(--fg-faint); text-decoration: line-through; }
.doc blockquote.md-quote {
  margin: 1em 0; padding: .3em 1.1em; color: var(--fg-soft);
  border-left: 4px solid var(--border); background: var(--bg-soft);
  border-radius: 0 8px 8px 0;
}
.doc blockquote.md-quote p { margin: .5em 0; }
.doc hr.md-hr { border: none; border-top: 1px solid var(--border); margin: 2em 0; }
.doc mark { background: rgba(255, 214, 0, .35); color: inherit; padding: 0 2px; border-radius: 3px; }
.doc del { color: var(--fg-faint); }
.doc .md-broken { color: #b42318; background: rgba(180, 35, 24, .08); padding: 1px 6px; border-radius: 5px; font-size: .92em; }

.md-img { max-width: 100%; height: auto; border-radius: 8px; display: block; margin: 1em 0; }
.md-img.broken { display: none; }

.md-code-inline {
  font-family: "Cascadia Code", Consolas, "JetBrains Mono", "Courier New", monospace;
  font-size: .88em; background: var(--code-bg);
  border: 1px solid var(--border); border-radius: 5px;
  padding: .12em .38em; word-break: break-word;
}
.md-pre-wrap { position: relative; margin: 1.1em 0; }
.md-pre-wrap .md-copy {
  position: absolute; top: 7px; right: 7px;
  border: 1px solid var(--border); background: var(--bg);
  color: var(--fg-soft); font-size: 11.5px; padding: 2px 8px;
  border-radius: 6px; cursor: pointer; opacity: 0; transition: opacity .12s;
}
.md-pre-wrap:hover .md-copy { opacity: 1; }
.md-pre-wrap .md-copy:hover { color: var(--accent); border-color: var(--accent); }
.md-pre-wrap .md-lang {
  position: absolute; top: 7px; left: 12px; font-size: 11px;
  color: var(--fg-faint); text-transform: lowercase; letter-spacing: .04em;
  pointer-events: none;
}
.md-pre {
  background: var(--code-bg); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 14px 16px; overflow: auto;
  margin: 0; font-size: 13.5px; line-height: 1.6;
}
.md-pre code {
  font-family: "Cascadia Code", Consolas, "JetBrains Mono", "Courier New", monospace;
  background: none; border: none; padding: 0; white-space: pre;
}
.md-pre-literal { border-style: dashed; }

.md-table-wrap { overflow-x: auto; margin: 1.1em 0; }
.md-table { border-collapse: collapse; width: 100%; font-size: .94em; }
.md-table th, .md-table td { border: 1px solid var(--border); padding: 7px 11px; text-align: left; vertical-align: top; }
.md-table th { background: var(--bg-soft); font-weight: 650; }
.md-table tr:nth-child(even) td { background: color-mix(in srgb, var(--bg-soft) 55%, transparent); }

/* highlight tokens */
.hl-kw { color: #a626a4; font-weight: 600; }
.hl-str { color: #2f7d31; }
.hl-com { color: var(--fg-faint); font-style: italic; }
.hl-num { color: #b76b00; }
.hl-fn { color: #1a73c4; }
html[data-theme="dark"] .hl-kw { color: #d2a8ff; }
html[data-theme="dark"] .hl-str { color: #8ddb8c; }
html[data-theme="dark"] .hl-num { color: #ffb86c; }
html[data-theme="dark"] .hl-fn { color: #79c0ff; }

/* source mode */
.source {
  font-family: "Cascadia Code", Consolas, monospace; font-size: 13.5px;
  white-space: pre-wrap; word-break: break-word;
  background: var(--code-bg); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 16px; margin: 0;
}

/* loading / error / welcome */
.state { padding: 80px 24px; text-align: center; color: var(--fg-faint); }
.state h2 { color: var(--fg); }
.state .big { font-size: 40px; margin-bottom: 8px; }
.welcome { max-width: 700px; margin: 0 auto; padding: 60px 32px; }
.welcome .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin: 22px 0; }
.welcome .card {
  border: 1px solid var(--border); border-radius: var(--radius);
  padding: 14px 16px; background: var(--bg-soft);
}
.welcome .card h3 { margin: 0 0 6px; font-size: 15px; }
.welcome .card p { margin: 0; font-size: 13px; color: var(--fg-soft); }
kbd {
  border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 5px;
  padding: 1px 6px; font-size: 12px; background: var(--bg-soft);
  font-family: inherit;
}
.splash { max-width: 640px; margin: 80px auto; }

@media (max-width: 1100px) { .toc { display: none; } }
@media (max-width: 760px) {
  .sidebar { position: absolute; z-index: 30; height: 100%; box-shadow: var(--shadow); }
  .doc { padding: 24px 18px 90px; }
  .crumb { display: none; }
}

@media print {
  .topbar, .sidebar, .toc, .md-copy { display: none !important; }
  .main { overflow: visible; }
  .doc { max-width: none; padding: 0; }
  .md-pre, .md-table-wrap { break-inside: avoid; }
}
`;

/* --------------------------------------------------------------- client */

const CLIENT_JS = String.raw`
(function () {
  'use strict';
  var BOOT = window.__MDVIEW_BOOT__ || {};
  var $ = function (id) { return document.getElementById(id); };
  var el = {
    crumb: $('crumb'), tree: $('tree'), doc: $('doc'), toc: $('toc'), main: $('main'),
    sidebar: $('sidebar'), search: $('search'), theme: $('btn-theme'),
    source: $('btn-source'), tocBtn: $('btn-toc'), footPath: $('foot-path'),
    footInfo: $('foot-info'), treeRootLabel: $('tree-root-label'),
    sideBtn: $('btn-side'), openBtn: $('btn-open'), menuOpen: $('menu-open'),
    menuWrap: document.querySelector('.menu-wrap'), sideRecents: $('side-recents'),
  };

  var state = {
    file: BOOT.file || null,
    dir: BOOT.dir || null,
    roots: BOOT.roots || [],
    source: false,
    showToc: false,
    focus: true,
    recent: null,
    raw: '',
    parsed: null,
    treeDir: null,
    scrollMemory: {},
  };

  /* --------------------------------------------------------------- api */
  function api(url) {
    return fetch(url, { headers: { 'Accept': 'application/json', 'X-Mdview': '1' } }).then(function (r) {
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          throw new Error(j.error || ('HTTP ' + r.status));
        });
      }
      return r.json();
    });
  }

  /* ------------------------------------------------------------- theme */
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    el.theme.textContent = t === 'dark' ? '☀️' : '🌙';
    try { localStorage.setItem('mdview.theme', t); } catch (e) { /* private mode */ }
  }
  var savedTheme = null;
  try { savedTheme = localStorage.getItem('mdview.theme'); } catch (e) { /* ignore */ }
  if (!savedTheme) {
    savedTheme = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  applyTheme(savedTheme);

  /* -------------------------------------------------------------- misc */
  function baseName(p) {
    if (!p) return '';
    var parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/);
    return parts[parts.length - 1] || p;
  }
  function dirName(p) {
    if (!p) return '';
    var s = String(p).replace(/[\\/]+$/, '');
    var idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return idx > 0 ? s.slice(0, idx) : '';
  }
  function fmtSize(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  /* ------------------------------------------------------------ crumb */
  function renderCrumb(file) {
    el.crumb.innerHTML = '';
    if (!file) {
      var s = document.createElement('span');
      s.textContent = '未打开文件 · 点击「打开…」或双击任意 .md';
      el.crumb.appendChild(s);
      return;
    }
    var parts = String(file).replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
    parts.forEach(function (p, i) {
      if (i) {
        var sep = document.createElement('span');
        sep.className = 'sep'; sep.textContent = '›';
        el.crumb.appendChild(sep);
      }
      var seg = document.createElement('span');
      seg.className = 'seg';
      if (i === parts.length - 1) {
        var b = document.createElement('b');
        b.textContent = p;
        seg.appendChild(b);
      } else {
        seg.textContent = p;
      }
      seg.title = parts.slice(0, i + 1).join('/');
      el.crumb.appendChild(seg);
    });
    el.footPath.textContent = file;
    el.footPath.title = file;
  }

  /* --------------------------------------------------------------- tree */
  function buildTreeEntries(entries) {
    var root = { name: '', dirs: {}, files: [] };
    entries.forEach(function (e) {
      var parts = String(e.path).split(/[\\/]/);
      var node = root;
      for (var i = 0; i < parts.length - 1; i++) {
        var key = parts[i];
        if (!node.dirs[key]) node.dirs[key] = { name: key, dirs: {}, files: [] };
        node = node.dirs[key];
      }
      node.files.push({ name: parts[parts.length - 1], path: e.path, size: e.size });
    });
    return root;
  }

  function renderNode(node, isRoot) {
    var ul = document.createElement('ul');
    if (!isRoot) ul.style.display = 'none';

    Object.keys(node.dirs).sort(function (a, b) {
      return a.localeCompare(b, 'zh-Hans-CN');
    }).forEach(function (key) {
      var child = node.dirs[key];
      var li = document.createElement('li');
      li.className = 'dir';
      var row = document.createElement('div');
      row.className = 'row';
      var chev = document.createElement('span');
      chev.className = 'chev'; chev.textContent = isRoot ? '▾' : '▸';
      var name = document.createElement('span');
      name.className = 'name'; name.textContent = key;
      row.appendChild(chev); row.appendChild(name);
      li.appendChild(row);
      var sub = renderNode(child, false);
      li.appendChild(sub);
      row.addEventListener('click', function () {
        var open = sub.style.display !== 'none';
        sub.style.display = open ? 'none' : 'block';
        chev.textContent = open ? '▸' : '▾';
      });
      ul.appendChild(li);
    });

    node.files.sort(function (a, b) {
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    }).forEach(function (f) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.className = 'row';
      a.href = '/view?f=' + encodeURIComponent(f.path);
      a.dataset.path = f.path;
      var icon = document.createElement('span');
      icon.className = 'chev'; icon.textContent = '📄';
      var name = document.createElement('span');
      name.className = 'name'; name.textContent = f.name; name.title = f.path;
      var badge = document.createElement('span');
      badge.className = 'badge'; badge.textContent = fmtSize(f.size);
      a.appendChild(icon); a.appendChild(name); a.appendChild(badge);
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        navigate(f.path);
      });
      li.appendChild(a);
      ul.appendChild(li);
    });

    return ul;
  }

  function renderTree(entries, rootDir) {
    el.tree.innerHTML = '';
    el.treeRootLabel.textContent = rootDir ? baseName(rootDir) : '';
    if (!entries || !entries.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '这个目录下没有找到 Markdown 文件。';
      el.tree.appendChild(empty);
      return;
    }
    el.tree.appendChild(renderNode(buildTreeEntries(entries), true));
  }

  function expandAncestors(node) {
    var parent = node.parentElement;
    while (parent && parent !== el.tree) {
      if (parent.tagName === 'UL' && parent.style.display === 'none') {
        parent.style.display = 'block';
        var li = parent.parentElement;
        var row = li && li.firstElementChild;
        var chev = row && row.querySelector ? row.querySelector('.chev') : null;
        if (chev) chev.textContent = '▾';
      }
      parent = parent.parentElement;
    }
  }

  function highlightActive() {
    var links = el.tree.querySelectorAll('a.row');
    for (var i = 0; i < links.length; i++) {
      var p = links[i].dataset.path;
      var on = !!(p && state.file && p.toLowerCase() === state.file.toLowerCase());
      links[i].classList.toggle('active', on);
      if (on) {
        expandAncestors(links[i]);
        if (links[i].scrollIntoView) {
          links[i].scrollIntoView({ block: 'nearest' });
        }
      }
    }
  }

  function filterTree(q) {
    var query = String(q || '').trim().toLowerCase();
    var files = el.tree.querySelectorAll('li:not(.dir)');
    var dirs = el.tree.querySelectorAll('li.dir');
    if (!query) {
      for (var i = 0; i < files.length; i++) files[i].style.display = '';
      for (var j = 0; j < dirs.length; j++) dirs[j].style.display = '';
      return;
    }
    for (var k = 0; k < files.length; k++) {
      var nameEl = files[k].querySelector('.name');
      var hit = nameEl && nameEl.textContent.toLowerCase().indexOf(query) >= 0;
      files[k].style.display = hit ? '' : 'none';
    }
    for (var d = 0; d < dirs.length; d++) {
      var kids = dirs[d].querySelectorAll('li:not(.dir)');
      var any = false;
      for (var v = 0; v < kids.length; v++) {
        if (kids[v].style.display !== 'none') { any = true; break; }
      }
      dirs[d].style.display = any ? '' : 'none';
    }
  }

  var treeLoadedFor = null;
  function loadTree(dir, force) {
    if (!dir) return;
    if (!force && treeLoadedFor === dir) { highlightActive(); return; }
    api('/api/tree?dir=' + encodeURIComponent(dir))
      .then(function (data) {
        treeLoadedFor = dir;
        renderTree(data.entries, data.dir);
        highlightActive();
        if (el.search.value) filterTree(el.search.value);
        // 目录太大时服务端会截断（条目数 / 目录项 / 时间任一到顶）。
        // 不提示的话，用户会以为"这个目录里只有这些文件"。
        if (data.truncated) {
          var note = document.createElement('div');
          note.className = 'empty tree-truncated';
          note.textContent = '目录太大，只列出了前一部分（' + (data.count || 0) + ' 个文件）';
          el.tree.insertBefore(note, el.tree.firstChild);
        }
      })
      .catch(function (err) {
        el.tree.innerHTML = '';
        var d = document.createElement('div');
        d.className = 'empty';
        d.textContent = '目录读取失败：' + err.message;
        el.tree.appendChild(d);
      });
  }

  /* ---------------------------------------------------------------- toc */
  var tocObserver = null;
  function renderToc(headings) {
    el.toc.innerHTML = '';
    if (tocObserver) { tocObserver.disconnect(); tocObserver = null; }
    if (!headings || !headings.length) { el.toc.classList.add('hidden'); return; }
    var title = document.createElement('div');
    title.className = 'toc-title'; title.textContent = '大纲';
    el.toc.appendChild(title);
    headings.forEach(function (h) {
      var a = document.createElement('a');
      a.href = '#' + h.id;
      a.className = 'lvl-' + h.level;
      a.textContent = h.text;
      a.title = h.text;
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        var target = document.getElementById(h.id);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        history.replaceState(null, '', '#' + h.id);
      });
      el.toc.appendChild(a);
    });
    if ('IntersectionObserver' in window) {
      var map = {};
      Array.prototype.forEach.call(el.toc.querySelectorAll('a'), function (a) {
        map[a.getAttribute('href')] = a;
      });
      tocObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          var active = map['#' + e.target.id];
          if (!active) return;
          Array.prototype.forEach.call(el.toc.querySelectorAll('a'), function (x) {
            x.classList.remove('active');
          });
          active.classList.add('active');
        });
      }, { rootMargin: '-72px 0px -75% 0px', threshold: 0 });
      Array.prototype.forEach.call(el.doc.querySelectorAll('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]'), function (h) {
        tocObserver.observe(h);
      });
    }
  }

  /* ---------------------------------------------------------- rendering */
  function setState(kind, message, detail) {
    el.doc.innerHTML = '';
    var box = document.createElement('div');
    box.className = 'state';
    var big = document.createElement('div');
    big.className = 'big';
    big.textContent = kind === 'error' ? '⚠️' : kind === 'loading' ? '⏳' : '📖';
    var h = document.createElement('h2');
    h.textContent = message;
    box.appendChild(big); box.appendChild(h);
    if (detail) {
      var p = document.createElement('p');
      p.textContent = detail;
      box.appendChild(p);
    }
    el.doc.appendChild(box);
  }

  function renderWelcome() {
    el.doc.innerHTML =
      '<div class="welcome">' +
      '<h1>mdview</h1>' +
      '<p>本机 Markdown 查看器。零依赖、零联网、只监听 127.0.0.1。</p>' +
      '<div class="cards">' +
      '<div class="card"><h3>双击打开</h3><p>任意 <code>.md</code> 文件在资源管理器里双击即可用本查看器打开。</p></div>' +
      '<div class="card"><h3>浏览整个目录</h3><p>点击右上角「打开…」，左侧目录树会列出该目录下所有 Markdown 文件。</p></div>' +
      '<div class="card"><h3>本地链接可跳转</h3><p>文档之间的相对链接、图片、锚点都能直接点开。</p></div>' +
      '</div>' +
      '<h2>快捷键</h2>' +
      '<p><kbd>Ctrl</kbd>+<kbd>E</kbd> 源码/预览 · <kbd>Ctrl</kbd>+<kbd>B</kbd> 侧栏 · ' +
      '<kbd>Ctrl</kbd>+<kbd>T</kbd> 大纲 · <kbd>Ctrl</kbd>+<kbd>D</kbd> 主题 · ' +
      '<kbd>Ctrl</kbd>+<kbd>F</kbd> 筛选 · <kbd>Ctrl</kbd>+<kbd>P</kbd> 打印/导出 PDF</p>' +
      '</div>';
    el.toc.classList.add('hidden');
  }

  function flash(node, text) {
    var tip = document.createElement('span');
    tip.className = 'md-broken';
    tip.style.marginLeft = '6px';
    tip.textContent = text;
    node.parentNode.insertBefore(tip, node.nextSibling);
    setTimeout(function () { if (tip.parentNode) tip.remove(); }, 2400);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy') ? resolve() : reject(new Error('copy failed')); }
      catch (e) { reject(e); }
      finally { ta.remove(); }
    });
  }

  function render() {
    var raw = state.raw;
    if (state.source) {
      el.doc.innerHTML = '';
      var pre = document.createElement('pre');
      pre.className = 'source';
      pre.textContent = raw;
      el.doc.appendChild(pre);
      return;
    }
    var dir = dirName(state.file || state.dir || '');
    var out = window.mdview.parse(raw, { dir: dir });
    state.parsed = out;
    el.doc.innerHTML = out.html;
    renderToc(out.headings);
    if (state.showToc) el.toc.classList.remove('hidden');

    Array.prototype.forEach.call(el.doc.querySelectorAll('img.md-img'), function (img) {
      img.addEventListener('error', function () {
        if (img.dataset.warned) return;
        img.dataset.warned = '1';
        img.classList.add('broken');
        var note = document.createElement('span');
        note.className = 'md-broken';
        note.textContent = '图片找不到：' + (img.dataset.path || img.getAttribute('src'));
        img.parentNode.insertBefore(note, img);
      });
    });

    Array.prototype.forEach.call(el.doc.querySelectorAll('button.md-copy'), function (btn) {
      btn.addEventListener('click', function () {
        var pre = btn.parentNode.querySelector('code');
        copyText(pre ? pre.textContent : '').then(function () {
          btn.textContent = '已复制';
          setTimeout(function () { btn.textContent = '复制'; }, 1200);
        }).catch(function () { btn.textContent = '复制失败'; });
      });
    });

    Array.prototype.forEach.call(el.doc.querySelectorAll('a.md-a'), function (a) {
      var href = a.getAttribute('href') || '';
      if (a.classList.contains('md-anchor')) {
        a.addEventListener('click', function (ev) {
          ev.preventDefault();
          var t = document.getElementById(href.slice(1));
          if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      } else if (a.classList.contains('md-file')) {
        a.addEventListener('click', function (ev) {
          ev.preventDefault();
          // from=link 让服务端知道这是"文档里的链接"而不是用户主动打开：
          // 指向文件夹时不要扩白名单。
          api('/api/open?f=' + encodeURIComponent(a.dataset.abs) + '&from=link')
            .then(function (res) {
              if (res && res.opened === false) flash(a, '系统没有打开它');
              else flash(a, '已交给系统默认程序');
            })
            .catch(function (err) { flash(a, '打开失败：' + err.message); });
        });
      } else if (a.classList.contains('md-local')) {
        a.addEventListener('click', function (ev) {
          if (ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
          ev.preventDefault();
          var hash = href.indexOf('#') >= 0 ? href.slice(href.indexOf('#')) : '';
          navigate(a.dataset.md, hash);
        });
      }
    });
  }

  /* ---------------------------------------------------------- navigation */
  function rememberScroll() {
    if (state.file) state.scrollMemory[state.file] = el.main.scrollTop;
  }

  function navigate(file, hash, push) {
    rememberScroll();
    loadFile(file, hash);
    if (push !== false) {
      history.pushState({ f: file }, '', '/view?f=' + encodeURIComponent(file) + (hash || ''));
    }
  }

  function loadFile(file, hash) {
    setState('loading', '正在加载…', file);
    el.footInfo.textContent = '加载中…';
    api('/api/file?f=' + encodeURIComponent(file))
      .then(function (data) {
        state.file = data.path;
        state.dir = data.dir;
        state.raw = data.content;
        renderCrumb(data.path);
        el.footInfo.textContent = fmtSize(data.size) + (data.encoding !== 'utf8' ? ' · ' + data.encoding : '');
        document.title = baseName(data.path) + ' — mdview';
        state.source = false;
        el.source.classList.remove('on');
        el.source.textContent = '源码';
        render();
        loadTree(data.dir);
        highlightActive();
        loadRecents().then(renderSideRecents);
        var target = hash && hash.length > 1 ? document.getElementById(hash.slice(1)) : null;
        if (target) target.scrollIntoView({ block: 'start' });
        else if (state.scrollMemory[data.path]) el.main.scrollTop = state.scrollMemory[data.path];
        else el.main.scrollTop = 0;
      })
      .catch(function (err) {
        setState('error', '打不开这个文件', err.message);
        el.footInfo.textContent = '错误';
      });
  }

  /* --------------------------------------------------------------- open */
  function openDialog() {
    var v = window.prompt('输入 Markdown 文件或文件夹的完整路径：', state.file || state.dir || '');
    if (!v) return;
    openPath(v);
  }

  /** Open a path the user typed or picked; dirs become the new tree root. */
  function openPath(raw) {
    var p = String(raw).trim().replace(/^"|"$/g, '');
    if (!p) return;
    return api('/api/open?f=' + encodeURIComponent(p))
      .then(function (res) {
        if (res.kind === 'dir') {
          state.dir = res.path;
          loadTree(res.path, true);
          loadRecents();
          if (!state.file) renderWelcome();
        } else {
          state.recent = null; // force a refresh with the new entry
          if (typeof res.path === 'string') {
            state.dir = dirName(res.path);
            loadTree(state.dir, true);
          }
          navigate(res.path);
          loadRecents();
        }
        return res;
      })
      .catch(function (err) { window.alert('打开失败：' + err.message); });
  }

  /* ------------------------------------------------------------- recents */
  function loadRecents() {
    return api('/api/recents')
      .then(function (data) { state.recent = data.recents || []; return state.recent; })
      .catch(function () { state.recent = []; return []; });
  }

  function recentEntry(e) {
    var path = e.path;
    var name = baseName(path);
    var item = document.createElement('a');
    item.className = 'menu-item' + (state.file && normEq(path, state.file) ? ' current' : '');
    item.href = e.kind === 'dir' ? ('/?dir=' + encodeURIComponent(path)) : ('/view?f=' + encodeURIComponent(path));
    var icon = document.createElement('span');
    icon.textContent = e.kind === 'dir' ? '📁' : '📄';
    var label = document.createElement('span');
    label.className = 'mi-name'; label.textContent = name;
    var where = document.createElement('span');
    where.className = 'mi-path'; where.textContent = dirName(path); where.title = path;
    item.appendChild(icon); item.appendChild(label); item.appendChild(where);
    item.addEventListener('click', function (ev) {
      ev.preventDefault();
      closeMenu();
      if (e.kind === 'dir') openPath(path);
      else navigate(path);
    });
    return item;
  }

  function normEq(a, b) {
    return String(a).replace(/\//g, '\\').toLowerCase() === String(b).replace(/\//g, '\\').toLowerCase();
  }

  /** 侧栏顶部的「最近打开」列表。 */
  function renderSideRecents() {
    var box = el.sideRecents;
    box.innerHTML = '';
    var list = state.recent || [];
    if (!list.length) return;

    var title = document.createElement('div');
    title.className = 'sr-title'; title.textContent = '最近打开';
    box.appendChild(title);

    list.slice(0, 8).forEach(function (e) {
      var item = document.createElement('a');
      var active = e.kind !== 'dir' && state.file && normEq(e.path, state.file);
      item.className = 'sr-item' + (active ? ' active' : '');
      item.href = e.kind === 'dir' ? ('/?dir=' + encodeURIComponent(e.path)) : ('/view?f=' + encodeURIComponent(e.path));
      item.title = e.path;

      var icon = document.createElement('span');
      icon.textContent = e.kind === 'dir' ? '📁' : '📄';
      var name = document.createElement('span');
      name.className = 'sr-name'; name.textContent = baseName(e.path);
      var dir = document.createElement('span');
      dir.className = 'sr-dir'; dir.textContent = dirName(e.path) || '/';

      item.appendChild(icon); item.appendChild(name); item.appendChild(dir);
      item.addEventListener('click', function (ev) {
        ev.preventDefault();
        if (e.kind === 'dir') openPath(e.path);
        else navigate(e.path);
      });
      box.appendChild(item);
    });
  }

  function buildOpenMenu() {
    var menu = el.menuOpen;
    menu.innerHTML = '';

    var mk = function (text, handler) {
      var item = document.createElement('div');
      item.className = 'menu-item';
      var label = document.createElement('span');
      label.className = 'mi-name'; label.textContent = text;
      item.appendChild(label);
      item.addEventListener('click', function () { closeMenu(); handler(); });
      return item;
    };

    menu.appendChild(mk('📄 打开文件…', openDialog));
    menu.appendChild(mk('📁 打开文件夹…', openDialog));

    var list = state.recent || [];
    if (list.length) {
      var sep = document.createElement('div');
      sep.className = 'menu-sep';
      menu.appendChild(sep);
      var title = document.createElement('div');
      title.className = 'menu-title'; title.textContent = '最近打开';
      menu.appendChild(title);
      list.slice(0, 15).forEach(function (e) { menu.appendChild(recentEntry(e)); });
    } else {
      var empty = document.createElement('div');
      empty.className = 'menu-empty';
      empty.textContent = '还没有记录。打开过的文件会出现在这里。';
      menu.appendChild(empty);
    }
  }

  function openMenu() {
    buildOpenMenu();
    el.menuOpen.classList.remove('hidden');
    el.openBtn.classList.add('on');
  }
  function closeMenu() {
    el.menuOpen.classList.add('hidden');
    el.openBtn.classList.remove('on');
  }
  function toggleMenu() {
    if (el.menuOpen.classList.contains('hidden')) {
      loadRecents().then(openMenu);
    } else {
      closeMenu();
    }
  }

  /* -------------------------------------------------------- focus mode */
  // 专注模式：默认不显示目录侧栏，只读当前打开的文件。侧栏仍可通过标题栏
  // 的 ☰ 或 Ctrl+B 唤出，选择会记住。
  function setFocus(on, persist) {
    state.focus = !!on;
    el.sidebar.classList.toggle('hidden', state.focus);
    el.sideBtn.classList.toggle('on', !state.focus);
    el.sideBtn.title = state.focus ? '显示目录侧栏 (Ctrl+B)' : '隐藏目录侧栏 (Ctrl+B)';
    if (persist !== false) {
      try { localStorage.setItem('mdview.focus', state.focus ? '1' : '0'); } catch (e) { /* ignore */ }
    }
  }

  /* ------------------------------------------------------------- events */
  el.sideBtn.addEventListener('click', function () { setFocus(!state.focus); });
  el.openBtn.addEventListener('click', function (ev) { ev.stopPropagation(); toggleMenu(); });
  document.addEventListener('click', function (ev) {
    if (el.menuOpen.classList.contains('hidden')) return;
    if (el.menuWrap.contains(ev.target)) return;
    closeMenu();
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && !el.menuOpen.classList.contains('hidden')) closeMenu();
  });
  el.theme.addEventListener('click', function () {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });
  el.source.addEventListener('click', function () {
    state.source = !state.source;
    el.source.classList.toggle('on', state.source);
    el.source.textContent = state.source ? '预览' : '源码';
    render();
  });
  el.tocBtn.addEventListener('click', function () {
    state.showToc = !state.showToc;
    el.toc.classList.toggle('hidden', !state.showToc);
    el.tocBtn.classList.toggle('on', state.showToc);
    try { localStorage.setItem('mdview.toc', state.showToc ? '1' : '0'); } catch (e) { /* ignore */ }
  });
  $('btn-reload').addEventListener('click', function () { if (state.file) loadFile(state.file); });
  el.search.addEventListener('input', debounce(function () { filterTree(el.search.value); }, 120));

  document.addEventListener('keydown', function (ev) {
    var mod = ev.ctrlKey || ev.metaKey;
    if (!mod) {
      if (ev.key === 'F5') { ev.preventDefault(); if (state.file) loadFile(state.file); }
      return;
    }
    var k = String(ev.key).toLowerCase();
    if (k === 'e') { ev.preventDefault(); el.source.click(); }
    else if (k === 'b') { ev.preventDefault(); setFocus(!state.focus); }
    else if (k === 't') { ev.preventDefault(); el.tocBtn.click(); }
    else if (k === 'd') { ev.preventDefault(); el.theme.click(); }
    else if (k === 'f') { ev.preventDefault(); el.search.focus(); el.search.select(); }
    else if (k === 'o') { ev.preventDefault(); el.openBtn.click(); }
    else if (k === 'r') { ev.preventDefault(); if (state.file) loadFile(state.file); }
  });

  window.addEventListener('beforeunload', rememberScroll);

  window.addEventListener('popstate', function () {
    var f = new URLSearchParams(location.search).get('f');
    if (f) loadFile(f, location.hash);
  });

  window.addEventListener('dragover', function (ev) { ev.preventDefault(); });
  window.addEventListener('drop', function (ev) {
    ev.preventDefault();
    var dt = ev.dataTransfer;
    if (!dt) return;
    if (dt.files && dt.files.length) {
      var f = dt.files[0];
      if (f.path) { navigate(f.path); return; }
      var reader = new FileReader();
      reader.onload = function () {
        state.file = f.name;
        state.raw = String(reader.result || '');
        renderCrumb(state.file);
        el.footInfo.textContent = fmtSize(state.raw.length) + ' · 拖入';
        document.title = f.name + ' — mdview';
        render();
      };
      reader.readAsText(f);
      return;
    }
    var text = dt.getData('text/plain');
    if (text) {
      state.raw = text;
      state.file = '(拖入的文本)';
      renderCrumb(null);
      render();
    }
  });

  /* ------------------------------------------------- tab lifetime / exit */
  // The server retires itself once no browser tab is left. Each page pings
  // while it lives, and signals its departure on unload. Tab ids are kept in
  // localStorage so a peer can tell whether any other tab is still open.
  var TAB_KEY = 'mdview.tabs';
  var myTabId = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8);

  function readTabs() {
    var now = Date.now();
    var list = [];
    try { list = JSON.parse(localStorage.getItem(TAB_KEY) || '[]'); } catch (e) { list = []; }
    if (!Array.isArray(list)) list = [];
    // drop entries whose owner died without a beacon
    return list.filter(function (t) { return t && t.id && (now - t.at) < 35000; });
  }
  function writeTabs(list) {
    try { localStorage.setItem(TAB_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
  }
  function announce() {
    var list = readTabs().filter(function (t) { return t.id !== myTabId; });
    list.push({ id: myTabId, at: Date.now() });
    writeTabs(list);
    return list;
  }
  function leave() {
    var list = readTabs().filter(function (t) { return t.id !== myTabId; });
    writeTabs(list);
    return list.length;
  }

  function startLifetime() {
    var count = announce().length;
    fetch('/api/keepalive?tabs=' + count, { cache: 'no-store', headers: { 'X-Mdview': '1' } })
      .catch(function () { /* server gone */ });
    setInterval(function () {
      var n = announce().length;
      fetch('/api/keepalive?tabs=' + n, { cache: 'no-store', headers: { 'X-Mdview': '1' } })
        .catch(function () { /* server gone */ });
    }, 12000);
  }

  function sendBye() {
    var remaining = leave();
    var payload = remaining === 0 ? 'last=1' : ('tabs=' + remaining);
    // 不能用 sendBeacon：它加不了自定义头，而 /api/bye 现在要求 X-Mdview。
    // fetch 的 keepalive 同样能在页面卸载时把请求发出去。
    try {
      fetch('/api/bye?' + payload, {
        method: 'POST', keepalive: true, cache: 'no-store',
        headers: { 'X-Mdview': '1' },
      }).catch(function () { /* ignore */ });
    } catch (e) { /* ignore */ }
  }

  /* -------------------------------------------------------------- start */
  try { state.showToc = localStorage.getItem('mdview.toc') === '1'; } catch (e) { /* ignore */ }
  if (state.showToc) { el.toc.classList.remove('hidden'); el.tocBtn.classList.add('on'); }

  // 选择模式：专注（默认，只读当前文件）还是带目录侧栏。
  var savedFocus = null;
  try { savedFocus = localStorage.getItem('mdview.focus'); } catch (e) { /* ignore */ }
  setFocus(savedFocus === null ? true : savedFocus === '1', false);

  startLifetime();
  window.addEventListener('pagehide', sendBye);
  window.addEventListener('beforeunload', sendBye);
  loadRecents().then(renderSideRecents);

  api('/api/session')
    .then(function (s) {
      window.mdview.setTokens({ asset: s.assetToken });
      if (state.file) {
        loadFile(state.file, location.hash);
        return;
      }
      renderWelcome();
      renderCrumb(null);
      if (state.dir) {
        loadTree(state.dir, true);
        api('/api/tree?dir=' + encodeURIComponent(state.dir)).then(function (data) {
          if (data.entries && data.entries.length) navigate(data.entries[0].path, '', false);
        }).catch(function () { /* tree error already shown */ });
        return;
      }
      api('/api/roots').then(function (r) {
        var first = (r.roots || [])[0];
        if (first) { state.dir = first; loadTree(first, true); }
      }).catch(function () { /* ignore */ });
    })
    .catch(function (err) {
      setState('error', '无法连接本地服务', err.message);
    });
})();
`;

/* --------------------------------------------------------------- 导出 -- */

/*
 * 渲染层导出（只增不改）。
 *
 * 这几个块本来就是纯前端代码（Markdown 解析、离线语法高亮、样式、页面逻辑），
 * 只是以内嵌字符串的形式放在这个文件里。把名字导出出去，别的项目就能直接复用
 * 同一份实现 —— 不用复制几千行，也不用担心两边行为漂移（例如想在同一套渲染上
 * 做一个编辑实验）。
 *
 * 这里不导出任何函数、不导出服务端逻辑，也不改变本文件的任何既有行为。
 */
export { HIGHLIGHT_JS, MD_CORE_JS, MD_CSS, CLIENT_JS };

/* --------------------------------------------------------- html shell */

function documentHtml({ file, dir, roots, version }) {
  const title = file ? path.basename(file) : 'mdview';
  const boot = JSON.stringify({
    file: file || null,
    dir: dir || null,
    roots: roots || [],
    version,
  }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${xmlEscape(title)} — mdview</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0b6bcb"/><path d="M14 46V18h7l7 12 7-12h7v28h-6V28l-8 13-8-13v18z" fill="#fff"/><path d="M46 18h6v28h-6z" fill="#fff" opacity=".85"/></svg>',
  )}">
<style>${MD_CSS}</style>
</head>
<body>
<div class="app">
  <header class="topbar">
    <button class="btn icon" id="btn-side" title="折叠/展开侧栏 (Ctrl+B)">☰</button>
    <div class="brand"><span class="dot"></span>mdview</div>
    <div class="crumb" id="crumb"></div>
    <div class="tools">
      <span class="searchbox"><input id="search" type="search" placeholder="在目录树中筛选…" autocomplete="off"></span>
      <span class="menu-wrap">
        <button class="btn" id="btn-open" title="最近打开 / 打开文件 / 打开文件夹">打开 ▾</button>
        <div class="menu hidden" id="menu-open"></div>
      </span>
      <button class="btn" id="btn-toc" title="大纲 (Ctrl+T)">大纲</button>
      <button class="btn" id="btn-source" title="源码 / 预览 (Ctrl+E)">源码</button>
      <button class="btn icon" id="btn-theme" title="切换主题 (Ctrl+D)">🌙</button>
      <button class="btn icon" id="btn-reload" title="重新加载 (F5 / Ctrl+R)">⟳</button>
    </div>
  </header>
  <div class="body">
    <aside class="sidebar" id="sidebar">
      <div class="side-head"><span>目录</span><span id="tree-root-label"></span></div>
      <div class="side-recents" id="side-recents"></div>
      <nav class="tree" id="tree"></nav>
      <div class="side-foot">
        <span id="foot-path" title="">—</span>
        <span id="foot-info"></span>
      </div>
    </aside>
    <main class="main" id="main">
      <div class="doc-wrap">
        <article class="doc" id="doc"></article>
        <aside class="toc hidden" id="toc"></aside>
      </div>
    </main>
  </div>
</div>
<script>window.__MDVIEW_BOOT__ = ${boot};</script>
<script>${HIGHLIGHT_JS}</script>
<script>${MD_CORE_JS}</script>
<script>${CLIENT_JS}</script>
</body>
</html>`;
}

/* -------------------------------------------------------------- server */

function createServer({ token, roots, initialFile, verbose }) {
  const allowedRoots = new Set(roots.map(norm));
  let assetToken = crypto.randomBytes(24).toString('base64url');
  let lastActivity = Date.now();

  // Live browser tabs. Each viewer page heartbeats while it is open and sends a
  // beacon when it unloads; the client's own tab count is authoritative, so a
  // tab that dies without a beacon still gets noticed via the heartbeat gap.
  let liveTabs = 1;
  let lastTabSeen = Date.now();
  const TAB_GRACE_MS = 45 * 1000; // heartbeat is 12s, so this is ~3 missed beats

  function touch() { lastActivity = Date.now(); }
  function idleFor() { return Date.now() - lastActivity; }

  function tabReport(count) {
    liveTabs = Number.isFinite(count) ? Math.max(0, count) : liveTabs;
    lastTabSeen = Date.now();
  }
  function noTabsFor() { return Date.now() - lastTabSeen; }
  function tabsGone() { liveTabs = 0; lastTabSeen = Date.now(); }

  /**
   * Whether the background server should retire now. Two independent reasons:
   * no browser tab has been around for a while, or nothing at all happened for
   * the full idle timeout. Kept here because all the state lives here.
   */
  function shouldRetire(idleMs) {
    if (liveTabs === 0 && noTabsFor() > TAB_GRACE_MS) {
      return 'no browser tab for ' + Math.round(noTabsFor() / 1000) + 's';
    }
    if (idleFor() > idleMs) return 'idle for ' + Math.round(idleFor() / 1000) + 's';
    return null;
  }

  function isAllowedTarget(p) {
    const abs = norm(p);
    for (const root of allowedRoots) {
      if (isInside(abs, root)) return true;
    }
    return false;
  }

  /**
   * 白名单的真实路径版本：先按字符串判断，再把 reparse point 解开重判。
   * 两个条件都满足才算允许，这样 junction 无法把白名单撑到目标目录之外。
   */
  function isAllowedTargetReal(p) {
    if (!isAllowedTarget(p)) return false;
    const abs = norm(realPathOf(p));
    for (const root of allowedRoots) {
      if (isInside(abs, norm(realPathOf(root)))) return true;
    }
    return false;
  }

  function allow(target) {
    const abs = norm(target);
    if (allowedRoots.has(abs)) return abs;
    for (const root of allowedRoots) if (isInside(abs, root)) return abs;
    allowedRoots.add(abs);
    return abs;
  }

  function json(res, code, body) {
    const data = JSON.stringify(body);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(data),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  }

  function fail(res, code, message) {
    json(res, code, { error: message });
  }

  /* ------------------------------------------------------------ recents -- */

  const RECENT_FILE = path.join(DATA_DIR, 'recent.json');
  const RECENT_MAX = 30;

  function readRecents() {
    try {
      const list = JSON.parse(fs.readFileSync(RECENT_FILE, 'utf8'));
      if (Array.isArray(list)) return list.filter((e) => e && typeof e.path === 'string');
    } catch { /* no history yet */ }
    return [];
  }

  function writeRecents(list) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = RECENT_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(list.slice(0, RECENT_MAX), null, 2));
      fs.renameSync(tmp, RECENT_FILE);
    } catch { /* history is best effort, never fatal */ }
  }

  /** Record an opened path, newest first, one entry per path. */
  function rememberRecent(target, kind) {
    const abs = norm(target);
    const list = readRecents().filter((e) => norm(e.path) !== abs);
    list.unshift({ path: abs, kind: kind || 'file', at: Date.now() });
    writeRecents(list);
    return list;
  }

  /** Drop entries whose file no longer exists, so the list cannot rot. */
  function pruneRecents(list) {
    const alive = list.filter((e) => {
      try { return fs.statSync(e.path).isFile() || fs.statSync(e.path).isDirectory(); } catch { return false; }
    });
    if (alive.length !== list.length) writeRecents(alive);
    return alive;
  }

  function assetAuthorized(req, url) {
    const t = url.searchParams.get('t') || '';
    if (t && t === assetToken) return true;
    const referer = req.headers.referer || '';
    if (referer && referer.indexOf(assetToken) >= 0) return true;
    return false;
  }

  async function listTree(dir) {
    const entries = [];
    const queue = [{ dir, depth: 0 }];
    let truncated = false;
    let visited = 0;
    const deadline = Date.now() + TREE_TIME_BUDGET_MS;
    while (queue.length) {
      if (Date.now() > deadline || visited >= MAX_TREE_VISITED) { truncated = true; break; }
      const cur = queue.shift();
      let items;
      try {
        items = await fsp.readdir(cur.dir, { withFileTypes: true });
      } catch { continue; }
      visited += items.length;
      items.sort((a, b) => a.name.localeCompare(b.name));
      for (const item of items) {
        if (entries.length >= MAX_TREE_ENTRIES) { truncated = true; break; }
        if (item.name.startsWith('.') && item.name !== '.') continue;
        const full = path.join(cur.dir, item.name);
        if (item.isDirectory()) {
          if (SKIP_DIRS.has(item.name)) continue;
          if (cur.depth < 6) queue.push({ dir: full, depth: cur.depth + 1 });
          continue;
        }
        if (!item.isFile() || !isMarkdown(full)) continue;
        let st = null;
        try { st = await fsp.stat(full); } catch { continue; }
        entries.push({ path: full, size: st.size, mtime: st.mtimeMs });
      }
      if (truncated) break;
    }
    return { entries, truncated };
  }

  /** Headers for the two HTML shells. Nothing here is optional hardening. */
  function pageHeaders(body) {
    return {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      // The page never needs to be framed, and never needs to be anyone's base
      // URL. Both are free to lock down and remove a class of tricks.
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data: http: https:; " +
        "style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; " +
        "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    };
  }

  const handler = async (req, res) => {
    // 只有页面自己发起的请求（带自定义头）才算"活动"；跨源页面既发不出这个头，
    // 也就无法靠轮询 /health 把空闲退出一直拖下去。
    if (req.headers[CLIENT_HEADER] === '1') touch();

    // Only accept requests actually addressed to the loopback interface.
    // A hostile page can point its own domain at 127.0.0.1 (DNS rebinding) and
    // keep its origin, but it still has to send its own Host header — which is
    // exactly what this check refuses.
    const hostHeader = String(req.headers.host || '').toLowerCase();
    // 缺少 Host 也拒绝：浏览器一定会带，放行只会给非浏览器客户端留口子。
    if (!hostHeader || !/^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(hostHeader)) {
      return fail(res, 403, 'forbidden host');
    }

    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      return fail(res, 400, 'bad request url');
    }
    const route = url.pathname;

    if (route === '/health') return json(res, 200, { ok: true, app: 'mdview', version: APP_VERSION, pid: process.pid, roots: [...allowedRoots], idleMs: idleFor(), liveTabs, noTabsMs: noTabsFor() });
    if (route === '/favicon.ico') { res.writeHead(204); return res.end(); }

    if (route === '/') {
      // `?dir=` picks the tree root when this server is reused for another
      // folder; it must already be inside the allow-list.
      const wanted = url.searchParams.get('dir');
      let dir = initialFile ? null : ([...allowedRoots][0] || null);
      if (wanted) {
        const decoded = decodeToken(wanted) || wanted;
        if (decoded && isAllowedTarget(decoded)) dir = norm(decoded);
      }
      const html = documentHtml({
        file: wanted ? null : (initialFile || null),
        dir,
        roots: [...allowedRoots],
        version: APP_VERSION,
      });
      res.writeHead(200, pageHeaders(html));
      return res.end(html);
    }

    if (route === '/view') {
      const f = url.searchParams.get('f');
      let target = null;
      if (f) {
        const decoded = decodeToken(f) || f;
        // Never widen the allow-list from a URL. The CLI adds the folder via
        // /api/open before it prints the link, so a real link passes this
        // check by the time it is opened — but a page that merely points at
        // /view?f=C:\... must not be able to make the server read that file.
        if (decoded && isAllowedTarget(decoded)) target = norm(decoded);
      }
      const html = documentHtml({
        file: target,
        dir: target ? null : ([...allowedRoots][0] || null),
        roots: [...allowedRoots],
        version: APP_VERSION,
      });
      res.writeHead(200, pageHeaders(html));
      return res.end(html);
    }

    if (route === '/api/session') {
      // 会改标签页计数（进而影响自动退出），属于状态变更：必须带自定义头。
      if (req.headers[CLIENT_HEADER] !== '1') return fail(res, 403, '缺少本地请求头');
      // A page just loaded. If a heartbeat or beacon from a dying tab lands
      // first, this repairs the count instead of letting it drift.
      if (noTabsFor() > TAB_GRACE_MS) liveTabs = 0;
      tabReport(Math.max(1, liveTabs));
      return json(res, 200, { assetToken, pid: process.pid, version: APP_VERSION, tabs: liveTabs });
    }

    // The page pings while it is open and reports how many mdview tabs it can
    // see (its own included). That number is authoritative.
    if (route === '/api/keepalive') {
      // 会改标签页计数，属于状态变更：和 /api/open 用同一道闸。
      if (req.headers[CLIENT_HEADER] !== '1') return fail(res, 403, '缺少本地请求头');
      const n = Number(url.searchParams.get('tabs'));
      tabReport(Number.isFinite(n) && n > 0 ? n : Math.max(1, liveTabs));
      return json(res, 200, { ok: true, tabs: liveTabs });
    }

    // A page is unloading; it already removed itself from the shared list and
    // tells us `last=1` when nothing is left.
    if (route === '/api/bye') {
      if (req.headers[CLIENT_HEADER] !== '1') return fail(res, 403, '缺少本地请求头');
      if (url.searchParams.get('last') === '1') tabsGone();
      else tabReport(Number(url.searchParams.get('tabs')));
      return json(res, 200, { ok: true, tabs: liveTabs });
    }

    if (route === '/api/roots') {
      return json(res, 200, { roots: [...allowedRoots] });
    }

    // Recently opened files/folders. Kept server-side so the list survives both
    // a page reload and a fresh server start. 只读：记录由服务端在读取/打开时
    // 自己写，页面没有"提交历史"的入口（少一个可以写状态的面）。
    if (route === '/api/recents') {
      if (req.method !== 'GET') return fail(res, 405, '只支持 GET');
      const list = pruneRecents(readRecents());
      return json(res, 200, { recents: list });
    }

    if (route === '/api/file') {
      const f = url.searchParams.get('f');
      const raw = f ? decodeToken(f) || f : null;
      if (!raw) return fail(res, 400, '缺少参数 f');
      if (!isAllowedTargetReal(raw)) return fail(res, 403, '该路径不在允许范围内');
      const abs = toNative(raw);
      let st;
      try { st = await fsp.stat(abs); } catch { return fail(res, 404, '文件不存在：' + abs); }
      if (!st.isFile()) return fail(res, 400, '不是文件：' + abs);
      if (st.size > MAX_TEXT_BYTES) return fail(res, 413, '文件过大（' + humanSize(st.size) + '）');
      const buf = await fsp.readFile(abs);
      const utf8 = buf.toString('utf8');
      let text = utf8;
      let encoding = 'utf8';
      if (utf8.indexOf('\uFFFD') >= 0) {
        try {
          const dec = new TextDecoder('gbk', { fatal: false });
          const gbk = dec.decode(buf);
          // GBK 也解不干净时保留 UTF-8 原文：至少不会比"直接当 UTF-8"更糟。
          // 比较替换字符个数，谁少用谁。
          if (gbk.split('\uFFFD').length <= utf8.split('\uFFFD').length) {
            text = gbk;
            encoding = 'gbk';
          }
        } catch { /* keep utf8 */ }
      }
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      // 只有本页发起（带自定义头）的读取才记"最近打开"。跨源页面发不出这个头，
      // 所以一个 GET 就不会再被外部页面拿来写历史。
      if (req.headers[CLIENT_HEADER] === '1') rememberRecent(abs, 'file');
      return json(res, 200, { path: abs, dir: path.dirname(abs), content: text, size: st.size, mtime: st.mtimeMs, encoding });
    }

    if (route === '/api/tree') {
      const d = url.searchParams.get('dir');
      const raw = d ? decodeToken(d) || d : null;
      if (!raw) return fail(res, 400, '缺少参数 dir');
      if (!isAllowedTargetReal(raw)) return fail(res, 403, '该路径不在允许范围内');
      const abs = toNative(raw);
      let st;
      try { st = await fsp.stat(abs); } catch { return fail(res, 404, '目录不存在：' + abs); }
      if (!st.isDirectory()) return fail(res, 400, '不是目录：' + abs);
      const out = await listTree(abs);
      return json(res, 200, { dir: abs, entries: out.entries, truncated: out.truncated, count: out.entries.length });
    }

    if (route === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      if (q.length < 2) return fail(res, 400, '查询至少 2 个字符');
      const results = [];
      const scanDirs = url.searchParams.get('dir')
        ? [decodeToken(url.searchParams.get('dir')) || url.searchParams.get('dir')]
        : [...allowedRoots];
      outer:
      for (const root of scanDirs) {
        if (!isAllowedTargetReal(root)) continue;
        const queue = [{ dir: root, depth: 0 }];
        while (queue.length) {
          const cur = queue.shift();
          let h;
          try { h = await fsp.opendir(cur.dir); } catch { continue; }
          for await (const item of h) {
            if (results.length >= 200) break outer;
            if (item.name.startsWith('.')) continue;
            const full = path.join(cur.dir, item.name);
            if (item.isDirectory()) {
              if (!SKIP_DIRS.has(item.name) && cur.depth < 6) queue.push({ dir: full, depth: cur.depth + 1 });
              continue;
            }
            if (!isMarkdown(full)) continue;
            // 根内可能有符号链接文件指向根外；读之前按真实路径再判一次。
            if (!isAllowedTargetReal(full)) continue;
            if (item.name.toLowerCase().indexOf(q) >= 0) {
              results.push({ path: full, name: item.name, hit: 'filename' });
              continue;
            }
            try {
              const st = await fsp.stat(full);
              if (st.size > 2 * 1024 * 1024) continue;
              const text = await fsp.readFile(full, 'utf8');
              const idx = text.toLowerCase().indexOf(q);
              if (idx >= 0) {
                const lineStart = text.lastIndexOf('\n', idx) + 1;
                const lineEnd = text.indexOf('\n', idx);
                const snippet = text.slice(Math.max(0, lineStart), lineEnd < 0 ? idx + 120 : lineEnd).trim().slice(0, 200);
                results.push({ path: full, name: item.name, hit: 'content', snippet });
              }
            } catch { /* skip unreadable */ }
          }
        }
      }
      return json(res, 200, { query: q, results });
    }

    if (route === '/api/open') {
      // This endpoint widens the allow-list and may hand a file to the OS, so
      // it is the one place a hostile page would want to reach. A custom
      // header forces a CORS preflight, which we never answer.
      if (req.headers[CLIENT_HEADER] !== '1') return fail(res, 403, '缺少本地请求头');
      const f = url.searchParams.get('f');
      const raw = f ? decodeToken(f) || f : null;
      if (!raw) return fail(res, 400, '缺少参数 f');
      const resolved = toNative(path.resolve(raw));
      let st;
      try { st = await fsp.stat(resolved); } catch { return fail(res, 404, '路径不存在：' + resolved); }
      if (st.isDirectory()) {
        // 页面里的链接也会走这个端点。如果一个普通链接点到文件夹就把该目录
        // 加进白名单，那"只读你打开过的范围"这个不变量就守不住了（可以是盘根）。
        // 所以只有用户主动"打开文件夹"（对话框/CLI）才扩白名单。
        const fromLink = url.searchParams.get('from') === 'link';
        if (fromLink) return fail(res, 400, '这是文件夹，请在目录树里打开');
        allow(resolved);
        rememberRecent(resolved, 'dir');
        return json(res, 200, { kind: 'dir', path: resolved });
      }
      if (!st.isFile()) return fail(res, 400, '既不是文件也不是目录：' + resolved);
      if (!isMarkdown(resolved)) {
        // 交给系统默认程序打开 = 交给对应的解析器执行。只允许白名单里的
        // 文档类/媒体类类型；.exe/.lnk/.bat/.hta 这类一律拒绝，否则一份
        // 文档里放个链接就能变成执行入口。
        const ext = path.extname(resolved).toLowerCase();
        if (!OPENABLE_EXT.has(ext)) {
          return fail(res, 403, '出于安全考虑不打开此类型：' + (ext || '(无扩展名)'));
        }
        const ok = openExternal(resolved);
        return json(res, 200, { kind: 'external', path: resolved, opened: ok });
      }
      allow(path.dirname(resolved));
      rememberRecent(resolved, 'file');
      return json(res, 200, { kind: 'file', path: resolved });
    }

    if (route === '/api/shutdown') {
      if (req.headers[CLIENT_HEADER] !== '1') return fail(res, 403, '缺少本地请求头');
      json(res, 200, { ok: true });
      // Leave no stale state file behind: the next `mdview status` would
      // otherwise report a server that is not there.
      setTimeout(() => {
        try { fs.unlinkSync(STATE_FILE); } catch { /* already gone */ }
        process.exit(0);
      }, 60);
      return undefined;
    }

    if (route === '/asset') {
      if (!assetAuthorized(req, url)) return fail(res, 403, '资源令牌无效');
      const p = url.searchParams.get('p');
      const raw = p ? decodeToken(p) || p : null;
      if (!raw) return fail(res, 400, '缺少参数 p');
      if (!isAllowedTargetReal(raw)) return fail(res, 403, '该路径不在允许范围内');
      const abs = toNative(raw);
      let st;
      try { st = await fsp.stat(abs); } catch { return fail(res, 404, '资源不存在'); }
      if (!st.isFile() || st.size > MAX_ASSET_BYTES) return fail(res, 413, '资源不可用或过大');
      const ext = path.extname(abs).toLowerCase();
      const type = CONTENT_TYPES[ext] || 'application/octet-stream';
      // 只让图片/媒体/PDF 内联；.html 等一律 octet-stream + attachment，
      // 这样即便被直接导航过去，也不会在 127.0.0.1 这个源里执行。
      const inline = INLINE_ASSET_EXT.has(ext);
      const safeName = path.basename(abs).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
      const headers = {
        'Content-Type': inline ? type : 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'private, max-age=120',
        'Last-Modified': new Date(st.mtimeMs).toUTCString(),
        'X-Content-Type-Options': 'nosniff',
        // 对直接导航到 /asset 的情况生效：沙箱化 + 禁止一切子资源，
        // 即使内容是 SVG 也执行不了脚本。
        'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'none'; style-src 'none'; script-src 'none'",
      };
      if (!inline) headers['Content-Disposition'] = 'attachment; filename="' + safeName + '"';
      let start = 0;
      let end = st.size - 1;
      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (m) {
          const hasFirst = m[1] !== '';
          const hasLast = m[2] !== '';
          if (hasFirst) {
            start = Number(m[1]);
            if (hasLast) end = Number(m[2]);
          } else if (hasLast) {
            // 后缀范围 `bytes=-N` 表示"最后 N 个字节"，不是 0..N
            const n = Number(m[2]);
            start = Math.max(0, st.size - n);
            end = st.size - 1;
          }
          if (isNaN(start) || isNaN(end) || start > end || start >= st.size) {
            res.writeHead(416, { 'Content-Range': 'bytes */' + st.size });
            return res.end();
          }
          headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
          headers['Content-Length'] = end - start + 1;
          res.writeHead(206, headers);
        } else {
          res.writeHead(200, headers);
        }
      } else {
        res.writeHead(200, headers);
      }
      const stream = fs.createReadStream(abs, { start, end });
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      return undefined;
    }

    return fail(res, 404, 'not found: ' + route);
  };

  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      if (verbose) console.error('[mdview] handler error:', err);
      try { fail(res, 500, 'internal error: ' + err.message); } catch { /* headers sent */ }
    });
  });

  server.on('clientError', (err, socket) => {
    try { socket.destroy(); } catch { /* ignore */ }
    void err;
  });

  return { server, allow, allowedRoots, idleFor, shouldRetire, tabStats: () => ({ liveTabs, noTabsFor: noTabsFor() }) };
}

/* ------------------------------------------------------------------ cli */

function printHelp() {
  console.log(`mdview ${APP_VERSION} — 本地 Markdown 查看器（零依赖、纯本机）

用法:
  mdview <文件.md>            在浏览器中打开这个 Markdown 文件
  mdview <文件夹>             浏览该文件夹下的所有 Markdown 文件
  mdview serve [--port N]     前台运行服务（默认端口 ${DEFAULT_PORT}）
  mdview stop                 停止后台服务
  mdview status               查看服务状态
  mdview --help | --version

说明:
  * 服务只监听 127.0.0.1，且仅允许读取你打开过的文件/目录所在范围。
  * 后台服务在浏览器标签页全部关闭约 45 秒后自动退出；
    兜底空闲退出: ${IDLE_MINUTES_LABEL}（可用环境变量 MDVIEW_IDLE_MINUTES 调整，0 = 不自动退出）
  * 状态文件: ${STATE_FILE}
  * 日志文件: ${LOG_FILE}
`);
}

/**
 * Strip the runtime's own noise from argv.
 *
 * Running `node server.mjs a b` gives argv = [node, server.mjs, a, b].
 * Running a SEA (`mdview.exe a b`) gives argv = [mdview.exe, mdview.exe, a, b]
 * — Node deliberately repeats argv[0] in place of the missing entry script.
 * Dropping both the executable path and any ".mjs" entry leaves just the user's
 * arguments, so the CLI behaves identically in both modes.
 */
function userArgs(argv) {
  const self = process.execPath.toLowerCase();
  return argv.filter((a) => {
    if (typeof a !== 'string') return false;
    const lower = a.toLowerCase();
    if (lower === self) return false;
    if (/\.mjs$/.test(lower) && (lower.includes('server') || lower.includes('mdview'))) return false;
    return true;
  });
}

function parseArgs(argv) {
  const out = { command: null, target: null, port: null, open: true };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') { out.port = Number(argv[++i]); continue; }
    if (a === '--no-open') { out.open = false; continue; }
    if (a === '--help' || a === '-h' || a === '/?') { out.command = 'help'; continue; }
    if (a === '--version' || a === '-v') { out.command = 'version'; continue; }
    rest.push(a);
  }
  if (out.command) return out;
  if (rest.length && ['serve', 'stop', 'status', 'open'].includes(rest[0].toLowerCase())) {
    out.command = rest.shift().toLowerCase();
    if (rest.length) out.target = rest.join(' ');
    return out;
  }
  if (rest.length) {
    out.command = 'open';
    out.target = rest.join(' ');
    return out;
  }
  out.command = 'open';
  return out;
}

async function commandStatus() {
  const state = readState();
  if (!state) { console.log('mdview: 未运行（没有状态文件）'); return 1; }
  const alive = await isAlive(state.port);
  if (!alive) { console.log('mdview: 状态文件存在但服务未响应（端口 ' + state.port + '）'); return 1; }
  console.log('mdview: 运行中 http://127.0.0.1:' + state.port + '  pid=' + state.pid +
    '  起始于 ' + new Date(state.startedAt).toLocaleString());
  return 0;
}

async function commandStop() {
  const state = readState();
  if (!state) { console.log('mdview: 没有正在运行的服务'); return 0; }
  const alive = await isAlive(state.port);
  if (alive) {
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: state.port, path: '/api/shutdown', method: 'POST', timeout: 1500, headers: { [CLIENT_HEADER]: '1' } },
        (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', resolve);
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.end();
    });
  }
  await new Promise((r) => setTimeout(r, 250));
  if (!(await isAlive(state.port))) {
    try { fs.unlinkSync(STATE_FILE); } catch { /* already gone */ }
    console.log('mdview: 已停止');
    return 0;
  }
  console.log('mdview: 服务仍在运行，请手动结束进程 pid=' + state.pid);
  return 1;
}

/** Start a detached background server and wait until it answers /health. */
async function ensureServer(targetFile, preferredPort, verbose) {
  const state = readState();
  if (state && await isAlive(state.port)) return state;

  const port = preferredPort || (state && state.port) || DEFAULT_PORT;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const log = fs.openSync(LOG_FILE, 'a');
  const self = selfInvocation();
  const args = self.prefix.concat(['serve', '--port', String(port)]);
  if (targetFile) args.push(targetFile);
  const child = spawn(self.file, args, {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(log);

  // The child may fall back to another port, so trust the state file it writes
  // rather than the port we asked for. Matching on the port being answerable
  // (not on the pid) keeps this working when a previous state file is stale.
  const debug = !!process.env.MDVIEW_DEBUG;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const fresh = readState();
    if (debug) {
      console.error('[mdview:debug] spawned pid=' + child.pid + ' want port=' + port +
        ' t=' + Date.now() + ' state=' + JSON.stringify(fresh));
    }
    if (fresh && fresh.port && await isAlive(fresh.port)) return fresh;
  }
  if (verbose) console.error('mdview: 服务启动超时，请查看日志 ' + LOG_FILE);
  throw new Error('服务启动超时（端口 ' + port + '），日志：' + LOG_FILE);
}

async function commandOpen(target, opts) {
  let abs = null;
  if (target) {
    abs = toNative(path.resolve(target.replace(/^"|"$/g, '')));
    let st;
    try { st = await fsp.stat(abs); } catch {
      console.error('mdview: 找不到路径 ' + abs);
      return 1;
    }
    if (st.isDirectory()) abs = abs;
    else if (!st.isFile()) { console.error('mdview: 不支持的路径类型 ' + abs); return 1; }
  }

  const state = await ensureServer(abs, opts.port, true);
  const base = 'http://127.0.0.1:' + state.port;
  let url = base + '/';
  if (abs) {
    // Widen the running server's allow-list first, then build the URL.
    await notifyOpen(state.port, abs);
    let st = null;
    try { st = await fsp.stat(abs); } catch { /* ignore */ }
    if (st && st.isDirectory()) {
      url = base + '/?dir=' + encodeURIComponent(abs);
    } else {
      url = base + '/view?f=' + encodeURIComponent(encodeToken(abs));
    }
  }
  if (opts.open) openExternal(url);
  console.log(url);
  return 0;
}

/** Tell the running server to widen its allow-list for this path. */
function notifyOpen(port, abs) {
  return new Promise((resolve) => {
    const body = '';
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/open?f=' + encodeURIComponent(encodeToken(abs)),
      method: 'GET', timeout: 2000, headers: { [CLIENT_HEADER]: '1' },
    }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.end(body);
  });
}

async function commandServe(opts) {
  const port = opts.port || DEFAULT_PORT;
  const targets = opts.target ? [toNative(path.resolve(opts.target.replace(/^"|"$/g, '')))] : [];
  const roots = [];
  let initialFile = null;
  for (const t of targets) {
    try {
      const st = await fsp.stat(t);
      if (st.isDirectory()) roots.push(t);
      else { roots.push(path.dirname(t)); initialFile = t; }
    } catch { /* ignore missing */ }
  }
  if (!roots.length) roots.push(process.cwd() || path.dirname(process.execPath));
  if (roots.length === 0) roots.push(path.parse(process.cwd()).root);

  const { server, allowedRoots, idleFor, shouldRetire } = createServer({
    token: crypto.randomBytes(16).toString('hex'),
    roots,
    initialFile,
    verbose: true,
  });

  // A fresh 'error' listener per attempt: `once` is consumed by the first
  // failure, and without a listener a failed listen() throws out of the process.
  const listen = (p) => new Promise((resolve, reject) => {
    const onError = (err) => { server.removeListener('listening', onListening); reject(err); };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(p, '127.0.0.1');
  });

  let boundPort = port;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await listen(boundPort);
      break;
    } catch (err) {
      if (err && err.code === 'EADDRINUSE') {
        boundPort = attempt === 19 ? 0 : boundPort + 1;
        continue;
      }
      console.error('[mdview] 无法监听端口 ' + boundPort + ': ' + err.message);
      process.exit(1);
    }
  }
  boundPort = server.address().port;

  writeState({
    port: boundPort,
    pid: process.pid,
    startedAt: Date.now(),
    roots: [...allowedRoots],
    version: APP_VERSION,
  });

  console.log('[mdview] listening on http://127.0.0.1:' + boundPort);
  if (initialFile) console.log('[mdview] opening ' + initialFile);

  const timer = setInterval(() => {
    const reason = shouldRetire(idleTimeoutMs);
    if (reason) {
      console.log('[mdview] retiring: ' + reason);
      cleanup(0);
    }
  }, 10 * 1000);
  timer.unref?.();

  function cleanup(code) {
    try { fs.unlinkSync(STATE_FILE); } catch { /* ignore */ }
    try { server.close(); } catch { /* ignore */ }
    process.exit(code);
  }

  process.on('SIGINT', () => cleanup(0));
  process.on('SIGTERM', () => cleanup(0));
}

/* ----------------------------------------------------------------- main */

async function main() {
  const opts = parseArgs(userArgs(process.argv.slice(1)));
  switch (opts.command) {
    case 'help': printHelp(); return 0;
    case 'version': console.log(APP_VERSION); return 0;
    case 'status': return commandStatus();
    case 'stop': return commandStop();
    case 'serve': await commandServe(opts); return 0;
    case 'open':
    default:
      try {
        return await commandOpen(opts.target, opts);
      } catch (err) {
        console.error('mdview: ' + err.message);
        return 1;
      }
  }
}

/*
 * 只有被直接执行时才启动 CLI。
 *
 * 文件被 import 时（例如其它实验复用上面的渲染层导出）不应该顺手把服务启起来。
 *
 * 比较路径时必须两边都做大小写归一：Windows 路径本身不区分大小写，但字符串
 * 比较区分，只把一边转成小写会让守卫永远返回 false（曾因此让 CLI 整个失效）。
 */
function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function isDirectRun() {
  const entry = String(process.argv[1] || '');
  if (!entry) return true;                                   // 没有 argv[1]，按直接运行处理
  if (entry.toLowerCase() === process.execPath.toLowerCase()) return true;  // SEA 或显式运行 node.exe
  try {
    return samePath(entry, fileURLToPath(import.meta.url));
  } catch {
    // 拿不到自身路径时，宁可不启动也不误启动：直接运行会表现为"没反应"，
    // 这比 import 时意外起一个服务更容易排查。
    return false;
  }
}

if (isDirectRun()) {
  main().then((code) => {
    if (typeof code === 'number' && code !== 0 && process.argv[2] !== 'serve') process.exitCode = code;
  }).catch((err) => {
    console.error('[mdview] fatal: ' + (err && err.stack ? err.stack : err));
    process.exit(1);
  });
}
