/*
 * 专注模式 / 最近打开 —— 端到端验证。
 *
 *   node server.mjs serve --port 7799 examples\test-fixture.md
 *   node tools/check/recents.mjs 7799
 *
 * 覆盖：
 *   1. 页面带有专注模式与「打开 ▾」下拉所需的 DOM
 *   2. /api/recents 记住打开过的文件，最新在前、同一路径不重复
 *   3. 读取白名单外路径被拒绝；/api/recents 没有写入口
 */

const port = Number(process.argv[2] || 7799);
const base = 'http://127.0.0.1:' + port;

let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
};

const page = await (await fetch(base + '/')).text();
check('页面含「打开 ▾」按钮', page.includes('id="btn-open"') && page.includes('打开 ▾'));
check('页面含下拉容器', page.includes('id="menu-open"'));
check('页面含侧栏「最近打开」容器', page.includes('id="side-recents"'));
check('页面含专注模式逻辑', page.includes('function setFocus') && page.includes('mdview.focus'));
check('侧栏默认隐藏由 JS 控制（HTML 不再硬编码 hidden）', !/<aside class="sidebar hidden"/.test(page));

// 打开一个文件，让服务端记进历史
const fixture = page.match(/__MDVIEW_BOOT__ = (\{.*?\});/s);
let target = null;
try { target = JSON.parse(fixture[1]).file; } catch { /* ignore */ }
if (!target) {
  console.log('  (页面没有初始文件，改用 /api/open 指定一个)');
  target = process.argv[3];
}
check('能确定一个测试文件', !!target, String(target));

if (target) {
  await fetch(base + '/api/open?f=' + encodeURIComponent(target), { headers: { 'X-Mdview': '1' } });

  // 读两次，确认"最新在前、同路径不重复"
  const r1 = await (await fetch(base + '/api/recents')).json();
  const list1 = r1.recents || [];
  check('历史里有这个文件', list1.some((e) => e.path.replace(/\\/g, '/').toLowerCase() === target.replace(/\\/g, '/').toLowerCase()),
    JSON.stringify(list1.map((e) => e.path)));
  check('最新一条在最前', list1.length > 0 && list1[0].path.replace(/\\/g, '/').toLowerCase() === target.replace(/\\/g, '/').toLowerCase());

  const before = list1.length;
  // 页面发起的读取带 X-Mdview，服务端才会把它记进历史（跨源页面发不出这个头）
  await fetch(base + '/api/file?f=' + encodeURIComponent(target), { headers: { 'X-Mdview': '1' } });
  const list2 = (await (await fetch(base + '/api/recents')).json()).recents || [];
  check('重复打开不会产生重复条目', list2.length === before, '之前 ' + before + '，现在 ' + list2.length);

  // 白名单外必须拒绝：直接读文件，不是读历史
  const bad = await fetch(base + '/api/file?f=' + encodeURIComponent('C:\\Windows\\win.ini'));
  check('读取白名单外路径被拒（403）', bad.status === 403, 'HTTP ' + bad.status);
  // 没有"提交历史"的写入口：这个端点只读
  const post = await fetch(base + '/api/recents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Mdview': '1' },
    body: JSON.stringify({ path: 'C:\\Windows\\win.ini' }),
  });
  check('POST /api/recents 没有写入口（405）', post.status === 405, 'HTTP ' + post.status);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
