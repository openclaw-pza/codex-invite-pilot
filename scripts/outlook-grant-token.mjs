#!/usr/bin/env node
// 手动给某个微软账号拿 refresh_token。正常流程里不需要跑它 ——
// Graph 臂发现没 token 会自动走同一套逻辑（server/outlookGrant.js）。
// 留着是为了单独排查授权环节，不用把整条链路跑一遍。
//
// 用法：WEBMAIL_USER=x@outlook.com WEBMAIL_PASS=xx node scripts/outlook-grant-token.mjs
import { grantRefreshToken } from '../server/outlookGrant.js';

if (!process.env.WEBMAIL_USER || !process.env.WEBMAIL_PASS) {
  console.error('缺少 WEBMAIL_USER / WEBMAIL_PASS');
  process.exit(2);
}
try {
  const result = await grantRefreshToken();
  console.log(result.path);
  process.exit(0);
} catch (error) {
  console.error(`❌ ${error.message}`);
  process.exit(1);
}
