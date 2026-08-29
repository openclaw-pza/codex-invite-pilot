import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 令牌路径要在 import 之前定好：模块在加载时就读它。
const dir = mkdtempSync(join(tmpdir(), 'outlook-test-'));
process.env.OUTLOOK_TOKEN_PATH = join(dir, 'token.json');
writeFileSync(process.env.OUTLOOK_TOKEN_PATH, JSON.stringify({ clientId: 'test-client', refreshToken: 'r1' }));

const { htmlToText, normalizeGraphMail, listMails } = await import('../server/outlookMail.js');

function graphMail(overrides = {}) {
  return {
    id: 'AAMk-1',
    subject: 'You are invited',
    from: { emailAddress: { address: 'noreply@codex.chatgpt.com' } },
    toRecipients: [{ emailAddress: { address: 'buyer@outlook.com' } }],
    receivedDateTime: '2026-08-25T06:00:00Z',
    body: { contentType: 'html', content: '<p>Join here: <a href="https://chatgpt.com/invite/ABC123">Accept invite</a></p>' },
    ...overrides,
  };
}

test('微软来的邀请信被认成 invite，且链接抽得出来', () => {
  const mail = normalizeGraphMail(graphMail());
  assert.equal(mail.kind, 'invite');
  assert.equal(mail.inviteUrl, 'https://chatgpt.com/invite/ABC123');
  assert.equal(mail.from, 'noreply@codex.chatgpt.com');
  assert.equal(mail.address, 'buyer@outlook.com');
});

test('验证码信被认成 otp，且码抽得出来', () => {
  const mail = normalizeGraphMail(graphMail({
    subject: 'Your ChatGPT code is 481902',
    from: { emailAddress: { address: 'noreply@tm.openai.com' } },
    body: { contentType: 'html', content: '<div>Your code: <b>481902</b></div>' },
  }));
  assert.equal(mail.kind, 'otp');
  assert.equal(mail.code, '481902');
});

test('HTML 转纯文本：标签清掉、实体还原、换行保住', () => {
  const text = htmlToText('<style>x{}</style><p>Hello&nbsp;&amp;&nbsp;bye</p><br><div>Line2</div>');
  assert.match(text, /Hello & bye/);
  assert.match(text, /Line2/);
  assert.doesNotMatch(text, /</);
});

// 「整批查不到 = 故障，不得当作没有数据」——这条硬规则在收信层的落点。
test('收件箱读不到要抛错，绝不塌成「没有邮件」', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('oauth2')) {
      return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
    }
    return new Response('boom', { status: 500 });
  };
  try {
    await assert.rejects(() => listMails({ limit: 5 }), /Graph .*失败/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('垃圾箱读不到只降级，不拖垮收件箱', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('oauth2')) {
      return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
    }
    if (target.includes('junkemail')) return new Response('nope', { status: 500 });
    return new Response(JSON.stringify({ value: [graphMail()] }), { status: 200 });
  };
  try {
    const { mails } = await listMails({ limit: 5 });
    assert.equal(mails.length, 1);
    assert.equal(mails[0].kind, 'invite');
  } finally {
    globalThis.fetch = realFetch;
  }
});
