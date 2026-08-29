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
import { acquireRunLock, releaseRunLock } from '../server/runLock.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = String(process.env.INVITE_SITE_URL || '').replace(/\/+$/, '');
const SECRET = String(process.env.INVITE_WORKER_SECRET || '');
const IDLE_MS = Number(process.env.INVITE_WORKER_TICK_MS) || 5000;
// 网站不可达 / 锁被占时的退避。没有它就会热转：每 5 秒重试一次，
// 日志刷屏而真正的原因一条都看不出来。
const BACKOFF_MS = Number(process.env.INVITE_WORKER_BACKOFF_MS) || 30000;

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
      },
    );
    let tail = '';
    const keep = (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      tail = (tail + text).slice(-4000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (error) => resolve({ ok: false, code: -1, tail: `spawn 失败：${error.message}` }));
    child.on('close', (code) => resolve({ ok: code === 0, code, tail }));
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
    // 立刻如实回报失败，别让号在 running 上干等 45 分钟才被清扫回来
    await callSite('/api/invite/worker/report', {
      address: job.address, ok: false, result: '❌ 通道忙，请稍后重试', note: `本机锁被 pid=${holder.pid} 占用`,
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
      address: job.address, ok: outcome.ok, result, note: outcome.tail.slice(-1500),
    });
  } catch (error) {
    // 回报失败最贵：号会卡在 running 直到陈旧清扫。重试几次再放弃。
    say(`回报失败：${error.message} —— 重试`);
    for (let i = 0; i < 5; i += 1) {
      await sleep(5000 * (i + 1));
      try {
        await callSite('/api/invite/worker/report', {
          address: job.address, ok: outcome.ok, result, note: outcome.tail.slice(-1500),
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
