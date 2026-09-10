'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createCodexCommandPort, createCodexHandlers
} = require('../lib/server/chat-runtime/codex-session-command-port');

test('Codex prewarm starts independent model and history reads concurrently', async () => {
  const model = deferred();
  const history = deferred();
  const order = [];
  const port = createCodexCommandPort({
    prewarmRuntime() {
      order.push('model:start');
      return model.promise.then(() => order.push('model:done'));
    },
    syncHistory() {
      order.push('history:start');
      return history.promise.then(() => order.push('history:done'));
    },
    runtimeScope: 'codex:account-1'
  });

  const pending = port.prewarm();
  await nextTask();
  assert.deepEqual(order, ['model:start', 'history:start']);

  history.resolve();
  model.resolve();
  assert.deepEqual(await pending, {
    ready: true, provider: 'codex', runtimeScope: 'codex:account-1'
  });
  assert.deepEqual(order, [
    'model:start', 'history:start', 'history:done', 'model:done'
  ]);
});

test('a tool-boundary intervention cannot steer a newer or stopping run', async () => {
  const received = [];
  const handlers = createCodexHandlers({ intervene: (payload) => received.push(payload) });
  const payload = { mode: 'steer_current', content: 'pending', expectedRunId: 'run-one' };
  for (const current of [{ state: 'running', activeTurn: { runId: 'run-two' } },
    { state: 'interrupting', activeTurn: { runId: 'run-one' } }]) {
    assert.throws(() => handlers['turn.intervene']({ command: { payload },
      sessionId: 's', store: { getSession: () => current } }), { code: 'chat_queue_boundary_superseded' });
  }
  handlers['turn.intervene']({ command: { payload }, sessionId: 's',
    store: { getSession: () => ({ state: 'running', activeTurn: { runId: 'run-one' } }) } });
  assert.equal(received.length, 1);
});

function deferred() {
  let resolve;
  const promise = new Promise((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

function nextTask() {
  return new Promise((resolve) => setImmediate(resolve));
}
