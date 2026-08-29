// check-pages.mjs — 上线前用买家的条件把成品看一遍，并把「看出来的问题」固化成断言。
//
// 这个脚本存在的理由：上一轮我报了「24/24 断言全绿」，安哥打开是一堆裸 HTML。
// 断言绿 ≠ 产品对。所以这里两件事一起做：
//   1. 出**截图**给人眼看（chk-*.jpg，跑完自己去看）
//   2. 把已经踩过的坑变成会 exit 1 的断言，别让它们悄悄回来
//
// 已固化的坑（每条都对应一次真实事故）：
//   · 悬停放大不生效 —— .row 上的 animation 用了 fill-mode: both，
//     动画最后一帧的 transform:none 会永久压过 :hover 的 scale()，且零报错
//   · 移动端右侧内容被裁 —— body 是 flex 列容器，子项不给 min-width:0 的话，
//     深层一句 min-width:460px 会把整页顶宽；body 的 overflow-x:hidden 又把
//     滚动条藏了，于是表现成「右边一截看不见也够不着」
//   · 附属页面用了已被删掉的旧皮 token，整页没样式
//   · 公告里的竖版截图被塞进方框，二维码只占中间一小块
//
// 用法：node scripts/check-pages.mjs   （非零退出 = 有回归）

import { chromium } from 'playwright';
import { startVendServer } from '../server/vend-server.js';

const OUT = 'C:/WINDOWS/TEMP/claude/D----/fae349b8-7916-464f-82e6-ab335a208072/scratchpad';
const PORT = 8792;
const fails = [];
const notes = [];
const ok = (cond, label, detail = '') => {
  if (cond) { notes.push(`✔ ${label}${detail ? ' — ' + detail : ''}`); } else { fails.push(`✖ ${label}${detail ? ' — ' + detail : ''}`); }
};

const server = await startVendServer({ dbPath: OUT + '/guide-db/check.sqlite', port: PORT, host: '127.0.0.1' });
const base = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch();

// ============ 桌面：取号页 ============
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, locale: 'zh-CN' });
const errors = [];
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('requestfailed', (r) => errors.push('请求失败: ' + r.url().split('/').slice(3).join('/')));

await page.goto(base, { waitUntil: 'networkidle', timeout: 120_000 });
await page.waitForSelector('#annMask:not([hidden])', { timeout: 20_000 });
await page.waitForTimeout(1000);
await page.screenshot({ path: OUT + '/chk-ann.jpg', type: 'jpeg', quality: 88, clip: await (await page.$('#annMask .modal')).boundingBox() });

const annImgs = await page.evaluate(() => [...document.querySelectorAll('#annMask img')].map((i) => {
  const r = i.getBoundingClientRect();
  return { src: i.getAttribute('src'), natural: i.naturalWidth, boxW: Math.round(r.width), boxH: Math.round(r.height) };
}));
ok(annImgs.length >= 2, '公告里两张图都在', `${annImgs.length} 张`);
ok(annImgs.every((i) => i.natural > 0), '公告图片没有加载失败的', annImgs.filter((i) => !i.natural).map((i) => i.src).join(','));
const qr = annImgs.find((i) => /wechat/.test(i.src || ''));
ok(qr && Math.abs(qr.boxW - qr.boxH) <= 2, '微信二维码是正方形（铺满方框，不是硬塞进去的竖版截图）', qr ? `${qr.boxW}x${qr.boxH}` : '找不到');
ok(/-sq\./.test(qr?.src || ''), '用的是重新裁过的方形二维码', qr?.src);
// 公告现在会高过一屏（宣传图完整显示，安哥要求不裁切、不做点击看大图）。
// 所以不再要求一屏放得下，改为验真正会出事的那两件：
//   1. flex 居中 + 内容溢出时，弹窗顶部会被裁到视口外面、往上滚不到 —— 靠 .modal 的 margin:auto 解
//   2. 「我知道了」得真的点得到
const annGeo = await page.evaluate(() => {
  const mask = document.getElementById('annMask');
  mask.scrollTop = 0;
  const m = document.querySelector('#annMask .modal').getBoundingClientRect();
  return { h: Math.round(m.height), top: Math.round(m.top), scrollable: mask.scrollHeight > mask.clientHeight };
});
ok(annGeo.top >= -1, '公告滚到顶时没有被裁掉顶部（flex 居中溢出的经典坑）', 'top=' + annGeo.top + ' 高=' + annGeo.h + 'px');
await page.locator('#btnAnnOk').scrollIntoViewIfNeeded();
ok(await page.locator('#btnAnnOk').isVisible(), '「我知道了」够得着（弹窗高过一屏时能滚到）');
const annText = await page.evaluate(() => document.getElementById('annBody').textContent);
ok(/卡密余额不足/.test(annText) && /补差价/.test(annText), '公告里写了补差价说明');

await page.click('#btnAnnOk');
await page.waitForTimeout(900);

const geom = await page.evaluate(() => {
  const stage = document.querySelector('.stage').getBoundingClientRect();
  return {
    railW: Math.round(document.querySelector('.rail').getBoundingClientRect().width),
    stageH: Math.round(stage.height), stageBottom: Math.round(stage.bottom),
    bodyBg: getComputedStyle(document.body).backgroundColor,
  };
});
ok(geom.bodyBg === 'rgb(240, 238, 240)', '纸底生效（换皮后是浅色）', geom.bodyBg);
ok(geom.railW > 380 && geom.railW < 760, '左栏是 5:7 栅格的左半（不再是写死的 360）', String(geom.railW));
ok(geom.stageH > 300 && geom.stageH < 1000, '主舞台高度正常（没被 flex 撑爆）', `${geom.stageH}px`);

// ---- 悬停放大 ----
async function hoverRatio(sel) {
  const el = await page.$(sel);
  if (!el) return null;
  const before = await el.boundingBox();
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.waitForTimeout(420);
  const after = await el.boundingBox();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);
  return after.width / before.width;
}
// 服务列表收在手风琴里，先点开标题行才量得到
await page.evaluate(() => document.querySelector('.rail-step[data-step="svc"] .step-head')?.click());
await page.waitForTimeout(500);
const svcRatio = await hoverRatio('#svcList .row-svc:nth-child(3)');
ok(svcRatio > 1.015, '服务行鼠标悬停会放大', `${svcRatio?.toFixed(3)}x`);
const clipped = await page.evaluate(() => {
  const list = document.getElementById('svcList');
  const r = list.getBoundingClientRect();
  return [...list.querySelectorAll('.row-svc')].some((n) => n.getBoundingClientRect().right > r.right + 0.5);
});
ok(!clipped, '放大后没有行被列表右边界切掉');

// ---- 服务图标覆盖（首屏 40 条里有多少是真 logo）----
const iconStat = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#svcList .row-svc')];
  return { total: rows.length, real: rows.filter((r) => r.querySelector('.svc-ico img, .svc-ico svg')).length };
});
ok(iconStat.real / iconStat.total >= 0.7, '首屏服务图标以真实品牌图为主', `${iconStat.real}/${iconStat.total}`);

await page.screenshot({ path: OUT + '/chk-index.jpg', type: 'jpeg', quality: 86 });

// ============ 说明页 ============
const help = await ctx.newPage();
const helpErrors = [];
help.on('console', (m) => { if (m.type() === 'error') helpErrors.push('console: ' + m.text()); });
help.on('pageerror', (e) => helpErrors.push('pageerror: ' + e.message));
help.on('requestfailed', (r) => helpErrors.push('请求失败: ' + r.url().split('/').slice(3).join('/')));
await help.goto(base + '/help.html', { waitUntil: 'networkidle', timeout: 60_000 });
// 教程图是 loading="lazy" 的，不滚一遍下面那几张 naturalWidth 还是 0，
// 会误报成坏图（加了新章节把图推到更下面之后就踩到了）
await help.evaluate(async () => {
  for (let y = 0; y < document.documentElement.scrollHeight; y += 700) {
    window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 50));
  }
  window.scrollTo(0, 0);
});
await help.waitForTimeout(1500);
await help.screenshot({ path: OUT + '/chk-help-top.jpg', type: 'jpeg', quality: 86, clip: { x: 0, y: 0, width: 1440, height: 1500 } });

const h = await help.evaluate(() => {
  const exit = document.querySelector('.hbar-exit').getBoundingClientRect();
  const imgs = [...document.querySelectorAll('.shot img')].map((i) => ({ src: i.getAttribute('src').split('/').pop(), w: i.naturalWidth }));
  return {
    exitFromRight: Math.round(window.innerWidth - exit.right),
    exitFromLeft: Math.round(exit.left),
    exitText: document.querySelector('.hbar-exit').textContent.trim(),
    broken: imgs.filter((i) => !i.w).map((i) => i.src),
    imgCount: imgs.length,
    svc: document.getElementById('cSvc')?.textContent,
    ttl: document.getElementById('cTtl')?.textContent,
    mail: document.getElementById('cMail')?.textContent,
    change: document.getElementById('cChange')?.textContent || '',
    faqLd: (document.getElementById('faqLd')?.textContent || '').length,
    h1: [...document.querySelectorAll('h1')].length,
    unresolvedVars: [...document.querySelectorAll('.doc *')].filter((n) => {
      const c = getComputedStyle(n).color;
      return c === 'rgba(0, 0, 0, 0)';
    }).length,
    text: document.body.innerText,
  };
});
ok(h.exitFromRight < h.exitFromLeft, '退出键在右上角（不是左上角）', `距右 ${h.exitFromRight}px / 距左 ${h.exitFromLeft}px`);
ok(/✕/.test(h.exitText), '退出键带 ✕', h.exitText);
ok(h.imgCount >= 7 && h.broken.length === 0, '图文教程的截图都在且都加载成功', `${h.imgCount} 张，坏图 ${h.broken.join(',') || '无'}`);
ok(h.h1 === 1, '只有一个 h1', String(h.h1));
ok(h.faqLd > 200, 'FAQ 结构化数据是按页面真实问答生成的', `${h.faqLd} 字符`);
ok(h.svc && Number(h.svc) > 400, '服务总数取的是实时值', h.svc);
ok(h.mail === '3', '邮箱有效期跟着配置走', h.mail + ' 天');
ok(/90 秒/.test(h.change) && !/最多换 5 次/.test(h.change), '换号规则文案是当前配置（不是老的「最多 5 次」）', h.change.slice(0, 46));
ok(!/24 小时/.test(h.text), '正文里没有残留「邮箱 24 小时失效」的旧说法');
ok(/卡密余额不足/.test(h.text) && /备注卡密后 4 位/.test(h.text), '说明页写了补差价流程');

await help.evaluate(() => document.getElementById('budget').scrollIntoView());
await help.waitForTimeout(500);
await help.screenshot({ path: OUT + '/chk-help-budget.jpg', type: 'jpeg', quality: 86 });

// ============ 移动端 390：两页都不许横向溢出 ============
// 注意：body 上有 overflow-x:hidden，溢出不会表现成滚动条，
// 而是**右边一截被裁掉、够不着**，所以必须看 scrollWidth 而不是「有没有滚动条」。
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN' });
for (const [name, path] of [['取号页', '/'], ['说明页', '/help.html']]) {
  const mp = await m.newPage();
  await mp.goto(base + path, { waitUntil: 'networkidle', timeout: 120_000 });
  await mp.waitForTimeout(900);
  await mp.evaluate(() => document.getElementById('btnAnnOk')?.click());
  await mp.waitForTimeout(900);
  const r = await mp.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const over = [...document.querySelectorAll('*')]
      .filter((el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.right > vw + 1; })
      .slice(0, 4)
      .map((el) => el.tagName.toLowerCase() + '.' + (el.className || '').toString().split(' ')[0]);
    return { scrollW: document.documentElement.scrollWidth, vw, over };
  });
  ok(r.scrollW <= r.vw + 1, `${name} 移动端 390 不横向溢出`, `scrollWidth=${r.scrollW} 视口=${r.vw}${r.over.length ? ' 溢出元素: ' + r.over.join(', ') : ''}`);
  await mp.screenshot({ path: `${OUT}/chk-390-${path === '/' ? 'index' : 'help'}.jpg`, type: 'jpeg', quality: 84 });
  await mp.close();
}

// ============ 不跑 JS 的爬虫（GPTBot / ClaudeBot 都不跑）拿到什么 ============
// robots.txt 专门放行了这些爬虫，所以「关掉 JS 还剩什么」就是它们看到的全部。
const nojs = await browser.newContext({ viewport: { width: 1280, height: 900 }, javaScriptEnabled: false, locale: 'zh-CN' });
for (const [name, p] of [['取号页', ''], ['说明页', 'help.html']]) {
  const np = await nojs.newPage();
  await np.goto(base + '/' + p, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const r = await np.evaluate(() => {
    let ld = null;
    try { ld = JSON.parse(document.getElementById('faqLd')?.textContent || 'null'); } catch { ld = 'PARSE_ERROR'; }
    const qs = ld && ld !== 'PARSE_ERROR' ? (ld.mainEntity || []).map((q) => q.name) : [];
    const text = document.body.innerText;
    return {
      compat: document.compatMode,
      doctype: Boolean(document.doctype),
      lang: document.documentElement.lang,
      faqCount: qs.length,
      missing: qs.filter((q) => !text.includes(q)),
      detailsCount: document.querySelectorAll('#faq details, .qa details').length,
      stale: [/722 个/, /180 个国家/, /最多换 5 次/, /最多可换 5 次/, /24 小时后自动失效/]
        .filter((re) => re.test(text)).map(String),
    };
  });
  ok(r.doctype && r.compat === 'CSS1Compat', name + ' 是标准模式（有 doctype，不是 quirks）', r.compat);
  ok(r.lang === 'zh-CN', name + ' 有 html lang', r.lang || '(空)');
  ok(r.faqCount >= 6, name + ' 关掉 JS 也有 FAQ 结构化数据', r.faqCount + ' 条');
  ok(r.missing.length === 0, name + ' 结构化数据的每一问在页面上都看得见', r.missing.slice(0, 2).join(' / '));
  ok(r.detailsCount >= 6, name + ' 关掉 JS 也能看到 FAQ 正文', r.detailsCount + ' 条');
  ok(r.stale.length === 0, name + ' 没有残留过期数字（722/180/5 次/24 小时）', r.stale.join(' '));
  await np.close();
}

ok(errors.length === 0, '取号页零控制台报错', errors.slice(0, 3).join(' | '));
ok(helpErrors.length === 0, '说明页零控制台报错', helpErrors.slice(0, 3).join(' | '));

await browser.close();
await server.close();

console.log(notes.join('\n'));
if (fails.length) {
  console.log('\n' + fails.join('\n'));
  console.log(`\n${fails.length} 项没过。截图在 ${OUT}\\chk-*.jpg，自己去看一眼再改。`);
  process.exit(1);
}
console.log(`\n全部 ${notes.length} 项通过。截图在 ${OUT}\\chk-*.jpg —— 断言绿不等于产品对，还是要看图。`);
