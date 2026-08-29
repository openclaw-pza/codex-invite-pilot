// relay.js — 书签弹窗的逻辑。
// 必须是外部文件：我们自己的 CSP 是 script-src 'self'（没有 unsafe-inline），
// 内联 <script> 会被自己挡掉。这条 CSP 是对的，不为了图省事放宽它。
// 这页跑在**我们自己的源**上，所以读得到买家的邮箱归属和取到的号码；
// 它通过 postMessage 把值送回打开它的那个 OpenAI 页面。
// 为什么不用 iframe：OpenAI 的 CSP 里 child-src 'self'，iframe 直接被挡；
// 而 CSP 没有任何指令管辖 window.open 弹窗。

// 只把值回传给这些来源。不设白名单的话，买家在任意页面上点了书签，
// 他的邮箱和验证码就会被送给那个页面 —— 值不大但没必要送。
const ORIGIN_OK = [
  'https://chatgpt.com', 'https://auth.openai.com', 'https://openai.com',
  'https://platform.openai.com', 'https://codex.chatgpt.com',
];
// 本机地址放行是给端到端测试用的。localhost 上跑着恶意页面的话，
// 攻击者已经在这台机器上了，这条白名单救不了什么。
const isAllowedOrigin = (origin) => ORIGIN_OK.includes(origin)
  || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);

let opener = null;
let openerOrigin = null;

const $ = (id) => document.getElementById(id);
const msg = (html, cls = '') => { $('msg').innerHTML = html; $('msg').className = 'msg ' + cls; };

// 握手：**我们先喊**，对方用 event.source 回。
// 反过来（开页方拿 popup 引用主动喊）实测不可靠：跨源弹窗的 window 引用
// 有时 .closed 直接是 true，重试循环第一次就自己停，而且完全静默。
//
// 第一声招呼用 '*' 是安全的：它不带任何数据，只是"我在这儿"。
// 真正的值只往握手确认过的那个源发。
function sayHello() {
  if (!window.opener) return;
  try { window.opener.postMessage({ t: 'vend-relay-here' }, '*'); } catch (e) { /* 引用没了 */ }
}
sayHello();
// 对方的 message 监听器可能还没装上，重试几次；连上就停
const helloTimer = setInterval(() => {
  if (opener) { clearInterval(helloTimer); return; }
  sayHello();
}, 300);
setTimeout(() => clearInterval(helloTimer), 8000);

window.addEventListener('message', (event) => {
  if (!event.data || event.data.t !== 'vend-hello') {
    if (event.data?.t === 'vend-result') {
      msg(event.data.ok
        ? '<span class="ok">✓ 填好了。回那个页面点「继续」。</span>'
        : '没找到对应的输入框。可能是这一步还没到，或者页面刚变过——'
          + '直接手动复制粘贴也行：值就在上面，点一下会复制。');
    }
    return;
  }
  if (!isAllowedOrigin(event.origin)) {
    // 别静默失败。买家看到的会是"没连上"，而真实原因是他在一个我们不认识的
    // 域名上点了书签（OpenAI 换域名、或者他点错页面了）——
    // 把域名显示出来，他截个图我们一眼就知道要加哪个。
    msg(`这个页面（${event.origin}）不在允许列表里，没有自动填。`
      + '如果你确实在 OpenAI 的注册页上，请把这行发给卖家。下面的值可以手动复制。');
    return;
  }
  opener = event.source;
  openerOrigin = event.origin;
  event.source.postMessage({ t: 'vend-ready' }, event.origin);
});

function send(kind, value) {
  if (!opener || !openerOrigin) {
    // 握手没成也别让买家白点：至少把值放进剪贴板
    navigator.clipboard?.writeText(String(value)).then(
      () => msg('没连上那个页面，已经帮你复制了，直接粘贴就行。'),
      () => msg('没连上那个页面，请手动复制上面的值。'),
    );
    return;
  }
  opener.postMessage({ t: 'vend-fill', kind, value: String(value) }, openerOrigin);
  msg('已送过去，正在填…');
}

function row({ kind, label, value, hint }) {
  const b = document.createElement('button');
  b.className = 'item';
  b.type = 'button';
  if (!value) {
    b.disabled = true;
    b.innerHTML = `<span class="k">${label}</span><span class="v" style="font-family:var(--sans);font-weight:500;color:var(--t4)">${hint}</span>`;
    return b;
  }
  b.innerHTML = `<span class="k">${label}</span><span class="v"></span><span class="go">填进去</span>`;
  b.querySelector('.v').textContent = value;
  b.addEventListener('click', () => send(kind, value));
  return b;
}

async function load() {
  const box = $('items');
  const read = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
  const address = read('vendMailAddress');
  const owner = read('vendMailOwner');
  // 号码和短信码由主站在取到号时写进来。**不存会话令牌** ——
  // 这页只需要值本身，没必要让一个弹窗页拿到能花钱的凭据。
  const phone = read('vendPhoneNat') || read('vendPhone');
  const sms = read('vendSmsCode');

  let otp = '';
  if (address && owner) {
    try {
      const r = await fetch(`/api/mail/list?owner=${encodeURIComponent(owner)}&address=${encodeURIComponent(address)}`);
      const j = await r.json();
      // 取最新一封验证码信。重发过码的话旧的已经失效，必须用新的那条
      const hit = (j?.data?.mails || []).find((m) => m.kind === 'otp' && m.code);
      otp = hit?.code || '';
    } catch { /* 拉不到就先不显示，买家可以关掉重开 */ }
  }

  box.append(
    row({ kind: 'email', label: '邮箱', value: address, hint: '还没建邮箱' }),
    row({ kind: 'otp', label: '邮箱验证码', value: otp, hint: '还没收到' }),
    row({ kind: 'phone', label: '手机号', value: phone, hint: '还没取号' }),
    row({ kind: 'sms', label: '短信验证码', value: sms, hint: '还没收到' }),
  );

  if (!address) {
    msg('还没在取号站建临时邮箱。回到 <b>Codex 邀请助手</b> 先建一个。');
  }
}

load();
