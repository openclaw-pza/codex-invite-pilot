// pricing.js — 美元报价 → 人民币售价 + 面额闸门
//
// 只有一条公式：人民币价 = HeroSMS 报价($) × rate。
// rate 默认 10，按 $1≈¥7.2 算等于在成本上留约 28% 毛利（毛利率 = 1 − 汇率/rate）。
// 把 rate 调低会直接吃掉这部分利润，改之前先想清楚。
//
// 闸门规则：
//   人民币价 ≤ 卡密面额        → 直接可选
//   人民币价 >  卡密面额        → 标记超额，给出应补金额，走补差价流程
//   没有卡密（还没验证）        → 不做闸门，全部照常显示，只标价格

// 金额一律走「乘 100 取整再除回」，避免 6.05 − 1.90 算出 4.149999999999999。
export function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

export function usdToCny(usd, rate) {
  const n = Number(usd);
  const r = Number(rate);
  if (!Number.isFinite(n) || !Number.isFinite(r) || r <= 0) return null;
  return round2(n * r);
}

// 给单个地区算价与闸门状态。
// denomCny 传 null 表示「还没验卡密」——此时不判超额，让买家先看得到价格。
export function priceRegion(region, { rate, denomCny = null }) {
  const priceCny = usdToCny(region.minPrice, rate);
  const gated = denomCny != null && priceCny != null;
  const over = gated ? priceCny > Number(denomCny) : false;
  return {
    id: region.id,
    name: region.name,
    englishName: region.englishName || '',
    count: Number(region.count) || 0,
    physical: Number(region.physical) || 0,
    priceUsd: region.minPrice == null ? null : Number(region.minPrice),
    priceCny,
    over,
    topupCny: over ? round2(priceCny - Number(denomCny)) : 0,
    // 价格拿不到的地区不能卖：宁可不显示，也不能让买家点一个算不出钱的地区
    sellable: priceCny != null && priceCny > 0,
  };
}

// 批量处理 + 排序 + 汇总。
// 排序按人民币价升序，价格缺失的排最后——买家最关心的是「最便宜能用的是哪个」。
export function priceRegions(regions, { rate, denomCny = null }) {
  const priced = (Array.isArray(regions) ? regions : [])
    .map((region) => priceRegion(region, { rate, denomCny }))
    .filter((region) => region.sellable);

  priced.sort((a, b) => a.priceCny - b.priceCny);

  const withinBudget = denomCny == null ? priced.length : priced.filter((r) => !r.over).length;
  return {
    regions: priced,
    total: priced.length,
    withinBudget,
    overBudget: priced.length - withinBudget,
    rate: Number(rate),
    denomCny: denomCny == null ? null : Number(denomCny),
  };
}

// 取号前的最后一道闸：这张卡能不能买这个地区。
// 超额且没核对过补差价 → 拒绝。这条是不变量 5，审计要逐条验。
// topupPaidCny = **已经核对到账的补款金额**。预算按「面额 + 实付补款」算，
// 不能只拿一个布尔量放行：地区涨价后（$1.2 → $3）差额就成了卖家在替买家垫，
// 而且没有任何上限——涨多少垫多少。
export function checkRegionAllowed({ region, denomCny, rate, topupPaidCny = null, spentCny = 0 }) {
  const priceCny = usdToCny(region?.minPrice, rate);
  if (priceCny == null || priceCny <= 0) {
    return { allowed: false, reason: 'no_price', priceCny: null, topupCny: 0, budgetCny: null };
  }
  if (denomCny == null) {
    return { allowed: false, reason: 'no_card', priceCny, topupCny: 0, budgetCny: null };
  }
  const paid = Number(topupPaidCny) > 0 ? Number(topupPaidCny) : 0;
  // 已经花掉的必须扣掉。多次收码的卡是**共用钱包**：
  // 不扣的话 ¥3.99 的卡三次各花 ¥3.99，成本 ¥8.6 卖 ¥3.99，一单亏 ¥4.6。
  const spent = Number(spentCny) > 0 ? Number(spentCny) : 0;
  const budgetCny = round2(Number(denomCny) + paid - spent);
  if (priceCny <= budgetCny) {
    return { allowed: true, reason: paid > 0 ? 'topup_confirmed' : null, priceCny, topupCny: paid, budgetCny };
  }
  return { allowed: false, reason: 'need_topup', priceCny, topupCny: round2(priceCny - budgetCny), budgetCny };
}

// 给 HeroSMS 的 maxPrice：卡密面额换算回美元，作为出价上限。
// 不设上限的话，低价优先逻辑遍历到高价档会买到超出面额的号——那是亏本卖。
// quotedUsd = 当前展示给买家的平台报价。**必须传**，否则会拿卡密面额当出价上限：
// ¥1.9 的卡去买 ¥0.5 的地区，出价 $0.19 而报价只要 $0.05——
// 而且请求带了 fixedPrice=true，按面额出价等于把毛利直接送掉。
// heroSms.js 原有的低价优先逻辑传的也是真实档位价，不是任意预算值。
export function maxPriceUsdFor({ denomCny, rate, topupCny = 0, quotedUsd = null }) {
  // 注意：Number(null) === 0 而不是 NaN，所以必须先挡 null/undefined，
  // 否则没面额时会算出「出价上限 0 美元」并当成有效值发给 HeroSMS。
  if (denomCny === null || denomCny === undefined) return null;
  const denom = Number(denomCny);
  const rateNum = Number(rate);
  const topup = Number(topupCny || 0);
  if (!Number.isFinite(denom) || denom <= 0) return null;
  if (!Number.isFinite(rateNum) || rateNum <= 0) return null;
  if (!Number.isFinite(topup) || topup < 0) return null;
  // 向下取到 4 位小数：宁可少买一档，也不能因为进位买超
  const budgetUsd = Math.floor(((denom + topup) / rateNum) * 10000) / 10000;
  const quoted = Number(quotedUsd);
  if (quotedUsd == null || !Number.isFinite(quoted) || quoted <= 0) return budgetUsd;
  return Math.min(budgetUsd, Math.round(quoted * 10000) / 10000);
}
