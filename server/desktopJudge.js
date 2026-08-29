// desktopJudge.js — Codex 桌面端的**判据**集中地。
//
// 为什么单独拆出来：这些判据在 2026-08-26 一天之内错了四次，每次都白烧一个
// 不可再生的邀请名额，而它们埋在 800 行的脚本里，**一行测试都写不了**。
// 判据是最容易自欺的地方 —— 它不影响功能，只影响你以为发生了什么，
// 而无人值守时"以为"就是全部。所以把它们抽成纯函数，用真实抓到的界面文案钉住。
//
// 错过的四次，根因各不相同，都记在这里免得再犯：
//   v1 长度阈值写死 40      → 真回复 "You're welcome."(15 字) 漏报
//   v2 助手气泡数           → 那是**网页版** DOM，桌面端匹配不到，检测整个瞎掉
//   v3 长度按消息长度算     → 界面是**虚拟列表**，旧消息滚出视区就从 DOM 移除，
//                             对话越长净增长越小，越靠后的消息越吃亏
//   v4 文本行集合差         → 命中的是 "You said:"（自己消息的无障碍标签），
//                             也就是回复永远不来也会报成功 —— 误报比漏报贵得多

// ---------------------------------------------------------------------------
// 一、桌面端处于哪一屏
//
// 三处地方要判这件事（handshakeDesktop / desktopLoggedIn / 阶段 5 的登录闸）。
// 以前各写一份词表，必然漂移 —— 已经漂移过：handshakeDesktop 把
// 「Continue signing in with your browser」判成了已登录，而同一个文件里
// 另一处专门注释过它和 "continue to sign in" 不是同一个串。
// ---------------------------------------------------------------------------

/** 登录屏（fin.log 实测原文：Sign in to ChatGPT / Continue to sign in / Sign in another way / Sign up） */
export const DESKTOP_LOGIN_RE = /sign in to chatgpt|sign in to codex|continue to sign in|sign in another way|sign up/i;

/** 等浏览器完成 OAuth 的**等待屏**（onb.log 实测：连续 150 秒停在这一屏）。
 *  这是等待态不是错误态，但它**绝不等于已登录** —— 判错就会关掉唯一持有会话的浏览器。 */
export const DESKTOP_WAITING_RE = /continue signing in with your browser|cancel sign-in|正在.*浏览器.*登录/i;

/** 坏掉的屏：错误页 / 更新提示 / 还在加载。纯反向判据会把它们全判成"已登录"。 */
export const DESKTOP_BROKEN_RE = /something went wrong|aw, snap|^loading\.*$|update available|restart to install/i;

/** 已登录主界面的正向证据。用的是**桌面端**真实用词（Codex / Pull requests /
 *  Scheduled / Plugins / Projects / Do anything），不是网页版那套。 */
export const DESKTOP_HOME_RE = /新对话|new chat|recents|ask anything|message chatgpt|welcome to the chatgpt|pull requests|scheduled|plugins|projects|do anything|codex/i;

/**
 * 桌面端是不是**已登录**。
 * 必须要正向证据：纯反向判据（"不是登录页就算登录"）会把等待屏、错误页、
 * 加载中全判成已登录，然后走上不可恢复的假成功路径。
 */
export function desktopTextLoggedIn(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (DESKTOP_LOGIN_RE.test(t)) return false;
  if (DESKTOP_WAITING_RE.test(t)) return false;
  if (DESKTOP_BROKEN_RE.test(t)) return false;
  return DESKTOP_HOME_RE.test(t);
}

/** 还停在登录流程里（登录屏或等待屏）—— 阶段 5 用它判「OAuth 没生效」 */
export function desktopTextNeedsLogin(text) {
  const t = String(text || '');
  return DESKTOP_LOGIN_RE.test(t) || DESKTOP_WAITING_RE.test(t);
}

// ---------------------------------------------------------------------------
// 二、消息发出去之后，到底有没有收到回复
// ---------------------------------------------------------------------------

/** 界面噪声行，全都**不是**回复内容。三类，每一类都是实测撞到的：
 *   · 无障碍播报标签："You said:" 发出消息就有、"ChatGPT said:" 容器建好就有
 *   · 状态指示："Thinking" 是正在生成，回复还没出来
 *   · 操作按钮文案 */
export const CHROME_LINE = new RegExp([
  '^(you|chatgpt|codex|assistant|用户|助手)\\s*said\\s*:?$',
  '^(你|我)说[:：]?$',
  '^(thinking|working|generating|正在(思考|生成|输入))\\.{0,3}$',
  '^(stop generating|regenerate|copy|share|good response|bad response|重新生成|复制|分享)$',
  '^response complete[:：]?$',
].join('|'), 'i');

/** 「回复真的完成了」的强信号 —— 桌面端会播报 "Response complete: <正文>"。
 *  冒号后面必须有内容，光有标签不算。 */
export const DONE_LINE = /^response complete[:：]\s*\S/i;

/**
 * 从「这一轮新出现的文本行」里挑出**能证明收到回复**的那一行。
 * 挑不出来就返回空串 —— 调用方据此判这条消息没成。
 *
 * @param freshLines 相对发送前新增的行
 * @param sentMessage 我们刚发出去的那句（它的回显不算回复）
 */
export function pickReplyLine(freshLines, sentMessage) {
  const lines = (Array.isArray(freshLines) ? freshLines : [])
    .map((l) => String(l).trim())
    .filter((l) => l && l !== String(sentMessage || '').trim());
  // 有完成播报就直接采信
  const done = lines.find((l) => DONE_LINE.test(l));
  if (done) return done;
  // 否则要一行像样的新内容：不是界面噪声、也不能太短
  return lines.find((l) => !CHROME_LINE.test(l) && l.length >= 8) || '';
}

// ---------------------------------------------------------------------------
// 三、挑战-应答：不再依赖界面文本长什么样
//
// 前面四版判据全都栽在同一件事上：**它们依赖的是不可控、无契约、随版本漂移的
// 界面文本**。措辞怎么调都躲不开，因为界面本来就会冒出各种我们没见过的新行
// （会话标题、"Working… 12s"、无障碍播报、报错弹条）。
//
// 换个思路：让回复里必须出现一个**只有真正回答的人才产生得出来**的串。
// 算术题的答案不在题面里，所以回显、标签、标题一律造不出它。
// ---------------------------------------------------------------------------

/** 硬失败文案：出现这些说明账号或服务出事了，继续发消息没有意义 */
export const FATAL_LINE = /something went wrong|aw, snap|usage limit|rate limit|too many requests|account (?:deactivated|disabled|suspended)|你已达到|使用上限/i;

/**
 * 造一道算术题。**答案不能出现在题面里**，否则回显就能骗过判据。
 * @param rand 注入随机源，便于测试
 */
export function makeChallenge(rand = Math.random) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const a = 100 + Math.floor(rand() * 800);
    const b = 100 + Math.floor(rand() * 800);
    const expect = String(a + b);
    const prompt = `What is ${a} plus ${b}? Reply with just the number.`;
    if (!prompt.includes(expect)) return { prompt, expect };
  }
  // 极端情况下退回一个固定题目，仍然满足「答案不在题面」
  return { prompt: 'What is 611 plus 322? Reply with just the number.', expect: '933' };
}

/**
 * 判定一条消息到底有没有被真正回答。
 *
 *   confirmed    —— 看到了只有真回答者才产生得出的答案
 *   fatal        —— 界面在报错/限流，继续发没意义，应当中止
 *   unverifiable —— 读不到界面。**这不等于成功**（以前 catch 成空串会 fail-open）
 *   pending      —— 还没等到
 */
export function classifyTurn(text, expect) {
  if (typeof text !== 'string' || !text.trim()) return 'unverifiable';
  if (FATAL_LINE.test(text)) return 'fatal';
  if (expect && text.includes(String(expect))) return 'confirmed';
  return 'pending';
}
