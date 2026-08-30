// merge-redesign.mjs — 把 Claude Design 的新稿合并进生产。
//
// 为什么用浏览器 DOM 而不是字符串替换：这次要往 58 个元素上挂回 id，
// 还要做十几处结构改造。字符串替换错一个位置是静默的，DOM 选择器不匹配会**当场报出来**。
//
// 交付稿的问题（已核实）：
//   · README 说「86 个 id 一个没改没删」，实际只有 31 个 —— 它保留的恰好是我在提示词里
//     举例列出的那 30 个，把举例当成了全集。这一半是我的提示词没给全清单。
//   · 「注销卡密并申请退款」整块没了（那是退款逃生口）
//   · 国旗用 emoji（Windows 退化成字母）；自定义邮箱前缀、注销邮箱等控件也没了
//
// 用法：node scripts/merge-redesign.mjs   （只写 public/vend/index.html，CSS 另外走）

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';

import { dirname as _dirname, join as _join } from 'node:path';
import { fileURLToPath as _fileURLToPath } from 'node:url';
// 仓库根由脚本自身位置算出，不写死 —— 写死的话别人 clone 到任何别的目录都跑不了。
const ROOT = _join(_dirname(_fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/');

const SRC = 'C:/WINDOWS/TEMP/claude/D----/fae349b8-7916-464f-82e6-ab335a208072/scratchpad/redesign/deliver/index.html';
const CUR = `${ROOT}/public/vend/index.html`;
const OUT = CUR;

// ---------- 1. 从现有文件里抠出 <head>：meta / canonical / og / 三段 JSON-LD / favicon ----------
const cur = readFileSync(CUR, 'utf8');
const headMatch = cur.match(/<head>([\s\S]*?)<\/head>/);
if (!headMatch) throw new Error('现有 index.html 里找不到 <head>，先确认它有 doctype 和 head');
const HEAD_INNER = headMatch[1];

// FAQ 正文要和 head 里的 FAQPage 结构化数据逐条对应。head 是第 4 步才换的，
// 所以先在 Node 侧解析出来，作为参数传进页面。
let FAQ_ITEMS = [];
try {
  const m = HEAD_INNER.match(/id="faqLd"[^>]*>([\s\S]*?)<\/script>/);
  if (m) FAQ_ITEMS = (JSON.parse(m[1]).mainEntity || []).map((q) => [q.name, q.acceptedAnswer.text]);
} catch (e) { console.error('faqLd parse failed: ' + e.message); }
console.log('FAQ items: ' + FAQ_ITEMS.length);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(pathToFileURL(SRC).href, { waitUntil: 'load', timeout: 60_000 });

// ---------- 2. 把 id 挂回去 ----------
// 左边是新稿里的选择器，右边是 vend.js 绑的 id。选不中会报出来，不静默跳过。
const ID_MAP = [
  ['.topbar .ann-pill', 'annPill'],
  ['.topbar .ann-pill .ann-dot', 'annDot'],
  ['.topbar .chip', 'cardChip'],

  ['section[data-step="key"] .search', 'cardForm'],
  ['section[data-step="key"] .rail-note', 'cardHint'],
  ['#cardOk .mono', 'cardOkCode'],
  ['#cardOk .muted', 'cardOkMeta'],

  ['section[data-step="svc"]', 'stepService'],
  ['section[data-step="svc"] .step-head .muted', 'svcCount'],
  ['section[data-step="svc"] .picked', 'pickedSvc'],
  ['section[data-step="svc"] .picked .svc-ico', 'pickedIco'],
  ['section[data-step="svc"] .picked .picked-name', 'pickedName'],
  ['section[data-step="svc"] .picked .linkish', 'btnReSvc'],

  ['section[data-step="reg"]', 'stepRegion'],
  ['section[data-step="reg"] .step-head .muted', 'regCount'],

  ['.rail-summary', 'stepSummary'],

  ['.stage-wrap', 'smsPane'],
  ['.stage .stage-empty', 'stageEmpty'],
  ['.stage .badge', 'stageBadge'],
  ['.stage .badge span:last-child', 'stageBadgeText'],
  ['.stage .numline', 'numLine'],
  ['.stage .numline button', 'btnCopyNum'],
  ['.stage .numhint', 'numHint'],
  ['.stage .sms-raw', 'smsRaw'],
  ['.stage .countdown', 'countdown'],
  ['.stage .cd-line .cd-total', 'cdTotal'],
  ['.stage .stage-actions', 'stageActions'],
  ['.stage .act-note', 'actNote'],

  ['.mail-wrap', 'mailPane'],
  ['.mail-opts .btn-quiet', 'btnCopyAddr'],
  ['.mail-opts .linkish', 'btnMailMenu'],
  ['.my-mailboxes', 'myBoxes'],
  ['.inbox-foot', 'mailFoot'],

  ['section.geo', 'geo'],

  ['#topupMask .modal-sub', 'topupSub'],
  ['#topupMask .topup-copy', 'tcPayLine'],
  ['#topupMask .modal-actions .btn-ghost', 'btnTopupOther'],

  ['#annMask .ann-modal', 'annModal'],
  ['#annMask .ann-head .x', 'btnAnnClose'],
  ['#annMask .ann-skip input', 'annSkip'],
];

const idResult = await page.evaluate((map) => {
  const miss = [];
  for (const [sel, id] of map) {
    const el = document.querySelector(sel);
    if (!el) { miss.push(`${id} <- ${sel}`); continue; }
    el.id = id;
  }
  return miss;
}, ID_MAP);
console.log(`id 挂回：${ID_MAP.length - idResult.length}/${ID_MAP.length}`);
if (idResult.length) console.error('  ✖ 选不中：\n   ' + idResult.join('\n   '));

// ---------- 3. 结构改造：新稿缺的元素补回来 ----------
const structResult = await page.evaluate((FAQ_ITEMS) => {
  const miss = [];
  const need = (sel) => { const el = document.querySelector(sel); if (!el) miss.push(sel); return el; };
  const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

  // 3.1 首段自我介绍 + 计数（GEO 要的，新稿把它删了）
  const head = need('.page-head');
  if (head) {
    head.insertAdjacentHTML('beforeend',
      '<p id="lede">给 OpenAI、Discord 等 <b id="svcTotal">700+</b> 个平台接收短信验证码的临时手机号，' +
      '覆盖 <b id="regTotal">100+</b> 个国家和地区，最低 ¥0.11 一个号。买了卡密就能用，收不到码可反复换号，或退款。</p>' +
      '<p id="pickHint" class="pick-hint" hidden></p>');
  }

  // 3.2 号码那一行：把国旗和地区名包进 #numFlag，vend.js 是整体重绘这一块的
  const nl = need('#numLine');
  if (nl) {
    const flag = nl.querySelector('.numflag');
    const name = nl.querySelector('.numflag-name');
    if (flag && name) {
      const wrap = h('<span id="numFlag" class="numflag-wrap"></span>');
      flag.parentNode.insertBefore(wrap, flag);
      wrap.append(flag, name);
    }
  }

  // 3.2b 号码行加一个「只复制号码」按钮：有些平台的验证页要求填不含区号的号码
  const numLineEl = document.getElementById('numLine');
  if (numLineEl && !document.getElementById('btnCopyNat')) {
    numLineEl.insertAdjacentHTML('beforeend',
      '<button id="btnCopyNat" class="btn-quiet btn-sm" type="button">只复制号码</button>');
  }

  // 3.3 短信原文：正文要能被 JS 单独写入
  const raw = need('#smsRaw');
  if (raw) {
    const p = raw.querySelector('p');
    if (p) p.innerHTML = '短信原文：<span id="smsRawText"></span>';
  }

  // 3.3b 号码下面补一句区号提示（安哥要求把区号标清楚）
  const nh = document.getElementById('numHint');
  if (nh) nh.innerHTML = '把这个号填进注册页面，然后<b>回到本页</b>等验证码'
    + '<span class="num-hint-cc">如果注册页单独有「国家/区号」那一栏，区号填 <b>+区号</b>、号码栏只填后面那串</span>';

  // 3.4 摘要区：补 sumSvc / sumReg / sumNote，以及**注销卡密退款**（新稿整块丢了）
  const sum = need('#stepSummary');
  if (sum) {
    const picks = sum.querySelectorAll('.picked');
    if (picks[0]) picks[0].id = 'sumSvc';
    if (picks[1]) picks[1].id = 'sumReg';
    sum.insertAdjacentHTML('beforeend',
      '<p id="sumNote" class="rail-note"></p>' +
      // 换了几个号还收不到码时才出现。没有它买家只能直接去闲鱼开纠纷。
      '<div id="voidBox" class="void-box" hidden>' +
      '<p>试了几次都收不到？可以注销这张卡密并联系卖家退款。</p>' +
      '<button id="btnVoid" class="btn-ghost btn-block" type="button">注销卡密并申请退款</button>' +
      '</div>');
  }

  // 3.5 三条规则：JS 要按配置改写第 1 条和第 3 条
  const rules = document.querySelectorAll('.rules .rule');
  if (rules.length >= 3) {
    rules[0].innerHTML = '<b>20 分钟有效</b><span id="rule1">验证码未到可免费换号，或取消整单退款。</span>';
    rules[2].innerHTML = '<b>号码一次性</b><span id="rule3">收到本次验证码后即释放，不能长期保留。</span>';
  } else { miss.push('.rules .rule ×3'); }

  // 3.6 邮箱：自定义前缀 / 注销邮箱 / 有效期文案，新稿都没了
  const label = need('.addr-label');
  if (label) label.innerHTML = '你的临时邮箱地址 · 免费 · <b id="mailTtlText">3 天</b>后自动失效';
  // 自定义前缀那几个控件要单独成块：#mailOpts 是「更多」里可折叠的部分，
  // 挂到 .mail-opts 上会把复制/创建/我的邮箱这三个常驻按钮一起藏掉
  const opts = need('.mail-opts');
  if (opts) {
    opts.removeAttribute('id');
    opts.insertAdjacentHTML('afterend', '<div id="mailOpts" class="mail-more" hidden></div>');
    document.getElementById('mailOpts').insertAdjacentHTML('beforeend',
      '<label class="search wide"><input id="mailPrefix" type="text" maxlength="16" ' +
      'placeholder="想要的前缀（选填，3~16 位字母数字）" aria-label="自定义前缀"></label>' +
      '<button id="btnCustomMail" class="btn-ghost btn-sm" type="button">用这个前缀创建</button>' +
      '<button id="btnReleaseMail" class="btn-quiet btn-sm" type="button">注销当前邮箱</button>');
  }
  const boxes = need('#myBoxes');
  if (boxes) {
    const inner = h('<div id="boxList"></div>');
    while (boxes.firstChild) inner.append(boxes.firstChild);
    boxes.append(inner);
  }

  // 3.7 GEO 导语里的服务总数
  const lede = need('.geo-lede');
  if (lede) lede.insertAdjacentHTML('beforeend', ' 完整 <span id="geoSvcTotal">700+</span> 个平台可在上方搜索。');

  // 3.8 补差价弹窗：标题、关闭按钮、地区行、备注位、收款码换成真 img
  const tm = need('#topupMask');
  if (tm) {
    const h3 = tm.querySelector('.modal-head');
    if (h3) {
      h3.id = 'topupTitle';
      h3.insertAdjacentHTML('afterend', '');
      h3.parentNode.insertBefore(h('<button id="btnTopupClose" class="x" type="button" aria-label="关闭">×</button>'), h3.nextSibling);
    }
    const first = tm.querySelector('.tc-row .tc-name');
    if (first) first.id = 'tcRegion';
    const copy = tm.querySelector('#tcPayLine');
    if (copy) copy.innerHTML = '<strong id="tcPayText"></strong><br>转账时<strong id="tcMemo"></strong>，卖家核对到账后放行取号。';
    const qr = tm.querySelector('.qr');
    if (qr) qr.replaceWith(h('<img id="alipayQr" class="qr" src="alipay-qr-sq.jpg" alt="支付宝收款码" width="132" height="132">'));
  }

  // 3.9 公告弹窗：标题 id、二维码和宣传图换成真 img（JS 会重绘 annBody，这里只保证图片位对）
  const am = need('#annMask');
  if (am) {
    const ah = am.querySelector('.ann-head');
    if (ah) ah.id = 'annTitle';
    // 三个入口，顺序按安哥定的：介绍图 → QQ 群 → 客服微信。
    // 给买家多一条求助路径 —— 微信要加好友、QQ 群是即时的，门槛低很多。
    const imgs = am.querySelector('.ann-imgs');
    if (imgs) {
      imgs.innerHTML =
        '<figure class="ann-promo"><img src="img/plus-promo-web.jpg" alt="Plus / Pro 会员代充说明" width="1000" height="1023" loading="lazy"></figure>'
        + '<figure class="ann-qr-fig"><img class="ann-qr" src="img/qq-group-sq.jpg" alt="AI 交流售后群 QQ 群二维码" width="160" height="160" loading="lazy"><figcaption>QQ 群 422191460<br>扫码进群，有人答</figcaption></figure>'
        + '<figure class="ann-qr-fig"><img class="ann-qr" src="img/wechat-qr-sq.jpg" alt="客服微信二维码" width="160" height="160" loading="lazy"><figcaption>微信加客服<br>代充会员找这里</figcaption></figure>';
    }
  }

  // 3.9b 步骤计数的示例文案要清掉：没选服务之前显示「103 个在面额内 · 共 175」
  //      是编的数字，而且它暗示已经知道卡密面额了。JS 会在真正拿到数据后填。
  const rc = document.getElementById('regCount');
  if (rc) rc.textContent = '';

  // 3.9c 顶栏和页脚的「使用说明」在交付稿里是 href="#faq"（页内锚点）。
  //      那不是使用说明，是常见问题 —— 安哥反馈「点进去直接跳常见问题」就是这个。
  const helpLink = document.querySelector('.help-link');
  if (helpLink) helpLink.setAttribute('href', 'help.html');
  for (const a of document.querySelectorAll('.foot a')) {
    const t = (a.textContent || '').trim();
    if (t.includes('教程') || t.includes('说明')) a.setAttribute('href', 'help.html');
    else if (t.includes('问题')) a.setAttribute('href', '#faq');
    else if (a.getAttribute('href') === '#') a.setAttribute('href', 'help.html');
  }

  // 3.9d 「选择地区」改叫「选择国家」（安哥要求）
  const regHead = document.querySelector('section[data-step="reg"] .rail-h');
  if (regHead) regHead.textContent = '选择国家';
  const regSearchInput = document.getElementById('regSearch');
  if (regSearchInput) regSearchInput.setAttribute('placeholder', '搜索国家，如 美国、泰国');
  const emptyOl = document.querySelector('.stage-empty ol');
  if (emptyOl && emptyOl.children[2]) emptyOl.children[2].textContent = '选国家，取手机号';

  // 3.10 列表清空：这几块由 vend.js 整体重绘，留着示例行会先闪一下再被换掉
  for (const id of ['svcList', 'regList', 'mailList']) {
    const el = document.getElementById(id);
    if (el) el.textContent = ''; else miss.push('#' + id);
  }
  // 实时可用榜：留一行兜底（不跑 JS 的爬虫也能看到这块在说什么）
  const live = document.getElementById('liveList');
  if (live) live.innerHTML = '<div class="live-row muted">正在读取各平台实时库存…</div>';
  const lh = document.querySelector('.live-head');
  if (lh) lh.innerHTML = '<span class="blip"></span>实时可用 · 这些平台现在都能取号';

  // 3.11a 价格表的表头改成 3 列 —— 新稿是 4 列（平台/常用低价地区/起步价/说明），
  //       而 vend.js 的 renderPriceTable 只输出 3 列，直接错位：
  //       价格被放到「常用低价地区」下面、地区数被放到「起步价」下面。
  // 表头跟着 renderPriceTable 走。安哥要求去掉起步价：标价格等于把成本摊给买家看。
  // 整块删掉会丢 GEO 的结构化内容，所以换成「覆盖能力」——同样是真数据，还更好听。
  const thead = document.querySelector('.price-table thead tr');
  if (thead) thead.innerHTML = '<th>平台</th><th>可用国家</th><th>当前库存</th>';
  const geoH2 = [...document.querySelectorAll('.geo h2')][0];
  if (geoH2) geoH2.textContent = '这些平台都能接码';
  const geoLede = document.querySelector('.geo-lede');
  if (geoLede) geoLede.textContent = '下面是常用平台当前可选的国家数量和号码库存，实时取自接码平台。';

  // 3.11 价格表兜底行（不跑 JS 时不能停在"示例数据"上）
  const rows = document.getElementById('priceRows');
  if (rows) rows.innerHTML = '<tr><td colspan="3" class="muted">价格实时拉取，稍等一下就会出现在这里。</td></tr>';
  const gu = document.querySelector('.geo-updated');
  if (gu) gu.textContent = '价格与库存实时取自接码平台，页面每次打开都会重新拉取';

  // 3.11b FAQ 正文换成我们自己的 9 条，并保证和 head 里的 FAQPage 结构化数据一一对应。
  // 交付稿只放了 4 条示例问答，而 head 里的 JSON-LD 有 9 条 —— 对不上就是
  // Google 明令禁止的「结构化数据里的问答在页面上看不见」，会吃人工处置。
  const faq = document.getElementById('faq');
  if (faq && FAQ_ITEMS.length) {
    faq.innerHTML = FAQ_ITEMS.map((_, i) =>
      '<details' + (i === 0 ? ' open' : '') + '><summary><h3></h3></summary><p></p></details>').join('');
    // 用 textContent 写，免得答案里的引号或尖括号被当成标签
    faq.querySelectorAll('details').forEach((d, i) => {
      d.querySelector('h3').textContent = FAQ_ITEMS[i][0];
      d.querySelector('p').textContent = FAQ_ITEMS[i][1];
    });
  } else { miss.push('#faq or FAQ_ITEMS empty'); }

  // 3.12 toast 默认隐藏（vend.js 用 hidden 属性控制）
  const toast = document.getElementById('toast');
  if (toast) { toast.hidden = true; toast.textContent = ''; }

  // 3.13 两个遮罩默认隐藏
  for (const id of ['topupMask', 'annMask']) document.getElementById(id)?.setAttribute('hidden', '');

  return miss;
}, FAQ_ITEMS);
console.log(`结构改造：${structResult.length ? '✖ 找不到 ' + structResult.join(', ') : '全部命中'}`);

// ---------- 4. 换 head、样式表引用、脚本引用 ----------
await page.evaluate((headInner) => {
  document.head.innerHTML = headInner;
  document.documentElement.lang = 'zh-CN';
  const s = document.querySelector('script[src*="vend.js"]');
  if (s) s.remove(); // head 里已经有带哈希的引用了吗？没有的话下面补
}, HEAD_INNER);

let html = await page.evaluate(() => '<!doctype html>\n' + document.documentElement.outerHTML);
// 脚本放在 </body> 前，保持原来的位置
html = html.replace('</body>', '<script type="module" src="vend.js"></script>\n</body>');

writeFileSync(OUT, html, 'utf8');

// ---------- 5. 核对：JS 绑的 id 一个都不能少 ----------
const js = readFileSync(`${ROOT}/public/vend/vend.js`, 'utf8');
const bound = [...new Set([...js.matchAll(/\$\('([A-Za-z0-9]+)'\)/g)].map((m) => m[1]))];
const have = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const still = bound.filter((id) => !have.has(id));
console.log(`\nvend.js 绑定 ${bound.length} 个 id，现在缺 ${still.length} 个`);
if (still.length) console.error('  ✖ ' + still.join(' '));

await browser.close();
console.log(still.length || idResult.length || structResult.length ? '\n有未解决项，看上面' : '\n合并完成');
