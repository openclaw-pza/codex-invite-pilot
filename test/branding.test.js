// branding.test.js — 署名 footer 的行为边界。
//
// 这个功能有个特殊之处：**它必须能被关掉，而且关掉之后一切照常**。
// 所以这里既钉「开着的时候确实在」，也钉「关掉之后确实不在、也不报错」。

import test from 'node:test';
import assert from 'node:assert/strict';
import { brandingEnabled, brandingUrl, brandingHtml, injectBranding } from '../server/branding.js';

const MARKER = 'data-branding="codex-invite-pilot"';

test('默认开启', () => {
  assert.equal(brandingEnabled({}), true);
  assert.equal(brandingEnabled({ BRANDING_FOOTER: '' }), true);
});

test('off / 0 / false 都能关掉，大小写不敏感', () => {
  for (const v of ['off', 'OFF', 'Off', '0', 'false', 'FALSE', ' off ']) {
    assert.equal(brandingEnabled({ BRANDING_FOOTER: v }), false, `${JSON.stringify(v)} 应该关掉`);
  }
});

test('写错的值不静默关掉署名', () => {
  // 「关掉」是个明确动作，拼错不该达成它 —— 否则 BRANDING_FOOTER=ofF1
  // 这种手滑会让人以为自己遵守了许可证，实际没有。
  for (const v of ['no', 'disable', 'ofx', 'true', '1', 'on']) {
    assert.equal(brandingEnabled({ BRANDING_FOOTER: v }), true, `${JSON.stringify(v)} 不该关掉`);
  }
});

test('URL 可覆盖，留空回落到项目地址', () => {
  assert.equal(brandingUrl({ BRANDING_URL: 'https://example.org/x' }), 'https://example.org/x');
  assert.match(brandingUrl({}), /^https:\/\/github\.com\//);
  assert.match(brandingUrl({ BRANDING_URL: '   ' }), /^https:\/\/github\.com\//);
});

test('注入在 </body> 之前，不动页面原有内容', () => {
  const html = '<html><body><footer>原来的页脚</footer></body></html>';
  const out = injectBranding(html, { enabled: true });
  assert.ok(out.includes(MARKER), '应该注入署名');
  assert.ok(out.includes('原来的页脚'), '不该动原有内容');
  assert.ok(out.indexOf(MARKER) < out.indexOf('</body>'), '署名要在 </body> 之前');
});

test('关掉之后原样返回，不抛错', () => {
  const html = '<html><body>x</body></html>';
  const out = injectBranding(html, { enabled: false });
  assert.equal(out, html);
});

test('不会注入两次', () => {
  const once = injectBranding('<html><body>x</body></html>', { enabled: true });
  const twice = injectBranding(once, { enabled: true });
  assert.equal(twice, once, '第二次注入应该原样返回');
  assert.equal(twice.split(MARKER).length - 1, 1, '页面上只能有一处署名');
});

test('没有 </body> 也不能把署名丢掉', () => {
  // 片段式 HTML（比如将来某个页面只输出一段 partial）同样要带上署名。
  const out = injectBranding('<div>片段</div>', { enabled: true });
  assert.ok(out.includes(MARKER));
  assert.ok(out.includes('<div>片段</div>'));
});

test('接受 Buffer —— serveStatic 读出来就是 Buffer', () => {
  const out = injectBranding(Buffer.from('<html><body>x</body></html>', 'utf8'), { enabled: true });
  assert.equal(typeof out, 'string');
  assert.ok(out.includes(MARKER));
});

test('大写 </BODY> 一样认得出来', () => {
  const out = injectBranding('<HTML><BODY>x</BODY></HTML>', { enabled: true });
  assert.ok(out.indexOf(MARKER) < out.toLowerCase().indexOf('</body>'));
});

test('URL 里的引号被转义，注入不了属性', () => {
  const out = injectBranding('<body></body>', { enabled: true, url: 'https://x/" onload="alert(1)' });
  assert.equal(out.includes('onload="alert(1)"'), false, '不能被拼出新属性');
  assert.ok(out.includes('&quot;'));
});

test('署名不引入任何外部请求', () => {
  // 别人部署的站点不该因为一行署名而多出对外连接：不加载脚本、字体、图片，也不打点。
  const snippet = brandingHtml();
  assert.equal(/<script|<img|<link|@import|url\(/i.test(snippet), false, '署名里不该有任何会发请求的东西');
});
