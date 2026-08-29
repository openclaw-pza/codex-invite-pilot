// 买家手选价位（「换个更贵的号」）的行为边界。
//
// 为什么要有这个功能：便宜档的号大多是回收复用的，注册时会被判「该号码已被使用」。
// 连撞几次之后买家需要一个「我愿意多花两毛钱换个干净号」的出口，
// 否则只能反复换号撞同一档，或者干等到号过期。
import test from 'node:test';
import assert from 'node:assert/strict';
import { vendGetNumberTiered } from '../server/vend-hero.js';

function fakeHero(available) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const price = Number(new URL(url).searchParams.get('maxPrice'));
    calls.push(price);
    return new Response(
      available.some((p) => price >= p) ? 'ACCESS_NUMBER:9001:66812345678' : 'NO_NUMBERS',
      { status: 200 },
    );
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const TH_OPENAI = [0.11, 0.1724, 0.1925, 0.2459, 0.2506];

test('选了下限就从那一档开始，便宜档一个都不试', async () => {
  const hero = fakeHero([0.1925]);
  try {
    const r = await vendGetNumberTiered({
      service: 'dr', country: 52, tiers: TH_OPENAI, budgetUsd: 0.5,
      minPriceUsd: 0.1925,
    });
    assert.equal(r.ok, true);
    assert.equal(r.paidUsd, 0.1925);
    assert.ok(!hero.calls.some((p) => p < 0.1925), `试了下限以下的档：${hero.calls}`);
  } finally { hero.restore(); }
});

test('下限优先于自动跳档，不叠加', async () => {
  // skipCheapest 会跳掉最便宜的；如果两个叠加，买家选的 0.1724 会被跳成 0.1925
  const hero = fakeHero([0.1724]);
  try {
    const r = await vendGetNumberTiered({
      service: 'dr', country: 52, tiers: TH_OPENAI, budgetUsd: 0.5,
      skipCheapest: 1, minPriceUsd: 0.1724,
    });
    assert.equal(r.paidUsd, 0.1724, '买家明确选的档不能被自动跳档吃掉');
    assert.equal(hero.calls[0], 0.1724);
  } finally { hero.restore(); }
});

test('选的档没货就往上找，仍然不回头买便宜的', async () => {
  const hero = fakeHero([0.2459]);
  try {
    const r = await vendGetNumberTiered({
      service: 'dr', country: 52, tiers: TH_OPENAI, budgetUsd: 0.5,
      minPriceUsd: 0.1724,
    });
    assert.equal(r.paidUsd, 0.2459);
    assert.deepEqual(hero.calls, [0.1724, 0.1925, 0.2459], '要从下限往上逐档试');
    assert.ok(!hero.calls.includes(0.11));
  } finally { hero.restore(); }
});

test('下限之上全部超预算时，给可买的最高档——不能悄悄给回最便宜的', async () => {
  // 买家选了 $0.25，但卡里只剩 $0.19。悄悄给他 $0.11 那档 = 他以为换了、其实没换，
  // 还是同一批回收号，验证照样失败，只会让他觉得功能是假的。
  const hero = fakeHero([0.1724]);
  try {
    const r = await vendGetNumberTiered({
      service: 'dr', country: 52, tiers: TH_OPENAI, budgetUsd: 0.19,
      minPriceUsd: 0.25,
    });
    assert.equal(r.ok, true);
    assert.equal(r.paidUsd, 0.1724, '预算内最高的那档');
    assert.ok(!hero.calls.includes(0.11));
  } finally { hero.restore(); }
});

test('预算一档都买不起时照实失败，不越预算出价', async () => {
  const hero = fakeHero([0.11]);
  try {
    const r = await vendGetNumberTiered({
      service: 'dr', country: 52, tiers: [0.5, 0.8], budgetUsd: 0.19,
      minPriceUsd: 0.5,
    });
    assert.equal(r.ok, false);
    assert.equal(hero.calls.length, 0, '一次都不该出价');
  } finally { hero.restore(); }
});

test('下限为 0 / 非法值时回到自动逐档，不报错', async () => {
  for (const bad of [0, -1, 'abc', null, undefined, NaN]) {
    const hero = fakeHero([0.11]);
    try {
      const r = await vendGetNumberTiered({
        service: 'dr', country: 52, tiers: [0.11, 0.1724], budgetUsd: 0.19,
        minPriceUsd: bad,
      });
      assert.equal(r.paidUsd, 0.11, `minPriceUsd=${String(bad)} 应该回到自动逐档`);
    } finally { hero.restore(); }
  }
});

test('选的档位刚被取完时，不能叫买家去换国家', async () => {
  // 上游库存实测 20 秒内会来回跳（$0.1925 那档消失又出现），而报价缓存 30 秒，
  // 所以「买家看到的档位已经没了」是常态而非例外。
  // 这时候套用 NO_NUMBERS 的通用文案「这个地区暂时没号了，换一个地区试试」
  // 是错的引导：这个国家还有号，没的只是他选的那一档。
  const hero = fakeHero([]);   // 全都没货
  try {
    const r = await vendGetNumberTiered({
      service: 'dr', country: 52, tiers: TH_OPENAI, budgetUsd: 0.5,
      minPriceUsd: 0.1925,
    });
    assert.equal(r.ok, false);
    assert.match(r.message, /价位/, `不该是通用文案：${r.message}`);
    assert.equal(/换一个地区/.test(r.message), false, '这个国家还有号，别把买家赶走');
  } finally { hero.restore(); }
});

test('没选价位时仍然用通用文案（这时候换国家才是对的建议）', async () => {
  const hero = fakeHero([]);
  try {
    const r = await vendGetNumberTiered({
      service: 'dr', country: 52, tiers: TH_OPENAI, budgetUsd: 0.5,
    });
    assert.equal(r.ok, false);
    assert.match(r.message, /换一个地区/);
  } finally { hero.restore(); }
});
