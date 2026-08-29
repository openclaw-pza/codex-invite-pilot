// server.js — 零依赖 HTTP 服务：静态资源 + JSON API
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import { config } from './config.js';
import { routes } from './routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const EXTENSION_API_PATHS = new Set([
  '/api/config',
  '/api/email/create',
  '/api/email/mails',
  '/api/sms/balance',
  '/api/sms/number',
  '/api/sms/status',
  '/api/sms/finish',
  '/api/sms/cancel',
  '/api/codex/device/start',
  '/api/codex/device/status',
  '/api/codex/device/cancel',
]);

function extensionCorsHeaders(req, pathname) {
  const origin = String(req.headers.origin || '');
  if (!EXTENSION_API_PATHS.has(pathname) || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin',
  };
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? '/index.html' : pathname;
  // 防目录穿越：规整后必须仍在 PUBLIC_DIR 内
  const filePath = normalize(join(PUBLIC_DIR, relative));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: '禁止访问' });
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: '资源不存在' });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    const corsHeaders = extensionCorsHeaders(req, pathname);
    if (req.method === 'OPTIONS') {
      if (!Object.keys(corsHeaders).length) {
        sendJson(res, 403, { error: '不允许此跨域来源' });
        return;
      }
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }
    const route = routes.find((item) => item.method === req.method && item.path === pathname);
    if (!route) {
      sendJson(res, 404, { error: `未知接口 ${req.method} ${pathname}` }, corsHeaders);
      return;
    }
    try {
      const body = req.method === 'GET' ? {} : await readBody(req);
      const query = Object.fromEntries(url.searchParams.entries());
      const data = await route.handler({ body, query });
      sendJson(res, 200, { ok: true, data }, corsHeaders);
    } catch (error) {
      // 面向 UI 的友好错误；详情打到服务端日志
      console.error(`[API ${pathname}]`, error);
      sendJson(res, 400, { ok: false, error: error?.message || '服务器内部错误' }, corsHeaders);
    }
    return;
  }

  if (req.method === 'GET') {
    await serveStatic(req, res, pathname);
    return;
  }
  sendJson(res, 405, { error: '方法不被允许' });
});

// 管理接口可以修改本地密钥，因此必须只监听本机回环地址。
server.listen(config.port, '127.0.0.1', () => {
  console.log(`\n  mail-sms-pilot 已启动`);
  console.log(`  → http://localhost:${config.port}\n`);
  const warn = [];
  if (!config.mail.adminAuth) warn.push('MAIL_ADMIN_AUTH');
  if (!config.mail.domain) warn.push('MAIL_DOMAIN');
  if (!config.heroSms.apiKey) warn.push('HERO_SMS_API_KEY');
  if (warn.length) console.log(`  ⚠ 尚未配置：${warn.join(', ')}（复制 .env.example 为 .env 填写）\n`);
});
