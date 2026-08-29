// vend-feedback.test.js — 意见反馈的限速闸
//
// 这是全站**唯一一个不需要卡密就能触发对外发信**的接口。
// 没有闸门它就是个垃圾邮件炮：把安哥 QQ 邮箱的发信配额刷爆，
// 顺带把真实反馈淹在几千条垃圾里 —— 那等于这个功能白做。
//
// 两道闸必须分别验，而且要跑双向用例（该拦的拦住、不该拦的放行）：
//   1. 按 IP：一小时 3 条
//   2. 全局总量：一小时 40 条。这道**不能**跟着 IP 那道一起退化 ——
//      拿不到真实 IP 时（反代没配好或被摘掉）第 1 道整个失效，
//      那时候第 2 道是唯一还站着的。

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';

import { CardStore } from '../server/cards.js';

function freshStore(t) {
  const dir = join(tmpdir(), `vend-fb-${randomUUID()}`);
  const store = new CardStore(join(dir, 'vend.sqlite'));
  t.after(() => {
    try { store.close(); } catch { /* 已关 */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });
  return store;
}

test('意见先落库，发信是后一步', (t) => {
  const store = freshStore(t);
  const id = store.addFeedback({ ip: '1.2.3.4', contact: 'wx: abc', body: '某平台收不到码', cardTail: 'UQQG' });
  const row = store.db.prepare('SELECT * FROM feedback WHERE id = ?').get(id);
  assert.equal(row.body, '某平台收不到码');
  assert.equal(row.card_tail, 'UQQG');
  // 落库那一刻还没发信 —— 买家看到「已提交」不代表信已经出去了，
  // 但内容一定已经存下来了，SMTP 挂了也捞得回来
  assert.equal(row.mailed_at, null);

  store.markFeedbackMailed(id);
  assert.ok(store.db.prepare('SELECT mailed_at FROM feedback WHERE id = ?').get(id).mailed_at > 0);
});

test('发信失败要把原因记在同一行，别让它无声消失', (t) => {
  const store = freshStore(t);
  const id = store.addFeedback({ ip: '1.2.3.4', body: '一条意见' });
  store.markFeedbackMailed(id, '535 Login Fail. 授权码错误');
  const row = store.db.prepare('SELECT * FROM feedback WHERE id = ?').get(id);
  assert.match(row.mail_error, /授权码/);
});

test('按 IP 计数只算这个 IP，不能把别人的算进来', (t) => {
  const store = freshStore(t);
  for (let i = 0; i < 3; i += 1) store.addFeedback({ ip: '1.1.1.1', body: `第 ${i} 条意见` });
  store.addFeedback({ ip: '2.2.2.2', body: '别人的意见' });

  assert.equal(store.countFeedbackByIp('1.1.1.1', 60 * 60 * 1000), 3);
  // 不该拦的要放行：换个 IP 的正常买家不能被前一个人的量牵连
  assert.equal(store.countFeedbackByIp('2.2.2.2', 60 * 60 * 1000), 1);
  assert.equal(store.countFeedbackByIp('3.3.3.3', 60 * 60 * 1000), 0);
});

test('全局总闸跟 IP 无关 —— IP 那道退化时它得还站着', (t) => {
  const store = freshStore(t);
  // 模拟反代没配好：每条都记不到真实 IP
  for (let i = 0; i < 40; i += 1) store.addFeedback({ ip: null, body: `机器刷的第 ${i} 条` });

  assert.equal(store.countFeedbackByIp('unreliable-ip', 60 * 60 * 1000), 0, '按 IP 那道此时确实数不出来');
  assert.equal(store.countFeedbackSince(60 * 60 * 1000), 40, '总闸照样数得出来');
});

test('时间窗要真的滑动，一小时前的不能算进来', (t) => {
  const store = freshStore(t);
  const id = store.addFeedback({ ip: '1.1.1.1', body: '两小时前那条' });
  store.db.prepare('UPDATE feedback SET created_at = ? WHERE id = ?')
    .run(Date.now() - 2 * 60 * 60 * 1000, id);

  // 不该拦的要放行：昨天提过意见的人今天还能提
  assert.equal(store.countFeedbackByIp('1.1.1.1', 60 * 60 * 1000), 0);
  assert.equal(store.countFeedbackSince(60 * 60 * 1000), 0);
});
