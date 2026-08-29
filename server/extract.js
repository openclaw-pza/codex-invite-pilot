// extract.js — 从邮件内容里抽取验证码与链接
const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;

// 4-8 位连续数字的候选
const DIGIT_GROUP = /\b(\d{4,8})\b/g;

// 看起来像年份的 4 位数（1990-2099），用于排除「© 2026」「Jun 2026」这类误判
function looksLikeYear(num) {
  return /^(19|20)\d{2}$/.test(num);
}

// 提示词用全词/词组匹配，避免 "Codex" 里的 "code" 被误当成验证码提示。
//
// 「安全代码」是**微软中文账户安全信的原话**，2026-08-26 审计发现漏了它。
// 绑恢复邮箱那一步全靠从这封信里抽码 —— 抽不到就等于废一个微软账号。
// 之前几轮能跑通是运气：收到的恰好是 6 位，被下面那条无提示词兜底捡到了；
// 微软也发 7 位的安全代码，那种情况下旧代码必然抽不出来。
// 注意这是**收紧**不是放宽：只多认几个提示词，无提示词的兜底一个字没动。
const HINT_SRC =
  '(?:验证码|校验码|动态码|验证代码|安全代码|安全性代码|安全码|verification\\s+code|one[-\\s]?time\\s+(?:code|password)'
  + '|security\\s+code|\\bOTP\\b|\\bpasscode\\b|\\bPIN\\b|\\bcode\\b)';
const HINT_REGEX = new RegExp(HINT_SRC + '[^\\d]{0,18}(\\d{4,8})', 'gi');

// 分段验证码：提示词后面跟着「数字中间夹了分隔符」的串。两种真实来源：
//   · 平台为了好念主动分组：「验证码：129-482」「code: 123 456」
//   · 邮件把每位数字单独包一层标签防抓取，stripHtml 换成空格后变「5 8 3 0 1 4」
// 只在提示词后面才这样宽松匹配 —— 无提示词时放开分隔符会把日期、电话、金额全吃进来。
const HINT_GROUPED_REGEX = new RegExp(HINT_SRC + '[^\\d]{0,18}(\\d(?:[-\\s\\u00A0]?\\d){3,9})', 'i');

// 没有提示词、但被拆成单个数字的六位码（「5 8 3 0 1 4 is your Telegram code」
// 这种提示词在后面的写法，靠 HINT 抓不到）。只认「正好 6 个单数字、每个之间一个空格」
// 这一种最保守的形态，多一位少一位都不认，免得把列表里的数字串当成码。
const SPACED_SIX_REGEX = /(?:^|[^\d\-])(\d(?:[ \u00A0]\d){5})(?![\d ]*\d)/;

// 看起来像 YYYYMMDD 的 8 位数（去掉分隔符后的「2026-08-22」），别当验证码
function looksLikeDate(num) {
  return /^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(num);
}

// 去掉分组分隔符后校验：必须是 4~8 位，且不是年份/日期
function cleanGrouped(raw) {
  const digits = String(raw || '').replace(/[^\d]/g, '');
  if (digits.length < 4 || digits.length > 8) return '';
  if (looksLikeYear(digits) || looksLikeDate(digits)) return '';
  return digits;
}

// 抽取验证码：
// 1) 优先取明确提示词（验证码 / verification code / OTP …）附近的数字
// 2) 否则只认「独立的 6 位数字」（最常见的 OTP 长度），并排除年份，避免误判
export function extractCode(text) {
  const content = String(text || '');
  if (!content) return '';

  // 提示词后面的数字。要遍历所有提示词而不是只看第一个，并且跳过年份 ——
  // 「Your code expires on 2026-08-22」里 code 后面跟的是 2026，
  // 直接返回就会把年份当验证码摆进金色胶囊里，买家照着填必然失败。
  // 空胶囊只是少个便利，填错码是白白烧掉一次取号。
  HINT_REGEX.lastIndex = 0;
  for (const m of content.matchAll(HINT_REGEX)) {
    if (m[1] && !looksLikeYear(m[1])) return m[1];
  }

  // 提示词后面的分段码（129-482 / 5 8 3 0 1 4），去掉分隔符再校验
  const grouped = content.match(HINT_GROUPED_REGEX);
  if (grouped?.[1]) {
    const cleaned = cleanGrouped(grouped[1]);
    if (cleaned) return cleaned;
  }

  const groups = Array.from(content.matchAll(DIGIT_GROUP), (m) => m[1]);
  const sixDigit = groups.find((g) => g.length === 6 && !looksLikeYear(g));
  if (sixDigit) return sixDigit;

  // 最后兜底：无提示词但逐位拆开的六位码
  const spaced = content.match(SPACED_SIX_REGEX);
  return spaced ? spaced[1].replace(/[^\d]/g, '') : '';
}

// 抽取链接：去重，过滤图片/样式/追踪像素（open / track / beacon / wf/open）
export function extractLinks(text) {
  const content = String(text || '');
  if (!content) return [];
  const seen = new Set();
  const links = [];
  for (const match of content.matchAll(URL_REGEX)) {
    const url = match[0]
      .replace(/&amp;/gi, '&')
      .replace(/&#38;/g, '&')
      .replace(/[.,;]+$/, '');
    if (seen.has(url)) continue;
    if (/\.(png|jpe?g|gif|webp|svg|css|ico|woff2?|ttf|otf|eot)(\?|$)/i.test(url)) continue;
    if (/\/(wf\/open|open|track|beacon|pixel|unsubscribe)\b/i.test(url)) continue;
    seen.add(url);
    links.push(url);
  }
  return links;
}
