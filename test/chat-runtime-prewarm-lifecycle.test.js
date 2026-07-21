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
  assert.deepEqual(store.events.at(-1).payload, {
    error: 'codex_app_server_disconnected'
  });
  assert.doesNotMatch(JSON.stringify(store.events), /must-not-leak/);
});

function createStore(order) {
  const session = {
    sessionId: 'session-1',
    provider: 'codex',
    runtimeBinding: { runtimeId: 'codex:account-1', runtimeGeneration: 4 },
    capabilitySnapshot: { revision: 'capability-4' }
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
