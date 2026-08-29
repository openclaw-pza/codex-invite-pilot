// vend-audit-fixes.test.js — 2026-08-20 对抗性审计发现问题的回归测试
//
// 每个用例对应一条审计结论。这些洞都是「读代码看不出来、实跑才暴露」的类型，
// 所以必须留测试，别让以后的改动把它们放回去。
//
// 红线：只用临时目录的库和临时端口，不碰 data/vend.sqlite。

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';

import { CardStore, CARD_CONSTANTS } from '../server/cards.js';

const SECRET = 'audit-fix-secret-ascii';
const ADMIN = 'audit-fix-admin-ascii';
process.env.VEND_ISSUE_SECRET = SECRET;
process.env.VEND_ADMIN_TOKEN = ADMIN;

const { startVendServer } = await import('../server/vend-server.js');

function freshStore(t) {
  const dir = join(tmpdir(), `vend-fix-${randomUUID()}`);
  const store = new CardStore(join(dir, 'vend.sqlite'));
  t.after(() => {
    try { store.close(); } catch { /* 已关 */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });
  return store;
}

async function boot(t) {
  const dir = join(tmpdir(), `vend-fix-srv-${randomUUID()}`);
  const app = await startVendServer({
    dbPath: join(dir, 'vend.sqlite'), port: 0, host: '127.0.0.1', skipVendorSync: true,
  });
  t.after(async () => {
    await app.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });
  return app;
}

// 用裸 socket 发请求：fetch 不允许构造非法 Host 头
function rawRequest(port, lines) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(`${lines.join('\r\n')}\r\n\r\n`));
    let data = '';
    socket.on('data', (chunk) => { data += chunk.toString('utf8'); });
    socket.on('close', () => resolve(data));
    socket.on('error', () => resolve(data));
    setTimeout(() => { socket.destroy(); resolve(data); }, 2500);
  });
}

test('R1 畸形 Host 头不能打死进程（一个 40 字节请求就能让全站下线）', async (t) => {
  const app = await boot(t);
  for (const host of [']', 'a:b:c', 'x:99999999', '::::']) {
    const response = await rawRequest(app.port, ['GET /api/vend/meta HTTP/1.1', `Host: ${host}`, 'Connection: close']);
    assert.match(response, /^HTTP\/1\.1 (200|400)/, `Host: ${host} 得到的响应是 ${response.slice(0, 40)}`);
  }
  // 进程必须还活着
  const alive = await fetch(`http://127.0.0.1:${app.port}/api/vend/meta`);
  assert.equal(alive.status, 200, '畸形 Host 之后服务挂了');
});

test('R3 管理口令连续试错会被锁住，不能全速爆破', async (t) => {
  const app = await boot(t);
  const url = `http://127.0.0.1:${app.port}/api/vend/admin/topups`;
  let locked = 0;
  for (let i = 0; i < 12; i += 1) {
    const response = await fetch(url, { headers: { 'X-Vend-Admin': `guess-${i}` } });
    if (response.status === 429) locked += 1;
  }
  assert.ok(locked > 0, '连试 12 次错误口令一次都没被锁，等于可以无限爆破');

  // 发卡 secret 同理
  const issueUrl = `http://127.0.0.1:${app.port}/api/cards/issue`;
  let issueLocked = 0;
  for (let i = 0; i < 12; i += 1) {
    const response = await fetch(issueUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Card-Secret': `guess-${i}` },
      body: JSON.stringify({ order_id: 'X' }),
    });
    if (response.status === 429) issueLocked += 1;
  }
  assert.ok(issueLocked > 0, '发卡 secret 可以无限爆破');
});

test('H8 缺 order_id 或占位符没被替换，一律拒绝发卡', async (t) => {
  const app = await boot(t);
  const url = `http://127.0.0.1:${app.port}/api/cards/issue`;
  const post = (body) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Card-Secret': SECRET },
    body: JSON.stringify(body),
  });

  // 没有订单号就没有幂等，闲鱼 4 次重试会白发 4 张卡
  assert.equal((await post({ spec_value: '基础卡' })).status, 400);
  assert.equal((await post({ order_id: '', spec_value: '基础卡' })).status, 400);
  // 占位符没被替换（把请求方法配成 GET 的经典事故）会让所有订单塌到同一张卡上
  const placeholder = await post({ order_id: '{order_id}', spec_value: '基础卡' });
  assert.equal(placeholder.status, 400);
  assert.equal((await placeholder.json()).code, 'bad_order_id');
});

test('H9 规格对不上必须拒发，不能默默按默认面额发卡', async (t) => {
  const app = await boot(t);
  const response = await fetch(`http://127.0.0.1:${app.port}/api/cards/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Card-Secret': SECRET },
    body: JSON.stringify({ order_id: 'H9-1', spec_value: '美國卡' }), // 繁体，映射表里没有
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'spec_unmatched');
});

test('M11 补差价是一次性的，不能补一次反复用', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'M11-1' });
  const claim = store.claimTopup({ code: card.code, country: 187, needCny: 4.15 });
  store.confirmTopup(claim.id);

  assert.equal(store.isTopupConfirmed(card.code), true);
  assert.equal(store.consumeTopup(card.code), true, '第一次取号应该把补款划掉');
  assert.equal(store.isTopupConfirmed(card.code), false, '补款用过之后不能再放行');
  assert.equal(store.consumeTopup(card.code), false, '没有可消费的补款了');
});

test('M13 一张卡只留一个会话，反复验卡不会把会话表撑爆', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'M13-1' });
  let lastToken = null;
  for (let i = 0; i < 30; i += 1) lastToken = store.createSession(card.code, `1.2.3.${i}`).token;

  const count = store.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE code = ?').get(card.code).n;
  assert.equal(count, 1, `会话表里留了 ${count} 条`);
  assert.ok(store.resolveSession(lastToken), '最后一次验卡拿到的令牌应该有效');
});

test('M18 崩在取号中途留下的孤儿占位会被清掉，卡不会被自己的硬闸卡死', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'M18-1' });

  // 模拟：占了坑，然后进程崩了，占位行永远停在 reserved
  const reservation = store.reserve({ code: card.code, country: 15, service: 'dr' });
  store.db.prepare('UPDATE activations SET created_at = ? WHERE id = ?')
    .run(Date.now() - 10 * 60 * 1000, reservation.reservationId);

  // 没清理之前这张卡取不了新号
  assert.equal(store.reserve({ code: card.code, country: 15, service: 'dr' }).reason, 'already_active');

  const swept = store.sweep();
  assert.equal(swept.staleReserved, 1);
  assert.equal(store.reserve({ code: card.code, country: 15, service: 'dr' }).ok, true, '清理后应该能重新取号');
});

test('M18 号码过期后本地状态要收掉，否则卡永远显示「有号在进行中」', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'M18-2' });
  const reservation = store.reserve({ code: card.code, country: 15, service: 'dr' });
  store.fulfill(reservation.reservationId, { activationId: 'EXPIRED-1', phone: '48511111111' });
  store.db.prepare('UPDATE activations SET created_at = ? WHERE activation_id = ?')
    .run(Date.now() - 30 * 60 * 1000, 'EXPIRED-1');

  const swept = store.sweep({ activationTtlMs: 20 * 60 * 1000 });
  assert.equal(swept.expiredWaiting, 1);
  assert.equal(store.reserve({ code: card.code, country: 15, service: 'dr' }).ok, true);
});

test('管理接口不把完整卡密发到浏览器（对账只需要后四位）', async (t) => {
  const app = await boot(t);
  // 先造一张卡并申请补差价
  const issued = await fetch(`http://127.0.0.1:${app.port}/api/cards/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Card-Secret': SECRET },
    body: JSON.stringify({ order_id: 'ADM-1', spec_value: '基础卡' }),
  }).then((r) => r.json());
  const code = /ANGE-[A-Z2-9-]+/.exec(issued.data)[0];

  const verified = await fetch(`http://127.0.0.1:${app.port}/api/vend/card/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
  }).then((r) => r.json());
  await fetch(`http://127.0.0.1:${app.port}/api/vend/topup/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: verified.data.token, country: 187 }),
  });

  const admin = await fetch(`http://127.0.0.1:${app.port}/api/vend/admin/topups`, {
    headers: { 'X-Vend-Admin': ADMIN },
  });
  const text = await admin.text();
  assert.equal(admin.status, 200);
  assert.ok(!text.includes(code), '完整卡密被发到了浏览器');
  assert.ok(text.includes(code.slice(-4)), '应该带上后四位供对账');
});

// ---------- 第三份审计（卡密与退款状态机）的回归 ----------

test('R1 平台拒绝退款时不能当成退款成功（失败也是 HTTP 200，错误码在正文里）', async () => {
  const { classifyCancelRaw } = await import('../server/vend-hero.js');

  // 真退了
  assert.deepEqual(classifyCancelRaw('ACCESS_CANCEL'), { refunded: true, settled: true, raw: 'ACCESS_CANCEL' });
  // 号本来就不在了：没得退，也不会再扣，算了结
  assert.equal(classifyCancelRaw('NO_ACTIVATION').settled, true);
  assert.equal(classifyCancelRaw('NOT_FOUND').settled, true);
  // 平台明确拒绝：钱还挂在这个号上，本地绝不能标成已取消
  assert.equal(classifyCancelRaw('EARLY_CANCEL_DENIED').settled, false);
  assert.equal(classifyCancelRaw('BAD_STATUS').settled, false);
  assert.equal(classifyCancelRaw('').settled, false, '空响应不能当成退款成功');
  assert.equal(classifyCancelRaw(undefined).settled, false);
});

test('R2 补款在真的收到码时才划掉，不是取号时', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'R2-1' });
  const claim = store.claimTopup({ code: card.code, country: 187, needCny: 4.15 });
  store.confirmTopup(claim.id);

  // 取号 → 换号：补款必须还在，否则买家补了钱、号收不到码、补款也没了
  const r1 = store.reserve({ code: card.code, country: 187, service: 'dr' });
  store.fulfill(r1.reservationId, { activationId: 'R2-A', phone: '1' });
  assert.equal(store.isTopupConfirmed(card.code), true, '取号不该把补款划掉');

  store.cancel('R2-A', 'cancelled');
  assert.equal(store.isTopupConfirmed(card.code), true, '换号后补款必须还能用');

  // 余额模型下还要能换到**别的国家**去 —— 旧模型这里会失效
  const rOther = store.reserve({ code: card.code, country: 46, service: 'dr' });
  store.fulfill(rOther.reservationId, { activationId: 'R2-C', phone: '3' });
  assert.equal(store.isTopupConfirmed(card.code), true, '换到别的国家补款也要还在');
  store.cancel('R2-C', 'cancelled');

  // 真的收到码，才作废
  const r2 = store.reserve({ code: card.code, country: 187, service: 'dr' });
  store.fulfill(r2.reservationId, { activationId: 'R2-B', phone: '2' });
  store.consume('R2-B', '112233');
  assert.equal(store.isTopupConfirmed(card.code), false, '收码后补款要作废，防止复用');
});

test('R3 码已从平台发出、本地却被并发标成取消时，必须认账补记', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'R3-1' });
  const r = store.reserve({ code: card.code, country: 15, service: 'dr' });
  store.fulfill(r.reservationId, { activationId: 'R3-A', phone: '48511111111' });

  // 模拟竞态：轮询已从平台读到码，但换号先一步把本地标成 cancelled
  store.cancel('R3-A', 'cancelled');
  assert.throws(() => store.consume('R3-A', '778899'), /不能标记收码/);

  const forced = store.forceConsume('R3-A', '778899');
  assert.equal(forced.status, 'used', '码到手了卡就必须消耗，不能还留着能再取号');
  assert.equal(store.getActivationById('R3-A').sms_code, '778899', '码不能丢');
});

test('O2 号自然过期不该吃掉买家的换号额度', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'O2-1' });

  for (let i = 0; i < 3; i += 1) {
    const r = store.reserve({ code: card.code, country: 15, service: 'dr' });
    store.fulfill(r.reservationId, { activationId: `O2-${i}`, phone: '1' });
    store.cancel(`O2-${i}`, 'expired'); // 平台侧自然过期
  }
  assert.equal(store.countChanges(card.code), 0, '过期不是买家换的号，不该计入换号次数');
  // 但花钱的闸门要数下单数，否则去掉过期计数后总支出就没上限了
  assert.equal(store.countOrders(card.code), 3);
});

test('Y1 说好锁 30 分钟就要真锁 30 分钟（回看窗口不能比锁定时长短）', (t) => {
  const store = freshStore(t);
  const ip = '198.51.100.77';
  const now = Date.now();
  // 造 5 次失败，时间都在 12 分钟前——超出 10 分钟统计窗口，但还在 30 分钟锁定期内
  for (let i = 0; i < CARD_CONSTANTS.ATTEMPT_MAX_FAIL; i += 1) {
    store.db.prepare('INSERT INTO attempts (ip, ts, ok) VALUES (?, ?, 0)').run(ip, now - 12 * 60 * 1000 - i * 1000);
  }
  const remaining = store.ipLockRemainingMs(ip);
  assert.ok(remaining > 15 * 60 * 1000, `12 分钟后仍应处于锁定中，实际剩余 ${Math.round(remaining / 60000)} 分钟`);
});

test('Y2 对已驳回的补差价点确认，要能判出来没生效', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'Y2-1' });
  const claim = store.claimTopup({ code: card.code, country: 46, needCny: 0.3 });

  store.rejectTopup(claim.id, '没查到到账');
  const again = store.confirmTopup(claim.id);
  assert.equal(again.changed, false, '已驳回的记录再点确认必须报告没生效');
  assert.equal(store.isTopupConfirmed(card.code, 46), false, '不能因为管理页显示成功就真的放行');
});

test('O4 出价上限取 min(预算, 平台报价)，不能拿面额当出价', async () => {
  const { maxPriceUsdFor } = await import('../server/pricing.js');
  // ¥1.9 的卡买 $0.05 的地区：出价必须是 $0.05，不是 $0.19
  assert.equal(maxPriceUsdFor({ denomCny: 1.9, rate: 10, quotedUsd: 0.05 }), 0.05);
  // 报价高于预算时仍按预算封顶（正常情况下闸门已经拦住了，这里是兜底）
  assert.equal(maxPriceUsdFor({ denomCny: 1.9, rate: 10, quotedUsd: 0.9 }), 0.19);
  // 没给报价时退回原行为
  assert.equal(maxPriceUsdFor({ denomCny: 1.9, rate: 10 }), 0.19);
});

// ---------- 注销卡密 / 退款申请（安哥 2026-08-20 追加需求）----------

test('注销卡密：作废后不能再取号，进待退款队列', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'VOID-1' });
  store.createSession(card.code, '1.1.1.1');

  const result = store.voidCard(card.code, '试了 3 次都没收到码');
  assert.equal(result.ok, true);
  assert.equal(result.card.status, 'void');
  assert.equal(result.card.refund_state, 'requested');
  // 注销后会话要清掉，别让买家拿旧 token 继续操作
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE code=?').get(card.code).n, 0);
  assert.equal(store.reserve({ code: card.code, country: 15, service: 'dr' }).reason, 'void');

  const pending = store.listRefundRequests();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].codeTail, card.code.slice(-4));
  // 管理页只需要后四位，完整卡密不外发
  assert.ok(!JSON.stringify(pending).includes(card.code));
  assert.equal(pending[0].orderId, 'VOID-1', '闲鱼订单号要带上，退款时要用');
});

test('注销卡密：已收过码的卡不能注销，有号在跑的也不行', (t) => {
  const store = freshStore(t);
  const a = store.issueCard({ denomCny: 1.9, orderId: 'VOID-2' }).card;
  const r = store.reserve({ code: a.code, country: 15, service: 'dr' });
  store.fulfill(r.reservationId, { activationId: 'VOID-ACT', phone: '1' });

  // 号还在跑：必须先退掉
  assert.equal(store.voidCard(a.code).reason, 'has_live');

  store.consume('VOID-ACT', '123456');
  // 已经收到码 = 交易完成
  assert.equal(store.voidCard(a.code).reason, 'used');
});

test('注销卡密：卖家处理退款按后四位定位，撞号要报错不能猜', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'VOID-3' });
  store.voidCard(card.code);

  const tail = card.code.slice(-4);
  const done = store.resolveRefund(tail, 'refunded', '闲鱼已退');
  assert.equal(done.ok, true);
  assert.equal(done.state, 'refunded');
  assert.equal(store.listRefundRequests().length, 0);

  // 处理过的不能再处理
  assert.equal(store.resolveRefund(tail, 'refunded').ok, false);
  // 找不到的要报错，不能静默成功
  assert.equal(store.resolveRefund('ZZZZ', 'refunded').reason, 'not_found');
});

test('逐档出价：从最便宜的档位开始，绝不越过预算', async () => {
  const { vendGetNumberTiered } = await import('../server/vend-hero.js');
  // 用一个只在指定价位有货的假平台验证「逐档加价」的行为
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const price = Number(new URL(url).searchParams.get('maxPrice'));
    calls.push(price);
    // 只有 0.11 这一档有货，更低的两档都没号
    const body = price >= 0.11 ? 'ACCESS_NUMBER:9001:48512345678' : 'NO_NUMBERS';
    return new Response(body, { status: 200 });
  };
  try {
    const result = await vendGetNumberTiered({
      service: 'dr', country: 15,
      tiers: [0.05, 0.08, 0.11, 0.25], // 0.25 超预算，不该被试
      budgetUsd: 0.19,
    });
    assert.equal(result.ok, true);
    assert.equal(result.paidUsd, 0.11, '应该停在第一个买得到的档位');
    assert.deepEqual(calls, [0.05, 0.08, 0.11], '要从低到高逐档试');
    assert.ok(!calls.some((p) => p > 0.19), '绝不能出价超过预算');
  } finally {
    globalThis.fetch = original;
  }
});

// ---------- 临时邮箱：归属边界是硬安全边界 ----------

test('临时邮箱只能读自己创建的地址', (t) => {
  const store = freshStore(t);
  store.createMailbox({ address: 'Alice@tempmail2026.xyz', owner: 'owner-A', ip: '1.1.1.1' });
  store.createMailbox({ address: 'bob@tempmail2026.xyz', owner: 'owner-B', ip: '2.2.2.2' });

  assert.equal(store.ownsMailbox('owner-A', 'alice@tempmail2026.xyz'), true, '大小写不该影响归属');
  // 这条是安全边界：后台接口能读任意地址，少了它就是人人可读别人的验证码邮件
  assert.equal(store.ownsMailbox('owner-A', 'bob@tempmail2026.xyz'), false, 'A 竟然能读 B 的邮箱');
  assert.equal(store.ownsMailbox('', 'bob@tempmail2026.xyz'), false, '空 owner 不能当通配');
  assert.equal(store.ownsMailbox('owner-A', ''), false);

  assert.equal(store.listMailboxes('owner-A').length, 1);
  assert.equal(store.listMailboxes('owner-B').length, 1);
});

test('临时邮箱过期即失效并被清理', (t) => {
  const store = freshStore(t);
  store.createMailbox({ address: 'old@tempmail2026.xyz', owner: 'o1', ttlMs: 1000 });
  store.db.prepare('UPDATE mailboxes SET expires_at = ? WHERE address = ?').run(Date.now() - 1000, 'old@tempmail2026.xyz');

  assert.equal(store.ownsMailbox('o1', 'old@tempmail2026.xyz'), false, '过期后不能再读');
  assert.equal(store.listMailboxes('o1').length, 0);
  store.sweep();
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM mailboxes').get().n, 0);
});

test('临时邮箱按 IP 计数，免费服务必须限速', (t) => {
  const store = freshStore(t);
  for (let i = 0; i < 4; i += 1) {
    store.createMailbox({ address: `m${i}@tempmail2026.xyz`, owner: `o${i}`, ip: '3.3.3.3' });
  }
  assert.equal(store.countMailboxesByIp('3.3.3.3', 60 * 60 * 1000), 4);
  assert.equal(store.countMailboxesByIp('4.4.4.4', 60 * 60 * 1000), 0, '别的 IP 不受牵连');
});
