import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  detectPhoneStage,
  driveToOtp,
  fillOtpAndSubmit,
  fillSmsCodeAndSubmit,
  pageIsLoggedIn,
  submitPhoneNumber,
} from '../server/automationBrowser.js';

const extensionContentPath = fileURLToPath(new URL('../extension/content.js', import.meta.url));

test('本地模拟邀请、邮箱、OTP 与登录成功流程', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://chatgpt.com/invite/test', async (route) => {
    await route.fulfill({
      contentType: 'text/html',
      body: `
        <meta charset="utf-8">
        <button id="accept" onclick="showEmail()">Accept invitation</button>
        <script>
          function showEmail() {
            document.body.innerHTML = '<input type="email"><button type="submit" onclick="showOtp()">Continue</button>';
          }
          function showOtp() {
            document.body.innerHTML = '<input autocomplete="one-time-code"><button type="submit" onclick="done()">Verify</button>';
          }
          function done() {
            history.pushState({}, '', '/');
            document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true"></div>';
          }
        </script>`,
    });
  });
  await page.goto('https://chatgpt.com/invite/test');
  let baselineCalled = false;
  const result = await driveToOtp(page, 'user@example.com', {
    beforeEmailSubmit: async () => { baselineCalled = true; },
    timeoutMs: 5000,
  });
  assert.equal(result.state, 'waiting_otp');
  assert.equal(baselineCalled, true);
  assert.deepEqual(await fillOtpAndSubmit(page, '137635'), { ok: true });
  assert.equal(await pageIsLoggedIn(page), true);
});

test('未知页面会暂停而不是盲目点击', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<main>Unexpected screen</main>');
  const result = await driveToOtp(page, 'user@example.com', { timeoutMs: 50 });
  assert.equal(result.state, 'paused');
});

test('无效邀请页面会立即返回重新等待状态', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<main><h1>推荐邀请不可用</h1><p>此邀请链接无效或已过期。</p></main>');
  const result = await driveToOtp(page, 'user@example.com', { timeoutMs: 5000 });
  assert.equal(result.state, 'invalid_invite');
});

test('邀请令牌被服务端剥离后会识别为无效邀请', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://chatgpt.com/accept-referral?email=*', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<main>Unavailable</main>',
  }));
  await page.goto('https://chatgpt.com/accept-referral?email=user%40example.com');
  const result = await driveToOtp(page, 'user@example.com', { timeoutMs: 5000 });
  assert.equal(result.state, 'invalid_invite');
});

test('本地模拟泰国手机号与短信验证码流程', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://chatgpt.com/add-phone', async (route) => {
    await route.fulfill({
      contentType: 'text/html',
      body: `
        <meta charset="utf-8">
        <form action="/add-phone">
          <select><option value="us">United States +1</option><option value="th">Thailand +66</option></select>
          <input type="radio" value="sms" name="channel"><input type="radio" value="whatsapp" name="channel" checked>
          <input type="tel" autocomplete="tel">
          <button type="submit" onclick="phone(event)">Continue</button>
        </form>
        <script>
          function phone(event) {
            event.preventDefault();
            document.body.innerHTML = '<form action="/phone-verification"><input name="code" inputmode="numeric"><button type="submit" onclick="done(event)">Verify</button></form>';
          }
          function done(event) {
            event.preventDefault(); history.pushState({}, '', '/');
            document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true"></div>';
          }
        </script>`,
    });
  });
  await page.goto('https://chatgpt.com/add-phone');
  assert.equal(await detectPhoneStage(page), 'phone_number');
  assert.deepEqual(await submitPhoneNumber(page, '+66812345678', '66'), { ok: true });
  assert.equal(await detectPhoneStage(page), 'phone_code');
  assert.deepEqual(await fillSmsCodeAndSubmit(page, '654321'), { ok: true });
  assert.equal(await pageIsLoggedIn(page), true);
});

test('Chrome 插件填写手机号后等待 Continue 启用并点击正确按钮', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.chrome = {
      runtime: {
        sendMessage: async () => ({ ok: true }),
        onMessage: { addListener(listener) { window.__extensionListener = listener; } },
      },
    };
  });
  await page.route('https://chatgpt.com/add-phone', (route) => route.fulfill({
    contentType: 'text/html',
    body: `
      <form action="/add-phone">
        <button type="button" id="countryButton">Thailand (+66)</button>
        <select><option value="th">Thailand +66</option><option value="gb">United Kingdom +44</option></select>
        <input type="radio" value="sms" name="channel">
        <input name="__reservedForPhoneNumberInput_tel" type="tel">
        <button id="continue" type="submit" disabled>Continue</button>
      </form>
      <script>
        const input = document.querySelector('input[type="tel"]');
        const continueButton = document.getElementById('continue');
        input.addEventListener('input', () => setTimeout(() => { continueButton.disabled = false; }, 250));
        document.getElementById('countryButton').addEventListener('click', () => { document.body.dataset.wrongButton = 'yes'; });
        continueButton.addEventListener('click', (event) => {
          event.preventDefault();
          document.body.dataset.continued = input.value;
        });
      </script>
    `,
  }));
  await page.goto('https://chatgpt.com/add-phone');
  await page.addScriptTag({ content: await readFile(extensionContentPath, 'utf8') });
  const result = await page.evaluate(() => new Promise((resolve) => {
    window.__extensionListener({ type: 'FILL_PHONE', phone: '+442079460018', dialCode: '44', nationalNumber: '2079460018', isoCountry: 'GB' }, {}, resolve);
  }));
  assert.deepEqual(result, { ok: true, submitted: true });
  assert.equal(await page.locator('body').getAttribute('data-continued'), '2079460018');
  assert.equal(await page.locator('body').getAttribute('data-wrong-button'), null);
});

test('Chrome 插件在 Codex 账号选择页只点击本轮邮箱对应账号', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.chrome = {
      runtime: {
        sendMessage: async (message) => message?.event === 'NEED_ACCOUNT_SELECTION'
          ? { ok: true, data: { address: 'target@edu.example.com' } }
          : { ok: true },
        onMessage: { addListener(listener) { window.__extensionListener = listener; } },
      },
    };
  });
  await page.route('https://auth.openai.com/account-picker', (route) => route.fulfill({
    contentType: 'text/html',
    body: `
      <h1>Welcome back</h1>
      <p>Choose an account to continue to Codex</p>
      <button id="wrong">Personal Account<br>owner@example.com</button>
      <button id="target">Morgan Lee<br>target@edu.example.com</button>
      <button id="another">Log in to another account</button>
      <script>
        for (const id of ['wrong', 'target', 'another']) {
          document.getElementById(id).addEventListener('click', () => { document.body.dataset.selected = id; });
        }
      </script>`,
  }));
  await page.goto('https://auth.openai.com/account-picker');
  await page.addScriptTag({ content: await readFile(extensionContentPath, 'utf8') });
  await page.waitForFunction(() => document.body.dataset.selected);
  assert.equal(await page.locator('body').getAttribute('data-selected'), 'target');
});

test('账号选择页没有本轮邮箱时改走其他账号登录', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.chrome = {
      runtime: {
        sendMessage: async (message) => message?.event === 'NEED_ACCOUNT_SELECTION'
          ? { ok: true, data: { address: 'new@edu.example.com' } }
          : { ok: true },
        onMessage: { addListener(listener) { window.__extensionListener = listener; } },
      },
    };
  });
  await page.route('https://auth.openai.com/account-picker', (route) => route.fulfill({
    contentType: 'text/html',
    body: `
      <h1>Welcome back</h1>
      <p>Choose an account to continue to Codex</p>
      <button id="old">Old Account<br>old@example.com</button>
      <button id="another">Log in to another account</button>
      <script>
        document.getElementById('old').addEventListener('click', () => { document.body.dataset.selected = 'old'; });
        document.getElementById('another').addEventListener('click', () => { document.body.dataset.selected = 'another'; });
      </script>`,
  }));
  await page.goto('https://auth.openai.com/account-picker');
  await page.addScriptTag({ content: await readFile(extensionContentPath, 'utf8') });
  await page.waitForFunction(() => document.body.dataset.selected);
  assert.equal(await page.locator('body').getAttribute('data-selected'), 'another');
});

test('Chrome 插件检测到会话过期时自动点击重新登录', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.chrome = {
      runtime: {
        sendMessage: async (message) => message?.event === 'SESSION_EXPIRED' ? { ok: true, data: { ok: true } } : { ok: true },
        onMessage: { addListener(listener) { window.__extensionListener = listener; } },
      },
    };
  });
  await page.route('https://chatgpt.com/accept-referral?test=session-expired', (route) => route.fulfill({
    contentType: 'text/html',
    body: `
      <main>
        <h2>Your session has expired</h2>
        <p>Please log in again to continue using the app.</p>
        <button id="login">Log in</button>
      </main>
      <script>
        document.getElementById('login').addEventListener('click', () => { document.body.dataset.loginClicked = 'yes'; });
      </script>`,
  }));
  await page.goto('https://chatgpt.com/accept-referral?test=session-expired');
  await page.addScriptTag({ content: await readFile(extensionContentPath, 'utf8') });
  await page.waitForFunction(() => document.body.dataset.loginClicked === 'yes');
  assert.equal(await page.locator('body').getAttribute('data-login-clicked'), 'yes');
});

test('旧设备码页面会切换回正确的 Codex ChatGPT OAuth', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.chrome = {
      runtime: {
        sendMessage: async (message) => {
          if (message?.event === 'LEGACY_DEVICE_AUTH') document.body.dataset.legacyDetected = 'yes';
          return { ok: true, data: { allowed: true } };
        },
        onMessage: { addListener(listener) { window.__extensionListener = listener; } },
      },
    };
  });
  await page.route('https://auth.openai.com/codex/device', (route) => route.fulfill({
    contentType: 'text/html',
    body: `
      <p>Enable device code authorization for Codex in ChatGPT Security Settings, then run codex login --device-auth again.</p>
      <button disabled>Continue</button>`,
  }));
  await page.goto('https://auth.openai.com/codex/device');
  await page.addScriptTag({ content: await readFile(extensionContentPath, 'utf8') });
  await page.waitForFunction(() => document.body.dataset.legacyDetected === 'yes');
  assert.equal(await page.locator('body').getAttribute('data-legacy-detected'), 'yes');
});
