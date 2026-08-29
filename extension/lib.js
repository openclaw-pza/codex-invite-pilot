export const API_BASE = 'http://127.0.0.1:8787';

// Chrome 扩展不能 import server/mailKind.js。名单必须与 mailKind.js 导出的
// INVITE_SENDERS / OTP_SENDERS 保持一致，由 test/extension-lib.test.js 对照守着。
const INVITE_SENDERS = new Set(['noreply@codex.chatgpt.com']);
const OTP_SENDERS = new Set([
  'noreply@tm.openai.com',
  'otp@tm1.openai.com',
  'noreply@email.openai.com',
]);
const INVITE_HINT = /(?:invited|invitation|accept\s+invite|邀请|邀請|诚邀|受邀|受邀請|加入.*(?:chatgpt|workspace))/i;

export function normalizeSender(value = '') {
  const text = String(value).trim().toLowerCase();
  return text.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1] || text.match(/[\w.+-]+@[\w.-]+/)?.[0] || '';
}

export function isAllowedInviteUrl(value = '') {
  try {
    const url = new URL(String(value));
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:'
      && (host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'openai.com' || host.endsWith('.openai.com'));
  } catch {
    return false;
  }
}

export function inviteUrlOf(mail) {
  const allowed = (mail?.links || []).filter(isAllowedInviteUrl);
  return allowed.find((value) => /(?:invite|invitation|join|workspace|accept|auth|login|token|referral)/i.test(value))
    || (allowed.length === 1 ? allowed[0] : '');
}

function decodeBase64UrlJson(value = '') {
  try {
    const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

// 只返回可公开的资格状态，绝不返回 referral_context、邮箱或 referral_id。
export function inspectInviteReferral(value = '') {
  try {
    const url = new URL(String(value));
    const context = url.searchParams.get('referral_context');
    if (!context) return { hasContext: false, referralType: '', hasRewards: null, noRewards: false };
    const payload = decodeBase64UrlJson(context);
    if (!payload) return { hasContext: true, referralType: '', hasRewards: null, noRewards: false };
    const referralType = String(payload.referral_type || '');
    const hasRewards = typeof payload.has_rewards === 'boolean' ? payload.has_rewards : null;
    return {
      hasContext: true,
      referralType,
      hasRewards,
      noRewards: referralType === 'codex_referral_consumer' && hasRewards === false,
    };
  } catch {
    return { hasContext: false, referralType: '', hasRewards: null, noRewards: false };
  }
}

export function findInvitationMail(mails = [], excludedIds = []) {
  const excluded = new Set(excludedIds.map(String));
  return mails.find((mail) => mail?.id
    && !excluded.has(String(mail.id))
    && INVITE_SENDERS.has(normalizeSender(mail.from))
    && INVITE_HINT.test(`${mail.subject || ''}\n${mail.body || ''}`)
    && inviteUrlOf(mail)) || null;
}

export function findOtpMail(mails = [], excludedIds = []) {
  const excluded = new Set(excludedIds.map(String));
  return mails.find((mail) => mail?.id
    && !excluded.has(String(mail.id))
    && OTP_SENDERS.has(normalizeSender(mail.from))
    && /^\d{6}$/.test(String(mail.code || ''))) || null;
}

export function isRecentMail(mail, referenceTime = new Date().toISOString(), graceMs = 10 * 60 * 1000) {
  const raw = String(mail?.receivedAt || '').trim();
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const received = Date.parse(normalized);
  const reference = Date.parse(referenceTime);
  return Number.isFinite(received)
    && Number.isFinite(reference)
    && received >= reference - graceMs
    && received <= reference + 2 * 60 * 1000;
}

export async function localApi(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `本地服务请求失败 (${response.status})`);
  return payload.data;
}

const PROFILE_FIRST_NAMES = ['Alex', 'Jamie', 'Taylor', 'Jordan', 'Casey', 'Morgan', 'Riley', 'Avery'];
const PROFILE_LAST_NAMES = ['Chen', 'Lin', 'Lee', 'Wang', 'Yang', 'Zhou', 'Wu', 'Xu'];

export function createProfile(random = Math.random) {
  const first = PROFILE_FIRST_NAMES[Math.floor(random() * PROFILE_FIRST_NAMES.length) % PROFILE_FIRST_NAMES.length];
  const last = PROFILE_LAST_NAMES[Math.floor(random() * PROFILE_LAST_NAMES.length) % PROFILE_LAST_NAMES.length];
  return {
    name: `${first} ${last}`,
    age: 21 + (Math.floor(random() * 12) % 12),
  };
}
