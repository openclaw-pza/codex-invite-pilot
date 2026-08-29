// 上游余额告警。
//
// 为什么这条告警重要：余额见底时 HeroSMS 回 NO_BALANCE，我们翻译成
// 「这个地区暂时取不了号，先换一个地区试试」（刻意不告诉买家是卖家没钱）。
// 于是买家换遍所有地区、全部失败、退款+差评，而卖家侧**一个信号都没有**。
// 这封邮件是这个静默失败模式唯一的可见出口，所以它自己不能也静默坏掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkBalanceOnce, balanceThresholdUsd, __resetBalanceWatch } from '../server/balanceWatch.js';

function fakeBalance(value) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    typeof value === 'number' ? `ACCESS_BALANCE:${value}` : String(value),
    { status: 200 },
  );
  return () => { globalThis.fetch = original; };
}

test('低于阈值发信，高于阈值不发', async (t) => {
  t.afterEach(__resetBalanceWatch);

  __resetBalanceWatch();
  let restore = fakeBalance(0.42);
  let sent = [];
  let r = await checkBalanceOnce({ notify: (b, th) => { sent.push([b, th]); return true; } });
  restore();
  assert.equal(r.low, true);
  assert.equal(r.sent, true);
  assert.deepEqual(sent, [[0.42, 1]]);

  __resetBalanceWatch();
  restore = fakeBalance(5.5);
  sent = [];
  r = await checkBalanceOnce({ notify: () => { sent.push('x'); return true; } });
  restore();
  assert.equal(r.low, false);
  assert.equal(sent.length, 0);
});

test('同一次见底不重复轰炸（6 小时冷却）', async (t) => {
  t.afterEach(__resetBalanceWatch);
  __resetBalanceWatch();
  const restore = fakeBalance(0.1);
  let count = 0;
  const notify = () => { count += 1; return true; };
  const t0 = 1_000_000_000_000;

  await checkBalanceOnce({ now: t0, notify });
  await checkBalanceOnce({ now: t0 + 60_000, notify });
  await checkBalanceOnce({ now: t0 + 3 * 3600_000, notify });
  assert.equal(count, 1, '冷却期内只该发一封');

  await checkBalanceOnce({ now: t0 + 7 * 3600_000, notify });
  assert.equal(count, 2, '过了 6 小时该再提醒一次');
  restore();
});

test('充值回升后再次见底要能立刻再提醒——不能被冷却压住', async (t) => {
  t.afterEach(__resetBalanceWatch);
  __resetBalanceWatch();
  let count = 0;
  const notify = () => { count += 1; return true; };
  const t0 = 2_000_000_000_000;

  let restore = fakeBalance(0.2);
  await checkBalanceOnce({ now: t0, notify });
  restore();
  assert.equal(count, 1);

  // 安哥充值了
  restore = fakeBalance(20);
  await checkBalanceOnce({ now: t0 + 600_000, notify });
  restore();
  assert.equal(count, 1);

  // 又花光了 —— 这次必须马上提醒，哪怕距上一封还不到 6 小时
  restore = fakeBalance(0.3);
  await checkBalanceOnce({ now: t0 + 1_200_000, notify });
  restore();
  assert.equal(count, 2, '回升后再次见底必须立刻提醒');
});

test('查不到余额时不发信——上游抖一下就报警会变成狼来了', async (t) => {
  t.afterEach(__resetBalanceWatch);
  __resetBalanceWatch();
  const restore = fakeBalance('BAD_KEY');
  let count = 0;
  const r = await checkBalanceOnce({ notify: () => { count += 1; return true; } });
  restore();
  assert.equal(r.checked, false);
  assert.equal(count, 0);
});

test('阈值可配，非法值回落到 $1', () => {
  const saved = process.env.VEND_BALANCE_ALERT_USD;
  for (const [raw, expected] of [['2.5', 2.5], ['0', 1], ['-3', 1], ['abc', 1], [undefined, 1]]) {
    if (raw === undefined) delete process.env.VEND_BALANCE_ALERT_USD;
    else process.env.VEND_BALANCE_ALERT_USD = raw;
    assert.equal(balanceThresholdUsd(), expected, `VEND_BALANCE_ALERT_USD=${raw}`);
  }
  if (saved === undefined) delete process.env.VEND_BALANCE_ALERT_USD;
  else process.env.VEND_BALANCE_ALERT_USD = saved;
});
