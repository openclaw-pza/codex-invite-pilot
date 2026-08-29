// cards.js — 卡密模块（对外售卖侧）
//
// 设计要点（每条都对应一个真实风险，改动前先想清楚）：
//
// 1. 「一卡一次成功收码」和「一卡同时只能有一个进行中的号」这两条不变量，
//    靠**数据库唯一索引**兜底，不靠调用方自觉。代码里的检查只是为了给出友好报错。
// 2. 取号是**先占坑再花钱**：先往 activations 插一条 reserved 占位行，
//    被唯一索引挡下就直接拒绝，压根不去调 HeroSMS。调用成功再回填真 activationId，
//    失败就删掉占位。避免「钱扣了号拿不到」。
// 3. 全部用 node:sqlite（Node 22+ 内置），零第三方依赖。DatabaseSync 是同步 API，
//    单进程下天然串行，配合唯一索引足以扛住并发。
//
// 关联：VEND-PLAN.md「核心不变量」一节。

import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// 卡密字符集：去掉了 0/O、1/I/L 这些手抄会认错的字符。32 个字符 = 每位 5 bit。
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const GROUPS = 3;
const GROUP_LEN = 4;

// 会话有效期：买家验完卡密后拿到的令牌能用多久
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 小时

// 卡密有效期：从「发出去那一刻」起算。
// 走订单发的卡 issued_at = created_at（发卡时才建卡，不是从库存里挑），
// 后台/桌面脚本生成的卡没有 issued_at，从 created_at 起算 —— 两种都是「发出即计时」。
//
// **只对新卡生效**：expires_at 为 NULL 的是这条规则上线前的老卡，永不过期。
// 不这么做的话上线当刻库里 51 张卡会死掉 49 张，其中有 20 小时前就发到买家手上的，
// 等于我们自己造一波「描述不符」退款。
const CARD_TTL_MS = 60 * 60 * 1000; // 1 小时

// 防爆破：同一 IP 在窗口内失败多少次就锁多久
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const ATTEMPT_MAX_FAIL = 5;
const LOCK_MS = 30 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cards (
  code          TEXT PRIMARY KEY,
  denom_cny     REAL    NOT NULL,
  service       TEXT    NOT NULL DEFAULT 'dr',
  status        TEXT    NOT NULL DEFAULT 'unused',  -- unused | issued | used | void
  created_at    INTEGER NOT NULL,
  issued_at     INTEGER,
  order_id      TEXT,
  item_id       TEXT,
  spec_value    TEXT,
  first_used_at INTEGER,
  expires_at    INTEGER,
  used_at       INTEGER,
  note          TEXT,
  -- 这张卡能成功收几次码。默认 1 = 原来的一次性卡，老卡行为完全不变。
  -- 面额是这几次**共用**的钱包，不是每次都能花满额 ——
  -- 每次都花满的话 ¥3.99 的卡三次能花掉 ¥11.97，一单亏 ¥4.6。
  max_codes     INTEGER NOT NULL DEFAULT 1
);

-- 一个闲鱼订单只发一张卡：闲鱼回调有 4 次重试，没有这条约束会重复发卡白送钱。
CREATE UNIQUE INDEX IF NOT EXISTS ux_cards_order
  ON cards(order_id) WHERE order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS ix_sessions_code ON sessions(code);

CREATE TABLE IF NOT EXISTS activations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT    NOT NULL,
  activation_id TEXT,                       -- HeroSMS 的 id，占坑阶段为 NULL
  country       INTEGER,
  service       TEXT    NOT NULL,
  phone         TEXT,
  price_usd     REAL,
  price_cny     REAL,
  state         TEXT    NOT NULL,           -- reserved | waiting | code | cancelled | failed
  sms_code      TEXT,
  created_at    INTEGER NOT NULL,
  ended_at      INTEGER
);

-- 硬闸一：一张卡同时只能有一个「进行中」的号（占坑中或等码中）。
CREATE UNIQUE INDEX IF NOT EXISTS ux_one_live_activation
  ON activations(code) WHERE state IN ('reserved', 'waiting');

-- 硬闸二：同一个 HeroSMS activationId 不能落两条。
CREATE UNIQUE INDEX IF NOT EXISTS ux_activation_id
  ON activations(activation_id) WHERE activation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_activations_code ON activations(code);

CREATE TABLE IF NOT EXISTS topups (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT    NOT NULL,
  country      INTEGER NOT NULL,
  need_cny     REAL    NOT NULL,
  status       TEXT    NOT NULL,            -- claimed | confirmed | rejected
  claimed_at   INTEGER NOT NULL,
  confirmed_at INTEGER,
  -- 补款是**一次性**的。没有这一列的话，补一次 ¥4.15 就能反复取美国号（每个成本 ¥6.05）。
  consumed_at  INTEGER,
  note         TEXT
);
CREATE INDEX IF NOT EXISTS ix_topups_code ON topups(code, country);

-- 临时邮箱（免费福利）。
-- 后台的 /admin/mails 接口拿管理员凭据可以读**任意地址**的信，
-- 所以必须记谁创建了哪个地址，只让本人读自己的——
-- 不绑归属的话，任何人都能读别人的验证码邮件。
CREATE TABLE IF NOT EXISTS mailboxes (
  address    TEXT PRIMARY KEY,
  owner      TEXT    NOT NULL,
  ip         TEXT,
  address_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_mailboxes_owner ON mailboxes(owner);
CREATE INDEX IF NOT EXISTS ix_mailboxes_ip ON mailboxes(ip, created_at);

CREATE TABLE IF NOT EXISTS attempts (
  id  INTEGER PRIMARY KEY AUTOINCREMENT,
  ip  TEXT    NOT NULL,
  ts  INTEGER NOT NULL,
  ok  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_attempts_ip ON attempts(ip, ts);

-- 买家意见。先落库再发邮件：SMTP 会挂（限频/授权码过期/网络抖），
-- 只发信的话这些意见就永远没了，而买家那边显示的是「已提交」。
CREATE TABLE IF NOT EXISTS feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  ip         TEXT,
  contact    TEXT,
  body       TEXT    NOT NULL,
  card_tail  TEXT,
  mailed_at  INTEGER,
  mail_error TEXT
);
CREATE INDEX IF NOT EXISTS ix_feedback_ip ON feedback(ip, created_at);
`;

// SQLite 唯一索引冲突时抛的错，用来把「撞闸」和「真故障」区分开
function isUniqueViolation(error) {
  return /UNIQUE constraint failed/i.test(String(error?.message || ''));
}

export class CardStore {
  constructor(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  // CREATE TABLE IF NOT EXISTS 不会给已存在的表补列，所以新增列要在这里单独加。
  migrate() {
    const topupCols = this.db.prepare('PRAGMA table_info(topups)').all().map((row) => row.name);
    if (!topupCols.includes('consumed_at')) {
      this.db.exec('ALTER TABLE topups ADD COLUMN consumed_at INTEGER');
    }
    // 支付宝成交号。人工核对时这一列是空的（那条路还留着）；
    // 走支付宝自动到账的必须记下来，否则事后跟支付宝账单对不上，
    // 出现纠纷时拿不出「这笔钱确实到了、对应哪张卡」的证据。
    if (!topupCols.includes('trade_no')) {
      this.db.exec('ALTER TABLE topups ADD COLUMN trade_no TEXT');
    }
    // 注销卡密 / 退款申请：买家试了几次没收到码，可以主动注销并找卖家退款。
    // 刻意**不做自动退款**——退款链路复杂且容易出错，宁可让卖家人工确认。
    // 退款对账：本地标了 cancelled 不等于平台真退了钱。
    // 没有这一列的话，平台退款失败时账面对不上，而且事后查不出来是哪一笔。
    // 注销邮箱要拿后台的 address_id 当句柄，老库没有这一列
    const mbCols = this.db.prepare('PRAGMA table_info(mailboxes)').all().map((row) => row.name);
    if (mbCols.length && !mbCols.includes('address_id')) {
      this.db.exec('ALTER TABLE mailboxes ADD COLUMN address_id TEXT');
    }
    const actCols = this.db.prepare('PRAGMA table_info(activations)').all().map((row) => row.name);
    // 短信原文。getStatus 返回的就是 STATUS_OK:<原文>，以前只留了抽出来的验证码，
    // 原文丢了 —— 买家看不到「这条码是哪个平台发的」，客服也没法核。
    if (!actCols.includes('sms_text')) {
      this.db.exec('ALTER TABLE activations ADD COLUMN sms_text TEXT');
    }
    if (!actCols.includes('refund_state')) {
      this.db.exec("ALTER TABLE activations ADD COLUMN refund_state TEXT"); // refunded | denied | unknown
    }
    if (!actCols.includes('refund_raw')) {
      this.db.exec('ALTER TABLE activations ADD COLUMN refund_raw TEXT');
    }
    const cardCols = this.db.prepare('PRAGMA table_info(cards)').all().map((row) => row.name);
    // 卡密有效期。老库补上这一列后**保持 NULL**：已经发出去的卡不受新规则约束，
    // 否则上线那一刻库里的存量卡会集体作废（实测 51 张里 49 张会死）。
    if (!cardCols.includes('expires_at')) {
      this.db.exec('ALTER TABLE cards ADD COLUMN expires_at INTEGER');
    }
    // locked_service：NULL = 买家自选服务（默认），有值 = 这张卡只能取该服务的号。
    // 跟 service 列区分开：service 只是发卡时的默认值，从来不是约束。
    if (!cardCols.includes('locked_service')) {
      this.db.exec('ALTER TABLE cards ADD COLUMN locked_service TEXT');
    }
    if (!cardCols.includes('refund_state')) {
      this.db.exec('ALTER TABLE cards ADD COLUMN refund_state TEXT'); // null | requested | refunded | declined
    }
    if (!cardCols.includes('refund_note')) {
      this.db.exec('ALTER TABLE cards ADD COLUMN refund_note TEXT');
    }
    if (!cardCols.includes('voided_at')) {
      this.db.exec('ALTER TABLE cards ADD COLUMN voided_at INTEGER');
    }
    // max_codes：这张卡能成功收几次码。老卡补成 1 = 保持原来的一次性行为，
    // 绝不能让已经卖出去的卡因为升级突然能多收几次。
    if (!cardCols.includes('max_codes')) {
      this.db.exec('ALTER TABLE cards ADD COLUMN max_codes INTEGER NOT NULL DEFAULT 1');
    }
  }

  close() {
    this.db.close();
  }

  // 在一个事务里跑 fn；抛错自动回滚
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* 回滚失败不掩盖原始错误 */ }
      throw error;
    }
  }

  // ---------- 卡密生成 ----------

  // 生成一段 ANGE-XXXX-XXXX-XXXX。用 randomBytes 而不是 Math.random——卡密能猜出来就等于白送。
  static generateCode(prefix = 'ANGE') {
    const groups = [];
    for (let g = 0; g < GROUPS; g += 1) {
      // 拒绝采样：256 不是 31 的整数倍，直接取模会让前几个字符概率偏高
      let group = '';
      while (group.length < GROUP_LEN) {
        for (const byte of randomBytes(GROUP_LEN * 2)) {
          if (byte >= 248) continue; // 248 = 31 * 8，丢掉尾巴保证均匀
          group += ALPHABET[byte % ALPHABET.length];
          if (group.length === GROUP_LEN) break;
        }
      }
      groups.push(group);
    }
    return `${prefix}-${groups.join('-')}`;
  }

  // 造一张卡。orderId 非空时带唯一约束，闲鱼重试不会重复发卡。
  issueCard({ denomCny, service = 'dr', lockedService = null, orderId = null, itemId = null, specValue = null, note = null, prefix = 'ANGE', maxCodes = 1 }) {
    const denom = Number(denomCny);
    if (!Number.isFinite(denom) || denom <= 0) throw new Error('卡密面额必须是正数');
    // 次数必须是正整数。传了 0 或 NaN 就退回 1 —— 宁可当成一次性卡，
    // 也不能发出一张次数不明的卡：多送次数是白送号，送少了是纠纷。
    const codes = Math.max(1, Math.floor(Number(maxCodes) || 1));

    // 同一订单已经发过卡就把原卡还回去，绝不再发一张
    if (orderId) {
      const existing = this.db.prepare('SELECT * FROM cards WHERE order_id = ?').get(orderId);
      if (existing) return { card: existing, reissued: true };
    }

    const now = Date.now();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = CardStore.generateCode(prefix);
      try {
        this.db.prepare(`
          INSERT INTO cards (code, denom_cny, service, locked_service, status, created_at, issued_at, order_id, item_id, spec_value, note, max_codes, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(code, denom, service, lockedService, orderId ? 'issued' : 'unused', now, orderId ? now : null, orderId, itemId, specValue, note, codes, now + CARD_TTL_MS);
        return { card: this.db.prepare('SELECT * FROM cards WHERE code = ?').get(code), reissued: false };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // 撞到 order_id 唯一索引 = 并发下另一个请求刚发过，把它的卡还回去
        if (orderId) {
          const raced = this.db.prepare('SELECT * FROM cards WHERE order_id = ?').get(orderId);
          if (raced) return { card: raced, reissued: true };
        }
        // 否则是 code 撞了（概率极低），换一个再来
      }
    }
    throw new Error('连续 8 次生成卡密都撞号，这不正常，请检查随机源');
  }

  // ---------- 校验与会话 ----------

  getCard(code) {
    return this.db.prepare('SELECT * FROM cards WHERE code = ?').get(String(code || '').trim().toUpperCase()) || null;
  }

  // 注销卡密并申请退款。已经收过码的卡不能注销（交易已完成），
  // 有号在跑的必须先由调用方退掉，否则那个号会变成没人管的孤儿。
  voidCard(code, reason = null) {
    const card = this.getCard(code);
    if (!card) return { ok: false, reason: 'not_found' };
    if (card.status === 'used') return { ok: false, reason: 'used', card };
    if (card.status === 'void') return { ok: true, card, already: true };
    const live = this.getLiveActivation(card.code);
    if (live) return { ok: false, reason: 'has_live', card };

    const now = Date.now();
    this.db.prepare(`UPDATE cards SET status = 'void', voided_at = ?, refund_state = 'requested', refund_note = ?
      WHERE code = ?`).run(now, reason ? String(reason).slice(0, 200) : null, card.code);
    this.db.prepare('DELETE FROM sessions WHERE code = ?').run(card.code);
    return { ok: true, card: this.getCard(card.code), already: false };
  }

  // 待卖家处理的退款申请。只给后四位对账用，不把整串卡密发到浏览器。
  listRefundRequests() {
    return this.db.prepare(`
      SELECT code, denom_cny, order_id, spec_value, voided_at, refund_note,
             (SELECT COUNT(*) FROM activations a WHERE a.code = cards.code AND a.activation_id IS NOT NULL) AS orders
      FROM cards WHERE refund_state = 'requested' ORDER BY voided_at ASC
    `).all().map((row) => ({
      codeTail: String(row.code).slice(-4),
      denomCny: row.denom_cny,
      orderId: row.order_id,
      specValue: row.spec_value,
      voidedAt: row.voided_at,
      note: row.refund_note,
      orders: row.orders,
    }));
  }

  // 卖家处理完退款。按后四位定位——管理页拿到的就是这四位。
  resolveRefund(codeTail, action, note = null) {
    const state = action === 'refunded' ? 'refunded' : 'declined';
    const rows = this.db.prepare(`
      SELECT code FROM cards WHERE refund_state = 'requested' AND code LIKE ?
    `).all(`%${String(codeTail).toUpperCase()}`);
    if (rows.length !== 1) return { ok: false, reason: rows.length ? 'ambiguous' : 'not_found', matches: rows.length };
    this.db.prepare('UPDATE cards SET refund_state = ?, refund_note = ? WHERE code = ?')
      .run(state, note ? String(note).slice(0, 200) : null, rows[0].code);
    return { ok: true, state, codeTail: String(rows[0].code).slice(-4) };
  }

  // 校验卡密。返回 {ok, card, reason}——reason 用于给买家看人话，不泄露卡密是否存在以外的信息。
  verifyCard(code) {
    const card = this.getCard(code);
    if (!card) return { ok: false, reason: 'not_found' };
    if (card.status === 'used') return { ok: false, card, reason: 'used' };
    if (card.status === 'void') return { ok: false, card, reason: 'void' };
    // expires_at 为 NULL = 规则上线前的老卡，永不过期（见 CARD_TTL_MS 注释）。
    if (card.expires_at && Date.now() > card.expires_at) return { ok: false, card, reason: 'expired' };
    return { ok: true, card, reason: null };
  }

  createSession(code, ip = null) {
    const now = Date.now();
    // 一张卡只留一个会话：既防会话表被反复验卡撑爆，
    // 也顺带让「换个地方重新验卡」把旧令牌自动失效
    this.db.prepare('DELETE FROM sessions WHERE code = ?').run(code);
    const token = randomUUID().replace(/-/g, '') + randomBytes(8).toString('hex');
    // 会话不能比卡活得久：卡 1 小时过期而会话 6 小时，买家在第 59 分钟验卡就能再用 6 小时，
    // 过期规则等于形同虚设。老卡 expires_at 为 NULL，不受影响。
    const card = this.getCard(code);
    const expiresAt = card && card.expires_at
      ? Math.min(now + SESSION_TTL_MS, card.expires_at)
      : now + SESSION_TTL_MS;
    this.db.prepare('INSERT INTO sessions (token, code, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?)')
      .run(token, code, now, expiresAt, ip);
    return { token, expiresAt };
  }

  // 会话过期即视为不存在。不做滑动续期——买家一次取号用不了 6 小时。
  resolveSession(token) {
    if (!token) return null;
    const row = this.db.prepare('SELECT * FROM sessions WHERE token = ?').get(String(token));
    if (!row) return null;
    if (row.expires_at < Date.now()) return null;
    const card = this.getCard(row.code);
    if (!card) return null;
    return { session: row, card };
  }

  dropSessions(code) {
    this.db.prepare('DELETE FROM sessions WHERE code = ?').run(code);
  }

  // ---------- 取号生命周期 ----------

  // 第一步：占坑。撞到 ux_one_live_activation 说明这张卡已经有号在跑了。
  // 关键——这一步在调 HeroSMS **之前**，所以撞闸不会浪费钱。
  reserve({ code, country, service }) {
    const card = this.getCard(code);
    if (!card) return { ok: false, reason: 'not_found' };
    if (card.status === 'used') return { ok: false, reason: 'used' };
    if (card.status === 'void') return { ok: false, reason: 'void' };

    try {
      const info = this.db.prepare(`
        INSERT INTO activations (code, activation_id, country, service, state, created_at)
        VALUES (?, NULL, ?, ?, 'reserved', ?)
      `).run(code, country, service, Date.now());
      return { ok: true, reservationId: Number(info.lastInsertRowid) };
    } catch (error) {
      if (isUniqueViolation(error)) return { ok: false, reason: 'already_active' };
      throw error;
    }
  }

  // 第二步：HeroSMS 取号成功，把真 id 回填，状态转 waiting。
  fulfill(reservationId, { activationId, phone, priceUsd = null, priceCny = null }) {
    return this.tx(() => {
      const row = this.db.prepare('SELECT * FROM activations WHERE id = ?').get(reservationId);
      if (!row) throw new Error(`占位记录 ${reservationId} 不存在`);
      if (row.state !== 'reserved') throw new Error(`占位记录 ${reservationId} 状态是 ${row.state}，不能回填`);

      this.db.prepare(`
        UPDATE activations SET activation_id = ?, phone = ?, price_usd = ?, price_cny = ?, state = 'waiting'
        WHERE id = ?
      `).run(String(activationId), phone, priceUsd, priceCny, reservationId);

      // 记一次首用时间，用于统计和排查
      const card = this.getCard(row.code);
      if (card && !card.first_used_at) {
        this.db.prepare('UPDATE cards SET first_used_at = ? WHERE code = ?').run(Date.now(), row.code);
      }
      return this.db.prepare('SELECT * FROM activations WHERE id = ?').get(reservationId);
    });
  }

  // 第二步的失败分支：HeroSMS 没给号，把占位删掉，让这张卡能马上重试。
  releaseReservation(reservationId) {
    const row = this.db.prepare('SELECT * FROM activations WHERE id = ?').get(reservationId);
    if (!row) return false;
    if (row.state !== 'reserved') return false;
    this.db.prepare('DELETE FROM activations WHERE id = ?').run(reservationId);
    return true;
  }

  getLiveActivation(code) {
    return this.db.prepare(`
      SELECT * FROM activations WHERE code = ? AND state IN ('reserved','waiting') ORDER BY id DESC LIMIT 1
    `).get(code) || null;
  }

  getActivationById(activationId) {
    return this.db.prepare('SELECT * FROM activations WHERE activation_id = ?').get(String(activationId)) || null;
  }

  // 收到验证码：activation 结束 + 卡密消耗。两件事必须同一个事务，
  // 否则中间崩了会出现「码给了但卡还能再用」。
  consume(activationId, smsCode, smsText = null) {
    return this.tx(() => {
      const row = this.db.prepare('SELECT * FROM activations WHERE activation_id = ?').get(String(activationId));
      if (!row) throw new Error(`activation ${activationId} 不存在`);
      if (row.state === 'code') return { card: this.getCard(row.code), activation: row, alreadyDone: true };
      if (row.state !== 'waiting') throw new Error(`activation ${activationId} 状态是 ${row.state}，不能标记收码`);

      const now = Date.now();
      this.db.prepare("UPDATE activations SET state = 'code', sms_code = ?, sms_text = ?, ended_at = ? WHERE id = ?")
        .run(String(smsCode), smsText ? String(smsText).slice(0, 500) : null, now, row.id);
      this.settleAfterCode(row.code, now);
      // 这里**不删会话**：验证码只在那一个 HTTP 响应里出现，
      // 买家网络抖一下或手滑刷新就永远拿不回来了，那是必然的退款。
      // 卡已经是 used，花钱的接口靠 requireSession 的状态检查挡住，读状态放行。

      return {
        card: this.getCard(row.code),
        activation: this.db.prepare('SELECT * FROM activations WHERE id = ?').get(row.id),
        alreadyDone: false,
      };
    });
  }

  // 兜底：码已经从平台发出来了（这笔钱铁定退不回来），但本地这条已经被
  // 并发的换号/取消标成了 cancelled。必须认账——把码记上、卡密消耗，
  // 绝不能把码丢掉让卡还留着：那是卖家付两个号的钱、买家却拿不到码。
  forceConsume(activationId, smsCode, smsText = null) {
    return this.tx(() => {
      const row = this.db.prepare('SELECT * FROM activations WHERE activation_id = ?').get(String(activationId));
      if (!row) return null;
      const now = Date.now();
      this.db.prepare("UPDATE activations SET state = 'code', sms_code = ?, sms_text = ?, ended_at = ? WHERE id = ?")
        .run(String(smsCode), smsText ? String(smsText).slice(0, 500) : null, now, row.id);
      this.settleAfterCode(row.code, now);
      return this.getCard(row.code);
    });
  }

  // 收到码之后结算这张卡：到次数上限就作废，没到就让它活着接着用。
  // consume 和 forceConsume 都必须走这里 —— 这是「卡什么时候死」的唯一定义，
  // 两处各写一遍迟早会漂，而漂的方向要么是白送号要么是吞了买家的次数。
  settleAfterCode(code, now) {
    const card = this.getCard(code);
    const maxCodes = Math.max(1, Number(card?.max_codes) || 1);
    if (this.codesUsed(code) < maxCodes) return false;

    this.db.prepare("UPDATE cards SET status = 'used', used_at = ? WHERE code = ?").run(now, code);
    // 补款余额跟着一起作废。放在取号时划掉是错的：买家补了 ¥10.1 取美国号，
    // 号收不到码想换一个，补款却已经没了——最高客单价的那批订单会当场变成退款。
    // 多次卡也不能在第一次收码就划：补的钱是钱包的一部分，要留到最后一次；
    // 中间花掉多少由 spentCny 从余额里扣，不是靠划掉整笔。
    this.db.prepare(`UPDATE topups SET consumed_at = ?
      WHERE code = ? AND status = 'confirmed' AND consumed_at IS NULL`)
      .run(now, code);
    return true;
  }

  // 取消/更换：activation 收尾，卡密**不消耗**。
  // refund: {state, raw} —— 平台侧的退款结论。
  // 只记本地 cancelled 是不够的：平台可能拒绝退款，那笔钱还挂着，
  // 事后对账必须能查出来是哪几笔。
  cancel(activationId, state = 'cancelled', refund = null) {
    const row = this.db.prepare('SELECT * FROM activations WHERE activation_id = ?').get(String(activationId));
    if (!row) return null;
    if (row.state === 'code') throw new Error('已经收到验证码的号不能取消');
    if (row.state === 'cancelled' || row.state === 'failed' || row.state === 'expired') return row;
    this.db.prepare('UPDATE activations SET state = ?, ended_at = ?, refund_state = ?, refund_raw = ? WHERE id = ?')
      .run(state, Date.now(), refund?.state ?? null, refund?.raw ? String(refund.raw).slice(0, 120) : null, row.id);
    return this.db.prepare('SELECT * FROM activations WHERE id = ?').get(row.id);
  }

  // 对账用：钱可能还挂在平台上的那些单子。
  // 三类：退款被平台拒绝 / 号自然过期（本来就不退）/ 崩在取号中途的孤儿。
  listMoneyAtRisk({ sinceMs = 7 * 24 * 60 * 60 * 1000, limit = 200 } = {}) {
    return this.db.prepare(`
      SELECT activation_id, code, country, service, phone, price_usd, price_cny,
             state, refund_state, refund_raw, created_at, ended_at
      FROM activations
      WHERE created_at >= ?
        AND activation_id IS NOT NULL
        AND state <> 'code'
        AND (refund_state IS NULL OR refund_state <> 'refunded')
      ORDER BY created_at DESC LIMIT ?
    `).all(Date.now() - sinceMs, limit).map((row) => ({
      activationId: row.activation_id,
      codeTail: String(row.code).slice(-4),
      country: row.country,
      service: row.service,
      phone: row.phone,
      priceUsd: row.price_usd,
      priceCny: row.price_cny,
      state: row.state,
      refundState: row.refund_state || 'unknown',
      refundRaw: row.refund_raw,
      createdAt: row.created_at,
      endedAt: row.ended_at,
    }));
  }

  // 简单账目汇总：花了多少、退回多少、多少还挂着
  ledgerSummary({ sinceMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
    const since = Date.now() - sinceMs;
    const rows = this.db.prepare(`
      SELECT state, refund_state, COUNT(*) AS n, COALESCE(SUM(price_usd), 0) AS usd
      FROM activations WHERE created_at >= ? AND activation_id IS NOT NULL
      GROUP BY state, refund_state
    `).all(since);
    let spent = 0, refunded = 0, stuck = 0, consumed = 0;
    for (const row of rows) {
      const usd = Number(row.usd) || 0;
      spent += usd;
      if (row.refund_state === 'refunded') refunded += usd;
      else if (row.state === 'code') consumed += usd;
      else stuck += usd;
    }
    const round4 = (n) => Math.round(n * 10000) / 10000;
    return { spentUsd: round4(spent), refundedUsd: round4(refunded), consumedUsd: round4(consumed), atRiskUsd: round4(stuck) };
  }

  // 这张卡一共向平台下过多少个号（含已取消/已过期的）。
  // 花钱的闸门必须用它而不是「取消数」——号自然过期也会写 cancelled，
  // 拿取消数当闸门的话，买家 5 个号全过期、一个码没收到，卡就废了。
  countOrders(code) {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM activations WHERE code = ? AND activation_id IS NOT NULL').get(code);
    return Number(row?.n || 0);
  }

  countChanges(code) {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM activations WHERE code = ? AND state = 'cancelled'").get(code);
    return Number(row?.n || 0);
  }

  listActivations(code) {
    return this.db.prepare('SELECT * FROM activations WHERE code = ? ORDER BY id ASC').all(code);
  }

  // 已经成功收到几次码。只数 state='code' —— 取过又退掉的不算，
  // 那些钱退回来了，不该占次数也不该占钱。
  codesUsed(code) {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM activations WHERE code = ? AND state = 'code'")
      .get(String(code));
    return Number(row?.n || 0);
  }

  // 这张卡真正花掉的钱。同样只算成功收码的那几个号：
  // 换号是全额退回的，把退了的钱算成花掉，等于让买家白白少了余额。
  spentCny(code) {
    const row = this.db.prepare("SELECT SUM(price_cny) AS total FROM activations WHERE code = ? AND state = 'code'")
      .get(String(code));
    return row?.total == null ? 0 : Number(row.total);
  }

  // ---------- 补差价 ----------

  claimTopup({ code, country, needCny }) {
    const now = Date.now();
    // 去重只看「这张卡还有没有一笔待核对的补款」，不再按国家分。
    // 已 confirmed 的**不**拦：余额模型下第一次补的钱可能还不够买更贵的地区，
    // 得允许再补差额。按国家去重会让买家换个国家就得重开一笔，反而更乱。
    const existing = this.db.prepare(`
      SELECT * FROM topups WHERE code = ? AND status = 'claimed' ORDER BY id DESC LIMIT 1
    `).get(code);
    if (existing) return existing;
    // country 仍然记下来，但只是「当时想买哪个地区」的存档，不再参与放行判断

    const info = this.db.prepare(`
      INSERT INTO topups (code, country, need_cny, status, claimed_at) VALUES (?, ?, ?, 'claimed', ?)
    `).run(code, country, Number(needCny), now);
    return this.db.prepare('SELECT * FROM topups WHERE id = ?').get(Number(info.lastInsertRowid));
  }

  // changed 必须返回：WHERE status='claimed' 影响 0 行时照样能 SELECT 回那一行，
  // 调用方判不出来，管理员会以为放行了而买家死活取不了号。
  confirmTopup(id, note = null) {
    const info = this.db.prepare("UPDATE topups SET status = 'confirmed', confirmed_at = ?, note = ? WHERE id = ? AND status = 'claimed'")
      .run(Date.now(), note, id);
    const row = this.db.prepare('SELECT * FROM topups WHERE id = ?').get(id) || null;
    return row ? { ...row, changed: Number(info.changes) > 0 } : null;
  }

  getTopup(id) {
    return this.db.prepare('SELECT * FROM topups WHERE id = ?').get(Number(id)) || null;
  }

  // 支付宝通知到账。**幂等**：支付宝会按 4m/10m/1h/2h/6h/15h 重推 25 小时，
  // 不幂等的话同一笔钱会被反复记成余额，买家花一次钱能取好几个号。
  // 靠 WHERE status='claimed' 保证只有第一次生效，changed 告诉调用方是不是首次。
  markTopupPaid(id, { tradeNo, note = null }) {
    const info = this.db.prepare(`UPDATE topups SET status = 'confirmed', confirmed_at = ?, trade_no = ?, note = ?
      WHERE id = ? AND status = 'claimed'`).run(Date.now(), tradeNo ? String(tradeNo) : null, note, Number(id));
    const row = this.getTopup(id);
    return row ? { ...row, changed: Number(info.changes) > 0 } : null;
  }

  rejectTopup(id, note = null) {
    const info = this.db.prepare("UPDATE topups SET status = 'rejected', confirmed_at = ?, note = ? WHERE id = ? AND status = 'claimed'")
      .run(Date.now(), note, id);
    const row = this.db.prepare('SELECT * FROM topups WHERE id = ?').get(id) || null;
    return row ? { ...row, changed: Number(info.changes) > 0 } : null;
  }

  // 这张卡有没有可用的补款余额。
  // claimed（买家自称付了）不算；用过的也不算——补款仍然是一次性的。
  // 不再按国家分：补的钱进的是卡密余额，哪个地区都能花。
  isTopupConfirmed(code) {
    const row = this.db.prepare(`
      SELECT 1 FROM topups
      WHERE code = ? AND status = 'confirmed' AND consumed_at IS NULL
      LIMIT 1
    `).get(code);
    return Boolean(row);
  }

  // 这张卡已核对到账的补款**总额**。闸门必须用这个数当预算，不能只用布尔量——
  // 否则地区涨价后（$1.2 → $3），差额是卖家在替买家垫，而且没有上限。
  //
  // 要 SUM 不能取最后一笔：余额模型下买家可以分几次补（先补 ¥1 再补 ¥2），
  // 只认最后一笔等于把先补的钱吞掉。
  confirmedTopupCny(code) {
    const row = this.db.prepare(`
      SELECT SUM(need_cny) AS total FROM topups
      WHERE code = ? AND status = 'confirmed' AND consumed_at IS NULL
    `).get(code);
    return row?.total == null ? null : Number(row.total);
  }

  // 收码成功时把这张卡的补款余额全部划掉，防止一次补款被反复使用。
  // 一次划全部而不是划一笔：卡密收到码就作废了，余额跟着一起结束，
  // 留着未消费的行会让后面的对账看起来像还有钱没花。
  consumeTopup(code) {
    const rows = this.db.prepare(`
      SELECT id FROM topups
      WHERE code = ? AND status = 'confirmed' AND consumed_at IS NULL
    `).all(code);
    if (!rows.length) return false;
    const now = Date.now();
    const stmt = this.db.prepare('UPDATE topups SET consumed_at = ? WHERE id = ?');
    for (const row of rows) stmt.run(now, row.id);
    return true;
  }

  listPendingTopups() {
    return this.db.prepare("SELECT * FROM topups WHERE status = 'claimed' ORDER BY id ASC").all();
  }

  // ---------- 临时邮箱 ----------

  // TTL 对齐邮箱后台的 3 天保留期。之前设 24 小时，等于后台信还在、
  // 买家却已经读不到了——白白丢掉两天可用期。
  createMailbox({ address, owner, addressId = null, ip = null, ttlMs = 3 * 24 * 60 * 60 * 1000 }) {
    const now = Date.now();
    this.db.prepare('INSERT OR REPLACE INTO mailboxes (address, owner, ip, address_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(String(address).toLowerCase(), String(owner), ip, addressId, now, now + ttlMs);
    return { address: String(address).toLowerCase(), expiresAt: now + ttlMs };
  }

  // 归属校验：这是安全边界，不是便利功能。少了它 = 任何人能读任何地址的信。
  ownsMailbox(owner, address) {
    if (!owner || !address) return false;
    const row = this.db.prepare('SELECT 1 FROM mailboxes WHERE owner = ? AND address = ? AND expires_at > ?')
      .get(String(owner), String(address).toLowerCase(), Date.now());
    return Boolean(row);
  }

  listMailboxes(owner) {
    return this.db.prepare('SELECT address, created_at, expires_at FROM mailboxes WHERE owner = ? AND expires_at > ? ORDER BY created_at DESC')
      .all(String(owner || ''), Date.now())
      .map((row) => ({ address: row.address, createdAt: row.created_at, expiresAt: row.expires_at }));
  }

  // 限速用：这个 IP 最近开了几个邮箱。免费服务不设限会被人拿去刷爆 Worker 配额。
  // 注销邮箱：先确认归属，再把 address_id 交给调用方去删后台。
  // 本地先删，后台删失败也不回滚——买家的诉求是「这个邮箱别再跟我有关系」，
  // 本地记录没了归属就没了，后台那条记录会自然过期。
  takeMailbox(owner, address) {
    const addr = String(address || '').toLowerCase();
    const row = this.db.prepare('SELECT * FROM mailboxes WHERE owner = ? AND address = ?')
      .get(String(owner || ''), addr);
    if (!row) return null;
    this.db.prepare('DELETE FROM mailboxes WHERE address = ?').run(addr);
    return { address: row.address, addressId: row.address_id || null, owner: row.owner };
  }

  // ---------- 意见反馈 ----------

  addFeedback({ ip, contact, body, cardTail }) {
    const info = this.db.prepare(`
      INSERT INTO feedback (created_at, ip, contact, body, card_tail) VALUES (?, ?, ?, ?, ?)
    `).run(Date.now(), ip || null, contact || null, String(body), cardTail || null);
    return Number(info.lastInsertRowid);
  }

  markFeedbackMailed(id, error = null) {
    this.db.prepare('UPDATE feedback SET mailed_at = ?, mail_error = ? WHERE id = ?')
      .run(Date.now(), error ? String(error).slice(0, 300) : null, id);
  }

  countFeedbackByIp(ip, sinceMs) {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE ip = ? AND created_at >= ?')
      .get(String(ip), Date.now() - Number(sinceMs));
    return Number(row?.n || 0);
  }

  // 全站总量。按 IP 限速在拿不到真实 IP 时会整个退化掉（反代没配好、
  // 或者被摘掉），那时候这个公开的发信接口就是个不限量的垃圾邮件炮。
  // 所以还要有一道跟 IP 无关的总闸。
  countFeedbackSince(sinceMs) {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE created_at >= ?')
      .get(Date.now() - Number(sinceMs));
    return Number(row?.n || 0);
  }

  countMailboxesByIp(ip, sinceMs) {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM mailboxes WHERE ip = ? AND created_at >= ?')
      .get(String(ip || '-'), Date.now() - sinceMs);
    return Number(row?.n || 0);
  }

  // ---------- 防爆破 ----------

  recordAttempt(ip, ok) {
    this.db.prepare('INSERT INTO attempts (ip, ts, ok) VALUES (?, ?, ?)').run(String(ip || '-'), Date.now(), ok ? 1 : 0);
  }

  // 锁定判据：窗口内失败次数达阈值，则从最后一次失败起锁 LOCK_MS。
  ipLockRemainingMs(ip) {
    // 回看要取 max(统计窗口, 锁定时长)。只回看 10 分钟的话，
    // 第 11 分钟那 5 次失败就滑出窗口了，说好的 30 分钟锁实际只锁 10 分钟。
    const lookback = Date.now() - Math.max(ATTEMPT_WINDOW_MS, LOCK_MS);
    const rows = this.db.prepare('SELECT ts, ok FROM attempts WHERE ip = ? AND ts >= ? ORDER BY ts DESC').all(String(ip || '-'), lookback);
    const fails = rows.filter((r) => !r.ok);
    if (fails.length < ATTEMPT_MAX_FAIL) return 0;
    // 找任意一段「窗口内连续失败达阈值」的记录，锁从那段最近一次失败起算
    for (let i = 0; i + ATTEMPT_MAX_FAIL - 1 < fails.length; i += 1) {
      const inWindow = fails[i].ts - fails[i + ATTEMPT_MAX_FAIL - 1].ts <= ATTEMPT_WINDOW_MS;
      const remaining = fails[i].ts + LOCK_MS - Date.now();
      if (inWindow && remaining > 0) return remaining;
    }
    return 0;
  }

  // 定期清理：会话过期的、太久远的尝试记录。跑不跑都不影响正确性。
  sweep({ activationTtlMs = 20 * 60 * 1000 } = {}) {
    const now = Date.now();
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    this.db.prepare('DELETE FROM attempts WHERE ts < ?').run(now - 24 * 60 * 60 * 1000);
    this.db.prepare('DELETE FROM mailboxes WHERE expires_at < ?').run(now);

    // 进程在 reserve 与 fulfill 之间崩掉会留下孤儿占位行，
    // 那张卡会一直被自己的硬闸判成「有号在进行中」而取不了新号。2 分钟够任何一次取号跑完。
    // 标记而不是删除：这条行是「可能已经扣了钱但没退款」的唯一线索
    const stale = this.db.prepare(
      "UPDATE activations SET state = 'failed', ended_at = ? WHERE state = 'reserved' AND created_at < ?",
    ).run(now, now - 2 * 60 * 1000);

    // 号码过期后本地还停在 waiting，同样会把卡卡死。标成 failed 让卡能继续用。
    const expired = this.db.prepare(
      "UPDATE activations SET state = 'failed', ended_at = ? WHERE state = 'waiting' AND created_at < ?",
    ).run(now, now - activationTtlMs);

    return { staleReserved: stale.changes, expiredWaiting: expired.changes };
  }
}

// 比较 shared secret 用定长比较，避免时序侧信道。长度不等直接判否。
export function secretEquals(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

export const CARD_CONSTANTS = { ALPHABET, SESSION_TTL_MS, CARD_TTL_MS, ATTEMPT_WINDOW_MS, ATTEMPT_MAX_FAIL, LOCK_MS };
