// 从入口出发算出真正需要的服务端文件。
// 扫目录会多传（把别的项目的文件也带上去），手挑会漏传（上次漏了 mime.js）。
// 只有按 import 图谱算才两头都不错。
import { readFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';

const ROOT = 'F:/sms-project';
const ENTRY = `${ROOT}/server/vend-server.js`;
const seen = new Set();

function walk(file) {
  const abs = resolve(file).replace(/\\/g, '/');
  if (seen.has(abs)) return;
  seen.add(abs);
  let src = '';
  try { src = readFileSync(abs, 'utf8'); } catch { return; }
  const re = /(?:^|\n)\s*(?:import|export)[^'"]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const spec = m[1] || m[2];
    walk(resolve(dirname(abs), spec));
  }
}

walk(ENTRY);
const files = [...seen]
  .map((f) => relative(ROOT, f).replace(/\\/g, '/'))
  .filter((f) => f.startsWith('server/'))
  .sort();
console.log(files.join('\n'));
