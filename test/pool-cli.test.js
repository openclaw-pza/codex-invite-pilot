import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 这个文件只回答一个问题：**CLI 到底能不能跑起来**。
//
// 起因：2026-08-27 抽运行锁时整块删除把 `const cmd` / `const arg` 一起带走了，
// 而 `node --check` 只验语法、不验引用 —— 部署脚本一路报「语法 OK」，
// 直到真的敲一条命令才炸 ReferenceError: cmd is not defined。
// 单元测试也盖不到：它们 import 的是 server/ 里的函数，不是这个入口脚本。

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'scripts', 'pool.mjs');
const DB = join(mkdtempSync(join(tmpdir(), 'poolcli-')), 'pool.sqlite');

const run = (args) => execFileSync(process.execPath, [CLI, ...args], {
  env: { ...process.env, POOL_DB_PATH: DB, NODE_NO_WARNINGS: '1' },
  encoding: 'utf8',
});

test('不带参数能跑，输出的是可解析的池况', () => {
  const out = run([]);
  const stats = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
  assert.equal(typeof stats.total, 'number');
});

test('每个子命令都进得去自己的分支（不是启动就崩）', () => {
  // 参数不全时应当是**业务报错**（非零退出 + 人话），而不是 ReferenceError
  for (const sub of ['add', 'claim', 'confirm', 'reset', 'dead']) {
    let stderr = '';
    try { run([sub]); } catch (error) { stderr = String(error.stderr || ''); }
    assert.equal(/ReferenceError|is not defined|SyntaxError/.test(stderr), false,
      `${sub} 分支崩在了引用错误上：${stderr.slice(0, 200)}`);
  }
});

test('打错子命令要非零退出，不能静默当成 status', () => {
  let code = 0;
  let stderr = '';
  try { run(['claimm']); } catch (error) { code = error.status; stderr = String(error.stderr || ''); }
  assert.notEqual(code, 0);
  assert.match(stderr, /未知子命令/);
});
