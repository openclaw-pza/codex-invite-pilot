// desktop-run.mjs — 全流程走**官方 ChatGPT 桌面端**（不是网页版、不是 CLI）。
//
// 安哥 2026-08-24 给的流程：
//   收邀请 → 点邮件建账户 → 打开 ChatGPT **桌面端** → 接码（泰国，**不要最便宜那档**，
//   至少倒数第三档）→ 登录桌面端发 1~3 条消息
// 官方原话：受邀者需接受邀请并**使用 ChatGPT Desktop 完成符合条件的操作**（Chat / Work / Codex）。
//
// 关键约束：
//   · 临时邮箱域名建的号约 10 分钟后被停用 → 全程掐表，每步打耗时
//   · DMIT-2 只有 2G 内存 → **分阶段跑，尽量不让两个 Chromium 同时在**
//
// 桌面端怎么自动化：它是 Electron，开 --remote-debugging-port 后 patchright 能 connectOverCDP 接管。
// 它点「登录」时会调 xdg-open 打开系统浏览器——这台机器没有默认浏览器，
// 所以预先装了个假 xdg-open 把 URL 写进 /tmp/opened-urls.txt，我们再用自己的浏览器去完成。
import { chromium } from 'patchright';
import { spawn, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
// 收信走 mailProvider：MAIL_PROVIDER=cloudflare（一次性域）/ outlook（真实微软邮箱）。
// 两条臂共用**同一份**下游代码，切换只动一个环境变量 —— 对照实验成立的前提。
// createAddress 仍从 cloudflare 拿：只有一次性域需要现建地址，微软号地址是固定的。
import { createAddress } from './server/cloudflareEmail.js';
import { listMails, mailProviderName } from './server/mailProvider.js';
import { findInvitationMail, findOtpMail, inviteUrlOf, inspectInviteReferral } from './server/automationMatch.js';
import { fetchPriceQuotes, requestNumber, getStatus, finishNumber, cancelNumber } from './server/heroSms.js';
import { config } from './server/config.js';
// 判据集中在这里，三处地方共用同一套词表。分开写必然漂移 ——
// 已经漂移过：handshakeDesktop 把「等浏览器登录」的等待屏判成了已登录。
import {
  classifyTurn, desktopTextLoggedIn, desktopTextNeedsLogin, makeChallenge, pickReplyLine,
} from './server/desktopJudge.js';
import {
  driveToOtp, fillOtpAndSubmit, fillProfileAndSubmit, makeProfile,
  detectProfileStage, detectPhoneStage, submitPhoneNumber, fillSmsCodeAndSubmit,
} from './server/automationBrowser.js';

// 这三个原本写死成部署机上的路径。别人 clone 下来跑，截图会往一个不存在的
// 目录里写、假 xdg-open 又写在另一个地方 —— 两边对不上的表现是
// 「一直等不到 OAuth 链接」，而真正的原因（路径不一致）一条日志都不会说。
// 所以做成可覆盖，默认值落在仓库内，不依赖任何特定部署布局。
const HERE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE_DIR, '..', '..');
// 截图目录：出事时的现场证据。默认放仓库 data/shots/（已被 .gitignore 排除）。
const SHOTS = process.env.CODEX_SHOTS_DIR || join(REPO_ROOT, 'data', 'shots');
// 假 xdg-open 把桌面端要打开的 URL 写在这里。**装 xdg-open 时用的路径必须和这里一致**，
// 否则脚本会一直等一个永远不会出现的文件。
const URL_FILE = process.env.CODEX_URL_FILE || join(tmpdir(), 'opened-urls.txt');
const CDP = process.env.CODEX_CDP_URL || 'http://127.0.0.1:9333';
const T0 = Date.now();
let W0 = null;                       // 10 分钟窗口起点（邀请到达时开始）
const el = () => ((Date.now() - T0) / 1000).toFixed(0) + 's';
const win = () => (W0 ? ((Date.now() - W0) / 1000).toFixed(0) + 's' : '-');
const say = (m) => console.log(`[+${el()} 窗口${win()}] ${m}`);
// 2G 机器上浏览器和 Electron 要并存，每个关键节点打一次余量。
// 上一轮怀疑过 OOM，实测没有击杀记录 —— 但没数据就只能继续猜，所以留着。
function mem() {
  try {
    const t = readFileSync('/proc/meminfo', 'utf8');
    const kb = Number(/MemAvailable:\s+(\d+)/.exec(t)?.[1] || 0);
    return `可用${Math.round(kb / 1024)}MB`;
  } catch { return '可用?'; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let activationId = null;
let desktop = null;

function killDesktop() {
  // 只杀桌面端，**不要杀 Xvfb** —— 那是脚本自己（和 patchright）赖以生存的显示环境
  // 大小写都要覆盖：launcher 命令行是小写 chatgpt，Electron 主进程路径是 ChatGPT。
  // 杀不干净的话上一轮进程还占着 9333，新一轮连上的是**旧那个已登录的桌面端**，
  // 登录按钮永远等不到。
  for (const pat of ['[C]hatGPT', '[c]hatgpt', 'codex-launcher']) {
    try { execSync(`pkill -9 -f "${pat}"`, { stdio: 'ignore' }); } catch { /* 本来就没有 */ }
  }
}

// 桌面端的用户数据目录。**每轮开跑前必须清掉**：
// 它是持久化的，上一轮那个受邀账号的登录态还在里面，于是新一轮起来时
// 桌面端直接是已登录状态、**根本不会渲染登录按钮** ——
// 2026-08-26 实测：等了 60 秒没等到按钮，整轮作废，而日志上看不出是这个原因。
// 注意这跟「登录之后不能重启桌面端」不冲突：那条说的是**同一轮之内**。
const DESKTOP_PROFILE = process.env.DESKTOP_PROFILE_DIR || '/root/.config/Codex';
// 🔴 真正存登录态的是这个文件，不是 Electron 的 user-data-dir。
// 桌面端（codex-launcher）和 Codex CLI **共用** $HOME/.codex/auth.json：
// 2026-08-26 实测，清空了 /root/.config/Codex 之后桌面端**依然**是已登录状态，
// 界面直接是 Codex 主界面（Recents 里还留着上一轮那个账号的对话），
// 于是「登录按钮」永远等不到 —— 而日志上只说「按钮没渲染出来」。
// 只删 auth.json，保留 config.toml 之类的配置。
const CODEX_AUTH = process.env.CODEX_AUTH_FILE
  || `${process.env.HOME || '/root'}/.codex/auth.json`;
const CODEX_HOME = `${process.env.HOME || '/root'}/.codex`;
// 跨账号会串的本地库。用**模式**而不是列文件名：这些库带版本号
// （state_5 / logs_2 / thread_history_1 / memories_1），下次升级就变成 state_6，
// 逐个列必漏。留下 config.toml / skills / plugins / installation_id 这些真正的配置。
// 2026-08-26：只清 sessions 不够 —— 桌面端 Recents 仍挂着上一个账号的会话标题，
// 排查「三条消息是不是记到别人头上」时白查了一轮。
const STALE_STATE = /^(auth.json|session_index.jsonl|sessions|sqlite|.codex-global-state.json(.bak)?)$|.sqlite(-wal|-shm)?$/;
function wipeCodexState() {
  let names = [];
  try { names = readdirSync(CODEX_HOME); } catch { return; }
  const hit = names.filter((n) => STALE_STATE.test(n));
  for (const n of hit) {
    try { rmSync(`${CODEX_HOME}/${n}`, { recursive: true, force: true }); } catch { /* 清不掉就算了 */ }
  }
  if (hit.length) say(`已清 ~/.codex 会话/状态残留 ${hit.length} 项（跨账号 Recents 串号的来源）`);
}

// 回调命中时桌面端会把凭据写进 auth.json。这个判据**和界面渲染无关** ——
// 界面读不出来的时候（Electron 窗口挂了 / 正在重绘），它是唯一还能信的证据。
//
// 为什么非要有它：2026-08-27 两次实测，重新握手时界面读出来是空字符串，
// 于是判"没登录"→ 整轮当场死，而回调其实已经命中了。同一条路上一次成功一次失败，
// 纯看运气。而这条判据看的是文件，不看渲染。
function desktopCredFresh() {
  try { return statSync(CODEX_AUTH).mtimeMs >= T0; } catch { return false; }
}

// 桌面端起在自己的 Xvfb 上，带 CDP 端口
function startDesktop() {
  writeFileSync(URL_FILE, '');
  for (const [target, opts, label] of [
    [DESKTOP_PROFILE, { recursive: true, force: true }, 'Electron 档案'],
    [CODEX_AUTH, { force: true }, '共用凭据 auth.json'],
  ]) {
    try {
      rmSync(target, opts);
      say(`已清 ${label}：${target}`);
    } catch (error) {
      say(`清 ${label} 失败（继续）：${error?.message || '未知错误'}`);
    }
  }
  wipeCodexState();
  // 复用**整个脚本所在的那个 Xvfb**（脚本本身要用 xvfb-run 启动）。
  // 不要在这里再套一层 xvfb-run：那样会开第二个 X server，
  // 2G 内存的机器上多一个就可能把桌面端 OOM 掉（实测被杀过一次）。
  const p = spawn('bash', ['-lc',
    `PATH=/usr/local/bin:$PATH exec chatgpt --remote-debugging-port=9333 --no-sandbox`,
  ], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
  p.stdout.on('data', () => {});
  p.stderr.on('data', () => {});
  return p;
}

async function waitCdp(timeoutMs = 60000) {
  const dl = Date.now() + timeoutMs;
  while (Date.now() < dl) {
    await sleep(2000);
    try {
      const r = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(4000) });
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
  }
  return false;
}

// 桌面端主窗口（跳过 devtools 之类）
// 挑桌面端窗口。Electron 同时可能开着不止一个（隐藏窗口、空白过渡窗口），
// 原来「拿第一个非 devtools 的」会挑到空白那个 —— 2026-08-27 实测：
// 重新握手时读到的界面是空字符串，于是 60 秒等不到登录按钮、整轮当场死，
// 而真正的窗口就在旁边好好开着。
// 判据改成「有内容的优先」，一个都没内容才退回第一个。
async function desktopPage(b) {
  const pages = [];
  for (const c of b.contexts()) {
    for (const p of c.pages()) {
      if (!/devtools/i.test(p.url())) pages.push(p);
    }
  }
  if (!pages.length) return null;
  for (const p of pages) {
    const text = await p.locator('body').innerText().catch(() => '');
    if (String(text).trim()) return p;
  }
  return pages[0];
}

// 界面文本读一次可能读空（Electron 正在重绘、窗口刚切）。
// 读空就判「没登录 / 没按钮」太急，2026-08-27 就是这么把一轮判死的。
async function desktopText(dp, tries = 5) {
  for (let i = 0; i < tries; i += 1) {
    const text = (await dp.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (text) return text;
    await sleep(1500);
  }
  return '';
}

// 轮询等某个按钮真的渲染出来。
//
// **不要用固定 sleep 代替这个函数。** CDP 端口通 ≠ 界面画好：
// 实测 CDP 4s 就绪，但登录按钮要 14s 才出现（probe-callback.mjs v2 实测）。
// 原来这里写的是 sleep(4000) 然后直接点，必然点空 ——
// 点空之后桌面端不会发起 OAuth，xdg-open 抓不到链接，整条链路停在
// 「Sign in to ChatGPT」这一屏，而日志里只留下一句"没找到"。
async function waitForButton(page, pattern, label, timeoutMs = 120000) {
  const dl = Date.now() + timeoutMs;
  while (Date.now() < dl) {
    const found = await page.evaluate((src) => {
      const re = new RegExp(src, 'i');
      return [...document.querySelectorAll('button,a,[role="button"],[role="menuitem"]')]
        .some((e) => re.test((e.innerText || e.textContent || '').trim()));
    }, pattern).catch(() => false);
    if (found) { say(`[${label}] 已渲染`); return true; }
    await sleep(2000);
  }
  say(`[${label}] 等了 ${timeoutMs / 1000}s 仍未出现`);
  return false;
}

// 原生 DOM 点击：Electron 界面里同样有覆盖层，Playwright 的可点性检查会卡死
async function domClick(page, pattern, label) {
  const ok = await page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    // 引导页的选项是 <label> 包 <span class="truncate">（还有 12 个隐藏 radio），
    // 只查 button/a/role=button 一个都找不到 —— 实测就卡在这：Continue 点得动、
    // 选项没选中，于是同一屏反复出现 8 次直到循环耗尽。
    const els = [...document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="option"], label, span')];
    const hits = els.filter((e) => re.test((e.innerText || e.textContent || '').trim()));
    if (!hits.length) return false;
    // 取最内层那个，再上溯到 label：点 span 不一定触发 label 关联的 radio
    const inner = hits.filter((e) => !hits.some((o) => o !== e && e.contains(o)));
    const hit = (inner[0] || hits[0]).closest('label') || inner[0] || hits[0];
    hit.click();
    return true;
  }, pattern).catch(() => false);
  say(`点击[${label}]: ${ok ? '命中' : '没找到'}`);
  return ok;
}

// 桌面端的 OAuth 回调监听。ECONNREFUSED 才算「没起来」；
// 起来了会回 400 State mismatch（假 code 打过去的正常响应，probe-callback.mjs 实测过），
// 那也算活着 —— 所以判据是「连得上」，不是「返回成功」。
async function callbackPortAlive() {
  try {
    await fetch('http://127.0.0.1:1455/auth/callback?code=probe', { signal: AbortSignal.timeout(2500) });
    return true;
  } catch (e) {
    const msg = String(e?.message || e);
    if (/ECONNREFUSED|fetch failed/i.test(msg)) return false;
    // 超时/abort = 端口在但不响应，对我们等价于「用不了」。
    // 原来这里返回 true，等于把卡死的端口当健康的，重新握手的恢复路径永远不触发。
    if (/abort|timeout/i.test(msg)) { say(`1455 探测超时（当作不可用）：${msg}`); return false; }
    return true;
  }
}

const SIGNIN_RE = '^(continue to sign in|sign in|log in|登录|继续登录)$';

// 只认「第 n 行之后」新出现的链接。重新握手时旧链接还躺在文件里，
// 拿旧的去走 OAuth 必然 state mismatch。
function capturedUrlSince(startLine, re = /auth\.openai\.com|chatgpt\.com/) {
  if (!existsSync(URL_FILE)) return '';
  const lines = readFileSync(URL_FILE, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  return [...lines.slice(startLine)].reverse().find((u) => re.test(u)) || '';
}

function urlFileLines() {
  if (!existsSync(URL_FILE)) return 0;
  return readFileSync(URL_FILE, 'utf8').split('\n').filter((l) => l.trim()).length;
}

// 让桌面端重新发起一次 OAuth，拿到**新的** authUrl 和**新的** 1455 监听。
//
// 为什么需要它：实测桌面端的 1455 回调监听只活约 60 秒，而 OAuth 里如果撞上
// 手机验证（取号 + 等短信 + 提交 ≈ 40 秒），走完时端口早没了 ——
// 2026-08-25 那轮就是这么死的：窗口 148s 拿到链接，213s 时 1455 已掉。
// 慢步骤做完之后重新握手，第二次 OAuth 因为会话已在、手机已验，几秒就能走完。
async function handshakeDesktop(cancelFirst = false, restarted = false) {
  const before = urlFileLines();
  const b = await chromium.connectOverCDP(CDP);
  const dp = await desktopPage(b);
  if (!dp) { await b.close(); throw new Error('桌面端没有可用窗口'); }
  if (cancelFirst) {
    // 🔴 取消是**破坏性**的 —— 它把桌面端那次 OAuth 作废。调用方虽然查过 1455，
    // 但那之后还隔着 connectOverCDP + 找窗口的几秒，回调完全可能正好在这几秒里落地。
    // 那一刻取消，等于亲手毁掉一次已经成功的登录。所以贴着点击再复查一次。
    if (await callbackPortAlive()) {
      await b.close();
      return 'CALLBACK_ALIVE';
    }
    // 桌面端此刻停在「等浏览器登录」态，没有登录按钮，得先取消
    await domClick(dp, '^(cancel sign-in|cancel|取消登录|取消)$', '取消上一次登录');
    await sleep(4000);
  }
  if (!(await waitForButton(dp, SIGNIN_RE, '桌面端登录按钮', 60000))) {
    // 登录按钮不出现有两种完全不同的原因：真出问题了，还是**已经登录了**。
    // 已登录时它既没有登录按钮也没有取消按钮 —— 硬抛错就等于把一次成功
    // 判成失败（2026-08-26 实测踩到）。所以先分辨清楚再决定。
    // 🔴 登录按钮不出现有三种情况，必须分清：真出问题 / 已经登录了 / 还停在等待屏。
    // 原来是纯反向判据（"不是登录页就算已登录"），而「等浏览器登录」那一屏
    // 恰恰是三个调用点上桌面端的**默认状态** —— 判成已登录就会报假成功、
    // 跳出循环、关掉唯一持有 OAuth 会话的浏览器，之后救不回来。
    const txt = await desktopText(dp);
    await b.close();
    if (desktopTextNeedsLogin(txt) && !/sign in to chatgpt|sign up/i.test(txt)) {
      throw new Error(`桌面端仍停在「等浏览器登录」屏（取消没点动）：${txt.slice(0, 100)}`);
    }
    if (desktopTextLoggedIn(txt)) {
      say(`没有登录按钮，且拿到已登录的正向证据 —— 判为已登录：${txt.slice(0, 70)}`);
      return null;
    }
    // 界面读不出任何内容：这时**不能**按界面判死。先看凭据文件 ——
    // 它和渲染无关，回调命中过就一定在。
    if (!txt.trim()) {
      if (desktopCredFresh()) {
        say('界面读不出内容，但 auth.json 是本轮写的 —— 回调已命中，判为已登录');
        return null;
      }
      // 凭据也没有 = 桌面端真的挂了。重启它再握一次手；浏览器会话还在，
      // 第二次 OAuth 通常是纯授权确认，几秒就到回调。
      // 只重启一次，避免桌面端本身有问题时无限循环。
      if (!restarted) {
        say('桌面端界面全空且无凭据 —— 重启桌面端，再握一次手');
        killDesktop();
        await sleep(3000);
        desktop = startDesktop();
        if (!(await waitCdp(70000))) throw new Error('重启后桌面端 CDP 没起来');
        return handshakeDesktop(cancelFirst, true);
      }
    }
    throw new Error(`桌面端登录按钮没渲染出来，界面：${txt.slice(0, 100) || '(空)'}`);
  }
  if (!(await domClick(dp, SIGNIN_RE, '桌面端登录'))) { await b.close(); throw new Error('登录按钮点击落空'); }
  let alive = false;
  for (let i = 0; i < 20 && !alive; i += 1) { await sleep(2000); alive = await callbackPortAlive(); }
  say(alive ? '✅ 1455 回调监听已就绪' : '❌ 1455 始终没起来');
  if (!alive) { await b.close(); throw new Error('桌面端没有起 1455 回调监听'); }
  let url = '';
  for (let i = 0; i < 20 && !url; i += 1) { await sleep(1500); url = capturedUrlSince(before); }
  await b.close();
  if (!url) throw new Error('没抓到新的 OAuth 链接（检查 /tmp/opened-urls.txt）');
  return url;
}

// 引导问卷有多屏，每屏的选项都不一样（工作类型 / 用途 / 团队规模…）。
// 只认死几个词，换一屏就选不中，然后 Continue 点了也不动，卡到超时。
// 所以兜底：认不出具体选项时，就挑第一个真正的选项（label 里带 radio/checkbox）。
async function pickAnyOption(page) {
  return page.evaluate(() => {
    const labels = [...document.querySelectorAll('label')].filter((el) => {
      const t = (el.innerText || '').trim();
      if (!t || t.length > 40) return false;
      return el.querySelector('input[type="radio"], input[type="checkbox"]') || el.htmlFor;
    });
    if (!labels.length) return '';
    labels[0].click();
    return (labels[0].innerText || '').trim().slice(0, 20);
  }).catch(() => '');
}

// 桌面端到底登进去没有。判据只看它**不是**登录页、也**不是**等待页 ——
// 登录之后它会显示欢迎问卷或聊天界面，文案随版本变，反着判更稳。
async function desktopLoggedIn() {
  try {
    const conn = await chromium.connectOverCDP(CDP);
    const pg = await desktopPage(conn);
    const t = pg ? (await pg.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ') : '';
    await conn.close();
    return desktopTextLoggedIn(t);
  } catch {
    return false;
  }
}


// 导航要能扛住瞬时网络错误。
//
// 2026-08-26 实测：OAuth 那一跳报 net::ERR_CERT_VERIFIER_CHANGED 直接把整轮打掉，
// 而当时网络、证书包、系统时间全是好的 —— 那是 Chromium 内部证书校验器被重新
// 配置时的瞬时事件，重试一次就过去了。一个邀请名额不该赔在这种事上。
// 只对**瞬时**错误重试：证书/网络/超时。真的 4xx 页面不在此列，那要如实失败。
const TRANSIENT_NAV = /ERR_CERT_VERIFIER_CHANGED|ERR_NETWORK_CHANGED|ERR_CONNECTION_(RESET|CLOSED|ABORTED|FAILED)|ERR_TIMED_OUT|ERR_EMPTY_RESPONSE|ERR_SOCKET_NOT_CONNECTED|Timeout .* exceeded/i;
async function gotoRetry(page, url, label, tries = 3) {
  let last;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (error) {
      last = error;
      const msg = String(error?.message || error);
      if (!TRANSIENT_NAV.test(msg)) throw error;
      say(`${label} 导航瞬时失败（第 ${i + 1}/${tries} 次）：${msg.split('\n')[0].slice(0, 90)}`);
      await sleep(3000 * (i + 1));
    }
  }
  throw last;
}

// 慢步骤（等短信 / 等邮箱验证码 / 页面卡住）之后统一走这个。
//
// 🔴 1455 只活约 60 秒，而 OAuth 里等邮箱验证码可以等 180 秒 —— 结构性必输。
// 原来只有手机验证分支做了这件事，邮箱 OTP 分支没有，所以只要 OAuth 要求邮箱码就必挂，
// 而那一刻账号、浏览器会话、桌面端全是好的，**唯一缺的就是重新握手一次**。
async function renewIfCallbackDead(page, why) {
  if (await callbackPortAlive()) return null;
  say(`${why} 期间 1455 已超时 —— 重新握手拿新链接`);
  const fresh = await handshakeDesktop(true);
  // 复查时 1455 又活了：上一次 OAuth 还有效，保留旧链接继续走，别重来
  if (fresh === 'CALLBACK_ALIVE') { say('临取消前复查：1455 又活了 —— 保留上一次 OAuth'); return null; }
  // null = 桌面端本来就已经登录了，回调其实命中过，不需要新链接
  if (!fresh) { say('桌面端已登录 —— 回调其实命中了，无需重新握手'); return 'ALREADY_LOGGED_IN'; }
  await gotoRetry(page, fresh, '重新握手后的 OAuth').catch((error) => say(`重新握手后导航失败：${error.message}`));
  await sleep(5000);
  return fresh;
}

// 🔴 账号存活窗口硬闸。各段慢步骤加起来最坏能到 36 分钟，而窗口只有 10-13 分钟。
// 每个慢步骤**开跑前**先问「还剩多少预算」，不够就当场认输 ——
// 别再花 $0.16 买一个注定用不上的号，别再多等 3 分钟等一个已经停用的账号。
// env 解析必须拒绝毒输入："11m"/"abc" 会变成 NaN（所有比较恒 false，闸静默失效），
// 一个空格会变成 0（每个慢步骤必抛，每轮必死）。实测都复现过。
function envMs(name, dflt) {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} 必须是正整数毫秒，收到：${JSON.stringify(process.env[name])}`);
  }
  return n;
}

// 🟡 默认放到 25 分钟：账号真实存活窗口目前**两说互斥且未裁决**
// （代码注释说 10 分钟、vault ops-002 实测 25-55 分钟）。
// 拿一个未裁决的假设去做会 throw 的硬闸，可能打死本来能成的运行 ——
// 所以先只拦真正的失控，等窗口测准了再收紧。
const WINDOW_BUDGET_MS = envMs('WINDOW_BUDGET_MS', 25 * 60 * 1000);
const winLeft = () => (W0 ? WINDOW_BUDGET_MS - (Date.now() - W0) : WINDOW_BUDGET_MS);
function needBudget(ms, what) {
  const left = winLeft();
  say(`预算检查[${what}]：需 ${Math.round(ms / 1000)}s，剩 ${Math.round(left / 1000)}s`);
  if (left < ms) {
    throw new Error(`窗口预算不足：${what} 需 ${Math.round(ms / 1000)}s，只剩 ${Math.round(left / 1000)}s —— 提前认输，不再烧钱`);
  }
}

// 🟠 listMails 在收件箱读失败时**必抛**（那条「整批查不到=故障」的硬规则本身是对的）。
// 但 Graph 的 429/503 是常态，抛在 OAuth 循环里就是白烧一个邀请名额。
// 只读操作重试是安全的：重试尽了还失败，才叫「查不到」。
async function listMailsRetry(opts, tries = 3) {
  let last;
  for (let i = 0; i < tries; i += 1) {
    try { return await listMails(opts); } catch (error) {
      last = error;
      say(`收信失败（第 ${i + 1}/${tries} 次）：${error?.message || error}`);
      await sleep(3000 * (i + 1));
    }
  }
  throw last;
}

// OpenAI 的「创建密码」屏要求至少 12 位。给足 20 位并保证四类字符都有 ——
// 只丢一串随机字母有概率不满足规则，而那一屏不满足就一直亮红框，
// 从外面看和"点了没反应"一模一样。
function makePassword() {
  const pools = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%^&*-_'];
  const bytes = randomBytes(64);
  const chars = pools.map((pool, i) => pool[bytes[i] % pool.length]);   // 四类各保底一个
  const all = pools.join('');
  for (let i = chars.length; i < 20; i += 1) chars.push(all[bytes[i + 8] % all.length]);
  // 洗牌，别让前四位固定是「大写小写数字符号」
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = bytes[i + 32] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// 接码：泰国，跳过最便宜的几档。
// 便宜档是被反复回收的号池，注册时大概率被判「已被使用」——安哥明确要求至少第 3 档。
async function pickThaiNumber(minRank = 3) {
  // 🟡 报价和取号必须问同一个国家/服务。原来这里写死 service:'dr', country:52，
  // 而 requestNumber 走的是 config.heroSms —— 只要 .env 设了 HERO_SMS_COUNTRY，
  // 就会「按泰国的档位算出价格，再拿这个价去另一个国家买号」，档位对不上。
  const { country, service } = config.heroSms;
  const q = await fetchPriceQuotes({ service, country });
  const tiers = (q.quotes || []).map((e) => ({ price: Number(e.price), count: Number(e.count) || 0 }))
    .filter((t) => t.price > 0).sort((a, b) => a.price - b.price);
  if (!tiers.length) throw new Error(`国家 ${country} 没有可用报价`);
  // 档位不够就认输，不要静默降级去买最便宜那档 —— 那正是明令禁止的：
  // 便宜档是被反复回收的号池，注册大概率被判「已被使用」，赔上 $0.16 和一个邀请名额。
  if (tiers.length < minRank) {
    throw new Error(`国家 ${country} 只有 ${tiers.length} 个可用档位，凑不满第 ${minRank} 档 —— 本轮不取号（便宜档=回收号池，注册必废）`);
  }
  const idx = minRank - 1;
  const c = tiers[idx];
  say(`国家 ${country} 档位 ${tiers.slice(0, 6).map((t) => '$' + t.price + '(' + t.count + ')').join(' ')}`);
  say(`取第 ${idx + 1} 档（跳过最便宜的 ${idx} 档）→ $${c.price}，剩 ${c.count} 个`);
  const num = await requestNumber({ price: c.price });
  activationId = num.activationId;
  say(`已取号 +${num.phone}`);
  return num;
}

// 在给定页面上把手机验证走完（OAuth 页里弹出来的那一段）
async function doPhone(page) {
  needBudget(5 * 60 * 1000, '手机验证');
  const num = await pickThaiNumber(3);
  const sub = await submitPhoneNumber(page, String(num.phone).replace(/^\+/, ''), num.dialCode, '', num.nationalNumber, num.isoCountry);
  if (!sub.ok) throw new Error('提交手机号失败：' + sub.reason);
  say('手机号已提交，等短信…');
  let code = '';
  let rawSms = '';
  const dl = Date.now() + 4 * 60 * 1000;
  while (Date.now() < dl && !code) {
    await sleep(4000);
    const st = await getStatus(activationId);
    if (st.state === 'code' && st.code) { code = st.code; rawSms = st.sms || ''; }
    if (st.state === 'cancel') throw new Error('接码订单被平台取消');
  }
  if (!code) throw new Error('4 分钟没等到短信');
  say(`短信码 ${code}`);
  // 只记抽出来的码不够：2026-08-26 那次抽到 155555（形状可疑），事后完全无法判定
  // 是 extractCode 抽错、还是回收号收到了别的服务的短信。原文一并留下。
  if (rawSms) say(`  ↳ 短信原文：${String(rawSms).replace(/s+/g, ' ').slice(0, 160)}`);
  const f = await fillSmsCodeAndSubmit(page, code);
  if (!f.ok) throw new Error('填短信码失败：' + f.reason);
  // 🔴 fillSmsCodeAndSubmit 点完提交就返回 ok，**不看服务端认没认**。
  // 原来这里直接 finishNumber（不可退）—— 码被拒也照付钱，而页面还停在
  // 手机验证码页，下游只认 phone_number，于是转去把它当邮箱验证码等 3 分钟。
  // 判据落在产物上：手机验证码框消失才算被接受。
  // 判据要落在「离开整个手机验证流程」上，而且要连续两次读到同一结果。
  //
  // detectPhoneStage 有三个返回值，原来只排除了 phone_code —— 而 OpenAI 拒号时
  // 会**退回重填手机号页**（返回 phone_number），那一样会被判成「接受」，
  // 然后给一个被拒的号付不可退的钱。
  // 另外 isVisible 在 React 重渲染时可能瞬时读空，单次采样即定案同样会误付钱。
  let accepted = false;
  let clean = 0;
  const vdl = Date.now() + 30000;
  while (Date.now() < vdl && !accepted) {
    await sleep(2000);
    const st = await detectPhoneStage(page);
    if (st === 'phone_code') { clean = 0; continue; }
    if (st === 'phone_number') {
      throw new Error(`短信码 ${code} 被拒：页面退回重填手机号页，需换号重试`);
    }
    clean += 1;
    accepted = clean >= 2;
  }
  if (!accepted) throw new Error(`短信码 ${code} 提交后 30 秒仍停在手机验证页 —— 判为被拒`);
  await finishNumber(activationId);
  activationId = null;
  await sleep(8000);
}

// ============================================================
let browser = null;
// 阶段 5 用来接管桌面端的 CDP 连接和页面。必须在 try 外声明：
// 阶段 3 重构成 handshakeDesktop() 之后这两个变量没了宿主，
// 而阶段 5 还在直接赋值 —— ESM 是严格模式，那是 ReferenceError。
let b = null;
let dp = null;
// 退出码必须反映成败。原来 finally 里写死 process.exit(0)，
// 失败也报 0 —— 无人值守跑的时候，外面完全没法判断这一轮成没成。
let failed = false;
// 无人值守必须有兜底：任何一步挂住（browser.close 卡死 / CDP 不回 / Graph 挂起）
// 都不能让进程永远不退出 —— 外面看到的是「还在跑」，实际早死了，名额也过期了。
const HARD_KILL_MS = envMs('HARD_KILL_MS', 40 * 60 * 1000);
// 🔴 process.exit **会跳过 catch 和 finally**（实测确认），而退号逻辑写在 catch 里。
// 所以这两条硬退出路径必须自己把没用完的接码号退掉，否则每次硬超时都白扔 $0.16。
async function bailOut(code, why) {
  console.log(`\n❌ ${why}`);
  if (activationId) {
    await Promise.race([cancelNumber(activationId).catch(() => {}), sleep(5000)]);
    console.log('   已退掉没用完的号');
    activationId = null;
  }
  try { killDesktop(); } catch { /* 尽力 */ }
  process.exit(code);
}
const watchdog = setTimeout(() => {
  bailOut(2, `硬超时 ${Math.round(HARD_KILL_MS / 1000)}s，强制退出`);
}, HARD_KILL_MS);
watchdog.unref();
process.on('unhandledRejection', (error) => {
  bailOut(3, `未捕获的 Promise 拒绝：${error?.message || error}`);
});
try {
  mkdirSync(SHOTS, { recursive: true });
  killDesktop();

  // 收件地址怎么定：
  //   · cloudflare（一次性域）—— 只有它才有「现建一个地址」这回事
  //   · outlook / webmail —— 地址就是那个微软账号本身，直接取 WEBMAIL_USER
  // 一个 outlook 只能收一次邀请、每轮都要换号，参数越少越不容易填错。
  // 拿不到地址时必须当场报错：悄悄回落到 tempmail 域会让整轮分错组，而且事后看不出来。
  const address = process.env.ADDRESS
    || (['webmail', 'outlook'].includes(mailProviderName()) ? String(process.env.WEBMAIL_USER || '').trim() : '')
    || (mailProviderName() === 'cloudflare'
      ? (await createAddress({ name: `dk${Date.now().toString(36)}` })).address
      : '');
  if (!address) {
    throw new Error(`MAIL_PROVIDER=${mailProviderName()} 时必须给 ADDRESS（webmail 臂也可以只给 WEBMAIL_USER）`);
  }
  say(`邮箱来源: ${mailProviderName()}｜收件地址: ${address}`);
  console.log('\n########################################');
  console.log('#  收件邮箱: ' + address);
  console.log('########################################\n');

  // ---------- 阶段 1：等邀请 ----------
  // 显式指定 ADDRESS = 复用模式（上一轮失败了、信箱里那封邀请还能用）。
  // 这时候**不能**把已有邮件全设成基线，否则会把要用的那封自己排除掉，
  // 然后干等一封永远不会再来的新邀请。
  // INVITE_URL 是排查用的旁路（跳过等邮件）。正常全自动流程不走它 ——
  // 买家那边不可能人工复制链接。
  let inviteUrl = String(process.env.INVITE_URL || '').trim();
  if (inviteUrl) {
    say('⚠️ 用直接给定的邀请链接 —— 这是排查旁路，不是全自动路径');
  } else {
    // 要不要把「已经在信箱里的邀请」排除掉？
    //
    // 微软臂（outlook/webmail）：**不排除**。一个 outlook 只能收一次邀请，
    // 信箱里那封就是我们要的那封；而实际顺序是「先发邀请、再让脚本跑」，
    // 把它设成基线就会干等一封永远不会再来的新邀请（2026-08-25 已经这么废过一轮）。
    //
    // cloudflare 臂（一次性域）：**排除**。同一个地址可能被上一轮用过，
    // 旧邀请早已失效，拿它去跑必然报「邀请无效」。
    const microsoftArm = ['outlook', 'webmail'].includes(mailProviderName());
    const reuse = microsoftArm || Boolean(process.env.ADDRESS);
    say(reuse ? '直接认信箱里现有的邀请（微软号一号一邀，不设基线）' : '等待新邀请邮件（最多 40 分钟）…');
    const baseline = reuse ? [] : (await listMailsRetry({ address, limit: 50 })).mails.map((m) => String(m.id));
    let invite = null;
    const t0 = Date.now();
    const idl = t0 + 40 * 60 * 1000;
    // 🔴 无人值守的硬要求：这段最长等 40 分钟，原来**一行都不打** ——
    // 2026-08-27 实测等了 13 分钟零输出，从日志上完全分不清「在等邀请」和
    // 「进程挂了」。而这正是要人盯着的唯一理由。
    // 心跳顺带把信箱里**实际有什么**打出来：邀请没到时，这几行就是诊断本身
    //（那次一看就知道只有微软安全通知、OpenAI 根本没投递）。
    let lastBeat = 0;
    while (Date.now() < idl && !invite) {
      await sleep(4000);
      const box = (await listMailsRetry({ address, limit: 50 })).mails;
      invite = findInvitationMail(box, baseline);
      if (!invite && Date.now() - lastBeat >= 60000) {
        lastBeat = Date.now();
        const heads = box.slice(0, 3).map((m) => String(m.subject || '(无主题)').slice(0, 24)).join(' / ');
        say(`仍在等邀请（已等 ${Math.round((Date.now() - t0) / 1000)}s；信箱 ${box.length} 封：${heads || '空'}）`);
      }
    }
    if (!invite) throw new Error('40 分钟没等到邀请');
    inviteUrl = inviteUrlOf(invite);
  }

  W0 = Date.now();                                   // ← 存活窗口从这里开始计时
  const elig = inspectInviteReferral(inviteUrl);
  say(`收到邀请：奖励=${elig.hasRewards} 类型=${elig.referralType}`);
  if (elig.noRewards) say('⚠️ 这封标记为不带奖励，跑完也不会入账');

  // ---------- 阶段 2：建账号（独占浏览器）----------
  browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
  let page = await (await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } })).newPage();
  await gotoRetry(page, inviteUrl, '打开邀请链接');
  const otpBase = (await listMailsRetry({ address, limit: 50 })).mails.map((m) => String(m.id));
  const r1 = await driveToOtp(page, address, { beforeEmailSubmit: async () => {} });
  say(`打开邀请后状态=${r1.state}`);

  // 🔴 driveToOtp 的其余返回状态**必须处理**。原来这里只认 waiting_otp，
  // 别的状态一律被无视，然后照样打「✅ 账号已建成」继续往下跑 ——
  // 2026-08-26 接线验证实测：邀请已被用过时它报 invalid_invite，
  // 脚本却宣布建号成功、接着去起桌面端。无人值守时这会带着一个不存在的账号跑完全程。
  if (r1.state === 'invalid_invite') {
    await page.screenshot({ path: `${SHOTS}/dk-X-invalid-invite.png`, fullPage: true }).catch(() => {});
    throw new Error(`邀请无效或已被使用：${r1.reason || 'invalid_invite'}`);
  }
  if (r1.state === 'phone_required') {
    say('打开邀请就要求手机验证 —— 先做掉');
    await doPhone(page);
    // 手机过了 != 账号建好。做完必须重判，否则会带着一个没建成的账号跑完后面三个阶段。
    const r2 = await driveToOtp(page, address, { beforeEmailSubmit: async () => {} });
    say(`手机验证后重判状态=${r2.state}`);
    r1.state = r2.state; r1.reason = r2.reason;
  }
  // profile_required 是**可救**的：下面第二段就有现成的资料页处理代码。
  // 原来它落进「未处理的状态」被 throw 掉 —— 邀请名额已经消耗，白烧一个。
  if (!['waiting_otp', 'succeeded', 'profile_required'].includes(r1.state)) {
    await page.screenshot({ path: `${SHOTS}/dk-X-unexpected.png`, fullPage: true }).catch(() => {});
    throw new Error(`打开邀请后落到未处理的状态 ${r1.state}：${r1.reason || '无原因'}`);
  }

  if (r1.state === 'waiting_otp') {
    let otp = null;
    const dl = Date.now() + 4 * 60 * 1000;
    while (Date.now() < dl && !otp) {
      await sleep(3000);
      otp = findOtpMail((await listMailsRetry({ address, limit: 50 })).mails, otpBase);
    }
    if (!otp) throw new Error('没等到邮箱验证码');
    say(`OTP ${otp.code}`);
    const f = await fillOtpAndSubmit(page, otp.code);
    if (!f.ok) throw new Error('填 OTP 失败：' + f.reason);
    await sleep(6000);
  }
  if (await detectProfileStage(page)) {
    const prof = makeProfile();
    say(`填资料 ${prof.name}, ${prof.age} 岁`);
    const f = await fillProfileAndSubmit(page, prof);
    if (!f.ok) throw new Error('填资料失败：' + f.reason);
    for (let i = 0; i < 25 && await detectProfileStage(page); i += 1) await sleep(700);
  }
  say(`✅ 账号已建成（${mem()}）`);
  await page.screenshot({ path: `${SHOTS}/dk-1-account.png` }).catch(() => {});

  // ---------- 阶段 2.5：把账号弄到 ready，**并且保住这个浏览器的登录态** ----------
  //
  // 🔴 这里原来是 `await browser.close()`，理由是「给桌面端腾内存」。那是 2026-08-25 那轮
  // 失败的真根因：关掉之后阶段 4 开的是一个**全新浏览器、零会话**，
  // 于是 OAuth 必须从头再走一遍邮箱 → OTP → 手机验证，整整 100 秒；
  // 而桌面端的 localhost:1455 回调监听等不了那么久，回调打到死端口，
  // 浏览器停在连不上的错误页，脚本就在那儿「推进：没找到」刷屏到超时。
  //
  // 省下的内存实测只有几百 MB（2G + 1G swap 扛得住并存，全程无 OOM），
  // 换来的是「回调必然超时」。所以：**留着这个浏览器**，让阶段 4 的 OAuth 认出已有会话秒过。
  //
  // 顺带把手机验证提前到这里做：它是 OAuth 里最慢的一段（取号 + 等短信约 60 秒），
  // 挪出关键路径之后，回调窗口才有富余。
  await page.goto('https://chatgpt.com/codex', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sleep(6000);
  const readyStage = await detectPhoneStage(page);
  if (readyStage === 'phone_number') {
    say('建号后仍需手机验证 —— 在这里做掉，不留到 OAuth 里');
    await doPhone(page);
    await page.screenshot({ path: `${SHOTS}/dk-1b-phone.png` }).catch(() => {});
  } else {
    say(`账号已 ready（${readyStage || '这一步没要手机验证'}）`);
  }

  // ---------- 阶段 3：起桌面端，拿它的 OAuth 链接 ----------
  say('启动官方 ChatGPT 桌面端…');
  desktop = startDesktop();
  if (!(await waitCdp(70000))) throw new Error('桌面端 CDP 没起来（多半是 OOM，检查内存）');
  say('桌面端 CDP 就绪');

  let authUrl = await handshakeDesktop(false);
  // 这里返回 null 只有一个意思：桌面端起来就已是登录态。而上面刚清过 auth.json
  // 和 Electron 档案，所以只可能是上一轮进程没杀干净、连上的是**旧桌面端**
  // （登录的是上一个账号）。用它发消息 = 把额度算到别人头上，必须中止。
  if (!authUrl) {
    throw new Error('桌面端起来就已是登录态 —— 多半是上一轮进程没杀干净（9333 被占），本轮中止');
  }
  say(`抓到桌面端 OAuth 链接: ${authUrl.slice(0, 100)}…`);

  // ---------- 阶段 4：用**阶段 2 那个已登录的浏览器**完成 OAuth ----------
  // 会话还在，所以这里应该是「确认授权」而不是「重新登录一遍」，几秒就该跳到回调。
  // 下面处理邮箱/OTP/手机的分支全部保留 —— 万一 OpenAI 要求重新验证，还能兜住。
  say(`用已登录的浏览器走 OAuth（${mem()}）`);
  // ===== 导航留痕 =====
  // 上一轮排查最贵的地方就是"不知道浏览器最后停在哪"。文案判据会骗人
  // （OpenAI 改一句话就失效），**导航到 redirect_uri 才是不变量**：
  // 只要主框架导航到 localhost:1455/auth/callback，OAuth 就是真的走完了。
  // probe-callback.mjs 实测：该端点活着，且会校验 state（假 state 返回 400 State mismatch），
  // 所以不能靠伪造回调绕过，只能让浏览器自己走到那一步。
  const navTrail = [];
  let callbackHit = null;
  page.on('framenavigated', (f) => {
    if (f !== page.mainFrame()) return;
    const u = f.url();
    navTrail.push(`[+${el()}] ${u.slice(0, 150)}`);
    if (/127\.0\.0\.1:1455|localhost:1455/.test(u)) {
      callbackHit = u;
      say(`✅ 浏览器已导航到回调: ${u.slice(0, 120)}`);
    }
  });

  await gotoRetry(page, authUrl, 'OAuth');
  await sleep(5000);
  say(`OAuth 页: ${page.url()}`);

  // 7 分钟只是名义上限；真正的约束是账号存活窗口，取两者较小的
  const odl = Math.min(Date.now() + 7 * 60 * 1000, (W0 || Date.now()) + WINDOW_BUDGET_MS);
  // 手机验证允许试两次：OpenAI 服务端超时那次的号就废了，重试要换新号。
  // 两次封顶，免得一直烧接码费。
  let phoneTries = 0;
  let stuck = 0;
  // 🔴 stuck 只在**点不到**东西时才增长。而 2026-08-27 那次是点得到、
  // 每次都「命中」、页面却纹丝不动 —— 于是循环空转 135 轮直到总超时。
  // 判据必须落在**页面有没有变**上，不是落在"点击这个动作成没成功"上。
  let lastSig = '';
  let sameSig = 0;
  let renewed = false;
  // OAuth 阶段那封 OTP 的基线，在提交邮箱那一刻才记（见下）
  let oauthOtpBase = (await listMailsRetry({ address, limit: 50 })).mails.map((m) => String(m.id));
  while (Date.now() < odl) {
    if (callbackHit) { say('OAuth 完成（依据：已导航到 redirect_uri）'); break; }
    const t = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
    // 判据要收紧：原来只要正文里有 "success" 就算完成，随便一段文案都可能命中。
    // 真正的完成态是 OpenAI 那句「可以关掉这个页面 / 回到应用」，
    // 而且页面上不能还留着登录入口。
    const done = /可以关闭此页|可以关闭这个|你已完成登录|已成功登录|successfully (signed|logged) in|you may (now )?close|return to the app|回到应用/i.test(t);
    if (done && !/sign in to|登录以继续|输入.*验证码/i.test(t)) {
      say('OAuth 页显示已完成'); break;
    }
    // 页面指纹：URL + 正文开头。连续不变 = 我们在原地打转。
    const sig = `${page.url()}|${t.slice(0, 300)}`;
    if (sig === lastSig) sameSig += 1; else { sameSig = 0; lastSig = sig; }
    if (sameSig >= 15) {
      await page.screenshot({ path: SHOTS + '/dk-X-noprogress.png', fullPage: true }).catch(() => {});
      throw new Error(`OAuth 原地打转：连续 ${sameSig} 轮页面无变化，停在 ${page.url()}｜${t.slice(0, 160)}`);
    }

    const stage = await detectPhoneStage(page);
    // 停在**手机**验证码页 = 上一条短信码没被接受。必须单独认出来：
    // 否则下面的 otpBox（input[name="code"]）会命中同名的手机验证码框，
    // 脚本转去等 3 分钟永远不会来的邮箱验证码，把排查方向指向邮箱侧。
    if (stage === 'phone_code') {
      // 🔴 2026-08-26 实测：doPhone 判「已接受」并 finishNumber（钱已付、订单已关）之后，
      // 页面又回到了这一屏 —— 空的验证码框、没有任何错误提示。也就是说
      // doPhone 的接受判据会假阳性（多半是回收号收到的是别的服务的短信）。
      // 原来这里无条件硬抛，整轮当场死掉，而 phoneTries 明明还有 3 次预算，
      // 那 3 次只对「退回重填手机号页」生效 —— 对最常见的失败形态用不上。
      // 改法：还有预算就退回 add-phone 换个号重来；订单已关，只能买新号。
      if (phoneTries >= 3) {
        await page.screenshot({ path: SHOTS + '/dk-X-phonecode-stuck.png', fullPage: true }).catch(() => {});
        throw new Error('停在手机验证码页且换号次数已用尽 —— 上一条短信码未被接受');
      }
      say('停在手机验证码页 —— 上一条码没被接受，退回重填手机号换个号再来');
      if (activationId) { await cancelNumber(activationId).catch(() => {}); activationId = null; }
      await gotoRetry(page, 'https://auth.openai.com/add-phone', '退回重填手机号')
        .catch((error) => say(`退回 add-phone 失败：${error.message}`));
      await sleep(4000);
      continue;
    }
    if (stage === 'phone_number') {
      // 🔴 原来写的是 phoneTries < 3：次数用尽后条件转假，页面明明还卡在手机号页，
      // 却掉进下面的通用推进循环里空转到 odl（实测约 83 轮无效点击）。
      // 三次都没过就是没过，当场认输，把剩下的窗口留给下一个号。
      if (phoneTries >= 3) {
        await page.screenshot({ path: SHOTS + '/dk-X-phone-exhausted.png', fullPage: true }).catch(() => {});
        throw new Error('手机验证三次都没过，仍停在手机号页 —— 认输，不空转到窗口耗尽');
      }
      phoneTries += 1;
      say(`需要手机验证（第 ${phoneTries} 次）`);
      // doPhone 里「4 分钟没等到短信」是直接抛错的，原来会一路冒泡出整个循环，
      // 于是 phoneTries 这套重试**根本走不到** —— 2026-08-26 实测一轮就这么废了。
      // 接码平台收不到短信是常态（号源被静默拉黑），换个号往往就好，
      // 所以这里要接住、退号、再来一次；三次都不行才认输。
      try {
        await doPhone(page);
      } catch (error) {
        if (activationId) { await cancelNumber(activationId).catch(() => {}); activationId = null; }
        if (phoneTries >= 3) throw error;
        say(`手机验证第 ${phoneTries} 次失败（${error?.message || '未知'}）—— 换个号再来`);
        await sleep(3000);
        continue;
      }
      await page.screenshot({ path: `${SHOTS}/dk-3-phone.png` }).catch(() => {});
      // 手机验证吃掉约 40 秒，而 1455 只活约 60 秒。做完先看端口还在不在：
      // 掉了就重新握手拿新链接 —— 这时账号已验完、浏览器有会话，
      // 第二次 OAuth 是纯授权确认，几秒就能到回调。
      {
        const fresh = await renewIfCallbackDead(page, '手机验证');
        if (fresh === 'ALREADY_LOGGED_IN') { callbackHit = 'desktop-logged-in'; break; }
        if (fresh) { authUrl = fresh; stuck = 0; }
      }
      continue;
    }
    // 邮箱框 → 填本轮邮箱；其余按钮 → 原生点击推进
    const em = page.locator('input[type="email"], input[autocomplete="username"]').first();
    if (await em.isVisible().catch(() => false)) {
      // **提交前先记基线**。这一步会触发第二封 OTP，而信箱里已经有建账号时那封了；
      // 不记基线就可能把旧码当新码填进去，必然失败 —— 上一轮只是侥幸没踩到。
      oauthOtpBase = (await listMailsRetry({ address, limit: 50 })).mails.map((m) => String(m.id));
      await em.fill(address);
      await domClick(page, '^(继续|continue)$', '提交邮箱');
      await sleep(5000);
      continue;
    }
    // 密码屏。两种：账号还没密码时是「创建密码」，已有密码时是「输入密码」。
    //
    // 🔴 两种都**优先改走一次性验证码**，不要设密码。
    // 上一版在这里自动生成并提交了一个密码，当场是过了 —— 但它把账号变成了
    // 「要密码才能登」，而我们没有任何地方存这个密码。于是那一轮后面一失败，
    // 重跑再开邀请链接就停在「输入密码」屏，号彻底进不去了（2026-08-27 实测）。
    //
    // 保持账号「无密码、只认一次性验证码」这一个状态，整条流水线才是同构的：
    // 失败重跑走的还是同一套 OTP 逻辑，而那套已经被多轮实跑验过。
    const pwBox = page.locator('input[type="password"]').first();
    if (await pwBox.isVisible().catch(() => false)) {
      if (await domClick(page, '使用一次性验证码|one-time (code|password)|verification code instead|使用驗證碼', '改用一次性验证码')) {
        await sleep(6000);
        continue;
      }
      // 没有一次性验证码入口才退而设密码。密码打进日志 —— worker 会把日志尾部
      // 回报进号池，真走到这条路时至少还能人工登回去。
      const secret = makePassword();
      say(`没有一次性验证码入口 —— 退而设置密码：${secret}`);
      await pwBox.fill(secret);
      await domClick(page, '^(继续|continue)$', '提交密码');
      await sleep(6000);
      continue;
    }
    // OAuth 侧的 /about-you 资料页。2026-08-27 实测：过完手机验证之后会问
    // 「你的年龄是多少？」，而这一屏**只有年龄**没有姓名（建号时已经填过）。
    // automationBrowser 的 profileInputs 要求姓名+年龄两个都在才认（那是防误判的
    // 正确设计，只有 name 的页面到处都是），所以这一屏它认不出来，
    // 通用「推进」就在这儿空点 —— 熔断器抓到的正是它。
    //
    // 闸放在**页面**上而不是放在选择器上：input[id*="age" i] 会匹配到 message，
    // 拿选择器当判据迟早在别的页面上乱填。
    if (/\/about-you/.test(page.url()) || /你的年龄|how old are you/i.test(t)) {
      const ageBox = page.locator(
        'input[name="age" i], input[id*="age" i], input[aria-label*="age" i], input[aria-label*="年龄"], input[placeholder*="年龄"]',
      ).first();
      if (await ageBox.isVisible().catch(() => false)) {
        const prof = makeProfile();
        const nameBox = page.locator('input[autocomplete="name"], input[name="name" i], input[placeholder*="姓名"]').first();
        if (await nameBox.isVisible().catch(() => false)) await nameBox.fill(prof.name);
        await ageBox.fill(String(prof.age));
        say(`OAuth 资料页：填 ${prof.age} 岁`);
        await domClick(page, '^(继续|continue|下一步|next|完成|done)$', '提交资料');
        await sleep(6000);
        continue;
      }
    }
    const otpBox = page.locator('input[autocomplete="one-time-code"], input[name="code"]').first();
    if (await otpBox.isVisible().catch(() => false)) {
      needBudget(3.5 * 60 * 1000, 'OAuth 等邮箱验证码');
      let otp = null;
      const dl2 = Date.now() + 3 * 60 * 1000;
      while (Date.now() < dl2 && !otp) {
        await sleep(3500);
        otp = findOtpMail((await listMailsRetry({ address, limit: 50 })).mails, oauthOtpBase);
      }
      // 等不到码就必须**当场报错**。原来这里只是 continue，
      // 回到循环又看见验证码框、又等 3 分钟，一路磨到 7 分钟总超时，
      // 而且这条分支不计入 stuck 计数，卡死检测也救不了它 ——
      // 最后日志上只有一句「OAuth 超时」，看不出是等码等死的。
      if (!otp) {
        await page.screenshot({ path: `${SHOTS}/dk-X-nootp.png`, fullPage: true }).catch(() => {});
        throw new Error('OAuth 阶段 3 分钟没等到邮箱验证码（信箱侧或发信侧出了问题）');
      }
      say(`OAuth 阶段 OTP ${otp.code}`);
      await otpBox.fill(otp.code);
      await domClick(page, '^(继续|continue)$', 'OTP 继续');
      await sleep(6000);
      // 🔴 等码可能吃掉 180 秒，远超 1455 的约 60 秒寿命 —— 必须和手机分支一样复检。
      // 少了这一条，只要 OAuth 要求邮箱验证码就是结构性必输。
      {
        const fresh = await renewIfCallbackDead(page, '等邮箱验证码');
        if (fresh === 'ALREADY_LOGGED_IN') { callbackHit = 'desktop-logged-in'; break; }
        if (fresh) { authUrl = fresh; stuck = 0; }
      }
      continue;
    }
    // 连续点不到任何东西 = 页面上没有我们认识的元素（上一轮就是浏览器停在
    // 「连不上 localhost:1455」的错误页）。原来这里会一直刷屏到 7 分钟超时，
    // 白白烧掉整个账号存活窗口，而日志里看不出任何有用信息。
    // 现在：连续 8 次（约 30 秒）没进展就把现场摊出来并退出。
    // 「重试」必须认：2026-08-26 实测手机验证提交后 OpenAI 服务端回
    // 「糟糕，出错了！Operation timed out」，页面上只剩一个「重试」按钮 ——
    // 不认它就只能干等到卡死检测触发，而这一步本来是能救回来的。
    if (!(await domClick(page, '^(继续|continue|授权|authorize|allow|允许|log in|登录|下一步|重试|retry|try again)$', '推进'))) {
      stuck += 1;
      if (stuck === 3 && !(await callbackPortAlive())) {
        // 🔴 1455 关闭 ≠ 失败。回调命中之后桌面端**本来就会**关掉这个监听 ——
        // 2026-08-25 实测：脚本在这里报「早停」，而桌面端其实已经登录成
        // Robert Walker 了。把成功报成失败，比慢一点贵得多。
        if (await desktopLoggedIn()) {
          say('1455 已关闭，但桌面端已登录 —— 说明回调其实命中了');
          callbackHit = 'desktop-logged-in';
          break;
        }
        // 1455 掉了但账号和浏览器会话都还在 —— 重新握手一次就能救回来。
        // 直接 throw 等于白烧一个名额。只给一次机会，免得无限重握。
        if (!renewed) {
          renewed = true;
          const fresh = await renewIfCallbackDead(page, 'OAuth 停滞');
          if (fresh === 'ALREADY_LOGGED_IN') { callbackHit = 'desktop-logged-in'; break; }
          if (fresh) { authUrl = fresh; stuck = 0; continue; }
          // null = 复检时 1455 又活了（单次探测的假阴性）。端口是好的，
          // 这时候报「没救回来」并早停是把逻辑判反了，而且错误信息指错方向。
          say('1455 复检时又活了 —— 判为探测假阴性，继续推进');
          stuck = 0;
          continue;
        }
        throw new Error('1455 回调监听已掉，重新握手也没救回来，且桌面端仍未登录 —— 早停');
      }
      if (stuck >= 8) {
        await page.screenshot({ path: `${SHOTS}/dk-X-stuck.png`, fullPage: true }).catch(() => {});
        say(`按钮: ${JSON.stringify((await page.locator('button:visible').allTextContents().catch(() => [])).slice(0, 12))}`);
        throw new Error(`OAuth 停滞：${page.url().slice(0, 100)} | ${t.slice(0, 160)}`);
      }
    } else {
      stuck = 0;
    }
    await sleep(3000);
  }
  await page.screenshot({ path: `${SHOTS}/dk-4-oauth.png` }).catch(() => {});
  console.log('--- 浏览器导航轨迹 ---');
  navTrail.slice(-25).forEach((l) => console.log('    ' + l));
  say(callbackHit ? '回调已命中' : `⚠️ 回调从未命中，浏览器最后停在: ${page.url().slice(0, 140)}`);
  await browser.close(); browser = null;

  // ---------- 阶段 5：桌面端发消息 ----------
  say('回到桌面端确认登录并发消息…');
  b = await chromium.connectOverCDP(CDP);
  dp = await desktopPage(b);
  // 可能返回 null（窗口还没建好 / 只剩 devtools 目标）。不挡的话下一行就是
  // TypeError，无人值守时日志上只留一句 "Cannot read properties of null"。
  for (let i = 0; i < 10 && !dp; i += 1) { await sleep(2000); dp = await desktopPage(b); }
  if (!dp) throw new Error('桌面端没有可用窗口（CDP 连上了但拿不到主窗口）');
  await sleep(6000);
  const dtxt0 = (await dp.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  say(`桌面端状态: ${dtxt0.slice(0, 140)}`);
  await dp.screenshot({ path: `${SHOTS}/dk-5-loggedin.png` }).catch(() => {});
  // 「Continue signing in with your browser」是**等待态不是错误**（实测确认）：
  // 桌面端点完登录就切到这一屏，一直等到浏览器那边 OAuth 真的完成。
  // 不认识它就会误判成「卡死」而去重启 —— 而重启会丢掉内存里的登录态。
  if (/continue signing in with your browser|正在.*浏览器.*登录/i.test(dtxt0)) {
    say('桌面端处于「等浏览器完成登录」态，继续等…');
    const wdl = Date.now() + 2 * 60 * 1000;
    while (Date.now() < wdl) {
      await sleep(5000);
      const t = (await dp.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
      if (!/continue signing in with your browser|正在.*浏览器.*登录/i.test(t)) { say('已离开等待态'); break; }
    }
  }
  const dtxt = (await dp.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  // "Continue signing in with your browser" 和 "continue to sign in" **不是同一个串**。
  // 少认它 = 白跑 3 分钟引导循环再报「没出现输入框」，错误信息还指错方向。
  if (desktopTextNeedsLogin(dtxt)) {
    throw new Error(`桌面端仍未登录（等了 2 分钟也没离开等待态），最后状态：${dtxt.slice(0, 120)}`);
  }
  if (/deactivated|已被删除|已停用/i.test(dtxt)) throw new Error('账号已被停用（窗口已过）');

  // 首次登录后桌面端会放一段**打字机动画的欢迎语**
  // （"Hey! Welcome to the ChatGPT desktop app. I'm going to ask you a few quick questions…"），
  // 输入框要等它播完才出现。上一轮只等了 6 秒就判「没找到输入框」，
  // 然后为了补救去重启桌面端 —— 结果把登录态弄丢了（见下面那条注释）。
  //
  // 🔴 **登录之后绝对不能重启桌面端**：这台无头机器没有系统密钥环（libsecret），
  // 凭据只在内存里，进程一死就退回登录页，而账号窗口只有 10 分钟，重来一次就废了。
  // 引导是**多屏问卷**，不是一路 Continue 就能过的（2026-08-25 实测）：
  //   · 每屏要先**选一个选项**再 Continue。不选就点 Continue，页面纹丝不动，
  //     日志上看却是「点击命中」—— 于是同一屏空转到循环耗尽。
  //   · 最后一屏是功能介绍，出口按钮叫「Go to ChatGPT」，不是 Continue。
  //     少认这一个，前面全白点。
  let box = null;
  // 引导循环也要受窗口约束：账号已经死了还在那儿翻问卷是纯浪费
  const bdl = Math.min(Date.now() + 3 * 60 * 1000, (W0 || Date.now()) + WINDOW_BUDGET_MS);
  for (let screen = 0; Date.now() < bdl; screen += 1) {
    const cand = dp.locator('#prompt-textarea, [contenteditable="true"], textarea').first();
    if (await cand.isVisible().catch(() => false)) { box = cand; say(`✅ 引导结束（共 ${screen} 屏）`); break; }
    // 先选项，后推进；出口按钮优先于 Continue
    if (!(await domClick(dp, '^(Engineering|工程|Other|其他)$', `第${screen + 1}屏选项`))) {
      const picked = await pickAnyOption(dp);
      if (picked) say(`  兜底选了「${picked}」`);
    }
    await sleep(1200);
    if (await domClick(dp, '^(Go to ChatGPT|进入 ChatGPT|Close dialog|关闭)$', '进入主界面')) {
      await sleep(4500);
      continue;
    }
    if (!(await domClick(dp, '^(continue|继续|skip|跳过|next|下一步|get started|开始|done|完成|not now|稍后)$', '推进'))) {
      await dp.keyboard.press('Enter').catch(() => {});
    }
    await sleep(4500);
    say(`  第${screen + 1}屏后（窗口${win()}）: ${(await dp.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 70)}`);
  }
  if (!box) {
    await dp.screenshot({ path: `${SHOTS}/dk-X-nobox.png` }).catch(() => {});
    say('按钮: ' + JSON.stringify((await dp.locator('button:visible').allTextContents()).filter((t) => t.trim()).slice(0, 14)));
    throw new Error('等了 3 分钟桌面端仍没出现输入框');
  }
  say('✅ 桌面端输入框已出现');
  // 发消息。**验产物不验动作**：只确认「我打了字并按了回车」不算数，
  // 要看到对话里真的多出内容才算这一轮 turn 成立（奖励看的是真实 turn）。
  // 判据 v5：挑战-应答。**不再依赖界面文本长什么样**。
  //
  // 前四版全部栽在同一件事上：判据依赖的是不可控、无契约、随版本漂移的界面文本
  // （会话标题、"Working… 12s"、无障碍播报、报错弹条都会冒出新行）。
  // 措辞怎么调都躲不开，因为界面本来就会出现我们没见过的东西。
  //
  // 现在改成：每条消息带一道算术题，**答案不在题面里**，
  // 所以只有真正回答的人才产生得出那个串 —— 回显、标签、标题一律造不出来。
  // 判据本身在 server/desktopJudge.js，有 17 项测试钉着。
  //
  // 🔴 这里**不留任何退路判据**。上一版留了"气泡数"和"长度"两条退路，
  // 它们绕过主判据自己判，实测在「消息发出去、回复永远不来」的场景下
  // 报 ✅✅ 3/3 并 exit 0 —— 模块测试全绿，脚本照样报假成功。
  const bodyText = async () => dp.locator('body').innerText().catch(() => '');
  let landed = 0;
  let fatalHit = '';
  // 官方规则是「被邀请人发出**第一条**消息」就发放奖励，所以 1 条就够，
  // 第 2 条只是留个冗余（万一第 1 条的判据被界面噪声干扰）。
  // 原来发 3 条：新账号发到第 3 条会稳定撞限流（2026-08-27 实测「Retry in 120s」），
  // 白等 45 秒还把结果报成「部分完成」，看着像失败。
  const rounds = 2;
  for (let i = 0; i < rounds; i += 1) {
    // 答案万一已经在屏幕上（上一题的答案还没滚走），重出一道，避免自己骗自己
    let challenge = makeChallenge();
    for (let retry = 0; retry < 5; retry += 1) {
      const seen = await bodyText();
      if (!seen.includes(challenge.expect)) break;
      challenge = makeChallenge();
    }
    const linesBefore = new Set((await bodyText()).split(/\r?\n/).map((l) => l.trim()).filter(Boolean));

    // 点不动就退回原生 focus。Electron 界面同样会盖遮罩层，
    // 而这一步是唯一能产生 codex_turn 的动作，不能因为点击被拦就整轮作废。
    if (!(await box.click({ timeout: 8000 }).then(() => true).catch(() => false))) {
      await box.evaluate((el) => el.focus()).catch(() => {});
    }
    await dp.keyboard.type(challenge.prompt, { delay: 45 });
    await sleep(500);
    await dp.keyboard.press('Enter');
    say(`已发第 ${i + 1} 条：${challenge.prompt}（等答案 ${challenge.expect}）`);

    // 超时按窗口预算派生，不写死 —— 账号都快死了还等 45 秒没有意义
    const budget = Math.max(20000, Math.min(45000, winLeft() - 30000));
    const rdl = Date.now() + budget;
    let verdict = 'pending';
    while (Date.now() < rdl && verdict !== 'confirmed' && verdict !== 'fatal') {
      await sleep(3000);
      verdict = classifyTurn(await bodyText(), challenge.expect);
    }

    if (verdict === 'confirmed') {
      landed += 1;
      say(`  ↳ ✅ 收到答案 ${challenge.expect}（第 ${i + 1} 条 turn 成立）`);
    } else if (verdict === 'fatal') {
      fatalHit = (await bodyText()).replace(/s+/g, ' ').slice(0, 120);
      say(`  ↳ 🔴 界面在报错/限流，中止后续消息：${fatalHit}`);
      break;
    } else {
      // 只报告不判定：把这一轮新出现的行打出来，方便事后看是卡在哪
      const linesNow = new Set((await bodyText()).split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
      const note = pickReplyLine([...linesNow].filter((l) => !linesBefore.has(l)), challenge.prompt);
      say(`  ↳ ⚠️ ${Math.round(budget / 1000)} 秒内没等到答案（verdict=${verdict}）${note ? `｜界面新增：${note.slice(0, 50)}` : ''}`);
    }
    await dp.screenshot({ path: `${SHOTS}/dk-6-msg${i + 1}.png` }).catch(() => {});
  }
  if (fatalHit) throw new Error(`桌面端报错/限流，本轮中止：${fatalHit}`);
  const msgs = { length: rounds };   // 下面的终局判据沿用 landed/msgs.length 的写法
  await dp.screenshot({ path: `${SHOTS}/dk-6-sent.png` }).catch(() => {});
  await b.close();

  // 终局判据必须落在产物上。原来这句不管消息发没发出去都会打「全流程完成」——
  // 而奖励只认真实 turn，报一个假的成功比报失败贵得多。
  if (!landed) {
    throw new Error('桌面端一条消息都没确认收到回复 —— 没有产生任何 codex_turn，不算完成');
  }
  // 部分成功不能用「✅✅ 全流程完成」报 —— 无人值守的编排器只看退出码和这一行，
  // 会把 1/3 当成三条 turn 都成立。
  if (landed < msgs.length) {
    console.log(`\n⚠️ 部分完成 —— ${landed}/${msgs.length} 条 turn 成立，窗口内 ${win()}，总耗时 ${el()}`);
    console.log('   奖励是否入账要人工核对');
  } else {
    console.log(`\n✅✅ 全流程完成 —— ${landed}/${msgs.length} 条 turn 成立，窗口内 ${win()}，总耗时 ${el()}`);
  }
} catch (e) {
  failed = true;
  console.log(`\n❌ ${e.message}（窗口 ${win()}，总 ${el()}）`);
  if (activationId) { await cancelNumber(activationId).catch(() => {}); say('已退掉没用完的号'); }
} finally {
  clearTimeout(watchdog);
  // close() 可能**永不 settle**（渲染进程没响应），.catch 挡不住挂起，只能赛跑
  if (browser) await Promise.race([browser.close().catch(() => {}), sleep(15000)]);
  killDesktop();
  process.exit(failed ? 1 : 0);
}
