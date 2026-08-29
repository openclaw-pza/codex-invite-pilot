// webmailOutlook.js — 用浏览器读 outlook 网页版收信。
//
// 为什么走这条路（三条协议路全部实测走不通）：
//   IMAP  outlook.office365.com:993 → LOGINDISABLED
//   POP3  pop-mail.outlook.com:995  → 能力串广告 USER，实际回 "Basic authentication is disabled"
//   Graph → 要 Azure 应用注册 + client_id，安哥手上没有
// 网页版是唯一只要账号密码就能走的路。代价是靠 DOM，微软改版就得修 ——
// 所以这里的选择器全部是 2026-08-25 在真实信箱上探出来的，不是猜的。
//
// 微软会强制要求「添加恢复邮箱」且**没有跳过选项**（实测只有 下一步/后退/注销）。
// 解法是把恢复邮箱绑成我们自己的 tempmail2026.xyz 地址 —— 安全代码发到我们能读的
// 信箱里，整条链路无人工。见 scripts/bind-recovery-mail.mjs。
//
// 浏览器是**单例长驻**的：注册链路每 4 秒轮询一次邮件，每次都开一个浏览器
// 会把 2G 的机器直接压垮。

import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractCode } from './extract.js';
import { classifyMail, pickInviteUrl } from './mailKind.js';
import { createAddress, listMails as listTempMails } from './cloudflareEmail.js';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

// 每个微软账号一个独立档案。**一个 outlook 只能收一次邀请**，所以每跑一轮就要换号，
// 共用一个档案会让上一个号的登录态污染下一个号（表现为「登录的不是我指定的那个账号」）。
export function profileDirFor(user) {
  if (process.env.WEBMAIL_PROFILE_DIR) return process.env.WEBMAIL_PROFILE_DIR;
  const key = createHash('sha256').update(String(user || '').trim().toLowerCase()).digest('hex').slice(0, 20);
  return join(ROOT_DIR, 'data', 'webmail-profiles', key);
}
const MAIL_URL = 'https://outlook.live.com/mail/0/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let shared = null;   // { ctx, page }
// 已解析过的行（按 aria-label 指纹）。注册链路每几秒轮询一次，
// 每轮把每封信都点开一遍要 17 秒 —— 而账号存活窗口只有十几分钟，
// 等 OTP 那一段拖不起。见过的行直接返回缓存，只点开新出现的。
const parsedRows = new Map();

async function launchChromium() {
  // patchright 装不上就退回 playwright；outlook 不像 chatgpt 那样查 Runtime.enable，
  // 所以这里两个都能用。
  try { return (await import('patchright')).chromium; }
  catch { return (await import('playwright')).chromium; }
}

// 登录态在磁盘档案里，但实测**不可靠**（跳回 OAuth 授权页）。
// 所以判据不是「档案存在」而是「邮件列表真的渲染出来了」，不行就用密码重登。
// 账号只要绑好恢复邮箱，重登是零验证的，所以这条退路是自动的。
async function ensureLoggedIn(page) {
  const user = String(process.env.WEBMAIL_USER || '').trim();
  const pass = String(process.env.WEBMAIL_PASS || '');
  await page.goto(MAIL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(10000);
  for (let round = 0; round < 10; round += 1) {
    if (await mailListReady(page)) return true;
    // 每一轮都把现场打出来。登录失败只报一句「登录失败」的话，
    // 下次还是只能靠猜是卡在密码页、验证页还是别的什么屏。
    const snapshot = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
    console.log(`[webmail] 第${round + 1}轮 ${page.url().slice(0, 70)} | ${snapshot.slice(0, 130)}`);
    if (!user || !pass) throw new Error('网页版未登录，且没有 WEBMAIL_USER / WEBMAIL_PASS 可用于重登');
    const email = page.locator('input[type="email"], input[name="loginfmt"]').first();
    if (await email.isVisible().catch(() => false)) {
      await email.fill(user); await page.keyboard.press('Enter'); await sleep(8000); continue;
    }
    // 绑过恢复邮箱之后，微软会**优先**提议「把代码发到备用邮箱」而不是问密码，
    // 页面上「使用密码」是降级入口。不点它就会一直停在这一屏 ——
    // 实测新档案登录必撞这一屏（因为恢复邮箱正是我们自己绑的）。
    if (/使用密码|use your password/i.test(snapshot)
      && !(await page.locator('input[type="password"]').first().isVisible().catch(() => false))) {
      await nativeClick(page, '^(使用密码|use your password|use password)$');
      await sleep(6000);
      continue;
    }
    const pw = page.locator('input[type="password"], input[name="passwd"]').first();
    if (await pw.isVisible().catch(() => false)) {
      await pw.fill(pass); await page.keyboard.press('Enter'); await sleep(12000);
      // 密码过了之后停在 login.live.com 的过场页，要自己回信箱
      if (/login\.live\.com|account\.live\.com/.test(page.url())) {
        await page.goto(MAIL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await sleep(10000);
      }
      continue;
    }
    const text = await page.locator('body').innerText().catch(() => '');
    // 「让我们来保护你的帐户」这一屏没有跳过键（实测只有 下一步/后退/注销）。
    // 以前这里直接抛错、要人去跑一个单独的绑定脚本 —— 那就不是全自动了。
    // 现在就地绑一个我们能读的地址，代码自己收自己填。
    if (/让我们来保护你的帐户|protect your account|安全信息/i.test(text)) {
      if (await bindRecoveryEmail(page)) { await sleep(6000); continue; }
      throw new Error('微软要求补充恢复邮箱，但自动绑定失败');
    }
    // 判据要卡死在这几句原文上。曾经把「隐私」也放进来 —— 而营销页页脚就有「隐私与 Cookie」，
    // 于是每一轮都被当成过场页按回车，后面「改从 login.live.com 进」那条分支永远走不到，
    // 表现成在营销页空转满 7 轮。宽判据比没判据更坏，因为它会挡住正确分支。
    if (/保持登录状态|stay signed in|有关 Microsoft 帐户的快速说明/i.test(text)) {
      await page.keyboard.press('Enter'); await sleep(8000); continue;
    }
    // 🔴 未登录时 outlook.live.com/mail 会被重定向到 Microsoft 365 的**营销页**，
    // 那页上没有任何登录表单 —— 实测新档案会在营销页空转满 7 轮然后报「登录失败」。
    // 拿到表单只有一条路：直接打 login.live.com。
    if (!/login\.live\.com|outlook\.live\.com\/mail/.test(page.url())) {
      console.log('[webmail] 被弹到营销页，改从 login.live.com 进');
      await page.goto('https://login.live.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await sleep(8000);
      continue;
    }
    await page.goto(MAIL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(8000);
  }
  const last = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  console.log(`[webmail] 登录未完成，最后停在 ${page.url().slice(0, 90)} | ${last.slice(0, 200)}`);
  return mailListReady(page);
}

// 微软页面到处是 ms-Overlay--dark 遮罩，Playwright 的可点性检查会重试到超时；
// 而且选项常常是 label 包 span。所以统一走原生 click，并上溯到 label。
async function nativeClick(page, pattern) {
  return page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    const hits = [...document.querySelectorAll('a,button,[role="button"],input[type="submit"],div,span,label')]
      .filter((e) => re.test((e.innerText || e.textContent || e.value || '').trim()));
    if (!hits.length) return false;
    const inner = hits.filter((e) => !hits.some((o) => o !== e && e.contains(o)));
    // 必须上溯到**真正可点的祖先**。按钮文字通常包在 <span> 里，
    // 只点 span 在这些框架里不触发处理器 —— 实测同意授权页因此原地打转 9 轮，
    // 而 nativeClick 每轮都报「命中」，日志上完全看不出问题。
    const raw = inner[0] || hits[hits.length - 1];
    const el = raw.closest('button, input[type="submit"], a, [role="button"], label') || raw;
    el.click();
    return true;
  }, pattern).catch(() => false);
}

// 微软对机房 IP 上的账号**强制要求补充恢复方式**，而且那一屏没有跳过键
// （实测可点的只有 下一步/后退/注销）。解法：绑一个我们自己能读的
// tempmail2026.xyz 地址 —— 安全代码发到我们的信箱，代码自己读、自己填，全程无人工。
// 这是「一个 outlook 只能邀请一次、每轮都要换号登录」能自动化的前提。
export async function bindRecoveryEmail(page) {
  const box = page.locator('input[name="EmailAddress"], input[type="email"][aria-label*="备用"]').first();
  if (!(await box.isVisible().catch(() => false))) return false;
  const recovery = (await createAddress({ name: `rec${Date.now().toString(36)}` })).address;
  console.log(`[webmail] 自动绑定恢复邮箱：${recovery}`);
  // 先记基线再提交，否则可能把信箱里的旧信当成这次的安全代码
  const baseline = (await listTempMails({ address: recovery, limit: 20 })).mails.map((m) => String(m.id));
  await box.fill(recovery);
  if (!(await nativeClick(page, '^(下一步|next)$'))) await page.keyboard.press('Enter');
  await sleep(9000);

  let code = '';
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline && !code) {
    await sleep(5000);
    const { mails } = await listTempMails({ address: recovery, limit: 20 });
    const hit = mails.filter((m) => !baseline.includes(String(m.id))).find((m) => m.code);
    if (hit) { code = hit.code; console.log(`[webmail] 收到微软安全代码 ${code}`); }
  }
  if (!code) { console.warn('[webmail] 5 分钟没收到微软安全代码'); return false; }

  const codeBox = page.locator('input[name="ProofConfirmation"], input[name="otc"], input[type="tel"], input[type="text"]').first();
  await codeBox.fill(code).catch(() => {});
  if (!(await nativeClick(page, '^(下一步|next|验证|verify|完成|done)$'))) await page.keyboard.press('Enter');
  await sleep(12000);
  return true;
}

async function mailListReady(page) {
  if (!/outlook\.live\.com\/mail/.test(page.url())) return false;
  // 判据是「进到信箱界面了」，不是「有邮件」。
  // 拿「至少有一行」当就绪判据的话，一个还没收到过任何信的新号会被判成加载失败，
  // 于是每一轮轮询都抛错 —— 而等邀请那段恰恰就是从空信箱开始的。
  return page.locator(
    'button[aria-label*="新邮件" i], button[aria-label*="New mail" i], [role="listbox"], [data-convid], div[role="option"]',
  ).first().isVisible().catch(() => false);
}

async function getPage() {
  if (shared?.page && !shared.page.isClosed()) return shared.page;
  const chromium = await launchChromium();
  const ctx = await chromium.launchPersistentContext(profileDirFor(process.env.WEBMAIL_USER), {
    // 默认无头：这台机器只有 2G，注册链路那边还要跑一个有头浏览器 + Electron 桌面端。
    // outlook 没有 chatgpt 那种反自动化检测，无头能用。
    headless: process.env.WEBMAIL_HEADLESS !== '0',
    locale: 'zh-CN',
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  if (!(await ensureLoggedIn(page))) {
    await ctx.close().catch(() => {});
    throw new Error('outlook 网页版登录失败');
  }
  shared = { ctx, page };
  return page;
}

// 只给测试和换账号用：清掉行缓存
export function resetWebmailCache() { parsedRows.clear(); }

// 把「已登录的那个页面」暴露出去。设备码授权要在这个账号的会话里点同意，
// 而登录逻辑（营销页重定向、使用密码降级、强制绑恢复邮箱）已经在这里踩齐了，
// 换个脚本重写一遍必然漏掉其中一两条。
export async function loggedInPage() {
  return getPage();
}

export async function closeWebmail() {
  if (shared?.ctx) await shared.ctx.close().catch(() => {});
  shared = null;
}

// 阅读窗格的正文头部长这样（实测）：
//   "主题 M帐 Microsoft 帐户团队<account-security-noreply@accountprotection.microsoft.com>
//    收件人:你 周二 2026/8/25 8:31  <正文…>"
// 发件人地址就藏在第一个尖括号里。这是我们唯一能拿到**真实发件地址**的地方 ——
// 列表行的 aria-label 只有显示名，而发件人白名单比对的是地址，不是显示名。
export function parseReadingPane(text, links = []) {
  const flat = String(text || '').replace(/\s+/g, ' ');
  const from = /<([^<>@\s]+@[^<>\s]+)>/.exec(flat)?.[1] || '';
  const subject = flat.slice(0, 120).split(/\s{2,}|<|收件人/)[0].trim();
  const safeLinks = (Array.isArray(links) ? links : []).filter((u) => /^https?:/i.test(u));
  const mail = {
    id: '',
    address: '',
    subject,
    from,
    receivedAt: '',
    body: flat.slice(0, 4000),
    code: extractCode(flat),
    links: safeLinks,
  };
  const kind = classifyMail(mail);
  return { ...mail, kind, inviteUrl: kind === 'invite' ? pickInviteUrl(safeLinks) : null };
}

/**
 * 与其他邮箱来源同名同形。逐封打开读正文 —— 列表行拿不到发件人地址和链接。
 * id 用「发件人+主题+时间」的指纹：OWA 的 data-convid 是会话级的，
 * 同一会话里的多封信共用一个值，拿它当邮件 id 会把新邮件误判成旧的。
 */
// 🔴 Outlook 的收件箱默认分成「重点 / 其他」两栏，而**只有当前栏的行会出现在 DOM 里**。
// 2026-08-25 实测：OpenAI 的邀请信 8:46 就到了，但落在「其他」栏，
// 只读默认栏的读取器完全看不到它 —— 表现成「40 分钟没等到邀请」，
// 而信箱、垃圾箱、已删除、存档全都翻过，人会以为是没送达。
// 所以两栏都必须读。不去关账号的「重点收件箱」开关：那是每个新号都要重做的一次性设置，
// 换个号就漏，跟全自动的目标相悖。
async function selectInboxTab(page, names) {
  const ok = await page.evaluate((list) => {
    const want = new RegExp(`^(${list.join('|')})$`, 'i');
    const el = [...document.querySelectorAll('[role="tab"], button')]
      .find((e) => want.test((e.innerText || '').trim()));
    if (!el) return false;
    el.click();   // 原生 click：OWA 会盖 ms-Overlay--dark，Playwright 的可点性检查会重试到超时
    return true;
  }, names).catch(() => false);
  if (ok) await sleep(3500);
  return ok;
}

export async function listMails({ limit = 10 } = {}) {
  const page = await getPage();
  if (!(await mailListReady(page))) {
    // 「读不到列表」按故障处理，不按「没有新邮件」处理 —— 这是本项目的硬规则：
    // 整批查不到 = 故障。判成「没邮件」会让注册链路一直空等到超时。
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(8000);
    if (!(await mailListReady(page))) throw new Error('outlook 网页版读不到邮件列表（不等于没有新邮件）');
  }
  const want = Math.min(Math.max(Number(limit) || 10, 1), 15);
  const mails = [];
  // 两栏都切、都读，不做任何条件跳过。
  // 上一版写成「切不过去就 continue」，结果整个「其他」栏被跳掉、邀请信永远读不到，
  // 而日志里一个字都看不出来 —— 所以这里每一步都打日志。
  // 没开启重点收件箱的信箱：切换会「没找到」，但照样读一次，行缓存保证不重复解析。
  for (const tab of [['重点', 'Focused'], ['其他', 'Other']]) {
    const picked = await selectInboxTab(page, tab);
    const before = mails.length;
    await collectRows(page, want, mails);
    console.log(`[webmail] ${tab[0]}栏：${picked ? '已切换' : '无此分栏'}，新增 ${mails.length - before} 封`);
  }
  return { mails };
}

async function collectRows(page, want, mails) {
  const rows = page.locator('[data-convid], div[role="option"]');
  const total = await rows.count().catch(() => 0);
  for (let i = 0; i < Math.min(total, want); i += 1) {
    const row = rows.nth(i);
    const aria = await row.getAttribute('aria-label').catch(() => '') || '';
    // 指纹只取前 90 字：发件人 + 主题 + 预览开头。够区分不同邮件，
    // 又不会因为「未读变已读」「相对时间刷新」这类状态变化而失效。
    // 去掉「未读」前缀再取指纹：邮件被点开后 aria-label 会从「未读 X」变成「X」，
    // 不剥的话同一封信换个身份又被点开解析一遍，白花好几秒。
    const finger = aria.replace(/^\s*(未读|unread)\s*/i, '').slice(0, 90);
    if (finger && parsedRows.has(finger)) { mails.push(parsedRows.get(finger)); continue; }
    // OWA 会盖 ms-Overlay--dark，Playwright 的可点性检查会判「被挡住」然后超时。
    // 上一版在这里 catch 掉就 continue，**一个字都不打** ——
    // 结果「其他」栏那封邀请信每轮都被静默跳过，外面看到的是「新增 0 封」，
    // 完全看不出是点不开还是本来就没有。原生 click 绕开可点性检查，失败必须出声。
    let opened = await row.click({ timeout: 6000 }).then(() => true).catch(() => false);
    if (!opened) {
      opened = await page.evaluate((idx) => {
        const els = document.querySelectorAll('[data-convid], div[role="option"]');
        if (!els[idx]) return false;
        els[idx].click();
        return true;
      }, i).catch(() => false);
    }
    if (!opened) {
      console.warn(`[webmail] 第 ${i + 1} 行点不开，跳过：${aria.slice(0, 50)}`);
      continue;
    }
    await sleep(2500);
    const read = await page.evaluate(() => {
      const main = document.querySelector('[role="main"]');
      return {
        text: (main?.innerText || '').slice(0, 6000),
        links: [...document.querySelectorAll('[role="main"] a[href]')].map((a) => a.href),
      };
    }).catch(() => ({ text: '', links: [] }));
    if (!read.text) continue;
    const mail = parseReadingPane(read.text, read.links);
    // 指纹当 id：同一会话下多封信的 data-convid 相同，用它会漏判新邮件
    mail.id = `owa-${Buffer.from(`${mail.from}|${mail.subject}|${aria.slice(0, 60)}`).toString('base64').slice(0, 32)}`;
    if (finger) parsedRows.set(finger, mail);
    mails.push(mail);
  }
}
