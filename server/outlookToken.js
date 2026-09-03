// outlookToken.js — 校验【Graph 令牌号】的 refresh_token 到底能不能用。
//
// 为什么要单独有它：卖家发的令牌可能是死的（早就被吊销、或者根本没授权对 scope）。
// 而现在唯一会发现这件事的时机是**跑到一半**——那时候买家的邀请名额已经烧掉了。
// 一个号 = 一个不可再生的名额，所以这个检查必须能在**入库时**跑，
// 让坏号在还没派给任何人之前就被拦下。
//
// 这里刻意不复用 outlookMail.js：那份是"单账号 + 环境变量"形态的
// （TOKEN_PATH 在 import 时就按 WEBMAIL_USER 定死了），批量校验用不了。

const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const GRAPH = 'https://graph.microsoft.com/v1.0';
// 我们自己走设备码拿的令牌用的是 Thunderbird 这个公开 client_id，
// 卖家发的也是同一个 —— 没给就按它兜底。
export const THUNDERBIRD_CLIENT_ID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753';

// scope 必须是 .default。
// 卖家签发令牌时用的是它自己那套 scope，我们并不知道；写死
// 'https://graph.microsoft.com/Mail.Read' 会被拒（AADSTS70000: 请求的 scope
// 未授权）。.default 的语义正是「把这个 client 已获授权的一切给我」。
// 2026-08-27 实测：这批货源授予的是 Mail.ReadWrite + Mail.Send。
// 🔴 必须带 offline_access，否则微软**不会回吐新的 refresh_token**。
//
// refresh_token 是滚动有效期：拿它换 access_token 时，只要 scope 里有
// offline_access，响应里就会附一个新的 refresh_token，90 天从那一刻重新计。
// 不带它，号在货架上一天天逼近 90 天悬崖，体检跑得再勤也不会延寿 ——
// 到期那天不报错，只是号池里的号集体登不上。
//
// 2026-09-03 拿真实账号逐个 scope 实测（n=1，判据是响应里有没有 refresh_token）：
//   .default 单独                     → 200，**没有** refresh_token 字段
//   offline_access + .default         → 200，有 refresh_token，且与旧的不同 ✅
//   offline_access + 显式 Mail.* scope → 同上
//   offline_access 单独               → 400 invalid_scope
export const DEFAULT_SCOPE = 'offline_access https://graph.microsoft.com/.default';

/**
 * 把刷新令牌的失败分成两类。分错的代价不对称：
 *   · 把**瞬时故障**判成死号 → 白扔一个好号（一次网络抖动换掉一个账号）
 *   · 把**死号**判成瞬时 → 只是多等一轮，下次再查
 * 所以判据要偏保守：只有微软明确说这个凭据不能用了，才算死。
 */
export function classifyTokenError(status, payload = {}) {
  const code = String(payload.error || '');
  if (status === 429 || status >= 500 || !status) return 'transient';
  const DEAD = new Set([
    'invalid_grant',        // 令牌被吊销 / 过期 / 用户改了密码
    'invalid_client',
    'unauthorized_client',
    'interaction_required',
    'consent_required',
  ]);
  return DEAD.has(code) ? 'dead' : 'transient';
}

/** 换一个 access_token。失败时按 classifyTokenError 分类。 */
async function accessTokenFor({ refreshToken, clientId, timeoutMs = 20000 }) {
  const body = new URLSearchParams({
    client_id: String(clientId || THUNDERBIRD_CLIENT_ID),
    grant_type: 'refresh_token',
    refresh_token: String(refreshToken),
    scope: DEFAULT_SCOPE,
  });
  const response = await fetch(TOKEN_URL, { method: 'POST', body, signal: AbortSignal.timeout(timeoutMs) });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

/**
 * 用账号自带的令牌读几封信。给 inviteSweep 判断「买家到底发没发邀请」用。
 * **读不出来一律返回 ok:false**，调用方必须把它当成"不知道"，不能当成"没有"。
 */
export async function fetchMessagesWithToken({ refreshToken, clientId, top = 25, timeoutMs = 20000 } = {}) {
  if (!refreshToken) return { ok: false, messages: [], detail: '没有 refresh_token' };
  try {
    const { status, payload } = await accessTokenFor({ refreshToken, clientId, timeoutMs });
    if (!payload.access_token) {
      return { ok: false, messages: [], detail: `换令牌失败 HTTP ${status} ${payload.error || ''}` };
    }
    const select = 'id,subject,from,sender,toRecipients,receivedDateTime,body';
    const url = `${GRAPH}/me/messages?$top=${Math.min(Math.max(Number(top) || 25, 1), 50)}&$select=${select}&$orderby=receivedDateTime%20desc`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${payload.access_token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, messages: [], detail: `读信 HTTP ${response.status}` };
    // 把微软轮换回来的新令牌带出去，交给调用方用 CAS 写回
    //（见 accountPool.updateRefreshToken）。丢掉的话，库里那份会越来越旧，
    // 等于一边有续期一边在漏气。
    return { ok: true, messages: data.value || [], detail: '', refreshToken: payload.refresh_token || null };
  } catch (error) {
    return { ok: false, messages: [], detail: `网络失败：${error?.message || error}` };
  }
}

/**
 * 校验一个令牌：换 access_token → 真的读一次信箱。
 *
 * **判据落在产物上**：只拿到 access_token 不算数 —— scope 可能不含读信权限，
 * 那种号换令牌成功、读信 403，跑起来一样废。所以必须真读一次。
 *
 * @returns {{ok:boolean, verdict:'ok'|'dead'|'transient', detail:string, mailCount?:number, scope?:string}}
 */
export async function verifyGraphToken({ refreshToken, clientId, timeoutMs = 20000 } = {}) {
  if (!refreshToken) return { ok: false, verdict: 'dead', detail: '没有 refresh_token' };

  const body = new URLSearchParams({
    client_id: String(clientId || THUNDERBIRD_CLIENT_ID),
    grant_type: 'refresh_token',
    refresh_token: String(refreshToken),
    scope: DEFAULT_SCOPE,
  });

  let status = 0;
  let payload = {};
  try {
    const response = await fetch(TOKEN_URL, {
      method: 'POST', body, signal: AbortSignal.timeout(timeoutMs),
    });
    status = response.status;
    payload = await response.json().catch(() => ({}));
  } catch (error) {
    return { ok: false, verdict: 'transient', detail: `换令牌网络失败：${error?.message || error}` };
  }

  if (!payload.access_token) {
    const verdict = classifyTokenError(status, payload);
    const why = `${payload.error || 'unknown'}：${String(payload.error_description || '').slice(0, 120)}`;
    return { ok: false, verdict, detail: `HTTP ${status} ${why}` };
  }

  // 真读一次。换到令牌 ≠ 能读信。
  try {
    const url = `${GRAPH}/me/messages?$top=1&$select=id`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${payload.access_token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      // 读不了信的令牌对我们没用，但这属于"权限不对"而不是"网络抖动"
      const verdict = response.status === 429 || response.status >= 500 ? 'transient' : 'dead';
      return { ok: false, verdict, detail: `读信 HTTP ${response.status} ${JSON.stringify(data).slice(0, 120)}` };
    }
    return {
      ok: true,
      verdict: 'ok',
      detail: '令牌可用',
      mailCount: (data.value || []).length,
      scope: payload.scope || '',
      // 同上：轮换来的新令牌要交给调用方写回，不能在这儿丢掉
      refreshToken: payload.refresh_token || null,
    };
  } catch (error) {
    return { ok: false, verdict: 'transient', detail: `读信网络失败：${error?.message || error}` };
  }
}
