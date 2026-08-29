import test from 'node:test';
import assert from 'node:assert/strict';
import { expiryVerdict, sweepDecision, ASSIGN_TTL_MS } from '../server/inviteSweep.js';

// 领了号却不点「我已发出邀请」的，要能自己回到池子里。
// 但**光看时间就收回是危险的**：买家可能已经把邀请发出去了、只是还没回来点按钮，
// 这时收回 = 号派给下一个人，而第一个买家的名额已经花在这个地址上了，两边都赔。

const at = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const row = (over) => ({ status: 'assigned', assigned_at: at(30 * 60 * 1000), ...over });

const card = (msLeft) => ({ expires_at: Date.now() + msLeft });

test('只有 assigned 才在扫描范围内', () => {
  for (const st of ['available', 'ready', 'running', 'done', 'failed', 'dead']) {
    assert.equal(expiryVerdict({ row: row({ status: st }), card: card(-1000) }), 'unknown', `${st} 被扫到了`);
  }
  assert.equal(expiryVerdict({ row: row(), card: card(-1000) }), 'expired');
});

// 判据绑的是**卡的有效期**，不是另起一个计时器。
// 两套计时器并存必然出现"卡还有效但号被收走了"，那是我们自己造的纠纷。
test('卡还没过期就不动，哪怕号领了很久', () => {
  assert.equal(expiryVerdict({ row: row({ assigned_at: at(5 * 60 * 60 * 1000) }), card: card(10 * 60 * 1000) }), 'alive');
});

test('卡一过期就该处置', () => {
  assert.equal(expiryVerdict({ row: row({ assigned_at: at(60 * 1000) }), card: card(-1) }), 'expired');
});

// 🔴 查不到卡 ≠ 卡失效了。老卡（expires_at 为 NULL）也走这条兜底。
test('查不到卡时退回按领号时间兜底，不凭空判过期', () => {
  assert.equal(expiryVerdict({ row: row({ assigned_at: at(60 * 1000) }), card: null }), 'alive');
  assert.equal(expiryVerdict({ row: row({ assigned_at: at(ASSIGN_TTL_MS + 60 * 1000) }), card: null }), 'expired');
  assert.equal(expiryVerdict({ row: row({ assigned_at: at(60 * 1000) }), card: { expires_at: null } }), 'alive');
});

// 时间戳也读不出来时**什么都不做**：反过来处理的话，格式一变就会把刚领的号全收回，
// 而买家正拿着那个地址在发邀请。
test('两个时间都读不出来就什么都不做', () => {
  for (const v of [null, undefined, '', 'not-a-date']) {
    assert.equal(expiryVerdict({ row: row({ assigned_at: v }), card: null }), 'unknown', `${v} 被判成过期了`);
  }
  assert.equal(expiryVerdict({ row: null, card: null }), 'unknown');
});

// 🔴 这三条是这套机制的全部安全性所在
test('信箱里有邀请信 → 替买家确认，不是收回', () => {
  assert.equal(sweepDecision(true), 'confirm');
});

test('信箱空 → 收回池子', () => {
  assert.equal(sweepDecision(false), 'release');
});

test('信箱读不出来 → 什么都不做（读不到 ≠ 没发）', () => {
  for (const v of [null, undefined]) {
    assert.equal(sweepDecision(v), 'keep', `${v} 被当成"没发"了`);
  }
});

test('兜底超时要和卡的有效期一致（1 小时），别让老卡比新卡还短命', () => {
  assert.equal(ASSIGN_TTL_MS, 60 * 60 * 1000);
});
