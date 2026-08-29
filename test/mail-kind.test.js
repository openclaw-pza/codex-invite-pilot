// mail-kind.test.js — 邀请信 / 验证码信的识别
//
// 邀请助手的每一步都靠这个判断推进。判错的两种后果都很实：
//   · 把广告认成邀请信 → 向导指着一封广告说"邀请到了"，买家点进去一脸懵
//   · 把钓鱼链接当成邀请链接 → 我们亲手把买家送去钓鱼站
// 所以发件人白名单收得很窄，而且链接域名要单独再验一次。

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMail, isAllowedInviteUrl, pickInviteUrl } from '../server/mailKind.js';

const invite = (over = {}) => ({
  from: 'ChatGPT <noreply@codex.chatgpt.com>',
  subject: '你已受邀使用 Codex',
  links: ['https://chatgpt.com/invite/abc123'],
  code: '',
  ...over,
});

const otp = (over = {}) => ({
  from: 'OpenAI <noreply@tm.openai.com>',
  subject: 'Your verification code',
  links: [],
  code: '583014',
  ...over,
});

test('邀请信：发件人 + 合法链接都对才算', () => {
  assert.equal(classifyMail(invite()), 'invite');
  assert.equal(pickInviteUrl(invite().links), 'https://chatgpt.com/invite/abc123');
});

test('邀请信发件人对、但没有合法链接 → 不算邀请', () => {
  // 给不出"下一步点哪里"，标成邀请只会让向导卡住
  assert.equal(classifyMail(invite({ links: [] })), 'other');
  assert.equal(classifyMail(invite({ links: ['https://evil.example/invite'] })), 'other');
});

test('验证码信：发件人 + 真抽到码才算', () => {
  assert.equal(classifyMail(otp()), 'otp');
  assert.equal(classifyMail(otp({ code: '' })), 'other');
});

test('OTP 白名单含 noreply@email.openai.com（来源声称，用于防漂移）', async () => {
  const { OTP_SENDERS } = await import('../server/mailKind.js');
  assert.deepEqual([...OTP_SENDERS], [
    'noreply@tm.openai.com',
    'otp@tm1.openai.com',
    'noreply@email.openai.com',
  ]);
  assert.equal(classifyMail({
    from: 'OpenAI <noreply@email.openai.com>',
    code: '583014',
    links: [],
  }), 'otp');
});

test('陌生发件人一律 other，哪怕正文写着邀请', () => {
  assert.equal(classifyMail({
    from: 'Codex 官方 <noreply@codex-chatgpt.com>',    // 少一个点，是仿冒域名
    subject: '你已受邀使用 Codex，点此接受邀请',
    links: ['https://chatgpt.com/invite/abc'],
  }), 'other');
  assert.equal(classifyMail({ from: '', links: ['https://chatgpt.com/invite/x'] }), 'other');
});

test('OpenAI 换发件地址时的兜底：域名对 + 有硬证据才认', () => {
  // 官方域名下的新地址，带合法邀请链接 → 认
  assert.equal(classifyMail({
    from: 'noreply@mail.openai.com', links: ['https://chatgpt.com/invite/x'],
  }), 'invite');
  // 官方域名下的新地址，带码 → 认成验证码
  assert.equal(classifyMail({ from: 'x@openai.com', code: '123456', links: [] }), 'otp');
  // 纯广告：官方域名、有 openai.com 链接，但链接不长得像邀请 → 不能认
  // （这条一开始是错的：只看域名的话每封营销邮件都会被标成"邀请到了"）
  assert.equal(classifyMail({ from: 'news@openai.com', links: ['https://openai.com/blog'], code: '' }), 'other');
});

test('邀请链接域名闸：只认 chatgpt.com / openai.com 及其子域', () => {
  for (const good of [
    'https://chatgpt.com/invite/a',
    'https://auth.openai.com/x',
    'https://platform.openai.com/y',
  ]) assert.equal(isAllowedInviteUrl(good), true, good);

  for (const bad of [
    'https://chatgpt.com.evil.example/invite',   // 前缀像，主域是 evil.example
    'https://notchatgpt.com/invite',             // 后缀像，但不是子域
    'https://openai.com.cn/invite',
    'http://evil.example/?u=https://chatgpt.com/invite',
    'not a url', '', null,
  ]) assert.equal(isAllowedInviteUrl(bad), false, String(bad));
});

test('挑邀请链接：信里常有帮助中心/退订，不能拿 links[0] 顶包', () => {
  const links = ['https://help.example.com/faq', 'https://chatgpt.com/invite/real'];
  assert.equal(pickInviteUrl(links), 'https://chatgpt.com/invite/real');
  assert.equal(pickInviteUrl(['https://help.example.com/faq']), null);
  assert.equal(pickInviteUrl(null), null);
});

test('域名对但路径不像邀请的，一律不挑 —— 否则每封广告都成了邀请信', () => {
  for (const notInvite of [
    'https://openai.com/blog',
    'https://chatgpt.com/',
    'https://openai.com/unsubscribe',
    'https://help.openai.com/articles/123',
  ]) assert.equal(pickInviteUrl([notInvite]), null, notInvite);

  for (const yes of [
    'https://chatgpt.com/invite/abc123',
    'https://chatgpt.com/accept?invite=xyz',
    'https://auth.openai.com/join/team-1',
  ]) assert.equal(pickInviteUrl([yes]), yes, yes);
});

// 2026-08-22 对抗审查抓到的真 bug：真实 Codex 邀请链接是
//   https://chatgpt.com/accept-referral?referral_context=…
// 而上一版正则要求关键词后面立刻结束（`accept(\/|$|\?)`），
// `accept-referral` 里 accept 后面跟着 `-referral`，直接匹配不上。
// 后果不是显示难看，是**每个买家都卡在第 2 步**：邀请信到了、我们认不出来、
// 向导永远停在"正在等邀请信"。静态看代码看不出来，agent 真跑了这个模块才发现。
test('真实的 accept-referral 形态必须认得', () => {
  for (const u of [
    'https://chatgpt.com/accept-referral?referral_context=abc',
    'https://chatgpt.com/accept-referral/TOKEN123',
    'https://chatgpt.com/accept?invite=xyz',
    'https://auth.openai.com/join/team-1',
    'https://chatgpt.com/invite/abc123',
  ]) assert.equal(pickInviteUrl([u]), u, u);

  assert.equal(classifyMail({
    from: 'ChatGPT <noreply@codex.chatgpt.com>',
    links: ['https://chatgpt.com/accept-referral?referral_context=abc'],
    code: '',
  }), 'invite');
});

test('放宽之后也不能把广告和站外链接放进来', () => {
  // 宽出来的假阳性由发件人白名单兜底，但域名闸和"不像邀请"这两道还得站着
  for (const u of [
    'https://openai.com/blog',
    'https://chatgpt.com/',
    'https://openai.com/unsubscribe',
    'https://evil.example/accept-referral?x=1',   // 路径像但域名不是他们的
  ]) assert.equal(pickInviteUrl([u]), null, u);
});
