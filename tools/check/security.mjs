/*
 * 安全回归：把已经修掉的攻击面变成断言，防止以后再被改回去。
 *
 *   node tools/check/security.mjs <port>
 *
 * 覆盖：
 *   · Host 头缺失 / 伪造 → 403
 *   · /api/open 的类型白名单（.exe / .lnk / 双扩展名 / 无扩展名 / .svg 一律拒绝）
 *   · 允许打开的类型不会顺带扩白名单
 *   · 文档里的目录链接（from=link）不能扩白名单
 *   · /asset 对 .html 强制下载，所有附件带 CSP sandbox；.svg 仍能当图片内联
 *   · junction 越界在 /api/file、/api/search 上都被拒绝
 *   · 仓库卫生：install.ps1 必须带 UTF-8 BOM（PS 5.1 依赖它），
 *     portable-install.ps1 必须纯 ASCII（任何代码页都能读）
 *
 * 断言设计上的两个坑，这里刻意避开：
 *   1. 测试目录不要把"被测目录"放在已加白名单的父目录里——那样 allow() 会命中
 *      已有 root 直接早退，"白名单没变"永远成立，等于没测。
 *   2. 搜索用例不要依赖系统里恰好存在的文件，用唯一标记串，否则回退了也 0 命中。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const port = Number(process.argv[2] || 0);
const results = [];
const t = (name, ok, extra) => {
  results.push({ name, ok });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  (' + extra + ')' : ''));
};

function req(method, p, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port, path: p, method, timeout: 10000,
      headers: headers || {},
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.end();
  });
}

/** 发一个不含 Host 头的原始 HTTP/1.0 请求，验证 Host 校验不会放行缺省值。 */
function rawNoHost(p) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write('GET ' + p + ' HTTP/1.0\r\n\r\n');
    });
    let data = '';
    socket.setTimeout(5000);
    socket.on('data', (d) => { data += d.toString(); });
    socket.on('end', () => resolve(data));
    socket.on('timeout', () => { socket.destroy(); reject(new Error('timeout')); });
    socket.on('error', reject);
  });
}

const rootsOf = async () => JSON.parse((await req('GET', '/health')).body).roots.length;

/* ---------------------------------------------------------- 文件级检查 */

console.log('=== 仓库卫生 ===');
const installBuf = fs.readFileSync(path.join(ROOT, 'windows', 'install.ps1'));
t('install.ps1 带 UTF-8 BOM（PS 5.1 必需）',
  installBuf.length >= 3 && installBuf[0] === 0xEF && installBuf[1] === 0xBB && installBuf[2] === 0xBF,
  '首字节 ' + [...installBuf.slice(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join(' '));

const portable = fs.readFileSync(path.join(ROOT, 'windows', 'portable-install.ps1'));
const firstNonAscii = portable.findIndex((b) => b > 0x7F);
t('portable-install.ps1 纯 ASCII', firstNonAscii === -1,
  firstNonAscii === -1 ? '' : '第一个非 ASCII 字节在偏移 ' + firstNonAscii);

if (!port) {
  console.log('\n（未给端口，跳过服务端安全断言）');
  const failed = results.filter((r) => !r.ok).length;
  console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
} else {
  const base = path.join(os.tmpdir(), 'mdview-sec-' + process.pid);
  fs.rmSync(base, { recursive: true, force: true });
  // sandbox/ 本身从不打开；allowed/ 会被显式打开；outside/ 永不打开。
  const sandbox = path.join(base, 'sandbox');
  const allowed = path.join(sandbox, 'allowed');
  const outside = path.join(sandbox, 'outside');
  fs.mkdirSync(path.join(allowed, 'assets'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  const H = { 'X-Mdview': '1' };
  const enc = encodeURIComponent;
  const mk = (dir, name, body) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, body);
    return p;
  };

  try {
    console.log('\n=== Host 校验 ===');
    let r = await req('GET', '/health', { Host: 'evil.example' });
    t('伪造 Host → 403', r.status === 403, 'HTTP ' + r.status);
    const raw = await rawNoHost('/health');
    t('缺少 Host → 403', /^HTTP\/1\.[01] 403/.test(raw), JSON.stringify(raw.slice(0, 40)));

    console.log('\n=== 状态变更端点的闸门 ===');
    r = await req('GET', '/api/session');
    t('/api/session 无头 → 403', r.status === 403, 'HTTP ' + r.status);
    r = await req('GET', '/api/session', H);
    t('/api/session 带头 → 200', r.status === 200, 'HTTP ' + r.status);
    r = await req('POST', '/api/keepalive?tabs=1');
    t('/api/keepalive 无头 → 403', r.status === 403, 'HTTP ' + r.status);
    r = await req('POST', '/api/keepalive?tabs=1', H);
    t('/api/keepalive 带头 → 200', r.status === 200, 'HTTP ' + r.status);
    r = await req('POST', '/api/bye?tabs=1');
    t('/api/bye 无头 → 403', r.status === 403, 'HTTP ' + r.status);
    r = await req('POST', '/api/recents', H);
    t('/api/recents 没有写入口（405）', r.status === 405, 'HTTP ' + r.status);

    console.log('\n=== 打开被测目录 ===');
    r = await req('GET', '/api/open?f=' + enc(allowed), H);
    t('打开目录 → 200', r.status === 200, 'HTTP ' + r.status);
    const baseRoots = await rootsOf();
    t('白名单已包含该目录', baseRoots >= 1, 'roots=' + baseRoots);

    const exe = mk(allowed, 'evil.exe', 'MZ');
    const lnk = mk(allowed, 'evil.lnk', 'x');
    const noext = mk(allowed, 'noext', 'x');
    const doubleExt = mk(allowed, 'shot.png.exe', 'MZ');
    const svg = mk(allowed, 'evil.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const html = mk(allowed, 'evil.html', '<script>document.title="PWNED"</script>');
    const txt = mk(allowed, 'note.txt', 'hello');

    console.log('\n=== /api/open 类型白名单 ===');
    for (const [label, file] of [
      ['.exe', exe], ['.lnk', lnk], ['无扩展名', noext], ['双扩展名 .png.exe', doubleExt], ['.svg', svg],
    ]) {
      r = await req('GET', '/api/open?f=' + enc(file), H);
      t('拒绝 ' + label + '（403）', r.status === 403, 'HTTP ' + r.status);
    }
    r = await req('GET', '/api/open?f=' + enc(txt), H);
    t('允许 .txt（200）', r.status === 200, 'HTTP ' + r.status);

    // 关键：outside 不在任何已允许的根下面，任何 allow(dirname) 都会让 roots 变化。
    console.log('\n=== 允许类型不扩白名单 ===');
    const outsideTxt = mk(outside, 'a.txt', 'x');
    const beforeOpen = await rootsOf();
    r = await req('GET', '/api/open?f=' + enc(outsideTxt), H);
    const afterOpen = await rootsOf();
    t('打开白名单外的 .txt 成功（200）', r.status === 200, 'HTTP ' + r.status);
    t('但没有把它的目录加进白名单', afterOpen === beforeOpen, beforeOpen + ' -> ' + afterOpen);

    console.log('\n=== 目录链接不能扩白名单 ===');
    const beforeLink = await rootsOf();
    r = await req('GET', '/api/open?f=' + enc(outside) + '&from=link', H);
    t('from=link 打开目录被拒（400）', r.status === 400, 'HTTP ' + r.status);
    const afterLink = await rootsOf();
    t('目录未被加入白名单', afterLink === beforeLink, beforeLink + ' -> ' + afterLink);

    console.log('\n=== /asset 活动内容收口 ===');
    const session = JSON.parse((await req('GET', '/api/session', H)).body);
    const tok = session.assetToken;
    r = await req('GET', '/asset?p=' + enc(html) + '&t=' + enc(tok));
    const ct = String(r.headers['content-type'] || '');
    const cd = String(r.headers['content-disposition'] || '');
    const csp = String(r.headers['content-security-policy'] || '');
    t('.html 返回 octet-stream', ct.includes('application/octet-stream'), ct);
    t('.html 带 attachment', cd.startsWith('attachment'), cd || '(无)');
    t('/asset 带 CSP sandbox', csp.includes('sandbox'), csp.slice(0, 40));

    r = await req('GET', '/asset?p=' + enc(svg) + '&t=' + enc(tok));
    t('.svg 仍以 image/svg+xml 内联', String(r.headers['content-type']).includes('image/svg+xml'),
      String(r.headers['content-type']));
    t('.svg 不被强制下载（无 attachment）', !String(r.headers['content-disposition'] || '').startsWith('attachment'),
      String(r.headers['content-disposition'] || '(无)'));
    t('.svg 也带 CSP sandbox', String(r.headers['content-security-policy'] || '').includes('sandbox'));

    console.log('\n=== junction 越界 ===');
    const target = path.join(base, 'junction-target');
    fs.mkdirSync(target, { recursive: true });
    const mark = 'ZZUNIQUEZZ' + process.pid;
    mk(target, 'leak.md', '# ' + mark + '\n');
    const junction = path.join(allowed, 'wj');
    fs.rmSync(junction, { recursive: true, force: true });
    let junctionOk = false;
    if (process.platform === 'win32') {
      try { fs.symlinkSync(target, junction, 'junction'); junctionOk = true; } catch { /* 见下 */ }
    }
    if (!junctionOk) {
      // Windows 上建 junction 不需要管理员；建不出来说明环境异常，按失败处理，
      // 否则这个套件会在 CI 上静默变成"什么都没测"。
      t('junction 创建成功', false, process.platform === 'win32' ? 'mklink /J 失败' : '非 Windows');
    } else {
      r = await req('GET', '/api/file?f=' + enc(path.join(junction, 'leak.md')));
      t('经 junction 读文件被拒（403）', r.status === 403, 'HTTP ' + r.status);
      r = await req('GET', '/api/search?q=' + enc(mark) + '&dir=' + enc(junction));
      const hits = r.status === 200 ? (JSON.parse(r.body).results || []).length : -1;
      t('经 junction 搜索不泄漏（0 命中）', hits === 0, 'status ' + r.status + ', hits ' + hits);
    }
  } catch (e) {
    t('安全断言执行完成', false, e.message);
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const failed = results.filter((x) => !x.ok).length;
  console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
}
