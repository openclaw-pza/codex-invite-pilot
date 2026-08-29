// codexLiveness.js — 账号存活窗口的采样判读。
//
// 存在的理由：vault `2026-08-25-ops-002` 的 A2 项——「账号建成后能活多久」目前有两个
// 互斥的说法，差一个数量级：
//   · desktop-run.mjs:9 的代码注释说约 10 分钟（整套「分阶段跑、掐表」的架构是按它设计的）
//   · ops-002 那轮实测是 12:30 建成 → 12:5x 还能登录 → 13:2x 已停用，即 25~55 分钟
// 没测准之前去改架构，等于拿一个未验证的前提当地基。总表自己写了这条「0 名额可验」，
// 靠的就是对**已有的那一个账号**反复探活，不需要再消耗邀请名额。
//
// 本文件只做判读，不起进程、不发请求，因此可以拿历史日志离线重跑。

// 探活结论的全集。区分「死了」和「没查成」是这里最重要的一件事：
// 项目硬规则「整批查不到 = 故障，不得当作没有数据」在这里的对应物是
// **网络抖一下不能记成账号死了** —— 记错一次，算出来的存活窗口就整个作废。
export const VERDICTS = Object.freeze({
  HEALTHY: 'healthy',                     // account/read 与 rateLimits/read 双双成功
  DEACTIVATED: 'deactivated',             // 账号被停用
  TOKEN_INVALIDATED: 'token_invalidated', // 服务端作废了 token
  UNAUTHORIZED: 'unauthorized',           // 401/403 但没认出具体原因
  NO_ACCOUNT: 'no_account',               // 本地就没有 ChatGPT 凭据
  TRANSIENT: 'transient',                 // 超时/连接错误/5xx —— 没查成，不是结论
  UNKNOWN: 'unknown',
});

// 只有这两种算「死亡证据」。UNAUTHORIZED / UNKNOWN 刻意不算：
// 认不出来的错误当成死亡，就是在用软信号下硬结论，而这份数据是要拿去改架构的。
const DEAD_EVIDENCE = new Set([VERDICTS.DEACTIVATED, VERDICTS.TOKEN_INVALIDATED]);

export function isDeadEvidence(verdict) {
  return DEAD_EVIDENCE.has(verdict);
}

// 停用的标记串来自六项目开源调研（ops-006）：它们的做法是 GET /backend-api/me
// 之后识别 `account_deactivated`。【来源声称】—— 本仓库**没有**抓到过 app-server
// 在停用时的原始报文，所以这里多留几个候选写法，并且认不出来一律落到 UNKNOWN，
// 由 rawError 原样入库，等真样本到手再回来收窄。宁可漏判，不可错判。
const DEACTIVATED_MARKERS = /account[_\s-]?deactivated|account (?:has been )?(?:deactivated|disabled|suspended|terminated)|账[户号].*(?:停用|封禁|禁用)/i;
const TOKEN_INVALID_MARKERS = /token[_\s-]?invalidated|authentication token has been invalidated/i;
const UNAUTHORIZED_MARKERS = /\b(?:401|403)\b|unauthorized|forbidden|not authenticated/i;
// 「没查成」的形态。app-server 自己退出也算——那是我们这边的问题，不是账号的问题。
const TRANSIENT_MARKERS = /timeout|timed out|请求超时|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|socket hang up|network|\b(?:429|500|502|503|504)\b|app-server 已退出|app-server 在探活时退出|无法启动官方 Codex/i;

// 判据优先级：错误码 > 错误文案。
// 错误码是 OpenAI 给的机器可读字段（ops-001 实测 401 那次带着 code: token_invalidated），
// 文案随时会改版；而 codexDeviceAuth 原来把 code 丢了，只留 message —— 已一并修掉。
export function classifyAccountError({ code = '', message = '' } = {}) {
  const text = `${code} ${message}`.trim();
  if (!text) return VERDICTS.UNKNOWN;
  if (DEACTIVATED_MARKERS.test(text)) return VERDICTS.DEACTIVATED;
  if (TOKEN_INVALID_MARKERS.test(text)) return VERDICTS.TOKEN_INVALIDATED;
  // 传输层的判定放在鉴权之前：「超时」里恰好带个 401 字样的情况极少，
  // 反过来把超时判成鉴权失败却会污染整条存活曲线。
  if (TRANSIENT_MARKERS.test(text)) return VERDICTS.TRANSIENT;
  if (UNAUTHORIZED_MARKERS.test(text)) return VERDICTS.UNAUTHORIZED;
  return VERDICTS.UNKNOWN;
}

function toTime(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '未知';
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const seconds = Math.floor((ms % 60000) / 1000);
  if (hours) return `${hours} 小时 ${minutes} 分`;
  if (totalMinutes) return `${totalMinutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

/**
 * 把一串探活样本读成一个存活窗口。
 *
 * 输出**刻意是一个区间而不是一个点**：我们只知道「最后一次确认活着」和
 * 「第一次拿到死亡证据」这两个时刻，真正的死亡时刻落在两者之间。
 * 报一个点值就是在编造采样间隔里的精度，而 A2 这条待办正是被两个点值互相打架卡住的。
 *
 * @param samples 形如 { at, verdict, error, code } 的数组，按时间先后
 * @param bornAt  账号建成时刻（t0）。缺省时退回「第一次探活成功」，并在输出里标注。
 * @param confirmAfter 连续多少个死亡证据才算确认。默认 2 —— 单点判死会被一次抖动骗到。
 */
export function summarizeLiveness(samples = [], { bornAt = '', confirmAfter = 2 } = {}) {
  const rows = (Array.isArray(samples) ? samples : []).filter((row) => row && row.verdict);
  const need = Math.max(1, Math.floor(Number(confirmAfter) || 2));

  let firstHealthyAt = '';
  let lastHealthyAt = '';
  let firstDeadAt = '';
  let confirmedAt = '';
  let deadKind = '';
  let streak = 0;
  const counts = Object.create(null);

  for (const row of rows) {
    counts[row.verdict] = (counts[row.verdict] || 0) + 1;
    if (row.verdict === VERDICTS.HEALTHY) {
      // 一次确认活着就把连击清零，也把「第一次死亡证据」作废：
      // 账号又活过来了，说明之前那次是误报或短暂抖动，不能拿它当死亡起点。
      streak = 0;
      firstDeadAt = '';
      if (!firstHealthyAt) firstHealthyAt = row.at;
      lastHealthyAt = row.at;
      continue;
    }
    if (!isDeadEvidence(row.verdict)) continue; // 没查成 / 认不出 → 既不推进也不打断
    streak += 1;
    if (streak === 1) { firstDeadAt = row.at; deadKind = row.verdict; }
    if (streak >= need && !confirmedAt) confirmedAt = row.at;
  }

  const t0 = toTime(bornAt) ?? toTime(firstHealthyAt);
  const t0Source = toTime(bornAt) ? 'born_at' : (firstHealthyAt ? 'first_healthy' : 'none');
  const lower = t0 && toTime(lastHealthyAt) ? toTime(lastHealthyAt) - t0 : null;
  const upper = t0 && toTime(firstDeadAt) ? toTime(firstDeadAt) - t0 : null;

  return {
    samples: rows.length,
    counts,
    confirmedDead: Boolean(confirmedAt),
    deadKind,
    firstHealthyAt,
    lastHealthyAt,
    firstDeadAt,
    confirmedDeadAt: confirmedAt,
    t0: t0 ? new Date(t0).toISOString() : '',
    t0Source,
    // 至少活了 lower，至多活了 upper。upper 为空 = 还没死或还没拿到死亡证据。
    survivedAtLeastMs: lower,
    survivedAtMostMs: upper,
    verdictLine: describeWindow({ lower, upper, confirmed: Boolean(confirmedAt), deadKind, t0Source }),
  };
}

function describeWindow({ lower, upper, confirmed, deadKind, t0Source }) {
  const base = t0Source === 'born_at' ? '自账号建成起' : '自首次探活成功起';
  if (lower == null) return '样本里没有一次确认活着，无法给存活窗口（先确认探活链路本身是通的）';
  if (!confirmed) return `${base}已存活 ≥ ${formatDuration(lower)}，尚未确认死亡`;
  if (upper == null) return `${base}已存活 ≥ ${formatDuration(lower)}，已确认死亡但缺首次死亡证据的时刻`;
  return `${base}存活窗口 ∈ [${formatDuration(lower)}, ${formatDuration(upper)}]（死因：${deadKind}）`;
}

export { formatDuration };
