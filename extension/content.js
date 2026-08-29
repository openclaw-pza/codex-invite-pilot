(() => {
  const startedAt = Date.now();
  const signalled = new Set();
  let scanning = false;
  let accepted = false;
  let emailSubmitted = false;
  let expiredSessionLoginStarted = false;

  const visible = (element) => Boolean(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));
  const firstVisible = (selectors) => {
    for (const selector of selectors) {
      const element = [...document.querySelectorAll(selector)].find(visible);
      if (element) return element;
    }
    return null;
  };

  const buttonByText = (pattern) => [...document.querySelectorAll('button, a[role="button"], a')]
    .find((element) => visible(element) && pattern.test((element.textContent || '').trim()));

  const SUBMIT_TEXT = /^(?:continue|next|verify|submit|send|finish creating account|继续|下一步|验证|提交|发送|完成创建账户)$/i;
  const submitButton = (input) => {
    const form = input?.closest('form');
    const candidates = form ? [...form.querySelectorAll('button, input[type="submit"]')].filter(visible) : [];
    return candidates.find((element) => SUBMIT_TEXT.test((element.textContent || element.value || '').trim()))
      || candidates.find((element) => String(element.type || '').toLowerCase() === 'submit')
      || buttonByText(SUBMIT_TEXT);
  };

  const disabled = (element) => Boolean(element?.disabled || element?.getAttribute('aria-disabled') === 'true');
  const waitForEnabledSubmit = async (input, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    let submit = null;
    while (Date.now() < deadline) {
      submit = submitButton(input);
      if (submit && !disabled(submit)) return submit;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return submit && !disabled(submit) ? submit : null;
  };

  const otpInput = () => firstVisible([
    'input[autocomplete="one-time-code"]',
    'input[name*="code" i]',
    'input[name*="otp" i]',
    'input[id*="code" i]',
    'input[placeholder*="code" i]',
    'input[placeholder*="验证码"]',
  ]);

  const phoneInput = () => firstVisible([
    'form[action*="/add-phone" i] input[type="tel"]',
    'form[action*="/add-phone" i] input[autocomplete="tel"]',
    'input[name="__reservedForPhoneNumberInput_tel"]',
  ]);

  const smsInput = () => firstVisible([
    'form[action*="/phone-verification" i] input[name="code"]',
    'form[action*="/phone-verification" i] input[autocomplete="one-time-code"]',
    'form[action*="/phone-verification" i] input[inputmode="numeric"]',
  ]);

  const profileInputs = () => {
    const age = firstVisible([
      'input[name="age" i]',
      'input[id*="age" i]',
      'input[placeholder*="age" i]',
      'input[aria-label*="age" i]',
      'input[placeholder*="年龄"]',
      'input[aria-label*="年龄"]',
    ]);
    const name = firstVisible([
      'input[autocomplete="name"]',
      'input[name="name" i]',
      'input[name*="full" i][name*="name" i]',
      'input[id*="name" i]',
      'input[placeholder*="full name" i]',
      'input[aria-label*="full name" i]',
      'input[placeholder*="姓名"]',
      'input[aria-label*="姓名"]',
    ]);
    return age && name ? { age, name } : null;
  };

  const isLoggedIn = () => {
    if (location.hostname !== 'chatgpt.com' || /\/(?:auth|login|invite|join|accept-referral)\b/i.test(location.pathname)) return false;
    return Boolean(firstVisible([
      '#prompt-textarea',
      '[data-testid="prompt-textarea"]',
      'button[aria-label*="profile" i]',
      'button[aria-label*="account" i]',
    ]));
  };

  const isAccountChooser = () => /choose an account to continue to codex|选择.*账号.*继续.*codex/i
    .test(document.body?.innerText || '');

  const isExpiredSession = () => /your session has expired|session expired|会话已过期|工作階段已過期/i
    .test(document.body?.innerText || '');

  const isLegacyDeviceAuth = () => /\/codex\/device\/?$/i.test(location.pathname)
    || /enable device code authori[sz]ation for codex/i.test(document.body?.innerText || '');

  const compactIdentity = (value) => String(value || '').toLowerCase().replace(/\s+/g, '');

  async function chooseCurrentAccount() {
    const response = await pageEvent('NEED_ACCOUNT_SELECTION');
    const address = compactIdentity(response?.data?.address);
    if (!response?.ok || !address) return;

    const candidates = [...document.querySelectorAll('button, a[href], [role="button"]')]
      .filter((element) => visible(element) && compactIdentity(element.textContent).includes(address))
      .sort((left, right) => compactIdentity(left.textContent).length - compactIdentity(right.textContent).length);
    if (candidates[0]) {
      candidates[0].click();
      return;
    }

    const another = buttonByText(/^(?:log in|sign in) to another account$|^使用其他账号(?:登录)?$|^使用其他帳號(?:登入)?$/i);
    if (another) {
      another.click();
      return;
    }
    await pageEvent('UNKNOWN', { reason: '账号选择页中没有本轮邮箱，也没有找到“使用其他账号登录”按钮' });
  }

  async function resumeExpiredSession() {
    if (expiredSessionLoginStarted) return;
    const login = buttonByText(/^(?:log in|sign in|登录|登入)$/i);
    if (!login) {
      await pageEvent('UNKNOWN', { reason: '检测到登录会话已过期，但没有找到重新登录按钮' });
      return;
    }
    const response = await pageEvent('SESSION_EXPIRED');
    if (!response?.ok) return;
    expiredSessionLoginStarted = true;
    login.click();
  }

  const rejectedInvite = () => {
    const params = new URLSearchParams(location.search);
    if (/\/accept-referral\/?$/i.test(location.pathname) && params.has('email') && !params.has('referral_context')) return true;
    const text = document.body?.innerText || '';
    return /推荐邀请不可用|邀请链接(?:无效|不可用|已过期)|referral invitation (?:is )?unavailable|invitation link (?:is )?(?:invalid|expired)/i.test(text);
  };

  const hasCaptcha = () => /captcha|verify you are human|验证您是人类|人机验证|安全验证/i.test(document.body?.innerText || '');
  const isAppHandoff = () => /continue in codex|download or open codex|open chatgpt(?:\.app)?|open the chatgpt app|在\s*(?:chatgpt|codex).*桌面|打开\s*chatgpt|继续(?:使用)?chatgpt(?:应用|桌面版)?|登录桌面版|登陆桌面版/i.test(document.body?.innerText || '');
  const phoneWasSubmitted = () => sessionStorage.getItem('codexInvitePilotPhoneSubmitted') === '1';
  const phoneWasRejected = () => {
    const input = phoneInput();
    if (!input || !phoneWasSubmitted()) return false;
    if (input.getAttribute('aria-invalid') === 'true') return true;
    const messages = [...document.querySelectorAll('[role="alert"], [aria-live="assertive"], [data-error], .error')]
      .filter(visible)
      .map((element) => element.textContent || '')
      .join(' ');
    return /(?:phone|number|手机号|电话号码).*(?:invalid|unsupported|not supported|unavailable|already used|try another|错误|无效|不支持|不可用|已使用|换一个)/i.test(messages);
  };

  async function pageEvent(event, extra = {}) {
    if (signalled.has(event)) return null;
    signalled.add(event);
    try {
      return await chrome.runtime.sendMessage({ type: 'PAGE_EVENT', event, ...extra });
    } catch {
      signalled.delete(event);
      return null;
    }
  }

  function setInputValue(input, value) {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function fillOtp(code) {
    const single = otpInput();
    if (single) {
      setInputValue(single, String(code));
      (submitButton(single) || single).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      if (!submitButton(single)) single.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return { ok: true };
    }
    const digits = [...document.querySelectorAll('input[maxlength="1"][inputmode="numeric"]')].filter(visible);
    if (digits.length < 6) return { ok: false, error: '页面上没有找到邮箱验证码输入框' };
    String(code).slice(0, 6).split('').forEach((digit, index) => setInputValue(digits[index], digit));
    submitButton(digits[0])?.click();
    return { ok: true };
  }

  async function fillPhone(phone, dialCode = '', countryName = '', providedNationalNumber = '', isoCountry = '') {
    signalled.delete('PHONE_REJECTED');
    sessionStorage.removeItem('codexInvitePilotPhoneSubmitted');
    const input = phoneInput();
    if (!input) return { ok: false, error: '页面上没有找到手机号输入框' };
    const form = input.closest('form') || document;
    const select = [...form.querySelectorAll('select')].find(visible);
    if (select) {
      const normalizedName = String(countryName || '').trim().toLowerCase();
      const normalizedIso = String(isoCountry || '').trim().toLowerCase();
      const normalizedDial = String(dialCode || '').replace(/\D/g, '');
      const dialPattern = normalizedDial ? new RegExp(`\\+${normalizedDial}\\b`) : null;
      const option = [...select.options].find((entry) => {
        const text = String(entry.textContent || '').toLowerCase();
        const value = String(entry.value || '').trim().toLowerCase();
        const dataIso = String(entry.dataset?.countryCode || entry.dataset?.country || '').trim().toLowerCase();
        return (normalizedIso && (value === normalizedIso || dataIso === normalizedIso))
          || (normalizedName && text.includes(normalizedName))
          || (dialPattern && dialPattern.test(text));
      });
      if (!option) return { ok: false, error: `页面上没有找到该号码对应的国家选项${normalizedDial ? `（+${normalizedDial}）` : ''}` };
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const sms = [...form.querySelectorAll('input[type="radio"][value="sms"]')].find(visible);
    if (sms && !sms.checked) sms.click();
    const digits = String(phone || '').replace(/\D/g, '');
    const normalizedDial = String(dialCode || '').replace(/\D/g, '');
    const national = String(providedNationalNumber || '').replace(/\D/g, '')
      || (normalizedDial && digits.startsWith(normalizedDial) ? digits.slice(normalizedDial.length) : digits);
    setInputValue(input, national);
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    const submit = await waitForEnabledSubmit(input);
    if (!submit) return { ok: false, error: '手机号已填写，但 Continue 在 10 秒内仍不可点击' };
    sessionStorage.setItem('codexInvitePilotPhoneSubmitted', '1');
    submit.click();
    return { ok: true, submitted: true };
  }

  async function fillSms(code) {
    const input = smsInput();
    if (!input) return { ok: false, error: '页面上没有找到手机验证码输入框' };
    setInputValue(input, String(code));
    const submit = submitButton(input);
    if (!submit) return { ok: false, error: '手机验证码已填写，但没有找到提交按钮' };
    submit.click();
    return { ok: true };
  }

  async function fillProfile(profile, name, age) {
    setInputValue(profile.name, String(name));
    setInputValue(profile.age, String(age));
    const finish = buttonByText(/finish creating account|create account|完成创建账户|完成建立帳戶|创建账户|建立帳戶/i)
      || submitButton(profile.age);
    if (!finish) return { ok: false, error: '姓名和年龄已填写，但没有找到完成创建按钮' };
    finish.click();
    return { ok: true };
  }

  async function scan() {
    if (scanning) return;
    scanning = true;
    try {
      if (isLegacyDeviceAuth()) return void await pageEvent('LEGACY_DEVICE_AUTH');
      if (isLoggedIn()) return void await pageEvent('SUCCEEDED');
      if (rejectedInvite()) return void await pageEvent('INVALID_INVITE');
      if (isAppHandoff()) return void await pageEvent('APP_HANDOFF');
      if (hasCaptcha()) return void await pageEvent('CAPTCHA');
      if (isExpiredSession()) return void await resumeExpiredSession();
      if (isAccountChooser()) return void await chooseCurrentAccount();
      const profile = profileInputs();
      if (profile) {
        const response = await pageEvent('NEED_PROFILE');
        const details = response?.data;
        if (!response?.ok || !details?.name || !details?.age) return;
        const filled = await fillProfile(profile, details.name, details.age);
        if (!filled.ok) return void await pageEvent('UNKNOWN', { reason: filled.error });
        await chrome.runtime.sendMessage({ type: 'PAGE_EVENT', event: 'PROFILE_SUBMITTED' }).catch(() => {});
        return;
      }
      if (smsInput()) {
        sessionStorage.removeItem('codexInvitePilotPhoneSubmitted');
        return void await pageEvent('NEED_SMS');
      }
      if (phoneWasRejected()) return void await pageEvent('PHONE_REJECTED');
      if (phoneInput()) return void await pageEvent('NEED_PHONE');
      if (otpInput() || document.querySelectorAll('input[maxlength="1"][inputmode="numeric"]').length >= 6) {
        return void await pageEvent('NEED_EMAIL_OTP');
      }

      if (!accepted) {
        const accept = buttonByText(/accept.*(?:invite|invitation)|接受邀请|接受邀請/i);
        if (accept) {
          accepted = true;
          accept.click();
          return;
        }
      }

      if (!emailSubmitted) {
        const email = firstVisible(['input[type="email"]', 'input[name*="email" i]']);
        if (email) {
          const response = await pageEvent('BEFORE_EMAIL_SUBMIT');
          const address = response?.data?.address;
          if (!response?.ok || !address) return;
          setInputValue(email, address);
          const submit = submitButton(email);
          if (!submit) return void await pageEvent('UNKNOWN', { reason: '邮箱已填写，但没有找到继续按钮' });
          emailSubmitted = true;
          submit.click();
          return;
        }
      }

      const consent = buttonByText(/^(?:continue|allow|authorize|confirm|继续|允许|授权|确认)$/i);
      if (consent && /codex|oauth|authorize|授权/i.test(document.body?.innerText || '')) {
        consent.click();
        return;
      }

      if (Date.now() - startedAt > 60000) {
        await pageEvent('UNKNOWN', { reason: '60 秒内未识别出安全的下一步，请人工检查页面' });
      }
    } finally {
      scanning = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      if (message?.type === 'FILL_EMAIL_OTP') return fillOtp(message.code);
      if (message?.type === 'FILL_PHONE') {
        return fillPhone(message.phone, message.dialCode, message.countryName, message.nationalNumber, message.isoCountry);
      }
      if (message?.type === 'FILL_SMS') return fillSms(message.code);
      if (message?.type === 'RESUME_SCAN') {
        signalled.clear();
        await scan();
        return { ok: true };
      }
      return { ok: false, error: '未知页面命令' };
    })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || '页面操作失败' }));
    return true;
  });

  setInterval(scan, 1000);
  scan();
})();
