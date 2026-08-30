// 截图 + 硬约束验收。看代码看不出来的问题只有跑起来才暴露：
//   · 动效基态可见（历史事故：ScrollTrigger 把地区列表永远藏在了折叠下方）
//   · 移动端不得横向滚动
//   · 控制台零报错
//   · 国旗真的渲染出来了（不是中性色块）
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { dirname as _dirname, join as _join } from 'node:path';
import { fileURLToPath as _fileURLToPath } from 'node:url';
// 仓库根由脚本自身位置算出，不写死 —— 写死的话别人 clone 到任何别的目录都跑不了。
const ROOT = _join(_dirname(_fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/');

for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_USE_ENV_PROXY']) {
  delete process.env[k];
}
for (const line of readFileSync(`${ROOT}/.env`, 'utf8').split('\n')) {
  if (!line.includes('=') || line.trim().startsWith('#')) continue;
  const i = line.indexOf('=');
  process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}

const { startVendServer } = await import(`file:///${ROOT}/server/vend-server.js`);
const dir = join(tmpdir(), `vend-shot-${randomUUID()}`);
const server = await startVendServer({ dbPath: join(dir, 'vend.sqlite'), port: 0, skipVendorSync: true });
const PORT = server.port ?? server.address?.().port;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = `${ROOT}/design/shots`;
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await chromium.launch();

async function shoot(label, width, height, prep) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE, { waitUntil: 'networkidle' });
  if (prep) await prep(page);
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, `${label}.png`), fullPage: false });
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  return { page, errors, overflow };
}

// 1. 桌面首屏（公告自动弹出）
{
  const { page, errors, overflow } = await shoot('01-desktop-announce', 1440, 900);
  check('桌面首屏无控制台报错', errors.length === 0, errors[0] || '');
  check('公告自动弹出', await page.locator('#annMask').isVisible());
  const imgs = await page.locator('#annBody img').count();
  check('公告里两张图都在', imgs === 2, `${imgs} 张`);
  const bad = await page.locator('#annBody').textContent();
  check('已去掉「无二验风险」这类绝对化承诺', !/无二验|绕过验证|100%|绝对/.test(bad || ''), bad?.match(/无二验|绕过验证|100%|绝对/)?.[0] || '');
  await page.close();
}

// 2. 桌面 · 关掉公告后的选服务态
{
  const { page, errors, overflow } = await shoot('02-desktop-service', 1440, 900, async (p) => {
    await p.click('#btnAnnOk');
    await p.waitForTimeout(800);
  });
  check('桌面选服务态无报错', errors.length === 0, errors[0] || '');
  check('桌面不横向滚动', !overflow);
  const rows = await page.locator('#svcList .row').count();
  check('服务列表有内容且可见', rows > 0, `${rows} 行`);
  const firstVisible = rows > 0 ? await page.locator('#svcList .row').first().isVisible() : false;
  check('动效基态可见（列表不是隐藏的）', firstVisible);

  // 元素「存在且 visible」不等于买家看得见 —— 被居中到视口外一样是空白首屏。
  // 这条是肉眼发现的，补成断言，别再靠我盯截图。
  const stage = await page.evaluate(() => {
    const vh = window.innerHeight;
    const box = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) };
    };
    return { vh, stage: box('#stage'), slots: box('#slots'), empty: box('#stageEmpty') };
  });
  check('主舞台高度合理（没被撑爆）', stage.stage.h < stage.vh * 1.2, `舞台 ${stage.stage.h}px / 视口 ${stage.vh}px`);
  check('验证码槽位在首屏内可见', stage.slots.top > 0 && stage.slots.bottom < stage.vh, `槽位 top ${stage.slots.top} bottom ${stage.slots.bottom}`);
  check('空态提示在首屏内可见', stage.empty.top > 0 && stage.empty.bottom < stage.vh, `提示 top ${stage.empty.top}`);
  await page.close();
}

// 3. 桌面 · 选完服务进入选地区（验国旗）
{
  const { page, errors } = await shoot('03-desktop-region', 1440, 900, async (p) => {
    await p.click('#btnAnnOk');
    await p.waitForTimeout(700);
    await p.locator('#svcList .row').first().click();
    await p.waitForTimeout(2500);
  });
  check('选地区态无报错', errors.length === 0, errors[0] || '');
  const regRows = await page.locator('#regList .row').count();
  check('地区列表有内容', regRows > 0, `${regRows} 行`);
  const flags = await page.locator('#regList .flag img').count();
  const blanks = await page.locator('#regList .flag-blank').count();
  check('国旗是真图不是色块', flags > 0 && flags >= blanks, `真旗 ${flags} / 色块 ${blanks}`);
  const loaded = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('#regList .flag img')];
    return imgs.filter((i) => i.naturalWidth > 0).length;
  });
  check('国旗 SVG 实际加载成功', loaded > 0, `${loaded}/${flags} 张已解码`);
  await page.close();
}

// 4. 移动 390
{
  const { page, errors, overflow } = await shoot('04-mobile', 390, 844, async (p) => {
    await p.click('#btnAnnOk');
    await p.waitForTimeout(800);
  });
  check('移动端无报错', errors.length === 0, errors[0] || '');
  check('移动端不横向滚动（硬约束）', !overflow);
  const tooSmall = await page.evaluate(() => {
    const els = [...document.querySelectorAll('button, .tab, a.help-link')];
    return els.filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.height < 44;
    }).map((e) => `${e.id || e.className}:${Math.round(e.getBoundingClientRect().height)}`);
  });
  check('可点区域 ≥44px', tooSmall.length === 0, tooSmall.slice(0, 4).join(', '));
  await page.close();
}

// 5. 临时邮箱面板
{
  const { page, errors, overflow } = await shoot('05-mail', 1440, 900, async (p) => {
    await p.click('#btnAnnOk');
    await p.waitForTimeout(700);
    await p.click('.tab[data-go="mail"]');
    await p.waitForTimeout(600);
  });
  check('邮箱面板无报错', errors.length === 0, errors[0] || '');
  check('邮箱面板不横向滚动', !overflow);
  await page.close();
}

// 6. GEO 区块
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('#btnAnnOk');
  await page.waitForTimeout(2000);
  await page.locator('#geo').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, '06-geo.png') });
  const faqCount = await page.locator('#faq details').count();
  check('FAQ 渲染出来了', faqCount === 8, `${faqCount} 组`);
  const ld = await page.locator('#faqLd').textContent();
  const parsed = ld ? JSON.parse(ld) : null;
  check('FAQPage 结构化数据与页面问答一致',
    parsed?.mainEntity?.length === faqCount, `schema ${parsed?.mainEntity?.length} vs 页面 ${faqCount}`);
  const h1 = await page.locator('h1').count();
  check('唯一 h1', h1 === 1, `${h1} 个`);
  const priceRows = await page.locator('#priceRows tr').count();
  check('价格表有数据', priceRows > 1, `${priceRows} 行`);
  await page.close();
}

await browser.close();
await server.close?.();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过 · 截图在 ${OUT}`);
if (failed.length) { console.log('失败：' + failed.map((f) => f.name).join('、')); process.exit(1); }
process.exit(0);
