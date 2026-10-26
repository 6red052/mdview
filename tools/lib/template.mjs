/*
 * 从 server.mjs 里抠出内嵌的 String.raw 模板（HIGHLIGHT_JS / MD_CORE_JS / ...）。
 *
 * 三个测试脚本本来各有一份完全相同的实现，改 server.mjs 的字符串写法时很容易
 * 只改到其中一两份。抽到这里，只有一份需要维护。
 *
 *   import { createGrabber } from './lib/template.mjs';
 *   const grabTemplate = createGrabber(src);   // src = server.mjs 的内容
 *   const js = grabTemplate('MD_CORE_JS');
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 读仓库根目录下的 server.mjs。传当前文件的 import.meta.url。 */
export function readServerSource(metaUrl) {
  const serverPath = path.resolve(path.dirname(fileURLToPath(metaUrl)), '..', 'server.mjs');
  return fs.readFileSync(serverPath, 'utf8');
}

/** 抠出 `const <key> = String.raw\`...\`` 里的内容，并还原被转义的反引号 / ${。 */
export function createGrabber(src) {
  return function grabTemplate(key) {
    const start = src.indexOf('const ' + key + ' = String.raw`');
    if (start < 0) throw new Error('server.mjs 里找不到模板 ' + key);
    const from = src.indexOf('`', start) + 1;
    let i = from;
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '`') break;
      i += 1;
    }
    return src.slice(from, i).replace(/\\`/g, '`').replace(/\\\$\{/g, '${');
  };
}
