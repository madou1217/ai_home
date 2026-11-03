'use strict';

// WebUI chat 没有账号区别（2026-11-02）：
// harness 是 aih 自己的全局目录，账号只决定这次请求的路由，不决定目录、不决定会话归属。
// 守三件事：建会话一律落网关作用域、换账号不换 home、harness 目录恒为 gateway，
// 且网关 harness 的线程存储照样链回宿主 ~/.codex（换作用域后还能 thread/resume）。

const test = require('node:test');
const assert = require('node:assert/strict');

const { harnessScopeDir } = require('../lib/server/chat-runtime/chat-harness-gateway');
const { ChatSessionCoordinator } = require('../lib/server/chat-runtime/chat-session-coordinator');
const { ensureSharedCodexSessions } = require('../lib/server/codex-app-server-endpoint');

function chatSession(overrides = {}) {
  return {
    sessionId: 'session-1',
    provider: 'codex',
    executionAccountRef: 'acct_abc',
    projectPath: '',
    ...overrides
  };
}

test('chat 的 harness 目录恒为全局 gateway，与账号无关', () => {
  assert.equal(harnessScopeDir(chatSession({ executionAccountRef: 'acct_abc' })), 'gateway');
  assert.equal(harnessScopeDir(chatSession({ executionAccountRef: 'gateway' })), 'gateway');
  // 非 chat（work）仍然按执行作用域分目录
  assert.equal(harnessScopeDir(chatSession({ projectPath: '/tmp/project', executionAccountRef: 'acct_abc' })), 'acct_abc');
});

test('新建 chat 会话一律落网关作用域（即使调用方传了具体账号）', async () => {
  const created = [];
  const service = {
    createSession: async (input) => {
      created.push(input);
      return { sessionId: 'session-new', ...input };
    },
    store: { importTimeline() {} }
  };
  const coordinator = new ChatSessionCoordinator(service, { hostHomeDir: '/tmp' });
  const session = await coordinator.create({ provider: 'codex', executionAccountRef: 'acct_abc' });
  assert.equal(session.executionAccountRef, 'gateway');
  assert.equal(created[0].executionAccountRef, 'gateway');
});

test('换账号不换 harness：已是网关作用域的会话直接复用，不触发重绑', async () => {
  let updated = 0;
  const service = {
    store: { updateExecutionContext() { updated += 1; return chatSession({ executionAccountRef: 'gateway' }); } },
    actors: { assertReplaceable() {}, prepare: async () => ({ runtime: {}, entry: { capabilities: {} } }), replacePrepared() {}, disposePrepared() {} }
  };
  const coordinator = new ChatSessionCoordinator(service, { hostHomeDir: '/tmp' });
  const existing = chatSession({ executionAccountRef: 'gateway' });
  const session = await coordinator.retarget(existing, { executionAccountRef: 'acct_other' });
  assert.equal(session, existing);
  assert.equal(updated, 0);
});

test('网关作用域的 chat harness 仍把线程存储链回宿主 ~/.codex', () => {
  const calls = [];
  ensureSharedCodexSessions(
    {
      runtimeNamespace: 'chat',
      ensureSessionStoreLinks: (...args) => { calls.push(args); return { migrated: 0, linked: 1 }; }
    },
    { accountRef: '', gateway: true, runtimeDir: '/ai_home/run/chat-harness/gateway' }
  );
  assert.equal(calls.length, 1);
  const [provider, accountRef, runtime] = calls[0];
  assert.equal(provider, 'codex');
  assert.equal(accountRef, 'gateway');
  assert.equal(runtime.projectionRoot, '/ai_home/run/chat-harness/gateway');
  // 提示词资产仍然排除（2026-10-16 事故：聊天模型复读全局工程规范）
  assert.deepEqual(runtime.excludeSharedEntries, ['AGENTS.md', 'AGENTS.override.md', 'skills']);
});

test('work 的网关会话直接用宿主 ~/.codex，不建链接', () => {
  const calls = [];
  ensureSharedCodexSessions(
    { ensureSessionStoreLinks: (...args) => { calls.push(args); return { migrated: 0, linked: 0 }; } },
    { accountRef: '', gateway: true, runtimeDir: '/host/home' }
  );
  assert.equal(calls.length, 0);
});
