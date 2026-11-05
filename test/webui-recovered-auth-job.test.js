'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { readPersistedAuthJob, __private } = require('../lib/server/web-ui-router');

const { toRecoveredAuthJob } = __private;

test('toRecoveredAuthJob 把 Go 状态映射成展示状态', () => {
  const base = {
    job_id: 'job-1', provider_id: 'zcode', purpose: 'register',
    created_at: '2026-11-05T07:00:00Z', updated_at: '2026-11-05T07:10:00Z', expires_at: '2026-11-05T07:10:00Z'
  };
  assert.equal(toRecoveredAuthJob({ ...base, status: 'completed' }).status, 'succeeded');
  assert.equal(toRecoveredAuthJob({ ...base, status: 'failed', error_message: 'boom' }).error, 'boom');
  // 重启后 pending/processing 已无意义，一律按 expired 展示，避免前端继续等。
  assert.equal(toRecoveredAuthJob({ ...base, status: 'pending' }).status, 'expired');
  assert.equal(toRecoveredAuthJob({ ...base, status: 'processing' }).status, 'expired');
  assert.equal(toRecoveredAuthJob({ ...base, status: 'expired' }).status, 'expired');
  const recovered = toRecoveredAuthJob({
    ...base, status: 'cancelled', purpose: 'reauth', target_ref: 'acct_0123456789abcdef0123'
  });
  assert.equal(recovered.reauth, true);
  assert.equal(recovered.accountRef, 'acct_0123456789abcdef0123');
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.createdAt, Date.parse(base.created_at));
  assert.equal(toRecoveredAuthJob(null), null);
});

test('readPersistedAuthJob 内存缺失时回落 Go 查询', async () => {
  const calls = [];
  const deps = {
    goCoreSync: {
      getOAuthJob: async (jobId) => {
        calls.push(jobId);
        return {
          ok: true,
          data: {
            job_id: jobId, provider_id: 'codex', purpose: 'register', status: 'completed',
            created_at: '2026-11-05T07:00:00Z', updated_at: '2026-11-05T07:01:00Z'
          }
        };
      }
    }
  };
  const job = await readPersistedAuthJob(deps, 'job-go-1');
  assert.equal(job.status, 'succeeded');
  assert.equal(job.recovered, true);
  assert.deepEqual(calls, ['job-go-1']);
});

test('readPersistedAuthJob 未装配 Go 时安静返回 null', async () => {
  assert.equal(await readPersistedAuthJob({}, 'job-missing'), null);
  assert.equal(await readPersistedAuthJob(null, ''), null);
});


const { handleGetAddJobRequest } = require('../lib/server/webui-account-routes');

test('GET /v0/webui/accounts/add/jobs/:id 内存缺失时返回恢复的只读快照', async () => {
  let status = 0;
  let payload = null;
  const ctx = {
    pathname: '/v0/webui/accounts/add/jobs/job-9',
    getAuthJobManager: () => ({ getJob: () => null }),
    readPersistedAuthJob: async (jobId) => toRecoveredAuthJob({
      job_id: jobId, provider_id: 'zcode', purpose: 'register', status: 'expired',
      created_at: '2026-11-05T07:00:00Z', updated_at: '2026-11-05T07:10:00Z'
    }),
    deps: {},
    state: {},
    res: {},
    writeJson: (_res, code, body) => { status = code; payload = body; }
  };
  const handled = await handleGetAddJobRequest(ctx);
  assert.equal(handled, true);
  assert.equal(status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.recovered, true);
  assert.equal(payload.job.status, 'expired');
  assert.equal(payload.job.id, 'job-9');
});

test('GET /v0/webui/accounts/add/jobs/:id 两边都没有时仍然 404', async () => {
  let status = 0;
  let payload = null;
  const ctx = {
    pathname: '/v0/webui/accounts/add/jobs/job-x',
    getAuthJobManager: () => ({ getJob: () => null }),
    readPersistedAuthJob: async () => null,
    deps: {},
    state: {},
    res: {},
    writeJson: (_res, code, body) => { status = code; payload = body; }
  };
  await handleGetAddJobRequest(ctx);
  assert.equal(status, 404);
  assert.equal(payload.error, 'job_not_found');
});

test('createAuthJobStoreForDeps 装配 Go 推送与查询（防再次漏 import）', async () => {
  const { createAuthJobStoreForDeps } = __private;
  const pushed = [];
  const store = createAuthJobStoreForDeps({
    goCoreSync: {
      pushOAuthJob: async (record) => { pushed.push(record.job_id); return { ok: true, status: 200 }; },
      listOAuthJobs: async () => ({ ok: true, data: [] })
    }
  });
  assert.equal(typeof store.record, 'function');
  store.record({ id: 'job-z', provider: 'zcode', status: 'running', createdAt: 1, updatedAt: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pushed, ['job-z']);
});
