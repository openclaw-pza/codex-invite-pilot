// github-stars.test.js — 顶栏 star 按钮的数据源。
//
// 这个功能有两条不能破的性质，测试主要就是钉这两条：
//   1. **没配就是没有**（不能默认指向别人的仓库）
//   2. **永远不阻塞、永远不抛**（它是装饰功能，坏掉不该让首屏接口跟着挂）

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  githubRepo, githubUrl, formatStars, githubMeta, getStars, _resetStarsCache,
} from '../server/githubStars.js';

test('没配 GITHUB_REPO 就是没有按钮', () => {
  assert.equal(githubRepo({}), '');
  assert.equal(githubRepo({ GITHUB_REPO: '' }), '');
  assert.equal(githubRepo({ GITHUB_REPO: '   ' }), '');
  // githubMeta 是异步的（冷启动要等第一次），下面单独测
});

test('owner/name 格式才认，防止把半截配置当成有效值', () => {
  assert.equal(githubRepo({ GITHUB_REPO: 'openclaw-pza/codex-invite-pilot' }), 'openclaw-pza/codex-invite-pilot');
  // 下面这些都该被当成没配 —— 与其渲染一个坏链接，不如不渲染
  for (const bad of ['openclaw-pza', '/name', 'owner/', 'a/b/c', 'owner name', 'owner/na me', '../etc/passwd']) {
    assert.equal(githubRepo({ GITHUB_REPO: bad }), '', `${JSON.stringify(bad)} 不该被接受`);
  }
});

test('粘完整地址进来也能认 —— 配置的人多半是从浏览器复制的', () => {
  const want = 'openclaw-pza/codex-invite-pilot';
  assert.equal(githubRepo({ GITHUB_REPO: 'https://github.com/openclaw-pza/codex-invite-pilot' }), want);
  assert.equal(githubRepo({ GITHUB_REPO: 'https://github.com/openclaw-pza/codex-invite-pilot/' }), want);
  assert.equal(githubRepo({ GITHUB_REPO: 'https://github.com/openclaw-pza/codex-invite-pilot.git' }), want);
});

test('链接指向配置的那个仓库，不是写死的', () => {
  assert.equal(githubUrl('a-owner/b-repo'), 'https://github.com/a-owner/b-repo');
  assert.equal(githubUrl(''), '');
});

test('计数格式：顶栏放不下完整数字', () => {
  assert.equal(formatStars(0), '0');
  assert.equal(formatStars(7), '7');
  assert.equal(formatStars(999), '999');
  assert.equal(formatStars(1000), '1.0k');
  assert.equal(formatStars(1234), '1.2k');
  assert.equal(formatStars(12345), '12.3k');
  // 十万以上不带小数，否则位数太多会把顶栏撑开
  assert.equal(formatStars(123300), '123k');
  assert.equal(formatStars(1234567), '1234k');
});

test('计数拿不到时返回空串，而不是 NaN 或 undefined', () => {
  // 空串会让前端只显示图标；漏成 "NaN" 就直接印到顶栏上了
  for (const bad of [null, undefined, NaN, -1, 'abc', {}]) {
    assert.equal(formatStars(bad), '', `${JSON.stringify(bad)} 该得到空串`);
  }
});

test('getStars 立刻返回，不等网络', async () => {
  _resetStarsCache();
  const t0 = Date.now();
  const first = getStars('test-owner/test-repo');
  const cost = Date.now() - t0;
  // 第一次还没有缓存，拿到 null 是对的 —— 关键是它没有在这里等
  assert.equal(first, null);
  assert.ok(cost < 50, `不该阻塞，实测 ${cost}ms`);
});

test('后台刷完之后就有数了', async () => {
  _resetStarsCache();
  getStars('test-owner/test-repo');
  // 等后台那次 fetch 落地（test.setup.mjs 把 api.github.com 拦成了固定值）
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(getStars('test-owner/test-repo'), 1234);
});

test('没配仓库时 getStars 不发任何请求', () => {
  _resetStarsCache();
  let called = false;
  const real = globalThis.fetch;
  globalThis.fetch = async (...a) => { called = true; return real(...a); };
  try {
    assert.equal(getStars(''), null);
    assert.equal(called, false, '没配仓库却发了请求');
  } finally {
    globalThis.fetch = real;
  }
});

test('上游挂掉不抛异常 —— 装饰功能不该拖垮首屏接口', async () => {
  _resetStarsCache();
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    assert.doesNotThrow(() => getStars('test-owner/test-repo'));
    await new Promise((r) => setTimeout(r, 60));
    assert.doesNotThrow(() => getStars('test-owner/test-repo'));
  } finally {
    globalThis.fetch = real;
  }
});

test('githubMeta 冷启动时会等第一次，拿到完整形状', async () => {
  _resetStarsCache();
  const env = { GITHUB_REPO: 'test-owner/test-repo' };
  const meta = await githubMeta(env);
  assert.equal(meta.repo, 'test-owner/test-repo');
  assert.equal(meta.url, 'https://github.com/test-owner/test-repo');
  assert.equal(meta.stars, 1234);
  assert.equal(meta.starsText, '1.2k');
});

test('没配仓库时 githubMeta 直接返回 null，不等任何东西', async () => {
  const t0 = Date.now();
  assert.equal(await githubMeta({}), null);
  assert.ok(Date.now() - t0 < 30, '没配仓库不该有任何等待');
});
