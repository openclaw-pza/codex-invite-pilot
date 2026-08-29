// vend-issue-multicode.test.js — 闲鱼回调发多次卡
//
// 三次卡是通过闲鱼卡券的 params.max_codes 传进来的。三条必须守住：
//   1. 不传 = 1 次（老商品的配置一个字不改，行为完全不变）
//   2. 传了要真的生效 —— 之前这个接口压根不接这个参数，
//      配了也发成一次性卡，而且**静默**：日志、返回、买家收到的文案全看不出来
//   3. 有上限。占位符没替换、后台手滑多打个 0，发出去就是能白嫖 200 次的卡

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';

// 发货文案里的站点地址走 SITE_URL（server/vend-routes.js 的 deliveryText 同一套规则）。
// 断言必须按同样的规则算期望值，不能写死域名 —— 写死的话任何人 fork 之后
// 改了自己的 SITE_URL，测试就无缘无故变红。
const SITE = process.env.SITE_URL || 'https://example.com';

import { CardStore } from '../server/cards.js';

process.env.VEND_ISSUE_SECRET = process.env.VEND_ISSUE_SECRET || 'test-issue-secret';
const SECRET = process.env.VEND_ISSUE_SECRET;
const { startVendServer } = await import('../server/vend-server.js');

async function boot(t) {
  const dir = join(tmpdir(), `vend-iss-${randomUUID()}`);
  const dbPath = join(dir, 'vend.sqlite');
  const app = await startVendServer({ dbPath, port: 0, host: '127.0.0.1', skipVendorSync: true });
  const store = new CardStore(dbPath);
  t.after(async () => {
    try { store.close(); } catch { /* 已关 */ }
    await app.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });
  return { store, port: app.port ?? app.address?.().port };
}

async function issue(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/cards/issue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-card-secret': SECRET },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

const codeOf = (text) => /卡密：(\S+)/.exec(String(text))?.[1];

test('不传 max_codes → 一次性卡（老商品行为不能变）', async (t) => {
  const { store, port } = await boot(t);
  const r = await issue(port, { order_id: 'O-1', denom: '1.9' });
  assert.equal(r.status, 200);
  const card = store.getCard(codeOf(r.json.data));
  assert.equal(card.max_codes, 1);
});

test('传 max_codes=3 → 真的发三次卡', async (t) => {
  const { store, port } = await boot(t);
  const r = await issue(port, { order_id: 'O-2', denom: '3.99', max_codes: '3' });
  const card = store.getCard(codeOf(r.json.data));
  assert.equal(card.max_codes, 3, '之前这个参数被无视，静默发成一次性卡');
  assert.equal(Number(card.denom_cny), 3.99);
});

test('次数有上限，挡住占位符没替换和多打一个 0', async (t) => {
  const { store, port } = await boot(t);
  const big = await issue(port, { order_id: 'O-3', denom: '3.99', max_codes: 300 });
  assert.equal(store.getCard(codeOf(big.json.data)).max_codes, 20, '封顶 20');

  const junk = await issue(port, { order_id: 'O-4', denom: '3.99', max_codes: '{max_codes}' });
  assert.equal(junk.status, 400, '占位符没被替换要当场拒发，不能默认成 1 悄悄发出去');
});

test('发货文案按次数分叉，且不出现平台敏感词', async (t) => {
  const { port } = await boot(t);
  const one = (await issue(port, { order_id: 'O-5', denom: '1.9' })).json.data;
  const three = (await issue(port, { order_id: 'O-6', denom: '3.99', max_codes: 3 })).json.data;

  assert.match(one, /可以用 1 次/);
  assert.match(three, /可以用 3 次/);
  // 「先确认邀请页写没写送额度」必须在：不写的话买家做完全套拿不到额度，
  // 回头就是描述不符，而这件事我们的系统看不见、帮不上。
  assert.match(three, /写明送多少/);
  // 2026-08-27 起「登录发一条消息」由我们自动完成，不再要求买家做 ——
  // 文案改成指向「Codex 一键邀请」那一页。
  assert.match(three, /一键邀请/);

  // 安哥 2026-08-22 要求：发货词中性，别出现这类词
  for (const word of ['接码', '验证码', '手机号', '虚拟号', '取号', '短信']) {
    assert.equal(one.includes(word), false, `一次卡文案不该出现「${word}」`);
    assert.equal(three.includes(word), false, `三次卡文案不该出现「${word}」`);
  }
  // 地址必须在，不然买家不知道去哪用 —— 两种文案都要有，不能只保一种。
  assert.ok(one.includes(SITE), `一次卡文案缺站点地址 ${SITE}`);
  assert.ok(three.includes(SITE), `三次卡文案缺站点地址 ${SITE}`);
});

test('每一种发货文案都必须同时带上「网址」和「怎么用」', async (t) => {
  const { port } = await boot(t);
  const cases = [
    ['单次接码卡', { order_id: 'U-1', denom: '1.9' }],
    ['多次接码卡', { order_id: 'U-2', denom: '5', max_codes: 3, kind: 'sms' }],
    ['Codex 单次卡', { order_id: 'U-3', denom: '3.99', kind: 'codex' }],
    ['Codex 三次卡', { order_id: 'U-4', denom: '3.99', max_codes: 3, kind: 'codex' }],
  ];
  for (const [name, body] of cases) {
    const text = (await issue(port, body)).json.data;
    // 光给一串卡密等于没发货：买家不知道去哪用、也不知道第一步干什么。
    // 安哥 2026-08-23 反馈「网址起码要带上」——这条对四种文案都成立，
    // 以后新增文案分支时这个用例会替我们守住。
    assert.ok(text.includes(SITE), `${name} 缺网址 ${SITE}`);
    assert.match(text, /卡密：ANGE-/, `${name} 缺卡密`);
    assert.match(text, /怎么用|跟着分步指引走/, `${name} 没说怎么用`);
  }
});

// ---------- 商品类型与次数解耦（三次卡方案取消后）----------
//
// 三次卡取消、Codex 改发单次卡之后，「按次数推断是不是 Codex 单」这条就失效了。
// 那条推断本来就是巧合（当时 Codex 卡恰好是三次卡），不是规律。
// 丢掉这两条前提的后果是买家做完全套却拿不到额度，回头就是描述不符退款。

test('kind=codex + 单次卡：Codex 那两条前提必须还在', async (t) => {
  const { store, port } = await boot(t);
  const r = await issue(port, { order_id: 'K-1', denom: '3.99', kind: 'codex' });
  assert.equal(r.status, 200);
  const text = r.json.data;

  assert.equal(store.getCard(codeOf(text)).max_codes, 1, '就是一张单次卡');
  assert.match(text, /可以用 1 次/);
  assert.match(text, /Codex 一键邀请/, '要指向一键邀请那一页，不是通用流程');
  assert.match(text, /写明送多少/, '先确认邀请页写明送多少 —— 唯一还要买家自己判断的事');
  // 反过来钉一条：不能再要求买家自己去发消息，那一步现在是我们做的
  assert.equal(/要用它登录发一条消息|登录发一条消息才/.test(text), false, '别再让买家自己发消息');
});

test('kind=sms 的多次卡不会误挂 Codex 文案', async (t) => {
  const { port } = await boot(t);
  const text = (await issue(port, { order_id: 'K-2', denom: '5', max_codes: 3, kind: 'sms' })).json.data;
  assert.match(text, /可以用 3 次/);
  assert.equal(/写明送多少/.test(text), false, '显式说了是 sms 就不该出现 Codex 前提');
});

test('不传 kind 时保留旧推断，老卡券的 api_config 一个字都不用改', async (t) => {
  const { port } = await boot(t);
  const three = (await issue(port, { order_id: 'K-3', denom: '3.99', max_codes: 3 })).json.data;
  const one = (await issue(port, { order_id: 'K-4', denom: '1.9' })).json.data;
  assert.match(three, /写明送多少/, '老的三次卡行为不能变');
  assert.equal(/写明送多少/.test(one), false);
});

test('kind 拼错时回落到按次数推断，不发空文案', async (t) => {
  const { port } = await boot(t);
  for (const bad of ['{kind}', 'CODEXX', '', 'null']) {
    const text = (await issue(port, { order_id: `K-bad-${bad || 'empty'}`, denom: '1.9', kind: bad })).json.data;
    assert.match(text, /卡密：/, `kind=${JSON.stringify(bad)} 不该把文案搞没`);
    assert.ok(text.includes(SITE), `kind=${JSON.stringify(bad)} 缺网址`);
  }
});

test('kind=codex 的文案同样不带平台敏感词', async (t) => {
  const { port } = await boot(t);
  const text = (await issue(port, { order_id: 'K-5', denom: '3.99', kind: 'codex' })).json.data;
  for (const word of ['接码', '验证码', '手机号', '虚拟号', '取号', '短信']) {
    assert.equal(text.includes(word), false, `不该出现「${word}」`);
  }
});
