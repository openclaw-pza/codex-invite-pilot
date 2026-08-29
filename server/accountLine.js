// accountLine.js — 解析卖家发货的账号行。
//
// 抽出来单独放是因为它是**判据**：哪一段是密码、哪一段是 client_id、
// 哪一段是 refresh_token，全靠这里认。认错的后果都很贵：
//   · 密码被截断 → 登录失败 → 看着像"号本身废了" → 被 markDead 白扔掉一个好号
//   · token 存进 client_id → 令牌号退化成网页号，白白多走 150 秒授权
// 而它埋在 CLI 脚本里时一行测试都写不了。

/**
 * 认两种发货格式：
 *   邮箱----密码                                  （网页号）
 *   邮箱----密码----client_id----refresh_token    （Graph 令牌号）
 * 返回 null 表示这一行不是账号（空行、注释、格式不对）。
 */
export function parseAccountLine(line) {
  const text = String(line == null ? '' : line).trim();
  if (!text || text.startsWith('#')) return null;

  // 只在**第一个分隔符**处切一刀，后面整段保留。
  // 老写法 split(/----|[\s,|]+/) 把密码里的空格/竖线/逗号/tab 也当分隔符，
  // 密码被静默砍半 —— 审计实测：'a@o.com----Pw 123' 解析出的密码是 'Pw'。
  const m = text.match(/^(\S+?@\S+?)(?:----|[\s,|]+)(.+)$/);
  if (!m) return null;

  const parts = m[2].split('----').map((x) => x.trim());
  const password = parts[0];
  if (!password) return null;

  const row = { address: m[1].toLowerCase(), password };
  // 按**形状**认，不按位置认：卖家的字段顺序不保证，按位置写死迟早把
  // token 存进 client_id 里，而那种错是静默的 —— 只表现为"授权莫名其妙失败"。
  for (const part of parts.slice(1)) {
    if (UUID.test(part)) row.clientId = part;
    else if (part.length >= 60) row.refreshToken = part;
  }
  return row;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
