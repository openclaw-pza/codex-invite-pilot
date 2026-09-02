// invite-cooling.test.js — 收回的号必须先隔离，不能直接再卖。
//
// 🔴 这里钉的是整套系统里最坏的一种错：**钱和货给了两个不同的人**。
//
// 判据来自安哥 2026-09-02 明确的一条业务事实：一个 outlook **只能被邀请一次**。
// 而 inviteSweep 读信箱只是**某一刻**的快照 —— 买家1 完全可能在号被收回之后
// 才把邀请发出来。号要是直接回到 available 被买家2 领走：
//   desktop-run 的微软臂**不设基线**（scripts/desktop/desktop-run.mjs:615-617，
//   注释原话是"一号一邀，信箱里那封就是我们要的那封"）
//   → 它认到的是**买家1那封** → 买家2 付了钱，500 额度记到买家1 头上，
//     买家2 自己的邀请名额还白烧一个。两边都不会察觉。
//
// 所以宁可让号在隔离区多关一会儿，也不能凭一次快照就当它是干净的。
// 线上实测：release 这条路径 30 天内一次都没触发过，隔离的库存代价约等于零。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 必须在 import accountPool **之前**设好：POOL_DB_PATH 是在模块作用域读的，
// 晚一步就会打到仓库里那个真实的 data/account-pool.sqlite 上。
process.env.POOL_DB_PATH = join(mkdtempSync(join(tmpdir(), 'cooling-')), 'pool.sqlite');
const pool = await import('../server/accountPool.js');

test('收回的号进隔离区，绝不直接回到可分配池', () => {
  pool.addAccounts([{ address: 'cool-1@outlook.com', password: 'pw' }]);
  const got = pool.claimAccount('CARD-COOL-1');
  pool.releaseAccount(got.address);

  const row = pool.getAccount(got.address);
  assert.equal(row.status, 'cooling', '被直接放回可分配池了 —— 会把两个买家的钱货错配');
  assert.ok(row.cooled_at, '没记隔离时刻');
  // 留痕：复检时看到信箱里有邀请，得能说清那是谁的
  assert.match(row.note || '', /CARD-COOL-1/);
  // 隔离中的号不能被 claim 走
  assert.equal(pool.listByStatus('available').some((r) => r.address === got.address), false);
  assert.throws(() => pool.claimAccount('CARD-OTHER'), /账号池已空/);
});

test('复检判干净才放回；信箱里有邀请就打死（名额已被消耗）', () => {
  pool.addAccounts([
    { address: 'cool-2@outlook.com', password: 'pw' },
    { address: 'cool-3@outlook.com', password: 'pw' },
  ]);
  // 断言增量而不是绝对值：绝对值依赖前一条用例的残留，单独跑这条会误报红。
  const before = pool.listCooling().length;
  const a = pool.claimAccount('CARD-COOL-2');
  pool.releaseAccount(a.address);
  const b = pool.claimAccount('CARD-COOL-3');
  pool.releaseAccount(b.address);

  assert.equal(pool.listCooling().length, before + 2);

  pool.settleCooling(a.address, { clean: true, detail: '复检：信箱无邀请信' });
  assert.equal(pool.getAccount(a.address).status, 'available');
  assert.equal(pool.getAccount(a.address).cooled_at, null);

  pool.settleCooling(b.address, { clean: false, detail: '复检：信箱里已有邀请信' });
  const dead = pool.getAccount(b.address);
  assert.equal(dead.status, 'dead', '被消耗掉的号还留在可分配集合里');
  assert.ok(dead.finished_at, 'dead 没记时间');
});

test('只有 cooling 能被复检结算，别的状态一律拒绝', () => {
  pool.addAccounts([{ address: 'cool-4@outlook.com', password: 'pw' }]);
  assert.throws(() => pool.settleCooling('cool-4@outlook.com', { clean: true }), /不在 cooling/);
  assert.equal(pool.getAccount('cool-4@outlook.com').status, 'available');
  assert.throws(() => pool.settleCooling('nobody@outlook.com', { clean: true }), /不在 cooling/);
});

// releaseAccount 的守卫没变：只有「已领号但邀请未发」才收得回来。
// ready/running 的号收回去 = 把一个买家已经发了邀请的号拿去再卖。
test('只有 assigned 收得回来，已发过邀请的一律拒绝', () => {
  pool.addAccounts([{ address: 'cool-5@outlook.com', password: 'pw' }]);
  const got = pool.claimAccount('CARD-COOL-5');
  pool.confirmInvite(got.address);
  assert.throws(() => pool.releaseAccount(got.address), /不在 assigned 状态/);
  assert.equal(pool.getAccount(got.address).status, 'ready');
});

// 🔴 漏传参数的默认动作绝不能是「打死一个号」。方向必须反过来：拿不准就报错。
test('clean 必须显式传 true/false，漏传时报错而不是默认打死', () => {
  pool.addAccounts([{ address: 'cool-7@outlook.com', password: 'pw' }]);
  const got = pool.claimAccount('CARD-COOL-7');
  pool.releaseAccount(got.address);

  assert.throws(() => pool.settleCooling(got.address, {}), /显式/);
  assert.throws(() => pool.settleCooling(got.address, { detail: '忘了传 clean' }), /显式/);
  // 报错之后号必须原封不动还在隔离区，绝不能被顺手打死
  assert.equal(pool.getAccount(got.address).status, 'cooling');
});

// 🔴 号进隔离区时 assigned_ref 必须清空（那一列有唯一索引，留着会占住卡的坑），
// 但清空之后买家侧就反查不到了 —— 状态接口回空壳，前端结论区和转圈区一起隐藏、
// 领取按钮不出现、轮询永不停，买家页面上一个字都没有。
// 这个洞在 dead 那条上补过一次，released_ref 就是不让它在 cooling 上重开。
test('隔离掉的号仍能按原卡号反查到，别把买家留在白板页', () => {
  pool.addAccounts([{ address: 'cool-8@outlook.com', password: 'pw' }]);
  const got = pool.claimAccount('CARD-COOL-8');
  assert.equal(pool.getAnyByRef('CARD-COOL-8')?.address, got.address);

  pool.releaseAccount(got.address);
  // 唯一索引那一列必须已清空，否则这张卡的坑一直被占着
  assert.equal(pool.getAccount(got.address).assigned_ref, null);
  // 但反查链路要还在
  const found = pool.getAnyByRef('CARD-COOL-8');
  assert.ok(found, '隔离后反查不到了 —— 买家会看到一张空白页面');
  assert.equal(found.address, got.address);
  assert.equal(found.status, 'cooling');
  // 活号查询仍然查不到它（它不该再被当成买家名下的活号）
  assert.equal(pool.getByRef('CARD-COOL-8'), null);
});
