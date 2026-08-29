// codexTurnCli.js — 不碰桌面端 GUI，用官方 CLI 在被邀请账号上完成 codex_turn。
//
// 为什么绕开桌面端：ops-001 已经查明那条路的死因 —— Electron + Xvfb + CDP，
// 「调试端口通 ≠ 渲染进程画完」，点击必然落空；再叠加 DMIT-2 无 libsecret，
// 凭据只在内存，进程一重启登录态就没了，于是脚本连重启都不敢。
//
// 正解是官方支持的两件东西：
//   1) app-server 的 chatgptDeviceCode 登录（凭据落盘 ~/.codex/auth.json）
//   2) `codex exec` —— CLI 自带的非交互模式，一条命令跑一个 turn
// 设备码流程需要「第二台设备」去输码，而我们手上恰好有一个**已经登录了被邀请账号**
// 的浏览器 —— 它就是那第二台设备。于是整条链路无人工、无界面、无时序竞态。

import { spawn } from 'node:child_process';
import { classifyAccountError, VERDICTS } from './codexLiveness.js';

const EXEC_TIMEOUT_MS = 4 * 60 * 1000;

// 🔴 安全闸：必须显式给隔离的 CODEX_HOME。
//
// VPS 的默认 ~/.codex 里躺着**安哥自己的** Codex 登录态。不设隔离就跑 codex exec，
// 消息会发在他自己账号上：奖励一分不入账（受邀者没说话），还白白污染主账号。
// 这种错误不会报错、日志看着一切正常，所以只能在入口处物理拦掉。
export function assertIsolatedCodexHome(codexHome) {
  const value = String(codexHome || '').trim();
  if (!value) throw new Error('codex exec 必须显式指定隔离的 CODEX_HOME，禁止回落到默认账号');
  if (/(^|[\/])\.codex[\/]?$/.test(value)) {
    throw new Error(`拒绝使用默认 Codex 账号目录：${value}。这会把消息发到主账号上`);
  }
  return value;
}

// 从 codex exec 的产物判断这一轮到底成没成。
//
// 判据卡在产物上而不是退出码：CLI 可能 exit 0 但什么都没说
// （限流、会话没建起来），那时候报「成功」就是对一个没入账的号说它成了。
// codex exec 的输出头格式，来自 2026-08-25 在 DMIT-2 上的真实运行，不是照文档猜的。
// 这些行永远存在，跟模型说没说话无关，必须先剔掉再判断「它到底回没回」。
const NOISE_LINE = new RegExp([
  '^-{3,}$',                                   // 分隔线
  '^OpenAI Codex v',
  '^Reading additional input',
  '^(workdir|model|provider|approval|sandbox|session id|reasoning [a-z ]+|tokens used):',
  '^(user|codex|thinking)$',                   // 角色标记单独占一行
  '^(WARNING|warning|ERROR|error):',
  '^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+(ERROR|WARN|INFO)',  // 带时间戳的日志行
].join('|'));

export function parseExecOutcome({ code, stdout = '', stderr = '', prompt = '' } = {}) {
  const merged = `${stdout}\n${stderr}`;
  const verdict = classifyAccountError({ message: merged });
  if (verdict === VERDICTS.DEACTIVATED) {
    return { ok: false, verdict, reason: '账号已被停用（A1 那条阻塞级问题的现场）' };
  }
  if (verdict === VERDICTS.TOKEN_INVALIDATED) {
    return { ok: false, verdict, reason: '服务端已作废 token，需要重新登录' };
  }
  // 实测：没有登录态时它**不会**说「not logged in」，而是对
  // wss://api.openai.com/v1/responses 报 401 Unauthorized 然后 Reconnecting 5 次，退出码 101。
  // 只匹配「未登录」字样的话，这种最常见的失败会落进含糊的兜底里。
  if (/not logged in|请先登录|run `?codex login/i.test(merged)
    || (/401 Unauthorized/i.test(merged) && /responses_websocket|api\.openai\.com/i.test(merged))) {
    return { ok: false, verdict: VERDICTS.NO_ACCOUNT, reason: '该 CODEX_HOME 没有有效登录态（实测表现为 401 + 反复重连）' };
  }
  if (code !== 0) {
    return { ok: false, verdict, reason: `codex exec 退出码 ${code}：${merged.trim().slice(0, 200) || '无输出'}` };
  }
  // 模型真的说了话才算数。空输出的 exit 0 一律不认。
  // 回声要剔掉：codex exec 会把我们发的 prompt 原样打一遍（`user` 行下面那行）。
  // 不剔的话，一个什么都没回的空轮次也会因为「看到了自己的问题」而被判成成功。
  const echo = String(prompt || '').trim();
  const meaningful = String(stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !NOISE_LINE.test(line) && (!echo || line !== echo));
  if (!meaningful.length) {
    return { ok: false, verdict: VERDICTS.UNKNOWN, reason: 'codex exec 退出码为 0 但没有任何模型输出，不能按入账算' };
  }
  return { ok: true, verdict: VERDICTS.HEALTHY, reply: meaningful.join('\n').slice(0, 500) };
}

export function runCodexExec({ codexHome, prompt, bin = 'codex', timeoutMs = EXEC_TIMEOUT_MS } = {}) {
  const home = assertIsolatedCodexHome(codexHome);
  return new Promise((resolve) => {
    // --skip-git-repo-check：VPS 上的工作目录不是 git 仓库，不跳过会直接拒绝启动。
    const child = spawn(bin, ['exec', '--skip-git-repo-check', String(prompt)], {
      env: { ...process.env, CODEX_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ ok: false, verdict: VERDICTS.TRANSIENT, reason: `codex exec 超过 ${Math.round(timeoutMs / 1000)} 秒没返回` });
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, verdict: VERDICTS.UNKNOWN, reason: `启动 codex 失败：${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ...parseExecOutcome({ code, stdout, stderr, prompt }), stdout, stderr });
    });
  });
}
