// automation.js — 单任务邀请/OTP 自动化状态机与本地持久化
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
// patchright 是 playwright 的 drop-in 替换，专门修掉两个会被反爬识别的泄漏：
//   · Runtime.enable CDP 命令 —— Cloudflare / DataDome 都在检测它，
//     被识破后它们会对页面里的 XHR 回一页 HTML 挑战，而 OpenAI 的前端是
//     Remix、期望 JSON，于是当场变成 `Route Error (400 Invalid content type: text/html)`
//     —— 正是 2026-08-23 卡了我们五轮的那个报错
//   · HeadlessChrome 标记
// 装不上或没装时自动退回 playwright，别让一个可选依赖把整条链路弄死。
let chromium;
try {
  ({ chromium } = await import('patchright'));
  console.log('[automation] 使用 patchright（已修 Runtime.enable 泄漏）');
} catch {
  ({ chromium } = await import('playwright'));
  console.warn('[automation] patchright 不可用，退回 playwright（反爬识别风险更高）');
}
// 邮箱来源走 mailProvider：cloudflare（一次性域）/ outlook（真实微软邮箱）二选一，
// 由 MAIL_PROVIDER 切换，其余链路代码完全一致 —— 对照实验的前提。
import { listMails, mailProviderName } from './mailProvider.js';
import {
  addressMatches,
  findInvitationMail,
  findOtpMail,
  inspectInviteReferral,
  inviteUrlOf,
  isRecentInviteMail,
  profileKey,
} from './automationMatch.js';
import {
  CODEX_APP_URL,
  detectCodexHandoff,
  detectPhoneStage,
  detectProfileStage,
  driveToOtp,
  fillOtpAndSubmit,
  fillProfileAndSubmit,
  fillSmsCodeAndSubmit,
  makeProfile,
  pageIsLoggedIn,
  dismissCodexOnboarding,
  sendCodexMessage,
  submitPhoneNumber,
  waitForLoginResult,
} from './automationBrowser.js';
import { cancelNumber, finishNumber, getStatus as getSmsStatus, requestNumber } from './heroSms.js';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT_DIR, 'data', 'automation');
const PROFILE_DIR = join(DATA_DIR, 'profiles');
const DUMP_DIR = join(DATA_DIR, 'dumps');
const STORE_PATH = join(DATA_DIR, 'tasks.json');
const POLL_MS = 5000;
const INVITE_TIMEOUT_MS = 10 * 60 * 1000;
const OTP_TIMEOUT_MS = 5 * 60 * 1000;
const SMS_TIMEOUT_MS = 5 * 60 * 1000;
const ACTIVE_STATES = new Set([
  'waiting_invite', 'opening_invite', 'waiting_otp', 'submitting_otp', 'submitting_profile', 'opening_codex', 'sending_codex_turn',
  'requesting_phone', 'submitting_phone', 'waiting_sms', 'submitting_sms', 'finishing_login',
]);
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled']);

mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
mkdirSync(DUMP_DIR, { recursive: true, mode: 0o700 });

function loadTasks() {
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
    return Array.isArray(parsed.tasks) ? parsed.tasks : [];
  } catch {
    return [];
  }
}

const tasks = loadTasks();
const contexts = new Map();
const runners = new Map();
let startPending = false;

function persist() {
  const safeTasks = tasks.slice(-50).map(({ baselineIds, otpBaselineIds, ...task }) => ({
    ...task,
    baselineIds: Array.isArray(baselineIds) ? baselineIds : [],
    otpBaselineIds: Array.isArray(otpBaselineIds) ? otpBaselineIds : [],
  }));
  const temp = `${STORE_PATH}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ tasks: safeTasks }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, STORE_PATH);
}

for (const task of tasks) {
  if (ACTIVE_STATES.has(task.state)) {
    task.state = 'interrupted';
    task.message = '服务曾重启，点击“继续检查”恢复任务';
    task.updatedAt = new Date().toISOString();
  }
}
if (tasks.length) persist();

function addEvent(task, message, level = 'info') {
  task.events = [...(task.events || []), { at: new Date().toISOString(), level, message }].slice(-50);
  task.message = message;
  task.updatedAt = new Date().toISOString();
  persist();
}

function setState(task, state, message, level = 'info') {
  task.state = state;
  if (ACTIVE_STATES.has(state)) task.lastActiveState = state;
  addEvent(task, message, level);
}

function publicTask(task) {
  if (!task) return null;
  const { baselineIds, otpBaselineIds, inviteMailId, ...safe } = task;
  return {
    ...safe,
    canContinue: ['paused', 'interrupted'].includes(task.state),
    canCancel: !TERMINAL_STATES.has(task.state),
    canRestart: ['failed', 'cancelled'].includes(task.state),
    canOpenProfile: Boolean(task.profileKey),
  };
}

function taskById(id) {
  const task = tasks.find((item) => item.id === String(id || ''));
  if (!task) throw new Error('自动化任务不存在');
  return task;
}

function assertAddress(value) {
  const address = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error('请输入合法邮箱地址');
  return address;
}

function isCancelled(task) {
  return task.state === 'cancelled';
}

async function sleep(task, ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return !isCancelled(task);
}

async function mailsFor(task) {
  const mails = (await listMails({ address: task.address, limit: 100 })).mails;
  return mails.filter((mail) => addressMatches(mail.address, task.address));
}

async function ensureBrowser(task, url = 'https://chatgpt.com/') {
  const existing = contexts.get(task.profileKey);
  if (existing) {
    const pages = existing.context.pages();
    const page = pages.at(-1) || await existing.context.newPage();
    await page.bringToFront();
    if (url && page.url() !== url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return { context: existing.context, page };
  }

  // headless 过不了 Cloudflare 的 managed challenge（实测 60 秒仍卡在 Just a moment），
  // headful + Xvfb 则首响应就 200、连挑战都不发。所以这里必须是 false，
  // Linux 上靠 xvfb-run 提供显示。改成 true 等于整条链路直接死。
  const launchOptions = {
    headless: false,
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
    // 跟手动跑通的那条完全一致，一个字都不差：差别只要还剩一个，
    // 「为什么手动行自动化不行」就还得再查一轮。
    args: ['--disable-blink-features=AutomationControlled'],
  };
  // 出口代理走环境变量，不写死：
  // 机房 IP 能过首屏挑战，但**能不能过注册环节没验过**——切住宅出口是随时可能要做的事，
  // 为这个改代码、重新部署一轮太慢。
  const proxy = process.env.AUTOMATION_PROXY_SERVER ? {
    server: process.env.AUTOMATION_PROXY_SERVER,
    username: process.env.AUTOMATION_PROXY_USER || undefined,
    password: process.env.AUTOMATION_PROXY_PASS || undefined,
  } : null;
  // 用普通 context 而不是 launchPersistentContext。
  //
  // 2026-08-24 A/B 实测：同一个邮箱、同一封邀请、同一台机器、前后差几分钟——
  //   · launchPersistentContext（磁盘档案）→ 填完验证码点继续，1 秒后就是
  //     `Route Error (400 Invalid content type: text/html)`，连续五轮无一例外
  //   · launch() + newContext()（内存上下文）→ 一次就通，直接落到 /about-you 资料页
  // 输入框、填法、点击、IP、邮箱全部对照过，只剩这一个变量。
  //
  // 持久化本来只买到一件事：进程重启后还能接上原来的登录态。
  // 但整轮任务本来就跑在一个进程里，重启的场景由 tasks.json 的 interrupted 恢复覆盖，
  // 拿「跑不通」换「重启能接上」是亏的。
  const { headless, args, ...contextOptions } = launchOptions;
  const browser = await chromium.launch({ headless, args, ...(proxy ? { proxy } : {}) });
  const context = await browser.newContext(contextOptions);
  // browser 要跟着 context 一起收，否则每轮任务留一个孤儿 Chromium 进程，
  // DMIT-2 只有 2G 内存，几轮就把机器吃满。
  context.on('close', () => { browser.close().catch(() => {}); });
  context.on('close', () => contexts.delete(task.profileKey));
  const page = context.pages()[0] || await context.newPage();
  contexts.set(task.profileKey, { context });
  if (url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  return { context, page };
}

async function waitForInvite(task, { includeKnownInvite = false } = {}) {
  const deadline = Date.now() + INVITE_TIMEOUT_MS;
  while (Date.now() < deadline && !isCancelled(task)) {
    const mails = await mailsFor(task);
    let invite = null;
    if (includeKnownInvite && task.inviteMailId) {
      invite = mails.find((mail) => String(mail.id) === String(task.inviteMailId)) || null;
    }
    invite ||= findInvitationMail(mails, task.baselineIds);
    if (invite) return invite;
    await sleep(task, POLL_MS);
  }
  if (!isCancelled(task)) setState(task, 'paused', '等待邀请邮件超过 10 分钟，请确认邀请已发送后继续', 'warn');
  return null;
}

async function finishSmsOrder(task) {
  if (!task.activationId || task.smsOrderFinished) return;
  try {
    await finishNumber(task.activationId);
    task.smsOrderFinished = true;
    addEvent(task, 'HeroSMS 订单已完成');
  } catch (error) {
    addEvent(task, `HeroSMS 完成订单失败：${error?.message || '未知错误'}`, 'warn');
  }
}

async function waitForSms(task, page) {
  setState(task, 'waiting_sms', `手机号 +${task.phone} 已提交，正在等待短信验证码`);
  const deadline = Date.now() + SMS_TIMEOUT_MS;
  while (Date.now() < deadline && !isCancelled(task)) {
    const result = await getSmsStatus(task.activationId);
    if (result.state === 'code' && result.code) {
      setState(task, 'submitting_sms', '已收到手机验证码，正在自动填写');
      const submitted = await fillSmsCodeAndSubmit(page, result.code);
      if (!submitted.ok) {
        setState(task, 'paused', submitted.reason, 'warn');
        return;
      }
      await finishSmsOrder(task);
      setState(task, 'finishing_login', '手机验证已提交，正在确认 Codex 登录结果');
      const finalResult = await waitForLoginResult(page, 60000, { ignorePhoneCode: true });
      if (finalResult.state === 'succeeded') {
        // 实跑几乎必走这条路（注册基本都要过手机验证），而它原来直接宣告成功，
        // 等于把「发消息才入账」那一步整条跳过 —— 主路径上的假终点，比旁路更贵。
        if (task.codexTurnDone) {
          setState(task, 'succeeded', '手机验证已完成，此前已完成 Codex 消息', 'ok');
        } else {
          await finishCodexTurn(task, page);
        }
      } else {
        setState(task, 'paused', finalResult.reason || '手机验证后仍需人工完成页面操作', 'warn');
      }
      return;
    }
    if (result.state === 'cancel') {
      setState(task, 'paused', 'HeroSMS 订单已取消，请人工检查后重试任务', 'warn');
      return;
    }
    await sleep(task, POLL_MS);
  }
  if (!isCancelled(task)) setState(task, 'paused', '等待手机验证码超过 5 分钟，请检查 HeroSMS 订单', 'warn');
}

async function handlePhoneVerification(task, page, initialStage = '') {
  const stage = initialStage || await detectPhoneStage(page);
  if (stage === 'phone_code') {
    if (!task.activationId) {
      setState(task, 'paused', '浏览器正在等待手机验证码，但任务没有可关联的 HeroSMS 订单', 'warn');
      return;
    }
    await waitForSms(task, page);
    return;
  }
  if (stage !== 'phone_number') {
    setState(task, 'paused', '需要手机验证，但未识别到安全的手机号输入页面', 'warn');
    return;
  }

  if (!task.activationId || !task.phone || task.smsOrderFinished) {
    setState(task, 'requesting_phone', 'Codex 要求手机验证，正在按管理员设置从 HeroSMS 获取号码');
    const number = await requestNumber();
    task.activationId = number.activationId;
    task.phone = String(number.phone || '').replace(/^\+/, '');
    task.phonePrice = number.price;
    task.phoneDialCode = number.dialCode;
    task.phoneNationalNumber = number.nationalNumber;
    task.phoneIsoCountry = number.isoCountry;
    task.phoneRequestedAt = new Date().toISOString();
    task.smsOrderFinished = false;
    persist();
  } else {
    addEvent(task, `继续使用本轮已取得的号码 +${task.phone}，避免重复扣费`);
  }

  setState(task, 'submitting_phone', `已取得号码 +${task.phone}，正在提交到 Codex`);
  const submitted = await submitPhoneNumber(page, task.phone, task.phoneDialCode, '', task.phoneNationalNumber, task.phoneIsoCountry);
  if (!submitted.ok) {
    setState(task, 'paused', submitted.reason, 'warn');
    return;
  }
  await waitForSms(task, page);
}

// 姓名 + 年龄的账号资料页。这一步以前直接暂停交人工 ——
// 2026-08-23 实测整轮就断在这里（OTP 提交后 60 秒「未确认登录成功」）。
// 同一份填写逻辑在 extension/content.js 里早就跑通了，这里是把它搬过来。
// 暂停时把现场留下来。
//
// 2026-08-23 第一轮实测停在「验证码提交后未确认登录成功」，而现场什么都没留 ——
// 只能靠读代码推断它卡在哪一页，为了看一眼还得杀进程重开浏览器，
// 反而把 cookie 落盘搞坏了，读数直接失去可信度。
// 一次截图 + 一份正文，比事后任何推理都便宜。
async function dumpPage(task, page, tag) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = join(DUMP_DIR, `${task.id.slice(0, 8)}-${stamp}-${tag}`);
  try {
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    const text = await page.locator('body').innerText().catch(() => '');
    writeFileSync(`${base}.txt`, `URL: ${page.url()}

${text}
`, { mode: 0o600 });
    addEvent(task, `现场已留证：${base}.png`);
  } catch (error) {
    addEvent(task, `留证失败：${error?.message || '未知错误'}`, 'warn');
  }
}

// 等资料页从 DOM 里消失。返回 false 表示等超时了，页面确实没动。
async function waitForProfileGone(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    if (!(await detectProfileStage(page))) return true;
  }
  return false;
}

async function handleProfilePage(task, page) {
  // 同一轮复用同一个身份：中途重试时换名字，页面上会出现前后不一致
  if (!task.profileName || !task.profileAge) {
    const profile = makeProfile();
    task.profileName = profile.name;
    task.profileAge = profile.age;
    persist();
  }
  setState(task, 'submitting_profile', `正在填写账号资料：${task.profileName}，${task.profileAge} 岁`);
  const submitted = await fillProfileAndSubmit(page, { name: task.profileName, age: task.profileAge });
  if (!submitted.ok) {
    setState(task, 'paused', submitted.reason, 'warn');
    return;
  }
  // 先等资料页真的消失，再去判断下一步。
  //
  // 原来这里提交完立刻调 waitForLoginResult，而它第一轮检查是**不等**的：
  // 页面才刚开始提交、DOM 还是资料页，于是当场判成「没前进」——
  // 2026-08-24 实测就卡在这，从提交到报错只隔了 1 秒（见 run.log 04:20:33）。
  // 防递归的闸是必要的，但判据得给页面留出跳转时间。
  const gone = await waitForProfileGone(page, 20000);
  if (!gone) {
    setState(task, 'paused', '账号资料已提交但页面 20 秒内没有前进，请人工检查', 'warn');
    return;
  }
  const result = await waitForLoginResult(page);
  // 走完还回到资料页 = 真的没生效（校验没过、被打回来）。留证再暂停。
  if (result.state === 'profile_required') {
    await dumpPage(task, page, 'profile-stuck');
    setState(task, 'paused', '账号资料提交后又被打回资料页，请人工检查', 'warn');
    return;
  }
  await handleBrowserResult(task, page, result);
}

// 账号建成后的最后一段：进 Codex 网页版并发一条消息。
//
// 为什么必须走这一步：邀请奖励的 redemption_action 是 `codex_turn` ——
// 账号建好只是入场券，额度要等受邀者真的在 Codex 里发过消息才入账。
// 安哥手动跑通过这条路，并指出**进 Codex 要先过手机验证**，
// 所以这里跳进去之后大概率撞上 add-phone，交给已有的 handlePhoneVerification 接。
async function handleCodexHandoff(task, page) {
  setState(task, 'opening_codex', '账号已建成，正在进入 Codex 网页版（这一步之后才会入账）');
  try {
    await page.goto(CODEX_APP_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (error) {
    setState(task, 'paused', `打开 Codex 失败：${error?.message || '未知错误'}`, 'warn');
    return;
  }
  // Codex 应用是 SPA，首屏渲染慢；不等够就会把「还没画出来」误判成「什么都没有」——
  // 资料页那一轮已经栽过一次同样的坑。
  await page.waitForTimeout(12000);

  const result = await waitForLoginResult(page);
  // 又回到交接屏 = 没真的进去（多半是会话没带过去）。留证，别自我递归。
  if (result.state === 'codex_handoff') {
    await dumpPage(task, page, 'codex-handoff-loop');
    setState(task, 'paused', '进入 Codex 后又回到交接页，请人工检查', 'warn');
    return;
  }
  await handleBrowserResult(task, page, result);
}

// 邀请奖励的最后一厘米。发什么内容不重要，重要的是**在被邀请的这个账号身上**
// 真的产生一次 turn；可以用环境变量换掉，默认给一句无害的短问句。
// 交接屏的原话是「发送**几条**消息即可获得额度」，不是一条。
// DMIT-2 上手动跑通那次发的就是这三条，照抄，不自己发明。
const CODEX_TURN_PROMPTS = (process.env.CODEX_TURN_PROMPTS || 'hi,what is 2 plus 2,thanks')
  .split(',').map((one) => one.trim()).filter(Boolean);
const MAX_CODEX_TURN_TRIES = 2;

async function finishCodexTurn(task, page) {
  task.codexTurnTries = (task.codexTurnTries || 0) + 1;
  if (task.codexTurnTries > MAX_CODEX_TURN_TRIES) {
    await dumpPage(task, page, 'codex-turn-give-up');
    setState(task, 'paused', `已在 Codex 里试发 ${MAX_CODEX_TURN_TRIES} 次消息都没确认成功，请人工接手`, 'warn');
    return;
  }
  // 有可能是从注册流直接落到 chatgpt.com 主界面的（那也算 pageIsLoggedIn），
  // 在那里发消息不是 Codex 的 turn。所以先确保人在 Codex 应用里。
  let pathname = '';
  try { pathname = new URL(page.url()).pathname; } catch { pathname = ''; }
  if (!/\/codex(\/|$)/.test(pathname)) {
    setState(task, 'opening_codex', '账号已登录，正在进入 Codex 应用（发消息才会入账）');
    try {
      await page.goto(CODEX_APP_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (error) {
      setState(task, 'paused', `打开 Codex 失败：${error?.message || '未知错误'}`, 'warn');
      return;
    }
    // 14 秒是 DMIT-2 上试出来的值，不是拍的：SPA 首屏慢，等不够会把
    // 「还没画出来」当成「页面上没有」，资料页那轮已经栽过同样的坑。
    await page.waitForTimeout(14000);
    // 进 Codex 常常先撞手机验证（安哥手动跑通时就是这个顺序）。交给已有的那条路，
    // 它走完会重新回到 handleBrowserResult，届时 codexTurnDone 仍为假，会再回到这里。
    const stage = await detectPhoneStage(page);
    if (stage) {
      await handlePhoneVerification(task, page, stage);
      return;
    }
  }
  // 输入框常常藏在几屏引导后面，先翻完再找框。
  await dismissCodexOnboarding(page);
  setState(task, 'sending_codex_turn', `正在以被邀请的账号在 Codex 里发 ${CODEX_TURN_PROMPTS.length} 条消息（这一步才会入账）`);
  const evidence = [];
  for (const [index, prompt] of CODEX_TURN_PROMPTS.entries()) {
    const sent = await sendCodexMessage(page, prompt);
    if (!sent.ok) {
      await dumpPage(task, page, `codex-turn-failed-${index + 1}`);
      // 第一条就发不出去 = 这个号根本没在 Codex 里说过话，直接暂停。
      // 后面几条失败则如实记下：已经有 turn 了，但没发满，入账与否要人看。
      setState(task, 'paused', `第 ${index + 1} 条消息没发成功：${sent.reason}`, 'warn');
      return;
    }
    evidence.push(`#${index + 1}:${sent.evidence.join('|')}`);
    await page.waitForTimeout(6000);
  }
  const sent = { evidence };
  task.codexTurnDone = true;
  task.codexTurnAt = new Date().toISOString();
  persist();
  // 留一张成功现场：这是唯一一次「奖励应该已经入账」的证据，
  // 事后对不上账时，没有这张图就只能靠回忆。
  await dumpPage(task, page, 'codex-turn-ok');
  setState(task, 'succeeded', `已在被邀请账号上完成 Codex 消息（证据：${sent.evidence.join(' / ')}）`, 'ok');
}

async function handleBrowserResult(task, page, result) {
  if (result.state === 'codex_handoff') {
    await handleCodexHandoff(task, page);
    return;
  }
  if (result.state === 'profile_required') {
    await handleProfilePage(task, page);
    return;
  }
  if (result.state === 'succeeded') {
    // 「页面认得出已登录」曾经就是终点，这是错的：登录 ≠ 入账。
    // 奖励要等被邀请的账号真的在 Codex 里发过一次消息（redemption_action: codex_turn），
    // 所以这里只是中途站，真正的终点在 finishCodexTurn。
    if (task.codexTurnDone) {
      setState(task, 'succeeded', '已登录且此前已完成 Codex 消息', 'ok');
    } else {
      await finishCodexTurn(task, page);
    }
  } else if (result.state === 'phone_required') {
    await handlePhoneVerification(task, page, result.phoneStage);
  } else if (result.state === 'invalid_invite') {
    // 这条分支也必须留证。2026-08-23 它连报两次「邀请无效」，
    // 而人工打开同一个链接完全正常（能一路走到验证码页）——
    // 说明是我们的判据误报，可判据有好几条，不看现场根本分不清是哪一条。
    await dumpPage(task, page, 'invalid-invite');
    if (task.inviteMailId) {
      task.baselineIds = [...new Set([...(task.baselineIds || []).map(String), String(task.inviteMailId)])];
      delete task.inviteMailId;
      persist();
    }
    setState(task, 'waiting_invite', '当前邀请已被 OpenAI 判定为无效或过期；请重新发送邀请，系统会自动接续');
    const replacement = await waitForInvite(task);
    if (replacement && !isCancelled(task)) await automateInvite(task, replacement);
  } else {
    // 这条分支就是「我们不认识这一页」。不留证 = 下次还是只能猜。
    await dumpPage(task, page, 'unknown');
    setState(task, 'paused', result.reason || '浏览器流程需要人工检查', 'warn');
  }
}

async function waitForOtp(task, page) {
  setState(task, 'waiting_otp', '邀请已打开，正在等待新的官方六位邮箱验证码');
  const deadline = Date.now() + OTP_TIMEOUT_MS;
  while (Date.now() < deadline && !isCancelled(task)) {
    const mails = await mailsFor(task);
    const otp = findOtpMail(mails, task.otpBaselineIds || task.baselineIds);
    if (otp) {
      setState(task, 'submitting_otp', '已收到最新验证码，正在填写并提交');
      const submitted = await fillOtpAndSubmit(page, otp.code);
      if (!submitted.ok) {
        setState(task, 'paused', submitted.reason, 'warn');
        return;
      }
      const result = await waitForLoginResult(page);
      await handleBrowserResult(task, page, result);
      return;
    }
    await sleep(task, POLL_MS);
  }
  if (!isCancelled(task)) setState(task, 'paused', '等待验证码超过 5 分钟；可在浏览器重发验证码后继续', 'warn');
}

async function automateInvite(task, invite) {
  const inviteUrl = inviteUrlOf(invite);
  if (!inviteUrl) {
    setState(task, 'failed', '邀请邮件中没有安全的 OpenAI/ChatGPT 链接', 'err');
    return;
  }
  const eligibility = inspectInviteReferral(inviteUrl);
  delete task.referralIssue;
  task.inviteMailId = String(invite.id);
  setState(task, 'opening_invite', eligibility.noRewards
    ? '邀请标记为不带奖励，仍将打开并以 OpenAI 页面实际结果为准'
    : '已识别邀请邮件，正在打开专用浏览器', eligibility.noRewards ? 'warn' : 'info');
  const { page } = await ensureBrowser(task, inviteUrl);
  const result = await driveToOtp(page, task.address, {
    beforeEmailSubmit: async () => {
      const mails = await mailsFor(task);
      task.otpBaselineIds = mails.map((mail) => String(mail.id));
      persist();
    },
  });
  if (result.state === 'waiting_otp') {
    await waitForOtp(task, page);
  } else {
    await handleBrowserResult(task, page, result);
  }
}

async function run(task, { resume = false } = {}) {
  try {
    if (resume && !task.inviteMailId) {
      const mails = await mailsFor(task);
      const recentInvite = findInvitationMail(mails, []);
      if (recentInvite && isRecentInviteMail(recentInvite, task.createdAt)) {
        task.baselineIds = (task.baselineIds || []).filter((id) => String(id) !== String(recentInvite.id));
        addEvent(task, '已接上启动前刚刚到达的官方邀请邮件');
        await automateInvite(task, recentInvite);
        return;
      }
    }
    if (resume && task.profileKey && contexts.has(task.profileKey)) {
      const { page } = await ensureBrowser(task, '');
      if (await pageIsLoggedIn(page)) {
        // 恢复任务时同理：登录态还在不代表这个号已经在 Codex 里说过话。
        // 中断重来的场景恰恰最容易停在「建好号但没发消息」，这里直接收工就白建了。
        if (task.codexTurnDone) {
          setState(task, 'succeeded', '该浏览器档案已登录且此前已完成 Codex 消息', 'ok');
        } else {
          await finishCodexTurn(task, page);
        }
        return;
      }
      const currentPhoneStage = await detectPhoneStage(page);
      if (currentPhoneStage) {
        await handlePhoneVerification(task, page, currentPhoneStage);
        return;
      }
      const result = await driveToOtp(page, task.address, {
        beforeEmailSubmit: async () => {
          const mails = await mailsFor(task);
          task.otpBaselineIds = mails.map((mail) => String(mail.id));
          persist();
        },
      });
      if (result.state === 'waiting_otp') {
        await waitForOtp(task, page);
        return;
      }
      await handleBrowserResult(task, page, result);
      return;
    }
    setState(task, 'waiting_invite', resume ? '正在恢复任务并重新查找邀请邮件' : '正在等待启动后到达的新邀请邮件');
    const invite = await waitForInvite(task, { includeKnownInvite: resume });
    if (invite && !isCancelled(task)) await automateInvite(task, invite);
  } catch (error) {
    if (!isCancelled(task)) setState(task, 'paused', `自动化暂停：${error?.message || '未知错误'}`, 'err');
  }
}

function launchRunner(task, options) {
  if (runners.has(task.id)) throw new Error('该任务正在运行');
  const promise = run(task, options).finally(() => runners.delete(task.id));
  runners.set(task.id, promise);
}

export async function startAutomation({ address } = {}) {
  if (startPending) throw new Error('正在启动另一个自动化任务，请稍候');
  const active = tasks.find((task) => !TERMINAL_STATES.has(task.state));
  if (active) throw new Error(`已有运行中的任务：${active.address}`);
  const normalized = assertAddress(address);
  startPending = true;
  try {
    const currentMails = await listMails({ address: normalized, limit: 100 });
    const addressedMails = currentMails.mails.filter((mail) => addressMatches(mail.address, normalized));
    const now = new Date().toISOString();
    const recentInvite = findInvitationMail(addressedMails, []);
    const acceptedInviteId = recentInvite && isRecentInviteMail(recentInvite, now) ? String(recentInvite.id) : '';
    const task = {
      id: randomUUID(),
      address: normalized,
      profileKey: profileKey(normalized),
      state: 'waiting_invite',
      message: '正在建立邮件基线',
      createdAt: now,
      updatedAt: now,
      // 记下这一轮用的是哪个邮箱来源。对照测试的分组信息必须跟样本一起落盘：
      // 事后靠回忆分组，等于没有分组。
      mailProvider: mailProviderName(),
      baselineIds: addressedMails
        .map((mail) => String(mail.id))
        .filter((id) => id !== acceptedInviteId),
      otpBaselineIds: [],
      events: [],
    };
    tasks.push(task);
    addEvent(task, acceptedInviteId
      ? '任务已启动；检测到刚刚到达的官方邀请，将直接继续处理'
      : '任务已启动；正在等待新的官方邀请邮件');
    launchRunner(task);
    return publicTask(task);
  } finally {
    startPending = false;
  }
}

export function automationStatus(id) {
  const task = id ? taskById(id) : tasks.at(-1);
  return publicTask(task);
}

export async function continueAutomation({ id } = {}) {
  const task = taskById(id);
  if (!['paused', 'interrupted'].includes(task.state)) throw new Error('当前任务不需要人工继续');
  launchRunner(task, { resume: true });
  return publicTask(task);
}

export async function restartAutomation({ id } = {}) {
  const task = taskById(id);
  if (!['failed', 'cancelled'].includes(task.state)) throw new Error('当前任务不需要重新开始');
  const active = tasks.find((item) => item.id !== task.id && !TERMINAL_STATES.has(item.state));
  if (active) throw new Error(`已有运行中的任务：${active.address}`);
  if (task.state === 'cancelled' && task.activationId && !task.smsOrderFinished) {
    delete task.activationId;
    delete task.phone;
    delete task.phonePrice;
    delete task.phoneRequestedAt;
    delete task.smsOrderFinished;
  }
  task.state = 'interrupted';
  addEvent(task, '正在重试同一轮：复用邮箱、邀请记录和浏览器档案');
  launchRunner(task, { resume: true });
  return publicTask(task);
}

export async function cancelAutomation({ id } = {}) {
  const task = taskById(id);
  if (TERMINAL_STATES.has(task.state)) return publicTask(task);
  setState(task, 'cancelled', '任务已取消');
  if (task.activationId && !task.smsOrderFinished) {
    try {
      await cancelNumber(task.activationId);
      addEvent(task, 'HeroSMS 订单已请求取消');
    } catch (error) {
      addEvent(task, `HeroSMS 订单暂未能取消：${error?.message || '未知错误'}`, 'warn');
    }
  }
  const entry = contexts.get(task.profileKey);
  if (entry) await entry.context.close().catch(() => {});
  return publicTask(task);
}

export async function openAutomationProfile({ id } = {}) {
  const task = taskById(id);
  const { page } = await ensureBrowser(task, 'https://chatgpt.com/');
  await page.bringToFront();
  addEvent(task, '已打开该邮箱的专用浏览器档案');
  return publicTask(task);
}
