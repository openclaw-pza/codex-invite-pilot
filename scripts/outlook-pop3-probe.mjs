#!/usr/bin/env node
// 微软邮箱 POP3 哨兵：只用账号密码，验「能不能登录 + 能不能读到信 + 信能不能被正确分类」。
//
// 实测依据（2026-08-25 DMIT-2）：
//   IMAP outlook.office365.com:993 → AUTH=XOAUTH2 LOGINDISABLED  （密码被禁）
//   POP3 pop-mail.outlook.com:995  → SASL PLAIN XOAUTH2 / USER   （密码还在）
// 所以走 POP3 就不需要 Azure 应用注册，也不需要任何一次性同意。
//
// 用法：
//   POP3_USER=xx@outlook.com POP3_PASS='密码' node scripts/outlook-pop3-probe.mjs
//
// 跑不通时最常见的三个原因，按这个顺序排查：
//   1) 账号里没开 POP：outlook.com → 设置 → 邮件 → 同步电子邮件 → POP 选项 → 允许设备和应用使用 POP
//   2) 开了两步验证：需要用「应用密码」而不是账号密码
//   3) 微软对这个账号也关了基本认证 → 只能退回 Graph（要 client_id）

import { checkPop3Login, listMails } from '../server/pop3Mail.js';

const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : String(process.argv[i + 1] || '').trim();
};

if (!process.env.POP3_USER || !process.env.POP3_PASS) {
  console.error('缺少 POP3_USER / POP3_PASS');
  process.exit(2);
}

console.log(`信箱：${process.env.POP3_USER}`);
try {
  const login = await checkPop3Login();
  console.log(`✅ 登录成功，收件箱里有 ${login.total} 封信`);
} catch (error) {
  console.error(`❌ 登录失败：${error.message}`);
  console.error('   按脚本头部那三条依次排查（先看 POP 开没开）');
  process.exit(1);
}

const { mails } = await listMails({ limit: Number(arg('--limit', '10')) || 10 });
if (!mails.length) {
  // 「一封都读不到」默认按故障处理，不按「没有新邮件」处理。
  console.log('\n⚠️ 一封都没读到。这不等于「没有新邮件」——先确认收件箱里确实有信。');
  process.exit(1);
}

console.log(`\n读到 ${mails.length} 封：\n`);
let recognized = 0;
for (const mail of mails) {
  if (mail.kind !== 'other') recognized += 1;
  console.log(`${mail.kind === 'other' ? ' ' : '✓'} [${mail.kind}] ${mail.receivedAt}`);
  console.log(`   来自：${mail.from}`);
  console.log(`   主题：${mail.subject.slice(0, 60)}`);
  if (mail.code) console.log(`   验证码：${mail.code}`);
  if (mail.inviteUrl) console.log(`   邀请链接：${mail.inviteUrl}`);
  console.log('');
}
console.log(`识别出 ${recognized} 封 invite/otp。`);
console.log('⚠️ 记住 POP3 看不到垃圾箱 —— 如果 OpenAI 的信被判垃圾，这里永远读不到。');
console.log('   发邀请前建议先把该账号的垃圾邮件过滤调低，或改用 Graph 那条路。');
