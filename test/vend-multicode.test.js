// vend-multicode.test.js — 一张卡收多次码（共用钱包）
//
// 安哥 2026-08-22 定的口径：面额是这几次**共用**的钱包，不是每次都能花满。
// 这个区别直接决定亏不亏钱：
//   ¥3.99 的卡每次都能花 ¥3.99 → 三次成本 ¥8.6，卖 ¥3.99，一单亏 ¥4.6。
//
// 三条不变量：
//   1. 收满次数才作废，没满不能提前作废（吞了买家买到的次数）
//   2. 花掉的钱要从余额扣，**换号退回的不算花掉**
//   3. 默认 max_codes=1，老卡行为一个字都不能变

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';

import { CardStore } from '../server/cards.js';
import { checkRegionAllowed } from '../server/pricing.js';

function freshStore(t) {
  const dir = join(tmpdir(), `vend-mc-${randomUUID()}`);
  const store = new CardStore(join(dir, 'vend.sqlite'));
  t.after(() => {
    try { store.close(); } catch { /* 已关 */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });
  return store;
}

// 走一遍「取号 → 收码」，priceCny 是这个号的成本
function takeAndConsume(store, code, id, priceCny, country = 52) {
  const r = store.reserve({ code, country, service: 'dr' });
  store.fulfill(r.reservationId, { activationId: id, phone: `66${id}`, priceUsd: priceCny / 10, priceCny });
  return store.consume(id, '123456');
}

test('默认还是一次性卡，老行为一个字不变', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'MC-1' });
  assert.equal(card.max_codes, 1);

  takeAndConsume(store, card.code, 'A1', 1.1);
  assert.equal(store.getCard(card.code).status, 'used', '一次性卡收到第一条码就作废');
});

test('三次卡收前两次不作废，第三次才作废', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 3.99, orderId: 'MC-2', maxCodes: 3 });

  takeAndConsume(store, card.code, 'B1', 1.1);
  assert.equal(store.getCard(card.code).status, 'issued', '第 1 次之后卡还得活着');
  assert.equal(store.codesUsed(card.code), 1);

  takeAndConsume(store, card.code, 'B2', 1.1);
  assert.equal(store.getCard(card.code).status, 'issued', '第 2 次之后卡还得活着');

  takeAndConsume(store, card.code, 'B3', 1.1);
  assert.equal(store.getCard(card.code).status, 'used', '收满 3 次才作废');
  assert.equal(store.codesUsed(card.code), 3);
});

test('共用钱包：花掉的要从余额扣，不能每次都花满面额', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 3.99, orderId: 'MC-3', maxCodes: 3 });

  takeAndConsume(store, card.code, 'C1', 1.10);
  takeAndConsume(store, card.code, 'C2', 1.65);
  assert.equal(store.spentCny(card.code), 2.75);

  // 余额 3.99 − 2.75 = 1.24。第三次只买得起 ¥1.24 以内的地区
  const budget = { denomCny: 3.99, rate: 10, spentCny: store.spentCny(card.code) };
  const cheap = checkRegionAllowed({ region: { minPrice: 0.11 }, ...budget });
  assert.equal(cheap.allowed, true, '¥1.10 的地区还买得起');
  assert.equal(cheap.budgetCny, 1.24);

  const pricey = checkRegionAllowed({ region: { minPrice: 0.165 }, ...budget });
  assert.equal(pricey.allowed, false, '¥1.65 的地区已经买不起了');
  assert.equal(pricey.reason, 'need_topup');
  // 这一条是防亏钱的核心：不扣已花的话这里会放行，三次共花 ¥4.4 > 面额 ¥3.99
  assert.equal(pricey.topupCny, 0.41);
});

test('换号退回的钱不算花掉', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 3.99, orderId: 'MC-4', maxCodes: 3 });

  // 取了三个号都没收到码，全退了
  for (const id of ['D1', 'D2', 'D3']) {
    const r = store.reserve({ code: card.code, country: 52, service: 'dr' });
    store.fulfill(r.reservationId, { activationId: id, phone: '661', priceUsd: 0.11, priceCny: 1.1 });
    store.cancel(id, 'cancelled', { state: 'refunded', raw: 'ACCESS_CANCEL' });
  }
  assert.equal(store.spentCny(card.code), 0, '退掉的号一分钱都不该算花掉');
  assert.equal(store.codesUsed(card.code), 0, '退掉的号也不该占次数');
  assert.equal(store.getCard(card.code).status, 'issued');
});

test('钱花光了但次数还剩：卡活着，但什么都买不动', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 2.5, orderId: 'MC-5', maxCodes: 3 });

  takeAndConsume(store, card.code, 'E1', 2.4);
  assert.equal(store.getCard(card.code).status, 'issued', '次数没用完，卡不该死');

  // 余额只剩 ¥0.10，最便宜的档都买不起 —— 前端要靠 balanceCny 把这件事说清楚，
  // 只报「还剩 2 次」会让买家一直点一直被拒
  const gate = checkRegionAllowed({
    region: { minPrice: 0.011 }, denomCny: 2.5, rate: 10, spentCny: store.spentCny(card.code),
  });
  assert.equal(gate.budgetCny, 0.1);
  assert.equal(gate.allowed, false);
});

test('多次卡的补款要留到最后一次，不能第一次收码就划掉', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'MC-6', maxCodes: 2 });
  const claim = store.claimTopup({ code: card.code, country: 187, needCny: 4 });
  store.confirmTopup(claim.id);

  takeAndConsume(store, card.code, 'F1', 1.1);
  assert.equal(store.isTopupConfirmed(card.code), true, '第 1 次收码后补款还得在');
  assert.equal(store.confirmedTopupCny(card.code), 4);

  takeAndConsume(store, card.code, 'F2', 1.1);
  assert.equal(store.isTopupConfirmed(card.code), false, '收满次数后补款才作废');
  assert.equal(store.getCard(card.code).status, 'used');
});

test('forceConsume 走的是同一套结算，不能绕过次数', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 3.99, orderId: 'MC-7', maxCodes: 2 });

  // 并发下换号把 activation 标成 cancelled，但码到了 —— 必须认账
  const r = store.reserve({ code: card.code, country: 52, service: 'dr' });
  store.fulfill(r.reservationId, { activationId: 'G1', phone: '661', priceUsd: 0.11, priceCny: 1.1 });
  store.cancel('G1', 'cancelled');
  store.forceConsume('G1', '654321');

  assert.equal(store.codesUsed(card.code), 1);
  assert.equal(store.getCard(card.code).status, 'issued', '两次卡的第一次不该把卡作废');
});
