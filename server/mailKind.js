// mailKind.js — 判断一封信是「Codex 邀请」还是「登录验证码」
//
// 给邀请助手用。向导得知道现在收到的这封是哪一类，才能把买家推到下一步：
// 邀请信 → 给一个「打开邀请页」的大按钮；验证码信 → 把 6 位码顶出来给他抄。
// 判错的代价不是显示难看，是**买家卡在那儿不知道该干嘛**。
//
// 判据优先级：发件人 > 主题 > 正文里有没有邀请链接。
// 发件人放第一位是因为它最难伪造也最稳定；主题和正文文案 OpenAI 会改。
//
// 白名单来自 vault 40-Maps/CodexInvitePilot_架构总览.md 里记的那份
// （那套本机流水线跑通过，发件人是实测出来的，不是猜的）。

// 邀请信的发件人。收窄到具体地址而不是整个 openai.com：
// 放宽到域名的话，OpenAI 的营销邮件也会被当成邀请信，向导会指着一封广告说"邀请到了"。
//
// 这是仓库里发件人白名单的**唯一定义**。automationMatch.js 必须从这里 import，
// 禁止再抄一份 Set——上一轮两处不一致，少了 noreply@email.openai.com。
export const INVITE_SENDERS = Object.freeze([
  'noreply@codex.chatgpt.com',
]);

// 登录/注册验证码的发件人。
// 第三个地址是 vault/向导首版带进来的【来源声称】，本仓库没有抓到过实信；
// 留着是为了换发件人域时不静默丢码，不是声称「已经实测收到过」。
export const OTP_SENDERS = Object.freeze([
  'noreply@tm.openai.com',
  'otp@tm1.openai.com',
  'noreply@email.openai.com',
]);

// 邀请链接允许的域。跟发件人白名单是两道独立的闸：
// 就算发件人对了，链接指向站外也不能给买家点 —— 那是钓鱼邮件的标准形态。
const INVITE_HOSTS = ['chatgpt.com', 'openai.com'];

function senderAddress(from) {
  const raw = String(from || '').trim().toLowerCase();
  const m = /<([^>]+)>/.exec(raw);
  return (m ? m[1] : raw).trim();
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

// 链接是不是指向 chatgpt.com / openai.com（含子域）
export function isAllowedInviteUrl(url) {
  const host = hostOf(url);
  if (!host) return false;
  return INVITE_HOSTS.some((base) => host === base || host.endsWith(`.${base}`));
}

// 链接长得像不像"接受邀请"。
//
// 只看域名不够：OpenAI 的营销邮件正文里必然有一堆 openai.com 链接，
// 那样每封广告都会被当成邀请信。
//
// 但也**不能要求关键词后面立刻结束** —— 真实的 Codex 邀请链接长这样：
//   https://chatgpt.com/accept-referral?referral_context=…
//   https://chatgpt.com/accept-referral/TOKEN
// 上一版正则写的是 `(accept|invite|…)(\/|$|\?)`，`accept-referral` 里
// accept 后面跟着 `-referral`，直接匹配不上 —— 结果是**每个买家都会卡在第 2 步**：
// 邀请信到了，我们认不出来，向导永远停在"正在等邀请信"。
// 这个 bug 是对抗审查的 agent 真的跑了这个模块才抓到的，静态看代码看不出来。
//
// 所以改成「路径里出现这些词就算」，宽一档。宽出来的假阳性由发件人白名单兜底：
// 能走到这里的信，发件人已经是 codex.chatgpt.com / openai.com 了。
const INVITE_WORDS = /(invite|invitation|referral|refer|accept|join|redeem|activate|claim)/i;

function looksLikeInvitePath(url) {
  try {
    const u = new URL(String(url));
    if (INVITE_WORDS.test(u.pathname)) return true;
    // 有些是把 token 放在查询串上（?invite=… / ?token=… / ?code=…）
    return /(invite|referral|token|code|claim)=/i.test(u.search);
  } catch {
    return false;
  }
}

// 从一封信里挑出可以给买家点的邀请链接。挑不出就返回 null ——
// 宁可让买家自己去信里找，也不能把一个站外链接（或一条广告链接）
// 包装成"点这里接受邀请"。
export function pickInviteUrl(links) {
  if (!Array.isArray(links)) return null;
  return links.find((url) => isAllowedInviteUrl(url) && looksLikeInvitePath(url)) || null;
}

/**
 * 判断邮件类型：'invite' | 'otp' | 'other'
 * 只在发件人可信时才认；发件人不认识的一律 'other'，哪怕正文写着"邀请"。
 */
export function classifyMail(mail) {
  const addr = senderAddress(mail?.from);
  if (!addr) return 'other';

  if (INVITE_SENDERS.includes(addr)) {
    // 发件人对了还要真有一个合法邀请链接，否则给不出下一步动作
    return pickInviteUrl(mail?.links) ? 'invite' : 'other';
  }
  if (OTP_SENDERS.includes(addr)) {
    return mail?.code ? 'otp' : 'other';
  }

  // 发件人在 openai.com / chatgpt.com 下但不在白名单里：
  // 有可能是 OpenAI 换了发件地址。给一个宽松兜底，但要求证据更硬 ——
  // 必须同时满足「域名是他们的」+「有码或有合法邀请链接」。
  const looksOfficial = /(^|[.@])(openai\.com|chatgpt\.com)$/.test(addr.split('@')[1] || '');
  if (looksOfficial) {
    if (pickInviteUrl(mail?.links)) return 'invite';
    if (mail?.code) return 'otp';
  }
  return 'other';
}
