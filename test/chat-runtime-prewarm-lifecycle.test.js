'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createRuntimePrewarmHandler
} = require('../lib/server/chat-runtime/runtime-prewarm-lifecycle');

test('prewarm lifecycle persists started and ready projections around the provider effect', async () => {
  const order = [];
  const store = createStore(order);
  const handler = createRuntimePrewarmHandler(async () => {
    order.push('provider');
    return { ready: true, transport: 'app-server' };
  });

  const result = await handler({ sessionId: 'session-1', store });

  assert.deepEqual(result, { ready: true, transport: 'app-server' });
  assert.deepEqual(order, [
    'runtime.prewarm.started', 'provider', 'runtime.prewarm.ready'
  ]);
  assert.deepEqual(store.events.map(({ type, source, payload }) => ({
    type, source, payload
  })), [
    {
      type: 'runtime.prewarm.started',
      source: { provider: 'codex', runtimeId: 'codex:account-1' },
      payload: {
        runtimeBinding: { runtimeId: 'codex:account-1', runtimeGeneration: 4 },
        capabilitySnapshot: { revision: 'capability-4' }
      }
    },
    {
      type: 'runtime.prewarm.ready',
      source: { provider: 'codex', runtimeId: 'codex:account-1' },
      payload: {
        runtimeBinding: { runtimeId: 'codex:account-1', runtimeGeneration: 4 },
        capabilitySnapshot: { revision: 'capability-4' }
      }
    }
  ]);
});

test('prewarm lifecycle persists a sanitized failure and rethrows the provider error', async () => {
  const order = [];
  const store = createStore(order);
  const failure = Object.assign(new Error('token=must-not-leak'), {
    code: 'codex_app_server_disconnected'
  });
  const handler = createRuntimePrewarmHandler(async () => {
    order.push('provider');
    throw failure;
  });

  await assert.rejects(
    handler({ sessionId: 'session-1', store }),
    (error) => error === failure
  );

  assert.deepEqual(order, [
    'runtime.prewarm.started', 'provider', 'runtime.prewarm.failed'
  ]);
  // 码保持机器可读（供重试判定与排障），另给一条用户文案 —— 内部 harness 码
  // 不能当正文透给用户（见 runtime-failure-copy）。
  assert.equal(store.events.at(-1).payload.error, 'codex_app_server_disconnected');
  assert.match(store.events.at(-1).payload.message, /会话运行时/);
  assert.doesNotMatch(JSON.stringify(store.events), /must-not-leak/);
});

// 2026-10-21 真机反馈：workbuddy 会话的「运行错误」显示成 codex_app_server_rpc_error。
// 根因是 chat 模式的 harness 就是 Codex app-server，任何 provider 的启动失败都带
// codex_* 前缀，而该码被原样当正文透出 —— 归属错乱且用户无法行动。
// 文案必须讲清楚「运行时与账号无关」，并带上真实会话 provider。
test('prewarm failure copy names the session provider, not the internal harness', async () => {
  const order = [];
  const store = createStore(order, { provider: 'workbuddy' });
  const handler = createRuntimePrewarmHandler(async () => {
    throw Object.assign(new Error('rpc blew up'), { code: 'codex_app_server_rpc_error' });
  });

  await assert.rejects(handler({ sessionId: 'session-1', store }));

  const payload = store.events.at(-1).payload;
  assert.equal(payload.error, 'codex_app_server_rpc_error');
  assert.doesNotMatch(payload.message, /codex_app_server_rpc_error/);
  assert.match(payload.message, /workbuddy/);
  assert.match(payload.message, /与账号无关/);
});

function createStore(order, overrides = {}) {
  const session = {
    sessionId: 'session-1',
    provider: 'codex',
    runtimeBinding: { runtimeId: 'codex:account-1', runtimeGeneration: 4 },
    capabilitySnapshot: { revision: 'capability-4' },
    ...overrides
  };
  return {
    events: [],
    getSession(sessionId) {
      return sessionId === session.sessionId ? structuredClone(session) : null;
    },
    appendEvent(_sessionId, event) {
      order.push(event.type);
      this.events.push(structuredClone(event));
      return event;
    }
  };
}
