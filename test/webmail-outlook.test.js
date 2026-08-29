import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReadingPane } from '../server/webmailOutlook.js';

// 这段是 2026-08-25 从真实信箱阅读窗格抓下来的原文，不是编的。
const REAL = 'Microsoft 帐户安全信息验证 M帐 Microsoft 帐户团队<account-security-noreply@accountprotection.microsoft.com>  收件人:​你​ 周二 2026/8/25 8:31  Microsoft 帐户 非常感谢你验证安全信息';

test('从阅读窗格抓得出真实发件人地址（列表行只有显示名，不够用）', () => {
  const mail = parseReadingPane(REAL, []);
  assert.equal(mail.from, 'account-security-noreply@accountprotection.microsoft.com');
});

test('OpenAI 邀请信能被认成 invite，链接取自 a[href] 而不是正文文本', () => {
  const mail = parseReadingPane(
    'You are invited 邀请 OpenAI<noreply@codex.chatgpt.com> 收件人:你 周二 2026/8/25 9:00 Join Codex',
    ['https://chatgpt.com/invite/ABC123', 'https://openai.com/policies'],
  );
  assert.equal(mail.kind, 'invite');
  assert.equal(mail.inviteUrl, 'https://chatgpt.com/invite/ABC123');
});

test('验证码信抽得出码', () => {
  const mail = parseReadingPane(
    'Your code OpenAI<noreply@tm.openai.com> 收件人:你 周二 2026/8/25 9:05 Your code is 481902',
    [],
  );
  assert.equal(mail.kind, 'otp');
  assert.equal(mail.code, '481902');
});

// 阅读窗格里混着导航文案和页脚，非 http 的伪链接不能进 links ——
// 那会让 pickInviteUrl 把 mailto:/javascript: 之类当成邀请链接。
test('非 http 链接不进候选', () => {
  const mail = parseReadingPane('x <a@b.com> body', ['mailto:x@y.com', 'javascript:void(0)', 'https://chatgpt.com/invite/Z']);
  assert.deepEqual(mail.links, ['https://chatgpt.com/invite/Z']);
});

test('没有发件人地址时不瞎猜，kind 落到 other', () => {
  const mail = parseReadingPane('一段没有尖括号地址的正文', ['https://chatgpt.com/invite/Z']);
  assert.equal(mail.from, '');
  assert.equal(mail.kind, 'other');
});
