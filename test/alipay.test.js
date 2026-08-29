// alipay.test.js — 支付宝签名与通知校验
//
// 这条链路上任何一道闸漏了，结果都是**别人不花钱就能把卡密余额充上去**。
// 所以每一条校验都得有一个"少了它会怎样"的对应用例，而且要跑双向：
// 该放行的放行、该拦的拦住。只测"正常付款能过"是没用的 —— 骗子不走正常路径。

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  buildSignContent, sign, verifyNotify, checkNotify, buildPayUrl, beijingTimestamp,
} from '../server/alipay.js';

// 测试用密钥对，跟生产的那对无关
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
// 另一对，用来冒充
const other = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const CONFIG = {
  appId: '2021006189675812',
  privateKey,
  alipayPublicKey: publicKey,
  gateway: 'https://openapi.alipay.com/gateway.do',
  notifyUrl: 'https://sms.tempmail2026.xyz/api/vend/alipay/notify',
  returnUrl: 'https://sms.tempmail2026.xyz/',
};

function signedNotify(over = {}) {
  const params = {
    app_id: CONFIG.appId,
    trade_status: 'TRADE_SUCCESS',
    out_trade_no: 'TOPUP-7',
    trade_no: '2026082222001489121000000001',
    total_amount: '3.65',
    gmt_payment: '2026-08-22 10:30:00',
    ...over,
  };
  params.sign_type = 'RSA2';
  params.sign = sign(params, privateKey);
  return params;
}

test('待签名串：排序、跳过空值、跳过 sign 本身', () => {
  const content = buildSignContent({
    b: '2', a: '1', sign: 'XXX', sign_type: 'RSA2', empty: '', nul: null, c: '3',
  });
  assert.equal(content, 'a=1&b=2&c=3');
});

test('待签名串用原值，不能是 URL 编码后的', () => {
  // 编码了签出来的串跟支付宝那边对不上，表现是「验签一直失败但看不出哪错」
  const content = buildSignContent({ biz_content: '{"a":"中文 空格"}' });
  assert.equal(content, 'biz_content={"a":"中文 空格"}');
});

test('自己签的自己能验过', () => {
  assert.equal(verifyNotify(signedNotify(), publicKey), true);
});

test('改一个字段签名就该失败', () => {
  const p = signedNotify();
  p.total_amount = '999.00';       // 最经典的篡改：把金额改大
  assert.equal(verifyNotify(p, publicKey), false);
});

test('别人的私钥签的一律不认', () => {
  const p = { app_id: CONFIG.appId, trade_status: 'TRADE_SUCCESS', total_amount: '3.65' };
  p.sign = sign(p, other.privateKey);
  assert.equal(verifyNotify(p, publicKey), false);
});

test('公钥没配 = 一律不认，绝不能"没配就等于不验"', () => {
  const p = signedNotify();
  for (const bad of ['', null, undefined, '   ']) {
    assert.equal(verifyNotify(p, bad), false, `公钥是 ${JSON.stringify(bad)} 时必须拒绝`);
  }
});

test('没有 sign 字段直接拒', () => {
  const p = signedNotify();
  delete p.sign;
  assert.equal(verifyNotify(p, publicKey), false);
});

test('checkNotify：正常付款放行', () => {
  const r = checkNotify({ params: signedNotify(), config: CONFIG, expectAmountCny: 3.65 });
  assert.deepEqual(r, { ok: true, reason: null });
});

test('checkNotify：金额少一分都不放行', () => {
  // 少了这条，买家付 ¥0.01 就能买 ¥100 的号
  const p = signedNotify({ total_amount: '3.64' });
  assert.deepEqual(checkNotify({ params: p, config: CONFIG, expectAmountCny: 3.65 }),
    { ok: false, reason: 'amount_short' });
});

test('checkNotify：多付了要放行，不能把人卡住', () => {
  const p = signedNotify({ total_amount: '4.00' });
  assert.equal(checkNotify({ params: p, config: CONFIG, expectAmountCny: 3.65 }).ok, true);
});

test('checkNotify：金额用分比，不能栽在浮点上', () => {
  // 0.1+0.2 那类问题：3.65 的浮点表示比不出等号
  const p = signedNotify({ total_amount: '3.65' });
  assert.equal(checkNotify({ params: p, config: CONFIG, expectAmountCny: 0.35 + 3.30 }).ok, true);
});

test('checkNotify：别人应用的通知不算我们的', () => {
  const p = signedNotify({ app_id: '2099999999999999' });
  assert.equal(checkNotify({ params: p, config: CONFIG, expectAmountCny: 3.65 }).reason, 'app_id_mismatch');
});

test('checkNotify：只认成功状态', () => {
  for (const st of ['WAIT_BUYER_PAY', 'TRADE_CLOSED', '']) {
    const p = signedNotify({ trade_status: st });
    assert.equal(checkNotify({ params: p, config: CONFIG, expectAmountCny: 3.65 }).ok, false, st);
  }
  for (const st of ['TRADE_SUCCESS', 'TRADE_FINISHED']) {
    const p = signedNotify({ trade_status: st });
    assert.equal(checkNotify({ params: p, config: CONFIG, expectAmountCny: 3.65 }).ok, true, st);
  }
});

test('checkNotify：验签在最前面 —— 状态和金额都对但签名假的照样拒', () => {
  const p = signedNotify();
  p.sign = sign({ ...p, out_trade_no: 'OTHER' }, privateKey);   // 对不上的签名
  assert.equal(checkNotify({ params: p, config: CONFIG, expectAmountCny: 3.65 }).reason, 'bad_sign');
});

test('付款链接：金额两位小数，不能是浮点原样', () => {
  const url = buildPayUrl({
    config: CONFIG, outTradeNo: 'TOPUP-7', totalAmount: 3.6500000000000004, subject: '补差价',
  });
  const biz = JSON.parse(decodeURIComponent(new URL(url).searchParams.get('biz_content')));
  assert.equal(biz.total_amount, '3.65');
});

test('付款链接：签名能被公钥验过（说明拼串和签名一致）', () => {
  const url = buildPayUrl({ config: CONFIG, outTradeNo: 'T-1', totalAmount: 1, subject: '补差价' });
  const params = Object.fromEntries(new URL(url).searchParams.entries());
  assert.equal(verifyNotify(params, publicKey), true);
  assert.equal(params.app_id, CONFIG.appId);
  assert.equal(params.notify_url, CONFIG.notifyUrl);
});

test('时间戳用北京时间，不能拿服务器本地时间', () => {
  // 服务器在洛杉矶，直接用本地时间会差十几小时，订单当场被判过期
  const t = beijingTimestamp(new Date('2026-08-22T02:30:00Z'));
  assert.equal(t, '2026-08-22 10:30:00');
});
