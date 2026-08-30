// check-prod.mjs — 线上复验，**带缓存的回访**。
//
// 上一轮翻车的根因就在这里：我每次都用全新的无缓存浏览器验收，而真实买家是
// 带着上一版缓存回来的。CDN 把源站的 no-cache 覆写成 max-age=14400，
// 于是回访拿到「新 HTML + 旧 CSS」，页面稀烂 —— 而我的验收永远是绿的。
//
// 所以这个脚本用 launchPersistentContext（磁盘 profile）跑两遍：
// 第一遍种缓存，第二遍才是真正的验收条件。
//
// 用法：node scripts/check-prod.mjs [url]

import { chromium } from 'playwright';
import { rmSync, mkdirSync } from 'node:fs';

// 不给默认值：这个脚本会**真的发请求**。默认值指向作者的生产站，
// 意味着任何人不带参数跑一次，都是在探别人的服务器。
const URL = process.argv[2];
if (!URL) {
  console.error('用法：node scripts/check-prod.mjs https://你的站点/');
  process.exit(2);
}
const PROFILE = 'C:/WINDOWS/TEMP/claude/D----/fae349b8-7916-464f-82e6-ab335a208072/scratchpad/prod-profile';
const OUT = 'C:/WINDOWS/TEMP/claude/D----/fae349b8-7916-464f-82e6-ab335a208072/scratchpad';

try { rmSync(PROFILE, { recursive: true, force: true }); } catch { /* 首次没有 */ }
mkdirSync(PROFILE, { recursive: true });

const fails = [];
const notes = [];
const ok = (c, label, detail = '') => (c ? notes : fails).push(`${c ? '✔' : '✖'} ${label}${detail ? ' — ' + detail : ''}`);

const ctx = await chromium.launchPersistentContext(PROFILE, {
  viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, locale: 'zh-CN',
});

// ---------- 第一遍：种缓存 ----------
const warm = await ctx.newPage();
await warm.goto(URL, { waitUntil: 'networkidle', timeout: 120_000 });
await warm.goto(URL + 'help.html', { waitUntil: 'networkidle', timeout: 90_000 });
await warm.close();

// ---------- 第二遍：这才是买家的真实条件 ----------
const errors = [];
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('requestfailed', (r) => errors.push('请求失败: ' + r.url().split('/').slice(3).join('/')));

const served = [];
page.on('response', (r) => {
  const u = r.url();
  if (/\.(css|js)(\?|$)/.test(u)) served.push({ u: u.split('/').pop(), status: r.status(), from: r.request().timing ? '' : '' });
});

await page.goto(URL, { waitUntil: 'networkidle', timeout: 120_000 });
// 服务列表收在手风琴里，验卡密之前是 display:none —— 等「可见」永远等不到
await page.waitForFunction(() => document.querySelectorAll('#svcList .row-svc').length > 0, { timeout: 60_000 });
// 量悬停放大之前要先把这一步点开
await page.evaluate(() => document.querySelector('.rail-step[data-step="svc"] .step-head')?.click());
await page.waitForTimeout(600);
await page.waitForTimeout(1200);

const st = await page.evaluate(() => {
  const stage = document.querySelector('.stage')?.getBoundingClientRect();
  return {
    bg: getComputedStyle(document.body).backgroundColor,
    railW: Math.round(document.querySelector('.rail')?.getBoundingClientRect().width || 0),
    stageH: Math.round(stage?.height || 0),
    rows: document.querySelectorAll('#svcList .row-svc').length,
    iconsReal: [...document.querySelectorAll('#svcList .row-svc')].filter((r) => r.querySelector('.svc-ico img, .svc-ico svg')).length,
    flags: document.querySelectorAll('#regList .flag img').length,
    tagOk: document.querySelectorAll('#svcList .row-tag').length,
    hasPrice: /起|¥/.test([...document.querySelectorAll('#svcList .row-svc')].map((r) => r.textContent).join('')),
    css: [...document.styleSheets].map((s) => (s.href || '').split('/').pop()).filter(Boolean),
  };
});
ok(st.bg === 'rgb(240, 238, 240)', '带缓存回访：新皮正常加载（不是裸 HTML）', st.bg);
ok(st.railW > 380 && st.railW < 760, '左栏是 5:7 栅格的左半', String(st.railW));
ok(st.stageH > 300 && st.stageH < 1000, '主舞台高度正常', `${st.stageH}px`);
ok(st.css.some((c) => /vend\.css\?v=[0-9a-f]{8}/.test(c)), 'CSS 带内容哈希（回访不会拿到旧样式）', st.css.join(','));
ok(st.iconsReal / Math.max(1, st.rows) >= 0.7, '服务图标以真实品牌图为主', `${st.iconsReal}/${st.rows}`);
ok(!st.hasPrice, '服务列表不再显示价格');

const annOpen = await page.$('#annMask:not([hidden])');
ok(Boolean(annOpen), '公告会自动弹出');
if (annOpen) {
  const ann = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('#annMask img')].map((i) => ({ src: i.getAttribute('src'), w: i.naturalWidth, boxW: Math.round(i.getBoundingClientRect().width), boxH: Math.round(i.getBoundingClientRect().height) }));
    return { imgs, h: Math.round(document.querySelector('#annMask .modal').getBoundingClientRect().height), text: document.getElementById('annBody').textContent };
  });
  ok(ann.imgs.every((i) => i.w > 0), '公告三张图都加载成功', ann.imgs.map((i) => `${i.src}:${i.w}`).join(' '));
  const qr = ann.imgs.find((i) => /wechat/.test(i.src));
  ok(qr && qr.boxW === qr.boxH, '微信码铺满方框', qr ? `${qr.boxW}x${qr.boxH}` : '找不到');
  ok(/卡密余额不足/.test(ann.text), '公告写了补差价说明');
  ok(ann.h > 400, '公告内容完整渲染', ann.h + 'px');
  await page.screenshot({ path: OUT + '/prod-ann.jpg', type: 'jpeg', quality: 88, clip: await (await page.$('#annMask .modal')).boundingBox() });
  await page.click('#btnAnnOk');
  await page.waitForTimeout(900);
}

// 悬停放大
const row = await page.$('#svcList .row-svc:nth-child(3)');
const b1 = await row.boundingBox();
await page.mouse.move(b1.x + b1.width / 2, b1.y + b1.height / 2);
await page.waitForTimeout(420);
const b2 = await row.boundingBox();
ok(b2.width / b1.width > 1.015, '鼠标悬停放大生效', `${(b2.width / b1.width).toFixed(3)}x`);
await page.mouse.move(5, 5);
await page.screenshot({ path: OUT + '/prod-index.jpg', type: 'jpeg', quality: 86 });

// ---------- 说明页 ----------
const helpErrors = [];
const help = await ctx.newPage();
help.on('console', (m) => { if (m.type() === 'error') helpErrors.push('console: ' + m.text()); });
help.on('requestfailed', (r) => helpErrors.push('请求失败: ' + r.url().split('/').slice(3).join('/')));
await help.goto(URL + 'help.html', { waitUntil: 'networkidle', timeout: 90_000 });
// 教程图 loading=lazy，不滚一遍下面几张的 naturalWidth 还是 0，会误报坏图
await help.evaluate(async () => {
  for (let y = 0; y < document.documentElement.scrollHeight; y += 700) {
    window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 50));
  }
  window.scrollTo(0, 0);
});
await help.waitForTimeout(1800);
const h = await help.evaluate(() => {
  const exit = document.querySelector('.hbar-exit')?.getBoundingClientRect();
  const imgs = [...document.querySelectorAll('.shot img')].map((i) => ({ s: i.getAttribute('src').split('/').pop(), w: i.naturalWidth }));
  return {
    bg: getComputedStyle(document.body).backgroundColor,
    exitFromRight: exit ? Math.round(window.innerWidth - exit.right) : -1,
    exitFromLeft: exit ? Math.round(exit.left) : -1,
    broken: imgs.filter((i) => !i.w).map((i) => i.s),
    imgCount: imgs.length,
    svc: document.getElementById('cSvc')?.textContent,
    change: document.getElementById('cChange')?.textContent || '',
    faqLd: (document.getElementById('faqLd')?.textContent || '').length,
  };
});
ok(h.bg === 'rgb(240, 238, 240)', '说明页跟着换了皮（不是没样式的白页）', h.bg);
ok(h.exitFromRight >= 0 && h.exitFromRight < h.exitFromLeft, '说明页退出键在右上角', `距右 ${h.exitFromRight} / 距左 ${h.exitFromLeft}`);
ok(h.imgCount >= 7 && h.broken.length === 0, '教程截图全部加载成功', `${h.imgCount} 张，坏图 ${h.broken.join(',') || '无'}`);
ok(/90 秒/.test(h.change), '换号文案取的是线上配置', h.change.slice(0, 40));
ok(h.faqLd > 200, 'FAQ 结构化数据已生成', h.faqLd + ' 字符');
await help.screenshot({ path: OUT + '/prod-help.jpg', type: 'jpeg', quality: 86, clip: { x: 0, y: 0, width: 1440, height: 1400 } });

// ---------- 移动端 390 ----------
const m = await ctx.newPage();
await m.setViewportSize({ width: 390, height: 844 });
for (const [name, p] of [['取号页', ''], ['说明页', 'help.html']]) {
  await m.goto(URL + p, { waitUntil: 'networkidle', timeout: 90_000 });
  await m.waitForTimeout(1000);
  await m.evaluate(() => document.getElementById('btnAnnOk')?.click());
  await m.waitForTimeout(800);
  const r = await m.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth }));
  ok(r.sw <= r.vw + 1, `${name} 移动端不横向溢出`, `${r.sw}/${r.vw}`);
}
await m.screenshot({ path: OUT + '/prod-390.jpg', type: 'jpeg', quality: 84 });

ok(errors.length === 0, '取号页带缓存回访零控制台报错', errors.slice(0, 3).join(' | '));
ok(helpErrors.length === 0, '说明页零控制台报错', helpErrors.slice(0, 3).join(' | '));

await ctx.close();
console.log(notes.join('\n'));
if (fails.length) { console.log('\n' + fails.join('\n')); process.exit(1); }
console.log(`\n线上 ${notes.length} 项全过（带缓存回访条件）。截图：${OUT}\\prod-*.jpg`);
