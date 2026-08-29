import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { sendCodexMessage } from '../server/automationBrowser.js';

// 这一步是整条邀请链路唯一决定给不给额度的动作，所以判据必须严：
// 「点过发送」不算办成，要看到回复真的开始。
test('在 Codex 里发消息：看到回复开始才算成功', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <meta charset="utf-8">
    <div id="prompt-textarea" contenteditable="true"></div>
    <button data-testid="send-button" onclick="reply()">发送</button>
    <div id="thread"></div>
    <script>
      function reply() {
        document.getElementById('prompt-textarea').textContent = '';
        document.getElementById('thread').innerHTML =
          '<div data-message-author-role="assistant">正在回复…</div>';
      }
    </script>`);
  const sent = await sendCodexMessage(page, 'hello', { timeoutMs: 8000 });
  assert.equal(sent.ok, true);
  assert.ok(sent.evidence.includes('assistant-or-stop'), `证据不对：${JSON.stringify(sent.evidence)}`);
});

// 最贵的一种错：消息其实没发出去（限流、会话没带过来），但输入框被清空了。
// 只看「输入框空了」就报成功 = 对一个根本没入账的号说它成了，买家那边什么都没有。
test('输入框清空但没有回复 → 判失败，不能按入账算', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <meta charset="utf-8">
    <div id="prompt-textarea" contenteditable="true"></div>
    <button data-testid="send-button" onclick="document.getElementById('prompt-textarea').textContent=''">发送</button>`);
  const sent = await sendCodexMessage(page, 'hello', { timeoutMs: 3000 });
  assert.equal(sent.ok, false);
  assert.match(sent.reason, /不能按入账算/);
});

test('没有输入框时说清楚是找不到框，不要含糊', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<main>Something else entirely</main>');
  const sent = await sendCodexMessage(page, 'hello', { timeoutMs: 1000 });
  assert.equal(sent.ok, false);
  assert.match(sent.reason, /没找到输入框/);
});

// DMIT-2 上连卡三轮的那个坑：ChatGPT 页面到处是 fixed inset-0 的遮罩层，
// Playwright 判定「按钮被挡住」于是重试到超时。遮罩只是视觉层，原生 click 是通的。
test('发送按钮被遮罩挡住时，退回原生点击而不是静默失败', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <meta charset="utf-8">
    <div id="prompt-textarea" contenteditable="true"></div>
    <button data-testid="send-button" onclick="reply()">发送</button>
    <div id="thread"></div>
    <div style="position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.3)"></div>
    <script>
      function reply() {
        document.getElementById('thread').innerHTML =
          '<div data-message-author-role="assistant">正在回复…</div>';
      }
    </script>`);
  const sent = await sendCodexMessage(page, 'hello', { timeoutMs: 15000 });
  assert.equal(sent.ok, true, `被遮罩挡住时没发出去：${sent.reason || ''}`);
});
