import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.POOL_DB_PATH = join(mkdtempSync(join(tmpdir(), 'invite-')), 'pool.sqlite');
const pool = await import('../server/accountPool.js');
const { createInviteRoutes, viewOf } = await import('../server/inviteRoutes.js');

class FakeVendError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}
// 卡密会话的最小替身：真实实现在 vend-routes.js，这里只关心「卡号 → ref」这条线
// 假卡要带上用途标记：领邀请号需要它（见文件末尾 cardMayInvite 那组测试）
const session = (code) => ({ card: { code, status: 'unused', locked_service: 'codex-invite', denom_cny: 3.99 } });
const routes = createInviteRoutes({
  requireSession: (token) => {
    if (!token) throw new FakeVendError('登录状态已过期，请重新输入卡密', 401, 'session_expired');
    return session(String(token).replace('tok-', 'CARD-'));
  },
  VendError: FakeVendError,
});
const at = (method, path) => routes.find((r) => r.method === method && r.path === path).handler;

const claim = at('POST', '/api/invite/claim');
const sent = at('POST', '/api/invite/sent');
const status = at('GET', '/api/invite/status');

test('没号时领取给的是人话，不是 stack', async () => {
  await assert.rejects(
    () => claim({ body: { token: 'tok-001' } }),
    (e) => e.code === 'pool_empty' && /联系客服/.test(e.message),
  );
});

test('领取幂等：刷新页面不会再吃掉一个号', async () => {
  pool.addAccounts([{ address: 'a@outlook.com', password: 'p1' }, { address: 'b@outlook.com', password: 'p2' }]);
  const first = await claim({ body: { token: 'tok-001' } });
  const again = await claim({ body: { token: 'tok-001' } });
  assert.equal(first.address, 'a@outlook.com');
  assert.equal(again.address, first.address);
  assert.equal(pool.poolStats().available, 1);   // 只消耗了一个
});

// 🔴 这条是安哥定的硬约束：微软号第一次登录会被强制绑临时恢复邮箱（约 10 分钟失效），
// 邀请还没发就先登录 = 白赔一个号。所以领取阶段状态必须还停在 assigned。
test('领取阶段不推进队列 —— 一个字节都不碰账号', async () => {
  const row = pool.getByRef('CARD-001');
  assert.equal(row.status, 'assigned');
  assert.equal(row.invite_confirmed_at, null);
});

test('点了「我已发出邀请」才进队列', async () => {
  const r = await sent({ body: { token: 'tok-001' } });
  assert.equal(r.phase, 'queued');
  assert.equal(pool.getByRef('CARD-001').status, 'ready');
});

test('没领号就点「已发出邀请」要挡住', async () => {
  await assert.rejects(
    () => sent({ body: { token: 'tok-999' } }),
    (e) => e.code === 'not_claimed',
  );
});

test('重复点「我已发出邀请」不会把状态推回去', async () => {
  pool.markRunning('a@outlook.com');
  const r = await sent({ body: { token: 'tok-001' } });
  assert.equal(r.phase, 'running');
  assert.equal(pool.getByRef('CARD-001').status, 'running');
});

test('查进度不需要重新验卡，也不会串到别人的号', async () => {
  const mine = await status({ query: { token: 'tok-001' } });
  assert.equal(mine.address, 'a@outlook.com');
  const other = await status({ query: { token: 'tok-777' } });
  assert.equal(other.phase, 'none');
  assert.equal(other.address, '');
});

test('没带 token 一律拒绝', async () => {
  await assert.rejects(() => status({ query: {} }), (e) => e.status === 401);
  await assert.rejects(() => claim({ body: {} }), (e) => e.status === 401);
});

// 安哥明确要求：失败就显示「邀请失败，请联系客服」，不要把技术原因透给买家 ——
// OAuth 超时 / 接码没到 / 账号被停对买家没有任何可操作性，只会变成争执。
test('失败一律显示「邀请失败，请联系客服」，不漏技术原因', () => {
  const failed = viewOf({ status: 'failed', result: '❌ OAuth 阶段 3 分钟没等到邮箱验证码' });
  assert.equal(failed.text, '邀请失败，请联系客服');
  assert.equal(failed.done, true);
  assert.equal(/OAuth|验证码/.test(JSON.stringify(failed)), false);
});

test('没见过的状态按失败处理，不能当成成功', () => {
  for (const s of ['available', 'dead', '', undefined, 'whatever']) {
    const v = viewOf({ status: s });
    assert.equal(v.done && v.phase === 'done', false, `${s} 被当成了成功`);
  }
});

test('完成态给的是正向文案', () => {
  const v = viewOf({ status: 'done' });
  assert.equal(v.phase, 'done');
  assert.equal(v.done, true);
  assert.match(v.text, /完成/);
});

// ---------- worker 侧（跑在另一台机器上，反向来拉任务）----------

const guarded = createInviteRoutes({
  requireSession: () => ({ card: { code: 'CARD-001', locked_service: 'codex-invite', denom_cny: 3.99 } }),
  VendError: FakeVendError,
  workerSecret: 'S3CRET-worker',
});
const wAt = (path) => guarded.find((r) => r.path === path).handler;
const next = wAt('/api/invite/worker/next');
const report = wAt('/api/invite/worker/report');

test('没配口令时 worker 接口整个关闭', async () => {
  const off = createInviteRoutes({ requireSession: () => ({ card: { locked_service: 'codex-invite' } }), VendError: FakeVendError });
  const handler = off.find((r) => r.path === '/api/invite/worker/next').handler;
  await assert.rejects(() => handler({ body: { secret: 'anything' } }), (e) => e.status === 404);
});

test('口令不对一律拒绝，且不泄露队列信息', async () => {
  for (const bad of ['', 'wrong', 'S3CRET-worke', 'S3CRET-workerX', null]) {
    await assert.rejects(() => next({ body: { secret: bad } }), (e) => e.status === 403, `放行了：${bad}`);
  }
});

let queued = null;   // claimAccount 派的是**最老的可用号**，不是我指定的那个，所以用返回值
test('取任务：只给 ready 的，取到即置 running（防同一个号发给两个 worker）', async () => {
  pool.addAccounts([{ address: 'c@outlook.com', password: 'pw-c' }]);
  queued = pool.claimAccount('CARD-C');
  pool.confirmInvite(queued.address);

  const got = await next({ body: { secret: 'S3CRET-worker' } });
  assert.equal(got.job.address, queued.address);
  assert.equal(got.job.password, queued.password);   // worker 要拿密码去登录
  assert.equal(pool.getAccount(queued.address).status, 'running');

  const again = await next({ body: { secret: 'S3CRET-worker' } });
  assert.equal(again.job, null);                      // 同一个号不会被取第二次
});

test('回报结果写回号池，买家那边立刻看到终态', async () => {
  await report({ body: { secret: 'S3CRET-worker', address: queued.address, ok: true, result: '✅✅ 3/3' } });
  assert.equal(pool.getAccount(queued.address).status, 'done');
  assert.equal(viewOf(pool.getByRef('CARD-C')).phase, 'done');
});

test('回报不存在的号要挡住，别凭空造状态', async () => {
  await assert.rejects(
    () => report({ body: { secret: 'S3CRET-worker', address: 'nobody@outlook.com', ok: true } }),
    (e) => e.status === 404,
  );
});

// 🔴 这条是清扫逻辑最危险的地方：判错就会把**正在跑的那一轮**放回队列，
// 被第二个 worker 取走 —— 两轮同时跑正是整套设计最怕的事。
test('陈旧清扫绝不能碰刚开跑的那一轮', () => {
  pool.addAccounts([{ address: 'd@outlook.com', password: 'pw-d' }]);
  const fresh = pool.claimAccount('CARD-D');
  pool.confirmInvite(fresh.address);
  pool.markRunning(fresh.address);

  // 默认 45 分钟：刚开跑的这一轮绝不能被碰
  assert.equal(pool.reclaimStaleRunning().includes(fresh.address), false);
  assert.equal(pool.getAccount(fresh.address).status, 'running');

  // 阈值设成负数 = 全部算陈旧，这时才该放回队列
  assert.equal(pool.reclaimStaleRunning(-1).includes(fresh.address), true);
  assert.equal(pool.getAccount(fresh.address).status, 'ready');
});

// ---------- 卡的用途标记 ----------
// 没有这道闸时，一张 ¥1.9 的接码卡能直接领走一个邀请号，而邀请号是不可再生的。

const { cardMayInvite, INVITE_CARD } = await import('../server/inviteRoutes.js');

test('只有打了标记的邀请卡放行', () => {
  assert.equal(cardMayInvite({ locked_service: INVITE_CARD, denom_cny: 3.99 }), true);
  assert.equal(cardMayInvite({ locked_service: INVITE_CARD, denom_cny: 0.01 }), true);  // 面额不参与判断
});

test('锁了别的服务的卡（接码卡）一律拒绝', () => {
  for (const s of ['dr', 'go', 'tg', 'wa']) {
    assert.equal(cardMayInvite({ locked_service: s, denom_cny: 99 }), false, `${s} 被放行了`);
  }
});

// 🔴 曾经有过"没标记就按面额兜底"的设计，为的是不挡住买家已付款的老卡。
// 那批卡 2026-08-27 已全部注销，兜底随之删除 —— 留着它等于给任何高面额卡开后门
// （当时线上就还有一张 ¥5 的接码卡）。
test('没有标记一律拒绝，面额再高也不行', () => {
  for (const d of [0.2, 1.9, 3.99, 5, 99, null, undefined, 'abc']) {
    assert.equal(cardMayInvite({ locked_service: null, denom_cny: d }), false, `¥${d} 被放行了`);
  }
  assert.equal(cardMayInvite({}), false);
  assert.equal(cardMayInvite(null), false);
  assert.equal(cardMayInvite(undefined), false);
});
