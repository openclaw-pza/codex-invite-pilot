// alipay-notify.test.js — 支付宝异步通知走 HTTP 那一层
//
// alipay.test.js 测的是纯函数。这里测的是**真的起一个服务、真的 POST 一次表单**，
// 因为出事的地方往往在函数之外：
//   · 表单 body 没解析（支付宝发的是 x-www-form-urlencoded，不是 JSON）
//   · 回了 JSON 而不是纯文本 success（支付宝会当失败，重推 25 小时）
//   · 幂等只在 store 层做了，路由层没走到
// 这个入口是全站唯一「陌生人 POST 一下就能改余额」的地方，所以要按被攻击来测。

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';

import { CardStore } from '../server/cards.js';
import { sign } from '../server/alipay.js';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const APP_ID = '2021006189675812';

// 环境变量要在 import server 之前设好：alipayConfigFromEnv 是每次调用现读的，
// 但保险起见还是先设。
process.env.ALIPAY_APP_ID = APP_ID;
process.env.ALIPAY_APP_PRIVATE_KEY = privateKey;
process.env.ALIPAY_PUBLIC_KEY = publicKey;
process.env.ALIPAY_NOTIFY_URL = 'https://example.test/api/vend/alipay/notify';

const { startVendServer } = await import('../server/vend-server.js');

async function boot(t) {
  const dir = join(tmpdir(), `vend-ali-${randomUUID()}`);
  const dbPath = join(dir, 'vend.sqlite');
  const app = await startVendServer({ dbPath, port: 0, host: '127.0.0.1', skipVendorSync: true });
  const store = new CardStore(dbPath);
  t.after(async () => {
    try { store.close(); } catch { /* 已关 */ }
    await app.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });
  return { app, store, port: app.port ?? app.address?.().port };
}

function notifyBody(over = {}) {
  const params = {
    app_id: APP_ID,
    trade_status: 'TRADE_SUCCESS',
    trade_no: '2026082222001489121000000001',
    total_amount: '4.15',
    gmt_payment: '2026-08-22 10:30:00',
    ...over,
  };
  params.sign_type = 'RSA2';
  params.sign = sign(params, privateKey);
  return new URLSearchParams(params).toString();
}

async function postNotify(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/vend/alipay/notify`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  return { status: res.status, type: res.headers.get('content-type'), text: await res.text() };
}

function pendingTopup(store) {
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'ALI-' + randomUUID() });
  const topup = store.claimTopup({ code: card.code, country: 187, needCny: 4.15 });
  return { card, topup };
}

test('正常到账：回纯文本 success，补款转 confirmed，余额加上去', async (t) => {
  const { store, port } = await boot(t);
  const { card, topup } = pendingTopup(store);
  assert.equal(store.confirmedTopupCny(card.code), null, '付款前余额里不该有补款');

  const r = await postNotify(port, notifyBody({ out_trade_no: `V${topup.id}T abc`.replace(' ', '') }));
  assert.equal(r.text, 'success', '必须是这七个字符，回 JSON 支付宝会一直重推');
  assert.match(r.type, /text\/plain/);

  const after = store.getTopup(topup.id);
  assert.equal(after.status, 'confirmed');
  assert.equal(after.trade_no, '2026082222001489121000000001', '成交号要落库，不然跟支付宝账单对不上');
  assert.equal(store.confirmedTopupCny(card.code), 4.15);
});

test('幂等：支付宝重推 25 小时，同一笔钱只能记一次', async (t) => {
  const { store, port } = await boot(t);
  const { card, topup } = pendingTopup(store);
  const body = notifyBody({ out_trade_no: `V${topup.id}Tx` });

  for (let i = 0; i < 5; i += 1) {
    const r = await postNotify(port, body);
    // 重复的也要回 success —— 回 fail 支付宝会更频繁地推
    assert.equal(r.text, 'success', `第 ${i + 1} 次重推`);
  }
  assert.equal(store.confirmedTopupCny(card.code), 4.15, '五次重推之后余额还是一笔的钱');
});

test('金额被改大 → 验签失败 → 一分钱不进余额', async (t) => {
  const { store, port } = await boot(t);
  const { card, topup } = pendingTopup(store);
  const params = new URLSearchParams(notifyBody({ out_trade_no: `V${topup.id}Ty` }));
  params.set('total_amount', '999.00');       // 签名是按 4.15 算的，改完就对不上

  const r = await postNotify(port, params.toString());
  assert.equal(r.text, 'fail');
  assert.equal(store.getTopup(topup.id).status, 'claimed', '状态不能动');
  assert.equal(store.confirmedTopupCny(card.code), null, '余额一分钱都不能加');
});

test('少付：签名是真的，但金额不够 —— 照样拒', async (t) => {
  const { store, port } = await boot(t);
  const { card, topup } = pendingTopup(store);
  // 这是最要命的一种：签名合法（真的付了钱），只是付了 ¥0.01
  const r = await postNotify(port, notifyBody({ out_trade_no: `V${topup.id}Tz`, total_amount: '0.01' }));
  assert.equal(r.text, 'fail');
  assert.equal(store.confirmedTopupCny(card.code), null);
});

test('伪造：没有签名、或用别人的私钥签的，一律拒', async (t) => {
  const { store, port } = await boot(t);
  const { card, topup } = pendingTopup(store);
  const other = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  const bare = new URLSearchParams({
    app_id: APP_ID, trade_status: 'TRADE_SUCCESS', total_amount: '4.15',
    out_trade_no: `V${topup.id}Tn`, trade_no: 'X',
  });
  assert.equal((await postNotify(port, bare.toString())).text, 'fail', '没签名');

  const forged = { ...Object.fromEntries(bare.entries()), sign_type: 'RSA2' };
  forged.sign = sign(forged, other.privateKey);
  assert.equal((await postNotify(port, new URLSearchParams(forged).toString())).text, 'fail', '别人的私钥');

  assert.equal(store.confirmedTopupCny(card.code), null);
});

test('未付款状态的通知不能算到账', async (t) => {
  const { store, port } = await boot(t);
  const { card, topup } = pendingTopup(store);
  const r = await postNotify(port, notifyBody({
    out_trade_no: `V${topup.id}Tw`, trade_status: 'WAIT_BUYER_PAY',
  }));
  assert.equal(r.text, 'fail');
  assert.equal(store.confirmedTopupCny(card.code), null);
});

test('订单号对不上任何补款单 → fail，不能静默当成功', async (t) => {
  const { port } = await boot(t);
  for (const bad of ['V999999Tq', '乱七八糟', '']) {
    const r = await postNotify(port, notifyBody({ out_trade_no: bad }));
    assert.equal(r.text, 'fail', `订单号 ${bad}`);
  }
});
