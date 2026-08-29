import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 2026-08-26 独立审计发现的 🔴：微软 token 端点返回 503/429 这类**瞬时故障**时，
// 旧代码也会 unlinkSync 删掉完全有效的 refresh_token，然后自动重新授权 ——
// 而重新授权很可能再绑一个十分钟就失效的临时恢复邮箱。
// 等于拿一次网络抖动换掉一个不可再生的微软账号。
const dir = mkdtempSync(join(tmpdir(), 'tokguard-'));
const tokenPath = join(dir, 'token.json');
process.env.OUTLOOK_TOKEN_PATH = tokenPath;
process.env.WEBMAIL_USER = 'guard@outlook.com';

const { getOutlookAccessToken } = await import('../server/outlookMail.js');

function seedToken() {
  writeFileSync(tokenPath, JSON.stringify({ clientId: 'cid', refreshToken: 'GOOD-TOKEN', scope: 'x offline_access' }));
}

async function refreshWith(status, body) {
  seedToken();
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status });
  try {
    await getOutlookAccessToken({ force: true });
    return { threw: false };
  } catch (error) {
    return { threw: true, message: error.message };
  } finally {
    globalThis.fetch = real;
  }
}

test('503 是瞬时故障：报错但**绝不能**删掉有效的 refresh_token', async () => {
  const r = await refreshWith(503, { error: 'temporarily_unavailable' });
  assert.equal(r.threw, true);
  assert.match(r.message, /暂时失败/);
  assert.equal(existsSync(tokenPath), true, 'token 被删了 —— 这会触发重新授权并重绑一个十分钟就死的恢复邮箱');
});

test('429 限流同理，token 必须保留', async () => {
  const r = await refreshWith(429, { error: 'temporarily_unavailable' });
  assert.equal(r.threw, true);
  assert.equal(existsSync(tokenPath), true);
});

test('认不出来的错误也保守处理：保留 token', async () => {
  const r = await refreshWith(400, { error: '某个没见过的错误' });
  assert.equal(r.threw, true);
  assert.equal(existsSync(tokenPath), true);
});
