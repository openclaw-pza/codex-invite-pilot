#!/usr/bin/env node
// 账号池 CLI。一个入口管完领号/确认/开跑/查状态。
//
// 业务时序（硬约束，见 server/accountPool.js 文件头）：
//   验卡 → claim 领号给买家 → 买家发邀请 → confirm → run
// 领号阶段**绝不碰账号**：提前登录会绑上十分钟就失效的临时恢复邮箱，白废一个号。
//
//   node scripts/pool.mjs add accounts.txt        # 每行 邮箱----密码 或 邮箱 密码
//   node scripts/pool.mjs claim --ref card-001
//   node scripts/pool.mjs confirm --address x@outlook.com
//   node scripts/pool.mjs run --address x@outlook.com   # 也可省略 --address，自动取一个 ready 的
//   node scripts/pool.mjs cooling            # 隔离区复检（干跑）；加 --apply 才落库
//   node scripts/pool.mjs status

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireRunLock, releaseRunLock } from '../server/runLock.js';
import { parseAccountLine } from '../server/accountLine.js';
import { verifyGraphToken } from '../server/outlookToken.js';
import {
  addAccounts, claimAccount, confirmInvite, getAccount,
  listByStatus, listCooling, markDead, markFinished, markRunning, nextReady, poolStats, releaseAccount,
  resetToReady, settleCooling, unconfirmInvite,
} from '../server/accountPool.js';
import { mailboxHasInvite } from '../server/inviteSweep.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cmd = process.argv[2] || 'status';
const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : String(process.argv[i + 1] || '').trim();
};

// 仓库里在 scripts/desktop/，部署到 VPS 后在根目录（它 import 的是 ./server/xxx.js）
function desktopRunPath() {
  for (const p of [join(ROOT, 'desktop-run.mjs'), join(ROOT, 'scripts', 'desktop', 'desktop-run.mjs')]) {
    if (existsSync(p)) return p;
  }
  throw new Error('找不到 desktop-run.mjs');
}


if (cmd === 'add') {
  const file = process.argv[3];
  if (!file || !existsSync(file)) { console.error('用法: pool.mjs add <账号文件>'); process.exit(2); }
  // 三个数要分开报：原始行数 / 解析成功 / 跳过。老写法两个数永远相同，
  // 解析失败的行完全看不出来 —— 而密码被截断正是从这里溜过去的。
  const raw = readFileSync(file, 'utf8').split('\n');
  const skipped = [];
  const rows = raw.map((line, i) => {
    const parsed = parseAccountLine(line);
    if (!parsed && line.trim() && !line.trim().startsWith('#')) skipped.push(i + 1);
    return parsed;
  }).filter(Boolean);
  const { added, withToken, patchedToken } = addAccounts(rows);
  console.log(`原始 ${raw.length} 行 → 解析成功 ${rows.length} → 新入池 ${added} 个`);
  if (withToken) console.log(`其中 ${withToken} 个自带 Graph 令牌 —— 建议接着跑一次 pool.mjs verify 体检`);
  if (skipped.length) console.log(`⚠️ 解析失败的行号：${skipped.join(', ')}（格式应为 邮箱----密码）`);
  console.log(JSON.stringify(poolStats()));
} else if (cmd === 'claim') {
  const ref = arg('--ref');
  if (!ref) { console.error('用法: pool.mjs claim --ref <卡密/订单号>'); process.exit(2); }
  let account;
  try {
    account = claimAccount(ref);
  } catch (error) {
    // 上线后这条是买家验卡时会看到的 —— 抛一屏栈没有任何意义
    console.error(`领号失败：${error?.message || error}`);
    process.exit(1);
  }
  console.log(JSON.stringify({
    address: account.address, reused: account.reused, status: account.status,
  }, null, 2));
  console.log(`\n把这个地址给买家，让他用自己的 Codex 发邀请到：${account.address}`);
  console.log('买家发完之后再跑：pool.mjs confirm --address ' + account.address);
} else if (cmd === 'confirm') {
  const address = arg('--address');
  const account = confirmInvite(address);
  console.log(`✅ ${account.address} 已标记「邀请已发送」，可以开跑了`);
} else if (cmd === 'reset') {
  // 把 failed 的号放回 ready 重跑。用在「账号已经建好、只是某一步卡了」的情况 ——
  // 邀请已经消耗掉了，换个号等于白扔一个邀请名额，能重跑就重跑。
  const address = arg('--address');
  const account = getAccount(address);
  if (!account) { console.error(`池子里没有 ${address}`); process.exit(1); }
  const force = process.argv.includes('--force');
  if (account.status === 'running' && !force) {
    console.error(`${address} 还是 running —— 子进程可能还活着，重跑会让两个进程同时登同一个号`);
    console.error('先确认进程已死（pgrep -af "[d]esktop-run"），再加 --force');
    process.exit(1);
  }
  if (account.status === 'done' && !force) {
    console.error(`${address} 已经跑完（done）。要做验证性重跑请加 --force`);
    console.error('（这类号邀请名额已消耗，重跑不浪费名额，只花一次接码费）');
    process.exit(1);
  }
  if (!['failed', 'running', 'done'].includes(account.status)) {
    console.error(`${address} 当前是 ${account.status}，只有 failed/running 才需要 reset`);
    process.exit(1);
  }
  resetToReady(address, { force });
  console.log(`✅ ${address} 已放回 ready，可以再跑一次`);
} else if (cmd === 'unconfirm') {
  // 退回「已领号、邀请还没发」。买家点错了、或者我们做完干跑要把状态摆正。
  const address = arg('--address');
  unconfirmInvite(address);
  console.log(`✅ ${address} 已退回 assigned（邀请未发），在买家确认之前不会被 worker 取走`);
} else if (cmd === 'release') {
  // 卡退款/注销了、邀请还没发 —— 把号收回来，别让好号跟废卡陪葬。
  // 但收回来只到**隔离区**：买家可能在这之后才把邀请发出去，而一个 outlook
  // 只能被邀请一次，直接再卖会把两个买家的钱货错配（见 accountPool.releaseAccount）。
  const address = arg('--address');
  releaseAccount(address);
  console.log(`✅ ${address} 已转入隔离区（cooling），**还不能**再派给别的买家`);
  console.log('   复检信箱后才决定放回还是打死：pool.mjs cooling（先干跑，确认无误再加 --apply）');
} else if (cmd === 'verify') {
  // 入库体检：把卖家发的令牌逐个真验一遍（换令牌 + 真读一次信箱）。
  //
  // 为什么必须有这一步：坏令牌现在唯一会暴露的时机是**跑到一半**，
  // 而那时买家的邀请名额已经烧掉了。一个号 = 一个不可再生的名额，
  // 所以要把失败从"邀请之后"提前到"入库时"。
  //
  // 默认只体检 available（还没派给任何人的）——已经在跑或跑完的不该动。
  const only = arg('--address');
  const rows = only ? [getAccount(only)].filter(Boolean) : listByStatus('available', 200);
  if (!rows.length) { console.log(only ? `池子里没有 ${only}` : '没有 available 状态的号'); }

  const autoDead = process.argv.includes('--mark-dead');
  let ok = 0; let bad = 0; let skip = 0; let flaky = 0;
  for (const row of rows) {
    if (!row.refresh_token) { skip += 1; console.log(`  － ${row.address} 没有令牌（网页号，跑的时候现授权）`); continue; }
    const r = await verifyGraphToken({ refreshToken: row.refresh_token, clientId: row.client_id });
    if (r.ok) { ok += 1; console.log(`  ✅ ${row.address} 可用（scope: ${(r.scope || '').replace('https://graph.microsoft.com/', '')}）`); continue; }
    if (r.verdict === 'transient') {
      // 🔴 瞬时故障绝不能标死号：一次网络抖动换掉一个好号，太贵了。
      flaky += 1;
      console.log(`  ⚠️ ${row.address} 暂时查不了（${r.detail}）—— 不动它，稍后重查`);
      continue;
    }
    bad += 1;
    console.log(`  ❌ ${row.address} 令牌已失效：${r.detail}`);
    if (autoDead) { markDead(row.address, `入库体检：令牌失效 ${r.detail}`.slice(0, 200)); console.log('     已标 dead'); }
  }
  console.log(`\n体检 ${rows.length} 个：可用 ${ok}｜失效 ${bad}｜暂时查不了 ${flaky}｜无令牌 ${skip}`);
  if (bad && !autoDead) console.log('加 --mark-dead 可以把失效的直接移出可分配集合');
} else if (cmd === 'dead') {
  // 号本身废了，或者它的邀请名额已经被消耗掉（发过邀请但没送达也算消耗）。
  // 永久移出可分配集合 —— 留在池子里迟早会被派给买家，然后白跑一轮。
  const address = arg('--address');
  const account = getAccount(address);
  if (!account) { console.error(`池子里没有 ${address}`); process.exit(1); }
  markDead(address, arg('--note') || '');
  console.log(`✅ ${address} 已标记 dead，不会再派给买家`);
} else if (cmd === 'cooling') {
  // 隔离区复检。买家领了号却没发邀请、号被 sweep 收回时进的就是这里。
  //
  // 🔴 为什么不能收回就直接放回可用池：一个 outlook **只能被邀请一次**，而 sweep
  // 读信箱只是某一刻的快照 —— 买家完全可能在那之后才把邀请发出来。真发生了而号
  // 又被再卖一次的话，desktop-run 的微软臂不设基线（一号一邀，认信箱里现有那封），
  // 认到的会是**前一个买家**那封：后一个买家付了钱，额度记到前一个人头上。
  //
  // 所以放回可用池必须以「此刻信箱里确实没有邀请信」为据，而且是人点头之后才放。
  const rows = listCooling();
  if (!rows.length) { console.log('隔离区是空的'); process.exit(0); }
  const apply = process.argv.includes('--apply');
  console.log(`隔离区 ${rows.length} 个${apply ? '（--apply：会真的改状态）' : '（干跑，不改任何状态；加 --apply 才落库）'}\n`);
  for (const row of rows) {
    let has = null;
    try { has = await mailboxHasInvite(row); }
    catch (error) { console.warn(`  读信箱出错：${error?.message || error}`); }
    // 读不出来 ≠ 干净。查不到就继续关着，绝不放行。
    const verdict = has === false ? 'clean' : (has === true ? 'used' : 'unknown');
    const label = { clean: '✅ 信箱干净，可放回', used: '💀 信箱里有邀请信 —— 名额已被消耗，打死', unknown: '❓ 读不出来，继续隔离' }[verdict];
    console.log(`  ${row.address}  隔离于 ${row.cooled_at || '?'}  ${label}`);
    console.log(`      ${row.note || ''}`);
    if (!apply || verdict === 'unknown') continue;
    settleCooling(row.address, {
      clean: verdict === 'clean',
      detail: verdict === 'clean' ? '隔离复检：信箱无邀请信，放回可用池' : '隔离复检：信箱里已有邀请信，名额已消耗',
    });
  }
  if (!apply) console.log('\n（以上只是判读，没有改任何状态。确认无误后加 --apply）');
} else if (cmd === 'run') {
  let address = arg('--address');
  if (!address) {
    // 🔴 必须和网站派单用同一个判据（nextReady）。
    // 这里曾经是 listByStatus('ready',1)[0]（按号入库时间），而网站侧已经改成
    // 按买家确认发出邀请的时间排 —— 两套顺序并存时，运维手工跑一轮会**跳过**
    // 真正的队头，被跳过那位买家页面上的排位就从「马上轮到你」倒退成
    // 「前面还有 1 个人」。而买家看到进度倒退正是他判定系统坏了、再下一单的原因，
    // 也就是排位这个功能本来要消灭的东西。（2026-09-02 对抗性审计实测复现。）
    const ready = nextReady();
    if (!ready) { console.error('没有 ready 状态的账号（买家确认发过邀请之后才会变 ready）'); process.exit(1); }
    address = ready.address;
    console.log(`没指定 --address，自动取一个 ready 的：${address}`);
  }
  const account = getAccount(address);
  if (!account) { console.error(`池子里没有 ${address}`); process.exit(1); }
  // 顺序很重要：先确认脚本在，再改状态。反过来的话 desktopRunPath() 抛错时
  // 号已经是 running 了，而 close 事件永远不会来 —— 号永久卡死。
  const script = desktopRunPath();
  // 抢锁在改状态之前：抢不到就直接退，号还留在 ready
  const holder = acquireRunLock(address);
  if (holder) {
    console.error(`已有一轮在跑：pid=${holder.pid} 账号=${holder.address} 起于 ${holder.startedAt}`);
    console.error('整机只允许一轮（桌面端 CDP 9333 和 ~/.codex 凭据是独占的）—— 本次拒绝启动');
    process.exit(1);
  }
  process.on('exit', releaseRunLock);
  markRunning(address);   // 不在 ready 状态会在这里抛错，这是防止提前动账号的最后一道闸
  console.log(`开跑 ${address} → ${script}`);
  const child = spawn('xvfb-run', ['-a', '--server-args=-screen 0 1280x900x24', 'node', script], {
    cwd: ROOT,
    env: {
      ...process.env,
      MAIL_PROVIDER: 'outlook',
      WEBMAIL_USER: account.address,
      WEBMAIL_PASS: account.password,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let tail = '';
  const keep = (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    tail = (tail + text).slice(-4000);   // 只留尾部，失败时把最后的现场记进池子
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);

  // 所有退出路径都要走这里，且只走一次。
  let settled = false;
  const settle = (ok, result, note = '') => {
    if (settled) return;
    settled = true;
    // markFinished 现在会抛（不在 running 就抛），不能让它把退出流程带崩
    try { markFinished(address, { ok, result, note }); }
    catch (error) { console.error(`⚠️ 回写池子失败：${error.message}`); }
    console.log(`\n${ok ? '✅' : '❌'} ${address} 结束`);
    console.log(JSON.stringify(poolStats()));
    process.exit(ok ? 0 : 1);
  };

  // 🔴 没有这条，xvfb-run 不存在时 Node 会把 'error' 当未捕获异常抛出：
  // CLI 直接崩 → close 永不触发 → markFinished 永不调用 → **号永久卡在 running**。
  // 而唯一的出路是 reset，reset 又会撞上「running 默认拒绝重置」—— 死循环。
  // 审计在本机一跑就复现了（spawn xvfb-run ENOENT）。
  child.on('error', (error) => settle(false, `spawn 失败: ${error.code || error.message}`, String(error.message).slice(0, 300)));

  // Ctrl-C / systemd stop 也要把号放回 failed，别留一个永远 running 的孤儿
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      try { child.kill('SIGTERM'); } catch { /* 已经没了 */ }
      settle(false, `被 ${sig} 中断`, tail.slice(-300));
    });
  }

  child.on('close', (code) => {
    // 判据落在脚本自己的终局判据上：它只有在真发出 turn 时才 exit 0
    const summary = (tail.match(/✅✅[^\n]*/) || tail.match(/❌[^\n]*/) || [''])[0];
    settle(code === 0, summary || `exit ${code}`, code === 0 ? '' : tail.slice(-300));
  });
} else if (!['status', '', undefined].includes(cmd)) {
  // 打错子命令不能静默走 status 分支还 exit 0 —— 脚本化调用会把
  // 「没领到号」当成「领到了」。审计实测：pool.mjs claimm --ref x 看起来是成功的。
  console.error(`未知子命令 ${cmd}。可用：add / claim / confirm / unconfirm / release / run / reset / verify / dead / cooling / status`);
  process.exit(2);
} else {
  console.log(JSON.stringify(poolStats(), null, 2));
  for (const status of ['available', 'assigned', 'ready', 'running', 'cooling', 'failed', 'done', 'dead']) {
    const rows = listByStatus(status, 20);
    if (!rows.length) continue;
    console.log(`\n[${status}]`);
    for (const r of rows) {
      console.log(`  ${r.address}${r.assigned_ref ? ` (ref=${r.assigned_ref})` : ''}${r.result ? ` — ${r.result.slice(0, 60)}` : ''}`);
    }
  }
}
