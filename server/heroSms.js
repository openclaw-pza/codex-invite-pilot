// heroSms.js — 对接 HeroSMS 接码平台（SMS-Activate 风格协议）
import { config } from './config.js';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { readFileSync } from 'node:fs';

// 地区中文名的规范表。读不到就退回上游名字——名字旧总比列表空白强。
let CN_NAMES = {};
try {
  CN_NAMES = JSON.parse(readFileSync(new URL('../data/country-cn.json', import.meta.url), 'utf8'));
} catch { CN_NAMES = {}; }


const REQUEST_TIMEOUT_MS = 20000;

// 短信里抽验证码。这是**卖钱那条路**的最后一步，抽错一次 =
// 卡当场作废 + 买家拿到一个错的码，而一张卡只有一次成功收码的机会。
//
// 原来只有一行 `/\b(\d{4,8})\b/`：正文里出现 "expires 2026" 就会返回 2026。
// 生产库里现存的两条原文都是纯 6 位数字（上游多数只回码），
// 但 sms_text 这一列存在本身就说明它有时回完整短信 —— 那时候年份、订单号、
// 短链里的数字都在正文里。
//
// 对照：邮件那条路（免费送的临时邮箱）的 extract.js 早就有年份闸和分段码支持，
// 收钱这条反而裸奔。这次补齐，三条按优先级试：
const CODE_HINT = /(?:验证码|校验码|动态码|verification\s+code|security\s+code|one[-\s]?time\s+(?:code|password)|\bOTP\b|\bcode\b)[^\d]{0,18}(\d{4,8})/i;
const CODE_GROUP = /\b(\d{4,8})\b/g;
// 分段码：「129-482」「123 456」，以及被逐位拆开的「5 8 3 0 1 4」
const CODE_SPLIT = /(?:^|[^\d])(\d(?:[-\s\u00A0]?\d){3,9})(?!\d)/;

// 看起来像年份的 4 位数。"expires 2026" 在短信里极常见，
// 命中它 = 把 2026 当验证码发给买家、同时把卡作废。
function looksLikeYear(num) {
  return /^(19|20)\d{2}$/.test(num);
}

function ensureApiKey() {
  if (!config.heroSms.apiKey) throw new Error('未配置 HERO_SMS_API_KEY');
}

function buildUrl(query) {
  const url = new URL(config.heroSms.baseUrl);
  url.searchParams.set('api_key', config.heroSms.apiKey);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

// HeroSMS 返回多为纯文本（ACCESS_xxx / STATUS_xxx），偶尔为 JSON
function parsePayload(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function describe(payload) {
  if (typeof payload === 'string') return payload.trim();
  if (payload && typeof payload === 'object') {
    return String(
      payload.message || payload.msg || payload.error || payload.details || payload.title || JSON.stringify(payload),
    ).trim();
  }
  return String(payload || '').trim();
}

async function request(query, label) {
  ensureApiKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(buildUrl(query), { method: 'GET', signal: controller.signal });
    const text = await response.text();
    const payload = parsePayload(text);
    if (!response.ok) {
      throw new Error(`${label}失败：${describe(payload) || `HTTP ${response.status}`}`);
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`${label}超时`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(url, init, label) {
  ensureApiKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    const payload = parsePayload(text);
    if (!response.ok) {
      throw new Error(`${label}失败：${describe(payload) || `HTTP ${response.status}`}`);
    }
    if (!payload || typeof payload !== 'object') throw new Error(`${label}返回了无法识别的数据`);
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`${label}超时`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function extractCode(raw) {
  const text = String(raw || '');
  if (!text) return '';

  // ① 提示词后面的数字最可信
  const hinted = text.match(CODE_HINT);
  if (hinted?.[1] && !looksLikeYear(hinted[1])) return hinted[1];

  // ② 连续 4~8 位数字，跳过年份，取第一个非年份的
  CODE_GROUP.lastIndex = 0;
  for (const m of text.matchAll(CODE_GROUP)) {
    if (!looksLikeYear(m[1])) return m[1];
  }

  // ③ 分段 / 逐位拆开的码
  const split = text.match(CODE_SPLIT);
  if (split?.[1]) {
    const digits = split[1].replace(/[^\d]/g, '');
    if (digits.length >= 4 && digits.length <= 8 && !looksLikeYear(digits)) return digits;
  }
  return '';
}

// 查询余额
export async function getBalance() {
  const payload = await request({ action: 'getBalance' }, 'HeroSMS 查询余额');
  const balance = Number(describe(payload).replace(/^ACCESS_BALANCE:/i, '').trim());
  return { balance: Number.isFinite(balance) ? balance : null, raw: describe(payload) };
}

function toPrice(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10000) / 10000 : null;
}

// HeroSMS 新版 offers 接口会返回网站「报价列表」中的完整价格档位。
// 结构为 data[service][country].map[price] = availableCount。
export function parseOfferQuotes(payload, service, country) {
  const offer = payload?.data?.[String(service)]?.[String(country)]
    || payload?.[String(service)]?.[String(country)];
  if (!offer || typeof offer !== 'object') {
    return { quotes: [], total: 0, physical: 0, defaultPrice: null, retailPrice: null };
  }
  const quotes = Object.entries(offer.map || {})
    .map(([price, count]) => ({ price: toPrice(price), count: Number(count) }))
    .filter((entry) => entry.price !== null && Number.isFinite(entry.count) && entry.count > 0)
    .sort((a, b) => a.price - b.price);
  return {
    quotes,
    total: Number(offer.counts?.total) || 0,
    physical: Number(offer.counts?.physical) || 0,
    defaultPrice: toPrice(offer.prices?.default),
    retailPrice: toPrice(offer.prices?.retail),
  };
}

function offersUrl({ service = config.heroSms.service, country } = {}) {
  const base = new URL(config.heroSms.baseUrl);
  const url = new URL('/api/v1/activations/offers', base.origin);
  url.searchParams.set('services', String(service));
  if (country !== undefined && country !== null && country !== '') {
    url.searchParams.set('countries', String(country));
  }
  return url.toString();
}

async function fetchOffers({ service = config.heroSms.service, country } = {}) {
  return requestJson(offersUrl({ service, country }), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `ApiKey ${config.heroSms.apiKey}`,
    },
  }, 'HeroSMS 查询报价列表');
}

export async function fetchPriceQuotes({
  service = config.heroSms.service,
  country = config.heroSms.country,
} = {}) {
  const normalizedService = String(service || '').trim() || config.heroSms.service;
  const normalizedCountry = Number(country);
  if (!Number.isInteger(normalizedCountry) || normalizedCountry <= 0) throw new Error('国家 ID 不合法');
  const payload = await fetchOffers({ service: normalizedService, country: normalizedCountry });
  const result = parseOfferQuotes(payload, normalizedService, normalizedCountry);
  if (!result.quotes.length) throw new Error('HeroSMS 当前没有返回可用报价');
  return {
    ...result,
    service: normalizedService,
    country: normalizedCountry,
    selectedPrice: toPrice(config.heroSms.maxPrice),
    priceMode: config.heroSms.priority,
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchAvailableCountries({ service = config.heroSms.service } = {}) {
  const normalizedService = String(service || '').trim() || config.heroSms.service;
  const [countriesPayload, offersPayload] = await Promise.all([
    request({ action: 'getCountries' }, 'HeroSMS 查询国家列表'),
    fetchOffers({ service: normalizedService }),
  ]);
  const names = new Map(
    Object.values(countriesPayload || {}).map((country) => [String(country.id), {
      // 上游的 chn 简繁混杂、还有错译（不丹被译成「丁烷」），
      // 一律先查规范表 data/country-cn.json（scripts/build-country-cn.cjs 生成）
      name: String(CN_NAMES[String(country.id)] || country.chn || country.eng || country.rus || `国家 ${country.id}`),
      englishName: String(country.eng || ''),
    }]),
  );
  const offers = offersPayload?.data?.[normalizedService] || {};
  const countries = Object.entries(offers).map(([id, offer]) => {
    const details = names.get(String(id)) || { name: `国家 ${id}`, englishName: '' };
    const quoteCount = Object.values(offer?.map || {}).reduce((sum, count) => sum + (Number(count) > 0 ? 1 : 0), 0);
    return {
      id: Number(id),
      ...details,
      count: Number(offer?.counts?.total) || 0,
      physical: Number(offer?.counts?.physical) || 0,
      minPrice: toPrice(offer?.prices?.min ?? offer?.prices?.default),
      quoteCount,
    };
  }).filter((country) => Number.isInteger(country.id) && country.id > 0 && country.quoteCount > 0);
  countries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return { service: normalizedService, countries, fetchedAt: new Date().toISOString() };
}

// 递归从 getPrices 响应里收集「有库存」的价格档位
function collectInStockPrices(payload, out = []) {
  if (Array.isArray(payload)) {
    payload.forEach((entry) => collectInStockPrices(entry, out));
    return out;
  }
  if (!payload || typeof payload !== 'object') return out;

  const cost = toPrice(payload.cost);
  if (cost !== null) {
    const stock = Number(payload.count ?? payload.stock ?? payload.available ?? payload.qty);
    if (!Number.isFinite(stock) || stock > 0) out.push(cost);
  }
  for (const [key, value] of Object.entries(payload)) {
    const keyedPrice = toPrice(key);
    if (keyedPrice !== null) {
      if (value && typeof value === 'object') {
        const stock = Number(value.count ?? value.stock ?? value.available ?? value.qty);
        if (Number.isFinite(stock) && stock > 0) out.push(keyedPrice);
      } else if (Number(value) > 0) {
        out.push(keyedPrice);
      }
    }
    if (value && typeof value === 'object') collectInStockPrices(value, out);
  }
  return out;
}

// 查询当前配置国家的 OpenAI 各价格档位（升序、有库存）
async function fetchLegacyPriceCandidates() {
  const payload = await request(
    { action: 'getPrices', service: config.heroSms.service, country: config.heroSms.country },
    'HeroSMS 查询最低价格',
  );
  const cap = toPrice(config.heroSms.maxPrice);
  const prices = collectInStockPrices(payload)
    .filter((p) => cap === null || p <= cap)
    .sort((a, b) => a - b);
  return Array.from(new Set(prices)).slice(0, 8);
}

export async function fetchPriceCandidates() {
  const cap = toPrice(config.heroSms.maxPrice);
  try {
    const result = await fetchPriceQuotes();
    return result.quotes
      .map((entry) => entry.price)
      .filter((price) => cap === null || price <= cap)
      .slice(0, 8);
  } catch {
    return fetchLegacyPriceCandidates();
  }
}

export function parseAccessNumber(text) {
  const match = String(text).match(/^ACCESS_NUMBER:([^:]+):(.+)$/i);
  if (!match) return null;
  const phone = String(match[2]).trim();
  const international = phone.startsWith('+') ? phone : `+${phone}`;
  const parsed = parsePhoneNumberFromString(international);
  return {
    activationId: String(match[1]).trim(),
    phone,
    dialCode: parsed?.countryCallingCode || '',
    nationalNumber: parsed?.nationalNumber || '',
    isoCountry: parsed?.country || '',
    country: config.heroSms.country,
    service: config.heroSms.service,
  };
}

async function getNumberOnce({ maxPrice } = {}) {
  const query = {
    action: 'getNumber',
    service: config.heroSms.service,
    country: config.heroSms.country,
  };
  if (config.heroSms.operator && config.heroSms.operator !== 'any') {
    query.operator = config.heroSms.operator;
  }
  if (maxPrice !== undefined && maxPrice !== null) {
    query.maxPrice = maxPrice;
    query.fixedPrice = 'true';
  }
  const payload = await request(query, 'HeroSMS 取号');
  return { number: parseAccessNumber(describe(payload)), raw: describe(payload) };
}

// 按管理员配置的服务、国家与报价取号。
// 低价优先时：先查价，从最便宜档位逐档尝试；否则直接取号。
export async function requestNumber({ price } = {}) {
  const explicitPrice = toPrice(price);
  const configuredPrice = toPrice(config.heroSms.maxPrice);
  if (explicitPrice !== null || config.heroSms.priority === 'fixed') {
    const selected = explicitPrice ?? configuredPrice;
    if (selected === null) throw new Error('锁定报价取号前，请先在管理员界面选择价格');
    const { number, raw } = await getNumberOnce({ maxPrice: selected });
    if (!number) throw new Error(`所选报价 $${selected} 暂时无法取号，平台返回：${raw}`);
    return { ...number, price: selected };
  }
  if (config.heroSms.priority === 'price') {
    let candidates = [];
    try {
      candidates = await fetchPriceCandidates();
    } catch {
      candidates = [];
    }
    let lastRaw = '';
    for (const price of candidates) {
      const { number, raw } = await getNumberOnce({ maxPrice: price });
      if (number) return { ...number, price };
      lastRaw = raw;
    }
    // 价格档全部取号失败，退回不限价再试一次（价格未知）
    const fallback = await getNumberOnce({ maxPrice: config.heroSms.maxPrice || null });
    if (fallback.number) return { ...fallback.number, price: null };
    throw new Error(`取号未成功（低价优先已遍历 ${candidates.length} 档），平台返回：${fallback.raw || lastRaw}`);
  }

  // 直接取号：若设了上限则即为成交价，否则未知
  const cap = toPrice(config.heroSms.maxPrice);
  const { number, raw } = await getNumberOnce({ maxPrice: config.heroSms.maxPrice || null });
  if (!number) throw new Error(`取号未成功，平台返回：${raw}`);
  return { ...number, price: cap };
}

// 单次查询短信状态（前端轮询调用）
export async function getStatus(activationId) {
  const id = String(activationId || '').trim();
  if (!id) throw new Error('缺少 activationId');
  const payload = await request({ action: 'getStatus', id }, 'HeroSMS 查询状态');
  const text = describe(payload);

  const ok = text.match(/^STATUS_OK:(.+)$/i);
  if (ok) {
    const sms = ok[1].trim();
    const code = extractCode(sms);
    // 「短信到了但抽不出码」和「短信还没到」是两件事，这里仍然都返回 waiting
    // （改状态契约会连带影响前端渲染，单独一轮再动），
    // 但**必须留一行日志** —— 否则买家转圈到超时，我们这边一无所知，
    // 事后连"哪种短信格式抽不出来"都无从统计。
    if (!code) {
      console.warn(`[hero] 收到短信但抽不出验证码，原文：${sms.slice(0, 120)}`);
      return { state: 'waiting', code: '', sms, raw: text, extractFailed: true };
    }
    return { state: 'code', code, sms, raw: text };
  }
  if (/^STATUS_(WAIT_CODE|WAIT_RETRY|WAIT_RESEND)/i.test(text)) {
    return { state: 'waiting', code: '', raw: text };
  }
  if (/^STATUS_CANCEL$/i.test(text)) {
    return { state: 'cancel', code: '', raw: text };
  }
  return { state: 'unknown', code: '', raw: text };
}

// 设置订单状态：1=已收到号准备接收 3=再要一条 6=完成 8=取消
async function setStatus(activationId, status, label) {
  const id = String(activationId || '').trim();
  if (!id) throw new Error('缺少 activationId');
  const payload = await request(
    { action: 'setStatus', id, status: Math.floor(Number(status) || 0) },
    label,
  );
  return { ok: true, raw: describe(payload) };
}

export const finishNumber = (id) => setStatus(id, 6, 'HeroSMS 完成订单');
export const cancelNumber = (id) => setStatus(id, 8, 'HeroSMS 取消订单');
export const requestAnotherSms = (id) => setStatus(id, 3, 'HeroSMS 再要一条短信');
