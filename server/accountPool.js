// accountPool.js — 微软账号池。
//
// 业务时序（安哥 2026-08-26 定的，**这是硬约束不是偏好**）：
//   买家验卡 → 池里领一个账号给他 → 他用自己的 Codex 给这个地址发邀请
//   → 他回来点「我已发送」 → 这时候才开跑
//
// 🔴 为什么不能提前跑：跑批的第一步是登录，而登录会撞上微软「强制绑恢复邮箱」那道闸，
// 我们绑的是 tempmail2026 的临时地址 —— 那个地址十分钟左右就会失效。
// 提前绑 = 邀请还没来、地址先死了，这个微软号从此没有恢复途径，等于白废一个。
// 所以**领号阶段绝不碰账号**（不登录、不绑定、不拿 token），只把地址给出去。
//
// 状态机：
//   available → assigned（已发给买家）→ ready（买家说邀请发了）
//             → running → done / failed
//   dead：账号本身废了（登不上/被封），不再参与分配

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const POOL_DB_PATH = process.env.POOL_DB_PATH || join(ROOT_DIR, 'data', 'account-pool.sqlite');

let db = null;

// 【Graph 令牌号】那类货源直接把 refresh_token 发给你，能整段跳过设备码授权
// （浏览器登录 + 强制绑临时恢复邮箱 + 同意屏，约 150 秒，而绑恢复邮箱那一步
// 本身就是安哥点名过的风险点）。老库没有这两列，而 CREATE TABLE IF NOT EXISTS
// 不会补列，所以要单独迁移一次。
function migrate(conn) {
  const cols = conn.prepare('PRAGMA table_info(accounts)').all().map((c) => c.name);
  if (!cols.includes('refresh_token')) conn.exec('ALTER TABLE accounts ADD COLUMN refresh_token TEXT');
  if (!cols.includes('client_id')) conn.exec('ALTER TABLE accounts ADD COLUMN client_id TEXT');
}

function open() {
  if (db) return db;
  mkdirSync(dirname(POOL_DB_PATH), { recursive: true, mode: 0o700 });
  // timeout + WAL + busy_timeout：默认是 journal_mode=delete / busy_timeout=0，
  // 意思是「撞锁立刻抛，一毫秒都不等」，而且读也挡写。审计实测 6 进程并发
  // 有 51% 的请求直接抛 database is locked —— 运维随手敲一句 status 就能把 claim 打挂。
  db = new DatabaseSync(POOL_DB_PATH, { timeout: 5000 });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  // 库里是**明文密码**，默认落成 644 = 同机任何用户 strings 一下就全拿走
  for (const f of [POOL_DB_PATH, `${POOL_DB_PATH}-wal`, `${POOL_DB_PATH}-shm`]) {
    try { chmodSync(f, 0o600); } catch { /* 文件还没生成 / 非 POSIX 平台 */ }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      address             TEXT PRIMARY KEY,
      password            TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'available',
      assigned_ref        TEXT,
      assigned_at         TEXT,
      invite_confirmed_at TEXT,
      started_at          TEXT,
      finished_at         TEXT,
      result              TEXT,
      note                TEXT,
      created_at          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
    CREATE INDEX IF NOT EXISTS idx_accounts_ref ON accounts(assigned_ref);
    -- 数据库级最后一道闸：就算应用层再出并发 bug，一张卡也不可能同时挂两个活号。
    -- 一个号 = 一个不可再生的邀请名额，超发一次就是白扔一个。
    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_ref_live
      ON accounts(assigned_ref) WHERE assigned_ref IS NOT NULL AND status <> 'dead';
  `);
  migrate(db);
  return db;
}

const now = () => new Date().toISOString();


/** 批量入池。已存在的地址跳过，不覆盖 —— 免得把正在跑的号重置回 available。 */
export function addAccounts(rows = []) {
  const conn = open();
  const insert = conn.prepare(
    'INSERT OR IGNORE INTO accounts (address, password, refresh_token, client_id, status, created_at)'
    + ' VALUES (?, ?, ?, ?, \'available\', ?)',
  );
  let added = 0;
  let withToken = 0;
  let patchedToken = 0;
  for (const row of rows) {
    const address = String(row?.address || '').trim().toLowerCase();
    const password = String(row?.password || '');
    if (!address || !password) continue;
    const refreshToken = String(row?.refreshToken || '') || null;
    const clientId = String(row?.clientId || '') || null;
    const info = insert.run(address, password, refreshToken, clientId, now());
    if (info.changes) { added += 1; if (refreshToken) withToken += 1; continue; }
    // 已存在：只在**它还没有令牌**时补上。不覆盖已有令牌，也一个字都不碰状态。
    if (refreshToken) {
      const patched = conn.prepare(
        'UPDATE accounts SET refresh_token = ?, client_id = ?'
        + ' WHERE address = ? AND (refresh_token IS NULL OR refresh_token = \'\')',
      ).run(refreshToken, clientId, address);
      if (patched.changes) { patchedToken += 1; withToken += 1; }
    }
  }
  return { added, total: rows.length, withToken, patchedToken };
}

/**
 * 领一个号给买家。**只改状态，不碰账号本身**（见文件头那条硬约束）。
 * ref 是卡密或订单号，用来把这一次分配和买家对上。
 */
export function claimAccount(ref) {
  const conn = open();
  const reference = String(ref || '').trim();
  if (!reference) throw new Error('claimAccount 需要 ref（卡密/订单号）');

  // check-then-act 必须整个包在一个事务里。原来「查幂等」和「占坑」是两个独立事务，
  // 两个进程会各自查到「没有」，然后各占一个号 —— 审计实测：紧密重试下
  // 12 轮里有 5 轮一张卡吃掉两个号。BEGIN IMMEDIATE 立刻拿写锁堵死这条缝。
  conn.exec('BEGIN IMMEDIATE');
  try {
    // 幂等范围要含 failed：号跑失败了同一张卡再来，应该拿回原来那个去重跑，
    // 而不是再吃一个新号 —— 邀请名额已经消耗在那个号上了。
    const existing = conn.prepare(
      "SELECT * FROM accounts WHERE assigned_ref = ? AND status <> 'dead' ORDER BY assigned_at DESC LIMIT 1",
    ).get(reference);
    if (existing) { conn.exec('COMMIT'); return { ...existing, reused: true }; }

    const next = conn.prepare(
      "SELECT address FROM accounts WHERE status = 'available' ORDER BY created_at LIMIT 1",
    ).get();
    if (!next) throw new Error('账号池已空');

    const info = conn.prepare(
      "UPDATE accounts SET status='assigned', assigned_ref=?, assigned_at=? WHERE address=? AND status='available'",
    ).run(reference, now(), next.address);
    if (!info.changes) throw new Error('占坑失败（BEGIN IMMEDIATE 下不该发生）');
    const row = conn.prepare('SELECT * FROM accounts WHERE address = ?').get(next.address);
    conn.exec('COMMIT');
    return { ...row, reused: false };
  } catch (error) {
    try { conn.exec('ROLLBACK'); } catch { /* 已经回滚过 */ }
    throw error;
  }
}

/** 买家点「我已发送邀请」。**只有走到这一步才允许开跑**。 */
export function confirmInvite(address) {
  const conn = open();
  const key = String(address || '').trim().toLowerCase();
  const info = conn.prepare(
    // COALESCE：重复 confirm 不冲掉**原始**确认时刻。邀请是时效敏感的
    // （恢复邮箱约 10 分钟失效），事后要能查出邀请究竟什么时候发的。
    "UPDATE accounts SET status='ready', invite_confirmed_at=COALESCE(invite_confirmed_at, ?) WHERE address=? AND status IN ('assigned','ready')",
  ).run(now(), key);
  if (!info.changes) throw new Error(`确认邀请失败：${key} 不在 assigned/ready 状态`);
  return conn.prepare('SELECT * FROM accounts WHERE address = ?').get(key);
}

export function markRunning(address) {
  const conn = open();
  const key = String(address || '').trim().toLowerCase();
  const info = conn.prepare(
    "UPDATE accounts SET status='running', started_at=? WHERE address=? AND status='ready'",
  ).run(now(), key);
  if (!info.changes) throw new Error(`${key} 不在 ready 状态，拒绝开跑（防止邀请还没来就动账号）`);
  return true;
}

export function markFinished(address, { ok, result = '', note = '' } = {}) {
  const conn = open();
  const key = String(address || '').trim().toLowerCase();
  // 🔴 必须限定 running。没有这条守卫时存在一条**绕过核心安全闸**的路径：
  //   claim → assigned（邀请还没发）→ markRunning 被正确拒绝 ✅
  //   → markFinished 把 assigned 打成 failed → reset 洗成 ready → markRunning 通过 🔴
  // 此时 invite_confirmed_at 仍是 null —— 买家从没确认过邀请，脚本却已经开跑去绑
  // 那个十分钟就死的恢复邮箱。这正是这个池子存在的理由要防的事。
  // 顺带堵住：无守卫时还能把 available 凭空打成 done（号没被领过就消失）、
  // 把 dead 复活成 done 并冲掉封号原因。
  const info = conn.prepare(
    "UPDATE accounts SET status=?, finished_at=?, result=?, note=? WHERE address=? AND status='running'",
  ).run(ok ? 'done' : 'failed', now(), String(result).slice(0, 500), String(note).slice(0, 500), key);
  if (!info.changes) throw new Error(`markFinished 无效：${key} 不在 running 状态（可能已被 reset，或本来就没开跑）`);
  return true;
}

// worker 跑一半机器挂了 / 网络断了，号会**永久卡在 running**：
// markFinished 只认 running→终态，而 reset 默认拒绝 running —— 一次崩溃就废掉
// 一个不可再生的邀请名额。这条清扫把陈旧的 running 放回队列（复用模式能救回来，
// 已实证：2026-08-27 minci931350 就是这么救回来的）。
//
// 阈值必须大于最坏的一轮（窗口预算 25 分钟 + 启动开销），默认 45 分钟。
// 🔴 时间戳读不出来时**不动它**：反过来处理的话，格式一变就会把正在跑的那一轮
// 也判成陈旧、放回队列被第二次取走 —— 两轮同时跑正是这套东西最怕的事。
export function reclaimStaleRunning(maxAgeMs = 45 * 60 * 1000) {
  const conn = open();
  const rows = conn.prepare("SELECT address, started_at FROM accounts WHERE status='running'").all();
  const stale = rows.filter((r) => {
    const t = Date.parse(r.started_at || '');
    if (!Number.isFinite(t)) {
      console.warn(`[pool] ${r.address} 的 started_at 读不出来（${r.started_at}），保守起见不回收`);
      return false;
    }
    return Date.now() - t > maxAgeMs;
  });
  for (const r of stale) {
    conn.prepare("UPDATE accounts SET status='ready', started_at=NULL WHERE address=? AND status='running'").run(r.address);
    console.warn(`[pool] ${r.address} 卡在 running 超过 ${Math.round(maxAgeMs / 60000)} 分钟，放回队列`);
  }
  return stale.map((r) => r.address);
}

// 把号退回「已领号、但邀请还没发」的状态。
// 真实场景：买家点了「我已发出邀请」其实没发；或者我们做完干跑要把状态摆正。
// 只认 ready —— running 的号子进程可能还活着，done/failed 是终态，都不该退回去。
export function unconfirmInvite(address) {
  const conn = open();
  const key = String(address || '').trim().toLowerCase();
  const info = conn.prepare(
    "UPDATE accounts SET status='assigned', invite_confirmed_at=NULL WHERE address=? AND status='ready'",
  ).run(key);
  if (!info.changes) throw new Error(`${key} 不在 ready 状态，拒绝退回（只有 ready 才能退回未确认）`);
  return true;
}

// 把号退回可分配池。真实场景：卡退款/注销了，而邀请还没发出去 ——
// 那个号一个字节都没被碰过，理应回到池子里，不该跟着一张废卡陪葬。
//
// 只认 assigned。ready 说明买家已确认发了邀请，running 可能还在跑，
// done/failed 是终态 —— 这几种都不能凭空回到"没派给任何人"。
export function releaseAccount(address) {
  const conn = open();
  const key = String(address || '').trim().toLowerCase();
  const info = conn.prepare(
    "UPDATE accounts SET status='available', assigned_ref=NULL, assigned_at=NULL WHERE address=? AND status='assigned'",
  ).run(key);
  if (!info.changes) throw new Error(`${key} 不在 assigned 状态，拒绝退回（只有"已领号但邀请未发"才能退回池子）`);
  return true;
}

/** 账号本身废了（登不上/被封），永久移出可分配集合 */
export function markDead(address, note = '') {
  const conn = open();
  const info = conn.prepare("UPDATE accounts SET status='dead', note=?, finished_at=? WHERE address=?")
    .run(String(note).slice(0, 500), now(), String(address || '').trim().toLowerCase());
  // 地址打错一个字母就静默 return true，运维会以为标记成功了
  if (!info.changes) throw new Error(`markDead 无效：池子里没有 ${address}`);
  return true;
}

export function getAccount(address) {
  return open().prepare('SELECT * FROM accounts WHERE address = ?').get(String(address || '').trim().toLowerCase());
}

// 按卡密反查这张卡挂着的号。网页端每一步都要它：
// 领号是幂等的（刷新页面不能再领一个），发出邀请、查进度也都从这里认号。
// 只认还活着的（dead 的号已经作废，不该再显示给买家）。
export function getByRef(ref) {
  const key = String(ref || '').trim();
  if (!key) return null;
  return open()
    .prepare("SELECT * FROM accounts WHERE assigned_ref = ? AND status <> 'dead'")
    .get(key) || null;
}

export function listByStatus(status, limit = 50) {
  return open().prepare('SELECT * FROM accounts WHERE status = ? ORDER BY created_at LIMIT ?').all(String(status), Number(limit) || 50);
}

export function poolStats() {
  const rows = open().prepare('SELECT status, COUNT(*) AS n FROM accounts GROUP BY status').all();
  const stats = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  stats.total = rows.reduce((sum, r) => sum + r.n, 0);
  return stats;
}

export function closePool() {
  if (db) { db.close(); db = null; }
}

/**
 * 把 failed/running 的号放回 ready 重跑。
 * 用在「账号其实已经建好、只是某一步卡了」的情况 —— 邀请已经消耗，
 * 换个号等于白扔一个邀请名额，能重跑就重跑。
 */
export function resetToReady(address, { force = false } = {}) {
  const conn = open();
  const key = String(address || '').trim().toLowerCase();
  // 🔴 running 默认不许 reset：子进程可能还活着，reset + 重跑 = 同一个微软号上
  // 两个自动化进程同时登录 —— 双份接码费不说，微软极可能直接判异常把号锁掉。
  // 要重置 running，运维必须先自己确认进程已死，再显式传 --force。
  // 另外要清掉 result/note：不清的话面板显示「ready — ❌ 上一轮的失败原因」，排障时误导。
  // --force 也放行 done：用于**验证性重跑**。这类号的邀请名额已经消耗掉了，
  // 重跑不浪费任何不可再生资源（只花一次接码费），而它能完整走到发消息那一步 ——
  // 正是验证判据改动最省的办法，比拿一个新号去试划算得多。
  const allowed = force ? "('failed','running','done')" : "('failed')";
  const info = conn.prepare(
    `UPDATE accounts SET status='ready', started_at=NULL, finished_at=NULL, result=NULL, note=NULL WHERE address=? AND status IN ${allowed}`,
  ).run(key);
  if (!info.changes) throw new Error(`${key} 不在 ${force ? 'failed/running' : 'failed'} 状态，拒绝 reset`);
  return conn.prepare('SELECT * FROM accounts WHERE address = ?').get(key);
}
