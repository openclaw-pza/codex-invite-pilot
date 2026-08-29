#!/usr/bin/env node
// 本机单账号协议探针。只做两件事：
//   1) 走官方 app-server 的 chatgptDeviceCode，把 verificationUrl / userCode 打出来
//   2) 登录完成后用 account/read + account/rateLimits/read 探活（禁止信 codex login status）
//
// 不打开浏览器、不填表、不取号、不批量。设备码由你自己在浏览器里输。
//
// 用法：
//   node scripts/codex-device-probe.mjs --address you@example.com
//   node scripts/codex-device-probe.mjs --address you@example.com --probe-only

import {
  cancelCodexDeviceAuth,
  codexDeviceAuthStatus,
  probeCodexAccount,
  startCodexDeviceAuth,
} from '../server/codexDeviceAuth.js';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return String(process.argv[index + 1] || '').trim();
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const address = arg('--address');
  const probeOnly = hasFlag('--probe-only');
  if (!address) {
    console.error('缺少 --address you@example.com');
    process.exit(2);
  }

  if (probeOnly) {
    const health = await probeCodexAccount({ address });
    console.log(JSON.stringify(health, null, 2));
    process.exit(health.healthy ? 0 : 1);
  }

  const session = await startCodexDeviceAuth({
    address,
    loginType: 'chatgptDeviceCode',
  });
  console.log(JSON.stringify({
    id: session.id,
    state: session.state,
    verificationUrl: session.verificationUrl,
    userCode: session.userCode,
    message: session.message,
  }, null, 2));
  console.log('\n在浏览器打开 verificationUrl，输入 userCode，同意后回到这里等待。Ctrl+C 取消。\n');

  const onAbort = async () => {
    await cancelCodexDeviceAuth({ id: session.id }).catch(() => {});
    process.exit(130);
  };
  process.on('SIGINT', onAbort);
  process.on('SIGTERM', onAbort);

  for (;;) {
    const current = codexDeviceAuthStatus(session.id);
    if (!current) {
      console.error('会话已消失');
      process.exit(1);
    }
    if (current.state === 'succeeded') {
      console.log(`登录完成：${current.message}`);
      const health = await probeCodexAccount({ address });
      console.log(JSON.stringify(health, null, 2));
      process.exit(health.healthy ? 0 : 1);
    }
    if (current.state === 'failed' || current.state === 'cancelled') {
      console.error(`${current.state}: ${current.message}`);
      process.exit(1);
    }
    await sleep(2000);
  }
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
