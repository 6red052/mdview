/*
 * 把 mdview 打包成单个 Windows 可执行文件。
 *
 *   node tools/build-exe.mjs                 # 用自动找到的 Node 打包
 *   node tools/build-exe.mjs --node <路径>   # 指定某个 node.exe 作为基线
 *
 * 产物：
 *   dist/mdview.exe                  单文件，内含 Node 运行时与全部代码
 *   dist/mdview-launch.cmd           无黑框启动器（文件关联指向它）
 *   dist/portable-install.ps1        一键注册 .md 关联（可选加 PATH）
 *   dist/使用说明.txt                给使用者看的说明
 *   dist/README.md
 *   dist/mdview-portable-<版本>.zip  可整体发给别人的压缩包
 *
 * 打包方式：
 *   Node 25.5+ 内置 `--build-sea`，一条命令就能生成 SEA，无需第三方注入工具。
 *   Node 20~24 只能用 `--experimental-sea-config` 生成 blob 再自己注入，
 *   而现成的注入工具 postject 在 Node 24 的 PE 结构上不可靠，所以本脚本要求
 *   Node 25.5+。可以用 npm 取一份官方二进制来做构建基线：
 *       npm install node@26 --no-save --prefix .build/nodebin
 *
 * 注意：SEA 的产物与构建平台/架构绑定，这里只产出 Windows x64 的 exe。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const BUILD = path.join(ROOT, '.build');
const EXE_NAME = 'mdview.exe';

const log = (m) => console.log(m);
const step = (m) => console.log('\n== ' + m);
const die = (m) => { console.error('\n[错误] ' + m); process.exit(1); };

/**
 * 运行一个命令并把 stdout/stderr 收进文件再读取。
 *
 * 不能直接用管道捕获子进程输出：某些受限环境（以及部分 Windows 策略）会
 * 让 `spawn` 带管道时直接 EPERM。写文件是到处都能用的做法。
 */
function capture(exe, args, timeout = 30000) {
  fs.mkdirSync(BUILD, { recursive: true });
  const outPath = path.join(BUILD, 'capture.out');
  const errPath = path.join(BUILD, 'capture.err');
  const out = fs.openSync(outPath, 'w');
  const err = fs.openSync(errPath, 'w');
  let status = -1;
  try {
    const r = spawnSync(exe, args, { stdio: ['ignore', out, err], timeout, windowsHide: true });
    status = r.status === null ? -1 : r.status;
  } catch (e) {
    status = -1;
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
  const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
  return { status, stdout: read(outPath), stderr: read(errPath) };
}

function version() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
}

/** 找一个支持 --build-sea 的 node.exe。 */
function pickBuilderNode() {
  const explicit = process.argv.indexOf('--node');
  const candidates = [];
  if (explicit >= 0 && process.argv[explicit + 1]) {
    const p = path.resolve(process.argv[explicit + 1]);
    if (!fs.existsSync(p)) die('--node 指定的路径不存在：' + p);
    candidates.push(p);
  }
  candidates.push(process.execPath);
  const binRoot = path.join(BUILD, 'nodebin');
  if (fs.existsSync(binRoot)) {
    const walk = (dir, depth) => {
      if (depth > 6) return;
      let items;
      try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const it of items) {
        const full = path.join(dir, it.name);
        if (it.isDirectory()) walk(full, depth + 1);
        else if (it.name.toLowerCase() === 'node.exe') candidates.push(full);
      }
    };
    walk(binRoot, 0);
  }

  const seen = new Set();
  const tried = [];
  for (const c of candidates) {
    if (!fs.existsSync(c) || seen.has(c.toLowerCase())) continue;
    seen.add(c.toLowerCase());
    const v = capture(c, ['-v'], 15000);
    if (v.status !== 0) continue;
    const ver = v.stdout.trim();
    const help = capture(c, ['--help'], 30000);
    const hasBuildSea = help.stdout.includes('--build-sea');
    tried.push({ c, ver, hasBuildSea });
    if (hasBuildSea) return { exe: c, version: ver };
  }

  console.error('候选 node 都不能打包：');
  if (!tried.length) console.error('  （一个都没能执行，可能是权限或架构不匹配）');
  for (const t of tried) console.error('  ' + t.ver + (t.hasBuildSea ? ' [有 --build-sea]' : ' [没有 --build-sea]') + '  ' + t.c);
  die('需要 Node 25.5 或更高版本来打包（--build-sea）。\n' +
      '可以这样取一份官方二进制，不会动你系统里的 Node：\n' +
      '    npm install node@26 --no-save --prefix .build/nodebin\n' +
      '然后重新执行本脚本。');
}

step('环境检查');
if (process.platform !== 'win32') die('当前只支持在 Windows 上构建（SEA 产物与平台绑定）。');
const builder = pickBuilderNode();
log('  构建用 Node: ' + builder.version + '  ' + builder.exe);
if (!fs.existsSync(path.join(ROOT, 'server.mjs'))) die('找不到 server.mjs，请在项目根目录运行。');

const VERSION = version();
const OUT_EXE = path.join(DIST, EXE_NAME);

await fsp.rm(DIST, { recursive: true, force: true });
await fsp.mkdir(DIST, { recursive: true });
await fsp.mkdir(BUILD, { recursive: true });

/* --------------------------------------------------------------- 打包 -- */

step('生成单文件可执行程序（--build-sea）');
const seaConfigPath = path.join(BUILD, 'sea-config.json');
await fsp.writeFile(seaConfigPath, JSON.stringify({
  main: path.join(ROOT, 'server.mjs'),
  output: OUT_EXE,
  mainFormat: 'module',                 // server.mjs 用的是 ESM
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
}, null, 2));

try {
  execFileSync(builder.exe, ['--build-sea', seaConfigPath], { stdio: 'inherit', cwd: ROOT });
} catch (e) {
  die('--build-sea 失败：' + (e.stderr || e.message));
}
if (!fs.existsSync(OUT_EXE)) die('没有生成 ' + OUT_EXE);
log('  ' + EXE_NAME + ': ' + (fs.statSync(OUT_EXE).size / 1048576).toFixed(1) + ' MB');

/* --------------------------------------------------------------- 自检 -- */

step('自检：直接运行生成的 exe');
const exeSize = fs.statSync(OUT_EXE).size;
const probeHome = path.join(BUILD, 'probe-home');
await fsp.rm(probeHome, { recursive: true, force: true });

function runExe(args) {
  // 同样写文件而不是管道捕获（见 capture 的说明）
  fs.mkdirSync(BUILD, { recursive: true });
  const outPath = path.join(BUILD, 'exe.out');
  const errPath = path.join(BUILD, 'exe.err');
  const out = fs.openSync(outPath, 'w');
  const err = fs.openSync(errPath, 'w');
  let status = -1;
  try {
    const r = spawnSync(OUT_EXE, args, {
      stdio: ['ignore', out, err],
      timeout: 30000,
      env: { ...process.env, MDVIEW_HOME: probeHome },
      windowsHide: true,
    });
    status = r.status === null ? -1 : r.status;
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
  const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
  if (status !== 0) throw new Error('exit ' + status + ': ' + read(errPath).trim());
  return read(outPath);
}

let out = '';
try {
  out = runExe(['--version']);
} catch (e) {
  die('exe 跑不起来：' + (e.stderr || e.message));
}
log('  --version -> ' + out.trim());
if (out.trim() !== VERSION) die('版本号对不上，期望 ' + VERSION + '，得到 ' + out.trim());

try {
  out = runExe(['--help']);
  log('  --help 正常（' + out.split('\n').length + ' 行）');
} catch (e) {
  die('--help 失败：' + (e.stderr || e.message));
}

// 关键：SEA 下不能再 spawn "node server.mjs"，必须能重新调用自身
try {
  const sample = path.join(DIST, 'sample.md');
  await fsp.writeFile(sample,
    '# mdview.exe 自检\n\n**这段文字能显示出来，说明单文件版可用。**\n\n| 检查项 | 结果 |\n|---|---|\n| 内嵌运行时 | 是 |\n| 后台服务 | 已启动 |\n',
    'utf8');
  runExe(['open', sample, '--no-open']);
  await new Promise((r) => setTimeout(r, 2000));
  const stateFile = path.join(probeHome, 'server.json');
  if (!fs.existsSync(stateFile)) die('exe 没有写出 server.json —— 后台服务没起来（SEA 下自调用失败）。');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const health = await (await fetch('http://127.0.0.1:' + state.port + '/health')).json();
  log('  后台服务: port=' + state.port + ' pid=' + state.pid + ' health=' + (health.ok ? 'ok' : '异常'));
  if (!health.ok) die('健康检查没通过。');
  const page = await (await fetch('http://127.0.0.1:' + state.port + '/view?f=' + encodeURIComponent(sample))).text();
  if (page.length < 1000) die('页面异常，长度 ' + page.length);
  log('  页面可访问: ' + page.length + ' 字节');
  await fetch('http://127.0.0.1:' + state.port + '/api/shutdown', {
    method: 'POST', headers: { 'X-Mdview': '1' },
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
} catch (e) {
  die('exe 后台服务自检失败：' + (e.stderr || e.message));
} finally {
  await fsp.rm(probeHome, { recursive: true, force: true });
}
log('  ✓ exe 能独立运行、能起后台服务、能渲染页面');

/* --------------------------------------------------------- 随附文件 -- */

step('生成随附文件');

await fsp.writeFile(path.join(DIST, 'mdview-launch.cmd'),
  '@echo off\r\n' +
  'rem Launch mdview.exe without a console window (the file association points here).\r\n' +
  'rem `open` starts the background server, prints the URL and returns at once.\r\n' +
  'setlocal\r\n' +
  'set "HERE=%~dp0"\r\n' +
  '"%HERE%mdview.exe" open %*\r\n' +
  'endlocal\r\n', 'ascii');

// 无窗口启动器：.cmd 会闪一下黑框，VBS 不会。文件关联优先用这个。
// 这个文件刻意只用 ASCII：cscript 在任意代码页下都不会读错。
await fsp.writeFile(path.join(DIST, 'mdview-silent.vbs'),
  "' mdview-silent.vbs - start mdview.exe with no console window.\r\n" +
  "'\r\n" +
  "'   cscript.exe //nologo mdview-silent.vbs \"<file-or-folder>\"\r\n" +
  "'\r\n" +
  'Option Explicit\r\n' +
  'Dim shell, fso, exe, target, cmd, argText\r\n' +
  'Set shell = CreateObject("WScript.Shell")\r\n' +
  'Set fso = CreateObject("Scripting.FileSystemObject")\r\n' +
  'exe = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "mdview.exe")\r\n' +
  'target = ""\r\n' +
  'If WScript.Arguments.Count >= 1 Then target = WScript.Arguments(0)\r\n' +
  "' A folder target arrives with a trailing backslash; that would escape the\r\n" +
  "' closing quote of the command line, so strip it -- but keep drive roots\r\n" +
  "' such as \"D:\\\" intact.\r\n" +
  'Do While Right(target, 1) = "\\"\r\n' +
  '  If Len(target) = 3 And Mid(target, 2, 2) = ":\\" Then Exit Do\r\n' +
  '  If Len(target) <= 1 Then Exit Do\r\n' +
  '  target = Left(target, Len(target) - 1)\r\n' +
  'Loop\r\n' +
  'cmd = """" & exe & """ open"\r\n' +
  'If Len(target) > 0 Then\r\n' +
  '  argText = target\r\n' +
  "' A trailing backslash would escape the closing quote; double it.\r\n" +
  '  If Right(argText, 1) = "\\" Then argText = argText & "\\"\r\n' +
  '  cmd = cmd & " """ & argText & """"\r\n' +
  'End If\r\n' +
  "' Run through cmd.exe so the redirection is reliable; window hidden.\r\n" +
  'cmd = "cmd.exe /c """ & Replace(cmd, """", """""") & """"\r\n' +
  'On Error Resume Next\r\n' +
  'shell.Run cmd, 0, False\r\n' +
  'On Error GoTo 0\r\n', 'ascii');

await fsp.copyFile(path.join(ROOT, 'windows', 'portable-install.ps1'),
  path.join(DIST, 'portable-install.ps1'));
await fsp.copyFile(path.join(ROOT, 'README.md'), path.join(DIST, 'README.md'));

await fsp.writeFile(path.join(DIST, '使用说明.txt'),
  // Written as UTF-8 with a BOM: this file is Chinese prose that people open
  // in Notepad, and older Windows still guesses the code page without it.
  // ('ascii' here would silently truncate every Chinese character.)
  '\uFEFF' + [
    'mdview —— 本地 Markdown 查看器（单文件版）',
    '',
    '【怎么装】',
    '  右键 portable-install.ps1 -> 使用 PowerShell 运行。',
    '  或者在 PowerShell 里执行：',
    '      powershell -NoProfile -ExecutionPolicy Bypass -File portable-install.ps1',
    '',
    '  它只做一件事：把本目录里的 mdview.exe 注册成 .md 文件的打开方式。',
    '  不需要管理员权限，不改系统目录，随时可以卸载（加 -Remove）。',
    '',
    '【不需要装 Node.js】',
    '  mdview.exe 里已经内含运行时，约 ' + (exeSize / 1048576).toFixed(0) + ' MB。',
    '',
    '【怎么用】',
    '  装好后双击任意 .md 文件即可。',
    '  也可以把 md 文件拖到 mdview.exe 上，或在命令行里：',
    '      mdview.exe "D:\\笔记\\某个文件.md"',
    '',
    '【注意】',
    '  1. 仅适用于 Windows 64 位。',
    '  2. 安装时请把整个文件夹放在以后不会挪动的位置 ——',
    '     注册表里的关联指向这个目录下的 mdview.exe。',
    '  3. 只监听 127.0.0.1，不联网；只允许读取你打开过的文件/目录。',
    '  4. 关掉浏览器标签页约 45 秒后，后台服务会自己退出。',
    '',
  ].join('\r\n'), 'utf8');

step('打包 zip');
const zipName = 'mdview-portable-' + VERSION + '.zip';
const zipPath = path.join(DIST, zipName);
// 单引号转义：路径里万一有 ' 也不会把 PowerShell 命令拼坏
const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const zipEntries = [
  path.join(DIST, 'mdview.exe'),
  path.join(DIST, 'mdview-silent.vbs'),      // 无窗口启动器，缺了会退化成闪黑框
  path.join(DIST, 'mdview-launch.cmd'),
  path.join(DIST, 'portable-install.ps1'),
  path.join(DIST, '使用说明.txt'),
  path.join(DIST, 'README.md'),
  path.join(DIST, 'sample.md'),
];
// 缺文件直接失败：静默跳过会让 zip 少东西而没人发现（vbs 就这么丢过一次）。
const missing = zipEntries.filter((p) => !fs.existsSync(p));
if (missing.length) {
  log('  zip 清单缺文件，已中止：' + missing.map((p) => path.basename(p)).join(', '));
  throw new Error('zip entries missing');
}
try {
  execFileSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    'Compress-Archive -Path ' + zipEntries.map(psQuote).join(',') +
      ' -DestinationPath ' + psQuote(zipPath) + ' -Force',
  ], { stdio: 'inherit' });
  log('  ' + zipName + ': ' + (fs.statSync(zipPath).size / 1048576).toFixed(1) + ' MB');
} catch (e) {
  log('  zip 打包失败（不影响 exe 本身）：' + e.message);
}

step('完成');
for (const f of fs.readdirSync(DIST).sort()) {
  const st = fs.statSync(path.join(DIST, f));
  log('  dist/' + f.padEnd(32) + (st.size / 1024).toFixed(0) + ' KB');
}
console.log('\n把 dist/ 整个目录（或那个 zip）发给别人即可。对方不需要装 Node。');
