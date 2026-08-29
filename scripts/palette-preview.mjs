// palette-preview.mjs — 把候选配色**贴到我们自己的页面上**，截真实截图。
//
// 为什么必须这么做：安哥给的四套是「两个色圆」，motionsites 那三个是别人家的落地页。
// 两种都回答不了真正的问题——「我这一页穿上这身色长什么样」。
// 色卡好看和页面好看是两件事：色卡只有两块纯色，页面有列表、有分隔线、有五级文字、
// 有一块要放验证码的舞台，配色撑不撑得住这些，只有贴上去才知道。
//
// 前提：vend.css 已经把 111 处硬编码色值收进了 token（渲染逐字节不变，已验证）。
// 没做这一步的话，只换 :root 会做出一个半新半旧的怪物 —— 45 处金色 rgba 换不掉。
//
// 收码那一刻走 page.route() 拦截造态，**绝不真取号**（取号扣真钱）。
//
// 用法：node scripts/palette-preview.mjs

import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { startVendServer } from '../server/vend-server.js';
import { CardStore } from '../server/cards.js';

const OUT = 'C:/WINDOWS/TEMP/claude/D----/fae349b8-7916-464f-82e6-ab335a208072/scratchpad/pal';
const TMP = 'C:/WINDOWS/TEMP/claude/D----/fae349b8-7916-464f-82e6-ab335a208072/scratchpad/guide-db';
mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });

// 每套配色都填满：外壳（浅）/ 主舞台（深）/ 强调色 / 五级文字。
// 八套之间**只有颜色一个变量**，结构完全一样，比得才公平。
const PALETTES = [
  { id: 'now', name: '现状 · 黑金', from: '线上正在跑的', note: '对照组' },

  {
    id: 'p1', name: '烟雨白 + 紫幽兰', from: '安哥给的 ①', pair: ['#E3E3E5', '#707899'],
    note: '原方案没有深色，主舞台那块是我按紫幽兰压暗推的',
    t: {
      bg: '#EDEDEF', panel: '#E7E7EA', panel2: '#E3E3E5', panel3: '#DCDCE0', panel4: '#E7E7EA',
      line: '#D3D4D9', line2: '#C3C5CE', line3: '#E2E2E6',
      raised: '#FFFFFF', deepPanel: '#E5E5E8', input: '#FFFFFF',
      accent: '#5C6383', accentLight: '#7C84A6', accentDark: '#4A5069', onAccent: '#FFFFFF',
      ink1: '#23273A', ink2: '#333849', ink3: '#5D6376', ink4: '#7D8395', ink5: '#9298A8',
      warn: '#9A6520', red: '#B8443A', okText: '#3F7A55',
      stage: 'linear-gradient(165deg, #3A3F52 30%, #333849)', stageInk: '#EFF1F7',
      accentRgb: '92, 99, 131', warnRgb: '154, 101, 32', glowRgb: '124, 132, 166',
    },
  },
  {
    id: 'p2', name: '豆汁黄 + 藿紫', from: '安哥给的 ②', pair: ['#FAFBE6', '#A48CE6'],
    note: '原方案没有深色，主舞台那块是我按藿紫压暗推的',
    t: {
      bg: '#FAFBE6', panel: '#F4F5DC', panel2: '#F7F8E1', panel3: '#EEF0D6', panel4: '#F4F5DC',
      line: '#E4E6C4', line2: '#D6D8B2', line3: '#EFF1DA',
      raised: '#FFFFFC', deepPanel: '#F2F3D8', input: '#FFFFFC',
      accent: '#7A5FC4', accentLight: '#A48CE6', accentDark: '#63499F', onAccent: '#FFFFFF',
      ink1: '#2E2A3D', ink2: '#3D3752', ink3: '#635C7E', ink4: '#8A83A2', ink5: '#A29BB6',
      warn: '#8F6015', red: '#B8443A', okText: '#3F7A55',
      stage: 'linear-gradient(165deg, #39325A 30%, #332C52)', stageInk: '#EFE9FA',
      accentRgb: '122, 95, 196', warnRgb: '143, 96, 21', glowRgb: '164, 140, 230',
    },
  },
  {
    id: 'p3', name: '嫩菊绿 + 幽谷灰', from: '安哥给的 ③', pair: ['#E2E7BF', '#2B313F'],
    note: '自带深色，浅深天然成对 —— 不用我推',
    t: {
      bg: '#EFF1DD', panel: '#E8ECCC', panel2: '#E2E7BF', panel3: '#E7EBC8', panel4: '#E8ECCC',
      line: '#D2D8AE', line2: '#C2C99B', line3: '#E4E8C6',
      raised: '#F7F9EC', deepPanel: '#E4E9C5', input: '#F7F9EC',
      accent: '#2B313F', accentLight: '#3A4256', accentDark: '#20242F', onAccent: '#E2E7BF',
      ink1: '#1E2229', ink2: '#2B313F', ink3: '#565D6E', ink4: '#79808F', ink5: '#8F96A3',
      warn: '#7E5D12', red: '#B03A31', okText: '#3A6E4C',
      stage: 'linear-gradient(165deg, #2B313F 30%, #242936)', stageInk: '#E2E7BF',
      accentRgb: '43, 49, 63', warnRgb: '126, 93, 18', glowRgb: '226, 231, 191',
    },
  },
  {
    id: 'p4', name: '海天蓝 + 葱油绿', from: '安哥给的 ④', pair: ['#C6E6E8', '#373834'],
    note: '自带深色，浅深天然成对 —— 不用我推',
    t: {
      bg: '#DFF0F1', panel: '#D3EAEC', panel2: '#C6E6E8', panel3: '#D8ECEE', panel4: '#D3EAEC',
      line: '#B4D8DA', line2: '#A0CBCE', line3: '#CFE8EA',
      raised: '#EFF8F9', deepPanel: '#D2E9EB', input: '#EFF8F9',
      accent: '#373834', accentLight: '#4A4C46', accentDark: '#2A2B27', onAccent: '#C6E6E8',
      ink1: '#1E1F1C', ink2: '#373834', ink3: '#5C5E57', ink4: '#7E817A', ink5: '#93968E',
      warn: '#7C5713', red: '#B03A31', okText: '#3A6E4C',
      stage: 'linear-gradient(165deg, #373834 30%, #2E2F2B)', stageInk: '#C6E6E8',
      accentRgb: '55, 56, 52', warnRgb: '124, 87, 19', glowRgb: '198, 230, 232',
    },
  },
  {
    id: 'v', name: 'Vitara 派生', from: 'motionsites · 我推荐的方向', pair: ['#EFEFEE', '#2A332F'],
    note: '这是我按 Vitara 的路子配的，不是现成配色',
    t: {
      bg: '#EFEFEE', panel: '#F7F7F6', panel2: '#FFFFFF', panel3: '#F2F2F1', panel4: '#F7F7F6',
      line: '#E0E0DD', line2: '#D0D0CC', line3: '#EAEAE8',
      raised: '#FFFFFF', deepPanel: '#F2F2F0', input: '#FFFFFF',
      accent: '#2A332F', accentLight: '#3A4540', accentDark: '#1F2724', onAccent: '#F2EDDF',
      ink1: '#1B211E', ink2: '#2A332F', ink3: '#5B635F', ink4: '#818884', ink5: '#979D99',
      warn: '#8A6118', red: '#B03A31', okText: '#3A6E4C',
      stage: 'linear-gradient(165deg, #2A332F 30%, #232B28)', stageInk: '#E9C87A',
      accentRgb: '42, 51, 47', warnRgb: '138, 97, 24', glowRgb: '233, 200, 122',
    },
  },
  {
    id: 's', name: 'Systema 派生', from: 'motionsites · 想留深色的话', pair: ['#000000', '#FFFFFF'],
    note: '纯黑白，一点彩色都不用 —— 深色但不靠发光色撑场面',
    t: {
      bg: '#000000', panel: '#0B0B0B', panel2: '#080808', panel3: '#0B0B0B', panel4: '#101010',
      line: '#1E1E1E', line2: '#2C2C2C', line3: '#151515',
      raised: '#101010', deepPanel: '#050505', input: '#0A0A0A',
      accent: '#FFFFFF', accentLight: '#FFFFFF', accentDark: '#D8D8D8', onAccent: '#000000',
      ink1: '#FFFFFF', ink2: '#E4E4E4', ink3: '#8E8E8E', ink4: '#6A6A6A', ink5: '#565656',
      warn: '#D2D2D2', red: '#FF6B60', okText: '#B9B9B9',
      stage: 'linear-gradient(165deg, #050505 30%, #0A0A0A)', stageInk: '#FFFFFF',
      accentRgb: '255, 255, 255', warnRgb: '210, 210, 210', glowRgb: '255, 255, 255',
    },
  },
  {
    id: 'r', name: 'AI Runtime 派生', from: 'motionsites · 折中', pair: ['#F1E9F2', '#241C22'],
    note: '原稿是上浅下深的渐变，这里先用纯色近似',
    t: {
      bg: '#F1E9F2', panel: '#EBE1EC', panel2: '#F5EEF6', panel3: '#E8DEE9', panel4: '#EBE1EC',
      line: '#DED2E0', line2: '#CDBFD0', line3: '#E9E0EA',
      raised: '#FBF7FC', deepPanel: '#EAE0EB', input: '#FBF7FC',
      accent: '#5E4068', accentLight: '#8A6396', accentDark: '#4A3252', onAccent: '#FFFFFF',
      ink1: '#2A2130', ink2: '#3B2F43', ink3: '#665A6D', ink4: '#8C7F92', ink5: '#A296A7',
      warn: '#8E611C', red: '#B8443A', okText: '#3F7A55',
      stage: 'linear-gradient(165deg, #241C22 30%, #1D171C)', stageInk: '#E7C9EE',
      accentRgb: '94, 64, 104', warnRgb: '142, 97, 28', glowRgb: '231, 201, 238',
    },
  },
];

function overrideCss(p) {
  if (!p.t) return '';
  const t = p.t;
  return `
:root {
  --bg: ${t.bg};
  --panel: ${t.panel}; --panel-2: ${t.panel2}; --panel-3: ${t.panel3}; --panel-4: ${t.panel4};
  --line: ${t.line}; --line-2: ${t.line2}; --line-3: ${t.line3};

  --gold: ${t.accent};
  --gold-light: ${t.accentLight}; --gold-dark: ${t.accentDark}; --gold-hover: ${t.accentLight};
  --on-gold: ${t.onAccent};

  --t1: ${t.ink1}; --t2: ${t.ink2}; --t3: ${t.ink3}; --t4: ${t.ink4}; --t5: ${t.ink5};
  --warn: ${t.warn}; --red: ${t.red}; --ok-text: ${t.okText};

  --gold-rgb: ${t.accentRgb};
  --warn-rgb: ${t.warnRgb};
  --glow-rgb: ${t.glowRgb};

  /* 浮起面板（弹窗 / toast / 公告胶囊）跟着外壳走 */
  --panel-raised: ${t.raised};
  --panel-deep: ${t.deepPanel};
  --input-bg: ${t.input};
  --text-cream: ${t.ink1};
  --text-muted-gold: ${t.ink3};
  --text-dim: ${t.ink4};

  /* 主舞台是深色的，舞台上的文字要单独翻过来 */
  --stage-grad: ${t.stage};
  --hot: ${t.stageInk};
  --text-bright: ${t.stageInk};
  --text-bright-rgb: 255, 255, 255;
}

/* 舞台上的文字不能跟着外壳的 ink 走，否则深底写深字看不见。
   这几条按元素点名，比再造一套 token 直接。 */
.stage, .numhint, .cd-line, .cd-total, .act-note, .stage-empty .lead, .stage-empty .sub {
  color: ${t.stageInk};
}
.badge, #stageBadgeText { color: ${t.stageInk}; }
.sms-raw p, .sms-raw span { color: ${t.stageInk}; opacity: .8; }
.numflag .flag-blank { color: ${t.stageInk}; }
`;
}

// ---------- 假快照，字段照 vend-routes.js 的 snapshot() ----------
const startedAt = Date.now() - 61_000;
const snap = (over = {}) => ({
  denomCny: 1.9, service: 'dr', lockedService: null, status: 'active',
  changes: 0, maxChanges: null, orders: 1, maxOrders: null, refundState: null,
  activation: {
    phone: '+639123456789', country: 4, service: 'dr', state: 'waiting',
    smsCode: null, smsText: null, priceCny: 0.28,
    startedAt, expiresAt: startedAt + 20 * 60 * 1000,
    remainingMs: startedAt + 20 * 60 * 1000 - Date.now(), ...over,
  },
});

const server = await startVendServer({ dbPath: TMP + '/pal.sqlite', port: 8794, host: '127.0.0.1' });
const base = 'http://127.0.0.1:8794';
const store = new CardStore(TMP + '/pal.sqlite');

const browser = await chromium.launch();

for (const p of PALETTES) {
  const CODE = store.issueCard({ denomCny: 1.9, service: 'dr', orderId: 'pal-' + p.id, note: '配色预览' }).card.code;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.4, locale: 'zh-CN' });
  await ctx.addInitScript(`try { localStorage.setItem('vendAnnSkipDate',
    new Date().getFullYear() + '-' + (new Date().getMonth() + 1) + '-' + new Date().getDate()); } catch {}`);
  const page = await ctx.newPage();

  await page.route('**/api/vend/number', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: snap() }),
  }));
  let phase = 'waiting';
  await page.route('**/api/vend/status*', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, data: phase === 'waiting' ? snap()
      : snap({ state: 'code', smsCode: '472913', smsText: 'Your OpenAI code is 472913' }) }),
  }));

  await page.goto(base, { waitUntil: 'networkidle', timeout: 120_000 });
  // 新皮把服务列表收进手风琴了，验卡密之前它是 display:none。
// 等「可见」会永远等不到，改成等**渲染出来**（数量 > 0）。
await page.waitForFunction(() => document.querySelectorAll('#svcList .row-svc').length > 0, { timeout: 120_000 });
  const css = overrideCss(p);
  if (css) await page.addStyleTag({ content: css });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/${p.id}-idle.jpg`, type: 'jpeg', quality: 80 });

  // 走到「收到验证码」那一刻 —— 全站最关键的一屏
  await page.fill('#cardInput', CODE);
  await page.click('#btnVerify');
  await page.waitForSelector('#cardOk:not([hidden])', { timeout: 30_000 });
  await page.click('#svcList .row-svc');
  await page.waitForSelector('#regList .row-reg', { timeout: 120_000 });
  await page.click('#regList .row-reg:not(:has(.row-tag.short))');
  await page.waitForTimeout(250);
  await page.click('#btnPrimary');
  await page.waitForSelector('body[data-state="waiting"]', { timeout: 20_000 });
  phase = 'code';
  await page.waitForSelector('body[data-state="done"]', { timeout: 40_000 });
  await page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.hidden = true; window.scrollTo(0, 0); });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/${p.id}-code.jpg`, type: 'jpeg', quality: 80 });

  console.log('ok', p.id.padEnd(4), p.name);
  await ctx.close();
}

await browser.close();
store.close();
await server.close();
console.log('\n图在 ' + OUT);
