'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGoOAuthJobStore, toJobRecord } = require('../lib/server/go-oauth-job-store');
const { buildCallbackErrorMessage } = require('../lib/server/webui-account-routes-utils');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';
const TERMINAL_ACCOUNT_FIELDS = ['account_ref', 'cli_account_id', 'finished_at'];

test('完成的 Job 快照带账号结果与完成时间', () => {
  const record = toJobRecord({
    id: 'job-done', provider: 'codex', status: 'succeeded',
    createdAt: 1_000, updatedAt: 2_000,
    accountRef: ACCOUNT_REF, cliAccountId: 7, finishedAt: 2_500
  });
  assert.equal(record.status, 'completed');
  assert.equal(record.account_ref, ACCOUNT_REF);
  assert.equal(record.cli_account_id, 7);
  assert.equal(record.finished_at, new Date(2_500).toISOString());
});

test('pending 快照不带三个终态账号字段', () => {
  const record = toJobRecord({
    id: 'job-pending', provider: 'codex', status: 'running',
    createdAt: 1_000, updatedAt: 2_000,
    // reauth 在 pending 阶段也带目标 accountRef，但那是 target_ref 而不是登录结果。
    reauth: true, accountRef: ACCOUNT_REF, finishedAt: 2_500
  });
  assert.equal(record.status, 'pending');
  assert.equal(record.target_ref, ACCOUNT_REF);
  for (const key of TERMINAL_ACCOUNT_FIELDS) {
    assert.equal(Object.hasOwn(record, key), false, key + ' 不应出现在 pending 快照');
  }
});

test('失败终态只带完成时间，不带账号结果', () => {
  const record = toJobRecord({
    id: 'job-failed', provider: 'codex', status: 'failed',
    createdAt: 1_000, updatedAt: 2_000, finishedAt: 2_400, error: 'provider_rejected'
  });
  assert.equal(record.finished_at, new Date(2_400).toISOString());
  assert.equal(Object.hasOwn(record, 'account_ref'), false);
  assert.equal(Object.hasOwn(record, 'cli_account_id'), false);
});

test('推送链路把三个字段原样带给 Go', async () => {
  const pushed = [];
  const store = createGoOAuthJobStore({
    put: async (record) => { pushed.push(record); return { ok: true, status: 200 }; }
  });
  store.record({
    id: 'job-push', provider: 'codex', status: 'succeeded', createdAt: 1, updatedAt: 2,
    accountRef: ACCOUNT_REF, cliAccountId: '9', finishedAt: 3
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].account_ref, ACCOUNT_REF);
  assert.equal(pushed[0].cli_account_id, 9);
  assert.equal(pushed[0].finished_at, new Date(3).toISOString());
});

test('provider_rejected 与 provider_unavailable 文案语义不同', () => {
  const rejected = buildCallbackErrorMessage('provider_rejected');
  const unavailable = buildCallbackErrorMessage('provider_unavailable');
  assert.notEqual(rejected, unavailable);
  assert.match(rejected, /上游拒绝/);
  assert.match(rejected, /不会成功/);
  assert.doesNotMatch(rejected, /稍后重试/);
  assert.match(unavailable, /稍后重试/);
});
