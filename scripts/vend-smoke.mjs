// vend-smoke.mjs — 取号服务端到端烟测（可重复跑）
//
// 覆盖：发卡回调 → 买家验卡 → 拉真实地区列表 → 面额闸门 → 页面资源
// **不取号**（取号会扣真钱）。要验证取号请手动跑，并且做好扣费准备。
//
// 用法：node scripts/vend-smoke.mjs
// 会在系统临时目录建一个独立的库，不碰 data/vend.sqlite。

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';

const SECRET = 'smoke-secret-ascii';
process.env.VEND_ISSUE_SECRET = SECRET;
process.env.VEND_ADMIN_TOKEN = 'smoke-admin-ascii';

const { startVendServer } = await import('../server/vend-server.js');

const dir = join(tmpdir(), `vend-smoke-${randomUUID()}`);
const app = await startVendServer({ dbPath: join(dir, 'vend.sqlite'), port: 0, host: '127.0.0.1', skipVendorSync: true });
const base = `http://127.0.0.1:${app.port}`;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✔' : '  ✖'} ${name}${detail ? `  ${detail}` : ''}`);
}

async function json(path, options) {
  const response = await fetch(base + path, options);
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 保持 null */ }
  return { status: response.status, body, text };
}

try {
  console.log('\n【1】闲鱼发卡回调');
  const issued = await json('/api/cards/issue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Card-Secret': SECRET },
    body: JSON.stringify({ order_id: `SMOKE-${Date.now()}`, item_id: '9001', spec_value: '基础卡' }),
  });
  check('返回 200', issued.status === 200, `status=${issued.status}`);
  check('响应是裸 data 字符串（不能套 ok 信封）', typeof issued.body?.data === 'string' && !('ok' in (issued.body || {})));
  const code = /ANGE-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/.exec(issued.body?.data || '')?.[0];
  check('发货文本里有卡密', Boolean(code), code || issued.text.slice(0, 120));

  console.log('\n【2】买家验证卡密');
  const verified = await json('/api/vend/card/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  check('验证通过', verified.status === 200, `status=${verified.status}`);
  const token = verified.body?.data?.token;
  const denom = verified.body?.data?.denomCny;
  check('拿到会话令牌', Boolean(token));
  check('面额正确', denom === 1.9, `denom=${denom}`);
  check('不泄露卡密以外的内部字段', !JSON.stringify(verified.body).includes('api_key'));

  console.log('\n【3】真实地区列表（只读，不扣费）');
  const regions = await json(`/api/vend/regions?token=${encodeURIComponent(token)}`);
  const data = regions.body?.data;
  check('拉到地区', Array.isArray(data?.regions) && data.regions.length > 0, `共 ${data?.total} 个`);
  check('面额闸门生效', data?.overBudget > 0, `额度内 ${data?.withinBudget} / 超额 ${data?.overBudget}`);
  const usa = data?.regions?.find((r) => /美国/.test(r.name));
  check('美国被判为超额', Boolean(usa?.over), usa ? `${usa.name} ¥${usa.priceCny} 需补 ¥${usa.topupCny}` : '列表里没有美国');
  check('价格按升序排', JSON.stringify(data.regions.map((r) => r.priceCny)) === JSON.stringify([...data.regions.map((r) => r.priceCny)].sort((a, b) => a - b)));
  console.log(`    最便宜 3 个：${data.regions.slice(0, 3).map((r) => `${r.name} ¥${r.priceCny}`).join(' / ')}`);

  console.log('\n【4】超额地区取号必须被拦（这一步不会扣钱，因为闸在调平台之前）');
  if (usa) {
    const blocked = await json('/api/vend/number', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, country: usa.id }),
    });
    check('被拦下', blocked.status === 402, `status=${blocked.status} code=${blocked.body?.code}`);
    check('提示里说清要补多少', /需要补/.test(blocked.body?.error || ''), blocked.body?.error);
  }

  console.log('\n【5】页面资源');
  for (const path of ['/', '/vend.css', '/vend.js', '/fonts/dm-mono-300.woff2']) {
    const response = await fetch(base + path);
    check(`GET ${path}`, response.status === 200, `${response.status}`);
  }

  console.log('\n【6】安全');
  for (const path of ['/../admin.html', '/%2e%2e/admin.html']) {
    const response = await fetch(base + path);
    check(`穿越 ${path} 被挡`, response.status === 403 || response.status === 404, `${response.status}`);
  }
  const noAuth = await json('/api/vend/admin/topups');
  check('管理接口需口令', noAuth.status === 401, `status=${noAuth.status}`);
} finally {
  await app.close();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录留着也无妨 */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
if (failed.length) {
  console.log('失败项：');
  for (const item of failed) console.log(`  · ${item.name} ${item.detail}`);
  process.exit(1);
}
