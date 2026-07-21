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

  client.upsert('acct_11111111111111111111', 'codex', { configured: true });
  client.upsert('acct_11111111111111111111', 'codex', { configured: true, remainingPct: 42 });
  client.pruneMissing('codex', ['acct_11111111111111111111']);

  await nextTick();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/state-index\/upsert$/);

  await nextTick();
  assert.equal(calls.length, 1);

  pending.shift()({ ok: true });
  await nextTick();
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /\/state-index\/upsert$/);

  pending.shift()({ ok: true });
  await nextTick();
  assert.equal(calls.length, 3);
  assert.match(calls[2].url, /\/state-index\/prune-missing$/);

  pending.shift()({ ok: true });
  await nextTick();
});

test('state index client suspends rejected credentials and resumes after config rotation', async () => {
  const calls = [];
  let managementKey = 'stale';
  const client = createStateIndexClient({
    fetchImpl: async (_url, options) => {
      calls.push(options.headers.authorization);
      return calls.length === 1
        ? { ok: false, status: 401 }
        : { ok: true, status: 200 };
    },
    managementBase: 'http://127.0.0.1:9527/v0/management',
    managementKey,
    resolveManagementSettings: () => ({
      managementBase: 'http://127.0.0.1:9527/v0/management',
      managementKey
    })
  });

  client.upsert('acct_11111111111111111111', 'codex', { configured: true });
  client.upsert('acct_11111111111111111111', 'codex', { configured: true });
  await nextTick();
  await nextTick();
  assert.deepEqual(calls, ['Bearer stale']);

  managementKey = 'current';
  client.upsert('acct_11111111111111111111', 'codex', { configured: true });
  await nextTick();
  await nextTick();
  assert.deepEqual(calls, ['Bearer stale', 'Bearer current']);
});
