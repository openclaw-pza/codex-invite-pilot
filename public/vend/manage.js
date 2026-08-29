// manage.js — 取号管理页脚本
// 必须是外链文件：服务端 CSP 是 script-src 'self'（不含 unsafe-inline），
// 写成内联 <script> 会被浏览器直接拦掉，整页点不动。

const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem('vendAdminToken') || '';

let toastTimer = null;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('err', Boolean(isError));
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

async function api(path, { method = 'GET', body = null } = {}) {
  const options = { method, headers: { 'X-Vend-Admin': token } };
  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  let payload = {};
  try { payload = await response.json(); } catch { /* 兜底 */ }
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `请求失败（${response.status}）`);
  }
  return payload.data;
}

function fmtTime(ms) {
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function loadTopups() {
  const body = $('topupBody');
  try {
    const data = await api('/api/vend/admin/topups');
    const rows = data.pending || [];
    if (!rows.length) {
      body.innerHTML = '<p class="empty">目前没有待核对的补差价。</p>';
      return;
    }
    const table = document.createElement('table');
    table.innerHTML = '<thead><tr><th>时间</th><th>卡密后四位</th><th>地区ID</th><th>应补</th><th></th></tr></thead>';
    const tbody = document.createElement('tbody');
    for (const row of rows) {
      const tr = document.createElement('tr');

      const time = document.createElement('td');
      time.textContent = fmtTime(row.claimed_at);

      const memo = document.createElement('td');
      memo.className = 'mono';
      // 买家转账时备注的就是这四位，用来对账
      memo.textContent = row.codeTail;

      const country = document.createElement('td');
      country.className = 'mono';
      country.textContent = row.country;

      const amount = document.createElement('td');
      amount.className = 'amt';
      amount.textContent = `¥${Number(row.need_cny).toFixed(2)}`;

      const actions = document.createElement('td');
      actions.style.textAlign = 'right';
      const ok = document.createElement('button');
      ok.className = 'pill sm';
      ok.textContent = '已到账';
      ok.onclick = async () => {
        if (!window.confirm(`确认收到 ¥${Number(row.need_cny).toFixed(2)}（备注 ${row.codeTail}）？确认后买家就能用这个地区取号。`)) return;
        ok.disabled = true;
        try {
          await api('/api/vend/admin/topups/confirm', { method: 'POST', body: { id: row.id } });
          toast('已确认');
          loadTopups();
        } catch (error) { toast(error.message, true); ok.disabled = false; }
      };
      const no = document.createElement('button');
      no.className = 'txtbtn alert';
      no.textContent = '没收到';
      no.onclick = async () => {
        if (!window.confirm('驳回后买家需要重新申请。确定？')) return;
        try {
          await api('/api/vend/admin/topups/reject', { method: 'POST', body: { id: row.id, note: '未查到到账' } });
          toast('已驳回');
          loadTopups();
        } catch (error) { toast(error.message, true); }
      };
      actions.append(no, ok);

      tr.append(time, memo, country, amount, actions);
      tbody.append(tr);
    }
    table.append(tbody);
    body.innerHTML = '';
    body.append(table);
  } catch (error) {
    body.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = error.message;
    body.append(p);
  }
}

async function loadRefunds() {
  const body = document.getElementById('refundBody');
  try {
    const data = await api('/api/vend/admin/refunds');
    const rows = data.pending || [];
    if (!rows.length) {
      body.innerHTML = '<p class="empty">目前没有待退款的卡密。</p>';
      return;
    }
    const table = document.createElement('table');
    table.innerHTML = '<thead><tr><th>注销时间</th><th>卡密后四位</th><th>面额</th><th>取过几次</th><th>闲鱼订单</th><th></th></tr></thead>';
    const tbody = document.createElement('tbody');
    for (const row of rows) {
      const tr = document.createElement('tr');
      const time = document.createElement('td');
      time.textContent = fmtTime(row.voidedAt);
      const tail = document.createElement('td');
      tail.className = 'mono';
      tail.textContent = row.codeTail;
      const denom = document.createElement('td');
      denom.className = 'amt';
      denom.textContent = '¥' + Number(row.denomCny).toFixed(2);
      const orders = document.createElement('td');
      orders.textContent = row.orders + ' 次';
      const order = document.createElement('td');
      order.className = 'mono';
      order.style.fontSize = '12px';
      // 闲鱼订单号是去平台退款时要用的，必须显示全
      order.textContent = row.orderId || '—';
      const actions = document.createElement('td');
      actions.style.textAlign = 'right';
      const done = document.createElement('button');
      done.className = 'pill sm';
      done.textContent = '已退款';
      done.onclick = async () => {
        if (!window.confirm('确认已经在下单平台给买家退过款了？（这里只记录，不会自动退钱）')) return;
        done.disabled = true;
        try {
          await api('/api/vend/admin/refunds/resolve', { method: 'POST', body: { codeTail: row.codeTail, action: 'refunded' } });
          toast('已标记退款');
          loadRefunds();
        } catch (error) { toast(error.message, true); done.disabled = false; }
      };
      const no = document.createElement('button');
      no.className = 'txtbtn alert';
      no.textContent = '不退';
      no.onclick = async () => {
        const note = window.prompt('不退的原因（会记在库里备查）：', '');
        if (note === null) return;
        try {
          await api('/api/vend/admin/refunds/resolve', { method: 'POST', body: { codeTail: row.codeTail, action: 'declined', note } });
          toast('已记录');
          loadRefunds();
        } catch (error) { toast(error.message, true); }
      };
      actions.append(no, done);
      tr.append(time, tail, denom, orders, order, actions);
      tbody.append(tr);
    }
    table.append(tbody);
    body.innerHTML = '';
    body.append(table);
  } catch (error) {
    body.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = error.message;
    body.append(p);
  }
}

// 对账：接码平台那边的钱。注意跟「待退款的卡密」是两回事——
// 那个是买家找你要钱，这个是你找接码平台要钱。
async function loadLedger() {
  const body = $('ledgerBody');
  const head = $('ledgerSummary');
  body.textContent = '加载中…';
  try {
    const data = await api('/api/vend/admin/ledger?days=7');
    const sum = data.summary || {};
    const rate = adminRate();
    const cny = (usd) => `¥${(Number(usd || 0) * rate).toFixed(2)}`;
    head.innerHTML = `近 ${data.days} 天：花出去 <b>${cny(sum.spentUsd)}</b>`
      + ` · 换来验证码 <b>${cny(sum.consumedUsd)}</b>`
      + ` · 退回来 <b>${cny(sum.refundedUsd)}</b>`
      + ` · <b class="bad">挂账 ${cny(sum.atRiskUsd)}</b>`;

    const rows = data.atRisk || [];
    if (!rows.length) {
      body.innerHTML = '<p class="mut sm">没有挂账的单子。</p>';
      return;
    }
    const cells = rows.map((row) => [
      fmtTime(row.createdAt),
      (row.phone || '—') + '<br><span class="mut sm">卡密尾号 ' + row.codeTail + '</span>',
      (row.service || '—') + ' / ' + (row.country || '—'),
      cny(row.priceUsd),
      refundLabel(row),
    ].map((cell) => '<td>' + cell + '</td>').join('')).map((tr) => '<tr>' + tr + '</tr>').join('');
    body.innerHTML = '<table class="tbl"><thead><tr>'
      + '<th>时间</th><th>号码</th><th>服务/地区</th><th>金额</th><th>平台怎么说</th>'
      + '</tr></thead><tbody>' + cells + '</tbody></table>';
  } catch (error) {
    body.textContent = error.message;
  }
}

// 把平台的原始返回翻译成人话，别让安哥去查错误码
function refundLabel(row) {
  if (row.refundState === 'denied') {
    const raw = String(row.refundRaw || '');
    if (/EARLY_CANCEL/i.test(raw)) return '拒退（下单后太快取消）';
    if (/NO_ACTIVATION|NOT_FOUND/i.test(raw)) return '号已不在，钱不退';
    return '拒退（' + (raw || '无详情') + '）';
  }
  if (row.state === 'expired') return '号过期作废，本就不退';
  if (row.state === 'reserved' || row.state === 'waiting') return '还在进行中';
  return '不确定退没退，需人工核';
}

// 汇率取买家页同一个来源；取不到就用默认 10，宁可显示得保守一点
function adminRate() {
  return Number(sessionStorage.getItem('vendRate')) || 10;
}

async function login() {
  token = $('token').value.trim();
  if (!token) { toast('请输入口令', true); return; }
  try {
    await api('/api/vend/admin/topups');
    sessionStorage.setItem('vendAdminToken', token);
    $('loginState').textContent = '已登录';
    $('ledgerPanel').hidden = false;
    $('topupPanel').hidden = false;
    $('refundPanel').hidden = false;
    $('issuePanel').hidden = false;
    $('token').value = '';
    loadTopups();
    loadRefunds();
    loadLedger();
  } catch (error) {
    toast(error.message, true);
    $('loginState').textContent = '口令不对';
  }
}

async function issue() {
  const button = $('btnIssue');
  button.disabled = true;
  try {
    const data = await api('/api/vend/admin/cards', {
      method: 'POST',
      body: { denomCny: Number($('denom').value), count: Number($('count').value) },
    });
    $('codes').hidden = false;
    $('codes').textContent = data.codes.join('\n');
    $('btnCopyCodes').hidden = false;
    toast(`已生成 ${data.count} 张`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

$('btnLogin').onclick = login;
$('token').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
$('btnRefresh').onclick = loadTopups;
$('btnRefreshRefunds').onclick = loadRefunds;
$('btnLedger').onclick = loadLedger;
$('btnIssue').onclick = issue;
$('btnCopyCodes').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('codes').textContent);
    toast('已复制');
  } catch { toast('复制失败，请手动选中', true); }
};

// 同一标签页刷新后免重输
if (token) { $('token').value = token; login(); }
