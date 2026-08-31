// githubStars.js — 顶栏那个 GitHub star 按钮的数据源。
//
// **默认不显示。** 只有设了 GITHUB_REPO 才会出现。
//
// 为什么不像页脚署名那样默认开：页脚那一行是许可证要求的署名，
// 顶栏这个是**推广位**。别人拿这套代码去卖自己的东西，
// 我不该默认在他家收银台上挂一个指向我仓库的按钮 —— 那是另一回事。
// 想显示的人自己配一行，fork 的人也可以指向自己的仓库。
//
// 三条实现约束：
//   1. **绝不阻塞页面。** 计数拿不到就不显示数字，按钮本身照常是个链接。
//   2. **必须缓存。** 请求走服务端发出，所有访客共用同一个出口 IP，
//      GitHub 匿名接口是每小时 60 次 —— 不缓存的话流量一大就全部 403，
//      而那时候按钮会变成"永远没有数字"，你还查不出为什么。
//   3. **失败不抛。** 这是个装饰功能，它坏掉不该让首屏接口跟着挂。

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

// 30 分钟。star 数不需要实时，而这个值直接决定会不会撞限流。
const TTL_MS = Number(process.env.GITHUB_STARS_TTL_MS) || 30 * 60 * 1000;
const TIMEOUT_MS = 6000;

let cache = { stars: null, at: 0 };
let inflight = null;

/** 配置的仓库，形如 owner/name。没配或格式不对都返回空串（= 不显示按钮）。 */
export function githubRepo(env = process.env) {
  const raw = String(env.GITHUB_REPO ?? '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '');
  return REPO_RE.test(raw) ? raw : '';
}

export function githubUrl(repo) {
  return repo ? `https://github.com/${repo}` : '';
}

/**
 * 把 12345 变成 12.3k —— 顶栏放不下完整数字，而且大数字看着也没有 k 直观。
 *
 * 🔴 null / undefined 必须返回空串，**不能返回 "0"**。
 * `Number(null)` 是 0，照着往下算的话，计数拿不到的时候顶栏会显示「★ 0」——
 * 看的人以为这项目一个 star 都没有。这比不显示数字糟得多。
 * 「读不到」和「读到了，是 0」是两件事，不能塌成一件。
 */
export function formatStars(n) {
  if (n === null || n === undefined || n === '') return '';
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v < 1000) return String(Math.floor(v));
  const k = v / 1000;
  // 100k 以上不再带小数：位数太多顶栏会被撑开
  return k >= 100 ? `${Math.floor(k)}k` : `${(Math.floor(k * 10) / 10).toFixed(1)}k`;
}

async function fetchStars(repo) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'codex-invite-pilot' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    const n = Number(body?.stargazers_count);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 取 star 数。**永远立刻返回**，不等网络。
 * 缓存过期时在后台刷，这一次先给旧值（没有旧值就给 null）。
 *
 * 这样设计是因为它挂在首屏接口上：为了一个装饰数字让买家多等几百毫秒，
 * 换谁都不划算。
 */
export function getStars(repo) {
  if (!repo) return null;
  const fresh = Date.now() - cache.at < TTL_MS;
  if (!fresh && !inflight) {
    inflight = fetchStars(repo)
      .then((n) => { if (n !== null) cache = { stars: n, at: Date.now() }; })
      .catch(() => { /* 装饰功能，坏了就坏了 */ })
      // 失败时也推进时间戳，否则每次请求都会重新发起 —— 上游挂掉时反而打得最凶
      .finally(() => { if (cache.at === 0) cache = { ...cache, at: Date.now() }; inflight = null; });
  }
  return cache.stars;
}

/** 服务启动时预热一次，让第一个访客也能看到数字。失败无所谓。 */
export function prewarmStars(repo) {
  if (repo) getStars(repo);
}

/**
 * 只在**一次都还没取到过**的时候，等一小会儿正在飞的那次请求。
 *
 * 为什么要有这个：`getStars` 立刻返回缓存，而服务刚起来时缓存是空的 ——
 * 那一刻进来的访客拿到的是「有按钮、没数字」，而且**不会自己变出来**，
 * 得等他刷新页面。预热能盖住大部分情况，但盖不住"启动完立刻有人访问"。
 *
 * 代价被框死在两处：只在冷启动后的第一次发生，且最多等 maxMs。
 * 拿到过一次之后，这个函数再也不会等。
 */
async function waitFirstStars(repo, maxMs = 1200) {
  const stars = getStars(repo);          // 顺带触发后台刷新
  if (stars !== null || !inflight) return stars;
  await Promise.race([inflight, new Promise((r) => setTimeout(r, maxMs))]);
  return cache.stars;
}

/** 给 /api/vend/meta 用：没配仓库就返回 null，前端据此决定显不显示。 */
export async function githubMeta(env = process.env) {
  const repo = githubRepo(env);
  if (!repo) return null;
  const stars = await waitFirstStars(repo);
  return { repo, url: githubUrl(repo), stars, starsText: formatStars(stars) };
}

/** 仅供测试：清掉缓存 */
export function _resetStarsCache() {
  cache = { stars: null, at: 0 };
  inflight = null;
}
