'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createCodexCommandPort
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

function deferred() {
  let resolve;
  const promise = new Promise((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

function nextTask() {
  return new Promise((resolve) => setImmediate(resolve));
}
