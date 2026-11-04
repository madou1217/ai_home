'use strict';

// 回归：detached 启动绝对不能用 `new-session -A`。
// -A 在会话已存在时会 attach 一个客户端并永久挂住 —— 父进程（aih）跟着一起卡死，
// 真机实测留下 9 个 12 小时不退的 aih + tmux 客户端对（2026-11-04）。
// 正确形态是 `new-session -d`：会话真不存在才创建，重复创建会立刻失败退出。

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTmuxLaunch } = require('../lib/runtime/persistent-session');

const INNER = { command: 'node', args: ['cli.js'] };
const BASE = {
  cliName: 'claude',
  runtimeScope: 'acct_0123456789abcdef0123',
  sessionName: 'p-demo-session',
  cwd: '/tmp',
  env: {}
};

test('detached 启动只用 new-session -d，不许出现 -A', () => {
  const launch = buildTmuxLaunch(INNER, { ...BASE, detached: true });
  assert.ok(launch.args.includes('new-session'));
  assert.ok(launch.args.includes('-d'));
  assert.ok(
    !launch.args.includes('-A'),
    `detached 带 -A 会 attach 住客户端导致进程泄漏：${launch.args.join(' ')}`
  );
  assert.equal(launch.detached, true);
});

test('attachExisting 仍然走 attach-session（前台进入会话靠它）', () => {
  const launch = buildTmuxLaunch(INNER, { ...BASE, attachExisting: true });
  assert.ok(launch.args.includes('attach-session'));
  assert.ok(launch.args.includes('-t'));
});
