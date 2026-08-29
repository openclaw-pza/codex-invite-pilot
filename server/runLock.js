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

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
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
  writeFileSync(RUN_LOCK_PATH, JSON.stringify({
    pid: process.pid,
    address: String(label || ''),
    startedAt: new Date().toISOString(),
  }));
  return null;
}

export function releaseRunLock() {
  try { rmSync(RUN_LOCK_PATH, { force: true }); } catch { /* 删不掉就算了，下一轮按 pid 判失效 */ }
}
