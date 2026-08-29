// 把上游 HeroSMS 的服务目录 dump 成磁盘文件，供图标匹配脚本使用。
// /api/v1/activations/offers 不带 services 参数会返回全部服务（实测 720+）的完整报价矩阵。
// 蒸馏出的 name 用上游英文原名（不用 server/vend-catalog.js 里的中文覆盖名 CN_NAMES，
// 中文名不利于跟 simple-icons 的品牌 slug/title 匹配）。CN_NAMES 只是额外存一份供参考。
import { mkdirSync, writeFileSync } from 'node:fs';
import { config } from '../server/config.js';

const REQUEST_TIMEOUT_MS = 45000;
const OUT_PATH = 'F:/sms-project/data/hero-services.json';

// 抄自 server/vend-catalog.js 的 CN_NAMES（只读引用，不 import 私有变量，不改动该文件）。
const CN_NAMES = {
  dr: 'OpenAI · ChatGPT',
  mm: 'Microsoft · Outlook',
  go: 'Google · Gmail · YouTube',
  lf: 'TikTok · 抖音',
  ds: 'Discord',
  wx: 'Apple ID',
  tn: 'LinkedIn',
  ig: 'Instagram · Threads',
  fb: 'Facebook',
  tg: 'Telegram',
  wa: 'WhatsApp',
  am: 'Amazon',
  oi: 'Tinder',
  mb: 'Yahoo',
  me: 'LINE',
  wb: '微信 WeChat',
  ka: 'Shopee',
  nv: 'Naver',
  li: '百度',
  ot: '其他服务（通用号）',
  ts: 'PayPal',
  ub: 'Uber',
  nf: 'Netflix',
  vi: 'Viber',
  ma: 'Mail.ru',
  ya: 'Yandex',
  vk: 'VKontakte',
  bz: 'Blizzard',
  mt: 'Steam',
  kt: 'KakaoTalk',
};

function offersUrl() {
  const base = new URL(config.heroSms.baseUrl);
  return new URL('/api/v1/activations/offers', base.origin).toString();
}

async function fetchAllOffers() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(offersUrl(), {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json', Authorization: `ApiKey ${config.heroSms.apiKey}` },
    });
    if (!response.ok) throw new Error(`报价接口 HTTP ${response.status}`);
    const payload = await response.json();
    return payload?.data || {};
  } finally {
    clearTimeout(timer);
  }
}

async function fetchServiceNames() {
  const url = new URL(config.heroSms.baseUrl);
  url.searchParams.set('api_key', config.heroSms.apiKey);
  url.searchParams.set('action', 'getServicesList');
  const response = await fetch(url, { method: 'GET' });
  if (!response.ok) throw new Error(`服务名接口 HTTP ${response.status}`);
  const payload = await response.json().catch(() => ({}));
  const list = payload?.services || [];
  return Object.fromEntries(list.map((item) => [item.code, item.name]));
}

// 蒸馏：每条服务算出最低价 / 覆盖国家数(有货的) / 总库存，不按库存过滤（要全量，供图标覆盖用）。
function distill(offers, names) {
  const rows = [];
  const namelessCodes = [];
  for (const code of Object.keys(offers || {})) {
    const byCountry = offers[code] || {};
    let stock = 0;
    let countries = 0;
    let minUsd = Infinity;
    for (const countryId of Object.keys(byCountry)) {
      const offer = byCountry[countryId] || {};
      const total = Number(offer?.counts?.total) || 0;
      const price = Number(offer?.prices?.min ?? offer?.prices?.default);
      if (total > 0) { stock += total; countries += 1; }
      if (Number.isFinite(price) && price > 0 && price < minUsd) minUsd = price;
    }
    const upstreamName = names?.[code];
    if (!upstreamName) namelessCodes.push(code);
    const row = {
      code,
      name: upstreamName || code,
      minUsd: Number.isFinite(minUsd) ? minUsd : null,
      countries,
      stock,
    };
    const cn = CN_NAMES[code];
    if (cn) row.cnName = cn;
    rows.push(row);
  }
  rows.sort((a, b) => b.stock - a.stock);
  return { rows, namelessCodes };
}

async function main() {
  const [offers, names] = await Promise.all([fetchAllOffers(), fetchServiceNames()]);
  const { rows, namelessCodes } = distill(offers, names);

  mkdirSync('F:/sms-project/data', { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(rows, null, 2));

  console.log(`dump 完成：${rows.length} 个服务 -> ${OUT_PATH}`);
  if (namelessCodes.length) {
    console.log(`\n❗ 上游报价矩阵里有、但 getServicesList 查不到英文名的服务码（${namelessCodes.length} 个，用 code 自身兜底）：`);
    console.log(`  ${namelessCodes.join(', ')}`);
  }
}

main().catch((error) => {
  console.error(`[dump-services] 失败：${error.message}`);
  process.exit(1);
});
