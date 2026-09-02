// run-lock.test.js — 「整机只允许跑一轮邀请」这个保证的回归测试。
//
// 为什么值得单独钉：这把锁挡的是 desktop 端 CDP 端口和 ~/.codex 凭据被两轮同时抢。
// 它失效的代价不是报错，是**两个不可再生的邀请名额一起烧**，而且现场看不出来 ——
// 两轮都会"跑起来"，然后互相清凭据一起死。
//
// 2026-09-02 审计发现两个洞（本文件的 3、4 两组就是钉它们的）：
//   - releaseRunLock 无条件 rmSync，能删掉**别人**的锁
//   - acquireRunLock 是 check-then-act，两个进程同时起会双双抢到

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

process.env.RUN_LOCK_PATH = join(mkdtempSync(join(tmpdir(), 'runlock-')), 'run.lock');
const { acquireRunLock, releaseRunLock, lockHolder, RUN_LOCK_PATH } = await import('../server/runLock.js');

// 一个真活着的、不是自己的进程 —— 用来扮演「手工 pool.mjs run 那一轮」
const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
test.after(() => { try { other.kill('SIGKILL'); } catch { /* 已经没了 */ } });

const putForeignLock = () => writeFileSync(RUN_LOCK_PATH, JSON.stringify({
  pid: other.pid, address: 'manual@run.com', startedAt: new Date().toISOString(),
}));

test('抢到锁：返回 null，且锁里记的是自己的 pid', () => {
  assert.equal(acquireRunLock('me@outlook.com'), null);
  assert.equal(JSON.parse(readFileSync(RUN_LOCK_PATH, 'utf8')).pid, process.pid);
  assert.equal(releaseRunLock(), true);
  assert.equal(existsSync(RUN_LOCK_PATH), false);
});

test('别人占着时抢不到，且不许覆盖人家的锁', () => {
  putForeignLock();
  const holder = acquireRunLock('me@outlook.com');
  assert.equal(holder?.pid, other.pid);
  // 关键：抢失败绝不能把锁内容改成自己的，否则下一个进程会以为是自己在跑
  assert.equal(JSON.parse(readFileSync(RUN_LOCK_PATH, 'utf8')).pid, other.pid);
});

// 🔴 回归：invite-worker 的 process.on('exit', releaseRunLock) 是无条件挂的。
// 一个空闲的、根本没持锁的 worker 退出时，绝不能把手工那轮的锁删掉 ——
// 锁一没，systemd 拉起 worker 就能抢到，第二个 desktop-run 起跑，两个名额一起烧。
test('只删自己的锁：没持锁的进程删不动别人的', () => {
  putForeignLock();
  assert.equal(releaseRunLock(), false, '把别人的锁删了');
  assert.equal(existsSync(RUN_LOCK_PATH), true, '别人的锁文件被删掉了');
  assert.equal(lockHolder()?.pid, other.pid, '别人的锁内容被动过');
});

test('占用者进程已经死了 = 失效锁，照样抢得到', () => {
  // 一个几乎不可能存在的 pid（Linux/Windows 都远超默认 pid 上限）
  writeFileSync(RUN_LOCK_PATH, JSON.stringify({ pid: 0x7ffffff0, address: 'ghost', startedAt: '2020-01-01T00:00:00.000Z' }));
  assert.equal(lockHolder(), null, '死进程的锁没被判成失效');
  assert.equal(acquireRunLock('me@outlook.com'), null, '失效锁没被顶掉');
  assert.equal(JSON.parse(readFileSync(RUN_LOCK_PATH, 'utf8')).pid, process.pid);
  releaseRunLock();
});

test('锁文件不存在时 release 不抛错，也不报成功', () => {
  assert.equal(existsSync(RUN_LOCK_PATH), false);
  assert.equal(releaseRunLock(), false);
});
