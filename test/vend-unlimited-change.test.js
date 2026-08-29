// vend-unlimited-change.test.js — 不限次数换号 + 短信原文的回归测试
//
// 背景：maxChanges 原来写死 5，是我自己加的本地防呆（上游没有次数限制）。
// 安哥要求改成「号码有效期内不限次数」。maxChanges: null = 不限。
//
// 两条不能丢的不变量：
//   1. 不限次数不等于没有兜底 —— 仍留一个很宽的硬上限，防脚本刷号把上游账号刷出风控
//   2. 短信原文必须落库，且**拿不到原文时不能编一句假的**

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';

import { CardStore } from '../server/cards.js';

function freshStore(t) {
  const dir = join(tmpdir(), `vend-unl-${randomUUID()}`);
  const store = new CardStore(join(dir, 'vend.sqlite'));
  t.after(() => {
    try { store.close(); } catch { /* 已关 */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });
  return store;
}

function order(store, code, activationId) {
  const r = store.reserve({ code, country: 4, service: 'dr' });
  store.fulfill(r.reservationId, { activationId, phone: `100${activationId}`, priceUsd: 0.03, priceCny: 0.3 });
  return r;
}

test('一张卡可以连续换很多次号，次数上不封顶', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'unlimited-1' });

  // 连开 20 轮：取号 → 退掉 → 再取。以前第 6 轮就会被本地闸挡住。
  for (let i = 0; i < 20; i += 1) {
    order(store, card.code, `A${i}`);
    store.cancel(`A${i}`, 'cancelled', { state: 'refunded', raw: 'ACCESS_CANCEL' });
  }
  assert.equal(store.countOrders(card.code), 20, '20 轮都该记下来');
  assert.equal(store.getCard(card.code).status, 'issued', '一直没收到码，卡密不该被消耗');

  // 第 21 轮仍然开得出来
  const again = store.reserve({ code: card.code, country: 4, service: 'dr' });
  assert.ok(again.ok, '不限次数就是不限次数');
});

test('收到验证码后卡密消耗，换号到此为止', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'unlimited-2' });
  order(store, card.code, 'B1');
  store.consume('B1', '472913', 'Your OpenAI code is 472913');

  assert.equal(store.getCard(card.code).status, 'used');
  const blocked = store.reserve({ code: card.code, country: 4, service: 'dr' });
  assert.equal(blocked.ok, false, '收码后不能再取号');
  assert.equal(blocked.reason, 'used');
});

test('短信原文落库并能读出来', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'sms-1' });
  order(store, card.code, 'C1');
  const text = 'Your OpenAI verification code is 472913. Don\'t share this code with anyone.';
  store.consume('C1', '472913', text);

  const row = store.listActivations(card.code).slice(-1)[0];
  assert.equal(row.sms_code, '472913');
  assert.equal(row.sms_text, text, '原文必须原样留着，客服要靠它核');
});

test('没有原文就存 null，绝不拿验证码拼一句假原文', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'sms-2' });
  order(store, card.code, 'C2');
  store.consume('C2', '123456'); // 不传原文

  const row = store.listActivations(card.code).slice(-1)[0];
  assert.equal(row.sms_text, null, '拿不到原文就是 null，前端据此整块不显示');
});

test('并发补记那条路径也要留住原文', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'sms-3' });
  order(store, card.code, 'C3');
  // 模拟并发：先被换号标成 cancelled，码才到
  store.cancel('C3', 'cancelled', { state: 'refunded', raw: 'ACCESS_CANCEL' });
  store.forceConsume('C3', '998877', 'Discord code: 998877');

  const row = store.listActivations(card.code).slice(-1)[0];
  assert.equal(row.state, 'code', '码到了就得认账');
  assert.equal(row.sms_text, 'Discord code: 998877');
});

test('原文过长要截断，别让一条垃圾短信撑爆这一行', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'sms-4' });
  order(store, card.code, 'C4');
  store.consume('C4', '111111', 'x'.repeat(5000));

  const row = store.listActivations(card.code).slice(-1)[0];
  assert.ok(row.sms_text.length <= 500, `应截断到 500 以内，实际 ${row.sms_text.length}`);
});

test('老库升级：activations 缺 sms_text 时能补列且不丢数据', (t) => {
  const dir = join(tmpdir(), `vend-smsmig-${randomUUID()}`);
  const path = join(dir, 'vend.sqlite');
  const store = new CardStore(path);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'mig-1' });
  order(store, card.code, 'D1');
  store.close();

  const reopened = new CardStore(path);
  t.after(() => {
    try { reopened.close(); } catch { /* 已关 */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });
  const row = reopened.listActivations(card.code).slice(-1)[0];
  assert.equal(row.activation_id, 'D1', '老数据要还在');
  assert.equal(row.sms_text ?? null, null, '新列默认空');
});
