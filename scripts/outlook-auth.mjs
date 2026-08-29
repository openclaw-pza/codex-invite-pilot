#!/usr/bin/env node
// 微软邮箱一次性授权（设备码）。VPS 上没有浏览器，所以码由你在自己电脑上输。
//
// 为什么必须走 OAuth：2026-08-25 实测 outlook.office365.com:993 的能力串是
//   * CAPABILITY ... AUTH=XOAUTH2 LOGINDISABLED
// 微软已关闭密码登录，账号密码收不了信。
//
// 前置：需要一个 Azure 应用注册的 client_id（免费，一次性）。
//   OUTLOOK_CLIENT_ID=xxxx node scripts/outlook-auth.mjs
//
// 授权结果存在 secrets/outlook-token.json（已在 .gitignore 里），只存 refresh token。

import { startOutlookDeviceLogin, pollOutlookDeviceLogin, outlookAccount, listMails } from '../server/outlookMail.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const start = await startOutlookDeviceLogin();
console.log('\n==============================');
console.log(`请在浏览器打开：${start.verificationUrl}`);
console.log(`输入这个码：      ${start.userCode}`);
console.log('用要拿来收邀请信的那个微软账号登录并同意（只读邮件权限）。');
console.log('==============================\n');

let interval = start.interval * 1000;
const deadline = Date.now() + start.expiresIn * 1000;
for (;;) {
  if (Date.now() > deadline) {
    console.error('设备码已过期，重新跑一次');
    process.exit(1);
  }
  await sleep(interval);
  const result = await pollOutlookDeviceLogin({ clientId: start.clientId, deviceCode: start.deviceCode });
  if (result.state === 'succeeded') break;
  if (result.state === 'failed') {
    console.error(`授权失败：${result.reason}`);
    process.exit(1);
  }
  // slow_down 是微软让我们放慢，不放慢会被继续拒
  if (result.slowDown) interval += 5000;
  process.stdout.write('.');
}

console.log('\n授权成功，正在验收产物（不是只看返回码）…');
const account = await outlookAccount();
console.log(`  账号：${account.address}${account.displayName ? ` (${account.displayName})` : ''}`);
const { mails } = await listMails({ limit: 3 });
console.log(`  能读到最近 ${mails.length} 封信`);
for (const mail of mails) {
  console.log(`    · [${mail.kind}] ${mail.from} | ${mail.subject.slice(0, 50)}`);
}
console.log('\n完成。之后把 MAIL_PROVIDER=outlook 传给自动化即可切到这条臂。');
