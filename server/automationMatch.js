// automationMatch.js — 纯匹配逻辑，避免把无关邮件或不可信链接交给浏览器
import { createHash } from 'node:crypto';
import { INVITE_SENDERS as INVITE_SENDER_LIST, OTP_SENDERS as OTP_SENDER_LIST } from './mailKind.js';

const INVITE_SENDERS = new Set(INVITE_SENDER_LIST);
const OTP_SENDERS = new Set(OTP_SENDER_LIST);
const INVITE_HINT = /(?:invited|invitation|accept\s+invite|邀请|邀請|诚邀|受邀|受邀請|加入.*(?:chatgpt|workspace))/i;
const PRESTART_INVITE_GRACE_MS = 10 * 60 * 1000;

export function normalizeSender(value = '') {
  const text = String(value).trim().toLowerCase();
  return text.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1] || text.match(/[\w.+-]+@[\w.-]+/)?.[0] || '';
}

export function addressMatches(value = '', target = '') {
  const expected = String(target).trim().toLowerCase();
  const addresses = String(value).toLowerCase().match(/[\w.+-]+@[\w.-]+/g) || [];
  return Boolean(expected) && addresses.includes(expected);
}

export function isAllowedInviteUrl(value = '') {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'openai.com' || host.endsWith('.openai.com');
  } catch {
    return false;
  }
}

export function profileKey(address = '') {
  return createHash('sha256').update(String(address).trim().toLowerCase()).digest('hex').slice(0, 20);
}

export function isRecentInviteMail(mail, referenceTime = new Date().toISOString()) {
  const raw = String(mail?.receivedAt || '').trim();
  if (!raw) return false;
  // Cloudflare/D1 常返回不带时区的 UTC 时间（YYYY-MM-DD HH:mm:ss）。
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const receivedAt = Date.parse(normalized);
  const reference = Date.parse(referenceTime);
  if (!Number.isFinite(receivedAt) || !Number.isFinite(reference)) return false;
  return receivedAt >= reference - PRESTART_INVITE_GRACE_MS && receivedAt <= reference + 2 * 60 * 1000;
}

export function findInvitationMail(mails = [], excludedIds = []) {
  const excluded = new Set(excludedIds.map(String));
  return mails.find((mail) => {
    if (!mail?.id || excluded.has(String(mail.id))) return false;
    if (!INVITE_SENDERS.has(normalizeSender(mail.from))) return false;
    if (!INVITE_HINT.test(`${mail.subject || ''}\n${mail.body || ''}`)) return false;
    return Boolean(inviteUrlOf(mail));
  }) || null;
}

export function inviteUrlOf(mail) {
  const allowed = (mail?.links || []).filter(isAllowedInviteUrl);
  const preferred = allowed.find((value) => /(?:invite|invitation|join|workspace|accept|auth|login|token)/i.test(value));
  if (preferred) return preferred;
  return allowed.length === 1 ? allowed[0] : '';
}

function decodeBase64UrlJson(value = '') {
  try {
    return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// 仅暴露资格判断结果，不把令牌、受邀邮箱或 referral_id 写进任务日志。
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

export function findOtpMail(mails = [], excludedIds = []) {
  const excluded = new Set(excludedIds.map(String));
  return mails.find((mail) =>
    mail?.id &&
    !excluded.has(String(mail.id)) &&
    OTP_SENDERS.has(normalizeSender(mail.from)) &&
    /^\d{6}$/.test(String(mail.code || '')),
  ) || null;
}
