/*
 * One command for every regression that does not need a browser.
 *
 *   node tools/run-tests.mjs          # render + recents + invisible chars + xss + security
 *   node tools/run-tests.mjs --exit   # also "closing the tab retires the server" (~60s)
 *
 * Boots a private server on a free port with its own MDVIEW_HOME under the OS
 * temp directory, runs the checks against it, and always tears it down —
 * so the suite never touches %LOCALAPPDATA%\mdview or a viewer you have open.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server.mjs');
const FIXTURE = path.join(ROOT, 'examples', 'test-fixture.md');
const WITH_EXIT = process.argv.includes('--exit');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mdview-test-'));
const logPath = path.join(home, 'server.log');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ask the OS for a port nobody is using, then release it for the server. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function run(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', script), ...args], {
      stdio: 'inherit',
      env: { ...process.env, MDVIEW_HOME: home },
    });
    // 每个套件单独限时：BOM 死循环那类回归会让子进程永久卡住，
    // 不设超时就要等 CI 的 job 上限（数小时）才失败。
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      resolve(124);
    }, 180000);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code === null ? 1 : code); });
    child.on('error', () => { clearTimeout(timer); resolve(1); });
  });
}

async function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/health');
      if (res.ok) return true;
    } catch { /* not listening yet */ }
    await sleep(150);
  }
  return false;
}

async function main() {
  const port = await freePort();
  const log = fs.openSync(logPath, 'a');
  const server = spawn(process.execPath, [SERVER, 'serve', '--port', String(port), FIXTURE], {
    // MDVIEW_NO_OPEN：测试里不要真的把系统默认程序拉起来（会弹记事本/浏览器）。
    env: { ...process.env, MDVIEW_HOME: home, MDVIEW_NO_OPEN: '1' },
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  fs.closeSync(log);

  let failures = 0;
  const suites = [
    ['render', 'check/render.mjs', [String(port)]],
    ['recents', 'check/recents.mjs', [String(port)]],
    ['bom', 'check/bom.mjs', []],
    ['bom-e2e', 'check/bom-e2e.mjs', [String(port), path.join(ROOT, 'examples', 'bom-sample.md')]],
    ['xss-fuzz', 'check/xss-fuzz.mjs', []],
    ['security', 'check/security.mjs', [String(port)]],
  ];

  try {
    if (!await waitForHealth(port, 10000)) {
      console.error('\n[run-tests] the server never came up. Last lines of ' + logPath + ':\n');
      try {
        const tail = fs.readFileSync(logPath, 'utf8').trim().split('\n').slice(-15).join('\n');
        console.error(tail);
      } catch { /* nothing to show */ }
      return 1;
    }
    console.log('server: http://127.0.0.1:' + port + '\n');

    for (const [name, script, args] of suites) {
      console.log('--- ' + name + ' ---');
      const code = await run(script, args);
      if (code !== 0) {
        failures++;
        console.error('--- ' + name + ' failed (exit ' + code + ') ---\n');
      }
    }

    if (WITH_EXIT) {
      console.log('--- tab-exit (waits up to 75s) ---');
      const code = await run('check/tab-exit.mjs', [String(port)]);
      if (code !== 0) {
        failures++;
        console.error('--- tab-exit failed (exit ' + code + ') ---\n');
      }
    }
  } finally {
    // Harmless when the tab-exit check already retired the server.
    try {
      await fetch('http://127.0.0.1:' + port + '/api/shutdown', {
        method: 'POST', headers: { 'X-Mdview': '1' },
      });
    } catch { /* already gone */ }
    await sleep(300);
    try { server.kill(); } catch { /* already gone */ }
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  if (failures) {
    console.error('\n' + failures + ' suite(s) failed');
    return 1;
  }
  console.log('\nall suites passed');
  return 0;
}

process.exitCode = await main();
