// vend-config.js — 对外售卖服务的配置
//
// 刻意跟 Codex Invite Pilot 的 config.js 完全分开：那边管邮箱/自动化/管理员，
// 是安哥自用的；这边只管对买家开放的东西。两边唯一共用的是 HeroSMS 的 key。
//
// 配置优先级：data/vend-config.json（可在管理页改） > 环境变量 > 内置默认值。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(HERE, '..');
export const VEND_CONFIG_PATH = join(PROJECT_ROOT, 'data', 'vend-config.json');
export const VEND_DB_PATH = join(PROJECT_ROOT, 'data', 'vend.sqlite');

// 面额档位：闲鱼多规格商品的 spec_value 映射到卡密面额。
// 键要跟闲鱼后台商品规格里填的文字**一模一样**，否则回调发不出对的卡。
const DEFAULT_DENOMS = {
  '基础卡': 1.9,
  '美国卡': 6.9,
};

const DEFAULTS = {
  port: 8788,
  host: '127.0.0.1',
  // 人民币价 = HeroSMS 报价($) × rate。毛利率 = 1 − 汇率/rate（汇率按 $1≈¥7.2）。
  //
  // 2026-08-23 由 10（28% 毛利）下调到 9（20% 毛利）。安哥定的，理由是这是引流品。
  //
  // 关键在于 rate **同时**决定预算和展示价：
  //   budgetUsd = 面额 / rate      展示价CNY = 上游价 × rate
  // 所以「展示价 ≤ 面额」和「上游价 ≤ 预算」是同一个条件，两边永远一致。
  // 降 rate = 卡价不动、买家能选的档位变多、展示价还更低。
  //
  // 实测（泰国 OpenAI，¥1.9 卡）：
  //   rate=10 → 预算 $0.1900 → 2 档 / 1507 个号
  //   rate=9  → 预算 $0.2111 → 3 档 / 6393 个号
  // 便宜档号少是因为它就是回收复用池，能选的档位越多，撞到「已被使用」的概率越低。
  //
  // 改这个数直接改毛利，动之前先算：毛利率 = 1 − 7.2/rate。
  rate: 9,
  service: 'dr',
  defaultDenomCny: 1.9,
  denomsBySpec: DEFAULT_DENOMS,
  // 号码有效期，用于前端倒计时。HeroSMS getNumber 不返回到期时间，
  // 这是个约定值，不是平台承诺——真要准得改用 getNumberV2 读 activationTime。
  activationTtlSec: 20 * 60,
  pollIntervalSec: 5,
  // 一张卡最多换几次号。null = 不限次数，只受号码有效期约束。
  //
  // 上游没有次数限制（换号 = 退旧号 + 取新号），但有一条硬约束：
  // **下单约 90 秒内不允许取消**（返回 EARLY_CANCEL_DENIED，实测过）。
  // 所以「不限次数」实际节奏是每次至少隔 90 秒，20 分钟内约 13 次封顶——
  // 这是上游的物理限制，不是我们设的闸，文案不能承诺成真·无限。
  maxChanges: null,
  // 取号时跳过最便宜的前几档报价。
  //
  // 为什么要跳：最低档往往是**回收复用号池**。实测泰国 OpenAI 的档位分布是
  // $0.11 只有 28 个号、$0.1724 有 1156 个、$0.1925 有 5239 个 ——
  // 最低档号少得离谱，因为它就是被反复用过的那一批，
  // 拿去注册会直接被判「该号码已被使用」，买家白等一轮。
  //
  // 代价是毛利变薄：跳一档等于成本涨一档，而页面上给买家看的价仍是最低档的价
  // （minPrice 来自平台的国家列表接口，不受这里影响）。这是刻意的取舍 ——
  // 展示价不变只影响我们的毛利，改展示价会让整站看起来涨价。
  //
  // **不要调到 2 以上**：泰国 OpenAI 第 3 档 $0.1925 已经超过 ¥1.9 卡的 $0.19 预算，
  // 跳两档会让基础卡在这个组合上直接买不到号（会退回原列表，但那就白跳了）。
  skipCheapestTiers: 1,
  // 注意是 /alipay-qr.jpg 而不是 /vend/alipay-qr.jpg：
  // vend 服务的静态根目录就是 public/vend，再带一层 /vend 会 404
  // 竖版原图塞进 132x132 的方框会被裁成一块蓝色，买家根本扫不到码。
  // -sq 是用 scripts 按码本体重新裁出来的正方形版本（留足 QR 静默区）。
  alipayQrUrl: '/alipay-qr-sq.jpg',

  // 临时邮箱有效期。页面文案和后端存活时间都读这一处，别再各写各的。
  mailTtlDays: 3,
  contactNote: '',
};

function readJsonFile(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    // 配置文件损坏时宁可用默认值继续跑，也不要整个服务起不来
    console.warn(`[vend-config] ${path} 解析失败，改用默认配置：${error.message}`);
    return {};
  }
}

function readEnvOverrides() {
  const out = {};
  if (process.env.VEND_PORT) out.port = Number(process.env.VEND_PORT);
  if (process.env.VEND_HOST) out.host = String(process.env.VEND_HOST);
  if (process.env.VEND_RATE) out.rate = Number(process.env.VEND_RATE);
  if (process.env.VEND_SERVICE) out.service = String(process.env.VEND_SERVICE);
  if (process.env.VEND_DEFAULT_DENOM) out.defaultDenomCny = Number(process.env.VEND_DEFAULT_DENOM);
  if (process.env.VEND_SKIP_CHEAPEST_TIERS) {
    out.skipCheapestTiers = Number(process.env.VEND_SKIP_CHEAPEST_TIERS);
  }
  return out;
}

// 密钥只从环境变量读，绝不落进可通过管理页读写的 JSON，也绝不返回给浏览器。
export function readSecrets() {
  return {
    // 闲鱼 api 卡券回调发卡时要带的 shared secret。没配 = 发卡接口直接关闭。
    issueSecret: process.env.VEND_ISSUE_SECRET || '',
    // 管理页（补差价核对、发卡）的口令。没配 = 管理接口直接关闭。
    adminToken: process.env.VEND_ADMIN_TOKEN || '',
    // 邀请 worker（跑在另一台机器上）拉任务用的口令。没配 = worker 接口直接关闭。
    inviteWorkerSecret: process.env.INVITE_WORKER_SECRET || '',
  };
}

let cache = null;

export function loadVendConfig({ force = false } = {}) {
  if (cache && !force) return cache;
  const fromFile = readJsonFile(VEND_CONFIG_PATH);
  const fromEnv = readEnvOverrides();
  const merged = { ...DEFAULTS, ...fromEnv, ...fromFile };

  // 兜底校验：这些值错了会直接影响算钱，宁可回落默认也不能带病运行
  if (!Number.isFinite(merged.rate) || merged.rate <= 0) merged.rate = DEFAULTS.rate;
  if (!Number.isFinite(merged.defaultDenomCny) || merged.defaultDenomCny <= 0) {
    merged.defaultDenomCny = DEFAULTS.defaultDenomCny;
  }
  if (!Number.isInteger(merged.port) || merged.port <= 0) merged.port = DEFAULTS.port;
  if (!merged.denomsBySpec || typeof merged.denomsBySpec !== 'object') {
    merged.denomsBySpec = { ...DEFAULT_DENOMS };
  }
  // 跳档数只接受 0~3 的整数。配成负数或小数会让 slice 行为变得不可预测，
  // 配成大数等于把所有便宜档全跳掉，成本直接翻几倍 —— 都当配置错误处理。
  const skip = Number(merged.skipCheapestTiers);
  merged.skipCheapestTiers = Number.isInteger(skip) && skip >= 0 && skip <= 3
    ? skip
    : DEFAULTS.skipCheapestTiers;

  cache = merged;
  return cache;
}

export function saveVendConfig(patch) {
  const current = loadVendConfig();
  const next = { ...current, ...patch };
  // 不允许把密钥写进配置文件
  delete next.issueSecret;
  delete next.adminToken;
  mkdirSync(dirname(VEND_CONFIG_PATH), { recursive: true });
  writeFileSync(VEND_CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  cache = null;
  return loadVendConfig({ force: true });
}

// 闲鱼订单规格 → 卡密面额。匹配不上就回落默认面额，并把情况报给调用方记日志，
// 不能静默按默认发卡（买家买的是美国卡却拿到基础卡就是纠纷）。
export function denomForSpec(specValue) {
  const config = loadVendConfig();
  const key = String(specValue ?? '').trim();
  if (key && Object.prototype.hasOwnProperty.call(config.denomsBySpec, key)) {
    return { denomCny: Number(config.denomsBySpec[key]), matched: true, spec: key };
  }
  return { denomCny: config.defaultDenomCny, matched: false, spec: key };
}

export const VEND_DEFAULTS = DEFAULTS;
