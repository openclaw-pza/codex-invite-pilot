// branding.js — 页面底部的项目署名。
//
// 许可证（Apache-2.0）要求保留署名，这里是它的实现。三条设计原则，
// 每一条都是**故意**的，改之前请先读完：
//
//   1. **关得掉。** BRANDING_FOOTER=off 就不注入了，而且关掉之后代码照常运行 ——
//      没有任何"检测到署名被移除就罢工"的逻辑。在开源项目里埋这种暗桩，
//      五分钟就会被绕过，代价却是被人挂出来说这个项目有后门。
//      留着署名靠的是许可证和体面，不是靠技术强制。
//
//   2. **不引入任何请求。** 纯内联 HTML + 内联样式，不加载脚本、不加载字体、
//      不打点。别人部署的站点不该因为署名而多出一个对外连接。
//
//   3. **不覆盖已有内容。** 只在 </body> 前追加一行，不动页面本来的 footer。
//
// 注入点在 server/vend-server.js 的 serveStatic()，只对 .html 生效。

const DEFAULT_URL = 'https://github.com/openclaw-pza/codex-invite-pilot';
const MARKER = 'data-branding="codex-invite-pilot"';

/** 关掉的写法只认 off / 0 / false，别的值一律当"开着" —— 拼错不该静默关掉署名。 */
export function brandingEnabled(env = process.env) {
  const raw = String(env.BRANDING_FOOTER ?? '').trim().toLowerCase();
  return !(raw === 'off' || raw === '0' || raw === 'false');
}

export function brandingUrl(env = process.env) {
  const raw = String(env.BRANDING_URL ?? '').trim();
  return raw || DEFAULT_URL;
}

/** 一行署名。颜色用 currentColor 配 opacity，深浅底色都能看清。 */
export function brandingHtml(url = DEFAULT_URL) {
  const safe = String(url).replace(/"/g, '&quot;');
  return (
    `<div ${MARKER} style="text-align:center;padding:14px 12px 20px;` +
    `font-size:12px;line-height:1.6;color:currentColor;opacity:.55">` +
    `Powered by <a href="${safe}" target="_blank" rel="noopener noreferrer" ` +
    `style="color:inherit;text-decoration:underline;text-underline-offset:2px">codex-invite-pilot</a>` +
    `</div>`
  );
}

/**
 * 把署名塞进 HTML。
 *
 * 注意 html 可能是 Buffer（serveStatic 读出来就是），所以先转字符串再判断。
 * 已经有署名的页面直接原样返回 —— 否则改完 HTML 又走一遍注入会出现两行。
 */
export function injectBranding(html, { enabled = true, url = DEFAULT_URL } = {}) {
  const text = Buffer.isBuffer(html) ? html.toString('utf8') : String(html ?? '');
  if (!enabled) return text;
  if (text.includes(MARKER)) return text;

  const snippet = brandingHtml(url);
  // 大小写不敏感地找最后一个 </body>。找不到就直接追加 ——
  // 片段式 HTML（没有 body 标签）也要能带上署名，不能静默丢掉。
  const idx = text.toLowerCase().lastIndexOf('</body>');
  if (idx === -1) return `${text}\n${snippet}\n`;
  return `${text.slice(0, idx)}${snippet}\n${text.slice(idx)}`;
}
