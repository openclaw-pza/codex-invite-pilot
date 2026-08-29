import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePop3Mail } from '../server/pop3Mail.js';

const CRLF = '\r\n';
function raw(headers, body) {
  return headers.join(CRLF) + CRLF + CRLF + body;
}

test('POP3 原文解析出的字段与其他邮箱来源同构', () => {
  const mail = parsePop3Mail(raw([
    'Message-ID: <abc@openai.com>',
    'From: OpenAI <noreply@codex.chatgpt.com>',
    'To: buyer@outlook.com',
    'Subject: You are invited',
    'Date: Mon, 25 Aug 2026 06:00:00 +0000',
  ], '<p>Accept: https://chatgpt.com/invite/ABC123</p>'), 1);
  assert.equal(mail.kind, 'invite');
  assert.equal(mail.inviteUrl, 'https://chatgpt.com/invite/ABC123');
  assert.equal(mail.from, 'OpenAI <noreply@codex.chatgpt.com>');
  assert.equal(mail.receivedAt, '2026-08-25T06:00:00.000Z');
});

test('验证码信抽得出码', () => {
  const mail = parsePop3Mail(raw([
    'From: noreply@tm.openai.com',
    'Subject: Your code is 481902',
    'Date: Mon, 25 Aug 2026 06:01:00 +0000',
  ], 'Your code: 481902'), 2);
  assert.equal(mail.kind, 'otp');
  assert.equal(mail.code, '481902');
});

// 头部折行是 RFC822 的常规写法：长 Subject 会被拆成多行、续行以空白开头。
// 不接回去就会被截断，白名单和抽码跟着一起错。
test('折行的长主题要接回完整一行', () => {
  const mail = parsePop3Mail(raw([
    'From: noreply@tm.openai.com',
    'Subject: Your ChatGPT verification',
    ' code is 771203 please use it',
    'Date: Mon, 25 Aug 2026 06:02:00 +0000',
  ], 'body'), 3);
  assert.match(mail.subject, /verification code is 771203/);
  assert.equal(mail.code, '771203');
});

test('RFC2047 编码主题要解码，不能留乱码', () => {
  // =?UTF-8?B?...?= 是 base64 的「你的验证码」
  const encoded = `=?UTF-8?B?${Buffer.from('你的验证码', 'utf8').toString('base64')}?= 445566`;
  const mail = parsePop3Mail(raw([
    'From: noreply@tm.openai.com',
    `Subject: ${encoded}`,
    'Date: Mon, 25 Aug 2026 06:03:00 +0000',
  ], 'body'), 4);
  assert.match(mail.subject, /你的验证码/);
  assert.equal(mail.code, '445566');
});

test('Date 头缺失或畸形时给空串，不编一个假时间', () => {
  const mail = parsePop3Mail(raw([
    'From: noreply@tm.openai.com',
    'Subject: hi',
  ], 'body'), 5);
  assert.equal(mail.receivedAt, '');
});
