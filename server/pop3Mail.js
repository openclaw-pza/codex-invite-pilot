// pop3Mail.js — 用账号密码从 Outlook 收信（POP3 over TLS）。
//
// 为什么是 POP3 而不是 IMAP：2026-08-25 在 DMIT-2 上实测两个协议的能力串：
//   IMAP  outlook.office365.com:993 → AUTH=XOAUTH2 **LOGINDISABLED**   （密码被禁）
//   POP3  pop-mail.outlook.com:995  → SASL PLAIN XOAUTH2 / **USER**    （密码还在）
// 微软关掉了 IMAP 的基本认证，但 POP3 仍然广告 USER/PASS。
// 这条路的好处是**不需要 Azure 应用注册、不需要任何一次性同意**，给账号密码就能跑。
//
// ⚠️ POP3 的两个固有限制，必须知道：
//   1) 只能看**收件箱**，看不到垃圾箱。OpenAI 的信被判垃圾就彻底读不到。
//   2) 账号里要先打开 POP 访问（outlook.com → 设置 → 邮件 → 同步电子邮件 → POP 选项）。
//
// 协议本身是行分隔的纯文本，所以零依赖，直接用 node:tls。

import { connect } from 'node:tls';
import { extractCode, extractLinks } from './extract.js';
import { classifyMail, pickInviteUrl } from './mailKind.js';

const HOST = process.env.POP3_HOST || 'pop-mail.outlook.com';
const PORT = Number(process.env.POP3_PORT || 995);
const PREVIEW_MAX = 4000;

// POP3 是一问一答的行协议。这个小客户端只做我们需要的四条命令。
function pop3Session({ host = HOST, port = PORT, user, pass, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, servername: host });
    socket.setTimeout(timeoutMs);
    let buffer = '';
    let pending = null;

    const fail = (error) => { try { socket.destroy(); } catch { /* 已经断了 */ } reject(error); };
    socket.on('timeout', () => fail(new Error(`POP3 ${host}:${port} 超时`)));
    socket.on('error', (error) => fail(error));

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (!pending) return;
      if (pending.multiline) {
        // 多行响应以单独一行的 "." 结束
        if (!/^[+-]/.test(buffer)) return;
        if (buffer.startsWith('-ERR')) { const p = pending; pending = null; buffer = ''; p.reject(new Error(firstLine(buffer))); return; }
        if (!/\r\n\.\r\n$/.test(buffer)) return;
      } else if (!/\r\n$/.test(buffer)) return;

      const text = buffer;
      buffer = '';
      const p = pending;
      pending = null;
      if (text.startsWith('-ERR')) p.reject(new Error(text.split('\r\n')[0]));
      else p.resolve(text);
    });

    function firstLine(text) { return String(text).split('\r\n')[0]; }

    function send(command, multiline = false) {
      return new Promise((res, rej) => {
        pending = { resolve: res, reject: rej, multiline };
        socket.write(`${command}\r\n`);
      });
    }

    // 服务器欢迎行
    pending = {
      multiline: false,
      resolve: () => resolve({
        send,
        quit: async () => { try { await send('QUIT'); } catch { /* 关就完事 */ } socket.end(); },
      }),
      reject,
    };
  });
}

// 把一封 RFC822 原文压成跟 cloudflareEmail / outlookMail 完全同构的形状。
// 字段名一个都不能改：下游 automationMatch / mailKind 全按这套取值。
export function parsePop3Mail(raw, index) {
  const text = String(raw || '');
  const split = text.indexOf('\r\n\r\n');
  const head = split === -1 ? text : text.slice(0, split);
  const body = split === -1 ? '' : text.slice(split + 4);
  // 头部折行（下一行以空白开头）要先接回去，否则长 Subject 会被截断
  const unfolded = head.replace(/\r\n[ \t]+/g, ' ');
  const header = (name) => (new RegExp(`^${name}:\s*(.+)$`, 'im').exec(unfolded)?.[1] || '').trim();
  const subject = decodeHeader(header('Subject'));
  const from = header('From');
  const mail = {
    id: String(header('Message-ID') || `pop-${index}`),
    address: header('To'),
    subject,
    from,
    receivedAt: normalizeDate(header('Date')),
    body: body.slice(0, PREVIEW_MAX),
    code: extractCode(`${subject}\n${body}`),
    links: extractLinks(body),
  };
  const kind = classifyMail(mail);
  return { ...mail, kind, inviteUrl: kind === 'invite' ? pickInviteUrl(mail.links) : null };
}

// RFC2047 编码头（=?UTF-8?B?...?=）。OpenAI 的主题基本是纯 ASCII，
// 但中文/带 emoji 的主题不解就会变成乱码，白名单判断跟着一起错。
function decodeHeader(value) {
  return String(value || '').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (all, charset, enc, data) => {
    try {
      if (/b/i.test(enc)) return Buffer.from(data, 'base64').toString('utf8');
      return Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))), 'binary').toString('utf8');
    } catch { return all; }
  });
}

function normalizeDate(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

/**
 * 与 cloudflareEmail.listMails / outlookMail.listMails 同名同形。
 *
 * POP3 没有"按收件人过滤"这回事（整个信箱就是一个账号的），所以 address 参数
 * 只用来做一次宽松校验；真正的过滤靠 mailKind 的发件人白名单。
 */
export async function listMails({ limit = 20 } = {}) {
  const user = String(process.env.POP3_USER || '').trim();
  const pass = String(process.env.POP3_PASS || '');
  if (!user || !pass) throw new Error('缺少 POP3_USER / POP3_PASS');

  const session = await pop3Session({ user, pass });
  try {
    await session.send(`USER ${user}`);
    await session.send(`PASS ${pass}`);
    const stat = await session.send('STAT');           // +OK <数量> <字节>
    const total = Number(stat.split(/\s+/)[1] || 0);
    if (!total) return { mails: [] };
    const want = Math.min(Math.max(Number(limit) || 20, 1), 30);
    const mails = [];
    // 从最新一封往回取。POP3 的序号是 1..total，最新在最后。
    for (let n = total; n > Math.max(total - want, 0); n -= 1) {
      const raw = await session.send(`RETR ${n}`, true);
      // 去掉 "+OK ..." 首行和结尾的 ".\r\n"
      const bodyStart = raw.indexOf('\r\n') + 2;
      const content = raw.slice(bodyStart).replace(/\r\n\.\r\n$/, '');
      mails.push(parsePop3Mail(content, n));
    }
    return { mails };
  } finally {
    await session.quit();
  }
}

// 只验连通和认证，不取信 —— 给哨兵用。
export async function checkPop3Login() {
  const user = String(process.env.POP3_USER || '').trim();
  const pass = String(process.env.POP3_PASS || '');
  if (!user || !pass) throw new Error('缺少 POP3_USER / POP3_PASS');
  const session = await pop3Session({ user, pass });
  try {
    await session.send(`USER ${user}`);
    await session.send(`PASS ${pass}`);
    const stat = await session.send('STAT');
    return { ok: true, total: Number(stat.split(/\s+/)[1] || 0) };
  } finally {
    await session.quit();
  }
}
