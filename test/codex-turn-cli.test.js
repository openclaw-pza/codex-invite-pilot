import test from 'node:test';
import assert from 'node:assert/strict';
import { assertIsolatedCodexHome, parseExecOutcome } from '../server/codexTurnCli.js';
import { VERDICTS } from '../server/codexLiveness.js';

// 这道闸拦的是最贵的一种错：不设隔离就跑 codex exec，
// 消息会发到 VPS 上安哥自己那个已登录的 Codex 账号上 ——
// 奖励一分不入账，还污染主账号，而且全程不报错。
test('拒绝在默认账号目录上发消息', () => {
  assert.throws(() => assertIsolatedCodexHome(''), /必须显式指定/);
  assert.throws(() => assertIsolatedCodexHome('/root/.codex'), /拒绝使用默认/);
  assert.throws(() => assertIsolatedCodexHome('/root/.codex/'), /拒绝使用默认/);
  assert.equal(assertIsolatedCodexHome('/opt/w/data/codex-auth/profiles/ab12'), '/opt/w/data/codex-auth/profiles/ab12');
});

// 实测（2026-08-25 DMIT-2）：没有登录态时 codex exec 不说「not logged in」，
// 而是对 wss://api.openai.com/v1/responses 报 401 并重连 5 次，退出码 101。
test('未登录的真实表现（401 + 重连）要认出来，不能落进兜底', () => {
  const outcome = parseExecOutcome({
    code: 101,
    stdout: 'OpenAI Codex v0.149.1\n--------\nworkdir: /tmp\n--------\nuser\nhi\n',
    stderr: '2026-08-25T09:28:35Z ERROR codex_api::endpoint::responses_websocket: failed to connect: HTTP error: 401 Unauthorized, url: wss://api.openai.com/v1/responses',
    prompt: 'hi',
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.verdict, VERDICTS.NO_ACCOUNT);
});

test('模型真回了话才算成功，且回复要能摘出来', () => {
  const outcome = parseExecOutcome({
    code: 0,
    stdout: 'OpenAI Codex v0.149.1\n--------\nmodel: gpt-5.6-sol\nsession id: x\n--------\nuser\nhi\ncodex\nHello there!\ntokens used: 90\n',
    prompt: 'hi',
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.reply, 'Hello there!');
});

// 退出码 0 不等于事情办成。这一步是唯一决定给不给额度的动作，判宽了
// 就会对一个根本没入账的号报成功。
test('退出码 0 但一个字没回 → 判失败', () => {
  const outcome = parseExecOutcome({
    code: 0,
    stdout: 'OpenAI Codex v0.149.1\n--------\nworkdir: /tmp\n--------\nuser\nhi\n',
    prompt: 'hi',
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /不能按入账算/);
});

test('账号被停用要单独认出来（A1 的现场）', () => {
  const outcome = parseExecOutcome({ code: 1, stdout: '', stderr: 'error: account_deactivated' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.verdict, VERDICTS.DEACTIVATED);
});
