'use strict';

// webui-account-refresh 对 Go 作业失败的转述：
//   · Go 明确回 401 unauthorized（管理面拒绝）时，作业必须原样落 "unauthorized"，
//     不能被当成 go_core_unavailable——后者会把一次真实的凭据/鉴权问题伪装成
//     「Go 没接线」，还会触发本地三段回退、重复打上游；
//   · Go 作业终态 failed + error "unauthorized" 时，快照原样映射进本地作业，
//     同样不出现 go_core_unavailable。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');
const { handleRefreshAccountRequest } = require('../lib/server/webui-account-refresh');
const { accountRefreshJobs } = require('../lib/server/webui-account-routes-refresh');

const PROVIDER = 'codex';

function setupAccount(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-refresh-'));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: PROVIDER,
    cliAccountId: '1',
    identitySeed: 'codex:refresh-unauthorized-test'
  });
  assert.ok(accountRef);
  // 非 API Key 账号：避免 handler 在入口前把刷新判成 api_key 不支持。
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, { access_token: 'AT-REFRESH-TEST' });
  t.after(() => {
    accountRefreshJobs.clear();
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });
  return { aiHomeDir, accountRef };
}

function createCtx({ aiHomeDir, accountRef, goCoreSync }) {
  const writes = [];
  return {
    pathname: `/v0/webui/accounts/${PROVIDER}/${accountRef}/refresh`,
    deps: { aiHomeDir, goCoreSync },
    fs,
    state: {},
    res: {},
    writes,
    writeJson: (_res, status, payload) => writes.push({ status, payload })
  };
}

async function waitForTerminalJob(jobId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = accountRefreshJobs.get(jobId);
    if (job && (job.status === 'failed' || job.status === 'succeeded')) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`refresh job ${jobId} did not reach a terminal state`);
}

test('Go 回 401 unauthorized：作业转述 unauthorized，不标成 go_core_unavailable', async (t) => {
  const { aiHomeDir, accountRef } = setupAccount(t);
  const calls = [];
  const goCoreSync = {
    refreshAccountWebUI: async (provider, ref) => {
      calls.push({ kind: 'start', provider, ref });
      return {
        ok: false,
        status: 401,
        data: { ok: false, error: 'unauthorized', message: '需要管理密钥' },
        errorCode: 'http_401'
      };
    },
    // 401 说明 Go 已经处理过这次请求：既不该再轮询作业，也不该回退本地三段。
    getRefreshJob: async (id) => {
      calls.push({ kind: 'poll', id });
      return { ok: false, status: 404, data: null, errorCode: 'http_404' };
    }
  };

  const ctx = createCtx({ aiHomeDir, accountRef, goCoreSync });
  assert.equal(handleRefreshAccountRequest(ctx), true);
  assert.equal(ctx.writes[0].status, 202);

  const job = await waitForTerminalJob(ctx.writes[0].payload.job.id);
  assert.equal(job.status, 'failed');
  assert.equal(job.error, 'unauthorized');
  assert.ok(!job.error.includes('go_core_unavailable'), '401 不能标成 go_core_unavailable');
  assert.ok(!job.error.includes('Go Core 不可用'), '401 不能落入 Go 独有账号的不可用文案');
  assert.equal(job.branches.status.status, 'failed');
  assert.equal(job.branches.status.error, 'unauthorized');
  assert.deepEqual(calls, [{ kind: 'start', provider: PROVIDER, ref: accountRef }]);
});

test('Go 作业终态 failed + unauthorized：快照原样映射，不误判 Go 不可用', async (t) => {
  const { aiHomeDir, accountRef } = setupAccount(t);
  let pollCount = 0;
  const goJobId = 'go-refresh-job-unauthorized';
  const goCoreSync = {
    refreshAccountWebUI: async () => ({
      ok: true,
      status: 202,
      data: {
        ok: true,
        accepted: true,
        alreadyRunning: false,
        job: {
          id: goJobId,
          provider: PROVIDER,
          accountRef,
          status: 'running',
          error: '',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          finishedAt: null,
          scope: 'account'
        }
      }
    }),
    getRefreshJob: async (id) => {
      pollCount += 1;
      assert.equal(id, goJobId);
      return {
        ok: true,
        status: 200,
        data: {
          ok: true,
          job: {
            id: goJobId,
            provider: PROVIDER,
            accountRef,
            status: 'failed',
            error: 'unauthorized',
            branches: {
              status: { status: 'failed', error: 'unauthorized' },
              models: { status: 'failed', error: 'unauthorized' },
              usage: { status: 'failed', error: 'unauthorized' }
            },
            updatedAt: Date.now(),
            finishedAt: Date.now(),
            scope: 'account'
          }
        }
      };
    }
  };

  const ctx = createCtx({ aiHomeDir, accountRef, goCoreSync });
  assert.equal(handleRefreshAccountRequest(ctx), true);
  assert.equal(ctx.writes[0].status, 202);

  const job = await waitForTerminalJob(ctx.writes[0].payload.job.id);
  assert.equal(pollCount, 1);
  assert.equal(job.status, 'failed');
  assert.equal(job.error, 'unauthorized');
  assert.ok(!job.error.includes('go_core_unavailable'), '作业失败不能标成 go_core_unavailable');
  assert.equal(job.branches.status.status, 'failed');
  assert.equal(job.branches.status.error, 'unauthorized');
});
