import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.POOL_DB_PATH = join(mkdtempSync(join(tmpdir(), 'pool-')), 'pool.sqlite');
const pool = await import('../server/accountPool.js');

test('入池 + 领号：只改状态，地址原样交出', () => {
  pool.addAccounts([
    { address: 'A@Outlook.com', password: 'p1' },
    { address: 'b@outlook.com', password: 'p2' },
  ]);
  const got = pool.claimAccount('card-001');
  assert.equal(got.status, 'assigned');
  assert.equal(got.assigned_ref, 'card-001');
  assert.equal(got.address, 'a@outlook.com');   // 地址统一小写，避免大小写造成重复
  assert.equal(got.password, 'p1');
});

// 买家刷新页面不该多吃一个号
test('同一张卡再来要号，返回同一个（幂等）', () => {
  const again = pool.claimAccount('card-001');
  assert.equal(again.address, 'a@outlook.com');
  assert.equal(again.reused, true);
  assert.equal(pool.poolStats().available, 1);
});

// 🔴 这条是整个池子最重要的闸：邀请没到就登录，会提前绑上十分钟就失效的
// 临时恢复邮箱，等于白废一个微软号。
test('没确认邀请就想开跑 → 必须拒绝', () => {
  assert.throws(() => pool.markRunning('a@outlook.com'), /不在 ready 状态/);
});

test('确认邀请后才允许开跑', () => {
  const ready = pool.confirmInvite('a@outlook.com');
  assert.equal(ready.status, 'ready');
  assert.ok(ready.invite_confirmed_at);
  assert.equal(pool.markRunning('a@outlook.com'), true);
  assert.equal(pool.getAccount('a@outlook.com').status, 'running');
});

test('跑完记结果，失败的号不再被领走', () => {
  pool.markFinished('a@outlook.com', { ok: false, result: '桌面端没登上' });
  assert.equal(pool.getAccount('a@outlook.com').status, 'failed');
  const next = pool.claimAccount('card-002');
  assert.equal(next.address, 'b@outlook.com');
});

test('重复入池不覆盖已有状态（免得把在跑的号重置回可用）', () => {
  pool.addAccounts([{ address: 'b@outlook.com', password: '改过的密码' }]);
  const b = pool.getAccount('b@outlook.com');
  assert.equal(b.password, 'p2');
  assert.equal(b.status, 'assigned');
});

test('池空时明确报错，不返回一个空对象让上游拿去跑', () => {
  assert.throws(() => pool.claimAccount('card-003'), /账号池已空/);
});

test('markDead 的号永久退出分配', () => {
  pool.addAccounts([{ address: 'c@outlook.com', password: 'p3' }]);
  pool.markDead('c@outlook.com', '登不上');
  assert.throws(() => pool.claimAccount('card-004'), /账号池已空/);
  assert.equal(pool.poolStats().dead, 1);
});

// 下面这组是 2026-08-26 独立审计发现的漏洞，补上回归测试。
// 它们覆盖的都是「会白废一个不可再生的微软号」的路径。

test('🔴 绕闸路径：markFinished 不能把没开跑的号打成 failed', () => {
  pool.addAccounts([{ address: 'g1@outlook.com', password: 'p' }]);
  pool.claimAccount('card-g1');            // assigned，买家还没发邀请
  // 审计实测的绕闸链：markRunning 被拒 → 但 markFinished 无守卫 → reset 洗成 ready
  // → markRunning 就通过了，而 invite_confirmed_at 仍是 null。
  assert.throws(() => pool.markRunning('g1@outlook.com'), /不在 ready 状态/);
  assert.throws(() => pool.markFinished('g1@outlook.com', { ok: false }), /不在 running 状态/);
  assert.equal(pool.getAccount('g1@outlook.com').status, 'assigned');
});

test('🔴 reset 默认拒绝 running（子进程可能还活着，重跑=两个进程登同一个号）', () => {
  pool.confirmInvite('g1@outlook.com');
  pool.markRunning('g1@outlook.com');
  assert.throws(() => pool.resetToReady('g1@outlook.com'), /拒绝 reset/);
  // 运维确认进程已死之后才允许 force
  assert.equal(pool.resetToReady('g1@outlook.com', { force: true }).status, 'ready');
});

test('reset 要清掉上一轮的失败原因，否则面板显示 ready 却挂着旧报错', () => {
  pool.markRunning('g1@outlook.com');
  pool.markFinished('g1@outlook.com', { ok: false, result: '❌ 上一轮的失败原因' });
  const back = pool.resetToReady('g1@outlook.com');
  assert.equal(back.status, 'ready');
  assert.equal(back.result, null);
});

test('同一张卡在号 failed 之后再领，拿回原来那个而不是再吃一个新号', () => {
  pool.markRunning('g1@outlook.com');
  pool.markFinished('g1@outlook.com', { ok: false, result: '跑挂了' });
  const again = pool.claimAccount('card-g1');
  assert.equal(again.address, 'g1@outlook.com');
  assert.equal(again.reused, true);   // 邀请名额已经消耗在这个号上，不能再换新号
});

test('markDead 地址打错要报错，不能静默返回成功', () => {
  assert.throws(() => pool.markDead('根本不存在@outlook.com'), /池子里没有/);
});

test('重复 confirm 不冲掉原始确认时刻（邀请是时效敏感的）', () => {
  pool.addAccounts([{ address: 'g2@outlook.com', password: 'p' }]);
  pool.claimAccount('card-g2');
  const first = pool.confirmInvite('g2@outlook.com').invite_confirmed_at;
  const second = pool.confirmInvite('g2@outlook.com').invite_confirmed_at;
  assert.equal(first, second);
});

// 【Graph 令牌号】的令牌必须真的落库。INSERT OR IGNORE 会把它静默丢掉，
// 而"新入池 1 个"看着完全正常 —— 2026-08-27 实测就是这么丢的。
test('带令牌入池：令牌和 client_id 都要存下来', () => {
  pool.addAccounts([{ address: 'tok@outlook.com', password: 'pw', refreshToken: 'M.' + 'x'.repeat(300), clientId: '9e5f94bc-e8a4-4e73-b8be-63364c29d753' }]);
  const row = pool.getAccount('tok@outlook.com');
  assert.equal(row.refresh_token.length, 302);
  assert.equal(row.client_id, '9e5f94bc-e8a4-4e73-b8be-63364c29d753');
});

test('已存在的号可以补令牌，但不能碰状态', () => {
  pool.addAccounts([{ address: 'later@outlook.com', password: 'pw' }]);
  pool.claimAccount('CARD-LATER');
  const before = pool.getAccount('later@outlook.com').status;
  const r = pool.addAccounts([{ address: 'later@outlook.com', password: 'pw', refreshToken: 'M.' + 'y'.repeat(200), clientId: 'cid-1' }]);
  assert.equal(r.added, 0);
  assert.equal(r.patchedToken, 1);
  const row = pool.getAccount('later@outlook.com');
  assert.equal(row.refresh_token.length, 202);
  assert.equal(row.status, before);          // 状态原样不动
});

test('已有令牌的号不会被再次覆盖', () => {
  pool.addAccounts([{ address: 'keep@outlook.com', password: 'pw', refreshToken: 'M.' + 'a'.repeat(100) }]);
  pool.addAccounts([{ address: 'keep@outlook.com', password: 'pw', refreshToken: 'M.' + 'b'.repeat(100) }]);
  assert.match(pool.getAccount('keep@outlook.com').refresh_token, /^M\.a+$/);
});

// 退回未确认：只有 ready 能退。running 的子进程可能还活着，
// done/failed 是终态 —— 退回去会让一个已经跑过的号重新排队。
test('unconfirm 只认 ready，其余状态一律拒绝', () => {
  pool.addAccounts([{ address: 'unc@outlook.com', password: 'pw' }]);
  // claimAccount 派的是**最老的可用号**，不是我指定的那个 —— 用返回值
  const a = pool.claimAccount('CARD-UNC').address;
  assert.throws(() => pool.unconfirmInvite(a), /不在 ready/);   // assigned 不能退
  pool.confirmInvite(a);
  assert.equal(pool.unconfirmInvite(a), true);
  const row = pool.getAccount(a);
  assert.equal(row.status, 'assigned');
  assert.equal(row.invite_confirmed_at, null);
  pool.confirmInvite(a);
  pool.markRunning(a);
  assert.throws(() => pool.unconfirmInvite(a), /不在 ready/);   // running 不能退
});

// 收回号：卡退款/注销而邀请还没发时用。只认 assigned ——
// ready 说明买家已确认发了邀请，running 可能还在跑，done/failed 是终态。
//
// 🔴 2026-09-02 改了落点：收回来只到**隔离区**（cooling），不再直接回 available。
// 依据是安哥明确的一条业务事实——一个 outlook 只能被邀请一次，而买家完全可能在
// 号被收回之后才把邀请发出来。详见 test/invite-cooling.test.js 的文件头。
test('release 只认 assigned，收回的号进隔离区而不是可分配池', () => {
  pool.addAccounts([{ address: 'rel@outlook.com', password: 'pw' }]);
  const a = pool.claimAccount('CARD-REL').address;
  assert.equal(pool.releaseAccount(a), true);
  const row = pool.getAccount(a);
  assert.equal(row.status, 'cooling');
  assert.notEqual(row.status, 'available', '直接放回可分配池会把两个买家的钱货错配');
  assert.equal(row.assigned_ref, null);          // 释放了唯一索引
  assert.throws(() => pool.releaseAccount(a), /不在 assigned/);   // cooling 不能再退
  const b = pool.claimAccount('CARD-REL2').address;
  pool.confirmInvite(b);
  assert.throws(() => pool.releaseAccount(b), /不在 assigned/);   // ready 不能退
});

test('轮换来的新令牌要能写回，但 CAS 挡住拿陈旧值换来的', () => {
  pool.addAccounts([{ address: 'cas1@outlook.com', password: 'p', refreshToken: 'GEN-1', clientId: 'c' }]);

  // 正常轮换：手里的旧值和库里一致 → 写得进去
  assert.equal(pool.updateRefreshToken('cas1@outlook.com', 'GEN-2', { expect: 'GEN-1' }), true);
  assert.equal(pool.getAccount('cas1@outlook.com').refresh_token, 'GEN-2');

  // 陈旧值：手里还是 GEN-1，但库里已经是 GEN-2 了 → 必须挡住。
  // 挡不住的话会把轮换链掰回上一环，而微软对轮换令牌有重放检测。
  assert.equal(pool.updateRefreshToken('cas1@outlook.com', 'STALE', { expect: 'GEN-1' }), false);
  assert.equal(pool.getAccount('cas1@outlook.com').refresh_token, 'GEN-2',
    'CAS 没挡住，陈旧值把更新的令牌覆盖了');

  // 判死的号不再改令牌：它的令牌就是死因，覆盖掉就看不到证据了
  pool.markDead('cas1@outlook.com', '令牌失效');
  assert.equal(pool.updateRefreshToken('cas1@outlook.com', 'GEN-3'), false);
});
