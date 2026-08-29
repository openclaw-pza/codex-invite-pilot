// mailProvider.js — 邮箱来源的唯一切换点。
//
// 对照测试要的是「只有一个变量不同」。上一轮实验作废就是因为两组样本之间
// 代码路径也变过（launchPersistentContext 换成 launch+newContext），
// 于是分不清差异来自邮箱域还是来自代码 —— n=2 实际是 n=1 加噪声。
//
// 所以这里只做一件事：按 MAIL_PROVIDER 选一个 listMails，其余全链路共用同一份代码。
//   MAIL_PROVIDER=cloudflare  → tempmail2026.xyz（一次性域，现状）
//   MAIL_PROVIDER=outlook     → 微软账号，Graph API（要 Azure client_id + 一次同意）
//   MAIL_PROVIDER=pop3        → 微软账号，POP3 —— **实测不可用**，微软回
//                                "Basic authentication is disabled"，留着是为了别再试一遍
//   MAIL_PROVIDER=webmail     → 微软账号，浏览器读网页版（只要账号密码，唯一实测可用的微软路）
//
// 为什么有两条微软路：实测 IMAP 是 LOGINDISABLED（密码被禁），但 POP3 仍广告
// USER/SASL PLAIN，所以账号密码可能直接可用。POP3 的代价是**看不到垃圾箱**，
// Graph 能看到收件箱+垃圾箱。先试 POP3（零门槛），不行再走 Graph。
import * as cloudflare from './cloudflareEmail.js';
import * as outlook from './outlookMail.js';
import * as pop3 from './pop3Mail.js';
import * as webmail from './webmailOutlook.js';

export const MAIL_PROVIDER = String(process.env.MAIL_PROVIDER || 'cloudflare').trim().toLowerCase();

if (!['cloudflare', 'outlook', 'pop3', 'webmail'].includes(MAIL_PROVIDER)) {
  // 拼错了就当场炸，别默默回落到默认值 —— 那会让整轮对照实验的分组是错的，
  // 而且事后从数据上完全看不出来。
  throw new Error(`MAIL_PROVIDER 只能是 cloudflare / outlook / pop3 / webmail，收到：${MAIL_PROVIDER}`);
}

const active = { cloudflare, outlook, pop3, webmail }[MAIL_PROVIDER];

export function mailProviderName() {
  return MAIL_PROVIDER;
}

export function listMails(options) {
  return active.listMails(options);
}
