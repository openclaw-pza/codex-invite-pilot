// fill.src.js — 书签小工具的源码。构建脚本会把它压成一行 javascript: URL。
//
// 这段代码跑在 **OpenAI 的页面上**（买家点书签栏里那个书签时执行）。
// 网页脚本没法操作另一个源的 DOM，所以「自动填表」这件事**只能**由
// 跑在那个页面上的代码来做 —— 书签是唯一不用装任何东西就能做到这点的办法。
//
// 边界（这几条是刻意的，不是没做完）：
//   · 只填，不点提交。替买家点提交正是 OpenAI 判机器人的地方，号会当场废掉。
//   · 不碰 CAPTCHA。
//   · 不编造姓名年龄。扩展那版会随机编一个英文名 —— 那是在替买家提交虚假信息，
//     责任落在他头上。这里只填他自己的数据（邮箱/验证码/手机号）。
//
// 数据从哪来：点书签会弹出我们自己域名下的 relay 页，那页读得到买家的
// 邮箱地址和验证码（同源 localStorage + 我们的接口），买家在弹窗里点一下
// 要填哪个值，relay 用 postMessage 把值送回来。
// postMessage 不受页面 CSP 管辖，而 iframe 会被 child-src 挡住 —— 所以必须用弹窗。

(function () {
  var ORIGIN = '__RELAY_ORIGIN__';
  var RELAY = ORIGIN + '/relay.html';

  // 已经开着就聚焦，别开一堆
  if (window.__vendFill) { try { window.__vendFill.focus(); } catch (e) {} return; }

  var visible = function (el) {
    return Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  };
  var firstVisible = function (sels) {
    for (var i = 0; i < sels.length; i += 1) {
      var list = document.querySelectorAll(sels[i]);
      for (var j = 0; j < list.length; j += 1) if (visible(list[j])) return list[j];
    }
    return null;
  };

  // React 受控组件必须走原生 setter 再派发事件，直接改 .value 会被它下一次渲染覆盖掉。
  // 这不是反检测手段，是让 React 知道值变了的标准写法。
  var setValue = function (el, value) {
    var proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  var FIND = {
    email: function () {
      return firstVisible(['input[type="email"]', 'input[name*="email" i]', 'input[autocomplete="username"]']);
    },
    otp: function () {
      return firstVisible([
        'input[autocomplete="one-time-code"]', 'input[name*="code" i]', 'input[name*="otp" i]',
        'input[id*="code" i]', 'input[placeholder*="code" i]', 'input[placeholder*="验证码"]',
      ]);
    },
    phone: function () {
      return firstVisible([
        'form[action*="/add-phone" i] input[type="tel"]',
        'form[action*="/add-phone" i] input[autocomplete="tel"]',
        'input[name="__reservedForPhoneNumberInput_tel"]',
        'input[type="tel"]',
      ]);
    },
    sms: function () {
      return firstVisible([
        'form[action*="/phone-verification" i] input[name="code"]',
        'form[action*="/phone-verification" i] input[autocomplete="one-time-code"]',
        'input[autocomplete="one-time-code"]', 'input[inputmode="numeric"]',
      ]);
    },
  };

  // 有些页面把验证码拆成 6 个单字符输入框，得逐位填
  var fillBoxes = function (value) {
    var boxes = [];
    var all = document.querySelectorAll('input[maxlength="1"][inputmode="numeric"], input[maxlength="1"][type="tel"]');
    for (var i = 0; i < all.length; i += 1) if (visible(all[i])) boxes.push(all[i]);
    if (boxes.length < value.length) return false;
    for (var k = 0; k < value.length; k += 1) { boxes[k].focus(); setValue(boxes[k], value[k]); }
    return true;
  };

  var flash = function (el, ok) {
    var old = el.style.boxShadow;
    el.style.boxShadow = ok ? '0 0 0 3px rgba(84,117,95,.75)' : '0 0 0 3px rgba(163,75,68,.75)';
    setTimeout(function () { el.style.boxShadow = old; }, 1200);
  };

  var fill = function (kind, value) {
    if (!value) return false;
    // 先试单框；单框找不到再试拆开的 6 个小框
    var el = (FIND[kind] || FIND.otp)();
    if (!el && (kind === 'otp' || kind === 'sms')) return fillBoxes(String(value));
    if (!el) return false;
    el.focus();
    setValue(el, String(value));
    flash(el, true);
    return true;
  };

  var popup = window.open(RELAY, 'vendRelay', 'width=380,height=560,menubar=no,toolbar=no');
  if (!popup) {
    alert('浏览器把弹窗拦了。请点地址栏右边的「已拦截弹窗」允许一次，然后再点一次这个书签。');
    return;
  }
  window.__vendFill = popup;

  // 握手由**弹窗先喊**。这里不主动拿 popup 引用去 postMessage ——
  // 跨源弹窗的 window 引用不可靠（实测 .closed 会直接是 true），
  // 基于它做重试会静默失效，买家只看到"没反应"。
  // 收到弹窗的招呼后用 event.source 回，那是活引用。
  var relay = null;

  window.addEventListener('message', function (event) {
    // 只认我们自己域名发来的消息 —— 不验来源的话，页面上任何第三方脚本
    // 都能往输入框里塞值
    if (event.origin !== ORIGIN) return;
    var d = event.data || {};
    if (d.t === 'vend-relay-here') {
      relay = event.source;
      try { relay.postMessage({ t: 'vend-hello' }, ORIGIN); } catch (e) {}
      return;
    }
    if (d.t !== 'vend-fill') return;
    var ok = fill(d.kind, d.value);
    var back = relay || event.source;
    try { back.postMessage({ t: 'vend-result', ok: ok, kind: d.kind }, ORIGIN); } catch (e) {}
  });
})();
