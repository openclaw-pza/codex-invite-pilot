// codexDeviceAuth.js — 使用官方 Codex app-server，在邮箱隔离档案中管理 ChatGPT OAuth。
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileKey } from './automationMatch.js';
import { classifyAccountError, VERDICTS } from './codexLiveness.js';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_DIR = join(ROOT_DIR, 'data', 'codex-auth', 'profiles');
const SESSION_TIMEOUT_MS = 16 * 60 * 1000;
const ACTIVE_STATES = ['starting', 'waiting_browser', 'waiting_device_code'];
const LOGIN_TYPES = new Set(['chatgpt', 'chatgptDeviceCode']);

function resolveCodexBin() {
  const configured = String(process.env.CODEX_BIN || '').trim();
  if (configured && existsSync(configured)) return configured;
  const candidates = [
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
  ];
  // Linux 分支。整条链路的正式运行环境是 DMIT-2（Ubuntu），而原来这里只探
  // macOS 和 Windows 两种路径 —— 在 VPS 上必然返回空串，然后抛一句
  // 「Windows 请安装微软商店的 ChatGPT 桌面版」。在 Linux 服务器上看到这句话，
  // 排查方向会被直接带偏。实测 VPS 上是 /usr/bin/codex（npm 全局装的）。
  for (const dir of String(process.env.PATH || '').split(':')) {
    if (!dir) continue;
    const candidate = join(dir, 'codex');
    if (existsSync(candidate)) { candidates.unshift(candidate); break; }
  }
  const windowsApps = join(process.env.ProgramFiles || 'C:\\Program Files', 'WindowsApps');
  try {
    for (const name of readdirSync(windowsApps)) {
      if (!/^OpenAI\.Codex_/i.test(name)) continue;
      candidates.unshift(join(windowsApps, name, 'app', 'resources', 'codex.exe'));
    }
  } catch {
    /* WindowsApps 无列举权限时走下面的固定探测 */
  }
  return candidates.find((path) => path && existsSync(path)) || '';
}

mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });

// 某个邮箱对应的隔离 CODEX_HOME。对外暴露是为了让 codex exec 用**同一处定义**，
// 而不是在调用方再拼一遍路径 —— 拼错的后果是消息发到别的账号上，且不会报错。
export function codexHomeFor(address) {
  return join(PROFILE_DIR, profileKey(String(address || '').trim().toLowerCase()));
}

const sessions = new Map();
let activeSessionId = '';

function assertAddress(value) {
  const address = String(value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error('Codex OAuth 需要合法邮箱地址');
  return address;
}

export function parseCodexOAuthStart(result) {
  if (result?.type !== 'chatgpt' || !result.loginId || !result.authUrl) {
    throw new Error('官方 Codex 未返回有效的 ChatGPT OAuth 信息');
  }
  return { loginId: result.loginId, authUrl: result.authUrl };
}

export function parseCodexDeviceCodeStart(result) {
  if (result?.type !== 'chatgptDeviceCode' || !result.loginId || !result.verificationUrl || !result.userCode) {
    throw new Error('官方 Codex 未返回有效的设备码登录信息');
  }
  return {
    loginId: result.loginId,
    verificationUrl: result.verificationUrl,
    userCode: result.userCode,
  };
}

// 不要拿 `codex login status` 当健康判据：它只看本地有没有凭据文件。
// 实测：status 显示 Logged in，account/rateLimits/read 却 401 token_invalidated。
export function parseCodexAccountHealth({ account, rateLimits, rateLimitsError, rateLimitsErrorCode } = {}) {
  const email = String(account?.email || '').trim();
  const planType = String(account?.planType || '').trim();
  const localHasAccount = account?.type === 'chatgpt' && Boolean(email);
  const errorText = String(rateLimitsError || '');
  const errorCode = String(rateLimitsErrorCode || '');
  // 分类只有一处定义（codexLiveness.classifyAccountError），这里不再自己写一遍正则：
  // 探活脚本和这里一旦各判各的，存活曲线和健康检查就会对同一份报文给出两种结论。
  const errorVerdict = errorText || errorCode
    ? classifyAccountError({ code: errorCode, message: errorText })
    : '';
  const tokenInvalidated = errorVerdict === VERDICTS.TOKEN_INVALIDATED;
  const deactivated = errorVerdict === VERDICTS.DEACTIVATED;
  const serverOk = Boolean(rateLimits) && !errorVerdict;
  // verdict 是给存活采样用的机器可读结论；healthy 是给人看的一句话，两者不要互相替代。
  let verdict = VERDICTS.UNKNOWN;
  if (!localHasAccount) verdict = VERDICTS.NO_ACCOUNT;
  else if (serverOk) verdict = VERDICTS.HEALTHY;
  else if (errorVerdict) verdict = errorVerdict;
  let message = '未能读取 Codex 账号';
  if (deactivated) {
    message = '账号已被停用（这是本项目 A1 那条阻塞级问题的现场，不是本地凭据问题）';
  } else if (tokenInvalidated) {
    message = '服务端已作废 token。codex login status 会假阳性，必须以 rateLimits/read 为准';
  } else if (localHasAccount && serverOk) {
    message = `账号有效：${email} / ${planType || 'unknown-plan'}`;
  } else if (localHasAccount && verdict === VERDICTS.TRANSIENT) {
    // 「没查成」必须说成没查成。把它讲成账号出事，采样数据就废了。
    message = `这一轮没查成（${errorText || errorCode || 'unknown'}），不作为账号结论`;
  } else if (localHasAccount) {
    message = `本地有账号 ${email}，但额度接口失败：${errorText || errorCode || 'unknown'}`;
  } else if (account?.type && account.type !== 'chatgpt') {
    message = `app-server 读到非 ChatGPT 账号类型：${account.type}`;
  }
  return {
    localHasAccount,
    serverOk,
    tokenInvalidated,
    deactivated,
    verdict,
    email,
    planType,
    error: errorText,
    errorCode,
    healthy: localHasAccount && serverOk,
    message,
  };
}

function publicSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    address: session.address,
    state: session.state,
    message: session.message,
    loginType: session.loginType || 'chatgpt',
    authUrl: session.authUrl || '',
    verificationUrl: session.verificationUrl || '',
    userCode: session.userCode || '',
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function isActiveState(state) {
  return ACTIVE_STATES.includes(state);
}

function setSessionState(session, state, message) {
  session.state = state;
  session.message = message;
  session.updatedAt = new Date().toISOString();
}

function terminate(session) {
  clearTimeout(session.timeout);
  if (session.child && !session.child.killed) session.child.kill('SIGTERM');
}

function send(session, payload) {
  if (!session.child?.stdin?.writable) throw new Error('Codex app-server 已关闭');
  session.child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function request(session, method, params = {}) {
  const id = ++session.requestId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error(`Codex app-server 请求超时：${method}`));
    }, 20000);
    session.pending.set(id, {
      resolve: (value) => { clearTimeout(timeout); resolve(value); },
      reject: (error) => { clearTimeout(timeout); reject(error); },
    });
    send(session, { id, method, params });
  });
}

function handleMessage(session, message) {
  if (message.id != null && session.pending.has(message.id)) {
    const pending = session.pending.get(message.id);
    session.pending.delete(message.id);
    if (message.error) {
      // 必须把 code 带出去。ops-001 实测服务端作废 token 时回的是 401 +
      // code: token_invalidated；只留 message 的话，探活只能靠模糊匹配文案，
      // 而文案随时会改版。存活窗口那份数据要靠这个字段分清「死了」和「没查成」。
      const error = new Error(message.error.message || 'Codex app-server 返回错误');
      if (message.error.code != null) error.code = message.error.code;
      if (message.error.data != null) error.data = message.error.data;
      pending.reject(error);
    }
    else pending.resolve(message.result);
    return;
  }
  if (message.method === 'account/login/completed') {
    const params = message.params || {};
    if (params.loginId && session.loginId && params.loginId !== session.loginId) return;
    if (params.success) {
      setSessionState(
        session,
        'succeeded',
        session.loginType === 'chatgptDeviceCode' ? '官方 Codex 设备码登录已完成' : '官方 Codex ChatGPT OAuth 已完成',
      );
    } else {
      setSessionState(session, 'failed', params.error || (session.loginType === 'chatgptDeviceCode' ? '官方 Codex 设备码登录失败' : '官方 Codex ChatGPT OAuth 失败'));
    }
    setTimeout(() => terminate(session), 750);
  }
}

async function initializeSession(session) {
  await request(session, 'initialize', {
    clientInfo: { name: 'codex-invite-pilot', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });
  send(session, { method: 'initialized', params: {} });
  if (session.loginType === 'chatgptDeviceCode') {
    const result = parseCodexDeviceCodeStart(await request(session, 'account/login/start', {
      type: 'chatgptDeviceCode',
    }));
    session.loginId = result.loginId;
    session.verificationUrl = result.verificationUrl;
    session.userCode = result.userCode;
    setSessionState(
      session,
      'waiting_device_code',
      `请打开 ${result.verificationUrl} 并输入设备码 ${result.userCode}`,
    );
    return;
  }
  const result = parseCodexOAuthStart(await request(session, 'account/login/start', {
    type: 'chatgpt',
    appBrand: 'codex',
    useHostedLoginSuccessPage: true,
  }));
  session.loginId = result.loginId;
  session.authUrl = result.authUrl;
  setSessionState(session, 'waiting_browser', '已生成官方 Codex ChatGPT OAuth 链接，等待浏览器完成登录');
}

export async function startCodexDeviceAuth({ address, loginType = 'chatgpt' } = {}) {
  const normalized = assertAddress(address);
  const type = String(loginType || 'chatgpt').trim();
  if (!LOGIN_TYPES.has(type)) {
    throw new Error('loginType 只支持 chatgpt 或 chatgptDeviceCode');
  }
  const active = activeSessionId ? sessions.get(activeSessionId) : null;
  if (active && isActiveState(active.state)) {
    throw new Error('已有 Codex 登录正在运行');
  }
  const codexBin = resolveCodexBin();
  if (!codexBin) {
    throw new Error('未找到官方 Codex 可执行文件。Windows 请安装微软商店的 ChatGPT 桌面版，或设置 CODEX_BIN');
  }

  const now = new Date().toISOString();
  const session = {
    id: randomUUID(),
    address: normalized,
    state: 'starting',
    loginType: type,
    message: type === 'chatgptDeviceCode' ? '正在启动官方 Codex 设备码登录' : '正在启动官方 Codex ChatGPT OAuth',
    createdAt: now,
    updatedAt: now,
    requestId: 0,
    pending: new Map(),
  };
  const taskAuthDir = join(PROFILE_DIR, profileKey(normalized));
  mkdirSync(taskAuthDir, { recursive: true, mode: 0o700 });
  session.child = spawn(codexBin, ['app-server', '--stdio', '-c', 'auth_credentials_store="file"'], {
    env: { ...process.env, CODEX_HOME: taskAuthDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  sessions.set(session.id, session);
  activeSessionId = session.id;

  const lines = createInterface({ input: session.child.stdout });
  lines.on('line', (line) => {
    try { handleMessage(session, JSON.parse(line)); } catch { /* app-server 非 JSON 输出不进入任务日志 */ }
  });
  session.child.on('error', (error) => setSessionState(session, 'failed', `无法启动官方 Codex：${error.message}`));
  session.child.on('exit', (code, signal) => {
    if (isActiveState(session.state)) {
      setSessionState(session, 'failed', `Codex app-server 意外退出（${signal || code || 'unknown'}）`);
    }
    for (const pending of session.pending.values()) pending.reject(new Error('Codex app-server 已退出'));
    session.pending.clear();
  });
  session.timeout = setTimeout(() => {
    if (isActiveState(session.state)) {
      setSessionState(session, 'failed', type === 'chatgptDeviceCode' ? 'Codex 设备码登录已超时，请重新开始' : 'Codex OAuth 登录已超时，请重新开始');
      terminate(session);
    }
  }, SESSION_TIMEOUT_MS);

  try {
    await initializeSession(session);
    return publicSession(session);
  } catch (error) {
    setSessionState(session, 'failed', error?.message || (type === 'chatgptDeviceCode' ? 'Codex 设备码登录启动失败' : 'Codex OAuth 启动失败'));
    terminate(session);
    throw error;
  }
}

export function codexDeviceAuthStatus(id) {
  const session = sessions.get(String(id || activeSessionId));
  if (!session) return null;
  return publicSession(session);
}

export async function probeCodexAccount({ address } = {}) {
  const normalized = assertAddress(address);
  const codexBin = resolveCodexBin();
  if (!codexBin) {
    throw new Error('未找到官方 Codex 可执行文件。Windows 请安装微软商店的 ChatGPT 桌面版，或设置 CODEX_BIN');
  }
  const taskAuthDir = join(PROFILE_DIR, profileKey(normalized));
  mkdirSync(taskAuthDir, { recursive: true, mode: 0o700 });
  const session = {
    id: randomUUID(),
    address: normalized,
    state: 'probing',
    message: '正在探活官方 Codex 账号',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    requestId: 0,
    pending: new Map(),
  };
  session.child = spawn(codexBin, ['app-server', '--stdio', '-c', 'auth_credentials_store="file"'], {
    env: { ...process.env, CODEX_HOME: taskAuthDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: session.child.stdout });
  lines.on('line', (line) => {
    try { handleMessage(session, JSON.parse(line)); } catch { /* app-server 非 JSON 输出不进入任务日志 */ }
  });
  let finished = false;
  const exitError = new Promise((_, reject) => {
    session.child.on('error', (error) => {
      if (!finished) reject(new Error(`无法启动官方 Codex：${error.message}`));
    });
    session.child.on('exit', (code, signal) => {
      if (!finished && session.state === 'probing') {
        reject(new Error(`Codex app-server 在探活时退出（${signal || code || 'unknown'}）`));
      }
    });
  });
  try {
    const health = await Promise.race([
      (async () => {
        await request(session, 'initialize', {
          clientInfo: { name: 'codex-invite-pilot', version: '0.1.0' },
          capabilities: { experimentalApi: true },
        });
        send(session, { method: 'initialized', params: {} });
        const account = await request(session, 'account/read');
        let rateLimits = null;
        let rateLimitsError = '';
        let rateLimitsErrorCode = '';
        try {
          rateLimits = await request(session, 'account/rateLimits/read');
        } catch (error) {
          rateLimitsError = error?.message || String(error);
          rateLimitsErrorCode = error?.code == null ? '' : String(error.code);
        }
        session.state = 'probed';
        return parseCodexAccountHealth({ account, rateLimits, rateLimitsError, rateLimitsErrorCode });
      })(),
      exitError,
    ]);
    // checkedAt 由探活方打，不由调用方补：存活窗口全靠这个时刻算，
    // 让调用方各打各的时间等于把测量误差交给调用方。
    return { address: normalized, checkedAt: new Date().toISOString(), ...health };
  } finally {
    finished = true;
    terminate(session);
  }
}

export async function cancelCodexDeviceAuth({ id } = {}) {
  const session = sessions.get(String(id || activeSessionId));
  if (!session) return null;
  if (session.loginId && isActiveState(session.state)) {
    await request(session, 'account/login/cancel', { loginId: session.loginId }).catch(() => {});
  }
  setSessionState(session, 'cancelled', session.loginType === 'chatgptDeviceCode' ? 'Codex 设备码登录已取消' : 'Codex OAuth 登录已取消');
  terminate(session);
  return publicSession(session);
}

process.once('exit', () => {
  for (const session of sessions.values()) terminate(session);
});
