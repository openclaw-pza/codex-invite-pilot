import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addressMatches,
  findInvitationMail,
  findOtpMail,
  inviteUrlOf,
  inspectInviteReferral,
  isAllowedInviteUrl,
  isRecentInviteMail,
  normalizeSender,
  profileKey,
} from '../server/automationMatch.js';

function referralUrl(payload) {
  const context = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `https://chatgpt.com/accept-referral?referral_context=${context}`;
}

test('只接受官方邀请发件人与允许域名的新邮件', () => {
  const mails = [
    { id: 'old', from: 'ChatGPT <noreply@codex.chatgpt.com>', subject: '你已受邀使用 ChatGPT', body: '', links: ['https://chatgpt.com/invite/old'] },
    { id: 'evil', from: 'noreply@codex.chatgpt.com.evil.test', subject: '邀请', body: '', links: ['https://chatgpt.com.evil.test/invite/x'] },
    { id: 'new', from: 'ChatGPT <noreply@codex.chatgpt.com>', subject: '诚邀你使用 ChatGPT 桌面版', body: '', links: ['https://openai.com/', 'https://chatgpt.com/invite/token'] },
  ];
  const match = findInvitationMail(mails, ['old']);
  assert.equal(match.id, 'new');
  assert.equal(inviteUrlOf(match), 'https://chatgpt.com/invite/token');
  assert.equal(isAllowedInviteUrl('http://chatgpt.com/invite/x'), false);
  assert.equal(isAllowedInviteUrl('https://openai.com.evil.test/x'), false);
});

test('允许启动前刚到达的邀请，但拒绝陈旧邀请', () => {
  const startedAt = '2026-08-08T03:00:47.759Z';
  assert.equal(isRecentInviteMail({ receivedAt: '2026-08-08 03:00:46' }, startedAt), true);
  assert.equal(isRecentInviteMail({ receivedAt: '2026-08-08 02:40:46' }, startedAt), false);
  assert.equal(isRecentInviteMail({ receivedAt: 'not-a-date' }, startedAt), false);
});

test('OTP 只采用新到达的官方六位验证码', () => {
  const mails = [
    { id: '1', from: 'noreply@tm.openai.com', code: '111111' },
    { id: '2', from: 'Attacker <noreply@tm.openai.com.evil.test>', code: '222222' },
    { id: '3', from: 'OpenAI <otp@tm1.openai.com>', code: '137635' },
  ];
  assert.equal(findOtpMail(mails, ['1']).id, '3');
  assert.equal(normalizeSender('OpenAI <OTP@tm1.openai.com>'), 'otp@tm1.openai.com');
});

test('OTP 发件人与 mailKind 同源，含 noreply@email.openai.com', async () => {
  const { OTP_SENDERS } = await import('../server/mailKind.js');
  assert.ok(OTP_SENDERS.includes('noreply@email.openai.com'));
  const match = findOtpMail(
    [{ id: 'email-domain', from: 'OpenAI <noreply@email.openai.com>', code: '246801' }],
    [],
  );
  assert.equal(match.id, 'email-domain');
});

test('浏览器档案键稳定且不泄露邮箱', () => {
  const key = profileKey('User@Example.com');
  assert.equal(key, profileKey('user@example.com'));
  assert.match(key, /^[a-f0-9]{20}$/);
  assert.equal(key.includes('user'), false);
  assert.equal(addressMatches('Pilot <user@example.com>, copy@example.com', 'user@example.com'), true);
  assert.equal(addressMatches('user@example.com.evil.test', 'user@example.com'), false);
});

test('服务端把 OpenAI 无奖励字段作为警告而非硬拦截', () => {
  assert.equal(inspectInviteReferral(referralUrl({
    referral_type: 'codex_referral_consumer',
    has_rewards: false,
  })).noRewards, true);
  assert.equal(inspectInviteReferral(referralUrl({
    referral_type: 'personal_credits',
    has_rewards: true,
  })).noRewards, false);
});
