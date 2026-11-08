'use strict';

// login-slice-wiring：Go account-auth-jobs 的状态机守卫。
//
// 这里全部用假 Go client（不碰真实 token 端点、不绑 1455、不写账号库），验证：
//   1. codex 开关关闭时行为与接线前一致：本地生成 PKCE/state，一次 Go 调用都没有；
//   2. zcode 不受 codex 开关影响：固定调用 Go，Node 不生成 PKCE/state；
//   3. Begin 成功 → 用 Go 的 authorization_url，失败 → Go 错误码原样成为 job 失败原因；
//   4. 回调成功 → 用 Go 的 account_ref / cli_account_id 收尾，并主动对账恰好一次；
//   5. 同一身份二次登录 → 假 store 里仍然只有一个账号（Node 不再自己注册一次）；
//   6. zcode 的完整 zcode:// 回调原样转发，reauth 把目标账号交给 Go。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerAccountIdentity } = require('../lib/account/account-registration');
const { createAuthJobManager } = require('../lib/server/web-account-auth');
const {
  createGoAuthJobsOption,
  isGoAuthJobFailureRetryable,
  toGoAuthJobFailure
} = require('../lib/server/web-account-auth-go-jobs');

const GO_JOB_ID = '1'.repeat(32);
const GO_AUTH_URL = 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=go&state=go-state';
const GO_CALLBACK_URL = 'http://localhost:1455/auth/callback?code=go-code&state=go-state';
// zcode 的授权入口由 Go 按区域拼装，回调是自定义协议（Node 侧没有 loopback）。
const ZCODE_GO_AUTH_URL = 'https://chat.z.ai/api/oauth/authorize?response_type=code&client_id=zcode&redirect_uri=zcode%3A%2F%2Foauth%2Fcallback&state=zcode-state';
const ZCODE_CALLBACK_URL = 'zcode://oauth/callback?code=zcode-code&state=zcode-state';

function createTempAiHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-go-auth-job-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function waitFor(predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      let value = null;
      try {
        value = predicate();
      } catch (error) {
        reject(error);
        return;
      }
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('wait_timeout'));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

/**
 * 假 Go：内存里的 job 表 + 账号表。
 *
 * 账号按「身份」去重（同一身份第二次登录复用同一个 account_ref），这样
 * 「二次登录不新增账号」可以直接用 accounts.size 断言，而不是断言 Node 的内部实现。
 */
function createFakeGoAuthJobs(options = {}) {
  const state = {
    jobs: new Map(),
    accounts: new Map(),
    calls: { start: 0, complete: 0, cancel: 0 },
    reconciles: 0
  };
  const client = {
    async start(input) {
      state.calls.start += 1;
      state.lastStartInput = input;
      if (options.startResponse) return options.startResponse;
      const jobId = GO_JOB_ID;
      state.jobs.set(jobId, { status: 'pending' });
      return {
        ok: true,
        status: 201,
        data: {
          job_id: jobId,
          provider_id: 'codex',
          status: 'pending',
          authorization_url: options.authorizationUrl || GO_AUTH_URL,
          expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString()
        }
      };
    },
    async complete(jobId, callbackUrl) {
      state.calls.complete += 1;
      state.lastCallback = callbackUrl;
      if (options.completeResponse) return options.completeResponse;
      const job = state.jobs.get(jobId);
      if (!job || job.status !== 'pending') {
        return { ok: false, status: 409, errorCode: 'job_not_pending' };
      }
      // 身份从回调 URL 里取：假 Go 只关心「是不是同一个人」。
      const identity = new URL(callbackUrl).searchParams.get('code') || 'unknown';
      let account = state.accounts.get(identity);
      if (!account) {
        account = { accountRef: `acct_${String(state.accounts.size + 1).padStart(22, '0')}`, cliAccountId: state.accounts.size + 1 };
        state.accounts.set(identity, account);
      }
      job.status = 'completed';
      return {
        ok: true,
        status: 200,
        data: {
          job_id: jobId,
          provider_id: 'codex',
          status: 'completed',
          account_ref: account.accountRef,
          cli_account_id: account.cliAccountId
        }
      };
    },
    async cancel(jobId) {
      state.calls.cancel += 1;
      const job = state.jobs.get(jobId);
      if (job && job.status === 'pending') job.status = 'cancelled';
      return { ok: true, status: 200, data: { job_id: jobId, status: 'cancelled' } };
    }
  };
  return {
    state,
    goAuthJobs: {
      codexEnabled: options.codexEnabled !== false,
      client,
      reconcile: async () => {
        state.reconciles += 1;
        return { ok: true };
      }
    }
  };
}

function createManager(t, aiHomeDir, goAuthJobs) {
  return createAuthJobManager({
    fs,
    aiHomeDir,
    goAuthJobs,
    // 不绑真实 1455：回调由测试直接喂给 completeBrowserOauthCallback。
    startLoopbackCallbackServerImpl: () => ({ close() {} }),
    onJobChanged: () => {}
  });
}

test('开关关闭：不调用 Go，仍由本地生成 PKCE 与 state', async (t) => {
  const aiHomeDir = createTempAiHome(t);
  const { state, goAuthJobs } = createFakeGoAuthJobs();
  const manager = createManager(t, aiHomeDir, { ...goAuthJobs, codexEnabled: false });

  const started = manager.startOauthJob('codex', 'oauth-browser');
  assert.ok(started.authorizationUrl.includes('code_challenge='), '旧路径必须带 PKCE challenge');
  assert.ok(started.authorizationUrl.includes('state='), '旧路径必须带本地 state');
  const job = manager.getJob(started.jobId);
  assert.equal(job._goAuthJobWired, undefined, '旧路径不应带上 Go 作业字段');
  assert.notEqual(job.oauthState, '');
  assert.equal(state.calls.start, 0, '开关关闭时不能发起任何 Go 调用');

  manager.cancelJob(started.jobId);
  assert.equal(state.calls.cancel, 0);
});

test('Begin 成功：authorization_url 与 job_id 都来自 Go，本地不留 state/verifier', async (t) => {
  const aiHomeDir = createTempAiHome(t);
  const { state, goAuthJobs } = createFakeGoAuthJobs();
  const manager = createManager(t, aiHomeDir, goAuthJobs);

  const started = manager.startOauthJob('codex', 'oauth-browser');
  const job = await waitFor(() => {
    const current = manager.getJob(started.jobId);
    return current && current.authorizationUrl ? current : null;
  });

  assert.equal(job.authorizationUrl, GO_AUTH_URL);
  assert.equal(job._goAuthJobId, GO_JOB_ID);
  assert.equal(job.oauthState, '', 'state 校验以 Go 为权威，本地不再持有');
  assert.equal(job._codeVerifier, '', 'PKCE verifier 只在 Go 进程内');
  assert.equal(job.redirectUri, 'http://localhost:1455/auth/callback');
  assert.equal(job.authProgressState, 'auth_url_ready');
  assert.equal(state.calls.start, 1);
  assert.deepEqual(state.lastStartInput, { providerId: 'codex', targetAccountRef: '' });
});

test('Begin 失败：Go 的 4xx 错误码原样成为失败原因，且不可重试', async (t) => {
  const aiHomeDir = createTempAiHome(t);
  const { goAuthJobs } = createFakeGoAuthJobs({
    startResponse: { ok: false, status: 409, errorCode: 'active_job_exists' }
  });
  const manager = createManager(t, aiHomeDir, goAuthJobs);

  const started = manager.startOauthJob('codex', 'oauth-browser');
  const job = await waitFor(() => {
    const current = manager.getJob(started.jobId);
    return current && current.status !== 'running' ? current : null;
  });

  assert.equal(job.status, 'failed');
  assert.equal(job.error, 'active_job_exists');
  assert.match(String(job.logs), /retryable=false/);
});

test('回调成功：用 Go 的 account_ref / cli_account_id 收尾，并主动对账一次', async (t) => {
  const aiHomeDir = createTempAiHome(t);
  const { state, goAuthJobs } = createFakeGoAuthJobs();
  const manager = createManager(t, aiHomeDir, goAuthJobs);

  const started = manager.startOauthJob('codex', 'oauth-browser');
  await waitFor(() => manager.getJob(started.jobId).authorizationUrl);

  const result = await manager.completeBrowserOauthCallback(started.jobId, GO_CALLBACK_URL);
  assert.equal(result.ok, true);
  assert.equal(state.lastCallback, GO_CALLBACK_URL, '完整回调 URL 必须原样转给 Go');

  const job = manager.getJob(started.jobId);
  assert.equal(job.status, 'succeeded', `job 应成功，实际 ${job.status}: ${job.error}`);
  assert.equal(job.accountRef, 'acct_' + '1'.padStart(22, '0'));
  assert.equal(job.cliAccountId, 1);
  assert.equal(state.reconciles, 1, '收尾后必须主动对账一次（不等 15s）');
  assert.match(String(job.logs), /已触发 Go 账号对账/);
});

test('回调失败：provider_rejected 不可重试，provider_unavailable 可重试', async (t) => {
  for (const [errorCode, expectedRetryable] of [['provider_rejected', false], ['provider_unavailable', true]]) {
    const aiHomeDir = createTempAiHome(t);
    const { goAuthJobs } = createFakeGoAuthJobs({
      completeResponse: { ok: false, status: 502, errorCode }
    });
    const manager = createManager(t, aiHomeDir, goAuthJobs);

    const started = manager.startOauthJob('codex', 'oauth-browser');
    await waitFor(() => manager.getJob(started.jobId).authorizationUrl);
    const result = await manager.completeBrowserOauthCallback(started.jobId, GO_CALLBACK_URL);

    assert.equal(result.ok, false);
    assert.equal(result.code, errorCode);
    assert.equal(result.retryable, expectedRetryable);
    const job = manager.getJob(started.jobId);
    assert.equal(job.status, 'failed');
    assert.equal(job.error, errorCode);
  }
});

test('回调返回 200 但 Go 侧 Job 已是失败态：以失败码为准，不假装成功', async (t) => {
  const aiHomeDir = createTempAiHome(t);
  const { state, goAuthJobs } = createFakeGoAuthJobs({
    completeResponse: {
      ok: true,
      status: 200,
      data: { job_id: GO_JOB_ID, status: 'failed', failure_code: 'state_mismatch' }
    }
  });
  const manager = createManager(t, aiHomeDir, goAuthJobs);

  const started = manager.startOauthJob('codex', 'oauth-browser');
  await waitFor(() => manager.getJob(started.jobId).authorizationUrl);
  const result = await manager.completeBrowserOauthCallback(started.jobId, GO_CALLBACK_URL);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'state_mismatch');
  const job = manager.getJob(started.jobId);
  assert.equal(job.status, 'failed');
  assert.equal(job.error, 'state_mismatch');
  assert.equal(state.reconciles, 0, '失败不能触发对账');
});

test('二次登录同一身份：假 store 里仍然只有一个账号', async (t) => {
  const aiHomeDir = createTempAiHome(t);
  const { state, goAuthJobs } = createFakeGoAuthJobs();
  const manager = createManager(t, aiHomeDir, goAuthJobs);

  const first = manager.startOauthJob('codex', 'oauth-browser');
  await waitFor(() => manager.getJob(first.jobId).authorizationUrl);
  await manager.completeBrowserOauthCallback(first.jobId, GO_CALLBACK_URL);
  const firstJob = manager.getJob(first.jobId);
  assert.equal(firstJob.status, 'succeeded');
  assert.equal(state.accounts.size, 1);

  const second = manager.startOauthJob('codex', 'oauth-browser');
  await waitFor(() => manager.getJob(second.jobId).authorizationUrl);
  await manager.completeBrowserOauthCallback(second.jobId, GO_CALLBACK_URL);
  const secondJob = manager.getJob(second.jobId);

  assert.equal(secondJob.status, 'succeeded', `第二次登录应成功，实际 ${secondJob.status}: ${secondJob.error}`);
  assert.equal(secondJob.accountRef, firstJob.accountRef, '同一身份必须复用 Go 分配的 account_ref');
  assert.equal(secondJob.cliAccountId, firstJob.cliAccountId);
  assert.equal(state.accounts.size, 1, 'Node 不能再注册出一个账号');
  assert.equal(state.reconciles, 2, '每次登录成功都要对账一次');
});

test('取消：释放 Go 侧 pending Job，避免下一次 Begin 撞 active_job_exists', async (t) => {
  const aiHomeDir = createTempAiHome(t);
  const { state, goAuthJobs } = createFakeGoAuthJobs();
  const manager = createManager(t, aiHomeDir, goAuthJobs);

  const started = manager.startOauthJob('codex', 'oauth-browser');
  const job = await waitFor(() => {
    const current = manager.getJob(started.jobId);
    return current && current._goAuthJobId ? current : null;
  });
  assert.equal(job._goAuthJobId, GO_JOB_ID);

  manager.cancelJob(started.jobId);
  await waitFor(() => state.calls.cancel === 1);
  assert.equal(manager.getJob(started.jobId).status, 'cancelled');
  assert.equal(state.jobs.get(GO_JOB_ID).status, 'cancelled');
});

test('zcode add：codex 开关关闭也固定调用 Go，本地不生成 PKCE/state', async (t) => {
  const aiHomeDir = createTempAiHome(t);
  const { state, goAuthJobs } = createFakeGoAuthJobs({
    authorizationUrl: ZCODE_GO_AUTH_URL,
    codexEnabled: false
  });
  const manager = createManager(t, aiHomeDir, { ...goAuthJobs, codexEnabled: false });

  const started = manager.startOauthJob('zcode', 'oauth-browser', { authStrategy: 'zai:custom-scheme' });
  const job = await waitFor(() => {
    const current = manager.getJob(started.jobId);
    return current && current.authorizationUrl ? current : null;
  });

  assert.equal(state.calls.start, 1, 'zcode 必须调用 Go，且不受 codex 开关影响');
  assert.deepEqual(state.lastStartInput, { providerId: 'zcode', targetAccountRef: '' });
  assert.equal(job.authorizationUrl, ZCODE_GO_AUTH_URL, '授权链接必须来自 Go');
  assert.equal(job._goAuthJobWired, true);
  assert.equal(job._goAuthJobId, GO_JOB_ID);
  assert.equal(job.redirectUri, 'zcode://oauth/callback');
  assert.equal(job._codeVerifier, '', 'PKCE verifier 只在 Go 进程内');
  assert.equal(job.oauthState, '', 'state 校验以 Go 为权威');
  assert.equal(job.callbackCaptureStatus, 'manual_only', '自定义协议没有可监听的 loopback');
});

test('zcode 回调：完整 zcode:// 地址原样交给 Go，按 Go 的 account_ref 收尾', async (t) => {
  const aiHomeDir = createTempAiHome(t);
  const { state, goAuthJobs } = createFakeGoAuthJobs({ authorizationUrl: ZCODE_GO_AUTH_URL });
  const manager = createManager(t, aiHomeDir, goAuthJobs);

  const started = manager.startOauthJob('zcode', 'oauth-browser', { authStrategy: 'zai:custom-scheme' });
  await waitFor(() => manager.getJob(started.jobId).authorizationUrl);

  const result = await manager.completeBrowserOauthCallback(started.jobId, ZCODE_CALLBACK_URL);
  assert.equal(result.ok, true);
  assert.equal(state.calls.complete, 1);
  assert.equal(state.lastCallback, ZCODE_CALLBACK_URL, 'Node 不解析、不裁剪，整段回调交给 Go');

  const job = manager.getJob(started.jobId);
  assert.equal(job.status, 'succeeded', `job 应成功，实际 ${job.status}: ${job.error}`);
  assert.equal(job.accountRef, 'acct_' + '1'.padStart(22, '0'));
  assert.equal(job.cliAccountId, 1);
  assert.equal(state.reconciles, 1, '收尾后必须主动对账一次（不等 15s）');
});

test('zcode 回调失败：Go 错误码按既有 retryable 语义返回', async (t) => {
  for (const [errorCode, expectedRetryable] of [['provider_rejected', false], ['provider_unavailable', true]]) {
    const aiHomeDir = createTempAiHome(t);
    const { goAuthJobs } = createFakeGoAuthJobs({
      authorizationUrl: ZCODE_GO_AUTH_URL,
      completeResponse: { ok: false, status: 502, errorCode }
    });
    const manager = createManager(t, aiHomeDir, goAuthJobs);

    const started = manager.startOauthJob('zcode', 'oauth-browser', { authStrategy: 'zai:custom-scheme' });
    await waitFor(() => manager.getJob(started.jobId).authorizationUrl);
    const result = await manager.completeBrowserOauthCallback(started.jobId, ZCODE_CALLBACK_URL);

    assert.equal(result.ok, false);
    assert.equal(result.code, errorCode);
    assert.equal(result.retryable, expectedRetryable);
    const job = manager.getJob(started.jobId);
    assert.equal(job.status, 'failed');
    assert.equal(job.error, errorCode);
  }
});

test('zcode reauth：目标账号作为 target_account_ref 交给 Go', async (t) => {
  const aiHomeDir = createTempAiHome(t);
  const { state, goAuthJobs } = createFakeGoAuthJobs({ authorizationUrl: ZCODE_GO_AUTH_URL });
  const registered = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'zcode',
    identitySeed: 'oauth:zcode:reauth-subject'
  });
  const manager = createManager(t, aiHomeDir, goAuthJobs);

  const started = manager.startOauthJob('zcode', 'oauth-browser', { accountRef: registered.accountRef });
  const job = await waitFor(() => {
    const current = manager.getJob(started.jobId);
    return current && current._goAuthJobId ? current : null;
  });

  assert.equal(job.reauth, true);
  assert.deepEqual(state.lastStartInput, {
    providerId: 'zcode',
    targetAccountRef: registered.accountRef
  });
});

test('zcode 跨端引用：reauth 目标送 Go 键，完成后 account_ref 翻回 Node 键', async (t) => {
  const aiHomeDir = createTempAiHome(t);
  const nodeRef = 'acct_' + '2'.padStart(22, '0');
  const { state, goAuthJobs } = createFakeGoAuthJobs({
    authorizationUrl: ZCODE_GO_AUTH_URL,
    completeResponse: {
      ok: true,
      status: 200,
      data: {
        job_id: GO_JOB_ID,
        status: 'completed',
        account_ref: 'go-ref-1',
        cli_account_id: 7
      }
    }
  });
  const registered = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'zcode',
    identitySeed: 'oauth:zcode:region|reauth-subject'
  });
  const manager = createManager(t, aiHomeDir, {
    ...goAuthJobs,
    resolveGoAccountRef: (ref) => (ref === registered.accountRef ? 'go-target-ref' : ref),
    resolveNodeAccountRef: (goRef) => (goRef === 'go-ref-1' ? nodeRef : goRef)
  });

  const started = manager.startOauthJob('zcode', 'oauth-browser', { accountRef: registered.accountRef });
  await waitFor(() => manager.getJob(started.jobId).authorizationUrl);
  assert.deepEqual(state.lastStartInput, {
    providerId: 'zcode',
    targetAccountRef: 'go-target-ref'
  });

  const result = await manager.completeBrowserOauthCallback(started.jobId, ZCODE_CALLBACK_URL);
  assert.equal(result.ok, true);
  assert.equal(manager.getJob(started.jobId).accountRef, nodeRef, '收尾必须用 Node 账号键');
});

test('zcode 在 Go 门面缺失时明确失败，不悄悄回退到 CLI', (t) => {
  const aiHomeDir = createTempAiHome(t);
  const manager = createManager(t, aiHomeDir, null);
  assert.throws(
    () => manager.startOauthJob('zcode', 'oauth-browser'),
    (error) => error && error.code === 'go_auth_job_unavailable'
  );
});

test('zcode 的 Node 策略已删除，注册表不再 require 它', () => {
  const strategyFile = path.join(__dirname, '..', 'lib', 'server', 'oauth-strategies', 'zcode.js');
  assert.equal(fs.existsSync(strategyFile), false, 'zcode.js 必须已删除');
  const registry = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'server', 'oauth-strategies', 'index.js'),
    'utf8'
  );
  assert.equal(registry.includes("require('./zcode')"), false, '注册表不能留下 zcode 依赖');
});

test('失败映射：Go 错误码优先，5xx 与无响应可重试，4xx 不可重试', () => {
  assert.deepEqual(toGoAuthJobFailure(null), {
    ok: false,
    code: 'go_auth_job_unavailable',
    status: 0,
    retryable: true
  });
  assert.equal(toGoAuthJobFailure({ ok: false, status: 502, errorCode: 'provider_rejected' }).retryable, false);
  assert.equal(toGoAuthJobFailure({ ok: false, status: 502, errorCode: 'provider_unavailable' }).retryable, true);
  assert.equal(toGoAuthJobFailure({ ok: false, status: 500 }).retryable, true);
  assert.equal(toGoAuthJobFailure({ ok: false, status: 404, errorCode: 'job_not_found' }).retryable, false);
  assert.equal(isGoAuthJobFailureRetryable('', 503), true);
  assert.equal(isGoAuthJobFailureRetryable('', 400), false);
});

test('开关解析：client 始终装配（zcode 需要），codexEnabled 只表达 codex 开关', () => {
  const goCoreSync = {
    startAccountAuthJob: async () => null,
    completeAccountAuthJob: async () => null,
    cancelAccountAuthJob: async () => null
  };
  const disabled = createGoAuthJobsOption({
    readServerConfig: () => ({ codexBrowserAuthViaGo: false }),
    goCoreSync
  });
  assert.equal(disabled.codexEnabled, false);
  assert.ok(disabled.client, 'zcode 固定走 Go，开关关闭时也必须有 client');

  const noGoCore = createGoAuthJobsOption({ readServerConfig: () => ({ codexBrowserAuthViaGo: true }) });
  assert.equal(noGoCore.client, null, '没有 Go 门面时不能假装能承接登录');

  const enabled = createGoAuthJobsOption({ readServerConfig: () => ({ codexBrowserAuthViaGo: true }), goCoreSync });
  assert.equal(enabled.codexEnabled, true);
  assert.equal(enabled.reconcile, null, '未装配对账时只能是 null，不能调用不存在的方法');
});
