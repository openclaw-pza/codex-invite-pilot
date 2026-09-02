// runLock.js — 整机只允许跑一轮邀请。
//
// 桌面端的 CDP 端口（9333）和登录凭据（~/.codex/auth.json）是**独占资源**。
// 两轮并行时，第二个实例会把第一个的凭据和本地状态清掉再抢端口 ——
// 两轮一起死，两个**不可再生**的邀请名额一起烧。
//
// 需要它的有两处：invite-worker（正常业务）和 pool.mjs run（手工跑/排查）。
// 两边共用这一份，免得各写一套然后只有一边生效。
//
// 锁里记 pid：进程没了就算失效锁，机器重启后不会把自己永久锁死。

import { readFileSync, writeFileSync, rmSync, openSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RUN_LOCK_PATH = process.env.RUN_LOCK_PATH || join(ROOT, 'data', 'run.lock');

/** 谁占着锁？没人占返回 null。占用者进程已死也返回 null（失效锁）。 */
export function lockHolder() {
  let prev;
  try { prev = JSON.parse(readFileSync(RUN_LOCK_PATH, 'utf8')); } catch { return null; }
  try { process.kill(prev.pid, 0); } catch { return null; }
  return prev;
}

/**
 * 抢锁。抢到返回 null，没抢到返回占用者（调用方自己决定是退出还是等）。
 * 不抛异常：两个调用方对"抢不到"的处理不一样（CLI 直接退，worker 退避重试）。
 */
export function acquireRunLock(label) {
  const holder = lockHolder();
  if (holder) return holder;
  const payload = JSON.stringify({
    pid: process.pid,
    address: String(label || ''),
    startedAt: new Date().toISOString(),
  });
  try {
    // 'wx' = 文件已存在就抛。原来是「先读一次，没人占就写」——两个进程同时起来会
    // 双双读到"没人占"，然后双双写进去、双双开跑。check-then-act 的缝只能靠
    // 内核的原子创建来堵，不能靠先读一次。
    const fd = openSync(RUN_LOCK_PATH, 'wx');
    try { writeFileSync(fd, payload); } finally { closeSync(fd); }
    return null;
  } catch {
    // 创建失败只有两种可能：真有人占着，或者是一把失效锁（进程早没了）。
    const again = lockHolder();
    if (again) return again;
    writeFileSync(RUN_LOCK_PATH, payload);
    return null;
  }
}

/**
 * 只删自己的锁。
 *
 * 🔴 原来是无条件 rmSync。而 invite-worker 的 `process.on('exit', releaseRunLock)`
 * 也是无条件挂的 —— 于是一个**空闲**（根本没持锁）的 worker 退出时，会把
 * 手工 `pool.mjs run` 那一轮的锁删掉。锁没了，systemd 把 worker 拉起来就能抢到，
 * 第二个 desktop-run 起跑 —— 两轮抢同一个 CDP 端口、互相清 ~/.codex/auth.json，
 * 两轮一起死、两个不可再生的名额一起烧。那正是这把锁存在的唯一理由。
 *
 * @returns {boolean} 真的删掉了才返回 true
 */
export function releaseRunLock() {
  try {
    const prev = JSON.parse(readFileSync(RUN_LOCK_PATH, 'utf8'));
    if (prev.pid !== process.pid) return false;   // 不是我的，一个字节都不动
  } catch { return false; }
  try { rmSync(RUN_LOCK_PATH, { force: true }); } catch { /* 删不掉就算了，下一轮按 pid 判失效 */ }
  return true;
}
