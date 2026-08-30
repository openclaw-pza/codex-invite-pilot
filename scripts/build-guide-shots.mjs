// build-guide-shots.mjs — 生成说明页（help.html）用的图文教程截图
//
// 为什么要有这个脚本：安哥的原话是说明页「点进去太过单一，让人找不到着重点，没有图文讲解」。
// 手动截图的问题是**会过期**——页面一改版，教程图还停在老样子，比没有图更误导人。
// 所以截图必须能一条命令重新生成，跟着代码一起走。
//
// 三条硬约束：
//   1. **绝不真的取号**。取号会扣真钱。等码/收码那两张图靠 page.route() 拦截
//      /api/vend/number 和 /api/vend/status 造出来 —— 走的是真实前端代码路径，
//      只是上游的回答是假的。图注里写明是示意图。
//   2. **绝不碰生产库**。用 scratchpad 里的临时 sqlite，跑完删掉。
//   3. 截图带标注（金色序号圈）。参考站（语雀那份）就是靠截图上的红框箭头讲清楚的，
//      纯截图对小白没用——他不知道该看哪儿。
//
// 用法：node scripts/build-guide-shots.mjs

import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startVendServer } from '../server/vend-server.js';
import { CardStore } from '../server/cards.js';

import { dirname as _dirname, join as _join } from 'node:path';
import { fileURLToPath as _fileURLToPath } from 'node:url';
// 仓库根由脚本自身位置算出，不写死 —— 写死的话别人 clone 到任何别的目录都跑不了。
const ROOT = _join(_dirname(_fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/');

const OUT = `${ROOT}/public/vend/guide`;
const TMP = 'C:/WINDOWS/TEMP/claude/D----/fae349b8-7916-464f-82e6-ab335a208072/scratchpad/guide-db';
const PORT = 8791;

mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });
const DB = join(TMP, 'guide.sqlite');
for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB + suffix)) rmSync(DB + suffix);
}

// ---------- 假的取号快照。字段照着 vend-routes.js 的 snapshot() 来 ----------
const PHONE = '+639123456789';
const startedAt = Date.now() - 42_000;
const baseSnapshot = (activationOverrides = {}) => ({
  denomCny: 1.9,
  service: 'dr',
  lockedService: null,
  status: 'active',
  changes: 0,
  maxChanges: null,
  orders: 1,
  maxOrders: null,
  refundState: null,
  activation: {
    phone: PHONE,
    country: 4,
    service: 'dr',
    state: 'waiting',
    smsCode: null,
    smsText: null,
    priceCny: 0.28,
    startedAt,
    expiresAt: startedAt + 20 * 60 * 1000,
    remainingMs: startedAt + 20 * 60 * 1000 - Date.now(),
    ...activationOverrides,
  },
});

// ---------- 标注：在元素旁边画一个金色序号圈 ----------
//
// 必须传**真函数**给 page.evaluate。传字符串时 Playwright 只是把它当表达式求值，
// 后面那个参数根本不会喂进去 —— 第一版就是这么写的，结果一个标注圈都没画出来，
// 脚本还全程 0 报错（它连函数体都没执行）。
function markFn(items) {
  document.querySelectorAll('.guide-mark').forEach((n) => n.remove());
  for (const { selector, n, dx = 0, dy = 0, at = 'left' } of items) {
    const el = document.querySelector(selector);
    if (!el) { console.warn('标注找不到元素', selector); continue; }
    const r = el.getBoundingClientRect();
    const dot = document.createElement('div');
    dot.className = 'guide-mark';
    dot.textContent = String(n);
    const x = at === 'right' ? r.right - 14 : r.left - 14;
    Object.assign(dot.style, {
      position: 'fixed', zIndex: 9999,
      left: (x + dx) + 'px', top: (r.top + r.height / 2 - 14 + dy) + 'px',
      width: '28px', height: '28px', borderRadius: '50%',
      display: 'grid', placeItems: 'center',
      background: 'linear-gradient(135deg,#F3D27A,#D9A62E)', color: '#221800',
      font: '700 15px ui-monospace, Consolas, monospace',
      boxShadow: '0 0 0 3px rgba(11,11,9,.9), 0 6px 18px rgba(0,0,0,.6)',
      pointerEvents: 'none',
    });
    document.body.append(dot);
    const ring = document.createElement('div');
    ring.className = 'guide-mark';
    Object.assign(ring.style, {
      position: 'fixed', zIndex: 9998,
      left: (r.left - 4) + 'px', top: (r.top - 4) + 'px',
      width: (r.width + 8) + 'px', height: (r.height + 8) + 'px',
      border: '2px solid #F3D27A', borderRadius: '12px',
      boxShadow: '0 0 0 9999px rgba(0,0,0,0)', pointerEvents: 'none',
    });
    document.body.append(ring);
  }
}

async function shot(page, name, clipSelector, marks = [], endSelector = null) {
  if (marks.length) await page.evaluate(markFn, marks);
  const target = clipSelector ? await page.$(clipSelector) : null;
  // 存 JPEG 不存 PNG：这些图是深色渐变的 UI 截图，PNG 无损要大 3~4 倍，
  // 而说明页一次要加载 7 张。q88 肉眼看不出差别。
  const file = join(OUT, name);
  const jpeg = { type: 'jpeg', quality: 88 };
  if (target) {
    const box = await target.boundingBox();
    // 有些面板比它的内容高得多（邮箱页就是），底边按内容的最后一块收一下，
    // 免得教程图里挂着一大片空白
    if (endSelector) {
      const endEl = await page.$(endSelector);
      const endBox = endEl && (await endEl.boundingBox());
      if (endBox) box.height = Math.max(120, endBox.y + endBox.height - box.y);
    }
    // 元素截图会把标注圈裁掉（标注画在元素外面），所以按 bounding box 外扩一圈截页面
    const pad = 30;
    await page.screenshot({
      path: file,
      ...jpeg,
      clip: {
        x: Math.max(0, box.x - pad),
        y: Math.max(0, box.y - pad),
        width: box.width + pad * 2,
        height: box.height + pad * 2,
      },
    });
  } else {
    await page.screenshot({ path: file, ...jpeg });
  }
  if (marks.length) await page.evaluate(() => document.querySelectorAll('.guide-mark').forEach((n) => n.remove()));
  console.log('  ->', name);
}

const server = await startVendServer({ dbPath: DB, port: PORT, host: '127.0.0.1' });
const base = `http://127.0.0.1:${PORT}`;
console.log('本地服务已起：' + base + '（临时库，跑完删）');

const store = new CardStore(DB);
const issued = store.issueCard({ denomCny: 1.9, service: 'dr', orderId: 'guide-shots', note: '教程截图专用' });
const CODE = issued.card.code;
console.log('教程用卡密：' + CODE.slice(0, 4) + '-****-****-' + CODE.slice(-4));

const browser = await chromium.launch();
// 1.5 倍够清晰，2 倍只是让教程图更大更沉（说明页最宽也就渲染到 816px）
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, locale: 'zh-CN' });
// 公告默认自动弹，会挡住所有截图；先按「今天不再弹」写进 localStorage
await ctx.addInitScript(`try { localStorage.setItem('vendAnnSkipDate',
  new Date().getFullYear() + '-' + (new Date().getMonth() + 1) + '-' + new Date().getDate()); } catch {}`);
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.warn('  [页面报错]', m.text()); });

await page.goto(base, { waitUntil: 'networkidle', timeout: 120_000 });
// 新皮把服务列表收进手风琴了，验卡密之前它是 display:none。
// 等「可见」会永远等不到，改成等**渲染出来**（数量 > 0）。
await page.waitForFunction(() => document.querySelectorAll('#svcList .row-svc').length > 0, { timeout: 120_000 });

// ---------- 第 1 步：粘卡密 ----------
console.log('第 1 步：卡密');
await page.fill('#cardInput', CODE);
await shot(page, 'step-1.jpg', '.rail-card', [
  { selector: '#cardInput', n: 1, at: 'left', dx: -6 },
  { selector: '#btnVerify', n: 2, at: 'right', dx: 20 },
]);

// ---------- 第 2 步：选服务 / 选地区 ----------
console.log('第 2 步：选服务 + 选地区');
await page.click('#btnVerify');
await page.waitForSelector('#cardOk:not([hidden])', { timeout: 30_000 });
await page.waitForTimeout(600);
await shot(page, 'step-2a.jpg', '#stepService', [
  { selector: '#svcSearch', n: 1, at: 'left', dx: -6 },
  { selector: '#svcList .row-svc:nth-child(2)', n: 2, at: 'right', dx: 20 },
]);

await page.click('#svcList .row-svc');
await page.waitForSelector('#regList .row-reg', { timeout: 120_000 });
await page.waitForTimeout(500);
// 地区按价格升序，'可用'全在前面、'余额不足'全在后面。
// 直接截第一屏只有一列'可用'，教程图注里说的②就没有对应物 ——
// 所以先滚到两者的交界处，让一张图里同时有这两种牌子。
await page.evaluate(() => {
  const short = document.querySelector('#regList .row-reg:has(.row-tag.short)');
  const list = document.getElementById('regList');
  if (!short || !list) return;
  list.scrollTop = Math.max(0, short.offsetTop - list.clientHeight + 130);
  // 标注是按 querySelector 找第一个匹配的元素画的，而第一条「可用」早被滚上去了，
  // 圈会画到可视区外面（第一版就是这么丢了 ①）。给交界处上面那条打个临时类，按类标。
  const prev = short.previousElementSibling?.querySelector('.row-tag');
  if (prev) prev.classList.add('guide-pick-ok');
});
await page.waitForTimeout(400);
await shot(page, 'step-2b.jpg', '#stepRegion', [
  { selector: '.guide-pick-ok', n: 1, at: 'right', dx: 22 },
  { selector: '#regList .row-reg .row-tag.short', n: 2, at: 'right', dx: 22 },
]);

// ---------- 补差价弹窗 ----------
console.log('补差价弹窗');
const overRow = await page.$('#regList .row-reg:has(.row-tag.short)');
if (overRow) {
  await overRow.click();
  await page.waitForSelector('#topupMask:not([hidden])', { timeout: 15_000 });
  await page.waitForTimeout(700);
  await shot(page, 'step-topup.jpg', '#topupMask .modal', [
    { selector: '#tcTopup', n: 1, at: 'right', dx: 22 },
    { selector: '.topup-copy', n: 2, at: 'left', dx: -8 },
  ]);
  await page.click('#btnTopupClose');
  await page.waitForTimeout(300);
} else {
  console.warn('  ! 当前没有超面额的地区，跳过补差价截图');
}

// ---------- 第 3 步：等码 / 收码（拦截上游，不真取号）----------
console.log('第 3 步：等码（mock，不真取号）');
let phase = 'waiting';
await page.route('**/api/vend/number', (route) => route.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({ ok: true, data: baseSnapshot() }),
}));
await page.route('**/api/vend/status*', (route) => route.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({ ok: true, data: phase === 'waiting' ? baseSnapshot() : baseSnapshot({ state: 'code', smsCode: '472913', smsText: 'Your OpenAI code is 472913' }) }),
}));

await page.click('#regList .row-reg:not(:has(.row-tag.short))');
await page.waitForTimeout(300);
await page.click('#btnPrimary');
await page.waitForSelector('body[data-state="waiting"]', { timeout: 20_000 });
await page.waitForTimeout(900);
await shot(page, 'step-3.jpg', '.stage', [
  { selector: '#btnCopyNum', n: 1, at: 'right', dx: 22 },
  { selector: '#cdLeft', n: 2, at: 'right', dx: 24 },
]);

// ---------- 收到码 ----------
console.log('收码态');
phase = 'code';
await page.waitForSelector('body[data-state="done"]', { timeout: 40_000 });
// 舞台变高之后页面会停在中段，截出来是半张图 —— 先滚回顶部
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(900);
await shot(page, 'step-4.jpg', '.stage', [{ selector: '#btnCopyCode', n: 1, at: 'right', dx: 22 }]);

// ---------- 临时邮箱 ----------
// 同样 mock：真去 Cloudflare 建邮箱会在账号里留下一个没人回收的地址，
// 而空的收件箱当教程图信息量等于零。
console.log('临时邮箱（mock，不真建邮箱）');
await page.unroute('**/api/vend/status*');
const DEMO_ADDR = 'demo7k2p@example.com';
await page.route('**/api/mail/create', (route) => route.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({ ok: true, data: { owner: 'demo', address: DEMO_ADDR, expiresAt: Date.now() + 3 * 86400000 } }),
}));
await page.route('**/api/mail/list*', (route) => route.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({ ok: true, data: { mails: [{
    id: 'demo-1', from: 'OpenAI <noreply@tm.openai.com>', subject: 'Your OpenAI verification code',
    receivedAt: '刚刚', code: '583014', links: [], body: 'Enter this code to finish signing up.',
  }] } }),
}));
// 上一步收码时弹的 toast 还挂在屏幕底下，会跑进邮箱教程图里
await page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.hidden = true; });
await page.click('.tab[data-go="mail"]');
await page.waitForTimeout(400);
await page.click('#btnNewMail');
await page.waitForSelector('.mail-item', { timeout: 15_000 });
await page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.hidden = true; });
await page.waitForTimeout(400);
await shot(page, 'step-mail.jpg', '.mail-inner', [
  { selector: '#btnNewMail', n: 1, at: 'right', dx: 22 },
  { selector: '.mail-code', n: 2, at: 'right', dx: 22 },
], '.inbox');

await browser.close();
store.close();
// startVendServer 返回的是 { server, store, port, close }，close() 自己是个 Promise
await server.close();
console.log('\n完成。图在 ' + OUT);
