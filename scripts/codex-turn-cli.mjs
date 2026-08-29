#!/usr/bin/env node
// 用 CLI 完成 codex_turn —— 完全绕开 Codex 桌面端 GUI。
//
// 之前卡死的地方是「在桌面端发消息」：Electron + Xvfb + CDP，
// 「调试端口通 ≠ 渲染进程画完」，点击落空；无 keyring 又导致重启掉登录态。
// 这条路一样都不需要：
//   1) 浏览器登录被邀请账号（邮箱 + 邮件验证码）
//   2) app-server 起设备码登录（隔离 CODEX_HOME，绝不碰主账号）
//   3) 用同一个浏览器批准那个设备码 —— 它就是流程要的「第二台设备」
//   4) codex exec 发消息，按产物验收（模型真回了话才算数）
//
// 用法：node scripts/codex-turn-cli.mjs --address user@tempmail2026.xyz [--prompt hi]
// 这是验证脚本，不是生产链路；跑通之后再接进 automation.js 的状态机。

import { chromium as pw } from 'playwright';
import { listMails } from '../server/mailProvider.js';
import { findOtpMail } from '../server/automationMatch.js';
import { approveDeviceCodeInPage, hardClickByText } from '../server/automationBrowser.js';
import { startCodexDeviceAuth, codexDeviceAuthStatus, codexHomeFor } from '../server/codexDeviceAuth.js';
import { runCodexExec } from '../server/codexTurnCli.js';

const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : String(process.argv[i + 1] || '').trim();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const address = arg('--address');
const prompt = arg('--prompt', 'hi');
if (!address) { console.error('缺少 --address'); process.exit(2); }

// patchright 修掉 Runtime.enable 泄漏，装不上就退回 playwright（本机没装是正常的）
let chromium = pw;
try { ({ chromium } = await import('patchright')); console.log('用 patchright'); }
catch { console.log('用 playwright（VPS 上应该有 patchright）'); }

const browser = await chromium.launch({
  headless: false,
  args: ['--disable-blink-features=AutomationControlled'],
});
const page = await (await browser.newContext({ locale: 'zh-CN', viewport: { width: 1400, height: 900 } })).newPage();
const bodyText = async () => (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');

try {
  // ---------- 1. 浏览器登录被邀请账号 ----------
  // 入口用 /codex 营销页而不是首页：首页未登录会盖一个 fixed inset-0 的弹窗遮罩，
  // Playwright 的可点性检查会一直重试到超时（VPS 上实测卡死两轮）。
  console.log('[1/4] 打开 chatgpt.com/codex');
  await page.goto('https://chatgpt.com/codex', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);

  const baseline = (await listMails({ address, limit: 30 })).mails.map((m) => String(m.id));
  await hardClickByText(page, '^(登录|log in)$', '登录');
  await page.waitForTimeout(9000);

  // 只认真正的邮箱框：input:visible 会撞上 composer 里隐藏的文件选择器（踩过）
  const email = page.locator('input[type="email"], input[name*="email" i], input[autocomplete="username"]').first();
  await email.waitFor({ timeout: 25000 });
  await email.fill(address);
  await hardClickByText(page, '^(继续|continue)$', '邮箱后继续');
  await page.waitForTimeout(6000);

  console.log('[2/4] 等邮件验证码');
  let code = '';
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline && !code) {
    await sleep(4000);
    code = findOtpMail((await listMails({ address, limit: 30 })).mails, baseline)?.code || '';
  }
  if (!code) throw new Error('150 秒没等到验证码邮件');
  console.log(`      验证码 ${code}`);
  await page.locator('input[autocomplete="one-time-code"], input[name="code"]').first().fill(code);
  await hardClickByText(page, '^(继续|continue|verify|验证)$', '验证码后继续');
  await page.waitForTimeout(12000);
  console.log(`      登录后 URL: ${page.url()}`);

  // ---------- 2. 起设备码登录 ----------
  console.log('[3/4] 起 app-server 设备码登录');
  const session = await startCodexDeviceAuth({ address, loginType: 'chatgptDeviceCode' });
  console.log(`      ${session.verificationUrl}  码 ${session.userCode}`);

  // ---------- 3. 用同一个浏览器批准 ----------
  const approved = await approveDeviceCodeInPage(page, {
    verificationUrl: session.verificationUrl,
    userCode: session.userCode,
  });
  console.log(`      批准结果: ${JSON.stringify(approved)}`);
  if (!approved.ok) {
    await page.screenshot({ path: `data/automation/dumps/devicecode-${Date.now()}.png`, fullPage: true }).catch(() => {});
    throw new Error(`设备码批准失败（卡在 ${approved.step}）：${approved.reason}`);
  }

  // app-server 那边要收到 account/login/completed 才算真登上
  let logged = false;
  const loginDeadline = Date.now() + 120000;
  while (Date.now() < loginDeadline) {
    const current = codexDeviceAuthStatus(session.id);
    if (current?.state === 'succeeded') { logged = true; break; }
    if (current?.state === 'failed' || current?.state === 'cancelled') {
      throw new Error(`设备码登录${current.state}：${current.message}`);
    }
    await sleep(3000);
  }
  if (!logged) throw new Error('浏览器批准了，但 app-server 120 秒内没收到登录完成通知');

  // ---------- 4. 发消息 ----------
  console.log('[4/4] codex exec 发消息');
  const home = codexHomeFor(address);
  const result = await runCodexExec({ codexHome: home, prompt });
  console.log(`      CODEX_HOME=${home}`);
  console.log(`      结果: ${result.ok ? '✅ 成功' : '❌ ' + result.reason}`);
  if (result.ok) console.log(`      模型回复: ${result.reply}`);
  else console.log(`      原始输出前 400 字:\n${String(result.stdout || '').slice(0, 400)}`);
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  console.error(`失败：${error.message}`);
  console.error(`当前页面正文前 200 字：${(await bodyText()).slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
}
