'use strict';

// kiro 的权限旗标属于 `chat` 子命令，不是根命令（kiro-cli 2.32.0 实测：
// `kiro-cli -a --help` 退出码 2 被拒，`kiro-cli chat -a --help` 退出码 0 接受）。
// aih 裸启动 kiro 时会先补 `chat`，所以落点必须插在它后面。

const test = require('node:test');
const assert = require('node:assert/strict');

const { placeKiroPermissionArgs } = require('../lib/runtime/kiro-permission-args');
const { kiroStrategy } = require('../lib/cli/services/ai-cli/launch-profile/kiro-strategy');

const TRUST = ['--trust-all-tools'];

test('the flag lands right after the chat subcommand', () => {
  assert.deepEqual(placeKiroPermissionArgs(['chat'], TRUST), ['chat', '--trust-all-tools']);
  assert.deepEqual(
    placeKiroPermissionArgs(['chat', '--agent', 'reviewer'], TRUST),
    ['chat', '--trust-all-tools', '--agent', 'reviewer']
  );
});

test('commands that do not accept the flag are left untouched', () => {
  // 根级参数（`kiro-cli --help`）与其它子命令都不认它；加了必挂。
  for (const args of [['--help'], ['agent'], ['settings'], ['doctor'], []]) {
    assert.deepEqual(placeKiroPermissionArgs(args, TRUST), args);
  }
});

test('no permission args means no rewrite', () => {
  assert.deepEqual(placeKiroPermissionArgs(['chat'], []), ['chat']);
});

// 端到端：策略补 chat → 权限推导 → 落点，与真实 spawn 的顺序一致。
test('a bare kiro launch ends up as `chat --trust-all-tools`', () => {
  const runtimeArgs = kiroStrategy.buildRuntimeArgs({ args: [], isLogin: false });
  assert.deepEqual(runtimeArgs, ['chat']);
  assert.deepEqual(kiroStrategy.placePermissionArgs(runtimeArgs, TRUST), ['chat', '--trust-all-tools']);
});
