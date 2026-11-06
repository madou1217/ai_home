'use strict';

// 回归守卫（2026-11-06 AWS 真机）：WebUI agy chat 报
//
//   provider_resource_reconcile_incomplete:sessions
//
// agy 的 chat 由 codex chat harness 驱动，per-account home 在
// ~/.ai_home/run/chat-harness/<ref>/.codex。那里的内容全是 aih 建的链接，
// 多出来的未对账条目只是残留。旧实现只在 gateway 分支传 required:false，
// per-account 分支按全量语义 fail-closed，于是 .codex/sessions 一有残留整轮就失败。
//
// 这里直接测接线：chat harness（runtimeNamespace=chat）per-account 必须 tolerant；
// 普通 codex 账号投影仍保持 fail-closed。

const test = require('node:test');
const assert = require('node:assert/strict');

const { ensureSharedCodexSessions } = require('../lib/server/codex-app-server-endpoint');

function capture(options, target) {
  const calls = [];
  ensureSharedCodexSessions({
    runtimeNamespace: options.runtimeNamespace,
    env: {},
    reconcileCodexSessions: (...args) => { calls.push(args); },
    resolveNativeProviderRuntime: () => ({ projectionRequired: true, runtimeDir: '/tmp/chat-harness' })
  }, target);
  return calls;
}

test('chat harness per-account reconcile 对残留 tolerant（required=false）', () => {
  const calls = capture({ runtimeNamespace: 'chat' }, {
    accountRef: 'acct_648b04e6c585e5d1bfbd',
    gateway: false,
    runtimeDir: '/tmp/chat-harness'
  });
  assert.equal(calls.length, 1);
  const [, scope, runtimeOptions, behavior] = calls[0];
  assert.equal(scope, 'acct_648b04e6c585e5d1bfbd');
  assert.equal(runtimeOptions.projectionRoot, '/tmp/chat-harness');
  assert.deepEqual(runtimeOptions.excludeSharedEntries, ['AGENTS.md', 'AGENTS.override.md', 'skills']);
  assert.deepEqual(behavior, { required: false });
});

test('普通 codex 账号投影仍 fail-closed（required=true）', () => {
  const calls = capture({}, {
    accountRef: 'acct_4a833dc13a62526ef5ab',
    gateway: false,
    runtimeDir: '/tmp/codex-projection'
  });
  assert.equal(calls.length, 1);
  const [, , runtimeOptions, behavior] = calls[0];
  assert.equal(runtimeOptions.excludeSharedEntries, undefined);
  assert.deepEqual(behavior, { required: true });
});
