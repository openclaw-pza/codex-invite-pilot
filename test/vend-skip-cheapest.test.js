// 跳过最便宜档位（回收号池）的行为与那条不变量。
//
// 背景：泰国 OpenAI 的档位是 $0.11(28个) / $0.1724(1156个) / $0.1925(5239个)——
// 最低档号少得离谱，因为那就是被反复用过的回收池，拿去注册直接「该号码已被使用」。
// 所以取号时跳掉最低档。但跳档有个绝不能破的底线，见最后两个用例。
import test from 'node:test';
import assert from 'node:assert/strict';
import { vendGetNumberTiered } from '../server/vend-hero.js';
import { VEND_DEFAULTS, loadVendConfig } from '../server/vend-config.js';

// 假平台：只有 available 里列出的价位有货，其余返回 NO_NUMBERS。
// 记下每一次出价，用来断言「试了哪些档、没试哪些档」。
function fakeHero(available) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const price = Number(new URL(url).searchParams.get('maxPrice'));
    calls.push(price);
    const hit = available.some((p) => price >= p);
    return new Response(hit ? 'ACCESS_NUMBER:9001:66812345678' : 'NO_NUMBERS', { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('跳 1 档：最便宜那档一次都不试', async () => {
  const hero = fakeHero([0.1724]);
  try {
    const r = await vendGetNumberTiered({
      service: 'dr', country: 52,
      tiers: [0.11, 0.1724, 0.1925, 0.2459],
      budgetUsd: 0.19,
      skipCheapest: 1,
    });
    assert.equal(r.ok, true);
    assert.equal(r.paidUsd, 0.1724);
    assert.ok(!hero.calls.includes(0.11), '$0.11 是回收池，一次都不该出价');
    assert.deepEqual(hero.calls, [0.1724], '预算 $0.19 装不下 $0.1925，所以只剩这一档');
  } finally { hero.restore(); }
});

test('跳档不改变「绝不超预算」', async () => {
  const hero = fakeHero([0.9]);  // 只有超预算的档位有货
  try {
    const r = await vendGetNumberTiered({
      service: 'dr', country: 52,
      tiers: [0.11, 0.1724, 0.1925, 0.9],
      budgetUsd: 0.19,
      skipCheapest: 1,
    });
    assert.equal(r.ok, false, '预算内买不到就该失败，而不是加价买');
    assert.ok(!hero.calls.some((p) => p > 0.19), `出价超预算了：${hero.calls}`);
  } finally { hero.restore(); }
});

// ---------- 不变量：跳档绝不能把「买得到」变成「买不到」 ----------

test('预算只够最低一档时，必须退回原列表而不是放弃', async () => {
  const hero = fakeHero([0.11]);
  try {
    const r = await vendGetNumberTiered({
      service: 'dr', country: 52,
      tiers: [0.11, 0.1724, 0.1925],
      budgetUsd: 0.12,          // 只有 $0.11 在预算内
      skipCheapest: 1,
    });
    assert.equal(r.ok, true, '跳完为空必须退回完整列表——宁可买回收号也不能让买家一个号都取不到');
    assert.deepEqual(hero.calls, [0.11]);
  } finally { hero.restore(); }
});

test('只有一个档位时跳档不生效', async () => {
  const hero = fakeHero([0.605]);
  try {
    const r = await vendGetNumberTiered({
      service: 'dr', country: 187,
      tiers: [0.605],           // 美国 OpenAI 真的只有 2 档，预算内常常只剩 1 档
      budgetUsd: 0.99,
      skipCheapest: 1,
    });
    assert.equal(r.ok, true);
    assert.deepEqual(hero.calls, [0.605]);
  } finally { hero.restore(); }
});

test('skipCheapest=0 时行为跟改动前完全一致', async () => {
  const hero = fakeHero([0.11]);
  try {
    const r = await vendGetNumberTiered({
      service: 'dr', country: 52,
      tiers: [0.11, 0.1724],
      budgetUsd: 0.19,
      skipCheapest: 0,
    });
    assert.equal(r.paidUsd, 0.11, '关掉跳档就该买回最便宜那档');
    assert.deepEqual(hero.calls, [0.11]);
  } finally { hero.restore(); }
});

test('不传 skipCheapest 默认不跳（老调用方不受影响）', async () => {
  const hero = fakeHero([0.11]);
  try {
    const r = await vendGetNumberTiered({
      service: 'dr', country: 52, tiers: [0.11, 0.1724], budgetUsd: 0.19,
    });
    assert.equal(r.paidUsd, 0.11);
  } finally { hero.restore(); }
});

// ---------- 配置闸 ----------

test('跳档数只接受 0~3 的整数，其余当配置错误回落默认', () => {
  assert.equal(VEND_DEFAULTS.skipCheapestTiers, 1);
  const cases = [
    ['-1', 1], ['0.5', 1], ['99', 1],      // 非法 → 回落默认 1
    ['0', 0], ['2', 2], ['3', 3],          // 合法
  ];
  for (const [raw, expected] of cases) {
    process.env.VEND_SKIP_CHEAPEST_TIERS = raw;
    const config = loadVendConfig({ force: true });
    assert.equal(config.skipCheapestTiers, expected, `VEND_SKIP_CHEAPEST_TIERS=${raw}`);
  }
  delete process.env.VEND_SKIP_CHEAPEST_TIERS;
  loadVendConfig({ force: true });
});
