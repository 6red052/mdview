/*
 * Verifies the tab-driven exit behaviour against a running mdview server.
 *
 *   node tools/tab-exit-check.mjs [port]
 *
 * Sequence:
 *   1. open a page            -> server must report 1 live tab
 *   2. simulate a 2nd tab     -> keepalive?tabs=2 -> server reports 2
 *   3. second tab closes      -> bye?tabs=1       -> server reports 1
 *   4. last tab closes        -> bye?last=1       -> server must exit by itself
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || 7799);
const base = 'http://127.0.0.1:' + port;
const fixture = process.argv[3] || path.join(repoRoot, 'examples', 'test-fixture.md');

const health = async () => {
  const r = await fetch(base + '/health');
  if (!r.ok) throw new Error('health ' + r.status);
  return r.json();
};

const ping = async (path) => {
  // /api/keepalive 与 /api/bye 现在都要求自定义头（页面就是用 fetch 带的）
  const r = await fetch(base + path, { method: 'POST', headers: { 'X-Mdview': '1' } });
  if (!r.ok) throw new Error(path + ' -> ' + r.status);
  return r.json();
};

let failures = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + '  (期望 ' + expected + '，实际 ' + actual + ')');
};

console.log('--- 1. 页面加载后应有 1 个活动标签页 ---');
await fetch(base + '/view?f=' + encodeURIComponent(fixture));
let h = await health();
check('liveTabs', h.liveTabs, 1);
check('noTabsMs 不大（说明标签页活动是新鲜的）', h.noTabsMs < 15000, true);

console.log('--- 2. 第二个标签页加入 ---');
await ping('/api/keepalive?tabs=2');
h = await health();
check('liveTabs', h.liveTabs, 2);

console.log('--- 3. 第二个标签页关闭，还剩一个 ---');
await ping('/api/bye?tabs=1');
h = await health();
check('liveTabs', h.liveTabs, 1);

console.log('--- 4. 最后一个标签页关闭，服务应自行退出 ---');
await ping('/api/bye?last=1');
h = await health();
check('liveTabs', h.liveTabs, 0);
console.log('  等待服务自行退出（宽限 45s，每秒探测一次）...');

const deadline = Date.now() + 75000;
let goneAt = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    await health();
  } catch {
    goneAt = Math.round((Date.now() - (deadline - 75000)) / 1000);
    break;
  }
}
if (goneAt === null) {
  failures++;
  console.log('  FAIL  服务在 75 秒内没有退出');
} else {
  console.log('  PASS  服务已自动退出，用时约 ' + goneAt + ' 秒');
}

// state file should have been cleaned up by the server on exit
const fs = await import('node:fs');
const statePath = (process.env.MDVIEW_HOME || '') + '\\server.json';
if (process.env.MDVIEW_HOME) {
  const exists = fs.existsSync(statePath);
  check('退出时清理了 server.json', exists, false);
}

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过'));
process.exitCode = failures ? 1 : 0;
