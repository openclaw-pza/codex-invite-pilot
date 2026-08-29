// smtpMail.js — 最小 SMTP 发信客户端（隐式 TLS，端口 465）
//
// 为什么不装 nodemailer：这里只有一个用途 —— 买家提交意见时给卖家自己的
// QQ 邮箱发一封信。自发自收、固定一个收件人、纯文本、没有附件。
// 为这点事拉一个几十个传递依赖的库，换来的是升级面和供应链面各多一块。
// 隐式 TLS 的 SMTP 握手就是「连上 → EHLO → AUTH LOGIN → MAIL/RCPT/DATA」，
// 用 node:tls 直接写清楚，比包一层库更好排错。
//
// 收发都用同一个 QQ 邮箱是刻意的：QQ 内部投递 100% 进收件箱。
// 换成自有域名发信会被 QQ 当陌生域名过滤（.xyz + 没配 DMARC），
// 告警进垃圾箱等于没有告警。判据见 vault 30-Library/QQ邮箱SMTP告警通道配置.md。

import tls from 'node:tls';

const CRLF = '\r\n';

// SMTP 头部注入：正文里的 \r\n 是合法的，但**头部字段**里不是 ——
// 一个换行就能让攻击者塞进额外的收件人，把这个接口变成群发跳板。
// 头部值一律先把 CR/LF 抹掉。
function headerSafe(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

// 非 ASCII 的主题必须按 RFC 2047 编码，否则中文标题在客户端里是乱码
function encodeHeaderWord(text) {
  const safe = headerSafe(text);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(safe)) return safe;
  return `=?UTF-8?B?${Buffer.from(safe, 'utf8').toString('base64')}?=`;
}

// 正文里单独一行的 "." 会被当成数据结束符 —— 必须按 RFC 5321 做点填充，
// 不然买家写一行 "." 就能把信截断（或者让整封信发不出去）。
function dotStuff(body) {
  return String(body ?? '').replace(/\r?\n/g, CRLF).replace(/^\./gm, '..');
}

function isPositive(line) {
  return /^[23]/.test(line);
}

/**
 * 发一封纯文本邮件。失败抛错，调用方自己决定要不要吞。
 * 全程有超时：SMTP 卡住不返回是常见故障，没有超时会把请求挂死。
 */
export function sendMail({
  host, port = 465, user, pass, from = user, to,
  subject, text, timeoutMs = 15_000,
}) {
  if (!host || !user || !pass || !to) {
    return Promise.reject(new Error('SMTP 配置不完整（host/user/pass/to 缺一不可）'));
  }

  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host });
    let buffer = '';
    let done = false;
    const queue = [];

    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* 已经断了 */ }
      if (error) reject(error); else resolve(true);
    };

    const timer = setTimeout(() => finish(new Error(`SMTP 超时（${timeoutMs}ms）`)), timeoutMs);

    // 一问一答：把「发一行、等一个响应」串成队列，比层层回调好读也好改
    const steps = [
      { send: `EHLO ${headerSafe(from).split('@')[1] || host}` },
      { send: 'AUTH LOGIN' },
      { send: Buffer.from(user, 'utf8').toString('base64') },
      { send: Buffer.from(pass, 'utf8').toString('base64') },
      { send: `MAIL FROM:<${headerSafe(from)}>` },
      { send: `RCPT TO:<${headerSafe(to)}>` },
      { send: 'DATA' },
      {
        send: [
          `From: ${encodeHeaderWord('验证码取号')} <${headerSafe(from)}>`,
          `To: <${headerSafe(to)}>`,
          `Subject: ${encodeHeaderWord(subject)}`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=UTF-8',
          'Content-Transfer-Encoding: 8bit',
          '',
          dotStuff(text),
          '.',
        ].join(CRLF),
      },
      { send: 'QUIT', last: true },
    ];
    queue.push(...steps);

    let waitingGreeting = true;

    const next = () => {
      const step = queue.shift();
      if (!step) return finish(null);
      socket.write(step.send + CRLF);
      if (step.last) finish(null);
    };

    socket.setEncoding('utf8');
    socket.on('error', (error) => finish(error));
    socket.on('close', () => {
      if (!done) finish(new Error('SMTP 连接被对方关闭'));
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      // 多行响应形如 "250-XXX"，最后一行是 "250 XXX"（第 4 个字符是空格）
      let idx = buffer.lastIndexOf(CRLF);
      if (idx === -1) return;
      const lines = buffer.slice(0, idx).split(CRLF);
      const last = lines[lines.length - 1];
      if (!/^\d{3} /.test(last)) return;
      buffer = buffer.slice(idx + CRLF.length);

      if (!isPositive(last)) {
        // 不要把服务器原文直接外泄给买家 —— 里面可能带账号信息。
        // 这条只进服务端日志，接口那边统一回一句人话。
        return finish(new Error(`SMTP 拒绝：${last.slice(0, 120)}`));
      }
      if (waitingGreeting) { waitingGreeting = false; return next(); }
      next();
    });
  });
}

// 从环境变量读配置。没配齐就返回 null —— 调用方据此判断「这个功能没开」，
// 而不是拿着半套配置去连接然后每次都超时。
export function smtpConfigFromEnv(env = process.env) {
  const host = env.FEEDBACK_SMTP_HOST || 'smtp.qq.com';
  const port = Number(env.FEEDBACK_SMTP_PORT || 465);
  const user = env.FEEDBACK_SMTP_USER || '';
  const pass = env.FEEDBACK_SMTP_PASS || '';
  const to = env.FEEDBACK_TO || user;
  if (!user || !pass || !to) return null;
  return { host, port, user, pass, to };
}
