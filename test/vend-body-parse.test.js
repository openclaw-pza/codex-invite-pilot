// 请求体解析：Content-Type 说的和实际发的可能不一致。
//
// 2026-08-23 事故：闲鱼发卡回调发 JSON、Content-Type 却写 urlencoded。
// 照声明解析出来是 {'{"order_id":"...","denom":"1.9"}': ''} ——
// 整段 JSON 成了字段名，body.order_id 恒为 undefined，
// 「缺 order_id 就拒发」那道闸把每一单都挡下，接码商品全线停发、全靠人工补。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SECRET = 'test-issue-secret-0123456789';

async function boot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vend-body-'));
  process.env.VEND_ISSUE_SECRET = SECRET;
  process.env.VEND_ADMIN_TOKEN = 'test-admin-token';
  const { startVendServer } = await import('../server/vend-server.js');
  const app = await startVendServer({ dbPath: join(dir, 'v.sqlite'), port: 0, host: '127.0.0.1', skipVendorSync: true });
  t.after(async () => { await app.close(); try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  return app.port ?? app.address?.().port;
}

const post = (port, contentType, body) => fetch(`http://127.0.0.1:${port}/api/cards/issue`, {
  method: 'POST',
  headers: { 'content-type': contentType, 'x-card-secret': SECRET },
  body,
});

test('JSON 正文 + urlencoded 声明：必须照 JSON 解，不能拒发', async (t) => {
  const port = await boot(t);
  // 这就是闲鱼实际发出来的东西（从生产日志里原样抄的）
  const raw = '{"order_id": "3316374086208000979", "item_id": "1076385238959", "spec_value": "", "denom": "1.9"}';
  const res = await post(port, 'application/x-www-form-urlencoded', raw);
  const json = await res.json();
  assert.equal(res.status, 200, `被拒了：${JSON.stringify(json)}`);
  assert.match(String(json.data), /卡密：ANGE-/);
});

test('JSON 正文 + JSON 声明：本来就该通', async (t) => {
  const port = await boot(t);
  const res = await post(port, 'application/json', '{"order_id":"O-json-1","denom":"1.9"}');
  assert.equal(res.status, 200);
});

test('真表单不能被误判成 JSON', async (t) => {
  const port = await boot(t);
  const res = await post(port, 'application/x-www-form-urlencoded', 'order_id=O-form-1&denom=1.9');
  const json = await res.json();
  assert.equal(res.status, 200, `真表单也该能发卡：${JSON.stringify(json)}`);
  assert.match(String(json.data), /卡密：ANGE-/);
});

test('声明 urlencoded 但正文是坏 JSON：退回表单解析，不能整个炸掉', async (t) => {
  const port = await boot(t);
  // 以 { 开头但不是合法 JSON —— 走表单分支后 order_id 仍然拿不到，
  // 应该是「参数不完整」的业务错误(400)，而不是 JSON.parse 抛出去变成 5xx
  const res = await post(port, 'application/x-www-form-urlencoded', '{坏了的东西');
  assert.equal(res.status, 400);
});

test('同一 order_id 重复发卡返回同一张（幂等没被这次改动破坏）', async (t) => {
  const port = await boot(t);
  const raw = '{"order_id": "IDEM-1", "denom": "1.9"}';
  const a = await (await post(port, 'application/x-www-form-urlencoded', raw)).json();
  const b = await (await post(port, 'application/x-www-form-urlencoded', raw)).json();
  const code = (t) => /卡密：(\S+)/.exec(String(t))?.[1];
  assert.equal(code(a.data), code(b.data), '闲鱼会重试，重试必须拿回同一张卡');
});
