// 测试环境预置 —— 由 package.json 的 `node --test --import ./test.setup.mjs` 加载。
//
// 命名与位置都是被迫的：Node 的默认测试匹配会收 test/ 目录下的**所有**文件，
// 也会收任何叫 test-*.mjs 的文件 —— 两种写法都会让这个文件被当成一个空测试跑一遍。
// 所以既不能放 test/ 里，也不能叫 test-setup.mjs。
//
// 这个文件解决两件事，两件都是「在作者机器上全绿、别人 clone 下来一片红」的典型：
//
//   1. server/config.js 在 import 时就读仓库根目录的 .env，读不到就是空配置，
//      而好几处业务代码在关键 key 为空时直接抛错 —— 作者本机有 .env，别人没有。
//
//   2. 有两条路由会真的去请求 HeroSMS 线上接口。作者的 key 是真的所以能通，
//      别人跑就是 Invalid API key。**测试打第三方线上 API 本身就是缺陷**：
//      对方挂了、限流了、改协议了，你的测试就红，而你什么也没改。
//
// 硬规矩：这里的假值必须一眼看出是假的。写得像真的一样，
// 某天有人把测试配置当成真配置，排查会非常痛苦。

// ---------- 1. 环境变量 ----------

const TEST_ENV = {
  HERO_SMS_API_KEY: 'test-key-not-a-real-credential',
  MAIL_ADMIN_AUTH: 'test-auth-not-a-real-credential',
  MAIL_BASE_URL: 'https://mail.example.test',
  MAIL_DOMAIN: 'example.test',
  SITE_URL: 'https://example.com',
};

// 只在未设置时填充 —— 真实环境变量优先，需要跑真实联调的人不用改代码。
for (const [key, value] of Object.entries(TEST_ENV)) {
  if (!process.env[key]) process.env[key] = value;
}

// ---------- 2. 拦截对接码平台的真实请求 ----------
//
// 只拦这一个上游，其余（包括测试自己起的 127.0.0.1 服务）原样放行 ——
// 一刀切地替换 fetch 会把本地集成测试也一起打断。

const UPSTREAM_HOST = (() => {
  try {
    return new URL(process.env.HERO_SMS_BASE_URL || 'https://hero-sms.com/stubs/handler_api.php').hostname;
  } catch {
    return 'hero-sms.com';
  }
})();

// 造数据按**请求里问的国家**生成，不写死一组 ——
// 写死的话，任何一个用别的国家号的用例都会拿到空数据，
// 而空数据往往表现成"某个不相干的断言失败"，排查要绕一大圈。
const DEFAULT_COUNTRY = '52';
const TEST_SERVICE = process.env.HERO_SMS_SERVICE || 'dr';

// 不列具体国家时（「把所有地区列出来」）要给一个成套的清单 ——
// 只回一个国家的话，任何挑别的地区的用例都会拿到「这个地区暂时不可用」，
// 而那个报错离真正的原因隔了三层，排查要绕一大圈。
const CATALOG = ['52', '187', '0', '1', '4', '6', '16', '19', '31', '117'];

// 价格按国家 id 派生：**id 越大越贵**（`id / 100` 美元，约 $0.01～$1.87）。
// 这样用例可以靠挑国家来确定性地制造「够钱」和「不够钱要补差价」两种局面，
// 不用去猜某个真实国家今天多少钱 —— 真实价格每天在变，钉在测试里必然变红。
const priceOf = (id) => Math.max(Number(id) / 100, 0.01);

function offerOf(id) {
  const min = priceOf(id);
  return {
    counts: { total: 80, physical: 40 },
    prices: { min, default: min, retail: Number((min * 1.25).toFixed(4)) },
    map: { [String(min)]: 60 },
  };
}

function askedCountries(url) {
  const raw = url.searchParams.get('countries') || url.searchParams.get('country') || '';
  const list = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : CATALOG;
}

function fromEntries(ids, make) {
  return Object.fromEntries(ids.map((id) => [id, make(id)]));
}

function json(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const realFetch = globalThis.fetch;

globalThis.fetch = async function testFetch(input, init) {
  let url;
  try {
    url = new URL(typeof input === 'string' ? input : input?.url ?? String(input));
  } catch {
    return realFetch.call(this, input, init);
  }

  // 不是接码上游 → 原样放行（本地服务、其他 mock 都不受影响）
  if (url.hostname !== UPSTREAM_HOST) return realFetch.call(this, input, init);

  const ids = askedCountries(url);

  if (url.pathname.startsWith('/api/v1/activations/offers')) {
    const service = url.searchParams.get('services') || TEST_SERVICE;
    return json({ data: { [service]: fromEntries(ids, offerOf) } });
  }

  const action = url.searchParams.get('action');
  if (action === 'getCountries') {
    return json(fromEntries(ids, (id) => ({
      id: Number(id), eng: `Testland ${id}`, chn: `测试国 ${id}`, rus: `Testland ${id}`,
    })));
  }
  if (action === 'getPrices') {
    const service = url.searchParams.get('service') || TEST_SERVICE;
    return json(fromEntries(ids, (id) => ({ [service]: { cost: priceOf(id), count: 80 } })));
  }

  // 没造过的上游动作一律显式失败 —— 悄悄返回空数据会让测试"通过"而实际没验到东西。
  return new Response(`TEST_STUB_UNHANDLED:${action || url.pathname}`, { status: 200 });
};
