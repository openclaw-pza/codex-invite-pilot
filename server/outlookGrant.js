// outlookGrant.js — 给一个微软账号自动拿 refresh_token（一次性），之后读信不再开浏览器。
//
// 为什么要有它：浏览器读网页版登录 80 秒、读信 26 秒，还依赖 DOM
// （已经被「重点/其他」分栏坑过一次）。换成 token 直连 Graph 是 **0.7 秒**、无 DOM，
// 也不受分栏影响 —— Focused/Other 只是视图，API 看到的是同一个 Inbox 文件夹。
//
// 不需要 Azure 注册：用 Thunderbird 的公开 client_id（无 client secret）。
// 实测微软 consumers 端点接受它签发 IMAP / POP / Graph 三种 scope 的设备码。
//
// 设备码那一步由**这个账号自己的浏览器会话**去点同意，所以全程无人工。

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const AUTH = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
export const THUNDERBIRD_CLIENT_ID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
export const DEFAULT_SCOPE = 'https://graph.microsoft.com/Mail.Read offline_access';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => console.log(`[grant] ${m}`);

// 与 outlookMail.js 用同一套路径算法：一个 outlook 只能收一次邀请，每轮换号，
// token 必须按账号分开存，否则后一个号会覆盖前一个号的 refresh_token。
export function tokenPathFor(address) {
  const key = createHash('sha256').update(String(address || '').trim().toLowerCase()).digest('hex').slice(0, 20);
  return join(ROOT_DIR, 'data', 'outlook-tokens', `${key}.json`);
}

export function hasToken(address) {
  return existsSync(tokenPathFor(address));
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  try { return { ok: res.ok, payload: JSON.parse(text) }; }
  catch { return { ok: res.ok, payload: {}, text }; }
}

// 按纯文本精确匹配点击，不拿邮箱地址去拼正则（地址里的 . 和 + 在正则里都有含义）
async function clickExactText(page, wanted) {
  return page.evaluate((w) => {
    const hits = [...document.querySelectorAll('a,button,[role="button"],div,span,label')]
      .filter((e) => (e.innerText || e.textContent || '').trim() === w);
    if (!hits.length) return false;
    const inner = hits.filter((e) => !hits.some((o) => o !== e && e.contains(o)));
    const raw = inner[0] || hits[0];
    (raw.closest('button, input[type="submit"], a, [role="button"], label') || raw).click();
    return true;
  }, wanted).catch(() => false);
}

// 🔴 微软的表单页（同意授权、保持登录状态…）**只认可信事件**。
// el.click() 产生 isTrusted=false，页面纹丝不动却又不报错 ——
// 表现是「每轮都报命中、屏幕不变」，这个坑在同意页和保持登录页各踩了一次。
// 所以凡是微软的按钮，一律先走 Playwright 的真实点击。
async function trustedClick(page, nameRegex, label) {
  const btn = page.getByRole('button', { name: nameRegex }).last();
  const ok = await btn.click({ timeout: 8000 }).then(() => true)
    .catch(() => btn.click({ timeout: 5000, force: true }).then(() => true).catch(() => false));
  if (label) say(`  点[${label}]: ${ok ? '命中' : '失败'}`);
  return ok;
}

async function nativeClick(page, pattern) {
  return page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    const hits = [...document.querySelectorAll('a,button,[role="button"],input[type="submit"],div,span,label')]
      .filter((e) => re.test((e.innerText || e.textContent || e.value || '').trim()));
    if (!hits.length) return false;
    const inner = hits.filter((e) => !hits.some((o) => o !== e && e.contains(o)));
    const raw = inner[0] || hits[hits.length - 1];
    (raw.closest('button, input[type="submit"], a, [role="button"], label') || raw).click();
    return true;
  }, pattern).catch(() => false);
}

/**
 * 拿 refresh_token。需要该账号能登录网页版（webmailOutlook 负责，它已经处理了
 * 营销页重定向、「使用密码」降级、强制绑恢复邮箱这三道闸）。
 */
export async function grantRefreshToken({
  user = process.env.WEBMAIL_USER,
  pass = process.env.WEBMAIL_PASS,
  clientId = process.env.OUTLOOK_CLIENT_ID || THUNDERBIRD_CLIENT_ID,
  scope = process.env.OUTLOOK_SCOPE || DEFAULT_SCOPE,
} = {}) {
  const address = String(user || '').trim();
  if (!address) throw new Error('grantRefreshToken 需要 WEBMAIL_USER');

  const start = await postForm(`${AUTH}/devicecode`, { client_id: clientId, scope });
  if (!start.payload.device_code) {
    throw new Error(`设备码申请失败：${start.payload.error_description || JSON.stringify(start.payload).slice(0, 200)}`);
  }
  say(`设备码 ${start.payload.user_code}，验证页 ${start.payload.verification_uri}`);

  const { loggedInPage, closeWebmail, bindRecoveryEmail } = await import('./webmailOutlook.js');
  const page = await loggedInPage();
  say('已拿到该账号的登录会话，去批准设备码');
  try {
    await page.goto(start.payload.verification_uri, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(6000);
    let codeEntered = false;
    for (let i = 0; i < 12; i += 1) {
      const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
      say(`  第${i + 1}屏: ${body.slice(0, 90)}`);

      // 🔴 同意授权必须用 Playwright 的**真实点击**。el.click() 产生的是
      // isTrusted=false 的事件，微软的同意表单不认 —— 表现是「每轮都报命中、
      // 页面纹丝不动」，查了三轮才定位到。页面上只有 拒绝 / 接受 两个按钮。
      if (/是否允许此应用访问|permissions requested|let this app access/i.test(body)) {
        await trustedClick(page, /^(接受|Accept)$/, '接受授权');
        await sleep(8000);
        continue;
      }
      // 「保持登录状态?」也是微软表单，同样只认可信点击（这里独立踩过一次）
      if (/保持登录状态|stay signed in/i.test(body)) {
        if (!(await trustedClick(page, /^(是|Yes)$/, '保持登录'))) await page.keyboard.press('Enter');
        await sleep(7000);
        continue;
      }
      if (/大功告成|已登录到|you.?re all set|可以安全地关闭|signed in/i.test(body)) { say('✅ 批准完成'); break; }

      // 全新账号在这一步会撞上「让我们来保护你的帐户」——**没有跳过键**。
      // 这套处理原本只写在收信模块里，授权循环不认它就会空转到超时
      // （2026-08-26 实测：新号在这里连转 12 屏）。复用同一个绑定函数，
      // 绑我们自己能读的 tempmail 地址，代码自读自填。
      if (/让我们来保护你的帐户|protect your account/i.test(body)) {
        if (await bindRecoveryEmail(page)) { await sleep(6000); continue; }
        throw new Error('授权流程里要求补充恢复邮箱，但自动绑定失败');
      }
      // 导航到验证页会**再触发一次登录挑战**（微软对这台机器仍不完全信任）
      if (/使用密码|use your password/i.test(body)
        && !(await page.locator('input[type="password"]').first().isVisible().catch(() => false))) {
        await nativeClick(page, '^(使用密码|use your password|use password)$'); await sleep(6000); continue;
      }
      const pw = page.locator('input[type="password"], input[name="passwd"]').first();
      if (await pw.isVisible().catch(() => false)) {
        await pw.fill(String(pass || '')); await page.keyboard.press('Enter'); await sleep(9000); continue;
      }
      const otc = page.locator('input[name="otc"], input[name="userCode"]').first();
      if (!codeEntered && (await otc.isVisible().catch(() => false))) {
        await otc.fill(start.payload.user_code); codeEntered = true;
        if (!(await nativeClick(page, '^(下一步|next|继续|continue)$'))) await page.keyboard.press('Enter');
        await sleep(7000); continue;
      }
      if (!codeEntered && /输入代码|enter the code|设备|device/i.test(body)) {
        const any = page.locator('input[type="text"]:visible, input[type="tel"]:visible').first();
        if (await any.isVisible().catch(() => false)) {
          await any.fill(start.payload.user_code); codeEntered = true;
          if (!(await nativeClick(page, '^(下一步|next|继续|continue)$'))) await page.keyboard.press('Enter');
          await sleep(7000); continue;
        }
      }
      if (await clickExactText(page, address)) { await sleep(6000); continue; }
      if (await trustedClick(page, /^(是|Yes|继续|Continue|下一步|Next)$/, '推进')) { await sleep(6000); continue; }
      if (await nativeClick(page, '^(是|yes|继续|continue|下一步|next)$')) { await sleep(6000); continue; }
      await sleep(4000);
    }
  } finally {
    // 批准完就把浏览器收掉：2G 的机器上后面还要跑注册浏览器 + 桌面端
    await closeWebmail().catch(() => {});
  }

  say('轮询取 token…');
  let interval = (Number(start.payload.interval) || 5) * 1000;
  const deadline = Date.now() + (Number(start.payload.expires_in) || 900) * 1000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('设备码已过期，未拿到 token');
    await sleep(interval);
    const r = await postForm(`${AUTH}/token`, {
      client_id: clientId,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: start.payload.device_code,
    });
    if (r.payload.refresh_token) {
      const file = tokenPathFor(address);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({
        address, clientId, scope, refreshToken: r.payload.refresh_token, savedAt: new Date().toISOString(),
      }, null, 2)}\n`, { mode: 0o600 });
      say(`✅ refresh_token 已保存：${file}`);
      return { ok: true, path: file };
    }
    if (r.payload.error === 'authorization_pending') continue;
    if (r.payload.error === 'slow_down') { interval += 5000; continue; }
    throw new Error(`取 token 失败：${r.payload.error_description || r.payload.error}`);
  }
}
