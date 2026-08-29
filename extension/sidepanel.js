import { localApi } from './lib.js';

const $ = (id) => document.getElementById(id);
let current = { state: 'idle', address: '', events: [] };
let copyFeedbackTimer;

const STATE_STEP = {
  idle: 1,
  waiting_invite: 3,
  opening_invite: 3,
  waiting_otp: 4,
  submitting_otp: 4,
  submitting_profile: 4,
  requesting_phone: 5,
  replacing_phone: 5,
  submitting_phone: 5,
  waiting_sms: 5,
  submitting_sms: 5,
  finishing_login: 6,
  app_handoff: 6,
  starting_codex: 6,
  waiting_codex: 6,
  succeeded: 6,
};

async function extensionMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || '扩展操作失败');
  return response.data;
}

function render(state) {
  current = state || current;
  const step = current.address && current.state === 'idle' ? 2 : (STATE_STEP[current.state] || STATE_STEP[current.resumeState] || 3);
  const stopped = ['paused', 'failed', 'cancelled'].includes(current.state);
  const succeeded = current.state === 'succeeded';
  document.querySelectorAll('.step').forEach((element) => {
    const n = Number(element.dataset.step);
    element.className = `step ${succeeded || n < step ? 'completed' : n === step ? (stopped ? 'attention' : 'active') : ''}`;
    element.querySelector('small').textContent = succeeded || n < step ? '完成' : n === step ? (stopped ? '需处理' : '进行中') : '等待';
  });
  $('progress').textContent = `${succeeded ? 6 : Math.max(0, step - 1)} / 6`;
  $('stateLabel').textContent = ({ idle: '准备中', paused: '等待人工', opening_invite: '请手动打开', succeeded: '登录成功', cancelled: '已停止' })[current.state] || '自动执行中';
  $('message').textContent = current.message || (current.address ? '发送邀请后开始流程。' : '先创建一个邮箱。');
  $('address').textContent = current.address || '—';
  $('addressBox').hidden = !current.address;
  $('inviteUrl').textContent = current.inviteUrl || '—';
  $('inviteBox').hidden = !current.inviteUrl;
  $('emailOtp').textContent = current.emailOtp || '—';
  $('otpBox').hidden = !current.emailOtp;
  $('startFlow').disabled = !current.address || !['idle', 'cancelled', 'failed', 'succeeded'].includes(current.state);
  $('createMail').disabled = !['idle', 'cancelled', 'failed', 'succeeded'].includes(current.state);
  $('useMail').disabled = $('createMail').disabled;
  $('continueFlow').hidden = !current.canContinue;
  $('replacePhone').hidden = !current.canReplacePhone;
  $('confirmApp').hidden = !current.canConfirmApp;
  $('cancelFlow').hidden = !current.canCancel;
  $('resetFlow').hidden = !current.canReset;
  $('smsMeta').textContent = [
    current.phone ? `本轮号码 +${current.phone}${current.phonePrice == null ? '' : ` · $${current.phonePrice}`}` : '',
    current.smsCode ? `短信验证码 ${current.smsCode}` : '',
  ].filter(Boolean).join(' · ');
  $('logList').innerHTML = '';
  [...(current.events || [])].reverse().forEach((event) => {
    const li = document.createElement('li');
    li.className = event.level === 'err' ? 'err' : event.level === 'ok' ? 'ok' : '';
    const time = document.createElement('span');
    time.textContent = new Date(event.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const text = document.createElement('span');
    text.textContent = event.message;
    li.append(time, text);
    $('logList').append(li);
  });
}

function showError(error) {
  $('message').textContent = error?.message || '操作失败';
}

async function copyText(button, value, emptyError) {
  clearTimeout(copyFeedbackTimer);
  try {
    if (!value) throw new Error(emptyError);
    await navigator.clipboard.writeText(value);
    button.textContent = '已复制 ✓';
    button.classList.add('copied');
    button.classList.remove('copy-failed');
  } catch (error) {
    button.textContent = '复制失败';
    button.classList.add('copy-failed');
    button.classList.remove('copied');
    showError(error);
  }
  copyFeedbackTimer = setTimeout(() => {
    button.textContent = '复制';
    button.classList.remove('copied', 'copy-failed');
  }, 1800);
}

async function createMail() {
  try {
    const result = await localApi('/api/email/create', { method: 'POST', body: { name: $('mailName').value.trim() } });
    render(await extensionMessage({ type: 'SET_ADDRESS', address: result.address }));
  } catch (error) { showError(error); }
}

function useMail() {
  const address = $('existingMail').value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return showError(new Error('请输入合法邮箱地址'));
  extensionMessage({ type: 'SET_ADDRESS', address }).then(render).catch(showError);
}

$('createMail').onclick = createMail;
$('useMail').onclick = useMail;
$('copyMail').onclick = () => copyText($('copyMail'), current.address, '当前没有可复制的邮箱');
$('copyInvite').onclick = () => copyText($('copyInvite'), current.inviteUrl, '还没有提取到邀请链接');
$('copyOtp').onclick = () => copyText($('copyOtp'), current.emailOtp, '还没有提取到邮箱验证码');
$('startFlow').onclick = () => extensionMessage({ type: 'START_FLOW', address: current.address }).then(render).catch(showError);
$('continueFlow').onclick = () => extensionMessage({ type: 'CONTINUE_FLOW' }).then(render).catch(showError);
$('replacePhone').onclick = () => extensionMessage({ type: 'REPLACE_PHONE' }).then(render).catch(showError);
$('confirmApp').onclick = () => extensionMessage({ type: 'CONFIRM_APP_OPENED' }).then(render).catch(showError);
$('cancelFlow').onclick = () => extensionMessage({ type: 'CANCEL_FLOW' }).then(render).catch(showError);
$('resetFlow').onclick = () => extensionMessage({ type: 'RESET_FLOW' }).then(render).catch(showError);
$('openAdmin').onclick = () => chrome.tabs.create({ url: 'http://127.0.0.1:8787/admin.html' });

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'STATE_CHANGED') render(message.state);
});

extensionMessage({ type: 'GET_STATE' }).then(render).catch(showError);
localApi('/api/sms/balance').then((result) => {
  if (!current.phone) $('smsMeta').textContent = result.balance == null ? result.raw : `HeroSMS 余额 $${result.balance}`;
}).catch(() => {});
