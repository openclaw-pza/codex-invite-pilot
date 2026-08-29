import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTokenError, verifyGraphToken, DEFAULT_SCOPE } from '../server/outlookToken.js';

// 分错的代价不对称：
//   把瞬时故障判成死号 → 白扔一个不可再生的账号
//   把死号判成瞬时     → 只是多等一轮
// 所以判据必须偏保守。这组测试就是钉住这个偏向。

test('限流和 5xx 一律算瞬时，绝不能判死号', () => {
  for (const s of [429, 500, 502, 503, 504, 0]) {
    assert.equal(classifyTokenError(s, { error: 'invalid_grant' }), 'transient',
      `HTTP ${s} 被判成了死号`);
  }
});

test('微软明确说凭据不可用才算死号', () => {
  for (const e of ['invalid_grant', 'invalid_client', 'unauthorized_client', 'interaction_required', 'consent_required']) {
    assert.equal(classifyTokenError(400, { error: e }), 'dead', `${e} 没判成死号`);
  }
});

test('没见过的错误码按瞬时处理（宁可多等一轮，也别扔号）', () => {
  for (const e of ['temporarily_unavailable', 'server_error', 'weird_new_code', '', undefined]) {
    assert.equal(classifyTokenError(400, { error: e }), 'transient', `${e} 被判成了死号`);
  }
});

test('没有令牌直接判死，不去打网络', () => {
  return verifyGraphToken({}).then((r) => {
    assert.equal(r.verdict, 'dead');
    assert.match(r.detail, /没有 refresh_token/);
  });
});

// scope 写错是这条链路上最容易犯又最难看出的错：
// 写死 Mail.Read 会被拒（AADSTS70000），而报错长得像"令牌坏了"。
test('scope 固定用 .default', () => {
  assert.equal(DEFAULT_SCOPE, 'https://graph.microsoft.com/.default');
});

// 🔴 判据必须落在**产物**上：只拿到 access_token 不算数。
// scope 不含读信权限的号换令牌是成功的、读信 403，跑起来一样废。
test('换到令牌但读信失败，要判失败而不是成功', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes('/token')
    ? { status: 200, ok: true, json: async () => ({ access_token: 'a', scope: 'openid' }) }
    : { status: 403, ok: false, json: async () => ({ error: { code: 'ErrorAccessDenied' } }) });
  try {
    const r = await verifyGraphToken({ refreshToken: 'x'.repeat(100) });
    assert.equal(r.ok, false);
    assert.equal(r.verdict, 'dead');
    assert.match(r.detail, /读信 HTTP 403/);
  } finally { globalThis.fetch = real; }
});

test('读信 5xx 算瞬时，不判死号', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes('/token')
    ? { status: 200, ok: true, json: async () => ({ access_token: 'a' }) }
    : { status: 503, ok: false, json: async () => ({}) });
  try {
    const r = await verifyGraphToken({ refreshToken: 'x'.repeat(100) });
    assert.equal(r.verdict, 'transient');
  } finally { globalThis.fetch = real; }
});

test('全程顺利时报 ok 并带回实际 scope', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes('/token')
    ? { status: 200, ok: true, json: async () => ({ access_token: 'a', scope: 'Mail.ReadWrite Mail.Send' }) }
    : { status: 200, ok: true, json: async () => ({ value: [{ id: '1' }] }) });
  try {
    const r = await verifyGraphToken({ refreshToken: 'x'.repeat(100) });
    assert.equal(r.ok, true);
    assert.equal(r.verdict, 'ok');
    assert.equal(r.mailCount, 1);
    assert.match(r.scope, /Mail\.ReadWrite/);
  } finally { globalThis.fetch = real; }
});
