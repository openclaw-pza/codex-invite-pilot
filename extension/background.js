import {
  createProfile,
  findInvitationMail,
  findOtpMail,
  inviteUrlOf,
  inspectInviteReferral,
  isAllowedInviteUrl,
  isRecentMail,
  localApi,
} from './lib.js';

const STORAGE_KEY = 'codexInvitePilotState';
const POLL_ALARM = 'codex-invite-poll';
const POLL_MS = 3000;
const POLL_STATES = new Set(['waiting_invite', 'waiting_otp', 'waiting_sms', 'waiting_codex']);
const TERMINAL_STATES = new Set(['idle', 'succeeded', 'failed', 'cancelled']);

let state = { state: 'idle', address: '', events: [], updatedAt: new Date().toISOString() };
let timer = null;
let busy = false;

function needsPolling() {
  return POLL_STATES.has(state.state) || Boolean(state.codexSessionId && !state.codexSessionTerminal);
}

const ready = chrome.storage.local.get(STORAGE_KEY).then((stored) => {
  if (stored[STORAGE_KEY]) state = stored[STORAGE_KEY];
  // 兼容上一版的误拦截：扩展更新后自动重新检查当时那封最新邀请。
  if (state.referralIssue === 'source_ineligible') {
    delete state.referralIssue;
    state.retryFlaggedInvite = true;
    chrome.storage.local.set({ [STORAGE_KEY]: state }).catch(() => {});
  }
  if (needsPolling()) schedulePoll(250);
});

function publicState() {
  const { baselineIds, otpBaselineIds, ...safe } = state;
  return {
    ...safe,
    canContinue: state.state === 'paused' && !state.phoneRejected,
    canReplacePhone: Boolean(state.activationId && !state.smsOrderFinished
      && (state.phoneRejected || ['paused', 'waiting_sms', 'submitting_phone'].includes(state.state))),
    canConfirmApp: state.state === 'app_handoff',
    canCopyInvite: Boolean(state.inviteUrl),
    canCancel: !TERMINAL_STATES.has(state.state),
    canReset: ['succeeded', 'cancelled', 'failed'].includes(state.state),
  };
}

async function save() {
  state.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  chrome.runtime.sendMessage({ type: 'STATE_CHANGED', state: publicState() }).catch(() => {});
}

async function transition(next, message, level = 'info') {
  const previous = state.state;
  state.state = next;
  if (POLL_STATES.has(next) && previous !== next) state.pollStartedAt = Date.now();
  if (!POLL_STATES.has(next)) delete state.pollStartedAt;
  state.message = message;
  state.events = [...(state.events || []), {
    at: new Date().toISOString(),
    level,
    message,
  }].slice(-50);
  await save();
  if (needsPolling()) schedulePoll();
}

function schedulePoll(delay = POLL_MS) {
  clearTimeout(timer);
  timer = setTimeout(() => poll().catch(handleError), delay);
  chrome.alarms.create(POLL_ALARM, { delayInMinutes: Math.max(delay / 60000, 0.1) }).catch(() => {});
}

async function listMails() {
  const result = await localApi(`/api/email/mails?address=${encodeURIComponent(state.address)}&limit=100`);
  return result.mails || [];
}

async function sendToTaskTab(message) {
  if (!state.tabId) throw new Error('没有可接管的 ChatGPT 标签页');
  try {
    return await chrome.tabs.sendMessage(state.tabId, message);
  } catch {
    throw new Error('ChatGPT 页面尚未准备好，请稍后点击“继续检查”');
  }
}

async function openInvite(mail) {
  const url = inviteUrlOf(mail);
  if (!url) throw new Error('邀请邮件中没有通过安全校验的链接');
  state.inviteMailId = String(mail.id);
  state.inviteUrl = url;
  delete state.tabId;
  const eligibility = inspectInviteReferral(url);
  delete state.referralIssue;
  await transition('opening_invite', eligibility.noRewards
    ? '已提取邀请链接（标记为不带奖励）。请复制后手动打开；打开后继续自动填验证码和接码。'
    : '已提取官方邀请链接。请复制后手动打开；打开后继续自动填验证码和接码。', eligibility.noRewards ? 'warn' : 'info');
}

async function pollInvite() {
  const mails = await listMails();
  const invite = findInvitationMail(mails, state.retryFlaggedInvite ? [] : (state.baselineIds || []));
  if (invite) {
    delete state.retryFlaggedInvite;
    await openInvite(invite);
  }
}

async function tryFillEmailOtp(code) {
  if (!state.tabId) return false;
  try {
    const result = await sendToTaskTab({ type: 'FILL_EMAIL_OTP', code });
    return Boolean(result?.ok);
  } catch {
    return false;
  }
}

async function pollOtp() {
  if (state.emailOtp && !state.emailOtpFilled) {
    if (await tryFillEmailOtp(state.emailOtp)) {
      state.emailOtpFilled = true;
      await transition('submitting_otp', '已将邮箱验证码填入当前页面');
      return;
    }
  }
  const mails = await listMails();
  const otp = findOtpMail(mails, state.otpBaselineIds || []);
  if (!otp) return;
  state.otpBaselineIds = [...new Set([...(state.otpBaselineIds || []).map(String), String(otp.id)])];
  state.emailOtp = otp.code;
  state.emailOtpFilled = false;
  if (await tryFillEmailOtp(otp.code)) {
    state.emailOtpFilled = true;
    await transition('submitting_otp', '已收到最新邮箱验证码，正在当前页面填写');
    return;
  }
  await transition('waiting_otp', '已提取邮箱验证码，可先复制；打开邀请页后会自动填写');
}

async function pollSms() {
  if (!state.activationId) throw new Error('没有可查询的 HeroSMS 订单');
  const result = await localApi(`/api/sms/status?id=${encodeURIComponent(state.activationId)}`);
  if (result.state === 'cancel') {
    await transition('paused', 'HeroSMS 订单已取消，请人工检查', 'warn');
    return;
  }
  if (result.state !== 'code' || !result.code) return;
  state.smsCode = result.code;
  await transition('submitting_sms', '已收到手机验证码，正在当前页面填写');
  const filled = await sendToTaskTab({ type: 'FILL_SMS', code: result.code });
  if (!filled?.ok) throw new Error(filled?.error || '手机验证码填写失败');
  await localApi('/api/sms/finish', { method: 'POST', body: { id: state.activationId } }).catch(() => {});
  state.smsOrderFinished = true;
  await transition('finishing_login', '手机验证已提交，正在等待官方 Codex 完成认证');
}

async function pollCodex() {
  if (!state.codexSessionId || state.codexSessionTerminal) return false;
  const result = await localApi(`/api/codex/device/status?id=${encodeURIComponent(state.codexSessionId)}`);
  if (!result) throw new Error('本地服务找不到 Codex OAuth 会话');
  if (result.state === 'succeeded') {
    state.codexSessionTerminal = true;
    await transition('succeeded', '官方 Codex ChatGPT OAuth 已完成，隔离登录档案已保存', 'ok');
    return true;
  }
  if (['failed', 'cancelled'].includes(result.state)) {
    state.codexSessionTerminal = true;
    await transition('paused', result.message || '官方 Codex OAuth 未完成', 'err');
    return true;
  }
  return false;
}

async function poll() {
  await ready;
  if (busy || !needsPolling()) return;
  busy = true;
  try {
    if (await pollCodex()) return;
    const elapsed = Date.now() - Number(state.pollStartedAt || Date.now());
    const limit = state.state === 'waiting_invite'
      ? 10 * 60 * 1000
      : state.state === 'waiting_codex' ? 15 * 60 * 1000 : 5 * 60 * 1000;
    if (elapsed > limit) {
      await transition('paused', state.state === 'waiting_invite'
        ? '等待邀请超过 10 分钟，请确认重新发送后继续'
        : '等待验证码超过 5 分钟，请人工检查后继续', 'warn');
      return;
    }
    if (state.state === 'waiting_invite') await pollInvite();
    else if (state.state === 'waiting_otp') await pollOtp();
    else if (state.state === 'waiting_sms') await pollSms();
  } finally {
    busy = false;
    if (needsPolling()) schedulePoll();
  }
}

async function handleError(error) {
  await transition('paused', error?.message || '扩展流程暂停', 'err');
}

async function startFlow(address) {
  const normalized = String(address || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error('请先创建或选择合法邮箱');
  const now = new Date().toISOString();
  const mails = (await localApi(`/api/email/mails?address=${encodeURIComponent(normalized)}&limit=100`)).mails || [];
  const recent = findInvitationMail(mails, []);
  const accepted = recent && isRecentMail(recent, now) ? recent : null;
  state = {
    state: 'waiting_invite',
    address: normalized,
    createdAt: now,
    updatedAt: now,
    baselineIds: mails.map((mail) => String(mail.id)).filter((id) => id !== String(accepted?.id || '')),
    otpBaselineIds: [],
    events: [],
  };
  await transition('waiting_invite', accepted
    ? '检测到刚刚到达的官方邀请，正在提取链接'
    : '正在等待新的官方邀请邮件');
  if (accepted) await openInvite(accepted);
  return publicState();
}

async function captureOtpBaseline() {
  if (!state.address) throw new Error('任务没有邮箱地址');
  const mails = await listMails();
  state.otpBaselineIds = mails.map((mail) => String(mail.id));
  await transition('waiting_otp', '邮箱已提交，正在等待新的官方六位验证码');
  return { address: state.address };
}

async function requestPhone() {
  if (!state.activationId || state.smsOrderFinished) {
    await transition('requesting_phone', 'Codex 要求手机验证，正在按管理员设置从 HeroSMS 获取号码');
    const number = await localApi('/api/sms/number', { method: 'POST', body: {} });
    state.activationId = number.activationId;
    state.phone = String(number.phone || '').replace(/^\+/, '');
    state.phoneDialCode = String(number.dialCode || '');
    state.phoneNationalNumber = String(number.nationalNumber || '');
    state.phoneIsoCountry = String(number.isoCountry || '');
    state.phoneCountry = number.country;
    state.phonePrice = number.price;
    state.smsOrderFinished = false;
    state.phoneRejected = false;
  }
  const dialCode = state.phoneDialCode || (String(state.phone || '').startsWith('66') ? '66' : '');
  await transition('submitting_phone', `已取得号码 +${state.phone}，正在当前页面填写`);
  const result = await sendToTaskTab({
    type: 'FILL_PHONE',
    phone: state.phone,
    dialCode,
    nationalNumber: state.phoneNationalNumber,
    isoCountry: state.phoneIsoCountry,
  });
  if (!result?.ok) throw new Error(result?.error || '手机号填写失败');
}

async function startOfficialCodexAuth() {
  if (state.codexSessionId && !state.codexSessionTerminal) {
    const existing = await localApi(`/api/codex/device/status?id=${encodeURIComponent(state.codexSessionId)}`);
    if (existing?.authUrl) {
      if (!isAllowedInviteUrl(existing.authUrl)) throw new Error('Codex OAuth 登录链接未通过域名安全校验');
      delete state.deviceUserCode;
      await transition('waiting_codex', '正在打开官方 Codex ChatGPT 登录页面');
      const tab = await chrome.tabs.create({ url: existing.authUrl, active: true });
      state.tabId = tab.id;
      await save();
      return;
    }
  }
  delete state.deviceAuthRetryPending;
  delete state.deviceUserCode;
  await transition('starting_codex', '正在向官方 Codex 申请本轮 ChatGPT OAuth 登录链接');
  const result = await localApi('/api/codex/device/start', {
    method: 'POST',
    body: { address: state.address },
  });
  if (!result.authUrl || !isAllowedInviteUrl(result.authUrl)) throw new Error('官方 Codex OAuth 登录链接未通过安全校验');
  state.codexSessionId = result.id;
  state.codexSessionTerminal = false;
  await transition('waiting_codex', '已生成官方 Codex 登录链接，正在选择本轮受邀邮箱');
  const tab = await chrome.tabs.create({ url: result.authUrl, active: true });
  state.tabId = tab.id;
  await save();
}

async function discardCurrentCodexAuth() {
  if (state.codexSessionId) {
    await localApi('/api/codex/device/cancel', {
      method: 'POST',
      body: { id: state.codexSessionId },
    }).catch(() => {});
  }
  delete state.codexSessionId;
  delete state.deviceUserCode;
  state.codexSessionTerminal = true;
}

async function handlePageEvent(message, sender) {
  if (sender.tab?.id) {
    state.tabId = sender.tab.id;
    await save();
  }
  switch (message.event) {
    case 'LEGACY_DEVICE_AUTH':
      if (!state.codexSessionId || !['starting_codex', 'waiting_codex', 'paused'].includes(state.state)) return { allowed: false };
      await transition('starting_codex', '检测到旧设备码登录，正在切换为正确的 Codex ChatGPT OAuth', 'warn');
      await discardCurrentCodexAuth();
      await startOfficialCodexAuth();
      return { allowed: true };
    case 'SESSION_EXPIRED':
      await transition(state.state, '当前 ChatGPT 会话已过期，正在重新登录并继续本轮流程', 'warn');
      return { ok: true };
    case 'NEED_ACCOUNT_SELECTION':
      if (!state.address) throw new Error('当前任务没有可匹配的邮箱地址');
      await transition(state.state, '检测到账号选择页，正在选择与本轮邮箱一致的账号');
      return { address: state.address };
    case 'BEFORE_EMAIL_SUBMIT':
      return captureOtpBaseline();
    case 'NEED_EMAIL_OTP':
      if (state.state !== 'waiting_otp') await captureOtpBaseline();
      return { ok: true };
    case 'NEED_PHONE':
      await requestPhone();
      return { ok: true };
    case 'NEED_SMS':
      state.phoneRejected = false;
      await transition('waiting_sms', `手机号 +${state.phone} 已提交，正在等待短信验证码`);
      return { ok: true };
    case 'PHONE_REJECTED':
      state.phoneRejected = true;
      await transition('paused', `当前号码 +${state.phone} 被页面拒绝；可先在管理员界面调整报价，再点击“更换号码”`, 'warn');
      return { ok: true };
    case 'NEED_PROFILE':
      if (!state.profileName || !state.profileAge) {
        const profile = createProfile();
        state.profileName = profile.name;
        state.profileAge = profile.age;
      }
      await transition('submitting_profile', `正在填写账号资料：${state.profileName}，${state.profileAge} 岁`);
      return { name: state.profileName, age: state.profileAge };
    case 'PROFILE_SUBMITTED':
      await transition('finishing_login', '账号资料已提交，正在确认 Codex 登录结果');
      return { ok: true };
    case 'APP_HANDOFF':
      if (state.codexSessionId && !state.codexSessionTerminal) return { ok: true };
      await startOfficialCodexAuth();
      return { ok: true };
    case 'CAPTCHA':
      state.resumeState = state.state;
      await transition('paused', '检测到 CAPTCHA，请在当前 Chrome 页面完成人机验证后继续', 'warn');
      return { ok: true };
    case 'INVALID_INVITE': {
      state.baselineIds = [...new Set([...(state.baselineIds || []).map(String), String(state.inviteMailId || '')])].filter(Boolean);
      delete state.inviteMailId;
      await transition('waiting_invite', '当前邀请被 OpenAI 判定为无效或过期；请重新发送同一邮箱的邀请', 'warn');
      return { ok: true };
    }
    case 'UNKNOWN':
      state.resumeState = state.state;
      await transition('paused', message.reason || '页面无法安全识别，请人工处理后继续', 'warn');
      return { ok: true };
    case 'SUCCEEDED':
      if (state.activationId && !state.smsOrderFinished) {
        await localApi('/api/sms/finish', { method: 'POST', body: { id: state.activationId } }).catch(() => {});
        state.smsOrderFinished = true;
      }
      await transition('succeeded', 'Codex 已在当前 Chrome 中成功登录', 'ok');
      return { ok: true };
    default:
      return { ok: false };
  }
}

async function continueFlow() {
  if (state.state !== 'paused') throw new Error('当前流程不需要继续');
  const next = state.resumeState || 'opening_invite';
  delete state.resumeState;
  await transition(next, '正在重新检查当前 Chrome 页面');
  await sendToTaskTab({ type: 'RESUME_SCAN' });
  if (POLL_STATES.has(next)) schedulePoll(100);
  return publicState();
}

async function replacePhone() {
  if (!state.activationId || state.smsOrderFinished) throw new Error('当前没有可更换的 HeroSMS 号码');
  await transition('replacing_phone', `正在取消当前号码 +${state.phone}，准备按管理员报价重新取号`, 'warn');
  await localApi('/api/sms/cancel', { method: 'POST', body: { id: state.activationId } });
  delete state.activationId;
  delete state.phone;
  delete state.phonePrice;
  delete state.phoneDialCode;
  delete state.phoneNationalNumber;
  delete state.phoneIsoCountry;
  delete state.phoneCountry;
  delete state.phoneRejected;
  state.smsOrderFinished = false;
  await requestPhone();
  return publicState();
}

async function cancelFlow() {
  clearTimeout(timer);
  if (state.activationId && !state.smsOrderFinished) {
    await localApi('/api/sms/cancel', { method: 'POST', body: { id: state.activationId } }).catch(() => {});
  }
  if (state.codexSessionId && !state.codexSessionTerminal) {
    await localApi('/api/codex/device/cancel', { method: 'POST', body: { id: state.codexSessionId } }).catch(() => {});
    state.codexSessionTerminal = true;
  }
  await transition('cancelled', '本轮流程已停止');
  return publicState();
}

async function resetFlow() {
  if (state.activationId && !state.smsOrderFinished) {
    await localApi('/api/sms/cancel', { method: 'POST', body: { id: state.activationId } }).catch(() => {});
  }
  if (state.codexSessionId && !state.codexSessionTerminal) {
    await localApi('/api/codex/device/cancel', { method: 'POST', body: { id: state.codexSessionId } }).catch(() => {});
  }
  state = { state: 'idle', address: state.address || '', events: [], updatedAt: new Date().toISOString() };
  await save();
  return publicState();
}

async function confirmAppOpened() {
  if (state.state !== 'app_handoff') throw new Error('当前不在 Codex 应用交接步骤');
  await transition('succeeded', 'Codex 已打开，本轮流程完成', 'ok');
  return publicState();
}

async function setAddress(address) {
  const normalized = String(address || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error('请输入合法邮箱地址');
  if (!TERMINAL_STATES.has(state.state)) throw new Error('当前流程运行中，不能切换邮箱');
  state = { state: 'idle', address: normalized, events: [], updatedAt: new Date().toISOString() };
  await save();
  return publicState();
}

function isTaskPage(url) {
  try {
    const host = new URL(String(url || '')).hostname.toLowerCase();
    return host === 'chatgpt.com' || host.endsWith('.chatgpt.com')
      || host === 'openai.com' || host.endsWith('.openai.com');
  } catch {
    return false;
  }
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  const url = info.url || tab.url || '';
  if (!url || !isTaskPage(url) || !state.inviteUrl) return;
  if (TERMINAL_STATES.has(state.state) || state.state === 'idle') return;
  if (state.tabId === tabId) return;
  state.tabId = tabId;
  save().catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) poll().catch(handleError);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'STATE_CHANGED') return false;
  (async () => {
    await ready;
    if (message?.type === 'GET_STATE') return publicState();
    if (message?.type === 'SET_ADDRESS') return setAddress(message.address);
    if (message?.type === 'START_FLOW') return startFlow(message.address);
    if (message?.type === 'CONTINUE_FLOW') return continueFlow();
    if (message?.type === 'REPLACE_PHONE') return replacePhone();
    if (message?.type === 'CANCEL_FLOW') return cancelFlow();
    if (message?.type === 'RESET_FLOW') return resetFlow();
    if (message?.type === 'CONFIRM_APP_OPENED') return confirmAppOpened();
    if (message?.type === 'PAGE_EVENT') return handlePageEvent(message, sender);
    throw new Error('未知扩展消息');
  })().then((data) => sendResponse({ ok: true, data })).catch((error) => {
    handleError(error).catch(() => {});
    sendResponse({ ok: false, error: error?.message || '扩展操作失败' });
  });
  return true;
});
