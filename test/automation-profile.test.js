// 账号资料页（姓名 + 年龄）的识别与填写。
//
// 2026-08-23 第一轮真实跑测就断在这里：OTP 提交后 60 秒「未确认登录成功」，
// 因为 Playwright 那条路根本不认识这一页（插件那条早就认识）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeProfile } from '../server/automationBrowser.js';

test('生成的身份落在 21~32 岁，姓名是两段英文', () => {
  for (const r of [() => 0, () => 0.5, () => 0.999999]) {
    const p = makeProfile(r);
    assert.ok(p.age >= 21 && p.age <= 32, `年龄越界: ${p.age}`);
    assert.match(p.name, /^[A-Z][a-z]+ [A-Z][a-z]+$/, `姓名格式不对: ${p.name}`);
  }
});

test('年龄不能低于 18——会触发未成年流程', () => {
  for (let i = 0; i < 200; i += 1) {
    assert.ok(makeProfile().age >= 18);
  }
});

// ---------- 顺序不变量 ----------
//
// visibleBlocker 里有条 /date of birth|生日/ 的规则会把资料页拦成「需要人工」。
// 资料页的检查**必须**排在它前面，顺序反了这个分支永远走不到 ——
// 而这正是第一轮失败的形态，改完必须有东西盯着它别改回去。
test('资料页检查排在 visibleBlocker 之前', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../server/automationBrowser.js', import.meta.url), 'utf8');

  for (const fn of ['driveToOtp', 'waitForLoginResult']) {
    const start = src.indexOf(`export async function ${fn}`);
    assert.ok(start > 0, `找不到 ${fn}`);
    const body = src.slice(start, start + 2000);
    // 只认**真实调用点**，不能按名字出现的位置找 —— 那段解释为什么要有这个顺序的
    // 注释本身就先提到了 visibleBlocker，按名字找会被自己的注释骗过去（第一版就是）。
    const profileAt = body.indexOf('await detectProfileStage(page)');
    const blockerAt = body.indexOf('await visibleBlocker(page)');
    assert.ok(profileAt > 0, `${fn} 里没有 detectProfileStage 的调用`);
    assert.ok(blockerAt > 0, `${fn} 里没有 visibleBlocker 的调用`);
    assert.ok(profileAt < blockerAt,
      `${fn} 里 detectProfileStage 必须排在 visibleBlocker 前面，否则被 /生日/ 那条规则抢走`);
  }
});

test('资料页判据要求姓名和年龄都在——只有姓名的页面到处都是', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../server/automationBrowser.js', import.meta.url), 'utf8');
  const start = src.indexOf('async function profileInputs');
  const body = src.slice(start, src.indexOf('\n}', start));
  // 先查 age、拿不到就直接 return null：登录页、搜索页都有 name 输入框，
  // 单看 name 会把它们误当资料页填一通
  assert.match(body, /if \(!age\) return null;/, '必须先用 age 卡掉非资料页');
  assert.match(body, /return name \? \{ age, name \} : null;/, '两个都在才算资料页');
});

// ---------- OTP 双提交 ----------
//
// 2026-08-23 第二轮实测：填完验证码后页面变成
//   https://auth.openai.com/email-verification
//   「糟糕，出错了！Route Error (400 Invalid content type: text/html; charset=UTF-8)」
// 根因是六格验证码框填完最后一位会自己提交，而代码紧接着又点了一次「继续」，
// 同一个表单提交两次。现场截图在 DMIT-2 的 data/automation/dumps/。

// 这条用例的前一版钉的是「填完先等页面自己走、不要补点继续」——
// 那是基于「六格框会自动提交」的假设写的，而 2026-08-23 手动实测证明
// OpenAI 的 /email-verification **用的是单个输入框**
// （`input[maxlength=1][inputmode=numeric]` 数量为 0），单框根本不会自动提交。
// 那一版把一个错误信念钉成了「期望行为」，还挡住了正确实现。改成钉真实行为：
test('单输入框必须显式点继续；六格框才等它自动提交', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../server/automationBrowser.js', import.meta.url), 'utf8');
  const start = src.indexOf('export async function fillOtpAndSubmit');
  const body = src.slice(start, src.indexOf('\nasync function otpInputsGone', start));

  const singleStart = body.indexOf("inputs.kind === 'single'");
  const single = body.slice(singleStart, body.indexOf('  {\n', singleStart));
  assert.ok(singleStart > 0, '找不到单框分支');
  assert.match(single, /clickContinue/, '单框分支必须点继续 —— 手动实测就是这么走通的');
  assert.equal(/Promise\.race/.test(single), false, '单框分支不该走「等自动提交」那套');

  // 六格分支仍然保留「先等再点」：那种组件确实会在最后一位自动提交
  assert.match(body, /Promise\.race/, '六格分支要保留等待');
  assert.match(body, /if \(settled\) return/, '页面自己走了就别再点一次');
});

test('OpenAI 的路由报错页要被单独认出来', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../server/automationBrowser.js', import.meta.url), 'utf8');
  // 落进最后那句含糊的「未确认登录成功」= 把「页面报错了」和「页面还没走完」
  // 混成一件事，查起来要多花一整轮（第一轮就是这么浪费掉的）
  assert.match(src, /route error\|糟糕，出错了\|invalid content type/i,
    'visibleBlocker 里要有认这个报错页的规则');
});
