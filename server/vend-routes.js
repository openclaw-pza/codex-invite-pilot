// vend-routes.js — 对买家开放的接口
//
// 安全边界（这些接口会挂在公网上，每一条都当外网来写）：
//   · 除了 /api/vend/meta 和卡密校验，其余全部要 token；token 由校验卡密换来
//   · 任何返回给浏览器的数据里都不出现 HeroSMS 的 api_key、不出现管理员口令
//   · 取号会扣真钱，所以下单前必须过三道闸：卡密有效 → 没有进行中的号 → 地区在额度内
//   · 管理接口未配置口令时直接当不存在（返回 404），不给外面探测的机会

import { checkRegionAllowed, priceRegions, maxPriceUsdFor, round2, usdToCny } from './pricing.js';
import { loadVendConfig, denomForSpec, readSecrets } from './vend-config.js';
import { getCatalog, getShowcase, catalogFetchedAt } from './vend-catalog.js';
import { createAddress, listMails, deleteMail, deleteAddress } from './cloudflareEmail.js';
import { randomUUID } from 'node:crypto';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { sendMail, smtpConfigFromEnv } from './smtpMail.js';
import { buildPayUrl, checkNotify, alipayConfigFromEnv } from './alipay.js';
import { secretEquals } from './cards.js';
import { githubMeta } from './githubStars.js';
import { createInviteRoutes } from './inviteRoutes.js';
import {
  fetchAvailableCountries,
  fetchPriceQuotes,
  getStatus,
  vendGetNumberTiered,
  vendCancelNumber,
  vendFinishNumber,
  friendlyHeroError,
} from './vend-hero.js';

// 地区列表要打 HeroSMS 两个接口，不能每个买家刷新一次就打一次。
const REGION_CACHE_TTL_MS = 60_000;
const regionCache = new Map(); // service -> {at, data}

async function loadRegions(service) {
  const cached = regionCache.get(service);
  if (cached && Date.now() - cached.at < REGION_CACHE_TTL_MS) return cached.data;
  const fresh = await fetchAvailableCountries({ service });
  regionCache.set(service, { at: Date.now(), data: fresh });
  return fresh;
}

// 价格档位缓存。取号时才用得上（比列地区低频得多），缓存短一点保证价格新鲜。
const QUOTE_CACHE_TTL_MS = 30_000;
const quoteCache = new Map(); // `${service}:${country}` -> {at, prices}

// 缓存整条报价（价格 + 该档剩余号数）。只缓存价格是不够的：
// 价位选择要把「这档还剩多少个号」摆给买家看 —— 最便宜那档常常只有几十个，
// 那正是回收号池的信号，买家看得到才知道为什么该多花两毛钱。
async function loadQuotes(service, country) {
  const key = `${service}:${country}`;
  const cached = quoteCache.get(key);
  if (cached && Date.now() - cached.at < QUOTE_CACHE_TTL_MS) return cached.quotes;
  try {
    const data = await fetchPriceQuotes({ service, country });
    const quotes = (data.quotes || [])
      .map((entry) => ({ price: Number(entry.price), count: Number(entry.count) || 0 }))
      .filter((entry) => entry.price > 0)
      .sort((a, b) => a.price - b.price);
    quoteCache.set(key, { at: Date.now(), quotes });
    return quotes;
  } catch {
    // 报价接口拿不到就交给调用方回退到「按预算出价」，别因为这个直接取不了号
    return [];
  }
}

async function loadTiers(service, country) {
  return (await loadQuotes(service, country)).map((entry) => entry.price);
}

export function clearRegionCache() {
  regionCache.clear();
  quoteCache.clear();
}

// 业务错误：会被原样翻译给买家看，所以 message 必须是人话。
class VendError extends Error {
  constructor(message, status = 400, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const CARD_REASON_TEXT = {
  not_found: '卡密不存在，请检查有没有输错',
  used: '这张卡密已经用过了，一张卡密只能成功收一次验证码',
  void: '这张卡密已注销。请回到你下单的平台联系卖家退款，把卡密后四位发给他即可',
  already_active: '这张卡密已经有一个号在进行中了，先收码或取消再取新号',
  // 过期是我们自己定的规则，所以话要说全：多久有效、现在该怎么办。
  // 只说「已过期」会让买家觉得是被坑了，必然来吵。
  expired: '这张卡密已过期。卡密自发出起 1 小时内有效，超时自动失效。请回到你下单的平台联系卖家处理',
};

// 免费临时邮箱的额度：每 IP 每小时几个、每人最多留几个
const MAIL_PER_IP_HOUR = 5;
// 意见反馈是**不需要卡密**就能调的公开接口，等于一个发信入口。
// 不限速就会被拿去刷邮件，把 QQ 邮箱的发信配额刷爆、顺带把真意见淹掉。
const FEEDBACK_PER_IP_HOUR = 3;
// 跟 IP 无关的总闸。按 IP 那道在拿不到真实 IP 时会整个退化成不限速 ——
// 对验卡密来说退化是对的（别把付了钱的买家锁在外面），
// 但这是个**不需要卡密就能触发发信**的接口，退化开放等于把邮箱送人刷。
// 真实反馈量一小时到不了 40 条，这个数只挡机器不挡人。
const FEEDBACK_PER_HOUR_TOTAL = 40;
const FEEDBACK_MAX_LEN = 1000;
const MAIL_PER_OWNER = 5;

// 号码拆成「区号 + 本地号码」。有些注册页的号码栏要求去掉区号单独填，
// 不标出来买家只能自己猜从哪儿切。
//
// 必须从号码本身解析，不能按下单时选的国家去推：区号有 1~4 位
// （+1 / +66 / +852 / +1876），上游偶尔还会发别的国家的号。
// 上游给的 phone 不带 +，补上再交给 libphonenumber-js。解析不出来就返回空，
// 前端整串显示 —— 宁可少一个便利，也不能把号码切错让买家填错。
export function splitPhone(raw) {
  const phone = String(raw || '').trim();
  if (!phone) return { dialCode: '', nationalNumber: '' };
  const parsed = parsePhoneNumberFromString(phone.startsWith('+') ? phone : `+${phone}`);
  return {
    dialCode: parsed?.countryCallingCode || '',
    nationalNumber: parsed?.nationalNumber || '',
  };
}

export function createVendRoutes({ store }) {
  const secrets = readSecrets();

  // ---------- 口令爆破闸 ----------
  // 管理口令和发卡 secret 原来没有任何锁定，实测能跑到 1700 次/秒。
  // 口令一旦被爆出来，攻击者就能自己造卡、自己确认自己的补差价，全是你付钱。
  const secretFails = new Map(); // ip -> {n, until}

  function secretGate(ip) {
    const record = secretFails.get(ip);
    if (record && record.until > Date.now()) {
      throw new VendError('操作太频繁，请稍后再试', 429, 'too_many');
    }
  }
  function secretFail(ip) {
    const record = secretFails.get(ip) || { n: 0, until: 0 };
    record.n += 1;
    // 第 5 次失败起指数退避，封顶 5 分钟
    if (record.n >= 5) record.until = Date.now() + Math.min(2 ** (record.n - 5), 300) * 1000;
    secretFails.set(ip, record);
    if (secretFails.size > 5000) secretFails.clear(); // 防内存被打爆
  }
  function secretOk(ip) { secretFails.delete(ip); }

  // ---------- 公共工具 ----------

  // allowUsed 只给查状态用：验证码只发一次，买家刷新一下就永远拿不回来，
  // 那是必然的退款账。已消耗的卡仍要能读回自己的验证码，但不能再花钱。
  function requireSession(token, { allowUsed = false } = {}) {
    const found = store.resolveSession(token);
    if (!found) throw new VendError('登录状态已过期，请重新输入卡密', 401, 'session_expired');
    if (found.card.status === 'used' && !allowUsed) throw new VendError(CARD_REASON_TEXT.used, 409, 'used');
    if (found.card.status === 'void') throw new VendError(CARD_REASON_TEXT.void, 409, 'void');
    // 会话创建时已经按卡的有效期封过顶，正常走不到这里；
    // 但老会话 + 后补的 expires_at 这种组合能绕过去，所以这里再挡一道。
    if (found.card.expires_at && Date.now() > found.card.expires_at) {
      throw new VendError(CARD_REASON_TEXT.expired, 409, 'expired');
    }
    return found;
  }

  // 商户订单号。要能从它反查回补款单，所以把 id 编进去；
  // 后面缀一个时间戳是因为同一笔补款重新发起时，支付宝不允许复用已关闭的订单号。
  function outTradeNoFor(topup) {
    return `V${topup.id}T${Date.now().toString(36)}`;
  }

  function topupIdFromOutTradeNo(value) {
    const m = /^V(\d+)T/.exec(String(value || ''));
    return m ? Number(m[1]) : null;
  }

  // 手机浏览器要跳「手机网站支付」，PC 跳「电脑网站支付」。
  // 跳错了手机上会看到一个唤不起支付宝 App 的收银台，买家只能放弃。
  function isMobile(headers) {
    return /Mobile|Android|iPhone|iPad/i.test(String(headers?.['user-agent'] || ''));
  }

  // 闸门要的三项预算输入。**必须一起传**，漏一项就会漂：
  //   · 漏 spentCny  → 多次收码的卡每次都能花满面额，¥3.99 的卡花掉 ¥11.97，一单亏 ¥4.6
  //   · 漏 topupPaid → 补过差价的买家被重复要钱
  // 所以打包成一个函数，调用方不给机会漏。
  function budgetInputs(card) {
    return {
      denomCny: card.denom_cny,
      topupPaidCny: store.confirmedTopupCny(card.code),
      spentCny: store.spentCny(card.code),
    };
  }

  // 买家手选的价位下限。这个数会直接决定花多少钱，所以按「不可信输入」处理：
  // 非数字 / 负数 / 0 一律当没选（回到自动逐档），**不报错** ——
  // 报错会让一次点击变成一个死胡同，而回到自动逐档是安全且有用的行为。
  // 上限不在这里判：真超预算时 vendGetNumberTiered 的预算过滤会挡住，
  // 那道闸是唯一的红线，不要在两处各判一遍（判漏一处就是超预算出价）。
  function parseMinPrice(raw) {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  // 这张卡还剩多少钱（给展示用：快照、地区列表）。
  // 跟上面那个是同一套算法，只是一个给闸门算、一个直接出数。
  function cardBalanceCny(card) {
    if (!card) return null;
    const { denomCny, topupPaidCny, spentCny } = budgetInputs(card);
    return round2(Number(denomCny) + (topupPaidCny || 0) - (spentCny || 0));
  }

  // 把内部的 activation 行整理成前端要的形状。绝不外泄 HeroSMS 的原始报错。
  function publicActivation(row, config) {
    if (!row) return null;
    const expiresAt = row.created_at + config.activationTtlSec * 1000;
    const { dialCode, nationalNumber } = splitPhone(row.phone);
    return {
      phone: row.phone || null,
      dialCode,
      nationalNumber,
      country: row.country,
      service: row.service || null,
      state: row.state === 'reserved' ? 'waiting' : row.state,
      smsCode: row.sms_code || null,
      smsText: row.sms_text || null,
      priceCny: row.price_cny == null ? null : round2(row.price_cny),
      startedAt: row.created_at,
      expiresAt,
      remainingMs: Math.max(0, expiresAt - Date.now()),
    };
  }

  function snapshot(card, config) {
    const live = store.getLiveActivation(card.code);
    const last = store.listActivations(card.code).slice(-1)[0] || null;
    return {
      denomCny: round2(card.denom_cny),
      // 卡的到期时间要给前端 —— 买家得看得见还剩多久，不然超时了只会觉得是我们坑他。
      // null = 规则上线前的老卡，永不过期。
      cardExpiresAt: card.expires_at || null,
      service: card.service,
      lockedService: card.locked_service || null,
      status: card.status,
      changes: store.countChanges(card.code),
      // null = 号码有效期内不限次数换号
      maxChanges: config.maxChanges,
      // 前端用这两个数判断「还能不能再试」，试完了就把注销退款的入口顶到前面
      orders: store.countOrders(card.code),
      maxOrders: config.maxChanges == null ? null : Number(config.maxChanges) + 1,
      refundState: card.refund_state || null,
      // 多次收码的卡：还能收几次、还剩多少钱。
      // 两个都要给 —— 次数没用完但余额买不动任何地区，是真会发生的状态，
      // 只报次数会让买家以为还能用，只报余额又看不出还剩几次。
      maxCodes: Math.max(1, Number(card.max_codes) || 1),
      codesUsed: store.codesUsed(card.code),
      balanceCny: cardBalanceCny(card),
      activation: publicActivation(live || last, config),
    };
  }

  // 取号 / 换号共用的下单流程。占坑 → 调平台 → 回填；任何一步失败都把坑放掉。
  // 卡密锁定了服务就只能用那个；没锁才轮到买家选。
  // 锁是从闲鱼卡券参数里的 service 带过来的 —— 卖家在后台填了就该生效。
  function resolveService(card, wanted, config) {
    const locked = card?.locked_service || null;
    if (!locked) return String(wanted || card?.service || config.service);
    const asked = String(wanted || '').trim();
    if (asked && asked !== locked) {
      throw new VendError('这张卡密只能取指定服务的号码', 400, 'service_locked');
    }
    return locked;
  }

  async function placeOrder({ card, countryId, config, service, minPriceUsd = 0 }) {
    // 服务由买家在页面上选，不再写死成卡密发出时的那个。
    // 卡密只管「值多少钱」，买什么服务的号由价格闸门把关就够了。
    // 例外：卖家在闲鱼卡券里指定了 service 的话，这张卡就锁死在那个服务上。
    const svc = resolveService(card, service, config);
    const regionData = await loadRegions(svc);
    const region = regionData.countries.find((c) => Number(c.id) === countryId);
    if (!region) throw new VendError('这个地区暂时不可用，换一个试试', 400, 'region_unavailable');

    const gate = checkRegionAllowed({ region, rate: config.rate, ...budgetInputs(card) });
    if (!gate.allowed) {
      if (gate.reason === 'need_topup') {
        throw new VendError(
          `这个地区要 ¥${gate.priceCny.toFixed(2)}，超出卡密余额 ¥${Number(gate.budgetCny).toFixed(2)}，需要补 ¥${gate.topupCny.toFixed(2)}`,
          402,
          'need_topup',
        );
      }
      throw new VendError('这个地区当前不能取号，换一个试试', 400, gate.reason || 'not_allowed');
    }

    // 总下单数封顶。数「取消数」是不行的：号自然过期也写 cancelled，
    // 买家 5 个号全过期、一个码都没收到，卡就被自己的闸门废掉了，必然退款。
    // maxChanges 为 null（不限次数）时，仍留一个很宽的硬上限兜底：
    // 真出现脚本刷号，不能让它无限跑下去把上游账号刷出风控。
    const orderCap = config.maxChanges == null ? 60 : Number(config.maxChanges) + 1;
    if (store.countOrders(card.code) >= orderCap) {
      throw new VendError(`这张卡密最多取 ${orderCap} 个号，已经用完了，请联系卖家`, 409, 'max_orders');
    }

    // 先占坑。撞闸说明这张卡已经有号在跑——在花钱之前就挡住。
    const reservation = store.reserve({ code: card.code, country: countryId, service: svc });
    if (!reservation.ok) {
      throw new VendError(CARD_REASON_TEXT[reservation.reason] || '当前不能取号', 409, reservation.reason);
    }

    // 预算上限 = **卡密当前剩余余额**换算成美元。这是绝对红线，出价永远不越过它。
    // 直接用闸门算好的 budgetCny（面额 + 已核对补款 − 已花），不要在这里
    // 拿面额和补款重新拼一遍 —— 拼漏一项（比如已花）就是每次都能花满面额。
    const budgetUsd = maxPriceUsdFor({
      denomCny: gate.budgetCny,
      rate: config.rate,
      topupCny: 0,
    });
    // 算不出上限时 vendGetNumber 会**完全不带 maxPrice** 发出去，等于不限价买
    if (!(budgetUsd > 0)) {
      store.releaseReservation(reservation.reservationId);
      throw new VendError('这个地区暂时不能取号，换一个试试', 400, 'no_price_cap');
    }

    // 从低到高逐档试，直到买到号或超预算。
    // 直接按预算出价成功率一样但会买贵；只按最低报价出价则最低档卖光就失败。
    // 逐档兼顾两头，且失败的 getNumber 不扣费，多试几档只是多花几百毫秒。
    const tiers = await loadTiers(svc, countryId);
    let result;
    try {
      result = await vendGetNumberTiered({
        service: svc,
        country: countryId,
        tiers: tiers.length ? tiers : [region.minPrice],
        budgetUsd,
        // 跳掉最便宜的回收号池档位。只有一档报价（回退到 minPrice）时不跳，
        // 否则唯一的候选被跳掉又被兜底加回来，白绕一圈。
        skipCheapest: tiers.length > 1 ? config.skipCheapestTiers : 0,
        minPriceUsd,
      });
    } catch (error) {
      store.releaseReservation(reservation.reservationId);
      throw new VendError(friendlyHeroError(error?.message), 502, 'hero_error');
    }

    if (!result.ok) {
      // 平台没给号 = 没扣钱，把坑放掉让买家能马上换个地区重试
      store.releaseReservation(reservation.reservationId);
      throw new VendError(result.message, 502, 'hero_no_number');
    }

    try {
      store.fulfill(reservation.reservationId, {
        activationId: result.number.activationId,
        phone: result.number.phone,
        // 记的是实际成交的那一档，不是展示价也不是预算上限——对账要用这个数
        priceUsd: result.paidUsd ?? budgetUsd,
        priceCny: gate.priceCny,
      });
    } catch (error) {
      // 占位行被并发的 cancel/change 删掉了。号已经买到、钱已经花了，
      // 这里不主动退回平台，它就是个没人管的孤儿号，永远不会退款。
      vendCancelNumber(result.number.activationId).catch(() => {});
      console.warn(`[vend] 占位丢失，已尝试退回 ${result.number.activationId}：${error?.message}`);
      throw new VendError('刚才的操作和取号撞在一起了，费用已退回，请重试', 409, 'reservation_lost');
    }
    return store.getLiveActivation(card.code);
  }

  // 占位行超过这个时间还没回填，就当那次下单请求已经死了，允许买家自己解开
  const RESERVING_GRACE_MS = 90_000;

  // 收掉当前这个号：先向平台退款，**确认平台侧确实了结**了再动本地状态。
  // 顺序反过来（本地先标 cancelled 再不管平台结果）= 本地以为退了、平台其实没退，
  // 这张卡马上又买一个号，卖家为同一次交易付两次钱，而且日志里没有任何线索。
  async function releaseLive(live, reason = 'cancelled') {
    if (!live.activation_id) {
      if (Date.now() - live.created_at < RESERVING_GRACE_MS) {
        throw new VendError('正在取号中，请等几秒再试', 409, 'reserving');
      }
      // 超过宽限期的占位：那次下单多半已经死了。放掉让买家自救，
      // 但要留日志——这条可能是「已扣费未退款」，需要人工核对。
      console.warn(`[vend] 回收陈旧占位 id=${live.id} 卡=${live.code}（可能已扣费未退款，需人工核对）`);
      store.releaseReservation(live.id);
      return;
    }

    let outcome;
    try {
      outcome = await vendCancelNumber(live.activation_id);
    } catch (error) {
      console.warn(`[vend] 取消 ${live.activation_id} 出错：${error?.message}`);
      outcome = { refunded: false, settled: false, raw: String(error?.message || '') };
    }
    if (!outcome.settled) {
      // 平台明确拒绝（比如刚下单几分钟内不许取消）。钱还挂在这个号上，
      // 本地绝不能标成已取消——那等于凭空多花一个号的钱。
      console.warn(`[vend] 平台没退成 ${live.activation_id}：${outcome.raw}，本地状态保持不动`);
      throw new VendError('这个号暂时退不了（平台限制），请过 1~2 分钟再试', 409, 'refund_denied');
    }
    // 把平台的退款结论一并落库，供对账。
    // settled 但没 refunded 的情况：号本来就不在了（NO_ACTIVATION），钱不会回来。
    store.cancel(live.activation_id, reason, {
      state: outcome.refunded ? 'refunded' : 'denied',
      raw: outcome.raw,
    });
  }

  // ---------- 买家接口 ----------

  // 收件轮询限速：免费邮箱最容易被脚本挂着刷，Cloudflare 免费额度是
  // 每天 10 万请求，一个死循环就能刷爆，把安哥自己的 Codex 邀请工具一起搞挂。
  // 按 owner 限：2 秒一次，允许攒 5 次的突发（正常前端 3 秒轮询一次够用）。
  const pollBuckets = new Map();
  const POLL_INTERVAL_MS = 2000;
  const POLL_BURST = 5;
  function checkPollQuota(owner) {
    const now = Date.now();
    if (pollBuckets.size > 5000) {
      // 别让这张表无限长：清掉已经攒满的（等于没在用的）
      for (const [key, value] of pollBuckets) {
        if (now - value.at > POLL_INTERVAL_MS * POLL_BURST) pollBuckets.delete(key);
      }
    }
    const bucket = pollBuckets.get(owner) || { tokens: POLL_BURST, at: now };
    const gained = (now - bucket.at) / POLL_INTERVAL_MS;
    const tokens = Math.min(POLL_BURST, bucket.tokens + gained);
    if (tokens < 1) {
      pollBuckets.set(owner, { tokens, at: now });
      throw new VendError('刷太快了，等两秒再试', 429, 'poll_rate');
    }
    pollBuckets.set(owner, { tokens: tokens - 1, at: now });
  }

  // 归属校验是硬边界：后台接口能读任意地址，少了这一步就是人人可读别人的信。
  // 所有邮箱接口都必须先过这里。
  function requireMailbox(owner, address) {
    const addr = String(address || '').toLowerCase();
    if (!store.ownsMailbox(String(owner || ''), addr)) {
      throw new VendError('这个邮箱不属于你，或者已经过期了', 403, 'not_owner');
    }
    return addr;
  }

  const routes = [
    {
      method: 'GET',
      path: '/api/vend/meta',
      // 首屏用，不需要卡密。只暴露展示用的常量，不含任何密钥。
      handler: async () => {
        const config = loadVendConfig();
        return {
          rate: config.rate,
          service: config.service,
          pollIntervalSec: config.pollIntervalSec,
          activationTtlSec: config.activationTtlSec,
          maxChanges: config.maxChanges,
          mailTtlDays: config.mailTtlDays,
          alipayQrUrl: config.alipayQrUrl,
          // 支付宝配齐了没。前端据此决定弹窗走「跳转付款」还是「扫码+人工核对」——
          // 让后端说了算，前端不去猜；配到一半时必须算「没配」，
          // 否则买家点了付款按钮拿到空链接，比压根没这个按钮更糟。
          alipayAuto: Boolean(alipayConfigFromEnv()),
          contactNote: config.contactNote,
          // 顶栏 GitHub star 按钮。没配 GITHUB_REPO 就是 null，前端据此不渲染。
          github: await githubMeta(),
        };
      },
    },

    {
      method: 'POST',
      path: '/api/vend/card/verify',
      handler: async ({ body, ip }) => {
        const config = loadVendConfig();
        // 拿不到买家真实 IP 时（反代后面又没配 VEND_TRUST_PROXY），
        // 所有买家会算成同一个人：一个人输错 5 次就把全站锁 30 分钟。
        // 刚花钱买卡的人第一次输入就被拒，只会当场退款差评，所以这条限速必须退化。
        const ipReliable = ip !== 'unreliable-ip';
        if (ipReliable) {
          const lockMs = store.ipLockRemainingMs(ip);
          if (lockMs > 0) {
            throw new VendError(
              `试错次数太多，已暂停 ${Math.ceil(lockMs / 60000)} 分钟。卡密是 ANGE 开头的那一串，整段消息一起粘贴也行；确认没错请回下单平台联系卖家`,
              429,
              'locked',
            );
          }
        }

        const code = String(body?.code || '').trim().toUpperCase();
        if (!code) throw new VendError('请输入卡密', 400, 'empty');

        const result = store.verifyCard(code);
        if (ipReliable) store.recordAttempt(ip, result.ok);
        if (!result.ok) {
          throw new VendError(CARD_REASON_TEXT[result.reason] || '卡密不可用', 400, result.reason);
        }

        const session = store.createSession(code, ip);
        return { token: session.token, expiresAt: session.expiresAt, ...snapshot(result.card, config) };
      },
    },

    // ---------- 意见反馈 ----------
    {
      method: 'POST',
      path: '/api/vend/feedback',
      handler: async ({ body, ip }) => {
        const text = String(body?.text ?? '').trim();
        if (text.length < 5) throw new VendError('说得再具体一点吧，至少 5 个字', 400, 'too_short');
        if (text.length > FEEDBACK_MAX_LEN) {
          throw new VendError(`最多 ${FEEDBACK_MAX_LEN} 个字，说重点就行`, 400, 'too_long');
        }
        // 拿不到真实 IP 时（反代没配好）按 IP 那道放宽，别误伤真实用户
        if (ip !== 'unreliable-ip' && store.countFeedbackByIp(ip, 60 * 60 * 1000) >= FEEDBACK_PER_IP_HOUR) {
          throw new VendError('提交太频繁了，一小时后再来', 429, 'feedback_rate');
        }
        // 总闸不放宽 —— IP 那道退化时，这里是唯一还站着的
        if (store.countFeedbackSince(60 * 60 * 1000) >= FEEDBACK_PER_HOUR_TOTAL) {
          throw new VendError('反馈通道暂时忙，晚点再来', 429, 'feedback_busy');
        }
        const contact = String(body?.contact ?? '').trim().slice(0, 100);
        const cardTail = String(body?.cardTail ?? '').trim().slice(0, 8) || null;

        // 先落库。买家看到「已提交」的那一刻，这条意见就必须已经存下来了。
        const id = store.addFeedback({ ip, contact, body: text, cardTail });

        // 再发信，而且**不等它**：SMTP 最长要 15 秒，让买家干等一个跟他无关的握手，
        // 只会让他以为页面卡死然后重复点。发失败了库里有记录，也记了原因。
        const smtp = smtpConfigFromEnv();
        if (smtp) {
          const lines = [
            `时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
            `来源 IP：${ip}`,
            contact ? `联系方式：${contact}` : '联系方式：（没留）',
            cardTail ? `卡密后 4 位：${cardTail}` : '卡密：（未验证卡密时提交）',
            '',
            text,
          ];
          sendMail({
            ...smtp,
            subject: `【取号站】买家意见 #${id}`,
            text: lines.join('\n'),
          })
            .then(() => store.markFeedbackMailed(id))
            .catch((error) => {
              console.error(`[vend] 意见 #${id} 发信失败：${error.message}`);
              store.markFeedbackMailed(id, error.message);
            });
        } else {
          console.warn(`[vend] 意见 #${id} 已落库，但没配 FEEDBACK_SMTP_* 所以没发信`);
        }
        return { id };
      },
    },

    // ---------- 临时邮箱（免费福利）----------
    {
      method: 'POST',
      path: '/api/mail/create',
      handler: async ({ body, ip }) => {
        const config = loadVendConfig();
        // 免费服务必须限速，否则会被人拿去把 Cloudflare Worker 配额刷爆。
        // 拿不到真实 IP 时（反代没配好）放宽，别误伤真实用户。
        if (ip !== 'unreliable-ip' && store.countMailboxesByIp(ip, 60 * 60 * 1000) >= MAIL_PER_IP_HOUR) {
          throw new VendError(`每小时最多开 ${MAIL_PER_IP_HOUR} 个临时邮箱，请稍后再来`, 429, 'mail_rate');
        }
        const owner = String(body?.owner || '').trim() || randomUUID().replace(/-/g, '');
        if (store.listMailboxes(owner).length >= MAIL_PER_OWNER) {
          throw new VendError(`你已经有 ${MAIL_PER_OWNER} 个临时邮箱了，够用了`, 429, 'mail_quota');
        }
        // 自选前缀：后台重名会返回 400，先到先得，抢不走别人已有的邮箱。
        // 后台还会强制加 tmp 前缀并剥掉 - . _，所以实际地址一律以返回值为准。
        const wanted = String(body?.name || '').trim();
        let created;
        try {
          created = await createAddress({ name: wanted });
        } catch (error) {
          const message = String(error?.message || '');
          // 前缀不合法 / 被占用 —— 这是买家能自己解决的，要如实说
          if (/前缀|已存在|exists/i.test(message)) {
            throw new VendError(
              /已存在|exists/i.test(message) ? '这个前缀被人用了，换一个' : message,
              400,
              'mail_name',
            );
          }
          console.warn(`[vend] 建临时邮箱失败：${message}`);
          throw new VendError('临时邮箱服务暂时不可用，稍后再试', 502, 'mail_unavailable');
        }
        const saved = store.createMailbox({
          address: created.address,
          addressId: created.addressId,
          owner,
          ip,
          // 有效期由配置说了算，别让 cards.js 的默认参数和页面文案各写各的
          ttlMs: config.mailTtlDays * 24 * 60 * 60 * 1000,
        });
        return { owner, address: saved.address, expiresAt: saved.expiresAt };
      },
    },
    {
      method: 'GET',
      path: '/api/mail/list',
      handler: async ({ query }) => {
        const owner = String(query.owner || '');
        const address = requireMailbox(owner, query.address);
        checkPollQuota(owner);
        try {
          const result = await listMails({ address, limit: 20 });
          return { address, mails: result.mails || [] };
        } catch (error) {
          console.warn(`[vend] 拉邮件失败：${error?.message}`);
          throw new VendError('收件暂时失败，过几秒再刷新', 502, 'mail_fetch');
        }
      },
    },
    {
      method: 'GET',
      path: '/api/mail/mine',
      handler: async ({ query }) => ({ mailboxes: store.listMailboxes(String(query.owner || '')) }),
    },
    {
      method: 'POST',
      path: '/api/mail/delete',
      // 删掉一封信。必须先确认这封信确实属于这个邮箱——
      // 后台的删除接口只认 mail id，不校验归属，光传 id 等于谁都能删别人的信。
      handler: async ({ body }) => {
        const owner = String(body?.owner || '');
        const address = requireMailbox(owner, body?.address);
        const mailId = String(body?.id || '').trim();
        if (!mailId) throw new VendError('缺少邮件 id', 400, 'bad_request');
        let mails = [];
        try {
          mails = (await listMails({ address, limit: 50 })).mails || [];
        } catch (error) {
          console.warn(`[vend] 删信前校验失败：${error?.message}`);
          throw new VendError('暂时删不了，过几秒再试', 502, 'mail_fetch');
        }
        if (!mails.some((mail) => String(mail.id) === mailId)) {
          throw new VendError('这封信不在你的邮箱里', 403, 'not_owner');
        }
        try {
          await deleteMail(mailId);
        } catch (error) {
          console.warn(`[vend] 删信失败：${error?.message}`);
          throw new VendError('暂时删不了，过几秒再试', 502, 'mail_delete');
        }
        return { ok: true, id: mailId };
      },
    },
    {
      method: 'POST',
      path: '/api/mail/release',
      // 注销邮箱：本地归属先删（买家的诉求是「别再跟我有关系」），
      // 后台删失败也不回滚——那条记录会自己过期，但归属已经断了。
      handler: async ({ body }) => {
        const owner = String(body?.owner || '');
        const address = requireMailbox(owner, body?.address);
        const taken = store.takeMailbox(owner, address);
        if (!taken) throw new VendError('这个邮箱不属于你', 403, 'not_owner');
        let backendRemoved = false;
        if (taken.addressId) {
          try {
            await deleteAddress(taken.addressId);
            backendRemoved = true;
          } catch (error) {
            console.warn(`[vend] 后台注销邮箱失败 ${address}：${error?.message}`);
          }
        }
        return { ok: true, address, backendRemoved };
      },
    },

    {
      method: 'GET',
      path: '/api/vend/services',
      // 能卖的服务目录。买家没验卡密也能看，首屏就要显示。
      handler: async ({ query }) => {
        const config = loadVendConfig();
        const all = await getCatalog();
        const keyword = String(query.q || '').trim().toLowerCase();
        const filtered = keyword
          ? all.filter((item) => (item.name + item.rawName + item.code).toLowerCase().includes(keyword))
          : all;
        return {
          total: all.length,
          services: filtered.slice(0, keyword ? 60 : 40).map((item) => ({
            code: item.code,
            name: item.name,
            // 展示价按目录里的最低价换算；真正扣钱以取号时现查的闸门为准
            fromCny: round2(item.minUsd * config.rate),
            stock: item.stock,
            countries: item.countries,
            featured: item.featured,
          })),
        };
      },
    },

    {
      method: 'GET',
      path: '/api/vend/showcase',
      // 首页滚动看板：「除了 ChatGPT，这些平台也能接码」。不要 token，首屏就要用。
      // 库存/价格全部来自 getShowcase() 那份跟目录同步的缓存，绝不会在这里现拉 2.8MB。
      // 目录本身拉取失败时 getShowcase() 返回 []（从不抛错），这里再包一层 try/catch
      // 兜底格式化阶段的任何意外——首页少一块看板不能让整页崩。
      handler: async () => {
        const config = loadVendConfig();
        try {
          const showcase = await getShowcase();
          const rows = showcase.map((item) => ({
            service: item.service,
            serviceName: item.serviceName,
            countryId: item.countryId,
            countryName: item.countryName,
            stock: item.stock,
            priceCny: round2(item.priceUsd * config.rate),
            recommended: item.recommended,
          }));
          return { rows, fetchedAt: catalogFetchedAt() };
        } catch (error) {
          console.warn(`[vend] 实时可用榜格式化失败：${error.message}`);
          return { rows: [], fetchedAt: null };
        }
      },
    },

    {
      method: 'GET',
      path: '/api/vend/regions',
      handler: async ({ query }) => {
        const config = loadVendConfig();
        // 没带 token 也能看价格（首屏就要显示），只是不做面额闸门
        const found = query.token ? store.resolveSession(query.token) : null;
        const card = found?.card || null;
        // 服务由买家选，query 优先；没传就回落到默认。锁定卡只认自己那个服务。
        const service = card
          ? resolveService(card, query.service, config)
          : String(query.service || config.service);

        const data = await loadRegions(service);
        const priced = priceRegions(data.countries, {
          rate: config.rate,
          // 必须是**剩余余额**不是面额：多次收码的卡花掉一部分之后，
          // 按面额标会把买不动的地区标成「可用」，买家点下去才被拒 —— 当场投诉。
          denomCny: card ? cardBalanceCny(card) : null,
        });
        // 已经补过差价的地区，前端要显示成可选
        if (card) {
          for (const region of priced.regions) {
            if (region.over && store.isTopupConfirmed(card.code)) {
              region.topupPaid = true;
            }
          }
        }
        return { ...priced, service, fetchedAt: data.fetchedAt };
      },
    },

    {
      method: 'GET',
      path: '/api/vend/tiers',
      // 这个地区当前有哪些价位可选。买家连着几个号验证不过时，
      // 要能看到「贵一点的档还剩多少个号」并直接挑一个，而不是干等或反复撞同一档。
      handler: async ({ query }) => {
        const config = loadVendConfig();
        const { card } = requireSession(query?.token, { allowUsed: true });
        const countryId = Number(query?.country);
        if (!Number.isInteger(countryId)) throw new VendError('请选择地区', 400, 'no_country');
        const svc = resolveService(card, query?.service, config);
        const quotes = await loadQuotes(svc, countryId);
        const balanceCny = cardBalanceCny(card);
        const tiers = quotes.map((entry) => {
          const priceCny = usdToCny(entry.price, config.rate);
          return {
            priceUsd: entry.price,
            priceCny,
            count: entry.count,
            // 买不起的档也返回（灰掉展示），但要说清还差多少 ——
            // 直接不显示会让买家以为「没有更好的号了」，其实只是钱不够。
            affordable: priceCny != null && balanceCny != null && priceCny <= balanceCny,
            shortCny: priceCny != null && balanceCny != null && priceCny > balanceCny
              ? round2(priceCny - balanceCny)
              : 0,
          };
        }).filter((t) => t.priceCny != null && t.priceCny > 0);
        return { tiers, balanceCny, service: svc, country: countryId };
      },
    },

    {
      method: 'POST',
      path: '/api/vend/number',
      handler: async ({ body }) => {
        const config = loadVendConfig();
        const { card } = requireSession(body?.token);
        const countryId = Number(body?.country);
        if (!Number.isInteger(countryId)) throw new VendError('请选择地区', 400, 'no_country');
        // 上限必须在这里也判一次。只在 /change 判的话，
        // 买家循环「取号 → 取消 → 取号」就能无限次取号，把 HeroSMS 账号刷进风控。
        if (config.maxChanges != null && store.countChanges(card.code) >= config.maxChanges) {
          throw new VendError(`这张卡密最多换 ${config.maxChanges} 次号，已经用完了`, 409, 'max_changes');
        }

        await placeOrder({
          card, countryId, config,
          service: body?.service,
          minPriceUsd: parseMinPrice(body?.minPrice),
        });
        return snapshot(store.getCard(card.code), config);
      },
    },

    {
      method: 'GET',
      path: '/api/vend/status',
      handler: async ({ query }) => {
        const config = loadVendConfig();
        // 允许已消耗的卡查状态，否则买家刷新一下验证码就再也拿不回来了
        const { card } = requireSession(query.token, { allowUsed: true });
        const live = store.getLiveActivation(card.code);
        if (!live || !live.activation_id) return snapshot(store.getCard(card.code), config);

        let platform;
        try {
          platform = await getStatus(live.activation_id);
        } catch {
          // 单次查询失败不改变任何状态，让前端下一轮再来
          return { ...snapshot(store.getCard(card.code), config), pollError: '查询超时，正在重试' };
        }

        if (platform.state === 'code' && platform.code) {
          // 收到码 = 卡密消耗。这一步走事务，中途崩了不会出现「码给了卡还能用」
          try {
            store.consume(live.activation_id, platform.code, platform.sms);
          } catch (error) {
            // 并发的换号/取消刚把这条标成了 cancelled。码已经从平台发出来、
            // 这笔钱铁定退不回来，必须认账补记——把码丢掉的话是卖家付两个号的钱、
            // 买家拿不到码、卡还能再用一次，三头亏。
            console.warn(`[vend] 收码时状态已变（${error?.message}），按已收码补记`);
            store.forceConsume(live.activation_id, platform.code, platform.sms);
          }
          // 一卡一次收码，码到手交易就结束了，直接替买家把号还给平台。
          // 不做成买家点的按钮：收码后会话已清，买家反而调不动。
          vendFinishNumber(live.activation_id).catch((error) => {
            console.warn(`[vend] 自动完成 ${live.activation_id} 失败：${error?.message}`);
          });
        } else if (platform.state === 'cancel') {
          // 平台侧回收（多半是 20 分钟自然过期）不是买家换的号，
          // 记成 expired，别去吃买家的换号额度
          store.cancel(live.activation_id, 'expired');
        }
        return snapshot(store.getCard(card.code), config);
      },
    },

    {
      method: 'POST',
      path: '/api/vend/change',
      handler: async ({ body }) => {
        const config = loadVendConfig();
        const { card } = requireSession(body?.token);
        // 不限次数时只受号码有效期约束。真正的节奏限制在上游：
        // 换号要先退旧号，而旧号下单 90 秒内退不掉，会返回 refund_denied。
        const used = store.countChanges(card.code);
        if (config.maxChanges != null && used >= config.maxChanges) {
          throw new VendError(`这张卡密最多换 ${config.maxChanges} 次号，已经用完了`, 409, 'max_changes');
        }

        const live = store.getLiveActivation(card.code);
        if (!live) throw new VendError('当前没有可更换的号码', 400, 'no_live');
        const countryId = Number(body?.country ?? live.country);
        // 闸门必须前移到退旧号之前。否则换到超额地区时，
        // 旧号已经退掉了才告诉买家「要补差价」，买家两头空。
        const regionData = await loadRegions(String(body?.service ?? live.service ?? card.service));
        const region = regionData.countries.find((c) => Number(c.id) === countryId);
        if (!region) throw new VendError('这个地区暂时不可用，换一个试试', 400, 'region_unavailable');
        const pre = checkRegionAllowed({
          region,
          rate: config.rate,
          ...budgetInputs(card),
        });
        if (!pre.allowed) {
          if (pre.reason === 'need_topup') {
            throw new VendError(
              `这个地区要 ¥${pre.priceCny.toFixed(2)}，超出卡密面额 ¥${Number(card.denom_cny).toFixed(2)}，需要补 ¥${pre.topupCny.toFixed(2)}`,
              402,
              'need_topup',
            );
          }
          throw new VendError('这个地区当前不能取号，换一个试试', 400, pre.reason || 'not_allowed');
        }

        await releaseLive(live, 'cancelled');
        try {
          await placeOrder({
            card, countryId, config,
            service: body?.service ?? live.service,
            minPriceUsd: parseMinPrice(body?.minPrice),
          });
        } catch (error) {
          // 老号已经退掉了，必须说清楚，别让买家对着一个作废的号干等短信
          if (error instanceof VendError) error.message = `${error.message}（上一个号已退款，请重新取号）`;
          throw error;
        }
        return snapshot(store.getCard(card.code), config);
      },
    },

    {
      method: 'POST',
      path: '/api/vend/cancel',
      handler: async ({ body }) => {
        const config = loadVendConfig();
        const { card } = requireSession(body?.token);
        const live = store.getLiveActivation(card.code);
        if (!live) return snapshot(store.getCard(card.code), config);
        await releaseLive(live, 'cancelled');
        return snapshot(store.getCard(card.code), config);
      },
    },

    {
      method: 'POST',
      path: '/api/vend/card/void',
      // 买家试了几次没收到码、不想再试了，可以主动注销这张卡密并申请退款。
      // 刻意不做自动退款：退款链路复杂且容易出错，宁可卖家人工确认。
      handler: async ({ body }) => {
        const config = loadVendConfig();
        const { card } = requireSession(body?.token);

        // 有号在跑就先退掉，否则那个号会变成没人管的孤儿（平台侧不会退款）
        const live = store.getLiveActivation(card.code);
        if (live) await releaseLive(live, 'cancelled');

        const result = store.voidCard(card.code, body?.reason ?? null);
        if (!result.ok) {
          if (result.reason === 'used') throw new VendError('这张卡密已经收到过验证码，交易已完成，不能注销', 409, 'used');
          if (result.reason === 'has_live') throw new VendError('还有号码在进行中，请先取消再注销', 409, 'has_live');
          throw new VendError('卡密不存在', 404, 'not_found');
        }
        console.warn(`[vend] 卡密注销待退款：***${card.code.slice(-4)} 面额¥${card.denom_cny} 订单:${card.order_id || '-'}`);
        return {
          voided: true,
          codeTail: card.code.slice(-4),
          denomCny: round2(card.denom_cny),
          orders: store.countOrders(card.code),
        };
      },
    },

    {
      method: 'POST',
      path: '/api/vend/topup/claim',
      handler: async ({ body, headers }) => {
        const config = loadVendConfig();
        const { card } = requireSession(body?.token);
        const countryId = Number(body?.country);
        if (!Number.isInteger(countryId)) throw new VendError('请选择地区', 400, 'no_country');

        const data = await loadRegions(resolveService(card, body?.service, config));
        const region = data.countries.find((c) => Number(c.id) === countryId);
        if (!region) throw new VendError('这个地区暂时不可用', 400, 'region_unavailable');

        // 这里原来只拿光面额算，两个方向都会错：
        //   · 没算已核对的补款 → 补过一次还想买更贵的地区时，差额从头再算一遍，多收买家的钱
        //   · 没算已花掉的钱   → 多次收码的卡余额已经少了，差额算少，卖家自己贴
        // 必须跟取号那道闸用同一套输入，否则「弹窗说补 X，取号说不够」。
        const gate = checkRegionAllowed({ region, rate: config.rate, ...budgetInputs(card) });
        if (gate.reason !== 'need_topup') {
          throw new VendError('这个地区不需要补差价', 400, 'no_topup_needed');
        }

        const topup = store.claimTopup({ code: card.code, country: countryId, needCny: gate.topupCny });
        const alipay = alipayConfigFromEnv();
        let payUrl = null;
        if (alipay) {
          try {
            payUrl = buildPayUrl({
              config: alipay,
              // 手机上要跳手机网站支付，不然会被塞进一个没法唤起 App 的收银台
              method: isMobile(headers) ? 'alipay.trade.wap.pay' : 'alipay.trade.page.pay',
              outTradeNo: outTradeNoFor(topup),
              totalAmount: round2(topup.need_cny),
              subject: '取号补差价',
              body: `卡密 ${card.code.slice(-4)}`,
            });
          } catch (error) {
            // 支付宝配错了不能把补差价整条路堵死 —— 退回人工核对，买家照样能付
            console.error('[vend] 生成支付宝付款链接失败：', error.message);
          }
        }
        return {
          topupId: topup.id,
          needCny: round2(topup.need_cny),
          status: topup.status,
          alipayQrUrl: config.alipayQrUrl,
          // 有这个就走自动到账，没有就走底下那套「扫码 + 备注 + 人工核对」
          payUrl,
          // 备注用卡密后四位，方便卖家对账
          memo: card.code.slice(-4),
        };
      },
    },
  ];

  // ---------- 管理接口（要口令） ----------

  // 面额天花板：口令万一被爆，攻击者能造出天价面额的卡直接把额度闸门架空
  const MAX_DENOM_CNY = 200;

  function requireAdmin(headers, ip) {
    if (!secrets.adminToken) throw new VendError('接口不存在', 404, 'admin_disabled');
    secretGate(ip);
    const given = headers?.['x-vend-admin'];
    if (!secretEquals(given, secrets.adminToken)) {
      secretFail(ip);
      throw new VendError('口令不对', 401, 'bad_admin');
    }
    secretOk(ip);
  }

  routes.push(
    {
      method: 'GET',
      path: '/api/vend/admin/topups',
      handler: async ({ headers, ip }) => {
        requireAdmin(headers, ip);
        // 只把后四位发到浏览器——管理页对账只用这四位，没必要把整串卡密传出去
        return {
          pending: store.listPendingTopups().map((row) => ({
            id: row.id,
            codeTail: String(row.code).slice(-4),
            country: row.country,
            need_cny: row.need_cny,
            claimed_at: row.claimed_at,
          })),
        };
      },
    },
    {
      method: 'POST',
      path: '/api/vend/admin/topups/confirm',
      handler: async ({ headers, body, ip }) => {
        requireAdmin(headers, ip);
        const row = store.confirmTopup(Number(body?.id), body?.note ?? null);
        if (!row) throw new VendError('这条补差价记录不存在', 404, 'not_found');
        // 影响 0 行时照样能 SELECT 回那一行；不判 changed 的话，
        // 管理员会以为放行了，而买家死活取不了号
        if (!row.changed) throw new VendError(`这条记录当前是 ${row.status}，不能再确认`, 409, 'not_claimed');
        return { id: row.id, status: row.status, need_cny: row.need_cny };
      },
    },
    {
      method: 'POST',
      path: '/api/vend/admin/topups/reject',
      handler: async ({ headers, body, ip }) => {
        requireAdmin(headers, ip);
        const row = store.rejectTopup(Number(body?.id), body?.note ?? null);
        if (!row) throw new VendError('这条补差价记录不存在', 404, 'not_found');
        if (!row.changed) throw new VendError(`这条记录当前是 ${row.status}，不能再驳回`, 409, 'not_claimed');
        return { id: row.id, status: row.status };
      },
    },
    {
      method: 'GET',
      path: '/api/vend/admin/ledger',
      // 对账：钱可能还挂在平台上的单子 + 一个汇总
      handler: async ({ headers, query, ip }) => {
        requireAdmin(headers, ip);
        const days = Math.min(Math.max(Number(query.days) || 7, 1), 90);
        const sinceMs = days * 24 * 60 * 60 * 1000;
        return {
          days,
          summary: store.ledgerSummary({ sinceMs }),
          atRisk: store.listMoneyAtRisk({ sinceMs }),
        };
      },
    },
    {
      method: 'GET',
      path: '/api/vend/admin/refunds',
      handler: async ({ headers, ip }) => {
        requireAdmin(headers, ip);
        return { pending: store.listRefundRequests() };
      },
    },
    {
      method: 'POST',
      path: '/api/vend/admin/refunds/resolve',
      handler: async ({ headers, body, ip }) => {
        requireAdmin(headers, ip);
        const action = body?.action === 'refunded' ? 'refunded' : 'declined';
        const result = store.resolveRefund(String(body?.codeTail || ''), action, body?.note ?? null);
        if (!result.ok) {
          if (result.reason === 'ambiguous') throw new VendError('后四位撞号了，请用完整卡密处理', 409, 'ambiguous');
          throw new VendError('找不到这条待退款记录', 404, 'not_found');
        }
        return result;
      },
    },
    {
      method: 'POST',
      path: '/api/vend/admin/cards',
      handler: async ({ headers, body, ip }) => {
        requireAdmin(headers, ip);
        const count = Math.min(Math.max(Number(body?.count) || 1, 1), 200);
        const denomCny = Number(body?.denomCny);
        if (!Number.isFinite(denomCny) || denomCny <= 0 || denomCny > MAX_DENOM_CNY) {
          throw new VendError(`面额必须在 0 到 ${MAX_DENOM_CNY} 元之间`, 400, 'bad_denom');
        }
        const service = String(body?.service || loadVendConfig().service);
        // 一张卡能收几次码。不传 = 1，跟原来的一次性卡完全一致。
        const maxCodes = Math.max(1, Math.min(Math.floor(Number(body?.maxCodes) || 1), 20));
        // 卡的用途标记。没有它的话，一张 ¥1.9 的接码卡能直接领走一个邀请号 ——
        // 而一个邀请号是不可再生的成本。桌面开卡脚本的「Codex 一键邀请」这一项
        // 传的就是 INVITE_CARD。
        const lockedService = body?.lockedService ? String(body.lockedService) : null;
        const created = [];
        for (let i = 0; i < count; i += 1) {
          created.push(store.issueCard({
            denomCny, service, lockedService, note: body?.note ?? null, maxCodes,
          }).card.code);
        }
        return { count: created.length, codes: created };
      },
    },
  );

  // ---------- 支付宝异步通知 ----------
  //
  // 这是整个站上唯一一个「陌生人 POST 一下就能改余额」的入口，
  // 所以每一步都当成有人在攻击来写：
  //   1. 没配支付宝 → 404，不能出现「没配就等于不验」
  //   2. 验签 / app_id / 交易状态 / 金额，任何一条不过就 fail
  //   3. 金额跟**我们自己算出来的**应补金额比，不信通知里说的
  //   4. 幂等，支付宝会重推 25 小时
  routes.push({
    method: 'POST',
    path: '/api/vend/alipay/notify',
    text: true,          // 必须回纯文本 success，回 JSON 支付宝会当失败一直重推
    handler: async ({ body }) => {
      const alipay = alipayConfigFromEnv();
      if (!alipay) throw new VendError('接口不存在', 404, 'alipay_disabled');

      const outTradeNo = String(body?.out_trade_no || '');
      const topupId = topupIdFromOutTradeNo(outTradeNo);
      const topup = topupId ? store.getTopup(topupId) : null;
      if (!topup) {
        console.error(`[vend] 支付宝通知找不到对应补款单：${outTradeNo}`);
        return 'fail';
      }

      // 金额以**库里那笔的应补金额**为准，绝不用通知里报的数
      const check = checkNotify({ params: body, config: alipay, expectAmountCny: topup.need_cny });
      if (!check.ok) {
        console.error(`[vend] 支付宝通知未通过校验（${check.reason}）：${outTradeNo}`);
        return 'fail';
      }

      const paid = store.markTopupPaid(topup.id, {
        tradeNo: body.trade_no,
        note: `支付宝自动到账 ¥${body.total_amount} · ${body.gmt_payment || ''}`.trim(),
      });
      if (paid?.changed) {
        console.log(`[vend] 补款 #${topup.id} 支付宝到账 ¥${body.total_amount}，卡密 ****${String(topup.code).slice(-4)}`);
      }
      // 重复通知也回 success —— 已经处理过的再回 fail，支付宝会一直重推
      return 'success';
    },
  });

  // 买家拍下后收到的那段话。
  //
  // 用词一律中性（安哥 2026-08-22 要求）：不出现「接码」「验证码接收」
  // 「手机号租用」这类词。闲鱼对这类商品的关键词很敏感，发货内容本身
  // 也在平台的可见范围里 —— 一段话把整个商品线拖下水不划算。
  // 该说清楚的照说：能用几次、去哪用、什么算用完，删的是标签不是事实。
  // kind = 商品类型（'codex' / 'sms'），**不是**次数。
  //
  // 原来这里按 maxCodes > 1 推断是不是 Codex 单，因为当时 Codex 卡恰好是三次卡。
  // 那是个巧合，不是规律：三次卡方案取消、Codex 改发单次卡之后，
  // 按次数推断会让 Codex 买家收到通用接码文案，丢掉下面那两条前提 ——
  // 而那两条正是退款的源头。所以类型必须由调用方显式传，不能靠猜。
  //
  // 没传 kind 时保留旧的推断，老卡券的 api_config 一个字都不用改。
  function deliveryText(code, maxCodes, config, kind = '') {
    // 站点地址走环境变量。写死的话，任何一个部署了本项目的人发出去的卡密
    // 都会把买家导到别人的站上 —— 而且卖家自己看不出来。
    const site = process.env.SITE_URL || 'https://example.com';
    const lines = [`卡密：${code}`, '', `使用地址：${site}`];
    const isCodex = kind ? kind === 'codex' : maxCodes > 1;

    if (isCodex) {
      lines.push(
        // 时效必须写在最显眼处。买家没看到就超时 = 我们自己造的「描述不符」，
        // 而这条规则是我们单方面加的，讲不清楚站不住脚。
        '⏰ 这张卡密自发出起 1 小时内有效，超时自动失效，请尽快使用。',
        '',
        // 2026-08-27：流程已经全自动，原来那段「需要人工协助」的披露连同退款/返现的
        // 说辞一起删掉 —— 留着等于主动劝退，而且已经不是事实。
        '怎么用（你只需要做一件事：发出那封邀请）：',
        `① 打开 ${site}，把上面的卡密粘进输入框，点顶栏的「Codex 一键邀请」`,
        '② 点「领取邮箱」，页面会给你一个邮箱地址',
        '③ 在**你自己**的 Codex 邀请页把这个邮箱填进去、点发送',
        '④ 回到页面点「我已发出邀请」，然后**保持页面开着**',
        '',
        // 发货词必须中性（安哥 2026-08-22）：接码/验证码/手机号/虚拟号/取号/短信 都不能出现。
        // 这条有测试钉着 —— 我 2026-08-27 改文案时就写进了「验证码」，当场被测试拦下。
        '剩下的全自动：注册新账号、各项验证、登录 Codex 发消息激活，',
        '都由我们完成，通常 3~5 分钟出结果。',
        '',
        '· 上面这串是本单的使用凭证，一单一串，请勿外传',
        maxCodes > 1
          ? `· 这张卡可以用 ${maxCodes} 次，${maxCodes} 次共用卡内同一份余额`
          : '· 这张卡可以用 1 次，成功拿到结果即为用完',
        '',
        // 这条是退款的真源头。不写的话买家做完全套却拿不到额度，回头就是「描述不符」
        // —— 而这件事我们的系统看不见、帮不上，只能提前讲清楚，所以排在最前面。
        '开始之前务必先看这条，不然做完也拿不到额度：',
        '  先去你自己的邀请页面看一眼，上面要写明送多少（正常是 250~1000）。',
        '  没写明送多少的，做完整套流程也不会入账，这种情况先别往下做。',
        '  页面里有正反对照图，照着比一眼就能分辨。',
        '',
        '· 邀请一旦被接受不可退款，发之前请先确认上面那条',
        '· 没成功的那次不扣卡内余额，可以接着用',
        '· 页面上有分步说明和常见问题，看不明白点「使用说明」，或者在这里留言',
      );
    } else {
      lines.push(
        '',
        '⏰ 这张卡密自发出起 1 小时内有效，超时自动失效，请尽快使用。',
        '',
        '怎么用（三步，一分钟）：',
        '① 打开上面的网址，把卡密粘进输入框',
        '② 选一个你要用的平台（700 多个可选），再选一个标着「可用」的地区',
        '③ 点最下面那个按钮，页面会给你一串带区号的数字。',
        '   把它填进平台的注册页，然后**这个页面不要关**——',
        '   结果会自动出现在右边那块，到了直接点复制。',
        '',
        '· 上面这串是本单的使用凭证，一单一串，请勿外传',
        // 类型和次数解耦之后这条也不能再写死 —— 「一次」原来是 sms 卡的固有属性，
        // 现在只是默认值，真发一张多次的 sms 卡会当场骗到买家。
        maxCodes > 1
          ? `· 这张卡可以用 ${maxCodes} 次，${maxCodes} 次共用卡内同一份余额`
          : '· 这张卡可以用 1 次，成功拿到结果即为用完',
        '· 中途换一次不额外扣费，只有成功的那一次才计费',
        '· 没成功的不扣卡内余额，可以接着再试',
        '· 刚开始的一两分钟内不能中止，稍等一下再操作',
        '· 个别地区价格超出本卡面额，页面会当场提示，换一个即可',
        '· 页面上有分步说明和常见问题，看不明白点「使用说明」，或者在这里留言',
      );
    }
    if (config.contactNote) lines.push('', config.contactNote);
    return lines.join('\n');
  }

  // ---------- 闲鱼自动发货回调 ----------

  routes.push({
    method: 'POST',
    path: '/api/cards/issue',
    // raw：不套 {ok,data} 信封，闲鱼那边直接 result.get('data') 取字符串
    raw: true,
    handler: async ({ headers, body, ip }) => {
      // 没配 secret = 这个口子直接关掉。绝不能出现「没配就等于不设防」。
      if (!secrets.issueSecret) throw new VendError('接口不存在', 404, 'issue_disabled');
      secretGate(ip);
      // 闲鱼的 headers 原样透传、不做占位符替换，所以这里只能是静态密钥。
      // 注意：401/403/404 闲鱼**不会重试**，只有 5xx/408/超时才重试——这正是我们要的。
      const given = headers?.['x-card-secret'] ?? headers?.['x-issue-secret'];
      if (!secretEquals(given, secrets.issueSecret)) {
        secretFail(ip);
        throw new VendError('无权访问', 401, 'bad_secret');
      }
      secretOk(ip);

      const config = loadVendConfig();
      const orderId = String(body?.order_id || body?.orderId || '').trim() || null;
      // 没有订单号就没有幂等，闲鱼 4 次重试会白发 4 张卡；
      // 占位符没被替换（把请求方法配成 GET 时的经典事故）会让所有订单塌到同一张卡上，
      // 第二个买家直接收到第一个买家的卡密。两种都是配置错误，必须当场失败。
      // 返回 4xx 而不是 5xx —— 闲鱼对 4xx 不重试，配错了当场炸比默默发错卡强。
      if (!orderId || /^\{.*\}$/.test(orderId)) {
        // 只打 order_id 不够查：分不清「字段没传」「占位符没替换」「整个 body 是空的」，
        // 这三种在闲鱼那边是完全不同的配置错误。把整个 body 摊出来（这里不含任何密钥，
        // 密钥在 header 上，而且能走到这一行说明密钥已经验过了）。
        console.error(`[vend] 发卡请求缺少有效 order_id（order_id=${JSON.stringify(body?.order_id)}，完整 body=${JSON.stringify(body)}），已拒绝`);
        throw new VendError('发货参数不完整', 400, 'bad_order_id');
      }
      const specValue = body?.spec_value ?? body?.specValue ?? null;

      // 面额来源优先级：
      //   1. 卡券 params 里写死的 denom —— 最可靠。闲鱼多规格是「一个规格一条 xy_cards 记录」，
      //      每条都有自己的 api_config，所以可以在各自的 params 里写死面额，
      //      规格文字以后改了也不会错发。
      //   2. spec_value → 面额映射表（vend-config.js）
      //   3. 默认面额
      let denomCny;
      let source;
      const explicit = Number(body?.denom ?? body?.denom_cny);
      if (Number.isFinite(explicit) && explicit > 0) {
        if (explicit > MAX_DENOM_CNY) throw new VendError('面额配置有误，请联系卖家', 400, 'denom_too_large');
        denomCny = explicit;
        source = 'param';
      } else {
        const mapped = denomForSpec(specValue);
        if (!mapped.matched && specValue) {
          // 买家买的可能是 ¥6.9 的美国卡。宁可这一单发不出去、让你去后台补映射，
          // 也不能默默发一张 ¥1.9 的基础卡出去——那是必然的纠纷。
          console.error(`[vend] 订单 ${orderId} 规格「${mapped.spec}」未匹配面额，已拒绝发卡`);
          throw new VendError('规格配置有误，请联系卖家', 400, 'spec_unmatched');
        }
        denomCny = mapped.denomCny;
        source = mapped.matched ? 'spec' : 'default';
      }

      // 闲鱼卡券参数里填了 service 就锁定这张卡；不填 = 买家自选（默认，也是多服务的常态）。
      // 只认 2~8 位小写字母数字的服务码，挡掉占位符没被替换之类的垃圾值。
      const rawService = String(body?.service ?? '').trim().toLowerCase();
      const lockedService = /^[a-z0-9]{2,8}$/.test(rawService) ? rawService : null;
      if (rawService && !lockedService) {
        console.error(`[vend] 订单 ${orderId} 的 service 参数不合法（${JSON.stringify(body?.service)}），已拒绝发卡`);
        throw new VendError('服务配置有误，请联系卖家', 400, 'bad_service');
      }

      // 一张卡能成功用几次。闲鱼卡券的 params 里填 max_codes；不填 = 1，
      // 跟原来的一次性卡完全一致（老商品的配置一个字都不用改）。
      // 上限 20 是防呆：占位符没被替换、或者后台手滑多打一个 0，
      // 发出去的就是一张能白嫖 200 次的卡 —— 那是直接烧钱。
      const rawMax = Number(body?.max_codes ?? body?.maxCodes ?? 1);
      if (body?.max_codes !== undefined && !Number.isFinite(rawMax)) {
        console.error(`[vend] 订单 ${orderId} 的 max_codes 不是数字（${JSON.stringify(body?.max_codes)}），已拒绝发卡`);
        throw new VendError('次数配置有误，请联系卖家', 400, 'bad_max_codes');
      }
      const maxCodes = Math.max(1, Math.min(Math.floor(rawMax) || 1, 20));

      // 商品类型。只认白名单里的值 —— 拼错或占位符没替换时回落到按次数推断，
      // 而不是发一段空文案出去。
      const rawKind = String(body?.kind ?? '').trim().toLowerCase();
      const kind = ['codex', 'sms'].includes(rawKind) ? rawKind : '';

      const { card, reissued } = store.issueCard({
        denomCny,
        service: lockedService || config.service,
        lockedService,
        orderId,
        itemId: body?.item_id ?? body?.itemId ?? null,
        specValue: specValue ? String(specValue) : null,
        note: source === 'default' && specValue ? `规格未匹配:${specValue}` : null,
        maxCodes,
      });
      console.log(`[vend] 发卡 ${card.code} 面额¥${denomCny}(来源:${source})${lockedService ? ' 锁定服务:' + lockedService : ''} 次数:${maxCodes} 订单:${orderId || '-'}${reissued ? ' [重发同一张]' : ''}`);

      return { data: deliveryText(card.code, maxCodes, config, kind) };
    },
  });

  // Codex 邀请助手（全自动版）。单独一个模块，复用这里的卡密会话闸。
  routes.push(...createInviteRoutes({
    requireSession,
    VendError,
    workerSecret: secrets.inviteWorkerSecret,
    // 卡到期就回号并注销卡 —— 判据落在卡上，买家只需要理解「1 小时」这一个数字
    resolveCard: (code) => (code ? store.getCard(String(code)) : null),
    voidCard: (code, reason) => store.voidCard(String(code), reason),
  }));

  return { routes, VendError };
}

export { VendError };
