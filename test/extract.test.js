import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCode, extractLinks } from '../server/extract.js';
import { parseMail } from '../server/mime.js';

test('从 quoted-printable 邀请邮件抽取链接', () => {
  const raw = [
    'From: ChatGPT <noreply@codex.chatgpt.com>',
    'Subject: =?UTF-8?B?5L2g5bey5Y+X6YKA5L2/55SoIENoYXRHUFQ=?=',
    'To: user@example.com',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '<a href=3D"https://chatgpt.com/invite/abc?x=3D1&amp;y=3D2">=E6=8E=A5=E5=8F=97=E9=82=80=E8=AF=B7</a>',
  ].join('\r\n');
  const parsed = parseMail(raw);
  assert.match(parsed.subject, /ChatGPT/);
  assert.equal(parsed.to, 'user@example.com');
  assert.deepEqual(extractLinks(parsed.html), ['https://chatgpt.com/invite/abc?x=1&y=2']);
});

test('验证码优先提示词并排除年份', () => {
  assert.equal(extractCode('© 2026 Your temporary verification code is 137635'), '137635');
  assert.equal(extractCode('© 2026'), '');
});

// 下面这两组是 2026-08-21 排查「临时邮箱的码要能点一下复制」时，
// 拿 11 组真实邮件正文实测出来的缺口 —— 不是「认得不准」而是「完全抽不到」：
// 码就明晃晃摆在正文里，页面却不给框出来，买家只能自己从灰色小字里抠。
test('分段验证码：分隔符和逐位标签都要能还原', () => {
  // 平台为了好念主动分组
  assert.equal(extractCode('Your verification code: 129-482'), '129482');
  assert.equal(extractCode('验证码：129-482，请尽快使用'), '129482');
  // 邮件把每位数字单独包一层标签防抓取，stripHtml 换成空格后变成散开的单数字
  assert.equal(extractCode('Your code is 5 8 3 0 1 4'), '583014');
  // 提示词在数字后面的写法，HINT 抓不到，走无提示词的六位兜底
  assert.equal(extractCode('5 8 3 0 1 4 is your Telegram code'), '583014');
});

test('不能把日期、电话、长号当验证码', () => {
  // 提示词后面跟的是年份/日期，直接返回就会把 2026 摆进金色胶囊里，
  // 买家照着填必然失败 —— 空胶囊只是少个便利，填错码是白烧一次取号
  assert.equal(extractCode('Your code expires on 2026-08-22'), '');
  // 但同一封信里真的有码时，不能被前面的年份挡住
  assert.equal(extractCode('This code was sent in 2026. Your OTP is 442190'), '442190');
  assert.equal(extractCode('Call us at 400 820 8820 for help'), '');
  assert.equal(extractCode('Order 12345678901234 shipped'), '');
  assert.equal(extractCode('Codex helps you write software'), '');
});
