// vend-issue.test.js — 闲鱼自动发货回调的集成测试
//
// 守的是一个真实会翻车的点：闲鱼取卡内容的代码是
//   content = result.get('data') or result.get('content') or result.get('card') or str(result)
// 如果我们的响应套了 {ok:true, data:{...}} 信封，它会拿到内层**对象**而不是卡密字符串，
// 最后把整个字典的字面量发给买家。所以这个接口必须裸返回 {"data": "卡密文本"}。
//
// 红线：本测试只用临时目录的库和临时端口，不碰 data/vend.sqlite。

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';

// 密钥必须是纯 ASCII：HTTP 头只能装 latin-1 字节，中文密钥根本发不出去。
// 服务端启动时也会对此告警，见 vend-server.js。
const SECRET = 'test-secret-ascii-only-123';

// 密钥要在 startVendServer 之前进环境变量：readSecrets() 在建路由时读一次
process.env.VEND_ISSUE_SECRET = SECRET;

const { startVendServer } = await import('../server/vend-server.js');

async function boot(t) {
  const dir = join(tmpdir(), `vend-issue-${randomUUID()}`);
  const app = await startVendServer({
    dbPath: join(dir, 'vend.sqlite'),
    port: 0,               // 让系统分配空闲端口，避免撞上正在跑的服务
    host: '127.0.0.1',
    skipVendorSync: true,  // 测试不需要拷 gsap
  });
  t.after(async () => {
    await app.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 删不掉不影响结论 */ }
  });
  return app;
}

function issueUrl(app) {
  return `http://127.0.0.1:${app.port}/api/cards/issue`;
}

async function postIssue(app, body, headers = {}) {
  const response = await fetch(issueUrl(app), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 就留 null */ }
  return { status: response.status, text, json };
}

test('发卡响应必须是裸的 {"data": "..."}，不能套 ok/data 信封', async (t) => {
  const app = await boot(t);
  const res = await postIssue(app, { order_id: 'XY-1', spec_value: '基础卡' }, { 'X-Card-Secret': SECRET });

  assert.equal(res.status, 200);
  assert.equal(typeof res.json.data, 'string', '闲鱼取的 data 必须是字符串，套了信封这里会变成对象');
  assert.equal('ok' in res.json, false, '套了 {ok:true,...} 信封就会把整个字典发给买家');
  assert.match(res.json.data, /ANGE-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/, '发货文本里得有卡密');

  // 模拟闲鱼那段取值逻辑，确认拿到的确实是能直接发给买家的文本
  const asXianyuWouldRead = res.json.data || res.json.content || res.json.card || JSON.stringify(res.json);
  assert.equal(typeof asXianyuWouldRead, 'string');
  assert.ok(!asXianyuWouldRead.includes('[object'), '买家不能收到对象字面量');
});

test('密钥不对返回 401（闲鱼对 401 不重试，正合适）', async (t) => {
  const app = await boot(t);
  assert.equal((await postIssue(app, { order_id: 'XY-2' }, { 'X-Card-Secret': 'wrong-secret' })).status, 401);
  assert.equal((await postIssue(app, { order_id: 'XY-2' })).status, 401, '不带密钥也必须拒');
  // 空字符串不能当作"没设密钥所以放行"
  assert.equal((await postIssue(app, { order_id: 'XY-2' }, { 'X-Card-Secret': '' })).status, 401);
});

test('闲鱼重试 4 次也只发一张卡（同一 order_id 幂等）', async (t) => {
  const app = await boot(t);
  const calls = await Promise.all(
    Array.from({ length: 4 }, () => postIssue(app, { order_id: 'XY-RETRY', spec_value: '基础卡' }, { 'X-Card-Secret': SECRET })),
  );
  const codes = calls.map((r) => /ANGE-[A-Z2-9-]+/.exec(r.json.data)[0]);
  assert.equal(new Set(codes).size, 1, `4 次重试发出了 ${new Set(codes).size} 张不同的卡`);
});

test('面额优先取卡券里写死的 denom，其次才是规格映射', async (t) => {
  const app = await boot(t);

  // params 里写死 denom：规格文字以后改了也不会错发
  const explicit = await postIssue(app, { order_id: 'D-1', spec_value: '随便什么规格', denom: 6.9 }, { 'X-Card-Secret': SECRET });
  assert.equal(explicit.status, 200);

  // 没写 denom 时按规格映射（vend-config 内置「美国卡」= 6.9）
  const mapped = await postIssue(app, { order_id: 'D-2', spec_value: '美国卡' }, { 'X-Card-Secret': SECRET });
  assert.equal(mapped.status, 200);

  // 规格对不上必须**拒绝发卡**，不能默默发默认面额：
  // 买家付了 ¥6.9 的美国卡却收到 ¥1.9 的基础卡，是必然的纠纷。
  // 返回 400 而不是 5xx——闲鱼对 4xx 不重试，配错了当场炸比默默发错卡强。
  const unmatched = await postIssue(app, { order_id: 'D-3', spec_value: '没见过的规格' }, { 'X-Card-Secret': SECRET });
  assert.equal(unmatched.status, 400);
  assert.equal(unmatched.json.code, 'spec_unmatched');
});

test('买家接口没有 token 一律拒绝，且不泄露内部错误', async (t) => {
  const app = await boot(t);
  const res = await fetch(`http://127.0.0.1:${app.port}/api/vend/number`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ country: 15 }),
  });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.ok, false);
  // 报错文案要是人话，不能带栈、SQL 或平台原始码
  assert.ok(!/Error|sqlite|SELECT|api_key/i.test(body.error), `错误文案泄露了内部信息：${body.error}`);
});

test('管理接口在没配口令时当作不存在', async (t) => {
  const app = await boot(t);
  const res = await fetch(`http://127.0.0.1:${app.port}/api/vend/admin/topups`);
  assert.equal(res.status, 404);
});

test('静态资源不能穿越到 public 上级目录（那里有 admin.html）', async (t) => {
  const app = await boot(t);
  for (const path of ['/../admin.html', '/%2e%2e/admin.html', '/..%2fadmin.html', '/%2e%2e%2fadmin.html']) {
    const res = await fetch(`http://127.0.0.1:${app.port}${path}`);
    assert.ok(res.status === 403 || res.status === 404, `${path} 返回了 ${res.status}`);
    const text = await res.text();
    assert.ok(!text.includes('管理员'), `${path} 竟然读到了 admin.html 内容`);
  }
});
