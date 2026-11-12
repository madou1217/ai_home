'use strict';

// WebUI chat 的 harness 目录是全局的（2026-11-02），但**执行作用域有两种并存**（2026-11-04）：
//   - 具体 accountRef → 单账号直连，harness 写 X-Account-Ref/X-Provider；
//   - `gateway` / 空 → aih-server 池化。
// 守四件事：建会话按选择落作用域、换账号只改钉选不改 home、harness 目录恒为 gateway，
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

test('新建 chat 会话按调用方的选择落作用域：单账号直连 / gateway 池化并存', async () => {
  const created = [];
  const service = {
    createSession: async (input) => {
      created.push(input);
      return { sessionId: 'session-new', ...input };
    },
    store: { importTimeline() {} }
  };
  const coordinator = new ChatSessionCoordinator(service, { hostHomeDir: '/tmp' });

  const direct = await coordinator.create({ provider: 'codex', executionAccountRef: 'acct_abc' });
  assert.equal(direct.executionAccountRef, 'acct_abc');
  assert.equal(created[0].executionAccountRef, 'acct_abc');

  const pooled = await coordinator.create({ provider: 'codex', executionAccountRef: 'gateway' });
  assert.equal(pooled.executionAccountRef, 'gateway');
  assert.equal(created[1].executionAccountRef, 'gateway');

  // 没选账号（草稿）沿用池化，不会凭空钉一个账号。
  const draft = await coordinator.create({ provider: 'codex' });
  assert.equal(draft.executionAccountRef, 'gateway');
  assert.equal(created[2].executionAccountRef, 'gateway');
});

test('换账号只改执行作用域，不换 harness home', async () => {
  let updated = 0;
  const service = {
    store: { updateExecutionContext(sessionId, patch) { updated += 1; return chatSession({ executionAccountRef: patch.executionAccountRef }); } },
    actors: { assertReplaceable() {}, prepare: async () => ({ runtime: {}, entry: { capabilities: {} } }), replacePrepared() {}, disposePrepared() {} }
  };
  const coordinator = new ChatSessionCoordinator(service, { hostHomeDir: '/tmp' });

  // 网关 → 单账号：选择器切换必须真的生效（旧实现会静默忽略）。
  const existing = chatSession({ executionAccountRef: 'gateway' });
  const switched = await coordinator.retarget(existing, { executionAccountRef: 'acct_other' });
  assert.equal(switched.executionAccountRef, 'acct_other');
  assert.equal(updated, 1);

  // 同一个目标重复打开不触发重绑。
  const same = chatSession({ executionAccountRef: 'acct_other' });
  assert.equal(await coordinator.retarget(same, { executionAccountRef: 'acct_other' }), same);
  assert.equal(updated, 1);

  // 单账号 → 网关：切回池化同样生效。
  const back = await coordinator.retarget(chatSession({ executionAccountRef: 'acct_other' }), { executionAccountRef: 'gateway' });
  assert.equal(back.executionAccountRef, 'gateway');
  assert.equal(updated, 2);
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
