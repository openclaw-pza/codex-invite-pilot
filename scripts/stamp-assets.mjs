// 给静态资源 URL 打内容哈希（?v=xxxxxxxx）。
//
// 为什么必须做：HTML 是 no-cache 每次都新，CSS/JS 被浏览器/CDN 缓存数小时。
// 一旦改版，回访用户拿到的是「新 HTML + 旧 CSS」—— 类名全对不上，页面稀烂。
// 2026-08-21 线上真出过这个事故：Cloudflare 把源站的 no-cache 覆写成 max-age=14400。
//
// 加了哈希之后，内容一变 URL 就变，旧缓存自然失效；也不再依赖任何 CDN 设置。
// 幂等：重复跑不会叠加参数。
//
// 用法：node scripts/stamp-assets.mjs   （部署前跑，deploy.sh 已自动调用）

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ROOT = 'F:/sms-project/public/vend';
const hash = (p) => createHash('sha256').update(readFileSync(join(ROOT, p))).digest('hex').slice(0, 8);

// 去掉已有的 ?v=，保证幂等
const strip = (s, file) =>
  s.replaceAll(new RegExp(`(${file.replace('.', '\\.')})\\?v=[0-9a-f]{8}`, 'g'), '$1');

function stamp(file, refs) {
  let s = readFileSync(join(ROOT, file), 'utf8');
  const before = s;
  for (const ref of refs) {
    s = strip(s, ref);
    const v = hash(ref);
    // 引用可能写成 "vend.css" 也可能写成 "./vend.css"，两种都要盖到；
    // 只替换带引号的引用位置，不碰注释里出现的同名文件。
    for (const q of ['"', "'"]) {
      s = s.replaceAll(`${q}${ref}${q}`, `${q}${ref}?v=${v}${q}`);
      s = s.replaceAll(`${q}./${ref}${q}`, `${q}./${ref}?v=${v}${q}`);
    }
  }
  if (s !== before) writeFileSync(join(ROOT, file), s);
  return s !== before;
}

// 顺序要紧：先把 icons.js 的哈希打进 vend.js，vend.js 内容变了再算它自己的哈希
const changed = [];
if (stamp('vend.js', ['icons.js'])) changed.push('vend.js -> icons.js');
if (stamp('index.html', ['vend.css', 'vend.js'])) changed.push('index.html -> vend.css/vend.js');
if (stamp('manage.html', ['vend.css', 'manage.js'])) changed.push('manage.html -> vend.css/manage.js');
if (stamp('help.html', ['vend.css', 'help.js'])) changed.push('help.html -> vend.css/help.js');

for (const file of ['index.html', 'manage.html', 'help.html', 'vend.js']) {
  const s = readFileSync(join(ROOT, file), 'utf8');
  const found = [...s.matchAll(/([\w.-]+\.(?:css|js))\?v=([0-9a-f]{8})/g)].map((m) => `${m[1]}@${m[2]}`);
  console.log(`${file}: ${found.length ? found.join(' ') : '（无引用）'}`);
}
console.log(changed.length ? `\n已打戳：${changed.join('、')}` : '\n没有需要更新的引用');
