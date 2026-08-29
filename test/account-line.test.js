import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAccountLine } from '../server/accountLine.js';

const CID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';
const TOKEN = `M.C561_BAY.0.U.MsaArtifacts.${'x'.repeat(380)}$$`;

test('网页号：邮箱----密码', () => {
  const r = parseAccountLine('AbC@Outlook.com----lo023659');
  assert.deepEqual(r, { address: 'abc@outlook.com', password: 'lo023659' });
});

// 审计实测过的那个坑：老写法把空格也当分隔符，密码被砍成 'Pw'。
// 后果是登录失败、看着像号本身废了，然后被 markDead 白扔掉一个好号。
test('密码里有空格/竖线/逗号也不能被截断', () => {
  for (const pw of ['Pw 123', 'a|b', 'x,y', 'has\tTab']) {
    assert.equal(parseAccountLine(`a@o.com----${pw}`).password, pw, `密码被截断：${pw}`);
  }
});

test('Graph 令牌号：四段全部收下', () => {
  const r = parseAccountLine(`mqxjazc90287@outlook.com----nxuuyy375596----${CID}----${TOKEN}`);
  assert.equal(r.address, 'mqxjazc90287@outlook.com');
  assert.equal(r.password, 'nxuuyy375596');
  assert.equal(r.clientId, CID);
  assert.equal(r.refreshToken, TOKEN);
});

// 🔴 按位置认迟早把 token 存进 client_id：卖家换个字段顺序就中招，
// 而那种错是静默的 —— 只表现为"授权莫名其妙失败"。
test('字段顺序颠倒也要认对', () => {
  const r = parseAccountLine(`a@o.com----pw----${TOKEN}----${CID}`);
  assert.equal(r.clientId, CID);
  assert.equal(r.refreshToken, TOKEN);
});

test('只有密码时不能凭空造出 token 字段', () => {
  const r = parseAccountLine('a@o.com----pw');
  assert.equal('clientId' in r, false);
  assert.equal('refreshToken' in r, false);
});

test('短备注不会被当成 token', () => {
  const r = parseAccountLine('a@o.com----pw----2026年8月购买');
  assert.equal(r.password, 'pw');
  assert.equal(r.refreshToken, undefined);
});

test('空行 / 注释 / 没有邮箱的行一律返回 null', () => {
  for (const bad of ['', '   ', '# 注释', 'not-an-account', 'a@o.com', null, undefined]) {
    assert.equal(parseAccountLine(bad), null, `不该解析出东西：${bad}`);
  }
});

test('密码为空要判无效，不能入池', () => {
  assert.equal(parseAccountLine('a@o.com----'), null);
  assert.equal(parseAccountLine(`a@o.com--------${CID}`), null);
});
