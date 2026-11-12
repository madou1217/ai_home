'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChatRuntimeActorRegistry, assertRecoverableRuntime } = require('../lib/server/chat-runtime-actor-registry');

const session = {
  sessionId: 's1',
  provider: 'codex',
  executionAccountRef: 'acct_a',
  runtimeBinding: { runtimeId: 'codex:acct_a', fingerprint: 'fp-before-token-refresh', nativeSessionId: 't1' }
};
const recovery = { recoverable: true };

test('a credential refresh or CLI upgrade does not block restart recovery', () => {
  // fingerprint 换了（auth.json sha / 二进制版本变化），但执行目标没变：必须允许恢复。
  assert.doesNotThrow(() => assertRecoverableRuntime(session, {
    provider: 'codex', runtimeScope: 'acct_a', fingerprint: 'fp-after-token-refresh'
  }, recovery));
});

test('recovery onto a different account or provider is still refused', () => {
  for (const runtime of [
    { provider: 'codex', runtimeScope: 'acct_b', fingerprint: 'x' },
    { provider: 'claude', runtimeScope: 'acct_a', fingerprint: 'x' }
  ]) {
    assert.throws(() => assertRecoverableRuntime(session, runtime, recovery), (error) => {
      assert.equal(error.code, 'chat_runtime_changed_during_recovery');
      assert.equal(error.statusCode, 409);
      assert.equal(error.details.boundRuntimeId, 'codex:acct_a');
      return true;
    });
  }
});

test('non-recovery acquisitions and unbound sessions are never checked', () => {
  const other = { provider: 'claude', runtimeScope: 'acct_z', fingerprint: 'x' };
  assert.doesNotThrow(() => assertRecoverableRuntime(session, other, { recoverable: false }));
  assert.doesNotThrow(() => assertRecoverableRuntime(session, other, undefined));
  assert.doesNotThrow(() => assertRecoverableRuntime({ ...session, runtimeBinding: {} }, other, recovery));
});

test('the registry rehydrates the turn after a credential refresh instead of failing it', async () => {
  const rehydrated = [];
  const bindings = [];
  class FakeActor {
    constructor() { this.turn = { active: false }; }
    async rehydrate(input) { rehydrated.push(input); this.turn.active = true; }
    dispose() {}
  }
  const registry = new ChatRuntimeActorRegistry({
    store: { updateRuntimeBinding: (id, binding) => bindings.push(binding) },
    runtimeResolver: { resolve: async () => ({ provider: 'codex', runtimeScope: 'acct_a', fingerprint: 'fp-after-token-refresh', generation: 2 }) },
    driverRegistry: { resolve: async () => ({ driver: { startTurn() {} }, capabilities: {} }) },
    Actor: FakeActor
  });
  const actor = await registry.acquire(session, recovery);
  assert.ok(actor instanceof FakeActor);
  assert.equal(rehydrated.length, 1);
  // 新的 fingerprint 写回绑定，下一次重启以它为准。
  assert.equal(bindings[0].fingerprint, 'fp-after-token-refresh');
  assert.equal(bindings[0].runtimeId, 'codex:acct_a');
});
