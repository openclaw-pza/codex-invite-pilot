// automationBrowser.js — Playwright 页面识别与有限动作；未知页面一律交给人工
// 🔴 5 秒太紧。2026-08-27 实测：OTP 页的 Continue 按钮**找到了**，却卡在
// Playwright 的可操作性检查（visible / enabled / stable）上超时，整轮当场死在
// 离终点两步的地方。那一屏本来就有过渡动画，按钮在动的时候 stable 检查就是过不了。
const ACTION_TIMEOUT_MS = 12000;
const UNKNOWN_PAGE_TIMEOUT_MS = 60000;
export const INVALID_INVITE_REASON = 'OpenAI 判定当前邀请链接无效或已过期';

// 点击要能扛住「按钮在动」。第一次按正常可操作性检查点；卡在检查上就等一下、
// 用 force 再点一次。
//
// 退路必须是 force:true，**不能**退到 DOM 的 el.click()：
// force 跳过的只是「等待检查」，派发的仍然是真实输入事件（isTrusted=true）；
// 而 el.click() 是合成事件，微软的授权表单会直接拒收（2026-08-25 实证）。
async function clickResilient(button, label = '按钮') {
  try {
    await button.click({ timeout: ACTION_TIMEOUT_MS });
    return true;
  } catch (error) {
    const msg = String(error?.message || '');
    // 只对"点不动"退让。元素没了、页面关了这类要照常抛出去，别把真故障吞掉。
    if (!/Timeout|not stable|intercepts pointer|element is not visible/i.test(msg)) throw error;
    console.warn(`[browser] ${label} 第一次点击卡在可操作性检查上，改用 force 重试：${msg.slice(0, 120)}`);
  }
  try { await button.page().waitForTimeout(1500); } catch { /* 页面没了下面会抛 */ }
  await button.click({ timeout: ACTION_TIMEOUT_MS, force: true });
  return true;
}

async function firstVisible(locators) {
  for (const locator of locators) {
    const first = locator.first();
    if (await first.isVisible().catch(() => false)) return first;
  }
  return null;
}

async function otpInputs(page) {
  const single = await firstVisible([
    page.locator('input[autocomplete="one-time-code"]'),
    page.locator('input[name*="code" i]'),
    page.locator('input[name*="otp" i]'),
    page.locator('input[id*="code" i]'),
    page.locator('input[placeholder*="code" i]'),
    page.locator('input[placeholder*="验证码"]'),
  ]);
  if (single) return { kind: 'single', locator: single };

  const digits = page.locator('input[maxlength="1"][inputmode="numeric"]:visible');
  if (await digits.count().catch(() => 0) >= 6) return { kind: 'digits', locator: digits };
  return null;
}

async function phoneNumberInput(page) {
  return firstVisible([
    page.locator('form[action*="/add-phone" i] input[type="tel"]'),
    page.locator('form[action*="/add-phone" i] input[autocomplete="tel"]'),
    page.locator('input[name="__reservedForPhoneNumberInput_tel"]'),
  ]);
}

async function phoneCodeInput(page) {
  return firstVisible([
    page.locator('form[action*="/phone-verification" i] input[name="code"]'),
    page.locator('form[action*="/phone-verification" i] input[autocomplete="one-time-code"]'),
    page.locator('form[action*="/phone-verification" i] input[inputmode="numeric"]'),
  ]);
}

// 姓名 + 年龄的账号资料页。选择器照搬 extension/content.js 的 profileInputs()——
// 那份是在真实页面上跑通过的，别自己重猜一套。
async function profileInputs(page) {
  const age = await firstVisible([
    page.locator('input[name="age" i]'),
    page.locator('input[id*="age" i]'),
    page.locator('input[placeholder*="age" i]'),
    page.locator('input[aria-label*="age" i]'),
    page.locator('input[placeholder*="年龄"]'),
    page.locator('input[aria-label*="年龄"]'),
  ]);
  if (!age) return null;
  const name = await firstVisible([
    page.locator('input[autocomplete="name"]'),
    page.locator('input[name="name" i]'),
    page.locator('input[name*="full" i][name*="name" i]'),
    page.locator('input[id*="name" i]'),
    page.locator('input[placeholder*="full name" i]'),
    page.locator('input[aria-label*="full name" i]'),
    page.locator('input[placeholder*="姓名"]'),
    page.locator('input[aria-label*="姓名"]'),
  ]);
  // 两个都在才算资料页。只有 name 的页面到处都是（登录页、搜索框），
  // 拿单个字段当判据会把无关页面误当资料页填一通。
  return name ? { age, name } : null;
}

const FIRST_NAMES = ['James', 'Michael', 'David', 'John', 'Robert', 'William', 'Daniel', 'Thomas',
  'Emily', 'Sarah', 'Jessica', 'Laura', 'Anna', 'Grace', 'Olivia', 'Sophia'];
const LAST_NAMES = ['Smith', 'Johnson', 'Brown', 'Miller', 'Wilson', 'Moore', 'Taylor', 'Clark',
  'Walker', 'Hall', 'Young', 'Baker', 'Turner', 'Parker', 'Evans', 'Collins'];

export function makeProfile(random = Math.random) {
  const first = FIRST_NAMES[Math.floor(random() * FIRST_NAMES.length) % FIRST_NAMES.length];
  const last = LAST_NAMES[Math.floor(random() * LAST_NAMES.length) % LAST_NAMES.length];
  // 21~32：低于 18 会触发未成年流程，太大也没必要
  return { name: `${first} ${last}`, age: 21 + (Math.floor(random() * 12) % 12) };
}

export async function fillProfileAndSubmit(page, profile) {
  const inputs = await profileInputs(page);
  if (!inputs) return { ok: false, reason: '没有找到姓名和年龄输入框' };
  await inputs.name.fill(String(profile.name));
  await inputs.age.fill(String(profile.age));
  const finish = await firstVisible([
    page.getByRole('button', { name: /finish creating account|create account|完成创建账户|完成建立帳戶|创建账户|建立帳戶/i }),
    page.locator('button[type="submit"]'),
  ]);
  if (!finish) return { ok: false, reason: '姓名和年龄已填写，但没有找到完成创建按钮' };
  await clickResilient(finish, '完成创建账户');
  return { ok: true };
}

// 账号建成后的最后一屏：「在 Codex 中继续 / 下载或打开 Codex，并发送几条消息即可获得 N 账户额度」。
//
// 这一屏**不是终点**：邀请奖励的 redemption_action 是 `codex_turn`，
// 必须真的在 Codex 里发一次消息才入账。而进 Codex 网页版要先过手机验证。
// 原来这一屏落进「未确认登录成功」的兜底里，整轮就停在离终点一步的地方。
export async function detectCodexHandoff(page) {
  const text = await page.locator('body').innerText({ timeout: ACTION_TIMEOUT_MS }).catch(() => '');
  return /在\s*Codex\s*中继续|下载或打开\s*Codex|continue in codex|download or open codex/i.test(text)
    ? 'codex_handoff'
    : '';
}

// Codex 网页应用。登录态下 /codex 会落到这里；没有会话时会被弹去营销页。
export const CODEX_APP_URL = 'https://chatgpt.com/codex/cloud';

// ——— 第五步：在**被邀请的那个账号**身上真的发一条消息 ———
//
// 这一步是整条链路唯一决定给不给额度的动作：邀请奖励的 redemption_action 是 `codex_turn`，
// 账号建成只是入场券。在补上这段之前，流程走到「Codex 已成功登录」就收工了 ——
// 离终点一步停下，前面收信、建号、过 OTP、过手机验证全部白干。

// ChatGPT 页面上到处是 `fixed inset-0` 的遮罩层（未登录弹窗、引导层）。
// Playwright 的可点性检查会判定「按钮被别的元素挡住」然后重试到超时 ——
// DMIT-2 上实测连卡三轮就是这个。遮罩只是视觉层，按钮自己的 click 处理器是好的，
// 所以绕开可点性检查、直接在页面里调原生 click。
export async function hardClickByText(page, pattern, label = '') {
  const ok = await page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    const els = [...document.querySelectorAll('button, a, [role="button"], input[type="submit"]')];
    const hit = els.find((el) => re.test((el.innerText || el.textContent || el.value || '').trim()));
    if (!hit) return false;
    hit.click();
    return true;
  }, pattern).catch(() => false);
  if (label) console.log(`[automation] 原生点击「${label}」：${ok ? '命中' : '没找到'}`);
  return ok;
}

// 新账号首次进 Codex 会连着几屏引导，输入框藏在它们后面。
// 不点掉就会报「没找到输入框」，而真实原因只是没翻完引导页。
export async function dismissCodexOnboarding(page, rounds = 3) {
  for (let i = 0; i < rounds; i += 1) {
    if (!(await hardClickByText(page, '^(继续|continue|开始使用|get started)$', `引导${i + 1}`))) break;
    await page.waitForTimeout(4500);
  }
}

async function codexComposer(page) {
  return firstVisible([
    // #prompt-textarea 是实跑验证过的：pageIsLoggedIn 就是拿它当登录态标记的。
    page.locator('#prompt-textarea'),
    page.locator('[data-testid="prompt-textarea"]'),
    page.locator('textarea[placeholder*="message" i]'),
    page.locator('textarea[placeholder*="ask" i]'),
    page.locator('textarea[placeholder*="发消息"]'),
    page.locator('div[contenteditable="true"]'),
  ]);
}

// 回复真的开始了的迹象。四条任取其一即可，但**必须至少有一条**。
async function codexTurnEvidence(page, urlBefore) {
  const evidence = [];
  if (page.url() !== urlBefore) evidence.push(`url:${page.url()}`);
  const started = await firstVisible([
    page.locator('[data-message-author-role="assistant"]'),
    page.locator('[data-testid="stop-button"]'),
    page.locator('button[aria-label*="stop" i]'),
    page.locator('button[aria-label*="停止"]'),
  ]);
  if (started) evidence.push('assistant-or-stop');
  return evidence;
}

export async function sendCodexMessage(page, text, { timeoutMs = 45000 } = {}) {
  const composer = await codexComposer(page);
  if (!composer) return { ok: false, reason: '进到 Codex 了，但没找到输入框，发不出消息' };
  const urlBefore = page.url();

  // 跟 OTP 六格框同一个教训：这些是 React 受控组件，locator.fill() 是「清空再设值」，
  // 跟组件自己的 onChange/onInput 打架，内部 state 可能收到残缺内容，
  // 表现是「看着填进去了，发出去是空的」。聚焦 + 真实键盘打字，事件序列跟人手一致。
  // 输入框也会被遮罩挡住。原来这里直接 click，遮罩一盖就抛异常、整个第五步崩出去，
  // 而外面看到的只是一句「未知错误」。点不动就退回原生 focus —— 键盘输入照样进得去。
  const focused = await composer.click({ timeout: ACTION_TIMEOUT_MS }).then(() => true).catch(() => false);
  if (!focused) {
    const ok = await composer.evaluate((el) => { el.focus(); return document.activeElement === el; }).catch(() => false);
    if (!ok) return { ok: false, reason: '输入框被遮挡且无法聚焦，消息发不出去' };
  }
  await page.keyboard.type(String(text), { delay: 30 });

  const send = await firstVisible([
    page.locator('[data-testid="send-button"]'),
    page.locator('button[aria-label*="send" i]'),
    page.locator('button[aria-label*="发送"]'),
  ]);
  // 三级退路。原来这里点击失败就被 catch 吞掉、什么也不做 ——
  // 按钮找得到但被遮罩挡住时，消息永远发不出去，而日志上看不出任何异常。
  let clicked = false;
  if (send) clicked = await send.click({ timeout: ACTION_TIMEOUT_MS }).then(() => true).catch(() => false);
  if (!clicked) clicked = await hardClickByText(page, '^(发送|send)$');
  if (!clicked) await page.keyboard.press('Enter');

  // 关键：**不拿「点过了」当办成了**。这一步的产物是「模型开始回复」，
  // 只看到输入框清空是不够的 —— 发送失败、被限流、会话没带过来，输入框照样会空。
  // 这条判据错了，我们会对一个根本没入账的号报「成功」，而买家那边什么都没有。
  const deadline = Date.now() + timeoutMs;
  let evidence = [];
  while (Date.now() < deadline) {
    evidence = await codexTurnEvidence(page, urlBefore);
    if (evidence.length) return { ok: true, evidence };
    await page.waitForTimeout(1000);
  }
  const composerNow = await codexComposer(page);
  const emptied = composerNow ? !(await composerNow.innerText().catch(() => 'x')).trim() : false;
  return {
    ok: false,
    reason: emptied
      ? '消息像是发出去了（输入框已清空），但等满仍未看到回复开始 —— 不能按入账算'
      : '消息没有发出去：输入框里内容还在，也没有回复开始',
  };
}

// ——— 设备码批准：让「已登录被邀请账号的浏览器」当那第二台设备 ———
//
// 设备码流程本来要一个人拿另一台设备去输码。但我们手上正好有一个已经登录了
// 被邀请账号的浏览器 —— 它就是那台设备。于是登录 Codex CLI 这一步也能无人工完成，
// 整条链路彻底绕开桌面端 GUI（ops-001 记的那些 CDP 时序坑）。
//
// ⚠️ 这里的选择器**尚未在真实页面上验证过**（还没有可用账号）。
// 所以每一步失败都必须明确报出是哪一步，不许含糊成一句「失败了」——
// 第一次真跑时要靠这些信息一次定位，而不是再猜一轮。
export async function approveDeviceCodeInPage(page, { verificationUrl, userCode, timeoutMs = 60000 } = {}) {
  if (!verificationUrl || !userCode) return { ok: false, step: 'args', reason: '缺少 verificationUrl 或 userCode' };
  try {
    await page.goto(verificationUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (error) {
    return { ok: false, step: 'goto', reason: `打不开设备码页面：${error?.message || '未知错误'}` };
  }
  await page.waitForTimeout(4000);

  // 码可能是单框，也可能是分段框（跟 OTP 那边同一类组件）
  const single = await firstVisible([
    page.locator('input[name*="code" i]'),
    page.locator('input[id*="code" i]'),
    page.locator('input[placeholder*="code" i]'),
    page.locator('input[autocomplete="one-time-code"]'),
    page.locator('input[type="text"]'),
  ]);
  if (!single) return { ok: false, step: 'find-input', reason: '设备码页面上没找到输入框' };

  // 真实键盘输入，理由同 OTP 六格框：受控组件跟 fill() 打架
  const focused = await single.click({ timeout: ACTION_TIMEOUT_MS }).then(() => true).catch(() => false);
  if (!focused) {
    const ok = await single.evaluate((el) => { el.focus(); return document.activeElement === el; }).catch(() => false);
    if (!ok) return { ok: false, step: 'focus', reason: '设备码输入框被遮挡且无法聚焦' };
  }
  await page.keyboard.type(String(userCode), { delay: 80 });

  if (!(await hardClickByText(page, '^(continue|next|继续|下一步|submit|提交)$', '设备码继续'))) {
    await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(5000);

  // 同意授权那一屏
  const allowed = await hardClickByText(page, '^(allow|authorize|approve|continue|允许|授权|同意|继续)$', '同意授权');
  await page.waitForTimeout(4000);

  const text = await page.locator('body').innerText().catch(() => '');
  // 成功文案未经实测，所以两个方向都认；认不出来就如实说认不出来，别猜成功。
  if (/you(?:'| a)?re all set|device (?:is )?connected|authorized|登录成功|已连接|可以关闭/i.test(text)) {
    return { ok: true, step: 'done', allowClicked: allowed };
  }
  if (/expired|invalid|过期|无效/i.test(text)) {
    return { ok: false, step: 'verify', reason: '设备码已过期或无效，需要重新申请' };
  }
  return {
    ok: false,
    step: 'verify',
    reason: `批准流程走完了但没认出成功页（正文前 120 字：${text.replace(/\s+/g, ' ').slice(0, 120)}）`,
  };
}

export async function detectProfileStage(page) {
  return (await profileInputs(page)) ? 'profile' : '';
}

export async function detectPhoneStage(page) {
  if (await phoneNumberInput(page)) return 'phone_number';
  if (await phoneCodeInput(page)) return 'phone_code';
  return '';
}

async function visibleBlocker(page) {
  const text = await page.locator('body').innerText({ timeout: ACTION_TIMEOUT_MS }).catch(() => '');
  const rules = [
    [/推荐邀请不可用|邀请链接(?:无效|不可用|已过期)|referral invitation (?:is )?unavailable|invitation link (?:is )?(?:invalid|expired)/i, INVALID_INVITE_REASON],
    [/captcha|verify you are human|验证您是人类|安全验证/i, '检测到 CAPTCHA 或人机验证'],
    [/require_sso_login|sso (?:login )?is required|必须.*(?:sso|单点登录)/i, '检测到必须使用 SSO 登录'],
    [/date of birth|birthday|出生日期|生日/i, '需要人工填写生日或个人资料'],
    [/i agree to the terms|accept.*terms|同意.*条款/i, '需要人工确认条款'],
    // OpenAI 自己的路由报错页。多半是表单被提交了两次（见 fillOtpAndSubmit 的注释）。
    // 单独认出来，别让它落进最后那句含糊的「未确认登录成功」——
    // 那句话把「页面报错了」和「页面还没走完」混成一件事，查起来要多花一整轮。
    [/route error|糟糕，出错了|invalid content type/i, 'OpenAI 页面报错（多为重复提交），可点页面上的「重试」'],
  ];
  return rules.find(([regex]) => regex.test(text))?.[1] || '';
}

export async function pageIsLoggedIn(page) {
  let url;
  try {
    url = new URL(page.url());
  } catch {
    return false;
  }
  if (!(url.hostname === 'chatgpt.com' || url.hostname.endsWith('.chatgpt.com'))) return false;
  if (/\b(auth|login|invite|join)\b/i.test(url.pathname)) return false;
  const marker = await firstVisible([
    page.locator('#prompt-textarea'),
    page.locator('[data-testid="prompt-textarea"]'),
    page.locator('button[aria-label*="profile" i]'),
    page.locator('button[aria-label*="account" i]'),
  ]);
  return Boolean(marker);
}

function pageHasRejectedReferralUrl(page) {
  try {
    const url = new URL(page.url());
    return url.hostname === 'chatgpt.com'
      && /\/accept-referral\/?$/i.test(url.pathname)
      && url.searchParams.has('email')
      && !url.searchParams.has('referral_context');
  } catch {
    return false;
  }
}

// 密码屏（「创建密码」/「输入密码」）上的「使用一次性验证码」入口。
//
// 为什么一定要认它：账号一旦被设上密码，重跑时再开邀请链接就停在「输入密码」屏，
// 而我们没有任何地方存那个密码 —— 号就彻底进不去了（2026-08-27 实测踩到）。
// 全程只让账号停留在「无密码、只认一次性验证码」这一个状态，重跑才是同构的。
async function switchToCodeLogin(page) {
  const pw = page.locator('input[type="password"]').first();
  if (!(await pw.isVisible().catch(() => false))) return false;
  const link = await firstVisible([
    page.getByRole('button', { name: /使用一次性验证码|使用驗證碼|one-time (code|password)|verification code instead/i }),
    page.getByRole('link', { name: /使用一次性验证码|使用驗證碼|one-time (code|password)|verification code instead/i }),
  ]);
  if (!link) return false;
  await clickResilient(link, '改用一次性验证码');
  await page.waitForTimeout(2500);
  return true;
}

async function clickContinue(page) {
  const button = await firstVisible([
    page.getByRole('button', { name: /^(?:continue|next|verify|submit)(?:\s+(?:email|code))?$|^(?:继续|下一步|验证|提交)$/i }),
    page.locator('button[type="submit"]'),
  ]);
  if (!button) return false;
  await clickResilient(button, '继续');
  return true;
}

// 推进邀请页直至需要 OTP、成功或必须人工接管。
export async function driveToOtp(page, address, { beforeEmailSubmit, timeoutMs = UNKNOWN_PAGE_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let accepted = false;
  let emailSubmitted = false;
  while (Date.now() < deadline) {
    if (await pageIsLoggedIn(page)) return { state: 'succeeded' };
    if (pageHasRejectedReferralUrl(page)) return { state: 'invalid_invite', reason: INVALID_INVITE_REASON };
    const phoneStage = await detectPhoneStage(page);
    if (phoneStage) return { state: 'phone_required', phoneStage };
    // **必须排在 visibleBlocker 之前**：资料页上常常同时出现「生日」字样，
    // 而 visibleBlocker 有条 /date of birth|生日/ 的规则会抢先把它拦成人工。
    // 顺序反了 = 这个分支永远走不到。
    if (await detectProfileStage(page)) return { state: 'profile_required' };
    if (await otpInputs(page)) return { state: 'waiting_otp' };

    const blocker = await visibleBlocker(page);
    if (blocker) {
      return blocker === INVALID_INVITE_REASON
        ? { state: 'invalid_invite', reason: blocker }
        : { state: 'paused', reason: blocker };
    }

    if (!accepted) {
      const accept = await firstVisible([
        page.getByRole('button', { name: /accept.*(?:invite|invitation)|接受邀请|接受邀請/i }),
        page.getByRole('link', { name: /accept.*(?:invite|invitation)|接受邀请|接受邀請/i }),
      ]);
      if (accept) {
        await clickResilient(accept, '接受邀请');
        accepted = true;
        await page.waitForTimeout(700);
        continue;
      }
    }

    // 密码屏要在邮箱分支**之前**处理：那一屏上也有一个（只读的）邮箱框，
    // 先跑邮箱分支会去重填它、点继续，然后原地打转。
    if (await switchToCodeLogin(page)) { emailSubmitted = true; continue; }

    if (!emailSubmitted) {
      const email = await firstVisible([
        page.locator('input[type="email"]'),
        page.locator('input[name*="email" i]'),
      ]);
      if (email) {
        await email.fill(address);
        if (beforeEmailSubmit) await beforeEmailSubmit();
        if (!(await clickContinue(page))) {
          return { state: 'paused', reason: '已填写邮箱，但未找到可确认的继续按钮' };
        }
        emailSubmitted = true;
        await page.waitForTimeout(700);
        continue;
      }
    }
    await page.waitForTimeout(1000);
  }
  return { state: 'paused', reason: '60 秒内未识别出安全的下一步，请人工检查浏览器页面' };
}

export async function fillOtpAndSubmit(page, code) {
  const inputs = await otpInputs(page);
  if (!inputs) return { ok: false, reason: '验证码已收到，但浏览器中没有找到验证码输入框' };
  // 这几行是拿五轮失败换来的。只知道「命中了 single」还不够：
  // 手动用「第一个可见输入框」一次就通，自动化按选择器找却炸，
  // 差别可能就是**命中了页面上另一个输入框**。把所有可见 input 的身份摊出来，
  // 顺便标出我们选中的是哪一个 —— 不然只能继续猜。
  try {
    const all = await page.locator('input:visible').evaluateAll((els) => els.map((el, i) => ({
      i,
      type: el.type, name: el.name, id: el.id,
      autocomplete: el.getAttribute('autocomplete'),
      maxlength: el.getAttribute('maxlength'),
      inputmode: el.getAttribute('inputmode'),
      placeholder: el.placeholder,
    })));
    const chosen = await inputs.locator.evaluate((el) => ({
      type: el.type, name: el.name, id: el.id, autocomplete: el.getAttribute('autocomplete'),
    })).catch(() => null);
    console.log(`[automation] OTP 页 ${page.url()}`);
    console.log(`[automation] 可见输入框 ${all.length} 个：${JSON.stringify(all)}`);
    console.log(`[automation] 我们选中的：kind=${inputs.kind} ${JSON.stringify(chosen)}`);
  } catch (error) {
    console.log(`[automation] 输入框快照失败：${error.message}`);
  }
  const before = page.url();
  if (inputs.kind === 'single') {
    // 单输入框**不会**自动提交，必须显式点「继续」。
    //
    // 2026-08-23 手动实测：OpenAI 的 /email-verification 用的就是单个输入框
    // （`input[maxlength=1][inputmode=numeric]` 数量为 0，六格框根本不存在），
    // 而「填 → 点继续」这条手动路径一次就通，直接落到 /about-you 资料页。
    // 所以这里填完直接点，不要走下面那套「等页面自己走」的逻辑 ——
    // 那套是给六格自动提交准备的，用在单框上只会白等 4 秒再点，
    // 中间任何一次重渲染让 otpInputsGone 误判，点击就被整个跳过、表单永远没提交。
    await inputs.locator.fill(code);
    if (!(await clickContinue(page))) {
      await inputs.locator.press('Enter').catch(() => {});
    }
    return { ok: true };
  }
  {
    // 六格验证码框是 React 受控组件：每格的 onChange 会把焦点推到下一格并重渲染。
    // 用 locator.fill() 逐格填会跟这套逻辑打架（fill 是「清空再设值」，
    // 清空那一下又触发一次 onChange），组件内部 state 收到的码可能是残缺的，
    // 提交上去就是 400 + 一页 `Route Error (400 Invalid content type: text/html)`。
    // 2026-08-23 连续三轮都死在这，现场截图在 data/automation/dumps/。
    //
    // 改成聚焦第一格 + 真实键盘打字：跳格由组件自己处理，
    // 事件序列跟人手输入完全一致。插件那条路能跑通也正是因为它走的是原生事件。
    await inputs.locator.nth(0).click();
    await page.keyboard.type(String(code).slice(0, 6), { delay: 90 });
  }

  // 六格验证码框填完最后一位会**自己提交**。原来这里紧接着又点一次「继续」，
  // 等于同一个表单提交两次 —— 第二次打到已经在跳转中的路由上，
  // OpenAI 会回一页 `Route Error (400 Invalid content type: text/html)`，
  // 整轮就死在这（2026-08-23 实测，现场截图在 data/automation/dumps/）。
  //
  // 所以：填完先看它自己走不走，只有确实没动才补一次点击。
  const settled = await Promise.race([
    page.waitForURL((url) => url.toString() !== before, { timeout: 4000 }).then(() => true).catch(() => false),
    otpInputsGone(page, 4000),
  ]);
  if (settled) return { ok: true, autoSubmitted: true };

  await clickContinue(page);
  return { ok: true };
}

// 输入框消失也算提交成功了（有些页面原地换内容、URL 不变）
async function otpInputsGone(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(400);
    if (!(await otpInputs(page))) return true;
  }
  return false;
}

export async function waitForLoginResult(page, timeoutMs = UNKNOWN_PAGE_TIMEOUT_MS, { ignorePhoneCode = false } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pageIsLoggedIn(page)) return { state: 'succeeded' };
    const phoneStage = await detectPhoneStage(page);
    if (phoneStage && !(ignorePhoneCode && phoneStage === 'phone_code')) {
      return { state: 'phone_required', phoneStage };
    }
    // 同 driveToOtp：必须排在 visibleBlocker 之前，否则被 /生日/ 那条规则抢走。
    // 2026-08-23 实测就断在这里——OTP 提交后 60 秒「未确认登录成功」，
    // 真实原因是页面停在姓名+年龄那一步，而这条路当时根本不认识它。
    if (await detectProfileStage(page)) return { state: 'profile_required' };
    if (await detectCodexHandoff(page)) return { state: 'codex_handoff' };
    const blocker = await visibleBlocker(page);
    if (blocker) return { state: 'paused', reason: blocker };
    await page.waitForTimeout(1000);
  }
  return { state: 'paused', reason: '验证码提交后未确认登录成功，请人工检查浏览器页面' };
}

function normalizedPhoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

export async function submitPhoneNumber(page, phone, dialCode = '66', countryName = '', providedNationalNumber = '', isoCountry = '') {
  const input = await phoneNumberInput(page);
  if (!input) return { ok: false, reason: '没有找到手机号输入框' };

  const form = input.locator('xpath=ancestor::form[1]');
  const select = form.locator('select').first();
  if (await select.isVisible().catch(() => false)) {
    const options = await select.locator('option').evaluateAll((entries) => entries.map((option, index) => ({
      index,
      value: option.value,
      text: option.textContent || '',
    })));
    const normalizedName = String(countryName || '').trim().toLowerCase();
    const normalizedIso = String(isoCountry || '').trim().toLowerCase();
    const normalizedDialForCountry = normalizedPhoneDigits(dialCode);
    const dialPattern = normalizedDialForCountry ? new RegExp(`\\+${normalizedDialForCountry}\\b`) : null;
    const country = options.find((option) => {
      const text = String(option.text || '').toLowerCase();
      const value = String(option.value || '').trim().toLowerCase();
      return (normalizedIso && value === normalizedIso)
        || (normalizedName && text.includes(normalizedName))
        || (dialPattern && dialPattern.test(text));
    });
    if (!country) return { ok: false, reason: `手机号页面没有找到号码对应的国家选项${normalizedDialForCountry ? `（+${normalizedDialForCountry}）` : ''}` };
    await select.selectOption({ value: country.value });
  }

  const sms = form.locator('input[type="radio"][value="sms"]');
  if (await sms.isVisible().catch(() => false) && !(await sms.isChecked().catch(() => false))) {
    await sms.check();
  }

  const digits = normalizedPhoneDigits(phone);
  const normalizedDial = normalizedPhoneDigits(dialCode);
  const suppliedNational = normalizedPhoneDigits(providedNationalNumber);
  const national = suppliedNational || (normalizedDial && digits.startsWith(normalizedDial)
    ? digits.slice(normalizedDial.length)
    : digits);
  if (!national) return { ok: false, reason: 'HeroSMS 返回的手机号为空' };
  await input.fill(national);

  const submit = await firstVisible([
    form.getByRole('button', { name: /continue|send|submit|继续|发送|提交/i }),
    form.locator('button[type="submit"]'),
  ]);
  if (!submit) return { ok: false, reason: '手机号已填写，但没有找到提交按钮' };
  await clickResilient(submit, '提交');

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await phoneCodeInput(page)) return { ok: true };
    const error = await firstVisible([
      form.locator('[role="alert"]'),
      form.locator('[class*="error" i]'),
      form.locator('[aria-invalid="true"] + *'),
    ]);
    if (error) {
      const message = (await error.innerText().catch(() => '')).trim();
      if (message) return { ok: false, reason: `手机号未被接受：${message}` };
    }
    await page.waitForTimeout(500);
  }
  return { ok: false, reason: '提交手机号后 30 秒内没有进入短信验证码页面' };
}

export async function fillSmsCodeAndSubmit(page, code) {
  const input = await phoneCodeInput(page);
  if (!input) return { ok: false, reason: '短信已收到，但没有找到手机验证码输入框' };
  await input.fill(String(code));
  const form = input.locator('xpath=ancestor::form[1]');
  const submit = await firstVisible([
    form.getByRole('button', { name: /continue|verify|submit|继续|验证|提交/i }),
    form.locator('button[type="submit"]'),
  ]);
  if (!submit) return { ok: false, reason: '手机验证码已填写，但没有找到提交按钮' };
  await clickResilient(submit, '提交');
  return { ok: true };
}
