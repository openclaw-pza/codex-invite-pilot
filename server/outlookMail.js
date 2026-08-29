// outlookMail.js — 用微软账号收信（Microsoft Graph），给 Codex 邀请链路当邮箱来源。
//
// 为什么不是 IMAP：2026-08-25 在 DMIT-2 上直连 outlook.office365.com:993 拿到的能力串是
//   * CAPABILITY IMAP4 IMAP4rev1 AUTH=XOAUTH2 LOGINDISABLED ...
// `LOGINDISABLED` + 唯一机制 `AUTH=XOAUTH2` —— 微软已经关掉密码登录。
// 拿到账号密码也收不了信，OAuth2 是唯一的路。既然都要 OAuth，Graph 比 IMAP 更划算：
// 纯 HTTPS+JSON，不用引 IMAP 客户端库（本项目零打包器、能不加依赖就不加）。
//
// 为什么要有这条路：竞品分配的是 @outlook.com 真邮箱而不是一次性域名，
// 而 OpenAI 的 referral 条款逐字排除 `address aliases used to evade eligibility`。
// 我们自己的 tempmail2026.xyz 是 3 个月新域 + catch-all，是典型一次性邮箱特征。
// 这个模块存在的意义就是让「真实微软邮箱」成为可对照的另一条臂 ——
// 判据是「OpenAI 收不收」，不是「哪个便宜」。
//
// 接口刻意跟 cloudflareEmail.js 的 listMails 完全一致（同样的字段、同样的分类函数），
// 这样切换邮箱来源只动一个环境变量，**下游代码路径一个字都不变**。
// 上一轮对照实验的教训就是「旧样本不能当对照组，因为代码路径变过」——
// 这次从设计上堵死这一条。

import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractCode, extractLinks } from './extract.js';
import { classifyMail, pickInviteUrl } from './mailKind.js';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
// secrets/ 已在 .gitignore 里。refresh token 等价于长期邮箱读取权，绝不进版本库。
// 一个 outlook 只能收一次邀请，所以每轮换号 —— token 必须按账号分开存，
// 共用一个文件会让上一个号的 refresh_token 覆盖下一个号的。
// 与 scripts/outlook-grant-token.mjs 的落盘路径保持同一套算法。
function tokenPathFor(address) {
  const key = createHash('sha256').update(String(address || '').trim().toLowerCase()).digest('hex').slice(0, 20);
  return join(ROOT_DIR, 'data', 'outlook-tokens', `${key}.json`);
}
const TOKEN_PATH = process.env.OUTLOOK_TOKEN_PATH
  || tokenPathFor(process.env.WEBMAIL_USER || process.env.OUTLOOK_USER || '');
// 个人微软账号用 consumers；如果将来换成企业号改这里（或给环境变量）。
const TENANT = process.env.OUTLOOK_TENANT || 'consumers';
const AUTH_BASE = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`;
const GRAPH = 'https://graph.microsoft.com/v1.0';
// offline_access 换 refresh token；Mail.Read 是只读。
// 不要 Mail.ReadWrite：这个链路只需要读，多要一分权限就多一分账号被封时的解释成本。
// scope 必须跟当初授权时用的一致，否则刷新会被拒。授权脚本默认申请的是
// https://graph.microsoft.com/Mail.Read，这里跟着走同一串。
const SCOPE = process.env.OUTLOOK_SCOPE || 'https://graph.microsoft.com/Mail.Read offline_access';
const PREVIEW_MAX = 4000;
// 收件箱和垃圾箱都要查。OpenAI 的验证码信被微软判垃圾是常见情况，
// 只查收件箱的表现是「永远收不到码」，而日志上一切正常 —— 又一个静默失败。
const FOLDERS = ['inbox', 'junkemail'];

function readTokenStore() {
  try {
    return JSON.parse(readFileSync(TOKEN_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeTokenStore(store) {
  mkdirSync(dirname(TOKEN_PATH), { recursive: true });
  writeFileSync(TOKEN_PATH, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

// 默认用 Thunderbird 的公开 client_id：实测微软 consumers 端点接受它签发
// IMAP / POP / Graph 三种 scope 的设备码，因此**不需要自己去 Azure 注册应用**。
const THUNDERBIRD_CLIENT_ID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';

export function outlookClientId() {
  const store = readTokenStore();
  return String(process.env.OUTLOOK_CLIENT_ID || store?.clientId || THUNDERBIRD_CLIENT_ID).trim();
}

export function outlookConfigured() {
  return Boolean(outlookClientId() && readTokenStore()?.refreshToken);
}

async function postForm(url, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const text = await response.text();
  let payload = {};
  try { payload = JSON.parse(text); } catch { /* 微软出错时也回 JSON，解不动就当空对象，下面按状态码报错 */ }
  return { ok: response.ok, status: response.status, payload, text };
}

// ——— 设备码授权：VPS 上没有浏览器，所以由安哥在自己电脑上输一个码 ———
export async function startOutlookDeviceLogin({ clientId = outlookClientId() } = {}) {
  if (!clientId) throw new Error('缺少 OUTLOOK_CLIENT_ID（Azure 应用注册的应用程序 ID）');
  const { ok, payload, text } = await postForm(`${AUTH_BASE}/devicecode`, { client_id: clientId, scope: SCOPE });
  if (!ok || !payload.device_code) {
    throw new Error(`微软设备码申请失败：${payload.error_description || text.slice(0, 200)}`);
  }
  return {
    clientId,
    deviceCode: payload.device_code,
    userCode: payload.user_code,
    verificationUrl: payload.verification_uri,
    expiresIn: Number(payload.expires_in) || 900,
    interval: Number(payload.interval) || 5,
    message: payload.message || '',
  };
}

// 轮询一次。返回 pending 表示还没批准 —— 这不是错误，别在调用方当失败处理。
export async function pollOutlookDeviceLogin({ clientId, deviceCode }) {
  const { ok, payload } = await postForm(`${AUTH_BASE}/token`, {
    client_id: clientId,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode,
  });
  if (ok && payload.refresh_token) {
    writeTokenStore({
      clientId,
      refreshToken: payload.refresh_token,
      savedAt: new Date().toISOString(),
    });
    return { state: 'succeeded' };
  }
  // authorization_pending / slow_down 都是「还没好」，不是失败
  if (payload.error === 'authorization_pending' || payload.error === 'slow_down') {
    return { state: 'pending', slowDown: payload.error === 'slow_down' };
  }
  return { state: 'failed', reason: payload.error_description || payload.error || '未知错误' };
}

let cachedToken = { value: '', expiresAt: 0 };

export async function getOutlookAccessToken({ force = false, retried = false } = {}) {
  const now = Date.now();
  if (!force && cachedToken.value && now < cachedToken.expiresAt) return cachedToken.value;
  let store = readTokenStore();
  // 没 token 就**自己去拿**（浏览器登录 + 自动批准设备码，一次性约 2 分钟）。
  // 一个 outlook 只能收一次邀请、每轮都要换号，如果这里只是抛错要人去跑一个
  // 单独的授权脚本，那就不是全自动。拿到之后所有读信都是 0.7 秒的纯 HTTPS。
  if (!store?.refreshToken) {
    console.log('[outlook] 该账号还没有 refresh_token，自动走一次设备码授权…');
    const { grantRefreshToken } = await import('./outlookGrant.js');
    await grantRefreshToken();
    store = readTokenStore();
  }
  if (!store?.refreshToken) throw new Error('微软邮箱授权失败，没拿到 refresh_token');
  const clientId = String(process.env.OUTLOOK_CLIENT_ID || store.clientId || '').trim();
  const { ok, status, payload, text } = await postForm(`${AUTH_BASE}/token`, {
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: store.refreshToken,
    // scope 要跟当初授权时一致。用模块级常量的话，改了 OUTLOOK_SCOPE 就必然刷新失败，
    // 然后一路掉进下面的「作废重授权」分支。
    scope: store.scope || SCOPE,
  });
  if (!ok || !payload.access_token) {
    // 🔴 只有微软**明确说这个 refresh_token 不能用了**才作废本地凭据。
    // 429 / 5xx / 网关抖动都是瞬时故障 —— 原来一律删 token 并自动重新授权，
    // 而重新授权要重开浏览器登录，很可能再撞一次「强制绑恢复邮箱」，
    // 绑上去的临时地址十分钟就死。等于**拿一次网络抖动换掉一个微软号**。
    // 审计用 503 和 429 都实跑复现过。
    const FATAL = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client', 'interaction_required', 'consent_required']);
    const transient = status === 429 || status >= 500 || !status;
    if (transient || !FATAL.has(String(payload.error || ''))) {
      throw new Error(`刷新微软令牌暂时失败（HTTP ${status} ${payload.error || 'unknown'}），本地 token 保留不动：${payload.error_description || text.slice(0, 160)}`);
    }
    // refresh token 会过期（微软上限 90 天）也会被吊销。只抛错的话，
    // 无人值守跑到那一天就整条链路停摆，而且报错看不出是「该重新授权了」。
    // 所以：作废本地 token，自动重走一次设备码授权，再试一次。只重试一次，
    // 避免授权本身有问题时无限循环。
    if (!retried) {
      console.warn(`[outlook] refresh_token 已失效（${payload.error}），作废本地 token 并重新授权一次`);
      try { unlinkSync(TOKEN_PATH); } catch { /* 本来就没有 */ }
      cachedToken = { value: '', expiresAt: 0 };
      const { grantRefreshToken } = await import('./outlookGrant.js');
      await grantRefreshToken();
      return getOutlookAccessToken({ force: true, retried: true });
    }
    throw new Error(`刷新微软令牌失败：${payload.error_description || text.slice(0, 200)}`);
  }
  // 微软每次刷新都会给一个新的 refresh token，旧的会作废。不落盘的话，
  // 下次刷新就用着已作废的令牌，表现是「跑了几天突然收不了信」。
  if (payload.refresh_token && payload.refresh_token !== store.refreshToken) {
    writeTokenStore({ ...store, clientId, refreshToken: payload.refresh_token, savedAt: new Date().toISOString() });
  }
  const ttl = (Number(payload.expires_in) || 3600) * 1000;
  // 提前 5 分钟过期，避免正好卡在边界上用一个刚死的令牌
  cachedToken = { value: payload.access_token, expiresAt: now + Math.max(ttl - 5 * 60 * 1000, 60 * 1000) };
  return cachedToken.value;
}

async function graphGet(path, { token }) {
  const response = await fetch(`${GRAPH}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Graph ${path} 失败：HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Graph ${path} 返回的不是 JSON：${text.slice(0, 120)}`);
  }
}

export async function outlookAccount() {
  const token = await getOutlookAccessToken();
  const me = await graphGet('/me?$select=displayName,mail,userPrincipalName', { token });
  return {
    address: String(me.mail || me.userPrincipalName || '').trim().toLowerCase(),
    displayName: String(me.displayName || ''),
  };
}

// Graph 给的是 HTML 正文。抽验证码要纯文本，抽链接要保留 href，所以两份都留。
export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


// 把 Graph 的一封信压成跟 cloudflareEmail 完全同构的形状。
// 字段名一个都不能改：下游 automationMatch / mailKind / 向导全按这套字段取值。
export function normalizeGraphMail(message) {
  const isHtml = String(message?.body?.contentType || '').toLowerCase() === 'html';
  const rawBody = String(message?.body?.content || '');
  const html = isHtml ? rawBody : '';
  const text = isHtml ? htmlToText(rawBody) : rawBody;
  const subject = String(message?.subject || '');
  const from = String(message?.from?.emailAddress?.address || message?.sender?.emailAddress?.address || '');
  const to = (message?.toRecipients || [])
    .map((one) => String(one?.emailAddress?.address || '').trim())
    .filter(Boolean)
    .join(', ');
  const mail = {
    id: String(message?.id || ''),
    address: to,
    subject,
    from,
    receivedAt: String(message?.receivedDateTime || ''),
    body: text.slice(0, PREVIEW_MAX),
    // 与 cloudflareEmail 同一套取值口径：码从「主题+正文」抽，链接从「HTML+正文」抽
    code: extractCode(`${subject}\n${text}`),
    links: extractLinks(`${html}\n${text}`),
  };
  const kind = classifyMail(mail);
  return { ...mail, kind, inviteUrl: kind === 'invite' ? pickInviteUrl(mail.links) : null };
}

function matchesAddress(mail, target) {
  if (!target) return true;
  const needle = target.toLowerCase();
  // 收件人可能是别名或带 +tag，所以用包含匹配
  return String(mail.address || '').toLowerCase().includes(needle);
}

/**
 * 与 cloudflareEmail.listMails 同名同形。收件箱 + 垃圾箱一起查。
 * address 为空时不过滤（单账号场景下就是这个信箱的全部来信）。
 */
export async function listMails({ address, limit = 20, offset = 0 } = {}) {
  const token = await getOutlookAccessToken();
  const top = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const select = 'id,subject,from,sender,toRecipients,receivedDateTime,body';
  const batches = await Promise.all(FOLDERS.map(async (folder) => {
    try {
      const payload = await graphGet(
        `/me/mailFolders/${folder}/messages?$top=${top}&$select=${select}&$orderby=receivedDateTime%20desc`,
        { token },
      );
      return (payload.value || []).map(normalizeGraphMail);
    } catch (error) {
      // 收件箱查不到必须抛：项目硬规则「整批查不到 = 故障，不得当作没有数据」。
      // 垃圾箱读不到只降级并留一行日志，不拖垮整次调用。
      if (folder === 'inbox') throw error;
      console.warn(`[outlook] 垃圾箱读取失败（不影响收件箱）：${error.message}`);
      return [];
    }
  }));
  const merged = batches.flat()
    .filter((mail) => matchesAddress(mail, String(address || '').trim()))
    .sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
  const start = Math.max(Number(offset) || 0, 0);
  return { mails: merged.slice(start, start + top) };
}
