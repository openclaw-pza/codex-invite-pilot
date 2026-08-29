// vend-phone-split.test.js — 号码拆「区号 + 本地号码」的回归测试
//
// 背景：安哥实测泰国号在页面上显示成 66840618145 —— 没有 +、也没拆开。
// 两个原因叠在一起：
//   1. 上游返回的 phone 本来就不带 +，而前端要求以 "+区号" 开头才肯拆
//   2. 更要命的是前端在**按下单时选的国家推区号**，而不是解析号码本身。
//      上一版就是这么错的：正则贪婪匹配把 +6391 当成菲律宾区号（真实是 +63）。
//
// 现在区号一律由服务端解析真号码得出。买家会照着这个区号去填注册页，
// 切错一位就是白烧一次取号，所以这条必须有测试守着。

import test from 'node:test';
import assert from 'node:assert/strict';
import { splitPhone } from '../server/vend-routes.js';

test('区号从号码本身解析，不带 + 也要能拆', () => {
  // 上游的真实形态：不带 +
  assert.deepEqual(splitPhone('66840618145'), { dialCode: '66', nationalNumber: '840618145' });
  // 带 + 的也要一样
  assert.deepEqual(splitPhone('+66840618145'), { dialCode: '66', nationalNumber: '840618145' });
});

test('区号长度 1~4 位都要对，不能靠猜', () => {
  // 1 位：美国。曾经的贪婪正则会把前 1~4 位随便当区号
  assert.deepEqual(splitPhone('12025551234'), { dialCode: '1', nationalNumber: '2025551234' });
  // 2 位：菲律宾 +63 —— 上一版被切成 +6391，买家照着填必然收不到码
  assert.deepEqual(splitPhone('639123456789'), { dialCode: '63', nationalNumber: '9123456789' });
  assert.deepEqual(splitPhone('8613800138000'), { dialCode: '86', nationalNumber: '13800138000' });
  assert.deepEqual(splitPhone('447700900123'), { dialCode: '44', nationalNumber: '7700900123' });
  // 3 位：香港 +852
  assert.deepEqual(splitPhone('85251234567'), { dialCode: '852', nationalNumber: '51234567' });
});

test('拆不出来就返回空，绝不返回半个号码', () => {
  // 前端拿到空的区号会整串显示 —— 少个便利没关系，切错号码是白烧一次取号
  for (const bad of ['', null, undefined, '   ', 'abc', '12']) {
    assert.deepEqual(splitPhone(bad), { dialCode: '', nationalNumber: '' }, `${bad} 不该拆出东西`);
  }
});
