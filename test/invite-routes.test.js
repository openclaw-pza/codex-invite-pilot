import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
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

// ---------- 排队排位（2026-09-02 安哥要求的硬闸）----------
//
// 买家看不到自己排第几时，会以为系统卡死然后重复下单 —— 当天就真出过一次，
// 两张卡吃掉两个不可再生的邀请名额。这组测试钉的是「显示出来的数字不能骗人」。

test('排队文案按人数变化，0 个人时不说「前面还有 0 个」', () => {
  const row = { status: 'ready' };
  const two = viewOf(row, 2);
  assert.match(two.text, /前面还有 2 个人在排队/);
  assert.match(two.text, /6～10 分钟/);
  assert.equal(two.ahead, 2);
  assert.match(viewOf(row, 0).text, /马上就轮到你/);
  assert.equal(/前面还有 0/.test(viewOf(row, 0).text), false);
});

test('不传排位时退回原来的通用文案，老调用点不受影响', () => {
  const v = viewOf({ status: 'ready' });
  assert.equal(v.phase, 'queued');
  assert.equal(v.text, '已排队，正在等待空闲通道…');
  assert.equal(v.ahead, null);
});

test('只有排队态才谈排位，其余状态一律 null', () => {
  for (const s of ['assigned', 'running', 'done', 'failed', 'available']) {
    assert.equal(pool.queueAheadOf({ status: s, created_at: '2099-01-01T00:00:00.000Z' }), null, `${s} 不该有排位`);
  }
  assert.equal(pool.queueAheadOf(null), null);
  assert.equal(pool.queueAheadOf({ status: 'ready' }), null);
  // 字段残缺时说「不知道」，绝不抛 —— 这个函数挂在买家每 4 秒一次的状态轮询上，抛了就是 500
  assert.equal(pool.queueAheadOf({ status: 'ready', invite_confirmed_at: '2026-01-01T00:00:00.000Z' }), null);
  assert.equal(pool.queueAheadOf({ status: 'ready', address: 'x@o.com' }), null);
});

test('排位 = 比我早的 ready + 正在跑的，和派单同一个判据', () => {
  // 用一个"排在所有人后面"的虚拟行来读队长，这样断言的是增量，不依赖前面测试留下的状态
  const last = { status: 'ready', address: 'zzzz@outlook.com', invite_confirmed_at: '2099-01-01T00:00:00.000Z' };
  const before = pool.queueAheadOf(last);

  pool.addAccounts([{ address: 'q1@outlook.com', password: 'pw1' }, { address: 'q2@outlook.com', password: 'pw2' }]);
  const a = pool.claimAccount('CARD-Q1');
  pool.confirmInvite(a.address);
  assert.equal(pool.queueAheadOf(last), before + 1);

  const b = pool.claimAccount('CARD-Q2');
  pool.confirmInvite(b.address);
  assert.equal(pool.queueAheadOf(last), before + 2);

  // 排位里绝不能把自己算进去：队头看到的人数一定比队尾少
  const head = pool.listByStatus('ready', 1)[0];
  assert.equal(pool.queueAheadOf(head) < pool.queueAheadOf(last), true, '队头把自己也数进去了');

  // ready → running 不该让后面的人数字变小：他还挡在你前面，只是换了个状态
  pool.markRunning(a.address);
  assert.equal(pool.queueAheadOf(last), before + 2, 'running 的人被漏数了');
});

test('买家查状态时拿到的就是真实排位，不是写死的文案', async () => {
  const view = await status({ query: { token: 'tok-Q2' } });
  assert.equal(view.phase, 'queued');
  assert.equal(Number.isFinite(view.ahead), true);
  assert.match(view.text, /排队|轮到你/);
});

// ---------- 派单顺序 + 可重试失败（2026-09-02 审计后的第二轮）----------

const napMs = (ms) => new Promise((r) => setTimeout(r, ms));

// 🔴 队列的先后必须是「买家确认发出邀请」的先后，不是「号入库」的先后。
// 按 created_at 排的后果：先领号、后发邀请的人会插到别人前面，别人页面上的排位
// 从 0 变 1、1 变 2 —— 而买家看到进度倒退，正是他判定"系统坏了"再下一单的原因，
// 也就是这个排位功能本来要消灭的东西。
test('派单按确认时间，不按号的入库时间：先领号后确认的人不许插队', async () => {
  // 🔴 必须先清掉前面用例留下的 ready 残留，否则本用例是一条**假绿**。
  // 2026-09-02 的对抗性审计用变异测试证明了这一点：把 QUEUE_ORDER 改回 created_at
  // （也就是把这个功能整个撤掉），全套测试 0 条红 —— 因为残留那一行在两套排序下
  // 都排最前，`队头 === 最小排位` 这个断言无论派单顺序对不对都成立。
  // 我在下面写了「残留不归我管」并改用相对断言绕开它，那个绕法恰好把这条
  // 绝对断言也一起架空了。**尺子先修好，再量东西。**
  for (const leftover of pool.listByStatus('ready', 99)) {
    pool.markDead(leftover.address, '测试隔离：清掉前面用例的 ready 残留');
  }
  pool.addAccounts([
    { address: 'ord-a@outlook.com', password: 'pa' },
    { address: 'ord-b@outlook.com', password: 'pb' },
    { address: 'ord-c@outlook.com', password: 'pc' },
  ]);
  // 领号顺序 A→B→C，所以 A 的 created_at 最早
  const a = pool.claimAccount('CARD-ORD-A');
  const b = pool.claimAccount('CARD-ORD-B');
  const c = pool.claimAccount('CARD-ORD-C');

  // 确认顺序反过来：C 先发出邀请，然后 B，A 磨蹭到最后
  pool.confirmInvite(c.address); await napMs(3);
  pool.confirmInvite(b.address); await napMs(3);
  const aheadOfB = pool.queueAheadOf(pool.getAccount(b.address));
  pool.confirmInvite(a.address); await napMs(3);

  // 断言看这三者的**相对**位置：前面的用例会留下 ready 残留，全局队头不归我管
  const pos = (x) => pool.queueAheadOf(pool.getAccount(x.address));
  // A 后确认，就该排在 C、B 后面 —— 哪怕它的号是最早入库的（旧的 created_at 判据下 A 会排最前）
  assert.equal(pos(c) < pos(b), true, `确认最早的 C 没排在 B 前面（C=${pos(c)} B=${pos(b)}）`);
  assert.equal(pos(b) < pos(a), true, `A 插队排到了 B 前面（A=${pos(a)} B=${pos(b)}）`);
  // B 的排位不能因为 A 的加入而变大 —— 数字倒退正是这个功能要消灭的东西
  assert.equal(pos(b), aheadOfB, 'B 的排位被后来的人顶大了');
  // 派单队头必须和排位用同一个判据：排位为 n 的那位，前面确实有 n 个人
  const head = pool.nextReady();
  const everyone = pool.listByStatus('ready', 99).map((r) => pool.queueAheadOf(r));
  assert.equal(pool.queueAheadOf(head), Math.min(...everyone), '队头不是排位最小的那个 —— 派单和显示用了两套判据');
});

// 🔴 worker 压根没跑过的失败（本机锁被占、spawn 挂了、看门狗回收）不能写 failed。
// failed 在买家侧是终态死路：卡不退、号不回队列，只能人工 reset。
// 实测过的代价：锁被占 5 分钟 = 队列前 10 个已付费买家被逐个判死。
test('带 requeue 的失败回队列，不打成 failed，且排位不变', async () => {
  const job = await next({ body: { secret: 'S3CRET-worker' } });
  assert.ok(job.job, '没取到任务');
  const addr = job.job.address;
  assert.equal(pool.getAccount(addr).status, 'running');
  const before = pool.getAccount(addr).invite_confirmed_at;

  const out = await report({ body: { secret: 'S3CRET-worker', address: addr, ok: false, requeue: true, result: '❌ 通道忙，请稍后重试' } });
  assert.equal(out.status, 'ready');
  assert.equal(out.requeued, true);
  assert.equal(pool.getAccount(addr).status, 'ready');
  // 站回原来的位置：确认时刻一个字都不能动，否则他会被排到队尾
  assert.equal(pool.getAccount(addr).invite_confirmed_at, before, '回队列时把确认时刻冲掉了');
  // 买家侧看到的仍是排队中，不是「邀请失败，请联系客服」
  assert.equal(viewOf(pool.getAccount(addr), 0).phase, 'queued');
});

test('重排有上限：跑够 MAX_RUN_ATTEMPTS 轮就老实落 failed，别无限烧接码费', async () => {
  let addr = null;
  for (let i = 0; i < pool.MAX_RUN_ATTEMPTS + 1; i += 1) {
    const got = await next({ body: { secret: 'S3CRET-worker' } });
    if (!got.job) break;
    addr = got.job.address;
    await report({ body: { secret: 'S3CRET-worker', address: addr, ok: false, requeue: true, result: '❌ 通道忙' } });
    if (pool.getAccount(addr).status === 'failed') break;
  }
  const row = pool.getAccount(addr);
  assert.equal(row.status, 'failed', `跑了 ${row.run_attempts} 轮还在无限重排`);
  assert.equal(row.run_attempts >= pool.MAX_RUN_ATTEMPTS, true);
});

// worker 回报会重试 5 次，「第一次已落库、响应在网络上丢了」是常态。
// 不认幂等的话第 2 次起必然 500，日志刷 5 条假告警，运维会以为号还卡在 running。
test('重复回报同一个终态是幂等的，不抛 500', async () => {
  const got = await next({ body: { secret: 'S3CRET-worker' } });
  assert.ok(got.job, '没取到任务');
  const addr = got.job.address;
  const first = await report({ body: { secret: 'S3CRET-worker', address: addr, ok: true, result: '✅✅ 2/2' } });
  assert.equal(first.status, 'done');
  const again = await report({ body: { secret: 'S3CRET-worker', address: addr, ok: true, result: '✅✅ 2/2' } });
  assert.equal(again.status, 'done');
  assert.equal(again.idempotent, true);
});

// 号被标 dead 是运维日常动作（令牌失效/被封）。此前买家侧会拿到一个空壳
// {phase:'none', address:''}：前端按 address 判「领取」按钮显隐、而它缓存着旧
// address，于是按钮不出现；结论区和转圈区又都被 phase='none' 隐藏；done=false
// 让轮询永不停 —— 买家页面上一个字都没有，每 4 秒空转一次。
test('号被标 dead 后要给买家一个明确终态，不能留一张空白页面', async () => {
  pool.addAccounts([{ address: 'dead-1@outlook.com', password: 'pw' }]);
  const got = pool.claimAccount('CARD-DEAD-1');
  pool.markDead(got.address, '令牌失效');

  const view = await status({ query: { token: 'tok-DEAD-1' } });
  assert.equal(view.phase, 'failed');
  assert.equal(view.done, true, 'done 不为 true 的话前端会一直空转轮询');
  assert.match(view.text, /联系客服/);
  // 仍然不把技术原因透给买家
  assert.equal(/令牌|dead|token/i.test(JSON.stringify(view)), false);
});

test('从来没领过号的卡仍然是 none，不许误报成失败', async () => {
  const view = await status({ query: { token: 'tok-NEVER-CLAIMED' } });
  assert.equal(view.phase, 'none');
  assert.equal(view.done, false);
});

// ---------- 2026-09-02 对抗性审计抓到的三条回归 ----------

// 🔴 reset 是 failed（买家侧终态死路）唯一的人工出口。不清 run_attempts 的话，
// reset 回来的号第一次瞬时故障就再次被判死 —— 运维会得出"reset 不管用"的结论，
// 然后弃用唯一有效的补救手段。让人失去对补救工具信任的 bug，比偶发功能 bug 贵。
test('reset 必须把重试预算一起还原，否则救回来的号第一次打嗝又死', async () => {
  pool.addAccounts([{ address: 'rst-1@outlook.com', password: 'pw' }]);
  const got = pool.claimAccount('CARD-RST-1');
  pool.confirmInvite(got.address);
  for (let i = 0; i < pool.MAX_RUN_ATTEMPTS; i += 1) {
    pool.markRunning(got.address);
    if (!pool.requeueRun(got.address, { note: '瞬时故障' })) break;
  }
  assert.equal(pool.getAccount(got.address).run_attempts >= pool.MAX_RUN_ATTEMPTS, true);

  pool.markFinished(got.address, { ok: false, result: '❌ 用尽' });
  pool.resetToReady(got.address);
  assert.equal(pool.getAccount(got.address).run_attempts, 0, 'reset 没清重试预算 —— 救回来的号会立刻再死');

  // 还原之后确实又能重排了
  pool.markRunning(got.address);
  assert.equal(pool.requeueRun(got.address, { note: '再来一次' }), true);
});

// worker 回报会重试 5 次，「第一次已落库、响应丢包」是常态。
// requeue 分支自己也必须幂等，否则重试全是 500，日志刷 5 条假告警 ——
// 正是这个修复本来要消灭的现象。
test('requeue 回报重复送达也是幂等的，不抛 500', async () => {
  const got = await next({ body: { secret: 'S3CRET-worker' } });
  assert.ok(got.job, '没取到任务');
  const addr = got.job.address;
  const first = await report({ body: { secret: 'S3CRET-worker', address: addr, ok: false, requeue: true, result: '❌ 通道忙' } });
  assert.equal(first.status, 'ready');
  const again = await report({ body: { secret: 'S3CRET-worker', address: addr, ok: false, requeue: true, result: '❌ 通道忙' } });
  assert.equal(again.status, 'ready');
  assert.equal(again.idempotent, true);
  assert.equal(pool.getAccount(addr).status, 'ready', '重复回报把状态改坏了');
});

// 🔴 派单顺序只能有一套。网站侧和 CLI 侧各用一套时，运维手工跑一轮会跳过真正的
// 队头，被跳过那位买家的排位就会倒退 —— 而排位倒退正是这个功能要消灭的东西。
// 这条用源码当判据：CLI 里再出现 listByStatus('ready' 就说明又分叉了。
test('派单入口只能有一个判据：CLI 不许自己按另一套顺序取 ready', () => {
  const raw = readFileSync(new URL('../scripts/pool.mjs', import.meta.url), 'utf8');
  // 先剥掉行注释再判 —— 否则会匹配到解释"这里曾经是什么"的那句注释，
  // 变成一条永远红的假警报。判据要落在**会执行的代码**上。
  const code = raw.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.equal(
    /listByStatus\(\s*'ready'/.test(code), false,
    'scripts/pool.mjs 又在自己按 created_at 取队头了 —— 必须走 nextReady()，否则排位会倒退',
  );
  assert.match(code, /nextReady\(\)/, 'CLI 没有走统一的派单入口');
});
