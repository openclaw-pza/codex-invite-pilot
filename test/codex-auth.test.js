import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCodexAccountHealth,
  parseCodexDeviceCodeStart,
  parseCodexOAuthStart,
} from '../server/codexDeviceAuth.js';

test('Codex 普通 ChatGPT OAuth 采用动态 authUrl', () => {
  assert.deepEqual(parseCodexOAuthStart({
    type: 'chatgpt',
    loginId: 'login-test',
    authUrl: 'https://auth.openai.com/oauth/authorize?test=1',
  }), {
    loginId: 'login-test',
    authUrl: 'https://auth.openai.com/oauth/authorize?test=1',
  });
});

test('Codex 设备码结果不会被误当成普通 OAuth', () => {
  assert.throws(() => parseCodexOAuthStart({
    type: 'chatgptDeviceCode',
    loginId: 'login-test',
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: 'ABCD-EFGH',
  }), /OAuth/);
});

test('Codex 设备码登录解析 verificationUrl 和 userCode', () => {
  assert.deepEqual(parseCodexDeviceCodeStart({
    type: 'chatgptDeviceCode',
    loginId: 'login-device',
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: 'B6MI-SJJGC',
  }), {
    loginId: 'login-device',
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: 'B6MI-SJJGC',
  });
});

test('普通 OAuth 结果不会被误当成设备码', () => {
  assert.throws(() => parseCodexDeviceCodeStart({
    type: 'chatgpt',
    loginId: 'login-test',
    authUrl: 'https://auth.openai.com/oauth/authorize?test=1',
  }), /设备码/);
});

test('账号健康检查：本地有凭据但 token 已作废 → 不健康', () => {
  const health = parseCodexAccountHealth({
    account: { type: 'chatgpt', email: 'user@example.com', planType: 'free' },
    rateLimitsError: 'Your authentication token has been invalidated (token_invalidated)',
  });
  assert.equal(health.localHasAccount, true);
  assert.equal(health.tokenInvalidated, true);
  assert.equal(health.serverOk, false);
  assert.equal(health.healthy, false);
});

test('账号健康检查：account/read + rateLimits/read 都成功才算健康', () => {
  const health = parseCodexAccountHealth({
    account: { type: 'chatgpt', email: 'user@example.com', planType: 'plus' },
    rateLimits: { usedPercent: 1 },
  });
  assert.equal(health.healthy, true);
  assert.equal(health.email, 'user@example.com');
  assert.equal(health.planType, 'plus');
});

test('账号健康检查：本地没有 ChatGPT 账号 → 不健康', () => {
  const health = parseCodexAccountHealth({
    account: { type: 'apiKey' },
  });
  assert.equal(health.localHasAccount, false);
  assert.equal(health.healthy, false);
});
