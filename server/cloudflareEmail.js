// cloudflareEmail.js — 对接 cloudflare_temp_email 后台 admin 接口
import { config } from './config.js';
import { extractCode, extractLinks } from './extract.js';
import { classifyMail, pickInviteUrl } from './mailKind.js';
import { parseMail } from './mime.js';

const DEFAULT_PAGE_SIZE = 20;

function ensureMailConfig() {
  if (!config.mail.baseUrl) throw new Error('未配置 MAIL_BASE_URL');
  if (!config.mail.adminAuth) throw new Error('未配置 MAIL_ADMIN_AUTH');
}

function buildHeaders(json = false) {
  const headers = {
    Accept: 'application/json',
    'x-admin-auth': config.mail.adminAuth,
  };
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

function buildUrl(path, searchParams) {
  const url = new URL(`${config.mail.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`);
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

const REQUEST_TIMEOUT_MS = 12000;

async function requestJson(path, { method = 'GET', searchParams, body } = {}) {
  ensureMailConfig();
  // 邮箱后台挂住时不能把取号服务的连接一起拖死
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(buildUrl(path, searchParams), {
      method,
      headers: buildHeaders(Boolean(body)),
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('临时邮箱后台超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    /* 保留为纯文本 */
  }
  if (!response.ok) {
    const detail =
      parsed && typeof parsed === 'object'
        ? parsed.message || parsed.error || parsed.msg
        : text;
    throw new Error(`临时邮箱请求失败（HTTP ${response.status}）：${detail || '无详情'}`);
  }
  return parsed;
}

function randomLocalPart() {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 7);
  return `u${stamp}${rand}`.toLowerCase();
}

function firstString(values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function hasAddress(value, target) {
  const addresses = String(value || '').toLowerCase().match(/[\w.+-]+@[\w.-]+/g) || [];
  return addresses.includes(target);
}

// 买家能不能自选前缀，取决于三件事（都实测过）：
//   · 后台重名返回 400「邮箱地址已存在」——先到先得，抢不走别人的邮箱
//   · 后台强制加 tmp 前缀并剥掉 - . _，实际地址跟买家输入的不一样，必须以返回值为准
//   · 冒充站方或大厂的名字要挡掉（tmpadmin@、tmpopenai@ 之类）
const RESERVED_LOCAL = new Set([
  'admin', 'administrator', 'root', 'support', 'service', 'kefu', 'help', 'billing',
  'security', 'abuse', 'postmaster', 'webmaster', 'noreply', 'noreply2', 'system',
  'codex', 'invite', 'openai', 'apple', 'google', 'microsoft', 'paypal', 'alipay',
]);

// 返回后台真正会用的 local part（不含 tmp 前缀）；不合法就抛错；空 = 随机
export function normalizeLocalPart(name) {
  const raw = String(name || '').trim().toLowerCase();
  if (!raw) return null;
  const cleaned = raw.replace(/[^a-z0-9._-]/g, '');
  const compact = cleaned.replace(/[._-]/g, '');
  if (compact.length < 3) throw new Error('自定义前缀至少 3 个字母或数字');
  if (compact.length > 16) throw new Error('自定义前缀最多 16 个字母或数字');
  if (RESERVED_LOCAL.has(compact) || RESERVED_LOCAL.has(cleaned)) {
    throw new Error('这个前缀不能用，换一个');
  }
  return cleaned;
}

// 创建一个新邮箱地址
export async function createAddress({ name } = {}) {
  if (!config.mail.domain) {
    throw new Error('未配置 MAIL_DOMAIN（收件域名），无法生成邮箱');
  }
  const localPart = normalizeLocalPart(name) || randomLocalPart();
  const result = await requestJson('/admin/new_address', {
    method: 'POST',
    body: {
      enablePrefix: true,
      enableRandomSubdomain: false,
      name: localPart,
      domain: config.mail.domain,
    },
  });
  const address = firstString([
    result?.address,
    result?.data?.address,
    result?.mail_address,
    `${localPart}@${config.mail.domain}`,
  ]);
  if (!address) throw new Error('后台未返回可用邮箱地址');
  // addressId 是注销邮箱时唯一能用的句柄，拿不到就注销不了
  const addressId = result?.address_id ?? result?.data?.address_id ?? result?.id ?? null;
  return { address, addressId: addressId == null ? null : String(addressId) };
}

// 注销邮箱（连同后台记录一起删）。实测 DELETE /admin/delete_address/:id 返回 {success:true}
export async function deleteAddress(addressId) {
  const id = String(addressId || '').trim();
  if (!id) throw new Error('缺少邮箱 id');
  await requestJson(`/admin/delete_address/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return { ok: true };
}

function getRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['results', 'data', 'items', 'messages', 'mails', 'list']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

const PREVIEW_MAX = 600;

function normalizeMail(row) {
  // 后台只给原始 MIME（raw），需自行解析出可读正文
  const raw = firstString([row.raw, row.source, row.mime, row.message]);
  const parsed = raw ? parseMail(raw) : { subject: '', from: '', to: '', date: '', text: '', html: '' };

  const subject = firstString([row.subject, row.title, parsed.subject]);
  // from：行级字段优先，退回解析出的 From 头
  const from = firstString([parsed.from, row.from, row.sender, row.mail_from]);
  const bodyText = firstString([row.text, row.content, parsed.text]);

  // 验证码从「主题 + 正文」抽；链接从「HTML（保留 href）+ 正文」抽
  const codeSource = `${subject}\n${bodyText}`;
  const linkSource = `${parsed.html}\n${bodyText}`;

  return {
    id: firstString([row.id, row._id, row.mail_id, row.message_id]),
    address: firstString([row.address, row.mail_address, row.recipient, row.to, parsed.to]),
    subject,
    from,
    receivedAt: firstString([row.created_at, row.receivedDateTime, row.received_at, parsed.date]),
    body: bodyText.slice(0, PREVIEW_MAX),
    code: extractCode(codeSource),
    links: extractLinks(linkSource),
  };
}

// 在基础字段之上补一层「这封信是干嘛的」。
// 邀请助手全靠它决定下一步：邀请信给"打开邀请页"的按钮，验证码信把码顶出来。
// 判错的代价不是难看，是买家卡在那儿不知道该干嘛。
function withKind(mail) {
  const kind = classifyMail(mail);
  return {
    ...mail,
    kind,
    // 邀请链接单独给出来：links[0] 不一定是邀请链接（信里常有帮助中心、退订等），
    // 前端拿 links[0] 当邀请链接会把买家点到别处去
    inviteUrl: kind === 'invite' ? pickInviteUrl(mail.links) : null,
  };
}

// 拉取某个地址的邮件，并自动抽取验证码与链接
export async function listMails({ address, limit = DEFAULT_PAGE_SIZE, offset = 0 } = {}) {
  const payload = await requestJson('/admin/mails', {
    searchParams: {
      limit: Number(limit) || DEFAULT_PAGE_SIZE,
      offset: Number(offset) || 0,
      address: String(address || '').trim(),
    },
  });
  const rows = getRows(payload).map(normalizeMail).map(withKind);
  // 仅保留属于该地址的邮件（后台可能返回全量）
  const target = String(address || '').trim().toLowerCase();
  const filtered = target
    ? rows.filter((mail) => !mail.address || hasAddress(mail.address, target))
    : rows;
  return { mails: filtered };
}

export async function deleteMail(id) {
  const mailId = String(id || '').trim();
  if (!mailId) throw new Error('缺少邮件 id');
  await requestJson(`/admin/mails/${encodeURIComponent(mailId)}`, { method: 'DELETE' });
  return { ok: true };
}
