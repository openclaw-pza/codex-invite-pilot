// vend.js — 验证码取号 + 临时邮箱（黑金 v3）
//
// 状态机 body[data-state]：idle（没号）/ ready（可取号）/ waiting（等码）/ done（已收码）
// 面板     body[data-tab]  ：sms / mail
//
// 这一版换了皮，**流程逻辑是从上一版原样搬过来的**——取号/换号/取消/补差价
// 这几条都直接关系到钱，重写一遍等于把已经验过的坑重踩一遍。
//
// 动效全部走 CSS keyframes（见 vend.css），不引 GSAP：
// 设计稿要的 ringPulse / breathG / popIn 都是纯 CSS 能做的，少一个依赖少一处失败点。

import { serviceIconHtml, flagHtml, loadIsoMap, loadServiceIcons, callingCodeFor } from './icons.js?v=03bca541';

const $ = (id) => document.getElementById(id);

const state = {
  token: null,
  meta: null,
  denomCny: null,
  // 多次收码的卡：能收几次 / 已收几次 / 还剩多少钱
  maxCodes: 1,
  codesUsed: 0,
  balanceCny: null,
  topupTimer: null,
  // Codex 一键邀请的状态。相位由**后端**给（server/inviteRoutes.js），
  // 前端不自己推断 —— 判据留两份必然漂移。
  cx: { address: '', phase: 'none', text: '', done: false, timer: null },
  cardCode: null,
  cardExpiresAt: null,      // 卡的到期时间。到点回号 + 卡自动注销，买家得看得见还剩多久
  validityTimer: null,
  cardTail: null,
  lockedService: null,
  step: 'service',          // service | region
  // 手风琴的手动覆盖：用户点了哪一步的标题行就开哪一步；null = 跟着流程自动走
  openStep: null,
  service: null,
  serviceName: '',
  services: [],
  svcTotal: 0,
  regions: [],
  regionSummary: null,
  selected: null,
  activation: null,
  changes: 0,
  // 买家在取号前手选的价位。0 = 自动（从最便宜的可用档往上试）。
  // 人民币价单独存一份而不是拿汇率现算 —— 汇率是服务端配置，
  // 前端没有它，硬编码一个兜底值就是「以后改了汇率按钮显示错价」。
  pickedTierUsd: 0,
  // 只用来在按钮上显示「批次 N」。价格一律不进前端展示层。
  pickedTierIndex: 0,
  maxChanges: null, // null = 号码有效期内不限次数（上游没有次数限制）
  orders: 0,
  maxOrders: 6,
  voided: false,
  pollTimer: null,
  tickTimer: null,
  pendingTopup: null,
  phoneParts: null,   // { full, cc, national } —— 复制按钮要按这个给不同格式
  mailOwner: null,
  mailAddress: null,
  mailTimer: null,
};

const API_TIMEOUT_MS = 25000;
const CANCEL_GRACE_MS = 90_000; // 上游约 90 秒内不许取消，提前置灰免得白点
const BASE_TITLE = '验证码取号 · 境外一次性手机号接收验证码';

// ---------- 基础 ----------

async function api(path, { method = 'GET', body = null, timeoutMs = API_TIMEOUT_MS } = {}) {
  const options = { method, headers: {} };
  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const controller = new AbortController();
  options.signal = controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(path, options);
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('等太久了，网络可能不稳。别重复点，刷新页面重新输入卡密会接上你已有的号码');
    }
    throw new Error('网络不通，检查一下网络再试');
  } finally {
    clearTimeout(timer);
  }
  let payload = {};
  try { payload = await response.json(); } catch { /* 非 JSON 走兜底 */ }
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || '服务开小差了，稍后再试');
    error.code = payload.code || null;
    error.status = response.status;
    throw error;
  }
  return payload.data;
}

// 买家会整段复制发货消息，也会用全角键盘打出「－」。这些都是正常操作，
// 不能拿「卡密不存在」去怼人——每怼一次还吃掉一次防爆破配额。
function normalizeCardCode(raw) {
  const text = String(raw || '')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[—–－‐_]/g, '-')
    .toUpperCase();
  const hit = /ANGE[-\s]*([A-Z2-9]{4})[-\s]*([A-Z2-9]{4})[-\s]*([A-Z2-9]{4})/.exec(text);
  if (hit) return `ANGE-${hit[1]}-${hit[2]}-${hit[3]}`;
  return text.trim().replace(/\s+/g, '');
}

function maskCode(code) {
  const parts = String(code || '').split('-');
  if (parts.length < 3) return code;
  return `${parts[0]}-••••-••••-${parts[parts.length - 1]}`;
}

const money = (n) => (n == null ? '—' : `¥${Number(n).toFixed(2)}`);

// 计数元素嵌在正文里，正文换了它们就没了。写之前先确认还在，
// 别让一个装饰性的数字把整条加载流程带崩。
function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = String(value);
}

function mmss(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function stockText(count) {
  const n = Number(count) || 0;
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万个可用`;
  return `${n} 个可用`;
}

let toastTimer = null;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('bad', Boolean(isError));
  el.hidden = false;
  // 新皮的 toast 靠 .show 做淡入淡出；hidden 只负责让它彻底不占位、不拦点击
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 320);
  }, isError ? 5200 : 2600);
}

async function copy(text, label) {
  const value = String(text ?? '');
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    toast(`${label}已复制`);
  } catch {
    // http 或旧浏览器下 clipboard 不可用，退回选中让买家自己复制
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;left:-9999px';
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    toast(ok ? `${label}已复制` : `复制不了，请长按选中：${value}`, !ok);
  }
}

// ---------- 「可用 / 卡密余额不足」标签 ----------
//
// 安哥 2026-08-21 的产品决定：选服务和选地区都**不显示价格**，只显示这张卡密能不能用。
// 理由站得住：卡密是预付的，一张卡对应一次成功收码，买家选便宜地区并不会省钱，
// 价格只会让人以为还要再掏钱。真正需要决策的只有「能直接用」还是「要补差价」。
//
// 没验卡密时**什么都不标**：那时候还没有面额可比，标「可用」是在骗人。

function svcOverBudget(svc) {
  if (state.denomCny == null || svc?.fromCny == null) return null;
  return Number(svc.fromCny) > Number(state.denomCny);
}

function budgetTag(el, { over, paid = false }) {
  if (!el) return;
  el.className = 'row-tag';
  if (!state.token || over == null) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  if (paid) { el.classList.add('paid'); el.textContent = '已补差价'; return; }
  if (over) { el.classList.add('short'); el.textContent = '卡密余额不足'; return; }
  // 「可用」是常态，几乎每一行都有 —— 做成一列药丸就成了噪音。
  // 有用的信号是例外（余额不足），所以这一档故意压得很轻。
  el.classList.add('ok'); el.textContent = '可用';
}

// ---------- 服务（第 1 步）----------

function renderServices() {
  const box = $('svcList');
  box.textContent = '';
  if (!state.services.length) {
    box.innerHTML = '<p class="rail-note">没有匹配的服务，换个词试试</p>';
    return;
  }
  for (const svc of state.services) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'row row-svc';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(svc.code === state.service));
    row.innerHTML = `${serviceIconHtml(svc.code, svc.name)}<span class="row-name"></span><span class="row-tag" hidden></span>`;
    row.querySelector('.row-name').textContent = svc.name;
    // fromCny 是这个服务在**所有地区里的最低价**。它都超面额，就说明这张卡密
    // 在这个服务下一个地区都直接取不了，得补差价。
    budgetTag(row.querySelector('.row-tag'), { over: svcOverBudget(svc) });
    row.addEventListener('click', () => pickService(svc));
    box.append(row);
  }
}

async function loadServices() {
  const keyword = $('svcSearch').value.trim();
  try {
    const data = await api(`/api/vend/services?q=${encodeURIComponent(keyword)}`);
    state.services = data.services || [];
    state.svcTotal = data.total || state.services.length;
    $('svcCount').textContent = keyword ? `匹配 ${state.services.length} 个` : `共 ${state.svcTotal} 个`;
    setText('svcTotal', state.svcTotal);
    setText('geoSvcTotal', state.svcTotal);
    renderServices();
    renderPriceTable();
  } catch (error) {
    $('svcList').innerHTML = '<p class="rail-note">服务列表加载失败，刷新页面再试</p>';
    console.warn('[vend] 服务目录加载失败', error);
  }
}

async function pickService(svc) {
  state.openStep = null;
  state.service = svc.code;
  state.serviceName = svc.name;
  state.selected = null;
  // 价位是「国家 × 服务」维度的，换服务时上一轮选的档位在新服务里可能根本不存在
  state.pickedTierUsd = 0;
  state.pickedTierIndex = 0;
  state.step = 'region';
  $('pickedIco').innerHTML = serviceIconHtml(svc.code, svc.name);
  $('pickedName').textContent = svc.name;
  // 注意别去改写 #lede：那段是 GEO 要求的首段自我介绍，而且里面嵌着
  // #svcTotal / #regTotal 两个计数元素 —— 整段 innerHTML 重写会把它们删掉，
  // 后面 loadRegions 再写就是 null.textContent（实测炸过一次）。
  const hint = $('pickHint');
  hint.hidden = false;
  hint.innerHTML = `已选 <b>${escapeHtml(svc.name)}</b> · 挑一个标着「可用」的国家就行；标「卡密余额不足」的点一下可以补差价`;
  syncSteps();
  // 上游要跑一两秒才返回一百多个国家。空着不动会让人以为这一步没打开，
  // 先把加载态写进去（安哥反馈「选完服务不会自动下拉」，实际是展开了但里面是空的）。
  $('regList').innerHTML = '<p class="rail-note">正在读取这个平台当前可用的国家…</p>';
  await loadRegions();

  // 这个服务连最便宜的地区都超面额时，直接把补差价弹窗弹出来（安哥要的「点一下跳出弹窗」）。
  // 不拿目录里的 fromCny 当判据 —— 那是 10 分钟缓存，可能和刚拉回来的实时价对不上；
  // 以真实地区列表的第一条（已按价格升序）为准。
  const cheapest = state.regions[0];
  if (state.token && cheapest?.over && !cheapest.topupPaid && cheapest.topupCny > 0) {
    openTopup(cheapest);
  }
}

function backToService() {
  state.openStep = null;
  state.step = 'service';
  state.selected = null;
  $('pickHint').hidden = true;
  syncSteps();
  refreshCta();
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 地区（第 2 步）----------

// 接 OpenAI 的号时把泰国和美国提到最前（安哥 2026-08-25 要求）。
//
// 只在选了 OpenAI 时生效：这两个地区是安哥自己跑出来的高成功率地区，
// 属于**经营经验**而不是我们测出来的数据 —— 换个服务就不一定成立，
// 所以不能做成全局置顶。措辞同理：只写「推荐」，绝不写成「成功率 XX%」。
//
// 'dr' 是上游给 OpenAI/ChatGPT 的服务代码（服务列表里 code=dr、name=OpenAI · ChatGPT），
// 也是本站卡密的默认 service —— 站本来就主要在做这个。
const OPENAI_SERVICE = 'dr';
const OPENAI_PICKS = [
  { id: 52, star: true },   // 泰国：置顶 + 标星
  { id: 187, star: false }, // 美国：第二位，不标星
];

// 把置顶项挪到列表最前，其余保持原有顺序（原顺序是按价格升序，不能打乱）。
// 搜索过滤之后再调用：被搜掉的置顶项就不该再冒出来。
function applyPicks(list) {
  if (state.service !== OPENAI_SERVICE) return list;
  const ids = OPENAI_PICKS.map((p) => p.id);
  const top = [];
  for (const pick of OPENAI_PICKS) {
    const hit = list.find((r) => Number(r.id) === pick.id);
    if (hit) top.push(hit);
  }
  if (!top.length) return list;
  return [...top, ...list.filter((r) => !ids.includes(Number(r.id)))];
}

function pickStar(regionId) {
  if (state.service !== OPENAI_SERVICE) return false;
  const hit = OPENAI_PICKS.find((p) => p.id === Number(regionId));
  return Boolean(hit && hit.star);
}

function renderRegions() {
  const box = $('regList');
  box.textContent = '';
  const keyword = $('regSearch').value.trim().toLowerCase();
  let list = keyword
    ? state.regions.filter((r) => `${r.name}${r.englishName}`.toLowerCase().includes(keyword))
    : state.regions;
  list = applyPicks(list);

  if (!list.length) {
    box.innerHTML = '<p class="rail-note">没有匹配的国家，换个词试试</p>';
    return;
  }
  for (const region of list) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'row row-reg';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(region.id === state.selected));
    row.innerHTML = `${flagHtml(region)}
      <span class="reg-mid"><span class="reg-name"></span><span class="reg-sub"></span></span>
      <span class="reg-right"><span class="reg-pick" hidden></span><span class="row-tag" hidden></span></span>`;
    row.querySelector('.reg-name').textContent = region.name;
    if (pickStar(region.id)) {
      const pick = row.querySelector('.reg-pick');
      pick.textContent = '⭐ 推荐';
      pick.hidden = false;
    }
    row.querySelector('.reg-sub').textContent = region.physical > 0 ? '真实实体卡' : stockText(region.count);
    budgetTag(row.querySelector('.row-tag'), { over: region.over, paid: Boolean(region.topupPaid) });
    row.addEventListener('click', () => pickRegion(region));
    box.append(row);
  }
}

async function loadRegions() {
  if (!state.service) return;
  const params = new URLSearchParams({ service: state.service });
  if (state.token) params.set('token', state.token);
  try {
    const data = await api(`/api/vend/regions?${params}`);
    state.regions = data.regions || [];
    state.regionSummary = data;
    const within = data.withinBudget ?? state.regions.length;
    $('regCount').textContent = state.token
      ? `${within} 个在面额内 · 共 ${data.total}`
      : `共 ${data.total} 个`;
    setText('regTotal', data.total || '100+');
    renderRegions();
  } catch (error) {
    $('regList').innerHTML = '<p class="rail-note">国家列表加载失败，刷新页面再试</p>';
    console.warn('[vend] 地区加载失败', error);
  }
}

function pickRegion(region) {
  // 超额地区先弹补差价，别让买家点了取号才被拒。
  //
  // topupPaid 必须排除掉：那是**卖家已经核对到账**的地区，后端闸门
  // （checkRegionAllowed 里的 topupPaidCny）已经放行了。这里只看 over 的话，
  // 已经付过钱的买家点进去又被弹一次补差价，等于付了钱反而选不了 —— 死路。
  if (region.over && !region.topupPaid && region.topupCny > 0) {
    openTopup(region);
    return;
  }
  state.selected = region.id;
  // 换了国家，上一个国家选的档位必须清掉（价位是「国家×服务」维度的）
  state.pickedTierUsd = 0;
  state.pickedTierIndex = 0;
  renderRegions();
  refreshCta();
  loadTierChips();
}

// 取号**之前**就把价位摆出来，让买家自己挑 —— 上游接码站都是这么做的。
// 原来只有取号失败之后才有得挑，等于必须先踩一次坑才知道有这个选项。
async function loadTierChips() {
  const box = $('tierPick');
  const chips = $('tierChips');
  if (!state.token || !state.selected) { box.hidden = true; return; }
  chips.innerHTML = '';
  box.hidden = false;
  $('tierPickHint').textContent = '读取中…';

  let data;
  try {
    const qs = new URLSearchParams({
      token: state.token, country: String(state.selected), service: String(state.service ?? ''),
    });
    data = await api(`/api/vend/tiers?${qs}`);
  } catch {
    // 报价拉不到不该挡住取号 —— 自动逐档本来就是能跑的默认路径
    box.hidden = true;
    return;
  }
  // 只摆买得起的档。买不起的在这里列出来只会让人点了才发现不行；
  // 「有更贵的但你钱不够」这件事，取号失败后的那个弹窗里会说清楚。
  const tiers = (data.tiers || []).filter((t) => t.affordable);
  // 判据数付费档，但列表里还无条件加了一个「自动」档（下面的 mk('自动',...)）。
  // 所以真实可选项 = 付费档 + 1。原来写 `< 2` 等于「付费档只有 1 个就隐藏」——
  // 可高成功率地区（泰国：只有 ¥1.73/¥1.89 两档在 ¥1.9 面额内，余额一抖就剩 1 档）
  // 恰恰付费档少，于是被误伤：明明有「自动 + 批次1」两个选项，价位条却整条消失。
  // 正确判据是「一个付费档都没有」才隐藏（那时只剩光秃秃一个自动档，确实没得选）。
  if (tiers.length < 1) { box.hidden = true; return; }

  // **绝不在这里显示单档价格。**
  // 买家付的是卡密面额（¥1.9），我们的进价是几毛钱 —— 把 "¥0.25" 摆在
  // 一个花了 ¥1.9 的人面前，等于把毛利率直接摊给他看，必然引发「被宰了」的投诉。
  // 买家真正需要的判断依据也不是价格，而是「这批还剩多少号」：号少 = 回收池 = 容易被判已使用。
  $('tierPickHint').textContent = '号码分几批，一批不通就换一批';
  const mk = (label, stock, usd, idx) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tier-chip';
    b.setAttribute('aria-pressed', String(state.pickedTierUsd === usd));
    b.innerHTML = `${escapeHtml(label)}${stock ? `<span class="tc-stock">${escapeHtml(stock)}</span>` : ''}`;
    b.addEventListener('click', () => {
      state.pickedTierUsd = usd;
      state.pickedTierIndex = idx;
      for (const el of chips.querySelectorAll('.tier-chip')) el.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-pressed', 'true');
      refreshCta();
    });
    chips.appendChild(b);
  };
  mk('自动', '推荐', 0, 0);
  tiers.forEach((t, i) => mk(`批次 ${i + 1}`, `剩 ${t.count.toLocaleString('zh-CN')} 个`, t.priceUsd, i + 1));
}

// ---------- 左栏步骤显隐 ----------

// 新皮把三步做成了手风琴：当前步骤加 .open（展开搜索框和列表），
// 做完的加 .done（塌成一行摘要）。等码/收码期整组隐藏、露出选择摘要，
// 那部分由 CSS 的 body[data-state] 管，**这里不要再设 hidden**——
// 两套并存的话 [hidden]{display:none!important} 会把 CSS 想显示的按住。
function syncSteps() {
  const verified = Boolean(state.token);
  const busy = ['waiting', 'done'].includes(document.body.dataset.state);
  const auto = !verified ? 'key' : (state.step === 'region' ? 'reg' : 'svc');
  const active = state.openStep || auto;
  for (const step of document.querySelectorAll('.rail-step')) {
    const key = step.dataset.step;
    const order = ['key', 'svc', 'reg'];
    step.classList.toggle('open', !busy && key === active);
    step.classList.toggle('done', order.indexOf(key) < order.indexOf(active));
  }
  // 价位条只在「正在选国家」这一步露出。等码/收码期整组步骤会塌掉，
  // 那时它还挂着就会从塌好的摘要里支出来。这里统一收，别指望每个调用点各记一遍。
  const tierPick = $('tierPick');
  if (tierPick && (busy || active !== 'reg' || !state.selected)) tierPick.hidden = true;
  if (busy) renderSummary();
  $('cardHint').hidden = verified;
}

function renderSummary() {
  const region = state.regions.find((r) => r.id === state.selected)
    || (state.activation ? { id: state.activation.country, name: `地区 ${state.activation.country}`, englishName: '' } : null);
  $('sumSvc').innerHTML = `${serviceIconHtml(state.service, state.serviceName)}<span class="grow"></span>`;
  $('sumSvc').querySelector('.grow').textContent = state.serviceName || '—';
  if (region) {
    $('sumReg').hidden = false;
    $('sumReg').innerHTML = `${flagHtml(region, { width: 26, height: 19 })}<span class="grow"></span><span class="mono"></span>`;
    $('sumReg').querySelector('.grow').textContent = region.name;
    // 这里原来摆的是这个号的进价。买家在等码，看到「¥0.25」只会想
    // 「我花 1.9 买了个 2 毛 5 的东西」—— 留空。
    // 余额不放这儿：下面那张卡密卡片已经在显示了，重复两遍反而像两笔钱。
    $('sumReg').querySelector('.mono').textContent = '';
  } else {
    $('sumReg').hidden = true;
  }
  const st = document.body.dataset.state;
  $('sumNote').textContent = st === 'done'
    ? doneNote()
    : `号码有效期 ${Math.round((state.meta?.activationTtlSec || 1200) / 60)} 分钟；这期间可反复更换号码（费用都退回），或等超时自动退款`;
}

// 左栏卡密那一行。**只有这一个写点** —— 之前分成两处写，
// 后一处把前一处直接覆盖掉了，多次卡的余额压根显示不出来。
// 而且要每次快照都刷：余额随收码变，只在验卡那刻写死等于不更新。
function renderCardMeta() {
  const el = $('cardOkMeta');
  if (!el || state.denomCny == null) return;
  if ((state.maxCodes || 1) > 1) {
    el.textContent = `余额 ${money(state.balanceCny ?? state.denomCny)} · 还能收 ${codesLeft()}/${state.maxCodes} 次码`;
    return;
  }
  const changesLeft = state.maxChanges == null ? null : Math.max(0, state.maxChanges - (state.changes ?? 0));
  el.textContent = changesLeft == null
    ? `面额 ${money(state.denomCny)} · ${validityText()}`
    : `面额 ${money(state.denomCny)} · 可换 ${changesLeft} 次号 · ${validityText()}`;
}

// 还能收几次码。次数和余额是两个独立的闸，任何一个到底都取不了号 ——
// 只看次数会让「次数还有但余额买不动」的买家一直点、一直被拒。
function codesLeft() {
  return Math.max(0, (state.maxCodes || 1) - (state.codesUsed || 0));
}

// 收到码之后那句话。一次性卡和多次卡说法完全不同，
// 上一版写死成「已经用完了」—— 多次卡照着这句话会以为卡废了，直接来找卖家。
function doneNote() {
  const left = codesLeft();
  if (left <= 0) {
    return state.maxCodes > 1
      ? `这张卡密的 ${state.maxCodes} 次都用完了，需要再取号请重新拍一单。`
      : '本单完成，这张卡密已经用完了。一张卡密对应一次成功收码，需要再取号请重新拍一单。';
  }
  const bal = state.balanceCny == null ? '' : `，余额 ${money(state.balanceCny)}`;
  return `收到了。这张卡密还能再收 ${left} 次码${bal}——直接选国家继续取号就行。`;
}

// 把号码拆成「区号 + 本地号码」。
//
// 区号以**后端解析真号码**的结果为准（act.dialCode / act.nationalNumber，
// 服务端用 libphonenumber-js 解析）。这里的按国家 id 查表只是后端拿不到时的兜底 ——
// 区号有 1~4 位（+1 / +66 / +852 / +1876），从号码字符串上正则猜必错，
// 上一版就把 +6391 当成了菲律宾区号（真实是 +63）。
// 两条路都拿不到就整串显示：宁可少一个便利，也不能把号码切错让买家填错。
function splitPhone(raw, countryId, parts) {
  const digits = String(raw || '').replace(/[^\d+]/g, '');
  const full = digits.startsWith('+') ? digits : `+${digits}`;
  if (parts?.dialCode && parts?.nationalNumber) {
    return { full, cc: parts.dialCode, national: parts.nationalNumber };
  }
  const cc = callingCodeFor(countryId);
  const bare = digits.replace(/^\+/, '');
  if (!cc || !bare.startsWith(cc)) return { full, cc: '', national: '' };
  const national = bare.slice(cc.length);
  if (national.length < 4) return { full, cc: '', national: '' };
  return { full, cc, national };
}

function renderPhone(raw, countryId, parts) {
  const el = $('numText');
  const { full, cc, national } = splitPhone(raw, countryId, parts);
  el.textContent = '';
  // 提示语里的区号/本地号是占位符，必须填真值。拆不出区号就整句藏掉 ——
  // 显示字面的「区号填 +区号」比不显示更糟，买家会以为要照着打这三个字。
  const hint = document.querySelector('#numHint .num-hint-cc');
  if (hint) {
    hint.hidden = !cc;
    if (cc) {
      hint.querySelector('.hint-cc').textContent = `+${cc}`;
      hint.querySelector('.hint-nat').textContent = national;
    }
  }
  if (!cc) { el.textContent = full; state.phoneParts = { full, cc: '', national: '' }; return; }
  state.phoneParts = { full, cc, national };
  const ccEl = document.createElement('span');
  ccEl.className = 'num-cc';
  ccEl.textContent = `+${cc}`;
  const natEl = document.createElement('span');
  natEl.className = 'num-nat';
  natEl.textContent = national;
  el.append(ccEl, natEl);
}

// ---------- 主舞台 ----------

function renderSlots(code) {
  const box = $('slots');
  box.textContent = '';
  const digits = String(code || '').replace(/\D/g, '');
  const count = digits.length || 6;
  for (let i = 0; i < count; i += 1) {
    const slot = document.createElement('div');
    slot.className = digits[i] ? 'slot filled' : 'slot';
    if (digits[i]) {
      slot.style.animationDelay = `${i * 70}ms`;
      const span = document.createElement('span');
      span.textContent = digits[i];
      slot.append(span);
    } else {
      // 等待态每个槽错开 0.18s 呼吸
      slot.style.animationDelay = `${(i * 0.18).toFixed(2)}s`;
      slot.append(document.createElement('i'));
    }
    box.append(slot);
  }
}

// 卡的剩余有效期。到点之后号会退回池子、卡自动注销 —— 这件事必须让买家一直看得见，
// 不然超时了他只会觉得是我们坑他。
// 后端没给到期时间（规则上线前的老卡）时就只说「有效期 1 小时」，不编一个假的倒计时。
function validityText() {
  const at = Number(state.cardExpiresAt);
  if (!Number.isFinite(at) || at <= 0) return '有效期 1 小时';
  const left = at - Date.now();
  if (left <= 0) return '已过期，需要请联系客服';
  const min = Math.ceil(left / 60000);
  if (min >= 60) return `有效期剩 ${Math.floor(min / 60)} 小时 ${min % 60} 分`;
  return `有效期剩 ${min} 分钟`;
}

// 每 30 秒刷一次，别让买家盯着一个不动的数字以为卡住了
function startValidityTicker() {
  if (state.validityTimer) clearInterval(state.validityTimer);
  state.validityTimer = setInterval(() => { renderCardMeta(); refreshChip(); }, 30000);
}

function renderStage(snapshot) {
  if (snapshot) {
    if (snapshot.denomCny != null) state.denomCny = snapshot.denomCny;
    if (snapshot.maxCodes != null) state.maxCodes = Number(snapshot.maxCodes) || 1;
    if (snapshot.codesUsed != null) state.codesUsed = Number(snapshot.codesUsed) || 0;
    if (snapshot.balanceCny != null) state.balanceCny = snapshot.balanceCny;
    if (snapshot.changes != null) state.changes = snapshot.changes;
    if (snapshot.cardExpiresAt !== undefined) state.cardExpiresAt = snapshot.cardExpiresAt;
    renderCardMeta();
    // 向导开着的时候，验完卡要立刻把「领取邮箱」按钮解锁（它依赖 state.token）
    if (document.body.dataset.tab === 'codex') { renderCxGate(); renderCodex(); }
    // 把号码和短信码留一份给 relay 页（书签弹窗）读。
    // **只存值，不存 token** —— relay 只需要往输入框里填什么，
    // 没必要让一个弹窗页拿到能花钱的会话凭据。
    try {
      const act = snapshot.activation;
      if (act?.phone) {
        localStorage.setItem('vendPhone', act.phone.startsWith('+') ? act.phone : `+${act.phone}`);
        if (act.nationalNumber) localStorage.setItem('vendPhoneNat', act.nationalNumber);
      }
      if (act?.smsCode) localStorage.setItem('vendSmsCode', act.smsCode);
    } catch { /* 隐私模式写不了就算了，买家还能手动复制 */ }
    if (snapshot.lockedService !== undefined) state.lockedService = snapshot.lockedService;
    state.activation = snapshot.activation || null;
    state.changes = snapshot.changes ?? state.changes;
    state.maxChanges = snapshot.maxChanges ?? state.maxChanges;
    state.orders = snapshot.orders ?? state.orders;
    state.maxOrders = snapshot.maxOrders ?? state.maxOrders;
  }
  const act = state.activation;
  const body = document.body;

  // 只有「等码中」和「已收到码」算活动订单。
  // 取消 / 过期 / 已退款的号必须当作没有 —— 否则页面会以为还在等码，
  // 买家取消之后回不到选国家那一步（安哥实测踩到，只能被迫注销卡密）。
  const LIVE = act && (act.state === 'waiting' || act.state === 'code');
  if (!LIVE) {
    state.activation = null;
    body.dataset.state = state.token ? 'ready' : 'idle';
  } else if (act.state === 'code') {
    body.dataset.state = 'done';
  } else {
    body.dataset.state = 'waiting';
  }
  const st = body.dataset.state;

  // 号码行。显隐交给 CSS 的状态矩阵，这里只填内容。
  // body[data-finished] 是「已收到码」的追加标记，CSS 用它藏掉换号/取消和那句提示。
  const hasNum = Boolean(act?.phone);
  body.toggleAttribute('data-finished', st === 'done');
  if (hasNum) {
    const region = state.regions.find((r) => r.id === Number(act.country));
    // 注意用类名选，别用 querySelector('span') —— flagHtml 返回的就是一个 <span>，
    // 按标签名选会选中国旗本身，textContent 一写就把国旗的 <img> 覆盖掉，
    // 结果是地区名被塞进 20x14 的小方块里露半个字（线上真出过，截图才看出来）。
    $('numFlag').innerHTML = `${flagHtml(region || { name: '', englishName: '' }, { width: 20, height: 14 })}<span class="numflag-name"></span>`;
    $('numFlag').querySelector('.numflag-name').textContent = region?.name || `地区 ${act.country}`;
    // 区号单独标出来：有些平台的验证页要求填**不含区号**的号码，
    // 粘整串进去就永远收不到码。两种都给一个复制按钮，让买家自己挑。
    renderPhone(act.phone, act.country, act);
  }

  // 徽章
  const badge = $('stageBadge');
  if (st === 'waiting') {
    badge.classList.remove('win');
    $('stageBadgeText').textContent = '等待验证码 · 短信到达后自动显示';
  } else if (st === 'done') {
    badge.classList.add('win');
    const secs = act?.startedAt ? Math.round((Date.now() - act.startedAt) / 1000) : null;
    $('stageBadgeText').textContent = secs ? `验证码已到 · 用时 ${secs} 秒` : '验证码已到';
  } else if (st === 'ready') {
    badge.classList.remove('win');
    $('stageBadgeText').textContent = state.selected ? '准备就绪 · 点左下角取号' : `第 ${state.step === 'service' ? 1 : 2} 步 · 在左侧选择${state.step === 'service' ? '服务' : '地区'}`;
  } else {
    badge.classList.remove('win');
  }

  // 槽位 / 空态
  renderSlots(act?.smsCode || '');


  // 短信原文
  // 只显示平台给的真原文。拿不到就整块不显示 —— 不能拼一句假的「原文」糊弄。
  $('smsRaw').hidden = st !== 'done' || !act?.smsText;
  if (st === 'done' && act?.smsText) $('smsRawText').textContent = act.smsText;

  // 倒计时

  if (st === 'waiting') {
    $('cdTotal').textContent = mmss((state.meta?.activationTtlSec || 1200) * 1000);
    startTicking();
  } else {
    stopTicking();
    document.title = BASE_TITLE;
  }

  // 舞台按钮
  const actions = $('stageActions');

  const change = $('btnChange');
  const cancel = $('btnCancel');
  const copyBtn = $('btnCopyCode');
  change.hidden = st !== 'waiting';
  $('btnTier').hidden = st !== 'waiting';
  cancel.hidden = st !== 'waiting';
  copyBtn.hidden = st !== 'done';
  if (st === 'waiting') {
    // 换号/取消两个按钮的文案与禁用状态统一由 refreshCancelGate 管，
    // 别在两处各写一遍——之前就是分开写的，结果换号漏了 90 秒闸。
    refreshCancelGate();
  } else if (st === 'done') {
    copyBtn.textContent = `复制验证码 ${act.smsCode}`;
    $('actNote').textContent = '本单完成 · 号码已释放，不可再收第二条短信';
  } else {
    $('actNote').textContent = '';
  }

  syncSteps();
  refreshCta();
  refreshChip();
  refreshVoidBox();
}

// 上游约 90 秒内不许取消（EARLY_CANCEL_DENIED，实测过）。
//
// 关键：这条同时管住**换号**。换号 = 退旧号 + 取新号，退不掉就换不了——
// 只拦「取消」不拦「换号」的话，买家点换号会吃一个看不懂的报错。
function refreshCancelGate() {
  const cancel = $('btnCancel');
  const change = $('btnChange');
  const act = state.activation;
  if (!act?.startedAt) { cancel.disabled = true; return; }
  const passed = Date.now() - act.startedAt;
  const blocked = passed < CANCEL_GRACE_MS;
  const waitSec = Math.ceil((CANCEL_GRACE_MS - passed) / 1000);

  cancel.disabled = blocked;
  cancel.title = blocked ? '上游限制：取号约 90 秒内不能取消' : '';

  // 换号按钮：次数用完了就一直禁用；否则跟着 90 秒闸走
  const outOfChanges = state.maxChanges != null && state.changes >= state.maxChanges;
  change.disabled = outOfChanges || blocked;
  change.title = blocked ? '上游限制：取号约 90 秒内不能换号' : '';

  // 换价位 = 退旧号 + 按指定价位取新号，本质就是换号，同一道闸必须一起拦。
  // 少拦这一个，买家点下去只会吃一个看不懂的 refund_denied。
  const tier = $('btnTier');
  tier.disabled = outOfChanges || blocked;
  tier.title = blocked ? '上游限制：取号约 90 秒内不能换号' : '';
  tier.textContent = blocked ? `${waitSec} 秒后可换价位` : '换个价位';
  if (blocked) {
    change.textContent = `${waitSec} 秒后可换号`;
  } else {
    const left = state.maxChanges == null ? null : Math.max(0, state.maxChanges - state.changes);
    change.textContent = left == null ? '更换号码（费用退回）' : `更换号码（费用退回，剩 ${left} 次）`;
  }

  $('actNote').textContent = blocked
    ? `刚取的号 ${waitSec} 秒内不能换、也不能退（号码线路限制），先把号填进注册页试试`
    : '号码用不了？可以「换个价位」挑贵一档的新号批次，或者「退掉，换个国家」。';
}

function refreshChip() {
  const chip = $('cardChip');
  if (!state.token) {
    chip.className = 'chip chip-off';
    chip.innerHTML = '<span class="chip-dot"></span>未验证卡密';
    return;
  }
  if (state.voided) {
    chip.className = 'chip chip-off';
    chip.innerHTML = '<span class="chip-dot"></span>卡密已注销';
    return;
  }
  const left = state.maxChanges == null ? null : Math.max(0, state.maxChanges - state.changes);
  chip.className = 'chip chip-on';
  chip.innerHTML = `<span class="chip-dot"></span><span class="chip-label">卡密面额</span> <b></b><em></em>`;
  // 多次卡显示的是**余额**不是面额：花掉一部分之后还标原价，
  // 买家会按面额去挑国家，挑完才发现买不动。
  const multi = (state.maxCodes || 1) > 1;
  chip.querySelector('.chip-label').textContent = multi ? '卡密余额' : '卡密面额';
  chip.querySelector('b').textContent = money(multi && state.balanceCny != null ? state.balanceCny : state.denomCny);
  chip.querySelector('em').textContent = multi
    ? ` · 还能收 ${codesLeft()}/${state.maxCodes} 次码`
    : (left == null ? ` · ${validityText()}` : ` · 剩 ${left} 次换号 · ${validityText()}`);
}

function refreshCta() {
  const btn = $('btnPrimary');
  const st = document.body.dataset.state;
  if (state.voided) { btn.disabled = true; btn.textContent = '卡密已注销'; return; }
  // 收完码之后能不能接着取，取决于这张卡还剩几次 ——
  // 一次性卡后端已经把它置成 used，再点必然报错，所以按钮要真的禁掉；
  // 多次卡则相反，禁掉等于把买家买到的次数吞了。
  if (st === 'done' && codesLeft() <= 0) { btn.disabled = true; btn.textContent = '本单已完成'; return; }
  if (st === 'waiting') { btn.disabled = true; btn.textContent = '已取号 · 等待验证码'; return; }
  if (!state.token) { btn.disabled = true; btn.textContent = '验证卡密后可取号'; return; }
  if (!state.service) { btn.disabled = true; btn.textContent = '先选择服务'; return; }
  if (!state.selected) { btn.disabled = true; btn.textContent = '先选择国家'; return; }
  const region = state.regions.find((r) => r.id === state.selected);
  btn.disabled = false;
  // 选了非自动档要在按钮上留痕（否则买家不知道自己的选择生效没有），
  // 但**只写批次序号、不写价格** —— 见 loadTierChips 里那段注释。
  const tierNote = state.pickedTierIndex > 0 ? ` · 批次 ${state.pickedTierIndex}` : '';
  btn.textContent = region ? `取手机号 · ${region.name}${tierNote}` : '取手机号';
}

// 试了几次都不成，把注销退款的入口顶到前面
function refreshVoidBox() {
  const used = Number(state.orders) || 0;
  const show = Boolean(state.token) && !state.voided && used >= 2 && document.body.dataset.state !== 'done';
  $('voidBox').hidden = !show;
}

// ---------- 倒计时 + 轮询 ----------

function startTicking() {
  stopTicking();
  const tick = () => {
    const act = state.activation;
    if (!act?.expiresAt) return;
    const left = act.expiresAt - Date.now();
    const total = (state.meta?.activationTtlSec || 1200) * 1000;
    $('cdLeft').textContent = mmss(left);
    $('cdFill').style.width = `${Math.max(0, Math.min(100, (left / total) * 100))}%`;
    // 买家会切到注册页去，标题里带倒计时才知道还剩多久
    const tail = String(act.phone || '').replace(/\s/g, '').slice(-4);
    document.title = `(${mmss(left)}) 等验证码 · ${tail}`;
    refreshCancelGate();
    if (left <= 0) { stopTicking(); document.title = BASE_TITLE; }
  };
  tick();
  state.tickTimer = setInterval(tick, 1000);
}
function stopTicking() { if (state.tickTimer) clearInterval(state.tickTimer); state.tickTimer = null; }

function startPolling() {
  stopPolling();
  const interval = Math.max(3, Number(state.meta?.pollIntervalSec) || 5) * 1000;
  let misses = 0;
  const poll = async () => {
    if (!state.token) return;
    try {
      const snapshot = await api(`/api/vend/status?token=${encodeURIComponent(state.token)}`);
      misses = 0;
      renderStage(snapshot);
      if (snapshot.activation && snapshot.activation.state !== 'code') {
        state.pollTimer = setTimeout(poll, interval);
      } else if (snapshot.activation?.smsCode) {
        toast('验证码到了');
      }
    } catch {
      // 轮询失败不打扰买家，退避重试；连续失败太多就停，别把服务打爆
      misses += 1;
      if (misses < 8) state.pollTimer = setTimeout(poll, interval * Math.min(4, misses + 1));
    }
  };
  state.pollTimer = setTimeout(poll, interval);
}
function stopPolling() { if (state.pollTimer) clearTimeout(state.pollTimer); state.pollTimer = null; }

// ---------- 取号流程（逻辑照搬上一版）----------

// 两个入口共用：取号页侧栏（cardInput/btnVerify）和 Codex 一键邀请页（cxCardInput/cxCardVerify）。
// 会话是同一份，验过一次两边都算数 —— 各写一套只会出现"这边验了那边说没验"。
async function verifyCard(event, { inputId = 'cardInput', buttonId = 'btnVerify' } = {}) {
  event?.preventDefault?.();
  const code = normalizeCardCode($(inputId).value);
  if (!code) { toast('请输入卡密', true); return; }
  const button = $(buttonId);
  button.disabled = true; button.textContent = '验证中';
  try {
    const data = await api('/api/vend/card/verify', { method: 'POST', body: { code } });
    state.token = data.token;
    state.denomCny = data.denomCny;
    state.cardExpiresAt = data.cardExpiresAt ?? null;
    startValidityTicker();
    state.maxCodes = Number(data.maxCodes) || 1;
    state.codesUsed = Number(data.codesUsed) || 0;
    state.balanceCny = data.balanceCny ?? data.denomCny;
    state.cardCode = code;
    state.cardTail = code.slice(-4);
    state.lockedService = data.lockedService || null;
    state.maxChanges = data.maxChanges ?? state.maxChanges;

    $('cardOkCode').textContent = maskCode(code);
    renderCardMeta();
    $(inputId).value = '';
    renderCxGate();   // 邀请页的卡密块和「领取邮箱」按钮都跟着 state.token 走

    // 锁定服务的卡不给选服务，直接进第 2 步
    if (state.lockedService) {
      const svc = state.services.find((s) => s.code === state.lockedService)
        || { code: state.lockedService, name: state.lockedService, fromCny: null };
      await pickService(svc);
      toast('这张卡密指定了服务，已为你选好');
    } else {
      state.step = state.service ? 'region' : 'service';
      if (state.service) await loadRegions();
    }
    // 面额是刚拿到的，服务列表得重画一遍，否则「可用 / 卡密余额不足」永远不出现
    renderServices();
    renderStage(data);
    if (data.activation && data.activation.state !== 'code') startPolling();
    toast('卡密可用');
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false; button.textContent = '验证';
  }
}

async function primaryAction() {
  const st = document.body.dataset.state;
  // done 态按钮已经禁用了，这里再兜一层：一张卡密只能成功收一次码
  if (st === 'done') return;
  await takeNumber();
}

async function takeNumber() {
  if (!state.token) { toast('先验证卡密', true); return; }
  if (!state.selected) { toast('先选一个地区', true); return; }
  const button = $('btnPrimary');
  button.disabled = true; button.textContent = '取号中…';
  try {
    const snapshot = await api('/api/vend/number', {
      method: 'POST',
      body: {
        token: state.token, country: state.selected, service: state.service,
        minPrice: state.pickedTierUsd > 0 ? state.pickedTierUsd : undefined,
      },
    });
    renderStage(snapshot);
    startPolling();
  } catch (error) {
    if (error.code === 'need_topup') {
      const region = state.regions.find((r) => r.id === state.selected);
      if (region) openTopup(region);
    }
    toast(error.message, true);
    renderStage(null);
  }
}

async function changeNumber(minPrice = 0) {
  const button = $('btnChange');
  button.disabled = true;
  try {
    const snapshot = await api('/api/vend/change', {
      method: 'POST',
      body: {
        token: state.token, country: state.selected, service: state.service,
        // 0 = 不指定价位，后端回到自动逐档
        minPrice: minPrice > 0 ? minPrice : undefined,
      },
    });
    renderStage(snapshot);
    startPolling();
    toast(minPrice > 0 ? '已按你选的价位换号，上一个号的费用会退回' : '已换新号，上一个号的费用会退回');
  } catch (error) {
    toast(error.code === 'refund_denied'
      ? '刚取的号 90 秒内换不了（上游限制），过一会儿再点'
      : error.message, true);
    // 老号可能已经退掉了，拉一次真实状态，别让买家对着作废的号干等
    try { renderStage(await api(`/api/vend/status?token=${encodeURIComponent(state.token)}`)); } catch { /* 拉不到就保持原样 */ }
  }
}

async function cancelNumber() {
  // 原来这里叫「取消并退款」，买家不会想到那就是「换国家」的入口 ——
  // 安哥实测反馈「退出重新选择国家」找不到，就是死在这个措辞上。
  if (!window.confirm('这个号码会作废、费用退回卡内，然后回到选国家那一步。继续吗？')) return;
  try {
    const snapshot = await api('/api/vend/cancel', { method: 'POST', body: { token: state.token } });
    stopPolling(); stopTicking();
    renderStage(snapshot);
    // 退回到选国家那一步，让买家直接换一个国家再来 —— 不要让他只剩注销这一条路
    state.selected = null;
    state.step = state.service ? 'region' : 'service';
    state.openStep = null;
    syncSteps();
    await loadRegions();
    toast('费用已退回，这张卡密还能继续用，换个国家再试一次');
  } catch (error) {
    toast(error.message, true);
  }
}

async function voidCard() {
  const used = Number(state.orders) || 0;
  const warn = used === 0
    ? '你还没取过号。注销后这张卡密立即作废、无法再取号，确定吗？'
    : '注销后这张卡密立即作废、无法再取号，需要联系卖家人工退款。确定吗？';
  if (!window.confirm(warn)) return;
  const button = $('btnVoid');
  button.disabled = true;
  try {
    const data = await api('/api/vend/card/void', { method: 'POST', body: { token: state.token } });
    state.voided = true;
    stopPolling(); stopTicking();
    document.body.dataset.state = 'idle';
    state.activation = null;
    $('voidBox').innerHTML = `<p>卡密 ••••${escapeHtml(data.codeTail)} 已注销。<b>请在下单平台联系卖家退款</b>，退款由卖家人工处理。</p>`;
    $('voidBox').hidden = false;
    renderStage(null);
    toast('已注销，请联系卖家退款');
  } catch (error) {
    toast(error.message, true);
    button.disabled = false;
  }
}

// ---------- 补差价 ----------

function openTopup(region) {
  state.pendingTopup = region;
  $('topupSub').textContent = `${region.name}价格高于卡密面额`;
  // 同上：类名选，不能 querySelector('span')
  $('tcRegion').innerHTML = `${flagHtml(region, { width: 22, height: 16 })}<span class="tc-name"></span>`;
  $('tcRegion').querySelector('.tc-name').textContent = `${region.name} · ${state.serviceName || '所选服务'}`;
  $('tcPrice').textContent = money(region.priceCny);
  $('tcDeduct').textContent = `− ${money(state.denomCny)}`;
  $('tcTopup').textContent = money(region.topupCny);
  // 写 #tcPayText，不要写 #tcPayLine —— 备注那句 #tcMemo 是嵌在 tcPayLine 里面的，
  // 对父元素设 textContent 会把它整个删掉，下一行再写它就是 null.textContent（实测炸过）
  $('tcPayText').textContent = `支付宝扫码转 ${money(region.topupCny)}`;
  // 备注必须在付款**之前**就看得见，否则买家空着备注转账，卖家对不上账
  $('tcMemo').textContent = `备注卡密后 4 位「${state.cardTail || '——'}」`;
  $('btnTopupClaim').disabled = false;
  $('btnTopupClaim').textContent = '我已转账，开始取号';
  // 有支付宝就走自动到账，把手动扫码那块收起来；没有就反过来。
  // meta 里的 alipayAuto 是后端根据「配没配齐」给的，不是前端猜的
  const auto = Boolean(state.meta?.alipayAuto);
  $('topupAuto').hidden = !auto;
  $('topupManual').hidden = auto;
  $('btnTopupClaim').hidden = auto;
  $('tcAutoAmt').textContent = money(region.topupCny);
  $('btnAlipayPay').disabled = false;
  $('tcAutoHint').textContent = '付完自动到账，这个页面会自己更新，不用截图给客服。';
  // 底部那句也得跟着切。自动到账模式下还挂着「核对由人工完成」是自相矛盾的，
  // 买家读到互相打架的两句话只会当成这站不靠谱
  $('tcNoteManual').hidden = auto;
  $('tcNoteAuto').hidden = !auto;
  $('topupMask').hidden = false;
  $('topupMask').classList.add('open');
  $('btnTopupClaim').focus();
}

function closeTopup() {
  stopTopupWatch();
  $('topupMask').classList.remove('open');
  $('topupMask').hidden = true;
  state.pendingTopup = null;
}

// ---------- 价位选择 ----------
//
// 便宜档的号大多是回收复用的，注册时被判「该号码已被使用」。
// 买家连撞几次之后需要一个「多花两毛钱换个干净号」的出口，
// 而不是反复点换号撞回同一档、或者干等到号过期。
async function openTierPicker() {
  const mask = $('tierMask');
  const list = $('tierList');
  list.innerHTML = '<p class="tier-empty">正在读取当前价位…</p>';
  mask.hidden = false;
  mask.classList.add('open');

  let data;
  try {
    const qs = new URLSearchParams({
      token: state.token,
      country: String(state.selected ?? ''),
      service: String(state.service ?? ''),
    });
    data = await api(`/api/vend/tiers?${qs}`);
  } catch (error) {
    list.innerHTML = `<p class="tier-empty">${escapeHtml(error.message)}</p>`;
    return;
  }

  const tiers = data.tiers || [];
  if (!tiers.length) {
    list.innerHTML = '<p class="tier-empty">这个地区暂时读不到分档报价，可以直接点「更换号码」或换个国家。</p>';
    return;
  }
  // 后端只暴露人民币价（publicActivation 里没有 priceUsd），拿它比对当前档
  const currentCny = Number(state.activation?.priceCny) || 0;
  // 这里也不摆单价，理由同 loadTierChips：买家付的是面额，进价是几毛钱。
  const usable = tiers.filter((t) => t.affordable).length;
  $('tierSub').textContent = `共 ${tiers.length} 批号码，其中 ${usable} 批这张卡密可用`;

  list.innerHTML = '';
  tiers.forEach((tier, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'tier-row';
    row.disabled = !tier.affordable;
    if (currentCny && Math.abs(Number(tier.priceCny) - currentCny) < 0.005) row.dataset.current = '1';
    const right = tier.affordable
      ? (row.dataset.current === '1' ? '当前这批' : '换这批')
      : '不可用';
    row.innerHTML = `<span><span class="tr-price">批次 ${index + 1}</span>`
      + `<span class="tr-meta">这批还剩 ${tier.count.toLocaleString('zh-CN')} 个号</span></span>`
      + `<span class="tr-right">${escapeHtml(right)}</span>`;
    if (tier.affordable) {
      row.addEventListener('click', async () => {
        closeTierPicker();
        await changeNumber(tier.priceUsd);
      });
    }
    list.appendChild(row);
  });
}

function closeTierPicker() {
  $('tierMask').classList.remove('open');
  $('tierMask').hidden = true;
}

// 联系卖家：弹微信码。页脚那个入口原来跳的是使用教程 ——
// 买家点「联系卖家」是想找人，给他一篇文档等于把他推走。
function openContact() {
  $('contactMask').hidden = false;
  $('contactMask').classList.add('open');
}

function closeContact() {
  $('contactMask').classList.remove('open');
  $('contactMask').hidden = true;
}


// ---------- Codex 一键邀请 ----------
//
// 这是个**半自动**向导：等邮件、认信、抄验证码由我们做；
// 打开邀请链接、在注册页填表、过人机验证由买家自己做。
// 后面那几步不能替他点 —— 那正是 OpenAI 判机器人的地方，替他点等于把他的号弄废。
//
// 向导「清不清楚」全在状态机：任何时刻**有且只有一步是亮的**，
// 前面的打勾、后面的压暗。只用文字描述状态的向导，买家看完还是不知道该点哪儿。

const CX_POLL_MS = 4000;

// Codex 一键邀请（全自动版）。
// 买家只做两件事：领邮箱、发完邀请点一下按钮。之后建号、过邮箱验证码、过手机验证、
// 登录 Codex 桌面端并发消息激活，全部在服务器上完成，前端只负责轮询状态。
//
// 🔴 「领邮箱」和「我已发出邀请」必须是两步、且第二步由买家自己点：
// 微软号第一次被登录时会被强制绑一个恢复邮箱，而我们用的是临时邮箱（约 10 分钟失效）。
// 邀请还没发就先登录，等于白赔一个**不可再生**的号。所以在买家点第二下之前，
// 服务端一次都不会碰这个邮箱 —— 这条约束在后端也有测试钉着。

function cxActiveStep() {
  if (!state.cx.address) return 1;
  if (state.cx.phase === 'need_invite') return 2;
  return 3;
}

function renderCodex() {
  const active = cxActiveStep();
  for (const li of document.querySelectorAll('#cxSteps .cx-step')) {
    const n = Number(li.dataset.step);
    li.dataset.state = n < active ? 'done' : (n === active ? 'active' : 'todo');
  }

  const address = state.cx.address || '';
  $('cxAddrBox').hidden = !address;
  $('cxTake').hidden = Boolean(address);
  if (address) $('cxAddr').textContent = address;

  // 第 2 步的按钮只在"等你发邀请"这一相出现。已经排队/在跑/跑完都不该再点。
  const needInvite = state.cx.phase === 'need_invite';
  $('cxSent').hidden = !needInvite;
  if (!needInvite) cxResetSentButton();

  // 第 3 步：进行中转圈，终态出结论
  const running = ['queued', 'running'].includes(state.cx.phase);
  $('cxRunWait').hidden = !running;
  if (running) $('cxRunText').textContent = state.cx.text || '正在处理…';

  const finished = state.cx.done;
  const box = $('cxResult');
  box.hidden = !finished;
  if (finished) {
    const ok = state.cx.phase === 'done';
    box.textContent = (ok ? '✅ ' : '⚠️ ') + (state.cx.text || '');
    // 站里的色板变量，别自己再造一套颜色
    box.style.color = ok ? 'var(--ok-text)' : 'var(--red)';
    box.style.fontWeight = '650';
  }
}

// 前置闸。卖家在商品文案里用【】+ 三个感叹号喊的就是这件事：
// 邀请页没写送多少额度的话，邀请多少次都收不到 —— 买家花了钱拿不到东西，
// 那是必然的退款差评。做成"勾了才能往下走"，比写一句提醒硬得多。
function cxGateOk() {
  return Boolean($('cxOk')?.checked);
}

function renderCxGate() {
  const ok = cxGateOk();
  // 验没验卡是**一份状态**，两个入口都照它渲染
  const verified = Boolean(state.token);
  if ($('cxCardBox')) {
    $('cxCardBox').hidden = verified;
    $('cxCardOk').hidden = !verified;
    if (verified && state.cardCode) $('cxCardTail').textContent = maskCode(state.cardCode);
  }
  // 没验卡就领不了号。这里只做提示，真正的闸在后端（领号必须带有效会话）。
  $('cxTake').disabled = !ok || !state.token || Boolean(state.cx.address);
  $('cxTake').title = state.token ? '' : '请先在页面上方输入卡密';
  $('cxGate').dataset.state = ok ? 'ok' : 'wait';
}

// 把服务端回的状态整块收下。前端不自己推断相位 ——
// 判据只留一份在后端，两边各写一套必然漂移。
function cxApply(data) {
  state.cx.address = data.address || state.cx.address || '';
  state.cx.phase = data.phase || 'none';
  state.cx.text = data.text || '';
  state.cx.done = Boolean(data.done);
  renderCxGate();
  renderCodex();
  if (state.cx.done) stopCodexPolling();
}

async function cxTake() {
  const button = $('cxTake');
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '领取中…';
  try {
    const data = await api('/api/invite/claim', { method: 'POST', body: { token: state.token } });
    cxApply(data);
    toast('邮箱已领取，把它填进你自己的 Codex 邀请页');
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.textContent = label;
    renderCxGate();
  }
}

// 二次确认做成"按钮改字"而不是弹窗：这一下是不可逆的（点了就开始烧名额），
// 但再加一层弹窗对小白反而是干扰。改字 + 5 秒后自动退回，误触也救得回来。
let cxSentArmed = null;
function cxResetSentButton() {
  if (cxSentArmed) { clearTimeout(cxSentArmed); cxSentArmed = null; }
  const button = $('cxSent');
  if (button) { button.textContent = '我已发出邀请'; button.dataset.armed = ''; }
}

async function cxMarkSent() {
  const button = $('cxSent');
  if (button.dataset.armed !== '1') {
    button.dataset.armed = '1';
    button.textContent = '确认已发出？点这里确认';
    cxSentArmed = setTimeout(cxResetSentButton, 5000);
    return;
  }
  cxResetSentButton();
  button.disabled = true;
  try {
    const data = await api('/api/invite/sent', { method: 'POST', body: { token: state.token } });
    cxApply(data);
    startCodexPolling();
    toast('已收到，开始自动处理');
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function cxTick() {
  if (!state.token) return;
  try {
    const data = await api(`/api/invite/status?token=${encodeURIComponent(state.token)}`);
    cxApply(data);
  } catch { /* 网络抖一下就等下一轮，不要把已完成的步骤退回去 */ }
}

function startCodexPolling() {
  stopCodexPolling();
  state.cx.timer = setInterval(cxTick, CX_POLL_MS);
}

function stopCodexPolling() {
  if (state.cx.timer) { clearInterval(state.cx.timer); state.cx.timer = null; }
}

// 进入这一页时调用。切走时停轮询，别在后台空跑。
function openCodex() {
  renderCxGate();
  renderCodex();
  // 刷新页面回来也要能接上：先拉一次状态，没跑完就继续盯着
  if (state.token) cxTick().then(() => { if (!state.cx.done && state.cx.address) startCodexPolling(); });
}

function closeCodex() {
  stopCodexPolling();
}

// ---------- 意见反馈 ----------

function openFeedback() {
  $('fbMask').hidden = false;
  $('fbMask').classList.add('open');
  $('fbText').focus();
}

function closeFeedback() {
  $('fbMask').classList.remove('open');
  $('fbMask').hidden = true;
}

async function sendFeedback() {
  const button = $('btnFbSend');
  const text = $('fbText').value.trim();
  // 前端也挡一道：让买家在点提交之前就知道字数不够，
  // 比提交完弹一个红字再让他重写体验好
  if (text.length < 5) { toast('说得再具体一点吧，至少 5 个字', true); $('fbText').focus(); return; }

  const label = button.textContent;
  button.disabled = true; button.textContent = '提交中…';
  try {
    await api('/api/vend/feedback', {
      method: 'POST',
      body: {
        text,
        contact: $('fbContact').value.trim(),
        // 带上卡密后 4 位，这样安哥能把意见对上具体哪一单；没验卡密也能提交
        cardTail: state.cardTail || '',
      },
    });
    // 清空再关：下次点开是干净的，不会看到上次已经发出去的内容还留在框里
    $('fbText').value = '';
    $('fbContact').value = '';
    $('fbCount').textContent = '0';
    closeFeedback();
    toast('已收到，谢谢——看到了会处理');
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false; button.textContent = label;
  }
}

async function claimTopup() {
  const region = state.pendingTopup;
  if (!region) return;
  const button = $('btnTopupClaim');
  button.disabled = true; button.textContent = '提交中…';
  try {
    const data = await api('/api/vend/topup/claim', {
      method: 'POST',
      body: { token: state.token, country: region.id, service: state.service },
    });
    if (data?.memo) $('tcMemo').textContent = `备注「${data.memo}」`;
    $('topupTitle').textContent = '已提交，等卖家核对';
    $('btnTopupOther').textContent = '知道了';
    button.textContent = '已提交';
    toast('已记录，卖家核对到账后就能用这个地区了');
    await loadRegions();
  } catch (error) {
    toast(error.message, true);
    button.disabled = false; button.textContent = '我已转账，开始取号';
  }
}

// 支付宝自动付款。跟人工核对那条是二选一：接上了就把手动那块整个收起来，
// 两套同时摆着买家不知道走哪条，反而更容易付错。
async function startAlipayPay() {
  const region = state.pendingTopup;
  if (!region) return;
  const button = $('btnAlipayPay');
  const label = button.innerHTML;
  button.disabled = true; button.textContent = '正在生成付款链接…';
  try {
    const data = await api('/api/vend/topup/claim', {
      method: 'POST',
      body: { token: state.token, country: region.id, service: state.service },
    });
    if (!data?.payUrl) {
      // 后端没给链接 = 支付宝没配好或者生成失败。退回人工，别把买家卡在这儿
      showTopupManual(data);
      toast('自动付款暂时不可用，请按下面的方式转账', true);
      return;
    }
    // 新标签打开：当前页要留着轮询到账，跳走了回来会丢掉进行中的状态
    window.open(data.payUrl, '_blank', 'noopener');
    button.textContent = '付款中…等待到账';
    $('tcAutoHint').textContent = '在新打开的页面完成付款。付好之后回到这里，几秒内会自动到账。';
    startTopupWatch(Number(data.needCny));
  } catch (error) {
    toast(error.message, true);
    button.disabled = false; button.innerHTML = label;
  }
}

// 付款后轮询余额。支付宝的异步通知是它主动推给我们服务器的，
// 买家这边只能靠轮询发现「钱到了」—— 不轮询的话他得自己刷新页面，
// 而在他眼里刚付完钱页面没反应就等于出事了。
function startTopupWatch(needCny) {
  stopTopupWatch();
  const before = Number(state.balanceCny ?? state.denomCny ?? 0);
  let ticks = 0;
  state.topupTimer = setInterval(async () => {
    ticks += 1;
    try {
      const snap = await api(`/api/vend/status?token=${encodeURIComponent(state.token)}`);
      renderStage(snap);
      const now = Number(state.balanceCny ?? state.denomCny ?? 0);
      if (now > before + 0.001) {
        stopTopupWatch();
        closeTopup();
        await loadRegions();
        toast(`到账了，余额 ${money(now)}，可以取号了`);
      }
    } catch { /* 网络抖一下就等下一轮 */ }
    // 5 分钟还没到就停：多半是买家没付或者关掉了付款页，
    // 一直轮询既费流量也会让「等待中」这个状态骗人
    if (ticks >= 60) {
      stopTopupWatch();
      $('tcAutoHint').textContent = '还没收到这笔款。付过了就点下面「知道了」再刷新页面，或者联系卖家。';
      $('btnAlipayPay').disabled = false;
      $('btnAlipayPay').textContent = `重新付款 ${money(needCny)}`;
    }
  }, 5000);
}

function stopTopupWatch() {
  if (state.topupTimer) { clearInterval(state.topupTimer); state.topupTimer = null; }
}

// 退回人工核对那条路
function showTopupManual(data) {
  $('topupAuto').hidden = true;
  $('topupManual').hidden = false;
  $('btnTopupClaim').hidden = false;
  $('tcNoteManual').hidden = false;
  $('tcNoteAuto').hidden = true;
  if (data?.memo) $('tcMemo').textContent = `备注「${data.memo}」`;
}

// ---------- 公告 ----------

const ANN_KEY = 'vendAnnSkipDate';

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function openAnnouncement() {
  // 公告正文写在 index.html 里，这里不再覆写 —— 新稿把图片和免责声明放在
  // #annBody 外面，JS 再塞一份进去会变成两套图（实测踩到）。
  // 静态化的附带好处：不跑 JS 的爬虫也读得到公告内容。
  const modal = $('annModal');
  modal.classList.remove('closing');
  $('annMask').hidden = false;
  $('annMask').classList.add('open');
  $('annDot').hidden = true;
}

function closeAnnouncement() {
  const modal = $('annModal');
  const mask = $('annMask');
  const pill = $('annPill');

  // 吸回顶栏那颗「公告」胶囊：先算出弹窗中心到胶囊中心的位移，交给 CSS 飞过去。
  // 不设这两个变量的话会走 CSS 的兜底值（直飞屏幕正上方），看着很生硬。
  if (pill) {
    const p = pill.getBoundingClientRect();
    const m = modal.getBoundingClientRect();
    modal.style.setProperty('--ann-x', `${p.left + p.width / 2 - (m.left + m.width / 2)}px`);
    modal.style.setProperty('--ann-y', `${p.top + p.height / 2 - (m.top + m.height / 2)}px`);
    pill.classList.add('pulse');
  }
  modal.classList.add('closing');
  mask.classList.add('closing');

  // 收尾时机必须和 CSS 的动画时长对齐（annAbsorb 是 450ms）。
  // 之前写 640ms，动画跑完之后弹窗还僵在那儿 190ms —— 那一下停顿就是「卡顿感」。
  setTimeout(() => {
    mask.classList.remove('open', 'closing');
    mask.hidden = true;
    modal.classList.remove('closing');
    modal.style.removeProperty('--ann-x');
    modal.style.removeProperty('--ann-y');
    pill?.classList.remove('pulse');
    $('annDot').hidden = false;
  }, 460);
  if ($('annSkip').checked) {
    try { localStorage.setItem(ANN_KEY, todayKey()); } catch { /* 隐私模式写不了就算了 */ }
  }
}

function maybeAutoAnnounce() {
  let skip = null;
  try { skip = localStorage.getItem(ANN_KEY); } catch { /* 读不到就当没设置过 */ }
  if (skip === todayKey()) { $('annDot').hidden = false; return; }
  openAnnouncement();
}

// ---------- 临时邮箱 ----------

const MAIL_OWNER_KEY = 'vendMailOwner';
const MAIL_ADDR_KEY = 'vendMailAddress';
const MAIL_POLL_MS = 6000; // 后端 2 秒一次限速，6 秒稳妥

function renderMails(mails) {
  const box = $('mailList');
  box.textContent = '';
  $('mailFoot').textContent = mails.length
    ? `只显示最近的邮件 · 邮箱 ${Math.round((state.meta?.mailTtlDays || 3))} 天后自动失效`
    : '还没有邮件。把这个地址填到注册页面，收到的信会自动出现在这里。';
  for (const mail of mails) {
    const item = document.createElement('article');
    item.className = 'mail-item';
    const initial = (mail.from || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase() || '@';
    item.innerHTML = `<span class="mail-ico">${escapeHtml(initial)}</span>
      <div class="mail-main">
        <div class="mail-top"><span class="mail-from"></span><span class="mail-addr-sm"></span><span class="mail-time"></span></div>
        <p class="mail-sub"></p>
      </div>`;
    const from = String(mail.from || '未知发件人');
    const nameMatch = /^(.*?)\s*<([^>]+)>$/.exec(from);
    item.querySelector('.mail-from').textContent = (nameMatch ? nameMatch[1] : from).trim() || '未知发件人';
    item.querySelector('.mail-addr-sm').textContent = nameMatch ? nameMatch[2] : '';
    item.querySelector('.mail-time').textContent = mail.receivedAt || '';
    item.querySelector('.mail-sub').textContent = mail.subject || '(无主题)';

    const main = item.querySelector('.mail-main');
    if (mail.code) {
      const box2 = document.createElement('div');
      box2.className = 'mail-code';
      box2.innerHTML = '<span class="label">检测到验证码</span><span class="val"></span><button type="button">复制</button>';
      box2.querySelector('.val').textContent = mail.code;
      box2.querySelector('button').addEventListener('click', () => copy(mail.code, '验证码'));
      main.append(box2);
    }
    if (Array.isArray(mail.links) && mail.links.length) {
      const links = document.createElement('p');
      links.className = 'mail-links';
      // 很多平台发的是确认链接而不是验证码，这条不显示等于功能缺一半
      const a = document.createElement('a');
      a.href = mail.links[0];
      a.target = '_blank';
      a.rel = 'noopener noreferrer nofollow';
      a.textContent = '打开信里的链接';
      links.append(a);
      main.append(links);
    }
    if (mail.body) {
      const body = document.createElement('p');
      body.className = 'mail-sub';
      body.textContent = mail.body;
      main.append(body);
    }
    const acts = document.createElement('div');
    acts.className = 'mail-acts';
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '删除这封';
    del.addEventListener('click', () => deleteMail(mail.id));
    acts.append(del);
    main.append(acts);

    box.append(item);
  }
}

function renderMailboxes(list) {
  const box = $('boxList');
  box.textContent = '';
  // 只有一个邮箱时没必要给个下拉
  $('myBoxes').hidden = list.length <= 1;
  if (list.length <= 1) $('myBoxes').classList.remove('open');
  for (const item of list) {
    const row = document.createElement('div');
    row.className = 'box-row';
    row.innerHTML = '<span class="mono"></span><span class="exp"></span><button type="button">切换</button>';
    row.querySelector('.mono').textContent = item.address;
    const days = Math.max(0, (item.expiresAt - Date.now()) / 86400000);
    row.querySelector('.exp').textContent = days >= 1 ? `${days.toFixed(1)} 天后失效` : `${Math.round(days * 24)} 小时后失效`;
    row.querySelector('button').addEventListener('click', () => {
      state.mailAddress = item.address;
      try { localStorage.setItem(MAIL_ADDR_KEY, item.address); } catch { /* 忽略 */ }
      $('mailAddr').textContent = item.address;
      loadMails();
    });
    box.append(row);
  }
}

async function createMailbox(name = '') {
  const button = name ? $('btnCustomMail') : $('btnNewMail');
  const label = button.textContent;
  button.disabled = true; button.textContent = '创建中…';
  try {
    const body = { owner: state.mailOwner };
    if (name) body.name = name;
    const data = await api('/api/mail/create', { method: 'POST', body });
    state.mailOwner = data.owner;
    state.mailAddress = data.address;
    try {
      localStorage.setItem(MAIL_OWNER_KEY, data.owner);
      localStorage.setItem(MAIL_ADDR_KEY, data.address);
    } catch { /* 隐私模式下写不了就算了 */ }
    $('mailAddr').textContent = data.address;
    $('mailPrefix').value = '';
    // 后端会强制加 tmp 前缀并去掉符号，实际地址跟买家输入的不一样，必须以返回值为准
    if (name && !data.address.startsWith(`tmp${name.replace(/[^a-z0-9]/gi, '').toLowerCase()}`)) {
      toast(`地址已生成：${data.address}`);
    } else {
      toast('邮箱已创建');
    }
    await Promise.all([loadMailboxes(), loadMails()]);
    startMailPolling();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false; button.textContent = label;
  }
}

async function loadMailboxes() {
  if (!state.mailOwner) { renderMailboxes([]); return; }
  try {
    const data = await api(`/api/mail/mine?owner=${encodeURIComponent(state.mailOwner)}`);
    const list = data.mailboxes || [];
    renderMailboxes(list);
    if (!state.mailAddress && list.length) {
      state.mailAddress = list[0].address;
      $('mailAddr').textContent = state.mailAddress;
    }
  } catch { renderMailboxes([]); }
}

async function loadMails({ quiet = false } = {}) {
  if (!state.mailOwner || !state.mailAddress) return;
  try {
    const params = new URLSearchParams({ owner: state.mailOwner, address: state.mailAddress });
    const data = await api(`/api/mail/list?${params}`);
    renderMails(data.mails || []);
  } catch (error) {
    if (!quiet && error.code !== 'poll_rate') toast(error.message, true);
  }
}

async function deleteMail(id) {
  try {
    await api('/api/mail/delete', { method: 'POST', body: { owner: state.mailOwner, address: state.mailAddress, id } });
    toast('已删除');
    await loadMails();
  } catch (error) { toast(error.message, true); }
}

async function releaseMailbox() {
  if (!state.mailAddress) { toast('还没有邮箱', true); return; }
  if (!window.confirm('注销后这个邮箱立即失效，里面的邮件也读不到了。确定吗？')) return;
  try {
    await api('/api/mail/release', { method: 'POST', body: { owner: state.mailOwner, address: state.mailAddress } });
    state.mailAddress = null;
    try { localStorage.removeItem(MAIL_ADDR_KEY); } catch { /* 忽略 */ }
    $('mailAddr').textContent = '还没有邮箱，点右边创建一个';
    $('mailList').textContent = '';
    stopMailPolling();
    await loadMailboxes();
    toast('邮箱已注销');
  } catch (error) { toast(error.message, true); }
}

function startMailPolling() {
  stopMailPolling();
  if (document.body.dataset.tab !== 'mail') return;
  state.mailTimer = setInterval(() => loadMails({ quiet: true }), MAIL_POLL_MS);
}
function stopMailPolling() { if (state.mailTimer) clearInterval(state.mailTimer); state.mailTimer = null; }

// ---------- GEO 区块 ----------

// FAQ 已经静态写进 index.html（正文 + FAQPage 结构化数据都在 HTML 里）。
// 原因：robots.txt 专门放行了 GPTBot / ClaudeBot / PerplexityBot 这些**不跑 JS**的爬虫，
// 而之前 FAQ 是运行时注入的 —— 它们抓到的是一个空 <script> 和零个问答，
// 为 GEO 花的力气对目标受众等于没有。
//
// 这里只留一道自检：结构化数据里的每一问一答，必须在页面上真的看得见。
// Google 的政策要求 FAQPage 的内容对用户可见，对不上会吃人工处置。
function auditFaq() {
  let data;
  try { data = JSON.parse(document.getElementById('faqLd')?.textContent || '{}'); } catch { return; }
  const text = document.getElementById('faq')?.innerText || '';
  const miss = (data.mainEntity || []).filter((q) => !text.includes(q.name));
  if (miss.length) console.warn('[vend] FAQ 结构化数据和页面对不上：', miss.map((q) => q.name));
}

function renderPriceTable() {
  const rows = $('priceRows');
  rows.textContent = '';
  const list = state.services.filter((s) => s.featured).slice(0, 10);
  if (!list.length) { rows.innerHTML = '<tr><td colspan="3" class="muted">正在读取各平台的可用国家…</td></tr>'; return; }
  for (const svc of list) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td></td><td></td><td></td>';
    const cells = tr.querySelectorAll('td');
    cells[0].textContent = svc.name;
    // 不再显示起步价（安哥要求）：卡密是预付的，标价格只会让买家去算我们的成本。
    // 但整块删掉会丢掉 GEO 的结构化内容，所以保留「可用国家数 + 库存」这类能力信息。
    cells[1].textContent = `${svc.countries} 个国家可选`;
    cells[2].textContent = svc.stock >= 10000
      ? `${(svc.stock / 10000).toFixed(1)} 万个号在库`
      : `${svc.stock} 个号在库`;
    rows.append(tr);
  }
}

// ---------- 面板切换 ----------

function switchTab(name) {
  document.body.dataset.tab = name;
  // 面板显隐由 CSS 的 [data-tab] 管；这里只同步 tab 自己的选中态（新皮用 aria-selected）
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.go === name));
  }
  if (name === 'mail') {
    loadMailboxes().then(() => loadMails({ quiet: true }));
    startMailPolling();
  } else {
    stopMailPolling();
  }
  if (name === 'codex') openCodex(); else closeCodex();
}


// ---------- 实时可用榜 ----------
//
// 给买家看「除了 ChatGPT，这些平台也能接码」。
// 数据是**真实库存**，不是编的——库存跟有没有人下单无关，一直是满的、一直在变，
// 所以不用造假就能滚起来（安哥原本想用随机假数据，问题是那会变成伪造成交记录）。
//
// 泰国和美国那两条标「卖家推荐」：那是安哥自己验证过的高成功率地区，
// 属于经营经验，不是我们测出来的数据，措辞上要分得清，不能写成「成功率 XX%」。

const LIVE_ROTATE_MS = 3600;
const LIVE_VISIBLE = 4;
let liveRows = [];
let liveIndex = 0;
let liveTimer = null;

function liveRowNode(row) {
  const node = document.createElement('div');
  node.className = 'live-row';
  const stock = row.stock >= 10000
    ? `${(row.stock / 10000).toFixed(1)} 万个可用`
    : `${row.stock} 个可用`;
  // 六个格子按交付稿的 .live-row 排布来填，最后一格靠 .muted 的 margin-left:auto 右对齐。
  // 少填一格整行就会左边挤成一坨 —— 上一版就是这么变难看的。
  node.innerHTML = '<span class="mono"></span>'
    + flagHtml({ id: row.countryId }, { width: 22, height: 16 })
    + '<b></b><span class="live-svc"></span><span class="live-ok"></span>'
    + '<span class="muted"></span>';
  node.querySelector('.mono').textContent = row.priceCny != null ? `¥${Number(row.priceCny).toFixed(2)}` : '';
  node.querySelector('b').textContent = row.countryName;
  node.querySelector('.live-svc').textContent = row.serviceName;
  node.querySelector('.live-ok').textContent = stock;
  node.querySelector('.muted').textContent = row.recommended ? '卖家推荐' : '';
  if (row.recommended) node.querySelector('.muted').classList.add('live-pick');
  return node;
}

function renderLive() {
  const box = $('liveList');
  if (!box || !liveRows.length) return;
  box.textContent = '';
  for (let i = 0; i < Math.min(LIVE_VISIBLE, liveRows.length); i += 1) {
    const node = liveRowNode(liveRows[(liveIndex + i) % liveRows.length]);
    if (i === 0) node.classList.add('in');   // 只有最上面那条做入场动画
    box.append(node);
  }
}

function stopLive() { clearInterval(liveTimer); liveTimer = null; }

function startLive() {
  stopLive();
  if (liveRows.length <= LIVE_VISIBLE) return;   // 条数不够就不用滚
  liveTimer = setInterval(() => {
    liveIndex = (liveIndex + 1) % liveRows.length;
    renderLive();
  }, LIVE_ROTATE_MS);
}

async function loadShowcase() {
  const box = $('liveList');
  try {
    const data = await api('/api/vend/showcase');
    liveRows = (data?.rows || []).filter((r) => r.stock > 0 && r.countryName);
    if (!liveRows.length) throw new Error('空榜单');
    renderLive();
    startLive();
  } catch (error) {
    console.warn('[vend] 实时可用榜取不到', error);
    // 取不到就把这块收掉，不要留一行「加载中…」永远转
    if (box) box.closest('.live')?.setAttribute('hidden', '');
  }
}

// ---------- 启动 ----------

async function boot() {
  // 国旗和服务图标的清单必须在画列表**之前**就位。
  // 之前 loadIsoMap() 没 await，靠「地区列表加载得比它慢」侥幸不出错 ——
  // 两份都是几十 KB 的静态 JSON，等一下比赌一把便宜。
  await Promise.all([loadIsoMap(), loadServiceIcons()]);
  auditFaq();

  try { state.mailOwner = localStorage.getItem(MAIL_OWNER_KEY); } catch { /* 忽略 */ }
  try { state.mailAddress = localStorage.getItem(MAIL_ADDR_KEY); } catch { /* 忽略 */ }
  if (state.mailAddress) $('mailAddr').textContent = state.mailAddress;

  try {
    state.meta = await api('/api/vend/meta');
    state.maxChanges = state.meta.maxChanges ?? null;
    const minutes = Math.round((state.meta.activationTtlSec || 1200) / 60);
    $('rule1').textContent = `${minutes} 分钟内没收到验证码，费用退回这张卡密，可以接着用`;
    // 上游没有次数限制，但换号要先退旧号、而旧号 90 秒内退不掉，
    // 所以是「不限次数、每次间隔约 90 秒」，不能写成真·无限。
    $('rule3').textContent = state.maxChanges == null
      ? `${minutes} 分钟有效期内可反复更换号码，每次间隔约 90 秒（接码平台限制），费用都退回`
      : `收不到码可更换号码，一张卡密最多换 ${state.maxChanges} 次`;
    if (state.meta.alipayQrUrl) $('alipayQr').src = state.meta.alipayQrUrl;
    if (state.meta.mailTtlDays) setText('mailTtlText', `${state.meta.mailTtlDays} 天`);
  } catch (error) {
    console.warn('[vend] meta 加载失败', error);
  }

  await loadServices();
  loadShowcase();
  renderStage(null);
  maybeAutoAnnounce();

  // 事件绑定
  // 新皮的 #cardForm 是个 <div class="search">，不是 <form> —— submit 事件永远不会来。
  // 改成按钮点击 + 输入框回车，两条路都要有：买家粘完卡密的第一反应就是敲回车。
  $('btnVerify').addEventListener('click', verifyCard);
  $('cardInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') verifyCard(e); });
  $('btnPrimary').addEventListener('click', primaryAction);
  $('btnChange').addEventListener('click', () => changeNumber());
  $('btnTier').addEventListener('click', openTierPicker);
  $('btnTierClose').addEventListener('click', closeTierPicker);
  $('tierMask').addEventListener('click', (event) => {
    if (event.target === $('tierMask')) closeTierPicker();
  });
  $('btnCancel').addEventListener('click', cancelNumber);
  $('btnVoid').addEventListener('click', voidCard);
  // 完整号码
  $('btnCopyNum').addEventListener('click', () => copy(state.phoneParts?.full || state.activation?.phone, '号码（含区号）'));
  // 不含区号的号码：有些验证页要求这种
  $('btnCopyNat')?.addEventListener('click', () => {
    const nat = state.phoneParts?.national;
    if (!nat) { toast('这个号码拆不出区号，请用完整号码', true); return; }
    copy(nat, '号码（不含区号）');
  });
  $('btnCopyCode').addEventListener('click', () => copy(state.activation?.smsCode, '验证码'));
  $('btnReSvc').addEventListener('click', backToService);

  let svcTimer = null;
  $('svcSearch').addEventListener('input', () => {
    clearTimeout(svcTimer);
    svcTimer = setTimeout(loadServices, 220);
  });
  $('regSearch').addEventListener('input', renderRegions);

  $('btnTopupClose').addEventListener('click', closeTopup);
  $('btnAlipayPay')?.addEventListener('click', startAlipayPay);
  // 页脚「联系卖家」：原来跳使用教程，买家要找人的时候看到一篇文档更火大
  $('btnContact')?.addEventListener('click', (event) => { event.preventDefault(); openContact(); });
  $('btnContactClose')?.addEventListener('click', closeContact);
  // 意见反馈：右边缘竖排胶囊（窄屏隐藏）+ 页脚入口，走同一个弹窗
  for (const id of ['btnFeedback', 'btnFeedbackFoot']) {
    $(id)?.addEventListener('click', (event) => { event.preventDefault(); openFeedback(); });
  }
  $('btnFbClose')?.addEventListener('click', closeFeedback);
  $('btnFbCancel')?.addEventListener('click', closeFeedback);
  $('btnFbSend')?.addEventListener('click', sendFeedback);

  // Codex 一键邀请
  $('cxCardVerify')?.addEventListener('click', (e) => verifyCard(e, { inputId: 'cxCardInput', buttonId: 'cxCardVerify' }));
  $('cxCardInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') verifyCard(e, { inputId: 'cxCardInput', buttonId: 'cxCardVerify' });
  });
  $('cxTake')?.addEventListener('click', cxTake);
  $('cxSent')?.addEventListener('click', cxMarkSent);
  $('cxCopyAddr')?.addEventListener('click', () => copy(state.cx.address, '邮箱地址'));
  $('cxOk')?.addEventListener('change', renderCxGate);
  $('fbText')?.addEventListener('input', () => { $('fbCount').textContent = String($('fbText').value.length); });
  $('btnTopupOther').addEventListener('click', closeTopup);
  $('btnTopupClaim').addEventListener('click', claimTopup);

  $('annPill').addEventListener('click', openAnnouncement);
  $('btnAnnClose').addEventListener('click', closeAnnouncement);
  $('btnAnnOk').addEventListener('click', closeAnnouncement);

  $('btnNewMail').addEventListener('click', () => createMailbox());
  $('btnCustomMail').addEventListener('click', () => createMailbox($('mailPrefix').value.trim()));
  $('btnCopyAddr').addEventListener('click', () => copy(state.mailAddress, '邮箱地址'));
  $('btnReleaseMail').addEventListener('click', releaseMailbox);
  $('btnMailMenu').addEventListener('click', () => { $('mailOpts').hidden = !$('mailOpts').hidden; });

  // 手风琴标题行可以点开。买家想先看看支持哪些平台再掏卡密，别拦着。
  for (const head of document.querySelectorAll('.rail-step .step-head')) {
    head.addEventListener('click', () => {
      if (['waiting', 'done'].includes(document.body.dataset.state)) return;
      const key = head.closest('.rail-step')?.dataset.step;
      if (!key) return;
      // 地区那一步得先选了服务才有内容可看
      if (key === 'reg' && !state.service) { toast('先选一个服务'); return; }
      state.openStep = state.openStep === key ? null : key;
      syncSteps();
    });
  }

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => switchTab(tab.dataset.go));
  }

  // 弹窗点遮罩关闭 + ESC 关闭
  const CLOSERS = {
    annMask: closeAnnouncement, topupMask: closeTopup,
    contactMask: closeContact, fbMask: closeFeedback,
  };
  for (const mask of [$('topupMask'), $('annMask'), $('contactMask'), $('fbMask')]) {
    if (!mask) continue;
    mask.addEventListener('click', (event) => {
      if (event.target !== mask) return;
      CLOSERS[mask.id]?.();
    });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    // 后开的先关：联系/反馈弹窗可能盖在补差价弹窗上面
    // 邀请页是标签页不是弹窗，ESC 不该把它关掉
    else if (!$('fbMask')?.hidden) closeFeedback();
    else if (!$('contactMask')?.hidden) closeContact();
    else if (!$('topupMask').hidden) closeTopup();
    else if (!$('annMask').hidden) closeAnnouncement();
  });

  // 切走标签页时停轮询，回来再继续，省得白刷上游
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopMailPolling(); stopLive(); stopCodexPolling(); return; }
    // 切回来要把向导的轮询接上。只停不启的话，买家去邮箱那边看一眼再回来，
    // 向导就永远停在"正在等邀请信"不动了 —— 而信其实早就到了
    if (document.body.dataset.tab === 'codex') { cxTick(); startCodexPolling(); }
    startLive();
    if (document.body.dataset.tab === 'mail') startMailPolling();
  });
}

boot();
