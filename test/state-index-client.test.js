const test = require('node:test');
const assert = require('node:assert/strict');

const { createStateIndexClient } = require('../lib/cli/services/server/state-index-client');

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('state index client serializes management writes per process', async () => {
  const calls = [];
  const pending = [];
  const fetchImpl = (url, options) => {
    calls.push({ url, options });
    return new Promise((resolve) => {
      pending.push(resolve);
    });
  };

  const client = createStateIndexClient({
    fetchImpl,
    managementBase: 'http://127.0.0.1:8317/v0/management',
    managementKey: 'k',
    abortSignalFactory: null
  });

  client.upsert('codex', '1', { configured: true });
  client.setExhausted('codex', '1', true);
  client.pruneMissing('codex', ['1']);

  await nextTick();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/state-index\/upsert$/);

  await nextTick();
  assert.equal(calls.length, 1);

  pending.shift()({ ok: true });
  await nextTick();
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /\/state-index\/set-exhausted$/);

  pending.shift()({ ok: true });
  await nextTick();
  assert.equal(calls.length, 3);
  assert.match(calls[2].url, /\/state-index\/prune-missing$/);

  pending.shift()({ ok: true });
  await nextTick();
});
