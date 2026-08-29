#!/usr/bin/env node
// 收信哨兵。真链路开跑前先用它验一遍「信能不能读到、能不能被正确分类」。
//
// 项目硬规则：批量写之前先跑哨兵，验收**产物**而不是返回码。
// 这里的产物是「这封 OpenAI 的信被认成了 invite / otp，而且码和链接都抽出来了」。
// 只看 HTTP 200 是不够的 —— 白名单漂移时接口照样 200，信照样读到，
// 只是全被判成 other，向导会永远转圈（这就是 ops-002 B4 那条唯一确定会造成退款的失效模式）。
//
// 用法：
//   node scripts/outlook-mail-probe.mjs                 # 最近 10 封
//   node scripts/outlook-mail-probe.mjs --limit 20      # 更多
//   node scripts/outlook-mail-probe.mjs --address a@b.c # 只看发给某地址的

import { listMails, outlookAccount, outlookConfigured } from '../server/outlookMail.js';

const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : String(process.argv[i + 1] || '').trim();
};

if (!outlookConfigured()) {
  console.error('还没授权。先跑：OUTLOOK_CLIENT_ID=xxx node scripts/outlook-auth.mjs');
  process.exit(2);
}

const account = await outlookAccount();
console.log(`信箱：${account.address}`);

const { mails } = await listMails({
  address: arg('--address'),
  limit: Number(arg('--limit', '10')) || 10,
});

if (!mails.length) {
  // 「一封都读不到」在本项目里默认按故障处理，不按「没有新邮件」处理。
  console.log('\n⚠ 一封都没读到。这不等于「没有新邮件」——先排除授权范围、文件夹、过滤条件，再下结论。');
  process.exit(1);
}

console.log(`\n共 ${mails.length} 封：\n`);
let recognized = 0;
for (const mail of mails) {
  const flag = mail.kind === 'other' ? ' ' : '✓';
  if (mail.kind !== 'other') recognized += 1;
  console.log(`${flag} [${mail.kind}] ${mail.receivedAt}`);
  console.log(`   来自：${mail.from}`);
  console.log(`   主题：${mail.subject.slice(0, 60)}`);
  if (mail.code) console.log(`   验证码：${mail.code}`);
  if (mail.inviteUrl) console.log(`   邀请链接：${mail.inviteUrl}`);
  console.log('');
}

console.log(`识别出 ${recognized} 封 invite/otp。`);
console.log('若 OpenAI 的信被判成 other，说明发件人白名单漂移了 —— 那是「向导永远转圈」的根因，');
console.log('修法是改 server/mailKind.js 里的白名单（唯一定义处），不要在别处再抄一份。');
