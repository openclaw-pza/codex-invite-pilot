import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTurn, desktopTextLoggedIn, desktopTextNeedsLogin, makeChallenge, pickReplyLine,
} from '../server/desktopJudge.js';

// 用**实测抓到的**桌面端界面原文钉住判据。
// 这些判据在 2026-08-26 一天内错了四次，每次白烧一个不可再生的邀请名额。

// 来源：research/改造方案_2026-08-24.md 里 fin.log / onb.log 抓到的原文
const 登录屏 = 'Sign in to ChatGPT Continue to sign in Sign in another way Sign up';
const 等待屏 = 'Continue signing in with your browser Cancel sign-in';
const 主界面 = 'File Edit View Help Codex New chat Pull requests Scheduled Plugins Projects No projects Recents Respond to greeting Do anything';
const 欢迎屏 = 'Hey! Welcome to the ChatGPT desktop app. I am going to ask you a few quick questions';

test('登录屏不能判成已登录', () => {
  assert.equal(desktopTextLoggedIn(登录屏), false);
  assert.equal(desktopTextNeedsLogin(登录屏), true);
});

// 🔴 这条是 2026-08-26 审计抓到的：等待屏是三个调用点上桌面端的**默认状态**，
// 判错就会走上「假成功 → 关掉唯一持有 OAuth 会话的浏览器 → 不可恢复」。
test('「等浏览器登录」的等待屏绝不能判成已登录', () => {
  assert.equal(desktopTextLoggedIn(等待屏), false);
  assert.equal(desktopTextNeedsLogin(等待屏), true);
});

test('主界面和欢迎屏判为已登录', () => {
  assert.equal(desktopTextLoggedIn(主界面), true);
  assert.equal(desktopTextLoggedIn(欢迎屏), true);
  assert.equal(desktopTextNeedsLogin(主界面), false);
});

// 纯反向判据（「不是登录页就算登录」）会把下面这些全判成已登录
test('错误页 / 更新提示 / 加载中 / 空白，一律不算已登录', () => {
  for (const t of ['Something went wrong. Please try again.', 'Aw, snap!', 'Update available. Restart to install', 'Loading...', '', '   ']) {
    assert.equal(desktopTextLoggedIn(t), false, `误判为已登录：${t}`);
  }
});

// ---- 回复判据 ----

test('自己消息的无障碍标签不算回复（v4 就是栽在这）', () => {
  assert.equal(pickReplyLine(['You said:', 'thanks'], 'thanks'), '');
});

test('「正在生成」不算收到回复', () => {
  assert.equal(pickReplyLine(['You said:', 'Thinking'], 'thanks'), '');
  assert.equal(pickReplyLine(['ChatGPT said:'], 'thanks'), '');
});

test('只有操作按钮出现也不算', () => {
  assert.equal(pickReplyLine(['Copy', 'Regenerate', 'Share'], 'thanks'), '');
});

test('完成播报是强信号，直接采信', () => {
  assert.equal(
    pickReplyLine(['You said:', 'Response complete: You are welcome.'], 'thanks'),
    'Response complete: You are welcome.',
  );
});

test('光有 Response complete 标签、没有正文，不算', () => {
  assert.equal(pickReplyLine(['Response complete'], 'thanks'), '');
  assert.equal(pickReplyLine(['Response complete:'], 'thanks'), '');
});

// v1 就是栽在这：阈值写死 40，而这句只有 15 个字
test('短回复也要认出来', () => {
  assert.equal(pickReplyLine(['ChatGPT said:', "You're welcome."], 'thanks'), "You're welcome.");
});

test('长回复正常识别', () => {
  const long = 'I can also work directly in this workspace: inspect code, make edits, run tests.';
  assert.equal(pickReplyLine(['ChatGPT said:', long], 'hello'), long);
});

// v3 栽在虚拟列表：旧行被移除导致长度判据失效。集合差不受影响。
test('虚拟列表把旧行移除了也不影响判定', () => {
  assert.equal(
    pickReplyLine(['Response complete: You are welcome.'], 'thanks'),
    'Response complete: You are welcome.',
  );
});

// ---- 挑战-应答 ----
// 前四版判据都栽在「依赖界面文本」上。这一版让回复里必须出现一个
// 只有真回答者才算得出来的串 —— 界面噪声再怎么变都造不出它。

test('题面里绝不能出现答案（否则回显就能骗过判据）', () => {
  let seed = 0;
  const rand = () => { seed += 0.0137; return seed % 1; };
  for (let i = 0; i < 200; i += 1) {
    const { prompt, expect } = makeChallenge(rand);
    assert.equal(prompt.includes(expect), false, `题面含答案：${prompt} / ${expect}`);
  }
});

test('只有真答案才算 confirmed', () => {
  assert.equal(classifyTurn('The answer is 933.', '933'), 'confirmed');
  assert.equal(classifyTurn('You said: What is 611 plus 322?', '933'), 'pending');
  assert.equal(classifyTurn('ChatGPT said:', '933'), 'pending');
  assert.equal(classifyTurn('Thinking… 12s', '933'), 'pending');
  assert.equal(classifyTurn('Respond to greeting', '933'), 'pending');
});

// 🔴 以前读不到界面会 catch 成空串，然后「全场都是新行」→ 立刻判成功。
// 方向反了：读不到是「无法验证」，不是「成功」。
test('读不到界面是 unverifiable，绝不能算成功', () => {
  assert.equal(classifyTurn('', '933'), 'unverifiable');
  assert.equal(classifyTurn('   ', '933'), 'unverifiable');
  assert.equal(classifyTurn(null, '933'), 'unverifiable');
});

test('报错/限流是 fatal，应当中止而不是继续发', () => {
  assert.equal(classifyTurn('Something went wrong. Please try again.', '933'), 'fatal');
  assert.equal(classifyTurn("You've reached your usage limit for today", '933'), 'fatal');
  assert.equal(classifyTurn('账号 account deactivated', '933'), 'fatal');
});

// 报错文案本身也可能包含数字，但 fatal 优先于 confirmed
test('报错优先于「碰巧含答案」', () => {
  assert.equal(classifyTurn('Something went wrong (code 933)', '933'), 'fatal');
});
