// vend-ledger-mail.test.js — 退款对账 + 临时邮箱完整功能的回归测试
//
// 这两块都直接关系到钱和隐私：
//   · 对账：本地标了「已取消」不等于平台真退了钱，账面必须能查出哪几笔钱还挂着
//   · 邮箱：后台接口能读任意地址，归属校验是唯一的安全边界
//
// 红线：只用临时目录的库，不碰 data/vend.sqlite；不发任何真实网络请求。

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';

import { CardStore } from '../server/cards.js';
import { normalizeLocalPart } from '../server/cloudflareEmail.js';

function freshStore(t) {
  const dir = join(tmpdir(), `vend-ledger-${randomUUID()}`);
  const store = new CardStore(join(dir, 'vend.sqlite'));
  t.after(() => {
    try { store.close(); } catch { /* 已关 */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });
  return store;
}

// 造一条已下单的记录，模拟真实取号流程走到 waiting
function seedActivation(store, { activationId, priceUsd = 0.05, priceCny = 0.5 }) {
  const { card } = store.issueCard({ denomCny: 1.9, orderId: `order-${activationId}` });
  const reservation = store.reserve({ code: card.code, country: 4, service: 'dr' });
  store.fulfill(reservation.reservationId, {
    activationId,
    phone: `1000${activationId}`,
    priceUsd,
    priceCny,
  });
  return card;
}

// ---------- 退款对账 ----------

test('平台真退了钱 → 记 refunded，不进风险名单', (t) => {
  const store = freshStore(t);
  seedActivation(store, { activationId: '900001' });

  store.cancel('900001', 'cancelled', { state: 'refunded', raw: 'ACCESS_CANCEL' });

  const row = store.listMoneyAtRisk({});
  assert.equal(row.length, 0, '已退款的不该出现在风险名单里');

  const summary = store.ledgerSummary({});
  assert.equal(summary.refundedUsd, 0.05);
  assert.equal(summary.atRiskUsd, 0, '退回来的钱不算挂账');
});

test('平台拒退 → 记 denied，钱要出现在风险名单里', (t) => {
  const store = freshStore(t);
  seedActivation(store, { activationId: '900002', priceUsd: 0.12, priceCny: 1.2 });

  store.cancel('900002', 'cancelled', { state: 'denied', raw: 'NO_ACTIVATION' });

  const rows = store.listMoneyAtRisk({});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].activationId, '900002');
  assert.equal(rows[0].refundState, 'denied');
  assert.equal(rows[0].refundRaw, 'NO_ACTIVATION');
  assert.equal(rows[0].priceUsd, 0.12);
  // 卡密只露后四位，运维面板不该把完整卡密摊出来
  assert.equal(rows[0].codeTail.length, 4);

  assert.equal(store.ledgerSummary({}).atRiskUsd, 0.12);
});

test('没带退款结论地取消 → 算作 unknown，同样进风险名单', (t) => {
  const store = freshStore(t);
  seedActivation(store, { activationId: '900003', priceUsd: 0.07 });

  store.cancel('900003'); // 老调用方式，不传第三个参数

  const rows = store.listMoneyAtRisk({});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].refundState, 'unknown', '不知道退没退 = 当作没退，宁可多查一笔');
  assert.equal(store.ledgerSummary({}).atRiskUsd, 0.07);
});

test('收到验证码的单子是正常消耗，不是挂账', (t) => {
  const store = freshStore(t);
  seedActivation(store, { activationId: '900004', priceUsd: 0.09 });
  store.consume('900004', '123456');

  assert.equal(store.listMoneyAtRisk({}).length, 0, '已成交的不该报到风险名单');
  const summary = store.ledgerSummary({});
  assert.equal(summary.consumedUsd, 0.09);
  assert.equal(summary.atRiskUsd, 0);
  assert.equal(summary.spentUsd, 0.09);
});

test('时间窗之外的旧单子不进名单', (t) => {
  const store = freshStore(t);
  seedActivation(store, { activationId: '900005' });
  store.cancel('900005', 'cancelled', { state: 'denied', raw: 'X' });

  assert.equal(store.listMoneyAtRisk({ sinceMs: 1 }).length, 0, '1ms 窗口内不该有记录');
  assert.equal(store.listMoneyAtRisk({ sinceMs: 60_000 }).length, 1);
});

// ---------- 临时邮箱 ----------

test('自定义前缀：太短/太长/保留词都要挡', () => {
  assert.throws(() => normalizeLocalPart('ab'), /至少 3/);
  assert.throws(() => normalizeLocalPart('a'.repeat(17)), /最多 16/);
  assert.throws(() => normalizeLocalPart('admin'), /不能用/);
  assert.throws(() => normalizeLocalPart('OpenAI'), /不能用/, '大小写不该能绕过保留词');
  // 分隔符不计入长度：后台本来就会把它们剥掉
  assert.throws(() => normalizeLocalPart('a-b'), /至少 3/);
});

test('自定义前缀：合法输入原样留给后台，非法字符先剥掉', () => {
  assert.equal(normalizeLocalPart('MyBox'), 'mybox');
  assert.equal(normalizeLocalPart('my-box_1'), 'my-box_1');
  assert.equal(normalizeLocalPart('我的box123'), 'box123', '中文剥掉后仍够长就放行');
  assert.equal(normalizeLocalPart(''), null, '不填 = 随机，不是错误');
  assert.equal(normalizeLocalPart(null), null);
});

test('邮箱归属：只有创建者能读，别人和陌生地址一律拒', (t) => {
  const store = freshStore(t);
  store.createMailbox({ address: 'TmpAaa@x.com', owner: 'owner-1', addressId: '77' });

  assert.equal(store.ownsMailbox('owner-1', 'tmpaaa@x.com'), true);
  assert.equal(store.ownsMailbox('owner-2', 'tmpaaa@x.com'), false, '别人的邮箱读不了');
  assert.equal(store.ownsMailbox('owner-1', 'someone-else@x.com'), false, '知道地址也读不了');
  assert.equal(store.ownsMailbox('', 'tmpaaa@x.com'), false, '空 owner 不能当万能钥匙');
});

test('邮箱有效期跟后台的 3 天保留期对齐', (t) => {
  const store = freshStore(t);
  const saved = store.createMailbox({ address: 'tmpttl@x.com', owner: 'o' });
  const days = (saved.expiresAt - Date.now()) / 86_400_000;
  assert.ok(days > 2.9 && days < 3.1, `应为 3 天，实际 ${days.toFixed(2)} 天`);
});

test('注销邮箱：本人能注销并拿到 addressId，别人不能', (t) => {
  const store = freshStore(t);
  store.createMailbox({ address: 'tmpdel@x.com', owner: 'owner-1', addressId: '55' });

  assert.equal(store.takeMailbox('owner-2', 'tmpdel@x.com'), null, '别人注销不了');
  assert.equal(store.ownsMailbox('owner-1', 'tmpdel@x.com'), true, '失败的注销不该动到记录');

  const taken = store.takeMailbox('owner-1', 'tmpdel@x.com');
  assert.equal(taken.addressId, '55', '要交出 addressId，否则后台删不掉');
  assert.equal(store.ownsMailbox('owner-1', 'tmpdel@x.com'), false, '注销后归属立即失效');
  assert.equal(store.takeMailbox('owner-1', 'tmpdel@x.com'), null, '重复注销要幂等地返回 null');
});

test('老库升级：mailboxes 缺 address_id 时能补列且不丢数据', (t) => {
  const dir = join(tmpdir(), `vend-mig-${randomUUID()}`);
  const path = join(dir, 'vend.sqlite');
  const store = new CardStore(path);
  store.createMailbox({ address: 'tmpold@x.com', owner: 'o', addressId: '1' });
  store.close();

  // 模拟老库：把列删掉再打开
  const reopened = new CardStore(path);
  t.after(() => {
    try { reopened.close(); } catch { /* 已关 */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });
  assert.equal(reopened.ownsMailbox('o', 'tmpold@x.com'), true, '升级后老数据要还在');
});
