// vend-hero.js — 对外售卖侧的 HeroSMS 取号
//
// 为什么不直接用 heroSms.js 的 requestNumber：
//   那个函数把服务和国家写死取自 config.heroSms（Codex Invite Pilot 自用的固定配置），
//   而买家是**按地区自选**的，每次请求的 country/maxPrice 都不一样。
//   改它就要动 Codex Invite Pilot 的生产代码和它那 26 项测试，风险不对等。
//   所以这里只重写「取号」这一个函数，其余 getBalance / getStatus / cancelNumber /
//   finishNumber / fetchAvailableCountries 全部原样复用 heroSms.js，不重复造。
//
// 已确认的平台行为（2026-08-20 本机实跑，非文档推测）：
//   · 成功：ACCESS_NUMBER:<activationId>:<phone>
//   · 失败可能是纯文本协议码（NO_NUMBERS / NO_BALANCE / BAD_KEY …）
//     也可能是 JSON：{"title":"NOT_FOUND","details":"Activation Not Found"}
//     两种都要认，只认一种会在线上翻车。

import { config } from './config.js';

import { cancelNumber as rawCancelNumber, finishNumber as rawFinishNumber } from './heroSms.js';

export {
  getBalance,
  getStatus,
  requestAnotherSms,
  fetchAvailableCountries,
  fetchPriceQuotes,
  extractCode,
} from './heroSms.js';

// ⚠️ setStatus 系列（取消/完成）走 SMS-Activate 风格协议：**失败也是 HTTP 200**，
// 错误码写在正文里（EARLY_CANCEL_DENIED / BAD_STATUS / NO_ACTIVATION …）。
// heroSms.js 的 cancelNumber 只看 HTTP 码，平台明确拒绝退款时它照样返回 {ok:true}。
// 退款是真钱，必须校验正文——否则「我调用过 cancel」会被当成「钱退回来了」，
// 本地把号标作废、买家立刻再取一个，卖家付两次钱且日志里一条线索都没有。
const CANCEL_OK = /^ACCESS_CANCEL/i;
const FINISH_OK = /^ACCESS_ACTIVATION/i;
// 号本来就不在了 = 平台侧没有在跑的订单，等价于「没得退，也不会再扣」
const ALREADY_GONE = /^(NO_ACTIVATION|NOT_FOUND|WRONG_ACTIVATION_ID)/i;

// 纯函数，方便单测：把平台返回的正文分类成「退款了 / 已了结 / 还挂着」
// settled=true 表示平台侧这个号已经了结，只有这时才允许动本地状态
export function classifyCancelRaw(raw) {
  const text = String(raw || '').trim();
  if (CANCEL_OK.test(text)) return { refunded: true, settled: true, raw: text };
  if (ALREADY_GONE.test(text)) return { refunded: false, settled: true, raw: text };
  // 平台明确拒绝（比如刚下单几分钟内不许取消）：钱还挂在这个号上，本地不能动
  return { refunded: false, settled: false, raw: text };
}

export async function vendCancelNumber(activationId) {
  const result = await rawCancelNumber(activationId);
  return classifyCancelRaw(result?.raw);
}

export async function vendFinishNumber(activationId) {
  const result = await rawFinishNumber(activationId);
  const raw = String(result?.raw || '').trim();
  return { ok: FINISH_OK.test(raw), raw };
}

const REQUEST_TIMEOUT_MS = 20000;

// 平台错误码 → 给买家看的人话。看不懂的错误码一律走兜底文案，
// 绝不把 BAD_KEY / ERROR_SQL 这种东西原样甩给买家。
const FRIENDLY_ERRORS = {
  NO_NUMBERS: '这个地区暂时没号了，换一个地区试试',
  // 这三条是卖家侧的问题。买家没必要也不该知道后台余额、密钥、封号状态，
  // 「后台余额不足」在买家眼里等同于"这店快跑路了"，直接触发退款。
  NO_BALANCE: '这个地区暂时取不了号，先换一个地区试试；都不行请联系卖家',
  BAD_KEY: '服务暂时不可用，请联系卖家',
  BAD_SERVICE: '这个服务暂时不可用',
  BAD_ACTION: '服务暂时不可用，请联系卖家',
  WRONG_MAX_PRICE: '当前出价买不到这个地区的号，换一个地区试试',
  BANNED: '服务暂时不可用，请联系卖家',
  ERROR_SQL: '接码平台开小差了，稍后再试',
  NO_ACTIVATION: '这个号码已经失效了',
  NOT_FOUND: '这个号码已经失效了',
};

export function friendlyHeroError(raw) {
  const text = String(raw || '').trim();
  const key = text.split(':')[0].toUpperCase();
  if (FRIENDLY_ERRORS[key]) return FRIENDLY_ERRORS[key];
  return '接码平台暂时没有响应，稍后再试';
}

function buildUrl(query) {
  const url = new URL(config.heroSms.baseUrl);
  url.searchParams.set('api_key', config.heroSms.apiKey);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

// 把响应统一压成一段文本：纯文本原样返回，JSON 抽 title/details。
function flatten(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return trimmed;
  try {
    const payload = JSON.parse(trimmed);
    if (payload && typeof payload === 'object') {
      // JSON 错误形态用 title 当错误码，details 当详情
      return String(payload.title || payload.message || payload.error || trimmed);
    }
  } catch {
    // 解析不了就当纯文本
  }
  return trimmed;
}

export function parseVendNumber(text, { service, country }) {
  const match = String(text).match(/^ACCESS_NUMBER:([^:]+):(.+)$/i);
  if (!match) return null;
  return {
    activationId: String(match[1]).trim(),
    phone: String(match[2]).trim(),
    service,
    country: Number(country),
  };
}

// 按指定地区取号。maxPrice 是硬上限——它保证不会买到超出卡密面额的号。
// 注意：调用本函数就会扣费，调用方必须已经通过 cards.reserve 占到坑。
export async function vendGetNumber({ service, country, maxPrice }) {
  if (!config.heroSms.apiKey) throw new Error('未配置 HERO_SMS_API_KEY');
  const countryId = Number(country);
  if (!Number.isInteger(countryId) || countryId < 0) throw new Error('国家 ID 不合法');
  if (maxPrice != null && (!Number.isFinite(Number(maxPrice)) || Number(maxPrice) <= 0)) {
    throw new Error('出价上限不合法');
  }

  const query = {
    action: 'getNumber',
    service: String(service),
    country: countryId,
  };
  if (maxPrice != null) {
    query.maxPrice = Number(maxPrice);
    // fixedPrice=true 让平台严格按这个价买，而不是把它当"建议价"
    query.fixedPrice = 'true';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let raw;
  try {
    const response = await fetch(buildUrl(query), { method: 'GET', signal: controller.signal });
    raw = flatten(await response.text());
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { ok: false, raw: 'TIMEOUT', message: '接码平台超时了，稍后再试' };
    }
    return { ok: false, raw: String(error?.message || error), message: '连不上接码平台，稍后再试' };
  } finally {
    clearTimeout(timer);
  }

  const number = parseVendNumber(raw, { service, country: countryId });
  if (number) return { ok: true, number, raw };
  return { ok: false, raw, message: friendlyHeroError(raw) };
}

// 这两种失败是「这个价位没号了」，加价再试有意义；其余（没余额、封号、参数错）
// 换个价位也是白搭，必须立刻停手，别用一串无谓的请求去撞平台风控。
const WORTH_RETRY = /^(NO_NUMBERS|WRONG_MAX_PRICE)/i;

// 按价格档位从低到高逐档试，直到买到号或超出预算。
//
// 为什么要逐档而不是直接按预算出价：请求带了 fixedPrice=true，
// 直接拿卡密面额当出价，可能为一个 $0.05 的号付 $0.19（毛利全送掉）。
// 而只按最低报价出价，最低档卖光时就直接失败了，成功率会掉。
// 逐档试两头都占：成本永远是「买到时的那一档」，成功率等同于按预算出价。
//
// 失败的 getNumber **不扣费**，所以多试几档没有额外成本，只是多花几百毫秒。
export async function vendGetNumberTiered({
  service, country, tiers, budgetUsd, maxTries = 6, skipCheapest = 0, minPriceUsd = 0,
}) {
  // minPriceUsd = 买家在页面上手动挑的价位下限（「换个更贵的号」）。
  // 便宜档的号大多是回收复用的，连着几个都验证不过时，买家需要一个
  // 「我愿意多花钱换个干净号」的出口 —— 这就是那个出口。
  const floor = Number.isFinite(Number(minPriceUsd)) && Number(minPriceUsd) > 0
    ? Number(minPriceUsd)
    : 0;
  const affordable = (Array.isArray(tiers) ? tiers : [])
    .map(Number)
    .filter((price) => Number.isFinite(price) && price > 0 && price <= budgetUsd)
    .sort((a, b) => a - b);

  // 下限优先于自动跳档：买家手动指定了价位，就按他说的来，
  // 不要再叠一层「跳最便宜」把他选的那一档也跳掉。
  if (floor > 0) {
    const atOrAbove = affordable.filter((price) => price >= floor);
    // 下限之上没有可买的档位（预算不够）—— 这里**不能**兜底回退到便宜档：
    // 买家明确说了要贵的，给他一个便宜的等于没换，他会以为功能坏了。
    // 直接把可买的最高档给他；一档都没有就照实失败。
    const picked = atOrAbove.length ? atOrAbove : affordable.slice(-1);
    if (!picked.length) {
      return { ok: false, raw: 'NO_TIER_IN_BUDGET', message: '这个价位超出卡内余额，换个国家或补差价', triedPrices: [] };
    }
    const tried = [];
    let last = null;
    for (const price of picked.slice(0, maxTries)) {
      tried.push(price);
      const result = await vendGetNumber({ service, country, maxPrice: price });
      if (result.ok) return { ...result, paidUsd: price, triedPrices: tried };
      last = result;
      if (!WORTH_RETRY.test(String(result.raw || ''))) break;
    }
    // 买家挑了具体价位却没买到，多半是那一档刚被别人取完 ——
    // 上游库存实测 20 秒内就会来回跳，而我们的报价缓存是 30 秒。
    // 这时候套用通用的「这个地区暂时没号了，换一个地区试试」是**错的引导**：
    // 这个国家还有号，没的只是他选的那一档。
    if (last && !last.ok && WORTH_RETRY.test(String(last.raw || ''))) {
      return { ...last, triedPrices: tried, message: '你选的这个价位刚被取完了，换一档或者选「自动」' };
    }
    return { ...last, triedPrices: tried };
  }

  // 跳过最便宜的前几档（回收号池，见 vend-config.js skipCheapestTiers 的注释）。
  //
  // **不变量：跳档绝不能把「买得到」变成「买不到」。**
  // 预算只够最低那一两档的卡（¥1.9 在很多国家就是这样）跳完会一个候选都不剩，
  // 那时必须退回完整列表 —— 宁可买到回收号，也不能让买家付了钱一个号都取不到。
  const skip = Number.isInteger(skipCheapest) && skipCheapest > 0 ? skipCheapest : 0;
  const trimmed = skip > 0 ? affordable.slice(skip) : affordable;
  const candidates = (trimmed.length ? trimmed : affordable).slice(0, maxTries);

  // 一档都没有（报价接口没数据）就退回按预算出价，总比直接失败强
  if (!candidates.length) {
    const single = await vendGetNumber({ service, country, maxPrice: budgetUsd });
    return { ...single, triedPrices: [budgetUsd] };
  }

  const tried = [];
  let last = null;
  for (const price of candidates) {
    tried.push(price);
    const result = await vendGetNumber({ service, country, maxPrice: price });
    if (result.ok) return { ...result, paidUsd: price, triedPrices: tried };
    last = result;
    if (!WORTH_RETRY.test(String(result.raw || ''))) break;
  }
  return { ...last, triedPrices: tried };
}
