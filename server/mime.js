// mime.js — 最小 MIME 解析：把原始邮件 raw 解码成可读 subject / from / 正文 / HTML
// 端口自 FlowPilot cloudflare-temp-email-utils 的解析逻辑，跑在 Node（Buffer / TextDecoder 均可用）。

function base64ToBytes(value = '') {
  const normalized = String(value || '').replace(/\s+/g, '');
  if (!normalized) return new Uint8Array();
  return Uint8Array.from(Buffer.from(normalized, 'base64'));
}

function quotedPrintableToBytes(value = '', { headerMode = false } = {}) {
  let source = String(value || '').replace(/=\r?\n/g, '');
  if (headerMode) source = source.replace(/_/g, ' ');
  const bytes = [];
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(source.slice(i + 1, i + 3))) {
      bytes.push(parseInt(source.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    bytes.push(char.charCodeAt(0));
  }
  return Uint8Array.from(bytes);
}

function decodeBytes(bytes, charset = 'utf-8') {
  const normalized = String(charset || 'utf-8').trim().toLowerCase();
  const candidates = [normalized];
  if (normalized === 'utf8') candidates.unshift('utf-8');
  if (normalized === 'gb2312' || normalized === 'gbk') candidates.unshift('gb18030');
  for (const candidate of candidates) {
    try {
      return new TextDecoder(candidate, { fatal: false }).decode(bytes);
    } catch {
      /* try next */
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// 解码邮件头里的 =?utf-8?B?...?= / =?utf-8?Q?...?=
export function decodeEncodedWords(value = '') {
  return String(value || '').replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]+)\?=/g,
    (_m, charset, encoding, text) => {
      try {
        if (encoding.toUpperCase() === 'B') return decodeBytes(base64ToBytes(text), charset);
        return decodeBytes(quotedPrintableToBytes(text.replace(/_/g, ' '), { headerMode: true }), charset);
      } catch {
        return text;
      }
    },
  );
}

function charsetOf(contentType = '') {
  return contentType.match(/charset="?([^";]+)"?/i)?.[1]?.trim() || 'utf-8';
}

function boundaryOf(contentType = '') {
  return contentType.match(/boundary="?([^";]+)"?/i)?.[1] || '';
}

function decodeHtmlEntity(value, radix) {
  const cp = parseInt(value, radix);
  return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ' ';
}

export function stripHtml(value = '') {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_m, c) => decodeHtmlEntity(c, 16))
    .replace(/&#(\d+);/g, (_m, c) => decodeHtmlEntity(c, 10))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function splitRaw(raw) {
  const text = String(raw || '');
  const idx = text.search(/\r?\n\r?\n/);
  if (idx === -1) return { headerText: text, bodyText: '' };
  const sepLen = text.slice(idx).match(/^\r?\n\r?\n/)[0].length;
  return { headerText: text.slice(0, idx), bodyText: text.slice(idx + sepLen) };
}

function parseHeaders(headerText) {
  const headers = {};
  // 合并折行（以空格/Tab 开头的续行）
  const unfolded = String(headerText || '').replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const m = line.match(/^([^:]+):\s?(.*)$/);
    if (m) headers[m[1].trim().toLowerCase()] = m[2];
  }
  return headers;
}

function decodeBody(bodyText, headers) {
  const contentType = String(headers['content-type'] || '');
  const encoding = String(headers['content-transfer-encoding'] || '').trim().toLowerCase();
  const charset = charsetOf(contentType);
  let decoded = String(bodyText || '');
  if (encoding === 'base64') decoded = decodeBytes(base64ToBytes(decoded), charset);
  else if (encoding === 'quoted-printable') decoded = decodeBytes(quotedPrintableToBytes(decoded), charset);
  return { contentType, decoded };
}

// 递归收集所有叶子正文段：{ contentType, decoded(未剥HTML) }
function collectLeaves(raw, depth, out) {
  if (depth > 6) return out;
  const { headerText, bodyText } = splitRaw(raw);
  const headers = parseHeaders(headerText);
  const contentType = String(headers['content-type'] || '');
  const boundary = boundaryOf(contentType);

  if (/multipart\//i.test(contentType) && boundary) {
    const marker = `--${boundary}`;
    const sections = String(bodyText || '')
      .split(marker)
      .map((part) => part.trim())
      .filter((part) => part && part !== '--');
    for (const section of sections) {
      collectLeaves(section.replace(/--\s*$/, '').trim(), depth + 1, out);
    }
    return out;
  }

  const { decoded } = decodeBody(bodyText, headers);
  if (decoded.trim()) out.push({ contentType, decoded });
  return out;
}

// 解析整封邮件 raw → { subject, from, date, text, html }
// text：剥过 HTML 的可读正文（抽验证码 / 预览用）
// html：解码但未剥 HTML 的内容（抽链接用，保留 href）
export function parseMail(raw) {
  const { headerText } = splitRaw(raw);
  const headers = parseHeaders(headerText);
  const leaves = collectLeaves(raw, 0, []);

  const htmlChunks = [];
  const textChunks = [];
  for (const leaf of leaves) {
    if (/text\/html/i.test(leaf.contentType)) {
      htmlChunks.push(leaf.decoded);
      textChunks.push(stripHtml(leaf.decoded));
    } else {
      textChunks.push(leaf.decoded.replace(/\s+/g, ' ').trim());
    }
  }

  return {
    subject: decodeEncodedWords(headers.subject || ''),
    from: decodeEncodedWords(headers.from || ''),
    to: decodeEncodedWords(headers['delivered-to'] || headers['x-original-to'] || headers.to || ''),
    date: headers.date || '',
    text: textChunks.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(),
    html: htmlChunks.join('\n'),
  };
}
