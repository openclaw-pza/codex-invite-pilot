import test from 'node:test';
import assert from 'node:assert/strict';
import { VERDICTS, classifyAccountError, summarizeLiveness } from '../server/codexLiveness.js';
import { parseCodexAccountHealth } from '../server/codexDeviceAuth.js';

test('错误码优先于文案：token_invalidated 认得出来', () => {
  assert.equal(
    classifyAccountError({ code: 'token_invalidated', message: 'HTTP 401' }),
    VERDICTS.TOKEN_INVALIDATED,
  );
});

test('账号被停用与 token 失效是两件事，不能混成一个结论', () => {
  assert.equal(classifyAccountError({ message: 'account_deactivated' }), VERDICTS.DEACTIVATED);
  assert.notEqual(classifyAccountError({ message: 'account_deactivated' }), VERDICTS.TOKEN_INVALIDATED);
});

// 项目硬规则「整批查不到 = 故障，不得当作没有数据」在这里的对应物。
test('超时/连接失败判为「没查成」，绝不判成账号出事', () => {
  for (const message of ['Codex app-server 请求超时：account/rateLimits/read', 'ECONNRESET', 'socket hang up', 'HTTP 503']) {
    assert.equal(classifyAccountError({ message }), VERDICTS.TRANSIENT, message);
  }
});

test('认不出来的错误落到 unknown，不冒充结论', () => {
  assert.equal(classifyAccountError({ message: '某个从没见过的报错' }), VERDICTS.UNKNOWN);
});

test('健康检查产出机器可读的 verdict，且与分类器同源', () => {
  const dead = parseCodexAccountHealth({
    account: { type: 'chatgpt', email: 'a@b.com', planType: 'free' },
    rateLimitsError: 'HTTP 401',
    rateLimitsErrorCode: 'token_invalidated',
  });
  assert.equal(dead.verdict, VERDICTS.TOKEN_INVALIDATED);
  assert.equal(dead.healthy, false);

  const flaky = parseCodexAccountHealth({
    account: { type: 'chatgpt', email: 'a@b.com' },
    rateLimitsError: 'Codex app-server 请求超时：account/rateLimits/read',
  });
  assert.equal(flaky.verdict, VERDICTS.TRANSIENT);
  assert.match(flaky.message, /没查成/);
});

test('存活窗口给区间不给点值：只知道最后活着和第一次拿到死讯之间', () => {
  const summary = summarizeLiveness([
    { at: '2026-08-25T12:30:00Z', verdict: VERDICTS.HEALTHY },
    { at: '2026-08-25T12:50:00Z', verdict: VERDICTS.HEALTHY },
    { at: '2026-08-25T13:10:00Z', verdict: VERDICTS.TOKEN_INVALIDATED },
    { at: '2026-08-25T13:20:00Z', verdict: VERDICTS.TOKEN_INVALIDATED },
  ], { bornAt: '2026-08-25T12:25:00Z' });
  assert.equal(summary.confirmedDead, true);
  assert.equal(summary.survivedAtLeastMs, 25 * 60 * 1000);
  assert.equal(summary.survivedAtMostMs, 45 * 60 * 1000);
});

test('单次抖动不判死：要连续两次死亡证据', () => {
  const summary = summarizeLiveness([
    { at: '2026-08-25T12:30:00Z', verdict: VERDICTS.HEALTHY },
    { at: '2026-08-25T12:40:00Z', verdict: VERDICTS.TOKEN_INVALIDATED },
    { at: '2026-08-25T12:50:00Z', verdict: VERDICTS.HEALTHY },
  ], { bornAt: '2026-08-25T12:25:00Z' });
  assert.equal(summary.confirmedDead, false);
  // 账号又活过来了，之前那次死亡证据必须作废，否则上界会被钉死在一次误报上
  assert.equal(summary.firstDeadAt, '');
  assert.equal(summary.survivedAtMostMs, null);
});

test('「没查成」既不推进死亡也不打断存活', () => {
  const summary = summarizeLiveness([
    { at: '2026-08-25T12:30:00Z', verdict: VERDICTS.HEALTHY },
    { at: '2026-08-25T12:40:00Z', verdict: VERDICTS.TRANSIENT },
    { at: '2026-08-25T12:50:00Z', verdict: VERDICTS.TRANSIENT },
  ], { bornAt: '2026-08-25T12:25:00Z' });
  assert.equal(summary.confirmedDead, false);
  assert.equal(summary.lastHealthyAt, '2026-08-25T12:30:00Z');
});
