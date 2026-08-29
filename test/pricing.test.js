// pricing.test.js — 换算与面额闸门
//
// 用例里的美元报价全部是 2026-08-20 从 HeroSMS 实盘拉的 dr(OpenAI) 价，不是编的。

import test from 'node:test';
import assert from 'node:assert/strict';

import { usdToCny, round2, priceRegion, priceRegions, checkRegionAllowed, maxPriceUsdFor } from '../server/pricing.js';

// 实盘样本：id / 中文名 / dr 最低价(USD) / 库存
const SAMPLE = [
  { id: 4, name: '菲律宾', minPrice: 0.0275, count: 12354 },
  { id: 16, name: '英格兰', minPrice: 0.0413, count: 3610 },
  { id: 48, name: '荷兰', minPrice: 0.0825, count: 79540 },
  { id: 15, name: '波兰', minPrice: 0.11, count: 34776 },
  { id: 46, name: '瑞典', minPrice: 0.22, count: 6018 },
  { id: 187, name: '美国（物理)', minPrice: 0.605, count: 371051 },
];

test('美元换人民币按系数走，两位小数', () => {
  assert.equal(usdToCny(0.0275, 10), 0.28);
  assert.equal(usdToCny(0.11, 10), 1.1);
  assert.equal(usdToCny(0.605, 10), 6.05);
  assert.equal(usdToCny(0.22, 10), 2.2);
  // 系数可改，改完价格要跟着变
  assert.equal(usdToCny(0.11, 8), 0.88);
});

test('非法输入不返回 NaN，一律给 null（NaN 显示给买家就是事故）', () => {
  assert.equal(usdToCny(undefined, 10), null);
  assert.equal(usdToCny(0.11, 0), null);
  assert.equal(usdToCny(0.11, -3), null);
  assert.equal(usdToCny('不是数字', 10), null);
  assert.equal(round2('x'), null);
});

test('浮点数陷阱：差价必须是干净的两位小数', () => {
  // 裸算是 4.149999999999999 和 0.30000000000000004
  assert.equal(round2(6.05 - 1.9), 4.15);
  assert.equal(round2(2.2 - 1.9), 0.3);

  const sweden = priceRegion(SAMPLE[4], { rate: 10, denomCny: 1.9 });
  assert.equal(sweden.topupCny, 0.3, `瑞典差价算成了 ${sweden.topupCny}`);

  const usa = priceRegion(SAMPLE[5], { rate: 10, denomCny: 1.9 });
  assert.equal(usa.topupCny, 4.15, `美国差价算成了 ${usa.topupCny}`);
});

test('面额闸门：¥1.90 的卡放行波兰，拦下瑞典和美国', () => {
  const result = priceRegions(SAMPLE, { rate: 10, denomCny: 1.9 });
  const byName = Object.fromEntries(result.regions.map((r) => [r.name, r]));

  assert.equal(byName['波兰'].over, false);
  assert.equal(byName['波兰'].priceCny, 1.1);
  assert.equal(byName['瑞典'].over, true);
  assert.equal(byName['美国（物理)'].over, true);
  assert.equal(result.withinBudget, 4);
  assert.equal(result.overBudget, 2);
});

test('没验卡密时不做闸门，但价格照常显示', () => {
  const result = priceRegions(SAMPLE, { rate: 10, denomCny: null });
  assert.equal(result.overBudget, 0);
  assert.ok(result.regions.every((r) => r.over === false && r.topupCny === 0));
  assert.equal(result.regions[0].priceCny, 0.28, '仍要按价格排序');
});

test('按人民币价升序排列，最便宜的排最前', () => {
  const { regions } = priceRegions(SAMPLE, { rate: 10, denomCny: 1.9 });
  const prices = regions.map((r) => r.priceCny);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  assert.equal(regions[0].name, '菲律宾');
});

test('算不出价格的地区直接不上架，不能让买家点到', () => {
  const dirty = [...SAMPLE, { id: 999, name: '价格缺失国', minPrice: null, count: 100 }];
  const { regions, total } = priceRegions(dirty, { rate: 10, denomCny: 1.9 });
  assert.equal(total, SAMPLE.length);
  assert.ok(!regions.some((r) => r.name === '价格缺失国'));
});

test('取号前的闸：额度内放行 / 超额要补 / 补过了放行 / 没卡密一律拒', () => {
  const poland = SAMPLE[3];
  const usa = SAMPLE[5];

  assert.deepEqual(
    checkRegionAllowed({ region: poland, denomCny: 1.9, rate: 10 }),
    { allowed: true, reason: null, priceCny: 1.1, topupCny: 0, budgetCny: 1.9 },
  );

  const blocked = checkRegionAllowed({ region: usa, denomCny: 1.9, rate: 10 });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'need_topup');
  assert.equal(blocked.topupCny, 4.15);

  // 补款按**实付金额**参与预算，不是一个布尔量
  const afterTopup = checkRegionAllowed({ region: usa, denomCny: 1.9, rate: 10, topupPaidCny: 4.15 });
  assert.equal(afterTopup.allowed, true);
  assert.equal(afterTopup.reason, 'topup_confirmed');
  assert.equal(afterTopup.budgetCny, 6.05);

  // 地区涨价后（$0.605 → $1.20），原来那笔补款不够了，必须再拦下来，
  // 不能让差额由卖家垫
  const raised = checkRegionAllowed({ region: { minPrice: 1.2 }, denomCny: 1.9, rate: 10, topupPaidCny: 4.15 });
  assert.equal(raised.allowed, false, '地区涨价后旧补款不该继续放行');
  assert.equal(raised.topupCny, 5.95);

  // 没验卡密就想取号，必须拒
  assert.equal(checkRegionAllowed({ region: poland, denomCny: null, rate: 10 }).reason, 'no_card');
  // 价格拿不到也必须拒，绝不能"先取了再说"
  assert.equal(checkRegionAllowed({ region: { minPrice: null }, denomCny: 1.9, rate: 10 }).reason, 'no_price');
});

test('给 HeroSMS 的出价上限向下取整，宁可少买一档也不能买超', () => {
  // ¥1.90 面额、系数 10 → 最多出 $0.19
  assert.equal(maxPriceUsdFor({ denomCny: 1.9, rate: 10 }), 0.19);
  // 补了差价，预算跟着涨
  assert.equal(maxPriceUsdFor({ denomCny: 1.9, rate: 10, topupCny: 4.15 }), 0.605);
  // 除不尽时必须向下，不能四舍五入到超预算
  assert.equal(maxPriceUsdFor({ denomCny: 1.0, rate: 3 }), 0.3333);
  assert.equal(maxPriceUsdFor({ denomCny: null, rate: 10 }), null);
});

test('美国用 ¥1.90 卡取号，出价上限必须低于美国实际报价（否则就是亏本卖）', () => {
  const cap = maxPriceUsdFor({ denomCny: 1.9, rate: 10 });
  assert.ok(cap < 0.605, `出价上限 ${cap} 没能拦住 $0.605 的美国号`);
});

// ---------- 默认汇率就是毛利率，改它 = 改钱 ----------
//
// rate 是个不起眼的数字，但它同时决定三件事：展示给买家的价、卡密能买到哪些档、毛利率。
// 上面那些用例都显式传 rate，测的是函数；**没有一条盯着默认值**。
// 少了这条，谁把 DEFAULTS.rate 从 9 改回 10 或改成 8，毛利率会无声地跟着变。

test('默认 rate 对应 20% 毛利（汇率按 $1≈¥7.2）', async () => {
  const { VEND_DEFAULTS } = await import('../server/vend-config.js');
  const FX = 7.2;
  const margin = 1 - FX / VEND_DEFAULTS.rate;

  assert.equal(VEND_DEFAULTS.rate, 9, '安哥 2026-08-23 定的：引流品，20% 毛利');
  assert.ok(Math.abs(margin - 0.20) < 0.005, `毛利率变成了 ${(margin * 100).toFixed(1)}%`);

  // 反过来钉死那条关系，别让人只改数字不改注释
  assert.ok(margin > 0, 'rate 低于汇率就是每单亏钱');
  assert.ok(VEND_DEFAULTS.rate > FX, `rate 必须大于汇率 ${FX}`);
});

test('rate 越低买家预算越高、展示价越低——两边必须同向', async () => {
  const { VEND_DEFAULTS } = await import('../server/vend-config.js');
  const denomCny = 1.9;
  const upstreamUsd = 0.1925;   // 泰国 OpenAI 实测的一档

  // 这一档在 rate=10 时买不起（展示 ¥1.93 > 面额 ¥1.9），rate=9 时买得起（展示 ¥1.73）
  const at10 = priceRegion({ id: 1, name: 'T', minPrice: upstreamUsd }, { rate: 10, denomCny });
  const at9 = priceRegion({ id: 1, name: 'T', minPrice: upstreamUsd }, { rate: 9, denomCny });
  assert.equal(at10.over, true, 'rate=10 时这一档超预算');
  assert.equal(at9.over, false, 'rate=9 时应该买得起');
  assert.ok(at9.priceCny < at10.priceCny, '降 rate 展示价也要跟着降');

  // 当前默认值下这一档必须是可买的，否则「引流品」这个定位就没落地
  const now = priceRegion({ id: 1, name: 'T', minPrice: upstreamUsd }, { rate: VEND_DEFAULTS.rate, denomCny });
  assert.equal(now.over, false, '默认 rate 下 ¥1.9 卡应该够得到 $0.1925 这档');
});
