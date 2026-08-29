// hero-extract.test.js — 短信验证码抽取（卖钱那条路）
//
// 这是买家拿码的最后一步。抽错一次的代价：卡当场作废 + 买家拿到一个错的码，
// 而一张卡只有一次成功收码的机会，没有第二次。
//
// 在此之前这里是**一行零测试的裸正则** `/\b(\d{4,8})\b/`：
// 短信里出现 "expires 2026" 就会返回 2026。
// 而同一个项目里，免费送的临时邮箱那条路（extract.js）早就有年份闸、
// 分段码、逐位拆开码三重防御，还有 11 组真实语料钉着。
// 收钱的那条反而裸奔 —— 这次补齐。
//
// 前两条用例是**生产库里真实存在的原文**（activations.sms_text），不是编的。

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCode } from '../server/heroSms.js';

test('生产库里的真实原文（上游多数只回码本身）', () => {
  assert.equal(extractCode('800203'), '800203');
  assert.equal(extractCode('618387'), '618387');
});

test('年份陷阱：这是原来那行正则会当场烧掉一张卡的地方', () => {
  // 原实现返回 '2026' → 前端显示 2026 给买家 → 同时 consume() 把卡作废
  assert.equal(extractCode('Your code expires 2026. Code: 472913'), '472913');
  assert.equal(extractCode('© 2026 OpenAI. Your verification code is 137635'), '137635');
  // 纯年份、没有真码时必须返回空，不能硬凑一个出来
  assert.equal(extractCode('Copyright 2026 OpenAI'), '');
});

test('提示词优先于位置', () => {
  assert.equal(extractCode('Your ChatGPT code is 583014'), '583014');
  assert.equal(extractCode('验证码：472913，请勿告诉他人'), '472913');
  // 提示词在后面的写法，走「第一个非年份数字」兜底
  assert.equal(extractCode('583014 is your Telegram code'), '583014');
});

test('分段码和逐位拆开的码', () => {
  // 平台为了好念主动分组
  assert.equal(extractCode('验证码：129-482，5分钟内有效'), '129482');
  // 逐位拆开（防抓取的常见写法）
  assert.equal(extractCode('Your code is 5 8 3 0 1 4'), '583014');
});

test('带前缀的码要抽对（Google 那种 G- 开头）', () => {
  assert.equal(extractCode('G-472913 is your Google verification code'), '472913');
});

test('抽不出来就返回空，绝不硬凑', () => {
  // 宁可让买家看原文，也不能给他一个错的码 —— 错码 = 白烧一次取号
  for (const bad of ['', null, undefined, '您好', '123']) {
    assert.equal(extractCode(bad), '', `${bad} 不该抽出东西`);
  }
});
