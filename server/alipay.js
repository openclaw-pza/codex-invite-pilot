// alipay.js — 支付宝开放平台（RSA2 / 公钥模式）
//
// 只做两件事：① 生成付款链接 ② 验证异步通知的签名。
// 没引 alipay-sdk：官方 SDK 拉一大串传递依赖，而我们用到的就是
// 「排序拼串 → SHA256withRSA 签名 / 验签 → 拼一个 GET URL」这点东西，
// 自己写清楚比包一层更好排错，也少一块供应链面。
//
// ⚠ 这个文件里每一条校验都是防止「别人不花钱就把卡密余额充上去」的。
// 改动之前先想清楚少了这条会发生什么，测试里每条都有对应用例。

import crypto from 'node:crypto';

const GATEWAY = 'https://openapi.alipay.com/gateway.do';

// 支付宝后台给的密钥常常是没有 PEM 头尾的一长串 base64。
// 两种都收，统一补成 Node 认识的 PEM。
function toPem(key, label) {
  const raw = String(key || '').trim();
  if (!raw) return '';
  if (raw.includes('-----BEGIN')) return raw;
  const body = raw.replace(/\s+/g, '').replace(/\\n/g, '');
  const lines = body.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
}

// 待签名串：按参数名字典序排序，跳过空值和 sign 本身，用未编码的原值拼。
// **不能用 URL 编码后的值** —— 支付宝那边是拿解码后的原值算的，
// 编码了签出来的串对不上，表现是「验签一直失败但看不出哪错了」。
export function buildSignContent(params) {
  return Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'sign_type')
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

export function sign(params, privateKey) {
  const pem = toPem(privateKey, 'PRIVATE KEY');
  if (!pem) throw new Error('缺少支付宝应用私钥');
  return crypto.createSign('RSA-SHA256')
    .update(buildSignContent(params), 'utf8')
    .sign(pem, 'base64');
}

/**
 * 验证异步/同步通知的签名。
 *
 * 这是整条链路上**最重要**的一道闸：没有它，任何人往 notify 地址 POST 一段
 * 「我付了 999 元」就能把卡密余额充满。所以：
 *   · 验不过一律 false，不要"宽容处理"
 *   · 公钥没配也一律 false —— 绝不能出现「没配就等于不验」
 */
export function verifyNotify(params, alipayPublicKey) {
  const pem = toPem(alipayPublicKey, 'PUBLIC KEY');
  if (!pem) return false;
  const signature = params?.sign;
  if (!signature) return false;
  try {
    return crypto.createVerify('RSA-SHA256')
      .update(buildSignContent(params), 'utf8')
      .verify(pem, String(signature), 'base64');
  } catch {
    // 公钥格式不对、签名不是合法 base64 等等，一律当验签失败
    return false;
  }
}

// 支付宝要 'yyyy-MM-dd HH:mm:ss' 的北京时间。
// 服务器在洛杉矶，直接 toISOString 会差 15 小时，订单会被判过期。
export function beijingTimestamp(now = new Date()) {
  const bj = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${bj.getFullYear()}-${p(bj.getMonth() + 1)}-${p(bj.getDate())} `
    + `${p(bj.getHours())}:${p(bj.getMinutes())}:${p(bj.getSeconds())}`;
}

/**
 * 拼一个跳转付款的 URL（电脑网站支付 / 手机网站支付）。
 * 这两个产品的参数完全一样，只有 method 不同，所以共用一份代码。
 */
export function buildPayUrl({
  config, method = 'alipay.trade.page.pay',
  outTradeNo, totalAmount, subject, body = '', timeoutExpress = '30m', now,
}) {
  if (!config?.appId) throw new Error('缺少支付宝 APPID');
  const bizContent = {
    out_trade_no: String(outTradeNo),
    // 金额必须是两位小数的字符串。传 number 会出现 3.65 变成 "3.6500000000000004"，
    // 支付宝直接报参数错误。
    total_amount: Number(totalAmount).toFixed(2),
    subject: String(subject).slice(0, 256),
    product_code: method === 'alipay.trade.wap.pay' ? 'QUICK_WAP_WAY' : 'FAST_INSTANT_TRADE_PAY',
    // 超时后订单自动关闭。不设的话未付的订单会一直挂着，
    // 同一个 out_trade_no 再发起会撞「交易已存在」。
    timeout_express: timeoutExpress,
  };
  if (body) bizContent.body = String(body).slice(0, 128);

  const params = {
    app_id: config.appId,
    method,
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: beijingTimestamp(now),
    version: '1.0',
    notify_url: config.notifyUrl,
    return_url: config.returnUrl,
    biz_content: JSON.stringify(bizContent),
  };
  params.sign = sign(params, config.privateKey);

  const query = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
  return `${config.gateway || GATEWAY}?${query}`;
}

/**
 * 一笔通知能不能算数。**顺序即优先级**，每一条都对应一种真实的骗法/事故：
 *   1. 验签      —— 不验 = 任何人 POST 一下就能白拿余额
 *   2. app_id    —— 别人的应用的通知不能算我们的
 *   3. 交易状态  —— 只认 TRADE_SUCCESS / TRADE_FINISHED
 *   4. 金额      —— 必须**等于**我们自己算出来的应补金额。
 *                   只信通知里的金额，等于让买家付 ¥0.01 买 ¥100 的号
 * 返回 { ok, reason }，reason 只进服务端日志，不回给调用方。
 */
export function checkNotify({ params, config, expectAmountCny }) {
  if (!verifyNotify(params, config?.alipayPublicKey)) return { ok: false, reason: 'bad_sign' };
  if (String(params.app_id) !== String(config.appId)) return { ok: false, reason: 'app_id_mismatch' };
  const status = String(params.trade_status || '');
  if (status !== 'TRADE_SUCCESS' && status !== 'TRADE_FINISHED') {
    return { ok: false, reason: `status_${status || 'empty'}` };
  }
  const paid = Number(params.total_amount);
  const want = Number(expectAmountCny);
  if (!Number.isFinite(paid) || !Number.isFinite(want)) return { ok: false, reason: 'bad_amount' };
  // 用「分」比，不要浮点相等：3.65 的浮点表示比不出等号。
  // 多付了放行（买家自己多给的，不能因此卡住他）；少一分都不行。
  if (Math.round(paid * 100) < Math.round(want * 100)) return { ok: false, reason: 'amount_short' };
  return { ok: true, reason: null };
}

// 从环境变量读。配不齐就返回 null —— 调用方据此走"还没接支付宝"的人工核对流程，
// 而不是拿着半套配置去发起支付然后每次都失败。
export function alipayConfigFromEnv(env = process.env) {
  const appId = (env.ALIPAY_APP_ID || '').trim();
  const privateKey = (env.ALIPAY_APP_PRIVATE_KEY || '').trim();
  const alipayPublicKey = (env.ALIPAY_PUBLIC_KEY || '').trim();
  if (!appId || !privateKey || !alipayPublicKey) return null;
  return {
    appId,
    privateKey,
    alipayPublicKey,
    gateway: (env.ALIPAY_GATEWAY || GATEWAY).trim(),
    notifyUrl: (env.ALIPAY_NOTIFY_URL || '').trim(),
    returnUrl: (env.ALIPAY_RETURN_URL || '').trim(),
  };
}
