#!/usr/bin/env node
// invite-worker.mjs — 邀请队列的**唯一**消费者。跑在桌面端那台机器上。
//
// 为什么是"反向拉取"：网站在 DMIT-1、桌面端在 DMIT-2，而号池是本地 SQLite，
// 两边 import 同一个模块只会各自建一个空库。所以队列由网站持有，
// worker 当 HTTPS 客户端来取任务、回报结果 —— worker 不用开任何入站端口。
//
// 为什么是单进程：桌面端的 CDP 端口和 ~/.codex 凭据是独占资源，两轮并行会
// 互相清凭据、抢端口，两个**不可再生**的邀请名额一起烧。
//
// 需要的环境变量：
//   INVITE_SITE_URL      网站地址，如 https://sms.tempmail2026.xyz
//   INVITE_WORKER_SECRET 与网站 .env 里同名变量一致
//   （其余 MAIL_PROVIDER / HERO_SMS_* 等由 desktop-run.mjs 自己读）

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireRunLock, releaseRunLock, lockHolder } from '../server/runLock.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = String(process.env.INVITE_SITE_URL || '').replace(/\/+$/, '');
const SECRET = String(process.env.INVITE_WORKER_SECRET || '');
const IDLE_MS = Number(process.env.INVITE_WORKER_TICK_MS) || 5000;
// 网站不可达 / 锁被占时的退避。没有它就会热转：每 5 秒重试一次，
// 日志刷屏而真正的原因一条都看不出来。
const BACKOFF_MS = Number(process.env.INVITE_WORKER_BACKOFF_MS) || 30000;

// 子进程静默多久算「卡死」。9 轮完整任务实测：运行内最长的合法静默是 **64 秒**
// （等邀请、等登录按钮的心跳都是 64s 一跳），取 5 分钟 ≈ 4.7 倍余量。
// 宁可放过慢的也不能误杀正常轮次 —— 误杀等于白烧一个不可再生的邀请名额。
const STALL_MS = Number(process.env.INVITE_STALL_MS) || 5 * 60 * 1000;
// 绝对上限。子进程自己的 HARD_KILL_MS 是 40 分钟，**它能响的时候要让它先响** ——
// 它的 bailOut 会把没用完的接码号退掉（约 $0.16），从外面直接杀就退不了了。
const MAX_RUN_MS = Number(process.env.INVITE_MAX_RUN_MS) || 45 * 60 * 1000;

if (!SITE || !SECRET) {
  console.error('缺 INVITE_SITE_URL 或 INVITE_WORKER_SECRET，worker 不启动');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (msg) => console.log(`[worker ${new Date().toISOString().slice(11, 19)}] ${msg}`);

async function callSite(path, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`${SITE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: SECRET, ...payload }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(`HTTP ${response.status} ${data.error || ''}`.trim());
    }
    return data.data ?? data;
  } finally {
    clearTimeout(timer);
  }
}

// 【Graph 令牌号】自带 refresh_token。把它写成 outlookMail.js 认的那个 token 文件，
// 读信那条链路就原样复用，一行都不用改，同时整段跳过设备码授权
// （浏览器登录 + 强制绑临时恢复邮箱 + 同意屏，约 150 秒）。
//
// 路径算法必须和 outlookMail.js 的 tokenPathFor 完全一致，算错了等于没写 ——
// 而表现是"又去跑了一遍授权"，不会报错。
//
// scope 用 .default：卖家签发时用的 scope 我们不知道，.default 的语义正是
// 「把这个 client 已获授权的一切给我」。实测这个货源授予的是
// Mail.ReadWrite + Mail.Send，而写死 Mail.Read 会被拒（AADSTS70000）。
function writeVendorToken(address, refreshToken, clientId) {
  if (!refreshToken) return false;
  const key = createHash('sha256').update(String(address).trim().toLowerCase()).digest('hex').slice(0, 20);
  const dir = join(ROOT, 'data', 'outlook-tokens');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${key}.json`), JSON.stringify({
    refreshToken,
    clientId: clientId || '9e5f94bc-e8a4-4e73-b8be-63364c29d753',
    scope: 'https://graph.microsoft.com/.default',
    source: 'vendor',
  }), { mode: 0o600 });
  return true;
}

// 跑一轮。判据落在**产物**上（脚本退出码 + 最后几行输出），
// 不落在"有没有异常"上 —— 脚本自己就会把失败写成非零退出。
//
// 🔴 除了「最长能跑多久」，还得有一道「多久没动静就算废了」。
//
// 2026-09-02 实测事故：一轮跑到 +152s 打完「桌面端状态」那行之后**彻底静默**，
// 主线程 100% 用户态自旋（几乎没有系统调用，RSS 不涨），一直转到子进程自己的
// HARD_KILL_MS = 40 分钟才被它自己的 bailOut 收掉。
// 兜底是生效了的 —— 但**只有 40 分钟这一档**：买家在页面上白等了 40 分钟，
// 一个不可再生的邀请名额也被占了 40 分钟，期间队列后面还排着另一位买家。
// （当时那位买家以为卡住了，又下单了一次，于是两张卡两个号。）
//
// 而正常轮次 3~4 分钟就跑完，9 轮完整任务实测运行内最长静默 **64 秒**。
// 也就是说「静默几分钟」这个信号，比「跑满 40 分钟」早得多、也一样可靠。
//
// 这道闸放在**父进程**：子进程卡住时它自身的状态不可信（连它卡在哪一句都
// 未必查得出来 —— 这次就没查出来），而父进程只需要判一件不依赖子进程健康度的事：
// 它还出不出声。不猜故障原因，只认沉默。
function runOne(address, password) {
  return new Promise((resolve) => {
    const script = join(ROOT, 'desktop-run.mjs');
    const local = join(ROOT, 'scripts', 'desktop', 'desktop-run.mjs');
    const target = existsSync(script) ? script : local;
    const child = spawn(
      'xvfb-run',
      ['-a', '--server-args=-screen 0 1280x900x24', 'node', target],
      {
        cwd: ROOT,
        env: { ...process.env, MAIL_PROVIDER: 'outlook', WEBMAIL_USER: address, WEBMAIL_PASS: password },
        stdio: ['ignore', 'pipe', 'pipe'],
        // 自成进程组。xvfb-run 下面挂着 node 和一整棵 Chrome 进程树，只杀 xvfb-run
        // 会留下一堆孤儿继续占着 CDP 端口和内存，下一轮起来就撞端口。
        // kill(-pid) 一次带走整组。
        detached: true,
      },
    );
    let tail = '';
    let done = false;
    let killed = '';
    let lastOutput = Date.now();

    // 先 SIGTERM 再 SIGKILL。desktop-run **没装 SIGTERM 处理器**（只有
    // unhandledRejection），所以 SIGTERM 走的是内核默认动作 —— 好处是它忙到
    // 没空跑 JS 也照样能被终结，代价是跑不到 bailOut 的退号逻辑：
    // 🔴 被静默看门狗杀掉时，那一轮没用完的接码号退不了，白扔约 $0.16。
    // 这是明知的取舍 —— 拿 $0.16 换买家少等半小时、名额少占半小时。
    // 想省这笔就得让 desktop-run 自己处理 SIGTERM，但它卡住时未必还跑得动 JS，
    // 正好在最需要的时候不可靠，所以没走那条路。
    const killTree = (signal) => {
      try { process.kill(-child.pid, signal); }
      catch { try { child.kill(signal); } catch { /* 已经没了 */ } }
    };
    const abort = (why) => {
      if (done || killed) return;
      killed = why;
      say(`⛔ ${why} —— 强制回收这一轮`);
      killTree('SIGTERM');
      setTimeout(() => { if (!done) killTree('SIGKILL'); }, 20000).unref();
    };

    // 这句话是要发给买家看的，别把 46 秒说成「1 分钟」—— 不足 2 分钟就报秒。
    const howLong = (ms) => (ms < 120000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms / 60000)} 分钟`);
    const stallTimer = setInterval(() => {
      const quiet = Date.now() - lastOutput;
      if (quiet > STALL_MS) abort(`子进程静默 ${howLong(quiet)}（正常轮次最长静默 64 秒）`);
    }, 15000);
    const capTimer = setTimeout(() => abort(`子进程总时长超过 ${Math.round(MAX_RUN_MS / 60000)} 分钟`), MAX_RUN_MS);

    const keep = (chunk) => {
      const text = chunk.toString();
      lastOutput = Date.now();
      process.stdout.write(text);
      tail = (tail + text).slice(-4000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);

    const finish = (payload) => {
      if (done) return;
      done = true;
      clearInterval(stallTimer);
      clearTimeout(capTimer);
      resolve(payload);
    };
    // retryable = 这一轮**不是脚本自己得出的结论**，而是我们这边没让它跑成/没让它跑完。
    // 这类失败不该写进买家的终态（见 accountPool.requeueRun 的注释）。
    child.on('error', (error) => finish({ ok: false, retryable: true, code: -1, tail: `spawn 失败：${error.message}` }));
    child.on('close', (code) => finish({
      // 被我们杀掉的一律算失败，哪怕退出码碰巧是 0
      ok: code === 0 && !killed,
      // 被看门狗回收 = 我们主动掐的，不是脚本自己的结论。这类轮次实测能靠
      // 「放回队列重跑」救回来（且不消耗新的邀请名额），所以自动重排是对的路。
      retryable: Boolean(killed),
      code,
      // 被杀时 tail 里不会有 ✅✅/❌ 那一行，summarize 就会拿最后一句无关日志当结论 ——
      // 而那句结论是要发给买家看的。这里如实补一句。
      tail: killed ? `${tail}\n❌ 通道无响应，已强制回收：${killed}` : tail,
    }));
  });
}

// 结果行：脚本最后那句 ✅✅/❌ 就是结论，回报给网站存进号池。
function summarize(tail) {
  const lines = String(tail).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const verdict = [...lines].reverse().find((l) => l.startsWith('✅✅') || l.startsWith('❌'));
  return (verdict || lines[lines.length - 1] || '').slice(0, 500);
}

let stopping = false;
let busy = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    say(`收到 ${sig}，不再取新任务`);
    stopping = true;
    // 正在跑的那一轮让它自己收尾：中途杀掉号会卡在 running，
    // 要等网站侧 45 分钟的陈旧清扫才能救回来。
    if (!busy) { releaseRunLock(); process.exit(0); }
  });
}
process.on('exit', releaseRunLock);

say(`启动，队列来源 ${SITE}`);
while (!stopping) {
  // 🔴 别人（多半是运维手工 pool.mjs run）占着锁时，**连任务都别取**。
  // 取了也跑不了，只会在库里画一条 running→ready，还得多跑一趟回报。
  //
  // 这里只是「看一眼」，不占锁 —— 不能改成先 acquire 再取任务：worker 是 7×24
  // 空转轮询的，它一直占着锁的话，运维就永远跑不了手工那一轮了。
  const idleHolder = lockHolder();
  if (idleHolder && idleHolder.pid !== process.pid) {
    say(`本机已有一轮在跑（pid=${idleHolder.pid} ${idleHolder.address}）—— 本轮不取任务`);
    await sleep(BACKOFF_MS);
    continue;
  }

  let job = null;
  try {
    ({ job } = await callSite('/api/invite/worker/next', {}));
  } catch (error) {
    say(`取任务失败：${error.message} —— 退避 ${BACKOFF_MS / 1000}s`);
    await sleep(BACKOFF_MS);
    continue;
  }
  if (!job) { await sleep(IDLE_MS); continue; }

  // 网站已经把它置成 running 了。这里再抢一次本机锁，挡住"有人同时手工跑"。
  const holder = acquireRunLock(job.address);
  if (holder) {
    say(`本机已有一轮在跑（pid=${holder.pid} ${holder.address}），退回任务`);
    // 🔴 必须带 requeue：这个号我们**一个字节都没碰过**，凭一次调度打嗝把买家
    // 判成 failed 是这套系统里最贵的错 —— failed 在买家侧是终态死路，
    // 卡不退、号不回队列，只能人工 reset。放回队列他还站在原来的位置。
    // （不带 requeue 时实测：锁被占 5 分钟 = 队列前 10 个已付费买家被逐个判死。）
    await callSite('/api/invite/worker/report', {
      address: job.address, ok: false, requeue: true, result: '❌ 通道忙，请稍后重试', note: `本机锁被 pid=${holder.pid} 占用`,
    }).catch((e) => say(`回报失败：${e.message}`));
    await sleep(BACKOFF_MS);
    continue;
  }

  busy = true;
  if (writeVendorToken(job.address, job.refreshToken, job.clientId)) {
    say('这个号自带 Graph 令牌 —— 跳过设备码授权');
  }
  say(`开跑 ${job.address}`);
  const outcome = await runOne(job.address, job.password);
  releaseRunLock();
  busy = false;

  const result = summarize(outcome.tail) || (outcome.ok ? '✅ 完成' : '❌ 未完成');
  say(`${job.address} 结束 exit=${outcome.code}：${result}`);
  try {
    await callSite('/api/invite/worker/report', {
      address: job.address, ok: outcome.ok, requeue: Boolean(outcome.retryable), result, note: outcome.tail.slice(-1500),
    });
  } catch (error) {
    // 回报失败最贵：号会卡在 running 直到陈旧清扫。重试几次再放弃。
    say(`回报失败：${error.message} —— 重试`);
    for (let i = 0; i < 5; i += 1) {
      await sleep(5000 * (i + 1));
      try {
        await callSite('/api/invite/worker/report', {
          address: job.address, ok: outcome.ok, requeue: Boolean(outcome.retryable), result, note: outcome.tail.slice(-1500),
        });
        say('回报成功');
        break;
      } catch (retryError) {
        say(`回报重试 ${i + 1}/5 失败：${retryError.message}`);
      }
    }
  }
}
say('已停止');
process.exit(0);
