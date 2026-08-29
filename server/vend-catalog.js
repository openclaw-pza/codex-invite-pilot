// vend-catalog.js — 服务目录（哪些服务能卖、多少钱、有多少货）
//
// HeroSMS 的 /api/v1/activations/offers 不带 services 参数时会返回**全部 722 个服务**
// 的完整报价矩阵，实测 2.8MB。绝不能每个买家刷新一次就拉一遍：
//   · 服务端拉一次，蒸馏成 code/name/最低价/覆盖国家数/总库存 的小目录
//   · 缓存 10 分钟，过期后台刷新，刷新失败继续用旧的（宁可价格旧一点也不能白屏）
//
// 目录只用于**展示和排序**。真正取号时的价格闸门仍然按单个服务+国家现查，
// 不拿这份缓存当作扣钱依据。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { config } from './config.js';

// 地区中文名的规范表（scripts/build-country-cn.cjs 生成）。
// 上游的 chn 字段简繁混杂、还有错译——不丹被译成「丁烷」。
// 读不到就退回上游名字：名字旧总比列表里出现 id 数字强。
let CN_NAME_TABLE = {};
try {
  CN_NAME_TABLE = JSON.parse(readFileSync(new URL('../data/country-cn.json', import.meta.url), 'utf8'));
} catch (error) {
  console.warn(`[vend] 国家名规范表读不到，退回上游名字：${error.message}`);
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const CATALOG_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 45000;

// 常见服务的中文名。HeroSMS 返回的是英文名，直接给中国买家看不友好。
// 没在这张表里的就用平台原名，不硬翻。
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

// 首页默认推的服务，按国内实际需求排。不在这张表里的靠库存排序。
const FEATURED = ['dr', 'go', 'mm', 'tg', 'ds', 'lf', 'ig', 'wx', 'fb', 'am', 'tn', 'ot'];

// 首页「实时可用榜」覆盖的服务，按展示顺序排。
const SHOWCASE_SERVICES = ['dr', 'go', 'mm', 'tg', 'ds', 'lf', 'ig', 'wx', 'fb', 'am', 'wa', 'tw'];

// dr（OpenAI）优先出的国家：52=泰国，187=美国。这是卖家验证过的高成功率地区，
// 不是我们自己测出来的数据，所以只在榜单里打 recommended 标记，不改排序算法本身。
const DR_PRIORITY_COUNTRY_IDS = ['52', '187'];

let countryNameCache = null;
function countryNames() {
  if (countryNameCache) return countryNameCache;
  countryNameCache = {};
  try {
    const path = join(__dirname, '..', 'data', 'hero-countries.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    for (const id of Object.keys(raw)) {
      // 同 heroSms.js：优先用规范表，上游的 chn 简繁混杂且有错译
      countryNameCache[id] = CN_NAME_TABLE[String(id)] || raw[id]?.chn || raw[id]?.eng || id;
    }
  } catch (error) {
    // 读不到名表不阻断榜单：国家名退化成 id，总比整块看板挂掉强。
      }
  return countryNameCache;
}

let cache = { at: 0, services: [], showcase: [], refreshing: null };

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
  const payload = await response.json().catch(() => ({}));
  const list = payload?.services || [];
  return Object.fromEntries(list.map((item) => [item.code, item.name]));
}

// 把 2.8MB 的报价矩阵压成一份小目录
export function distillCatalog(offers, names) {
  const rows = [];
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
    // 库存为 0 或算不出价格的服务不上架：
    // 买家点进去只会看到「这个地区暂时没号了」，白跑一趟。
    if (!stock || !Number.isFinite(minUsd)) continue;
    const featuredIndex = FEATURED.indexOf(code);
    rows.push({
      code,
      name: CN_NAMES[code] || names?.[code] || code,
      rawName: names?.[code] || code,
      minUsd,
      stock,
      countries,
      featured: featuredIndex >= 0,
      featuredRank: featuredIndex >= 0 ? featuredIndex : 999,
    });
  }
  // 推荐的排前面（按人工顺序），其余按库存降序
  rows.sort((a, b) => (a.featuredRank - b.featuredRank) || (b.stock - a.stock));
  return rows;
}

// 首页「实时可用榜」的第二道蒸馏：复用同一次 offers 结果，不重新拉接口。
// 每个服务取库存最多的 3 个国家；dr 例外，优先塞泰国/美国（有库存才塞，没有就跳过）。
// 只算库存和国家，不算钱——priceCny 留给调用方按当前 config.rate 现算，
// 这样汇率/毛利率调整不用等目录下一次刷新才生效（跟 distillCatalog 的 minUsd 是同一个道理）。
export function distillShowcase(offers, serviceNames = {}, services = SHOWCASE_SERVICES) {
  const names = countryNames();
  const rows = [];
  for (const code of services) {
    const byCountry = offers?.[code] || {};
    const candidates = [];
    for (const countryId of Object.keys(byCountry)) {
      const offer = byCountry[countryId] || {};
      const stock = Number(offer?.counts?.total) || 0;
      const priceUsd = Number(offer?.prices?.min ?? offer?.prices?.default);
      if (stock <= 0 || !Number.isFinite(priceUsd) || priceUsd <= 0) continue;
      candidates.push({ countryId, stock, priceUsd });
    }
    candidates.sort((a, b) => b.stock - a.stock);

    let picked;
    if (code === 'dr') {
      const priority = [];
      for (const id of DR_PRIORITY_COUNTRY_IDS) {
        const found = candidates.find((c) => c.countryId === id);
        if (found) priority.push({ ...found, recommended: true });
      }
      const rest = candidates
        .filter((c) => !priority.some((p) => p.countryId === c.countryId))
        .slice(0, Math.max(0, 3 - priority.length))
        .map((c) => ({ ...c, recommended: false }));
      picked = [...priority, ...rest];
    } else {
      picked = candidates.slice(0, 3).map((c) => ({ ...c, recommended: false }));
    }

    for (const item of picked) {
      rows.push({
        service: code,
        // CN_NAMES 只覆盖了常见的三十来个服务，其余退回上游英文名，
        // 别让看板上出现「tw」「aih」这种内部代码
        serviceName: CN_NAMES[code] || serviceNames?.[code] || code,
        countryId: Number(item.countryId),
        // 走规范表，上游的 chn 简繁混杂且有错译
        countryName: CN_NAME_TABLE[String(item.countryId)] || names[item.countryId] || `地区 ${item.countryId}`,
        stock: item.stock,
        priceUsd: item.priceUsd,
        recommended: item.recommended,
      });
    }
  }
  return rows;
}

// 拉一次 offers、刷新两份蒸馏（services 给 /api/vend/services，showcase 给首页榜单），
// getCatalog / getShowcase 共用这一份缓存和这一次网络请求。
async function refreshCatalog({ force = false } = {}) {
  const fresh = Date.now() - cache.at < CATALOG_TTL_MS;
  if (fresh && !force && cache.services.length) return cache;
  // 已经有人在刷就搭它的车，别并发拉好几次 2.8MB
  if (cache.refreshing) return cache.refreshing;

  cache.refreshing = (async () => {
    try {
      const [offers, names] = await Promise.all([fetchAllOffers(), fetchServiceNames().catch(() => ({}))]);
      const services = distillCatalog(offers, names);
      const showcase = distillShowcase(offers, names);
      if (services.length) cache = { at: Date.now(), services, showcase, refreshing: null };
      return cache;
    } catch (error) {
      console.warn(`[vend] 服务目录刷新失败：${error.message}（继续用 ${cache.services.length} 条旧数据）`);
      cache.refreshing = null;
      return cache; // 宁可价格旧一点，也不能让页面空着
    }
  })();
  return cache.refreshing;
}

export async function getCatalog({ force = false } = {}) {
  const current = await refreshCatalog({ force });
  return current.services;
}

// 首页实时可用榜。目录拉取失败时 cache.showcase 保持上一份好数据（冷启动时是空数组），
// 从不抛错——首页少一块看板不能让整页崩。
export async function getShowcase({ force = false } = {}) {
  const current = await refreshCatalog({ force });
  return current.showcase;
}

export function catalogAgeMs() {
  return cache.at ? Date.now() - cache.at : null;
}

// 缓存最近一次成功刷新的时间戳（ms epoch）。给 /api/vend/showcase 当 fetchedAt 用，
// 比拿 catalogAgeMs() 反推更准——不会有两次 Date.now() 之间的抖动。
export function catalogFetchedAt() {
  return cache.at || null;
}

export const CATALOG_CONSTANTS = { CATALOG_TTL_MS, FEATURED, CN_NAMES, SHOWCASE_SERVICES, DR_PRIORITY_COUNTRY_IDS };
