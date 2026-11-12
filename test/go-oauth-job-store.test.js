'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGoOAuthJobStore, toJobRecord } = require('../lib/server/go-oauth-job-store');

test('toJobRecord 只投影公开快照并映射状态', () => {
  const base = { id: 'job-1', provider: 'zcode', createdAt: 1000, updatedAt: 2000 };
  assert.equal(toJobRecord({ ...base, status: 'running' }).status, 'pending');
  assert.equal(toJobRecord({ ...base, status: 'succeeded' }).status, 'completed');
  assert.equal(toJobRecord({ ...base, status: 'failed', error: 'boom' }).status, 'failed');
  assert.equal(toJobRecord({ ...base, status: 'cancelled' }).status, 'cancelled');
  assert.equal(toJobRecord({ ...base, status: 'expired' }).status, 'expired');
  // 缺 id / provider / 未知状态：不持久化。
  assert.equal(toJobRecord({ ...base, id: '', status: 'running' }), null);
  assert.equal(toJobRecord({ ...base, provider: '', status: 'running' }), null);
  assert.equal(toJobRecord({ ...base, status: 'weird' }), null);
});

test('toJobRecord 区分 reauth 与 register，并保留目标账号', () => {
  const record = toJobRecord({
    id: 'job-2', provider: 'zcode', status: 'running', createdAt: 1, updatedAt: 2,
    reauth: true, accountRef: 'acct_0123456789abcdef0123'
  });
  assert.equal(record.purpose, 'reauth');
  assert.equal(record.target_ref, 'acct_0123456789abcdef0123');
  // 不含任何凭据字段。
  assert.deepEqual(
    Object.keys(record).sort(),
    ['created_at', 'error_code', 'error_message', 'expires_at', 'job_id', 'owner', 'provider_id', 'purpose', 'source', 'status', 'target_ref', 'updated_at']
  );
});

test('record 只推送变化（成功推送后同一快照不重复写）', async () => {
  const calls = [];
  const store = createGoOAuthJobStore({
    put: async (record) => { calls.push(record.status); return { ok: true, status: 200 }; }
  });
  const job = { id: 'job-3', provider: 'zcode', status: 'running', createdAt: 1, updatedAt: 2 };
  store.record(job);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['pending']);
  assert.equal(store.get('job-3').status, 'pending');

  // 同样的快照不重复推送。
  store.record({ ...job });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['pending']);

  // 状态变化才推。
  store.record({ ...job, status: 'succeeded', updatedAt: 3 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['pending', 'completed']);
});

test('推送失败进 dirty，由 flush 重试', async () => {
  const calls = [];
  let failNext = true;
  const store = createGoOAuthJobStore({
    now: () => 10_000,
    retryMs: 0,
    put: async (record) => {
      calls.push(record.status);
      if (failNext) { failNext = false; return { ok: false, status: 500 }; }
      return { ok: true, status: 200 };
    }
  });
  store.record({ id: 'job-4', provider: 'zcode', status: 'running', createdAt: 1, updatedAt: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['pending']);
  const pushed = await store.flush();
  assert.equal(pushed, 1);
  assert.deepEqual(calls, ['pending', 'pending']);
});

test('hydrateFromRecords 回填历史终态且不重复推送', async () => {
  const calls = [];
  const store = createGoOAuthJobStore({
    put: async (record) => { calls.push(record.job_id); return { ok: true, status: 200 }; }
  });
  const loaded = store.hydrateFromRecords([
    { job_id: 'old-1', provider_id: 'codex', purpose: 'register', status: 'completed', created_at: '2026-11-05T00:00:00Z', updated_at: '2026-11-05T00:01:00Z' }
  ]);
  assert.equal(loaded, 1);
  assert.equal(store.get('old-1').status, 'completed');
  // 回填只读，不会把历史记录再推回 Go。
  assert.deepEqual(calls, []);
});

test('hydrate 拉取失败时安静返回 0', async () => {
  const store = createGoOAuthJobStore({ list: async () => ({ ok: false, status: 500 }) });
  assert.equal(await store.hydrate(), 0);
});
