// vend-server.js — 对外售卖的取号服务（独立进程、独立端口）
//
// 跟 server.js（Codex Invite Pilot 自用）刻意完全分开：
//   · 那个进程有 /api/admin/config（能读写 HeroSMS key）、/api/email/*、/api/automation/*，
//     一行都不能暴露到公网
//   · 静态资源根目录锁死在 public/vend/，**不是** public/，
//     否则 admin.html 会跟着一起挂到外网上
//   · 本进程不提供任何能改密钥的接口；管理动作只有「核对补差价」和「发卡」，都要口令
//
// 部署姿势：默认只听 127.0.0.1，公网访问走 Cloudflare Tunnel / 反向代理。
// 要直接对外监听时设 VEND_HOST=0.0.0.0，并且必须自己在前面加 TLS。

import { createServer } from 'node:http';
import { readFile, mkdir, copyFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, resolve, sep } from 'node:path';

import { CardStore } from './cards.js';
import { loadVendConfig, VEND_DB_PATH, readSecrets } from './vend-config.js';
import { createVendRoutes } from './vend-routes.js';
import { getCatalog } from './vend-catalog.js';
import { startBalanceWatch } from './balanceWatch.js';
import { injectBranding, brandingEnabled, brandingUrl } from './branding.js';
import { prewarmStars, githubRepo } from './githubStars.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, '..');
const PUBLIC_DIR = resolve(join(PROJECT_ROOT, 'public', 'vend'));

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  // robots.txt / llms.txt / sitemap.xml 要能被爬虫直接读，
  // 落到 application/octet-stream 会变成下载而不是显示
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

// 一年缓存的静态资源（带内容指纹或本来就不会变的）
const LONG_CACHE = new Set(['.woff2', '.png', '.jpg', '.webp', '.svg']);

const MAX_BODY_BYTES = 64 * 1024; // 买家接口的请求体都很小，给 64KB 足够且能挡住灌包

// 安全响应头。CSP 不放行任何外部域——
// Google Fonts 在国内打不开，字体必须自托管，所以这里也没有它的位置。
// 是否允许搜索引擎和生成式引擎收录。
// 做 GEO 就必须开；想收回去只改环境变量重启，不用改代码。
// 注意：一旦被 AI 引擎抓取并缓存，关掉之后缓存不会立刻消失。
const INDEXABLE = process.env.VEND_INDEXABLE !== '0';
const ROBOTS_HEADER = INDEXABLE ? {} : { 'X-Robots-Tag': 'noindex, nofollow' };

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    // 放行 Cloudflare Web Analytics 的探针（安哥 2026-08-21 批准）。
    // CF 会自动往页面里注入 beacon.min.js，不放行的话既拿不到流量统计、
    // 控制台还常驻一条 CSP 报错。只放这一个具体域名，不开 'unsafe-inline'。
    "script-src 'self' https://static.cloudflareinsights.com",
    "font-src 'self'",
    // 注意：connect-src 只能出现一次。写两条的话浏览器只认第一条、
    // 忽略后面的，并在控制台常驻一条 duplicate directive 报错（踩过）。
    "connect-src 'self' https://cloudflareinsights.com",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  ...ROBOTS_HEADER,
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

// 纯文本响应。支付宝的异步通知有个硬要求：页面必须**只输出** `success`
// 这七个字符。回 JSON（哪怕内容是 "success" 带引号）它都判定为失败，
// 然后按 4m/10m/1h/2h/6h/15h 的节奏一直重推 25 小时。
function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(String(text));
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      // 必须销毁连接：剩余字节留在 keep-alive 连接里，
      // 下一个复用该连接的请求会永远等不到响应，买家侧表现为「网络不通」
      req.destroy();
      throw new Error('请求体过大');
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  // 支付宝的异步通知是 application/x-www-form-urlencoded，不是 JSON。
  // 按 content-type 分流而不是「先试 JSON 再试表单」——
  // 后者会把表单里恰好像 JSON 的值解析错，而且错得很难查。
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/x-www-form-urlencoded')) {
    // 闲鱼发卡回调发的是 JSON，Content-Type 却声明成 urlencoded（2026-08-23 抓到实证）。
    // 照声明解析的产物是 `{'{"order_id":"...","denom":"1.9"}': ''}` ——
    // 整段 JSON 变成一个字段名、值是空串，于是 body.order_id 恒为 undefined，
    // 我们那道「缺 order_id 就拒发」的闸把每一单都挡了，接码商品全线停发。
    //
    // 所以按声明分流之外再加一条：**正文本身长得像 JSON 就按 JSON 解**。
    // 判据卡得很死（首字符是 { 或 [，且整段能 JSON.parse 通过），
    // 真表单是 `k=v&k2=v2`，不可能同时满足这两条；
    // 支付宝的异步通知也是标准表单，不受影响。
    const looksJson = text.startsWith('{') || text.startsWith('[');
    if (looksJson) {
      try {
        return JSON.parse(text);
      } catch {
        // 解不动就退回表单解析，跟以前完全一致
      }
    }
    return Object.fromEntries(new URLSearchParams(text).entries());
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

// 取买家真实 IP。只有明确设了 VEND_TRUST_PROXY 才信 X-Forwarded-For——
// 否则任何人都能伪造这个头来绕开限速。
const TRUST_PROXY = process.env.VEND_TRUST_PROXY === '1';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// 拿不到买家真实 IP 时统一用这个标记，路由层据此决定哪条限速要退化
export const LOOPBACK_MARK = 'unreliable-ip';
let loopbackWarned = false;

function clientIp(req) {
  if (TRUST_PROXY) {
    // 顺序很关键。Cloudflare / nginx 是把真实 IP **追加到 X-Forwarded-For 末尾**，
    // 取 [0] 拿到的是客户端自己塞进来的那一段——限速会被随便绕过，
    // 反过来填别人的 IP 还能定向把人锁 30 分钟。
    // CF-Connecting-IP 由 Cloudflare 覆写，伪造不了，所以优先用它。
    const cfIp = String(req.headers['cf-connecting-ip'] || '').trim();
    if (cfIp) return cfIp;
    const chain = String(req.headers['x-forwarded-for'] || '')
      .split(',').map((part) => part.trim()).filter(Boolean);
    if (chain.length) return chain[chain.length - 1];
  }
  const raw = req.socket.remoteAddress || '-';
  // 没开 TRUST_PROXY，请求却全部来自回环地址 —— 说明前面挂着反代/隧道，
  // 所有买家会被算成同一个人：一个人输错 5 次卡密，全站买家一起被锁 30 分钟。
  // 刚花钱买了卡的人第一次输入就看到「试得太多了」，只会当场退款差评。
  // 这种情况下宁可放弃这条限速，也不能把付过钱的买家挡在门外。
  if (!TRUST_PROXY && LOOPBACK.has(raw)) {
    if (!loopbackWarned) {
      loopbackWarned = true;
      console.warn('[vend] 请求来自回环地址但没开 VEND_TRUST_PROXY，买家侧限速已自动退化（否则会误锁全部买家）。挂反代时请设 VEND_TRUST_PROXY=1');
    }
    // 返回一个**固定**标记而不是随机值。
    // 随机值会顺带把管理口令的爆破闸也废掉——那个闸锁住是对的（只有卖家一个人用），
    // 需要退化的只是买家验卡那条限速，由路由层按这个标记单独判断。
    return LOOPBACK_MARK;
  }
  return raw;
}

// 判断解析后的路径是否仍在允许的根目录内。
// 必须用 `根目录 + 分隔符` 比较：只比前缀的话，`public/vend-secrets` 也会被判为合法。
export function isInsideRoot(filePath, root) {
  const target = resolve(filePath);
  const base = resolve(root);
  return target === base || target.startsWith(base + sep);
}

async function serveStatic(req, res, pathname) {
  // 先解码再校验：`%2e%2e` 这类编码过的穿越必须在检查之前还原成 `..`
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendJson(res, 400, { ok: false, error: '路径不合法' });
    return;
  }
  // 反斜杠在 Windows 上也是路径分隔符，统一成正斜杠再交给 join
  decoded = decoded.replace(/\\/g, '/');
  const relative = decoded === '/' || decoded === '' ? '/index.html' : decoded;
  const filePath = resolve(join(PUBLIC_DIR, relative));
  if (!isInsideRoot(filePath, PUBLIC_DIR)) {
    sendJson(res, 403, { ok: false, error: '禁止访问' });
    return;
  }
  try {
    const data = await readFile(filePath);
    const ext = extname(filePath);
    // relay.html 是**故意**要跟一个跨源的 opener 说话的（书签在 OpenAI 页面上
    // 把它弹出来，它再把验证码 postMessage 回去）。
    // 全站的 COOP: same-origin 会把这层 opener 关系直接切断 —— 表现是
    // window.opener 为 null、握手静默失败，买家只看到"没反应"。
    // 所以只对这一个页面降到 unsafe-none，别的页面照旧。
    //
    // 这个口子开得起：relay 页**不持有任何凭据**（只有买家自己的邮箱/验证码/号码，
    // 而且只回传给白名单里的 OpenAI 域），它本来就是为跨源对话设计的。
    const isRelay = filePath.endsWith('relay.html');
    const headers = { ...SECURITY_HEADERS };
    if (isRelay) headers['Cross-Origin-Opener-Policy'] = 'unsafe-none';
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': LONG_CACHE.has(ext) ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...headers,
    });
    // 署名只加在 HTML 上。relay.html 跳过：它是给跨源 opener 用的功能页，
    // 不是给人看的页面，往里塞可见元素只会干扰握手时的视觉判断。
    // 没有显式设 Content-Length，改了长度也不会对不上。
    if (ext === '.html' && !isRelay) {
      res.end(injectBranding(data, {
        enabled: brandingEnabled(),
        url: brandingUrl(),
      }));
      return;
    }
    res.end(data);
  } catch {
    sendJson(res, 404, { ok: false, error: '页面不存在' });
  }
}


// options 只给测试用：注入临时库路径和临时端口，避免测试碰生产数据。
// 生产走无参调用，全部取配置。
export async function startVendServer({ dbPath = VEND_DB_PATH, port, host, skipVendorSync = false } = {}) {
  const config = loadVendConfig();
  const secrets = readSecrets();
  const listenPort = port ?? config.port;
  const listenHost = host ?? config.host;
  const store = new CardStore(dbPath);
  const { routes } = createVendRoutes({ store });


  // 回收：孤儿占位（进程崩在取号中途留下的）会让那张卡一直被硬闸判成
  // 「有号在进行中」而取不了新号。每小时跑一次是不够的——如果服务重启比一小时更频繁，
  // 计时器每次归零，这条清理**永远不会执行**。所以启动先跑一次 + 每分钟一次。
  const reclaimOptions = { activationTtlMs: config.activationTtlSec * 1000 };
  function reclaim() {
    try {
      const result = store.sweep(reclaimOptions);
      if (result.staleReserved || result.expiredWaiting) {
        console.warn(`[vend] 回收：陈旧占位 ${result.staleReserved} 条（可能已扣费未退款，需人工核对）/ 过期等待 ${result.expiredWaiting} 条`);
      }
    } catch (error) {
      console.warn(`[vend] 回收失败：${error.message}`);
    }
  }
  reclaim(); // 启动先跑一次，别让上次崩溃留下的卡死等一小时

  // 服务目录要拉 2.8MB 的全量报价矩阵。不预热的话，重启后第一个买家
  // 打开页面要干等这一下。后台拉，不阻塞启动。
  getCatalog()
    .then((list) => console.log(`[vend] 服务目录已预热：${list.length} 个可售服务`))
    .catch((error) => console.warn(`[vend] 服务目录预热失败：${error.message}`));

  // 顶栏 star 计数也预热一下：它是「立刻返回缓存、后台刷新」的取法，
  // 不预热的话重启后第一个访客看到的是没有数字的按钮。没配 GITHUB_REPO 时这是个空操作。
  prewarmStars(githubRepo());
  const sweeper = setInterval(reclaim, 60 * 1000);
  sweeper.unref();

  // 上游余额告警。余额见底不会报错，只会让每次取号都「换个地区试试」——
  // 买家换遍所有地区都失败然后退款，而我们这边一无所知。
  startBalanceWatch();

  const server = createServer(async (req, res) => {
    // Host 头是攻击面：`Host: ]` 会让 new URL 抛 ERR_INVALID_URL，
    // 而这个 handler 是 async，抛出去就是 unhandledRejection，Node 22+ 直接把进程干掉。
    // 一个 40 字节的请求就能让整个取号服务下线，不需要任何凭据。
    // 本服务只用 pathname 和 searchParams，跟真实 host 无关，用固定占位主机即可。
    let url;
    try {
      url = new URL(req.url, 'http://placeholder.invalid');
    } catch {
      sendJson(res, 400, { ok: false, error: '请求不合法' });
      return;
    }
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      const route = routes.find((item) => item.method === req.method && item.path === pathname);
      if (!route) {
        sendJson(res, 404, { ok: false, error: '接口不存在' });
        return;
      }
      try {
        const body = req.method === 'GET' ? {} : await readBody(req);
        const query = Object.fromEntries(url.searchParams.entries());
        const data = await route.handler({ body, query, headers: req.headers, ip: clientIp(req) });
        // raw 路由**不套** {ok,data} 信封。
        // 闲鱼取卡内容的代码是 result.get('data') or result.get('content') or result.get('card')，
        // 套了信封它会拿到内层对象而不是卡密字符串，最后把整个字典当文本发给买家。
        if (route.text) sendText(res, 200, data);
        else sendJson(res, 200, route.raw ? data : { ok: true, data });
      } catch (error) {
        const status = Number(error?.status) || 400;
        // 只有业务错误（带 status）才把 message 给买家看；
        // 其余一律走兜底文案，避免把栈、SQL、平台原始报错漏出去。
        const isBusiness = Boolean(error?.status);
        if (!isBusiness) console.error(`[vend ${pathname}]`, error);
        // text 路由（支付宝通知）出错也不能回 JSON：回什么都不是 success 就行，
        // 但得是纯文本，否则支付宝那边日志里全是解析失败，查起来看不出真原因。
        if (route.text) { sendText(res, status, 'fail'); return; }
        sendJson(res, status, {
          ok: false,
          error: isBusiness ? error.message : '服务开小差了，稍后再试',
          // 只回业务错误码。非业务错误的 code 是 Node 内部码（ERR_INVALID_ARG_TYPE 之类），
          // 漏出去既没用又暴露实现
          code: isBusiness ? (error.code || null) : null,
        });
      }
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res, pathname);
      return;
    }
    sendJson(res, 405, { ok: false, error: '方法不被允许' });
  });

  await new Promise((done) => server.listen(listenPort, listenHost, done));
  const actualPort = server.address().port;

  // 注意用 === undefined 而不是 !port：测试传的是 port 0（让系统分配），0 是 falsy
  if (port === undefined) {
    console.log(`\n  取号服务已启动`);
    console.log(`  → http://${listenHost}:${actualPort}/`);
    console.log(`  静态根目录：${PUBLIC_DIR}`);
    console.log(`  换算系数：$1 = ¥${config.rate}\n`);
    const warn = [];
    if (!secrets.issueSecret) warn.push('VEND_ISSUE_SECRET（未配置 → 闲鱼发卡接口关闭）');
    if (!secrets.adminToken) warn.push('VEND_ADMIN_TOKEN（未配置 → 管理接口关闭）');
    // HTTP 头只能装 latin-1 字节。密钥里有中文的话闲鱼那边请求都发不出来，
    // 表现是买家下单后什么都收不到，且很难查——所以在启动时就喊出来。
    for (const [name, value] of [['VEND_ISSUE_SECRET', secrets.issueSecret], ['VEND_ADMIN_TOKEN', secrets.adminToken]]) {
      if (value && /[^\x20-\x7E]/.test(value)) {
        warn.push(`${name} 含非 ASCII 字符，HTTP 头装不下，请改成纯英文数字`);
      }
    }
    if (listenHost !== '127.0.0.1') warn.push(`正在监听 ${listenHost}，请确认前面有 TLS 和反向代理`);
    if (INDEXABLE) console.log('  已开放搜索引擎与生成式引擎收录（VEND_INDEXABLE=0 可关闭）');
    if (!TRUST_PROXY) {
      warn.push('VEND_TRUST_PROXY 未配置 → 挂在反代/隧道后面时所有买家共用一个 IP，防爆破限速会被迫退化。挂公网前请设为 1');
    }
    if (warn.length) console.log(`  ⚠ ${warn.join('\n  ⚠ ')}\n`);
  }

  return { server, store, port: actualPort, close: () => new Promise((done) => { store.close(); server.close(done); }) };
}

// 直接 node server/vend-server.js 时才自启动；被测试 import 时不启动。
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  startVendServer().catch((error) => {
    console.error('取号服务启动失败：', error);
    process.exit(1);
  });
}
