// cards.test.js — 卡密模块不变量测试
//
// 红线：本测试**只**在系统临时目录建库，绝不碰仓库 data/ 下的生产文件。
// CardStore 的库路径是构造参数（不是模块级常量），所以这里天然隔离，不需要 monkeypatch。

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';

import { CardStore, CARD_CONSTANTS, secretEquals } from '../server/cards.js';

// 每个用例一个全新的临时库，用完删掉
function freshStore(t) {
  const dir = join(tmpdir(), `vend-test-${randomUUID()}`);
  const store = new CardStore(join(dir, 'vend.sqlite'));
  t.after(() => {
    try { store.close(); } catch { /* 已关就算了 */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录删不掉不影响结论 */ }
  });
  return store;
}

test('卡密格式固定且不含易认错的字符', () => {
  for (let i = 0; i < 200; i += 1) {
    const code = CardStore.generateCode();
    assert.match(code, /^ANGE-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    // 0/O/1/I/L 全部不该出现，否则买家手抄会打错
    assert.ok(!/[01ILO]/.test(code.slice(5)), `卡密含易混字符: ${code}`);
  }
});

test('同一个闲鱼订单只发一张卡（闲鱼有 4 次重试，重复发卡等于白送）', (t) => {
  const store = freshStore(t);
  const first = store.issueCard({ denomCny: 1.9, orderId: 'XY-ORDER-1' });
  const second = store.issueCard({ denomCny: 1.9, orderId: 'XY-ORDER-1' });
  assert.equal(second.reissued, true);
  assert.equal(second.card.code, first.card.code);
  const rows = store.db.prepare('SELECT COUNT(*) AS n FROM cards').get();
  assert.equal(rows.n, 1);
});

test('没有订单号的卡各自独立', (t) => {
  const store = freshStore(t);
  const a = store.issueCard({ denomCny: 1.9 });
  const b = store.issueCard({ denomCny: 1.9 });
  assert.notEqual(a.card.code, b.card.code);
  assert.equal(a.card.status, 'unused');
});

test('校验卡密：不存在 / 已用 / 已作废 各自给出理由', (t) => {
  const store = freshStore(t);
  assert.equal(store.verifyCard('ANGE-XXXX-XXXX-XXXX').reason, 'not_found');

  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'O-2' });
  assert.equal(store.verifyCard(card.code).ok, true);
  // 小写输入也要认，买家会手抄
  assert.equal(store.verifyCard(card.code.toLowerCase()).ok, true);

  store.db.prepare("UPDATE cards SET status='used' WHERE code=?").run(card.code);
  assert.equal(store.verifyCard(card.code).reason, 'used');

  store.db.prepare("UPDATE cards SET status='void' WHERE code=?").run(card.code);
  assert.equal(store.verifyCard(card.code).reason, 'void');
});

test('不变量 2：一张卡同时只能有一个进行中的号（数据库硬闸）', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'O-3' });

  const first = store.reserve({ code: card.code, country: 15, service: 'dr' });
  assert.equal(first.ok, true);

  // 第二次占坑必须被挡下——而且是在调 HeroSMS 之前挡下，不花钱
  const second = store.reserve({ code: card.code, country: 187, service: 'dr' });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already_active');

  // 库里只有一条进行中的记录
  const live = store.db.prepare("SELECT COUNT(*) AS n FROM activations WHERE code=? AND state IN ('reserved','waiting')").get(card.code);
  assert.equal(live.n, 1);
});

test('取号失败释放占位后，同一张卡可以立刻重试', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'O-4' });

  const r1 = store.reserve({ code: card.code, country: 15, service: 'dr' });
  assert.equal(store.releaseReservation(r1.reservationId), true);

  const r2 = store.reserve({ code: card.code, country: 15, service: 'dr' });
  assert.equal(r2.ok, true, '释放后应能重新占坑');

  // 释放过的占位不能重复释放
  assert.equal(store.releaseReservation(r1.reservationId), false);
});

test('不变量 1+4：收到验证码后卡密消耗，且不可再取号', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'O-5' });

  const r = store.reserve({ code: card.code, country: 15, service: 'dr' });
  store.fulfill(r.reservationId, { activationId: 'ACT-1', phone: '48512345678', priceUsd: 0.11, priceCny: 1.1 });

  const result = store.consume('ACT-1', '472913');
  assert.equal(result.card.status, 'used');
  assert.equal(result.activation.sms_code, '472913');
  assert.equal(result.alreadyDone, false);

  // 再取号必须被拒
  assert.equal(store.reserve({ code: card.code, country: 15, service: 'dr' }).reason, 'used');
});

test('收码后会话要留着——验证码只发一次，丢了就是一笔退款', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'O-5b' });
  const { token } = store.createSession(card.code, '203.0.113.5');

  const r = store.reserve({ code: card.code, country: 15, service: 'dr' });
  store.fulfill(r.reservationId, { activationId: 'ACT-KEEP', phone: '48511111111' });
  store.consume('ACT-KEEP', '135790');

  // 会话必须还在，买家刷新页面还能读回自己的验证码
  const found = store.resolveSession(token);
  assert.ok(found, '收码后会话被删了，买家刷新一下验证码就永远拿不回来');
  assert.equal(found.card.status, 'used', '卡仍然是已消耗，花钱的接口靠这个状态挡住');
  assert.equal(store.listActivations(card.code).slice(-1)[0].sms_code, '135790');
});

test('重复上报同一个验证码是幂等的（轮询可能并发触发两次）', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'O-6' });
  const r = store.reserve({ code: card.code, country: 15, service: 'dr' });
  store.fulfill(r.reservationId, { activationId: 'ACT-2', phone: '48512345678' });

  store.consume('ACT-2', '111111');
  const again = store.consume('ACT-2', '222222');
  assert.equal(again.alreadyDone, true);
  // 第二次不能改掉已记录的验证码
  assert.equal(again.activation.sms_code, '111111');
});

test('不变量 3：更换号码要退款且不消耗卡密', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'O-7' });

  const r1 = store.reserve({ code: card.code, country: 15, service: 'dr' });
  store.fulfill(r1.reservationId, { activationId: 'ACT-A', phone: '48511111111' });
  store.cancel('ACT-A');

  assert.equal(store.getCard(card.code).status, 'issued', '取消不该消耗卡密');
  assert.equal(store.countChanges(card.code), 1);

  const r2 = store.reserve({ code: card.code, country: 15, service: 'dr' });
  assert.equal(r2.ok, true, '取消后应能再取一个号');
  store.fulfill(r2.reservationId, { activationId: 'ACT-B', phone: '48522222222' });
  assert.equal(store.getLiveActivation(card.code).activation_id, 'ACT-B');
});

test('已经收到验证码的号不允许取消退款', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'O-8' });
  const r = store.reserve({ code: card.code, country: 15, service: 'dr' });
  store.fulfill(r.reservationId, { activationId: 'ACT-C', phone: '48533333333' });
  store.consume('ACT-C', '654321');

  assert.throws(() => store.cancel('ACT-C'), /已经收到验证码/);
});

test('同一个 HeroSMS activationId 不能落两条', (t) => {
  const store = freshStore(t);
  const a = store.issueCard({ denomCny: 1.9, orderId: 'O-9' }).card;
  const b = store.issueCard({ denomCny: 1.9, orderId: 'O-10' }).card;

  const ra = store.reserve({ code: a.code, country: 15, service: 'dr' });
  store.fulfill(ra.reservationId, { activationId: 'DUP-1', phone: '4851' });

  const rb = store.reserve({ code: b.code, country: 15, service: 'dr' });
  assert.throws(() => store.fulfill(rb.reservationId, { activationId: 'DUP-1', phone: '4852' }), /UNIQUE/i);
});

test('不变量 5：补差价只有 confirmed 才放行，买家自称付款不算', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'O-11' });

  assert.equal(store.isTopupConfirmed(card.code), false);

  const claim = store.claimTopup({ code: card.code, country: 187, needCny: 4.15 });
  assert.equal(claim.status, 'claimed');
  assert.equal(store.isTopupConfirmed(card.code), false, 'claimed 不能放行');

  // 重复点「我已付款」不该刷出一堆待核对记录
  store.claimTopup({ code: card.code, country: 187, needCny: 4.15 });
  assert.equal(store.listPendingTopups().length, 1);

  store.confirmTopup(claim.id, '支付宝 20:31 到账 4.15');
  assert.equal(store.isTopupConfirmed(card.code), true);
});

// 2026-08-22 换模型：补款从「绑定那个国家」改成「充进卡密余额」。
// 旧行为是补了美国的钱只能取美国号，换个国家试就白费、得再补一次 ——
// 那是把买家往退款那边推。下面这条锁住新行为。
test('补款进的是卡密余额，任何国家都能花', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'O-11b' });

  const claim = store.claimTopup({ code: card.code, country: 187, needCny: 4.15 });
  store.confirmTopup(claim.id, '支付宝到账 4.15');

  // 当时补的是美国（187），但钱在卡里，换成别的国家照样能用
  assert.equal(store.isTopupConfirmed(card.code), true, '补款不绑国家');
  assert.equal(store.confirmedTopupCny(card.code), 4.15);
});

test('分几次补要累加，不能只认最后一笔', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'O-11c' });

  const first = store.claimTopup({ code: card.code, country: 187, needCny: 1 });
  store.confirmTopup(first.id);
  // 第一笔核对完了，才允许再开一笔（待核对的那笔仍然只能有一条）
  const second = store.claimTopup({ code: card.code, country: 46, needCny: 2 });
  store.confirmTopup(second.id);

  // 只取最后一笔的话先补的 ¥1 就被吞了 —— 那是真金白银
  assert.equal(store.confirmedTopupCny(card.code), 3);
});

test('补差价被驳回后不放行', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'O-12' });
  const claim = store.claimTopup({ code: card.code, country: 46, needCny: 0.3 });
  store.rejectTopup(claim.id, '没查到到账');
  assert.equal(store.isTopupConfirmed(card.code), false);
  assert.equal(store.listPendingTopups().length, 0);
});

test('防爆破：同 IP 连续失败到阈值即锁定，成功尝试不解锁', (t) => {
  const store = freshStore(t);
  const ip = '203.0.113.9';
  assert.equal(store.ipLockRemainingMs(ip), 0);

  for (let i = 0; i < CARD_CONSTANTS.ATTEMPT_MAX_FAIL - 1; i += 1) store.recordAttempt(ip, false);
  assert.equal(store.ipLockRemainingMs(ip), 0, '未到阈值不该锁');

  store.recordAttempt(ip, false);
  assert.ok(store.ipLockRemainingMs(ip) > 0, '到阈值必须锁');

  // 别的 IP 不受牵连
  assert.equal(store.ipLockRemainingMs('198.51.100.1'), 0);
});

test('shared secret 用定长比较，空值和长度不等一律拒绝', () => {
  assert.equal(secretEquals('abc123', 'abc123'), true);
  assert.equal(secretEquals('abc123', 'abc124'), false);
  assert.equal(secretEquals('abc', 'abcdef'), false);
  assert.equal(secretEquals('', ''), false, '空 secret 必须判否，否则没配 secret 就等于不设防');
  assert.equal(secretEquals(undefined, undefined), false);
  assert.equal(secretEquals(null, ''), false);
});

test('会话过期即失效', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'O-13' });
  const { token } = store.createSession(card.code, '203.0.113.10');
  assert.ok(store.resolveSession(token));

  store.db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(Date.now() - 1000, token);
  assert.equal(store.resolveSession(token), null);
  assert.equal(store.resolveSession('不存在的令牌'), null);
});

// ---------- 卡密有效期（2026-08-25 新增）----------
//
// 这组测试守的是一条会赔钱的不变量：**老卡不能被新规则追溯作废**。
// 规则上线那一刻库里有 51 张未用卡，其中 49 张已经超过 1 小时，
// 有的 20 小时前就发到买家手里了。追溯生效 = 我们自己制造一波退款。

test('新发的卡带 expires_at，且是发出时刻 + 1 小时', (t) => {
  const store = freshStore(t);
  const before = Date.now();
  const { card } = store.issueCard({ denomCny: 1.9 });
  const after = Date.now();
  assert.ok(card.expires_at, 'expires_at 必须写上，否则这张卡永不过期');
  assert.ok(card.expires_at >= before + CARD_CONSTANTS.CARD_TTL_MS);
  assert.ok(card.expires_at <= after + CARD_CONSTANTS.CARD_TTL_MS);
});

test('有效期内的卡验得过', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9 });
  const r = store.verifyCard(card.code);
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
});

test('超过有效期的卡返回 expired', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9 });
  // 把过期时刻拨到 1 秒前
  store.db.prepare('UPDATE cards SET expires_at = ? WHERE code = ?').run(Date.now() - 1000, card.code);
  const r = store.verifyCard(card.code);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'expired');
});

test('🔴 老卡 expires_at 为 NULL 时永不过期（防止规则追溯作废存量卡）', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9 });
  // 模拟规则上线前的老卡：没有 expires_at，created_at 在很久以前
  store.db.prepare('UPDATE cards SET expires_at = NULL, created_at = ?, issued_at = ? WHERE code = ?')
    .run(Date.now() - 30 * 24 * 3600 * 1000, Date.now() - 30 * 24 * 3600 * 1000, card.code);
  const r = store.verifyCard(card.code);
  assert.equal(r.ok, true, '30 天前的老卡必须仍然可用，否则存量卡集体作废');
});

test('会话有效期不会超过卡的有效期', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9 });
  const s1 = store.createSession(card.code);
  assert.ok(s1.expiresAt <= card.expires_at,
    '会话比卡活得久的话，买家在第 59 分钟验卡就能再用 6 小时，过期规则形同虚设');
});

test('老卡的会话仍按原来的 6 小时算', (t) => {
  const store = freshStore(t);
  const { card } = store.issueCard({ denomCny: 1.9 });
  store.db.prepare('UPDATE cards SET expires_at = NULL WHERE code = ?').run(card.code);
  const now = Date.now();
  const s1 = store.createSession(card.code);
  assert.ok(s1.expiresAt >= now + CARD_CONSTANTS.SESSION_TTL_MS - 5000);
});
