// build-bookmarklet.cjs — 把 fill.src.js 压成一行 javascript: URL，写进向导页。
//
// 为什么要构建这一步：书签的 href 必须是**单行**、URL 编码过的 javascript:，
// 手写维护不了（几百行代码挤成一行没法读也没法改）。
// 源码留在 fill.src.js 里正常写、正常加注释，构建时才压。
//
// 用法：node scripts/build-bookmarklet.cjs [https://sms.tempmail2026.xyz]

const fs = require('fs');

const ORIGIN = process.argv[2] || 'https://sms.tempmail2026.xyz';
const SRC = 'F:/sms-project/public/vend/fill.src.js';
const HTML = 'F:/sms-project/public/vend/index.html';

let code = fs.readFileSync(SRC, 'utf8');
code = code.replace('__RELAY_ORIGIN__', ORIGIN);

// 极简压缩：只去注释和行首缩进。不做变量改名 ——
// 书签坏掉的时候买家帮不上忙，我们得能一眼看懂那串东西，
// 为省几百字节把可读性全丢掉不划算（书签 URL 长度没有实际瓶颈）。
const min = code
  .split('\n')
  .map((line) => line.replace(/^\s+/, ''))
  .filter((line) => line && !line.startsWith('//'))
  .join('')
  // 行内注释：只处理明显安全的整段 /* */，不碰 // 以免切坏正则里的斜杠
  .replace(/\/\*[\s\S]*?\*\//g, '');

// 语法闸。压缩是「按行拼起来」，靠的是源码每句都有分号 —— 哪天少写一个分号，
// 拼完就是语法错误，而书签坏掉是**静默**的（买家点了没反应，不会有任何报错给我们）。
// 所以构建时必须真解析一遍。
try {
  // eslint-disable-next-line no-new-func
  new Function(min);
} catch (error) {
  console.error(`✖ 压缩后的书签代码语法错误：${error.message}`);
  console.error('  多半是 fill.src.js 里某句结尾少了分号 —— 去掉换行之后 ASI 就救不了了。');
  process.exit(1);
}

const href = `javascript:${encodeURIComponent(min)}`;

// 长度闸：书签 URL 各浏览器上限不同，超过 ~64KB 有风险。
// 现在离得很远，但加一道闸免得以后闷声超标。
if (href.length > 60000) {
  console.error(`✖ 书签太长了（${href.length} 字符），浏览器可能存不下`);
  process.exit(1);
}

let html = fs.readFileSync(HTML, 'utf8');
const RE = /(<a class="cx-bm" id="cxBm" href=")[^"]*(")/;
if (!RE.test(html)) {
  console.error('✖ index.html 里找不到 id="cxBm" 的书签链接，先把标记加上');
  process.exit(1);
}
html = html.replace(RE, `$1${href.replace(/\$/g, '$$$$')}$2`);
fs.writeFileSync(HTML, html, 'utf8');

console.log(`书签已写入 index.html：源 ${min.length} 字符 → href ${href.length} 字符，relay=${ORIGIN}`);
