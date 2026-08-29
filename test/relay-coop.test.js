// relay-coop.test.js — relay.html 的 COOP 头
//
// 全站 COOP 是 same-origin（对的，防跨窗口攻击）。但 relay.html 是**故意**
// 要跟一个跨源的 opener 说话的：书签在 OpenAI 页面上把它弹出来，
// 它再把验证码 postMessage 回去。COOP same-origin 会把这层 opener 关系
// 直接切断 —— window.opener 变成 null，握手静默失败。
//
// 「静默」是这个 bug 最坏的地方：没有报错、没有日志，买家点了书签只看到
// 弹窗里写着"没连上"。开发时我就是这么被卡住的，查了三轮才定位到响应头。
// 所以必须有测试钉住，而且要两个方向都测：relay 放开、其他页面照旧收紧。

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';

const { startVendServer } = await import('../server/vend-server.js');

async function boot(t) {
  const dir = join(tmpdir(), `vend-coop-${randomUUID()}`);
  const app = await startVendServer({
    dbPath: join(dir, 'vend.sqlite'), port: 0, host: '127.0.0.1', skipVendorSync: true,
  });
  t.after(async () => {
    await app.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });
  return app.port ?? app.address?.().port;
}

test('relay.html 必须放开 COOP，否则书签自动填整个失效', async (t) => {
  const port = await boot(t);
  const res = await fetch(`http://127.0.0.1:${port}/relay.html`);
  assert.equal(res.status, 200);
  assert.equal(
    res.headers.get('cross-origin-opener-policy'), 'unsafe-none',
    'relay 页要保住 window.opener —— 这是它存在的唯一理由',
  );
});

test('其他页面照旧收紧，别顺手把整站的 COOP 放了', async (t) => {
  const port = await boot(t);
  for (const path of ['/', '/index.html', '/help.html']) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(
      res.headers.get('cross-origin-opener-policy'), 'same-origin',
      `${path} 的 COOP 不该被放开`,
    );
  }
});

test('relay 页仍然带着其余安全头 —— 只放 COOP 一项', async (t) => {
  const port = await boot(t);
  const res = await fetch(`http://127.0.0.1:${port}/relay.html`);
  assert.match(res.headers.get('content-security-policy') || '', /script-src 'self'/,
    'CSP 不能跟着一起放松');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});
