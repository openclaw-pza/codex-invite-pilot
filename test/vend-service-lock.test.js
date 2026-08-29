// vend-service-lock.test.js — 卡密锁定服务的回归测试
//
// 背景：闲鱼卡券参数里能填 service，卖家会以为填了就锁住这张卡。
// 以前那个字段被完全忽略，是必然的误解。现在填了就真锁，不填仍是买家自选。
//
// 最要紧的用例是「不填 = 不锁」：多服务自选是常态，别为了加锁把默认行为改坏了。

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';

import { CardStore } from '../server/cards.js';

const SECRET = 'lock-test-secret-ascii';
const ADMIN = 'lock-test-admin-ascii';
process.env.VEND_ISSUE_SECRET = SECRET;
process.env.VEND_ADMIN_TOKEN = ADMIN;

const { startVendServer } = await import('../server/vend-server.js');

async function freshServer(t) {
  const dir = join(tmpdir(), `vend-lock-${randomUUID()}`);
  const server = await startVendServer({ dbPath: join(dir, 'vend.sqlite'), port: 0, skipVendorSync: true });
  const port = server.port ?? server.address?.().port;
  t.after(async () => {
    try { await server.close?.(); } catch { /* 已关 */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });
  return `http://127.0.0.1:${port}`;
}

async function issue(base, body) {
  const r = await fetch(`${base}/api/cards/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Card-Secret': SECRET },
    body: JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
}

async function verify(base, code) {
  const r = await fetch(`${base}/api/vend/card/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, data: body?.data ?? null };
}

function codeFrom(text) {
  return (text.match(/ANGE-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/) || [])[0];
}

test('闲鱼卡券不填 service → 卡密不锁定，买家可自选（这是常态，不能改坏）', async (t) => {
  const base = await freshServer(t);
  const issued = await issue(base, { order_id: `no-lock-${randomUUID()}`, denom: '1.9' });
  assert.equal(issued.status, 200);
  const code = codeFrom(issued.text);
  assert.ok(code, '应发出卡密');

  const info = await verify(base, code);
  assert.equal(info.status, 200);
  assert.equal(info.data.lockedService, null, '没填 service 就不该有锁');
});

test('闲鱼卡券填了 service → 卡密锁定该服务', async (t) => {
  const base = await freshServer(t);
  const issued = await issue(base, { order_id: `lock-${randomUUID()}`, denom: '1.9', service: 'go' });
  assert.equal(issued.status, 200);
  const code = codeFrom(issued.text);

  const info = await verify(base, code);
  assert.equal(info.data.lockedService, 'go', '填了就该锁住');
});

test('service 参数是垃圾值（占位符没被替换）→ 当场拒发，不静默忽略', async (t) => {
  const base = await freshServer(t);
  for (const bad of ['{service}', 'OpenAI ChatGPT', 'a', 'toolongservicecode']) {
    const r = await issue(base, { order_id: `bad-${randomUUID()}`, denom: '1.9', service: bad });
    assert.equal(r.status, 400, `「${bad}」应被拒绝而不是发一张锁错服务的卡`);
  }
});

test('service 大小写不影响锁定值', async (t) => {
  const base = await freshServer(t);
  const issued = await issue(base, { order_id: `case-${randomUUID()}`, denom: '1.9', service: 'DR' });
  const info = await verify(base, codeFrom(issued.text));
  assert.equal(info.data.lockedService, 'dr');
});

test('锁定卡查别的服务的地区 → 拒绝，不能让买家看错价', async (t) => {
  const base = await freshServer(t);
  const issued = await issue(base, { order_id: `region-${randomUUID()}`, denom: '1.9', service: 'go' });
  const info = await verify(base, codeFrom(issued.text));
  const token = info.data.token;

  const r = await fetch(`${base}/api/vend/regions?token=${token}&service=dr`);
  assert.equal(r.status, 400, '锁定 go 的卡不该能查 dr 的地区');
  const body = await r.json().catch(() => ({}));
  assert.equal(body?.code ?? body?.error?.code, 'service_locked');
});

test('锁定卡查自己那个服务的地区 → 放行', async (t) => {
  const base = await freshServer(t);
  const issued = await issue(base, { order_id: `same-${randomUUID()}`, denom: '1.9', service: 'dr' });
  const info = await verify(base, codeFrom(issued.text));
  const r = await fetch(`${base}/api/vend/regions?token=${info.data.token}&service=dr`);
  assert.notEqual(r.status, 400, '锁定的服务本身必须能查');
});

test('老库升级：cards 缺 locked_service 时能补列且老卡不受影响', (t) => {
  const dir = join(tmpdir(), `vend-lockmig-${randomUUID()}`);
  const path = join(dir, 'vend.sqlite');
  const store = new CardStore(path);
  const { card } = store.issueCard({ denomCny: 1.9, orderId: 'old-order' });
  store.close();

  const reopened = new CardStore(path);
  t.after(() => {
    try { reopened.close(); } catch { /* 已关 */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });
  const again = reopened.getCard(card.code);
  assert.ok(again, '老卡要还在');
  assert.equal(again.locked_service ?? null, null, '升级后老卡必须仍是不锁定的');
});
