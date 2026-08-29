import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProfile,
  findInvitationMail,
  findOtpMail,
  inviteUrlOf,
  inspectInviteReferral,
  isAllowedInviteUrl,
  isRecentMail,
} from '../extension/lib.js';

function referralUrl(payload) {
  const context = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `https://chatgpt.com/accept-referral?referral_context=${context}`;
}

test('扩展生成固定格式姓名且年龄始终在 21–32 岁', () => {
  assert.deepEqual(createProfile(() => 0), { name: 'Alex Chen', age: 21 });
  assert.deepEqual(createProfile(() => 0.999999), { name: 'Avery Xu', age: 32 });
  for (let index = 0; index < 100; index += 1) {
    const profile = createProfile(Math.random);
    assert.match(profile.name, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
    assert.ok(profile.age >= 21 && profile.age <= 32);
  }
});

test('Chrome 扩展只接受新到达的官方邀请链接', () => {
  const mails = [
    { id: 'old', from: 'ChatGPT <noreply@codex.chatgpt.com>', subject: '你已受邀使用 ChatGPT', links: ['https://chatgpt.com/accept-referral?referral_context=old'] },
    { id: 'evil', from: 'noreply@codex.chatgpt.com.evil.test', subject: '邀请', links: ['https://chatgpt.com.evil.test/invite/x'] },
    { id: 'new', from: 'ChatGPT <noreply@codex.chatgpt.com>', subject: '你已受邀使用 ChatGPT 桌面版', links: ['https://chatgpt.com/accept-referral?referral_context=secret'] },
  ];
  const match = findInvitationMail(mails, ['old']);
  assert.equal(match.id, 'new');
  assert.match(inviteUrlOf(match), /^https:\/\/chatgpt\.com\/accept-referral/);
  assert.equal(isAllowedInviteUrl('https://chatgpt.com.evil.test/invite/x'), false);
});

test('Chrome 扩展匹配官方 OTP 且不采用旧邮件', () => {
  const mails = [
    { id: '1', from: 'noreply@tm.openai.com', code: '111111' },
    { id: '2', from: 'otp@tm1.openai.com', code: '654321' },
  ];
  assert.equal(findOtpMail(mails, ['1']).code, '654321');
});

test('Chrome 扩展 OTP 发件人与 mailKind 同源', async () => {
  const { OTP_SENDERS } = await import('../server/mailKind.js');
  for (const from of OTP_SENDERS) {
    const mails = [{ id: from, from: `OpenAI <${from}>`, code: '123456' }];
    assert.equal(findOtpMail(mails, []).id, from, from);
  }
});

test('Chrome 扩展允许启动前十分钟内刚到达的邀请', () => {
  const reference = '2026-08-08T03:00:47.759Z';
  assert.equal(isRecentMail({ receivedAt: '2026-08-08 03:00:46' }, reference), true);
  assert.equal(isRecentMail({ receivedAt: '2026-08-08 02:40:46' }, reference), false);
});

test('Chrome 扩展识别不带奖励的邀请但不把它误判为不可打开', () => {
  const inspection = inspectInviteReferral(referralUrl({
    referral_type: 'codex_referral_consumer',
    has_rewards: false,
    email_referred_to: 'secret@example.com',
    referral_id: 'do-not-log-this',
  }));
  assert.deepEqual(inspection, {
    hasContext: true,
    referralType: 'codex_referral_consumer',
    hasRewards: false,
    noRewards: true,
  });
  assert.equal(JSON.stringify(inspection).includes('secret@example.com'), false);
  assert.equal(inspectInviteReferral(referralUrl({ referral_type: 'personal_credits', has_rewards: true })).noRewards, false);
});
