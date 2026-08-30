#!/usr/bin/env node
// doc-shots.mjs — 给 README 和 docs 生成截图。
//
// 为什么做成脚本而不是手工截：
//   手工截的图会过期。改了界面之后没人记得重截，README 上挂着半年前的样子，
//   而新来的人是照着那张图判断这个项目还活不活着的。
//   脚本能重跑，就有人会重跑。
//
// 它自己起一个临时服务、自己造演示数据、截完自己清干净 ——
// **不碰任何真实数据库**，也不需要你先把站跑起来。
//
// 用法：
//   npm run shots            # 输出到 docs/img/
//   SHOTS_OUT=xxx npm run shots

import { chromium } from 'playwright';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.SHOTS_OUT || join(ROOT, 'docs', 'img');

// 演示口令：只在这个临时实例里存在，进程退出就没了。
const ADMIN = 'demo-admin-token-not-real';
process.env.VEND_ADMIN_TOKEN = ADMIN;
process.env.VEND_ISSUE_SECRET = 'demo-issue-secret-not-real';
// 上游一律不碰：截图不该依赖第三方在不在线，更不该真花钱取号。
process.env.HERO_SMS_API_KEY = 'demo-key-not-real';
process.env.SITE_URL = 'https://example.com';

// 拦掉对接码平台的真实请求，喂一份演示目录。
// 不拦的话服务目录是空的，截出来的首图上写着「0 个平台」——
// 一张显示"什么都没有"的截图放进 README，比没有截图更糟。
const UPSTREAM = 'hero-sms.com';
const DEMO_SERVICES = { dr: 'OpenAI', tg: 'Telegram', wa: 'WhatsApp', ds: 'Discord', go: 'Google' };
const DEMO_COUNTRIES = ['52', '187', '117', '16', '6', '31', '4', '1'];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  let url;
  try { url = new URL(typeof input === 'string' ? input : input?.url ?? String(input)); }
  catch { return realFetch(input, init); }
  if (url.hostname !== UPSTREAM) return realFetch(input, init);
  const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  const price = (id) => Math.max(Number(id) / 100, 0.05);
  const offer = (id) => ({
    counts: { total: 60 + (Number(id) % 40), physical: 30 },
    prices: { min: price(id), default: price(id), retail: price(id) * 1.2 },
    map: { [String(price(id))]: 50 },
  });
  const asked = (url.searchParams.get('countries') || url.searchParams.get('country') || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const ids = asked.length ? asked : DEMO_COUNTRIES;
  if (url.pathname.startsWith('/api/v1/activations/offers')) {
    const svc = url.searchParams.get('services') || 'dr';
    return json({ data: { [svc]: Object.fromEntries(ids.map((i) => [i, offer(i)])) } });
  }
  const action = url.searchParams.get('action');
  if (action === 'getCountries') {
    return json(Object.fromEntries(ids.map((i) => [i, { id: Number(i), eng: `Demoland ${i}`, chn: `演示国 ${i}` }])));
  }
  if (action === 'getPrices') {
    const svc = url.searchParams.get('service') || 'dr';
    return json(Object.fromEntries(ids.map((i) => [i, { [svc]: { cost: price(i), count: 60 } }])));
  }
  if (action === 'getServices' || action === 'getTopCountriesByService') {
    return json(DEMO_SERVICES);
  }
  return json({});
};

const workDir = join(tmpdir(), `docshots-${randomUUID()}`);
const dbPath = join(workDir, 'vend.sqlite');
mkdirSync(workDir, { recursive: true });
mkdirSync(OUT, { recursive: true });

const { CardStore } = await import('../server/cards.js');
const { startVendServer } = await import('../server/vend-server.js');

// ---------- 造演示数据 ----------
// 全部用一眼看得出是假的值：截图会被放进 README，
// 看的人不该需要分辨哪些是真单子。
function seed(store) {
  const cards = [];
  for (const [i, denom] of [1.9, 3.99, 3.99, 5, 9.9].entries()) {
    const { card } = store.issueCard({
      denomCny: denom,
      orderId: `DEMO-${String(i + 1).padStart(4, '0')}`,
      maxCodes: denom >= 5 ? 3 : 1,
      note: '演示数据',
    });
    cards.push(card);
  }
  // 一笔待核对的补差价
  store.claimTopup({ code: cards[0].code, country: 187, needCny: 2.4 });
  // 一笔已确认的，让对账面板有内容
  const paid = store.claimTopup({ code: cards[1].code, country: 117, needCny: 1.2 });
  store.confirmTopup(paid.id, '演示：已收到');
  // 一张待退款的卡
  store.voidCard(cards[4].code, '演示：买家申请退款');
  return cards;
}

const store = new CardStore(dbPath);
seed(store);
store.close();

const app = await startVendServer({ dbPath, port: 0, host: '127.0.0.1', skipVendorSync: true });
const PORT = app.port ?? app.address?.().port;
const BASE = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch();
const shots = [];

async function shot(name, url, prepare) {
  // 1x 就够：GitHub 渲染 README 图片的容器宽度约 800px，
  // 2x 只是把仓库撑大（实测两张图从 4MB 降到 1MB 出头）。
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle' });
  if (prepare) await prepare(page);
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  shots.push(name);
  console.log(`  ✅ ${name}.png`);
  await page.close();
}

try {
  // 买家页。先把公告弹窗关掉 —— 它盖住整个产品，
  // 而 README 首图要给人看的是产品长什么样，不是公告写了什么。
  await shot('buyer', '/', async (page) => {
    for (const sel of ['#annOk', '.modal .btn-primary', 'button:has-text("我知道了")']) {
      const el = await page.$(sel);
      if (el) { await el.click().catch(() => {}); break; }
    }
    await page.waitForTimeout(1400); // 等首屏动效落位，否则截到中间态
  });

  // 管理后台：登录后各面板都有数据
  await shot('admin', '/manage.html', async (page) => {
    await page.fill('#token', ADMIN);
    await page.click('#btnLogin');
    // 判据落在**产物**上：等面板真的出现，不是等固定秒数。
    // 等秒数在慢机器上会截到空白，而空白截图不会报错、只会被直接放进 README。
    await page.waitForSelector('#topupPanel', { state: 'visible', timeout: 15000 });
    await page.click('#btnLedger').catch(() => {});
    await page.click('#btnRefreshRefunds').catch(() => {});
    await page.waitForTimeout(800);
  });
} finally {
  await browser.close();
  await app.close();
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* 临时目录，清不掉也无所谓 */ }
}

console.log(`\n共 ${shots.length} 张 → ${OUT}`);
if (!shots.length) process.exit(1);
