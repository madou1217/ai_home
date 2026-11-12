'use strict';

// 两个「需要重新登录」误判的回归测试（2026-10-31）：
//   1. kiro：access token 约 1 小时过期，网关从不刷新 → 403 AccessDenied 被锁号一年；
//      对端 AIH 网关回的「池内账号全失效」401 又让下游把自己的 api key 冷却掉。
//   2. codex：套餐变更作废 access token → 401 直接标「需要重新登录」，刷新暂时失败也不撤销。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { upsertAccountRef } = require('../lib/server/account-ref-store');
const {
  readAccountCredentialRecord,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');
const { refreshKiroAccountAccessToken } = require('../lib/server/kiro-access-token-refresh');
const { kiroStreamTransport } = require('../lib/server/upstream-endpoints-transport-kiro');
const {
  classifyUpstreamFailure,
  isRelayPoolAuthExhaustedResponse
} = require('../lib/server/upstream-failure-policy');
const { buildNoAvailableAccountResponse } = require('../lib/server/account-availability');
const { createCodexAuthInvalidReconciler } = require('../lib/cli/services/usage/codex-auth-invalid-reconciler');

function setupKiroAccount(t, { expiresAt }) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kiro-refresh-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, { provider: 'kiro', cliAccountId: '1', identitySeed: 'kiro:refresh-test' });
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
    flavor: 'desktop',
    profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/OLD',
    auth: { access_token: 'OLD-AT', refresh_token: 'RT', expires_at: expiresAt, region: 'us-east-1' }
  });
  return { aiHomeDir, accountRef };
}

function fakeEnsureFresh(calls, nextToken = 'NEW-AT') {
  return async (record, options) => {
    calls.push(options.now);
    const expires = Date.parse(record.nativeAuth.auth.expires_at);
    if (expires - 60_000 > options.now) return { record, refreshed: false };
    const next = {
      ...record,
      nativeAuth: {
        ...record.nativeAuth,
        profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/NEW',
        auth: { ...record.nativeAuth.auth, access_token: nextToken, expires_at: new Date(Date.now() + 3_600_000).toISOString() }
      }
    };
    return { record: next, refreshed: true };
  };
}

test('kiro refresh: expired token is refreshed before use and the in-memory account adopts it', async (t) => {
  const { aiHomeDir, accountRef } = setupKiroAccount(t, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  const account = { accountRef, provider: 'kiro', accessToken: 'OLD-AT' };
  const calls = [];
  const result = await refreshKiroAccountAccessToken(account, {}, {
    fs, aiHomeDir, ensureFreshKiroGrant: fakeEnsureFresh(calls)
  });
  assert.deepEqual([result.ok, result.refreshed], [true, true]);
  assert.equal(account.accessToken, 'NEW-AT');
  assert.equal(account.profileArn, 'arn:aws:codewhisperer:us-east-1:1:profile/NEW');
});

test('kiro refresh: fresh token is left alone unless forced', async (t) => {
  const { aiHomeDir, accountRef } = setupKiroAccount(t, { expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  const account = { accountRef, provider: 'kiro', accessToken: 'OLD-AT' };
  const calls = [];
  const deps = { fs, aiHomeDir, ensureFreshKiroGrant: fakeEnsureFresh(calls) };
  const notDue = await refreshKiroAccountAccessToken(account, {}, deps);
  assert.equal(notDue.refreshed, false);
  assert.equal(account.accessToken, 'OLD-AT');
  const forced = await refreshKiroAccountAccessToken(account, { force: true }, deps);
  assert.equal(forced.refreshed, true);
  assert.equal(account.accessToken, 'NEW-AT');
});

test('kiro refresh: adopts a token another writer already stored without calling the refresh endpoint', async (t) => {
  const { aiHomeDir, accountRef } = setupKiroAccount(t, { expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  const account = { accountRef, provider: 'kiro', accessToken: 'STALE-IN-MEMORY' };
  const calls = [];
  const result = await refreshKiroAccountAccessToken(account, { force: true }, {
    fs, aiHomeDir, ensureFreshKiroGrant: fakeEnsureFresh(calls)
  });
  assert.equal(result.reason, 'adopted_newer_credentials');
  assert.equal(account.accessToken, 'OLD-AT');
  assert.equal(calls.length, 0);
  assert.ok(readAccountCredentialRecord(fs, aiHomeDir, accountRef));
});

test('kiro refresh: rejected refresh_token is reported as unrecoverable; network errors are not', async (t) => {
  const { aiHomeDir, accountRef } = setupKiroAccount(t, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  const failWith = (code) => async () => { const error = new Error(code); error.code = code; throw error; };
  const account = { accountRef, provider: 'kiro', accessToken: 'OLD-AT' };
  const rejected = await refreshKiroAccountAccessToken(account, { force: true }, {
    fs, aiHomeDir, ensureFreshKiroGrant: failWith('kiro_refresh_http_401')
  });
  assert.equal(rejected.unrecoverable, true);
  const offline = await refreshKiroAccountAccessToken(account, { force: true }, {
    fs, aiHomeDir, ensureFreshKiroGrant: failWith('kiro_refresh_transport_failed')
  });
  assert.equal(offline.unrecoverable, false);
});

function kiroTransportCtx(overrides = {}) {
  const failures = [];
  let retriedSame = 0;
  const account = { accountRef: 'acct_kirotransport0000001', provider: 'kiro', accessToken: 'OLD-AT' };
  const ctx = {
    options: {},
    state: { metrics: { totalTimeouts: 0, totalFailures: 0, providerFailures: {} } },
    res: { headersSent: false, writableEnded: false, setHeader() {}, end() {} },
    requestJson: { model: 'claude-opus-5.5' },
    routeKey: 'POST /v1/messages',
    requestStartedAt: Date.now(),
    cooldownMs: 60_000,
    requestMeta: { requestId: 'r1' },
    provider: 'kiro',
    streamRequested: false,
    recordAccountSuccess() {},
    recordAccountFailure: (_account, policy) => failures.push(policy),
    diagnosticMaxAttempts: () => 2,
    recordModelUsage() {},
    appendProxyRequestLog() {},
    control: { attempt: 0, retrySameAccount: () => { retriedSame += 1; }, setLastError() {} },
    account,
    attemptUpstreamTimeoutMs: 1000,
    forcedRefreshRetryUsed: new Set(),
    attemptMutable: { streamTransport: 'non_stream' },
    ...overrides
  };
  return { ctx, failures, get retriedSame() { return retriedSame; } };
}

function accessDenied() {
  const error = new Error('com.amazon.aws.codewhisperer#AccessDeniedException');
  error.code = 'com.amazon.aws.codewhisperer#AccessDeniedException';
  error.kiroStatusCode = 403;
  return error;
}

test('kiro transport: 403 AccessDenied triggers a forced refresh and retries the same account', async () => {
  const refreshCalls = [];
  const harness = kiroTransportCtx();
  harness.ctx.deps = {
    refreshKiroAccountAccessToken: async (account, options) => {
      refreshCalls.push(options.force);
      if (options.force) account.accessToken = 'NEW-AT';
      return options.force ? { ok: true, refreshed: true } : { ok: true, refreshed: false };
    },
    fetchKiroChatCompletion: async () => { throw accessDenied(); }
  };
  const action = await kiroStreamTransport.run(harness.ctx);
  assert.deepEqual(action, { action: 'retry_same' });
  assert.deepEqual(refreshCalls, [false, true]);
  assert.equal(harness.retriedSame, 1);
  assert.equal(harness.failures.length, 0, 'a refreshable token must not be recorded as an account failure');
  assert.ok(harness.ctx.forcedRefreshRetryUsed.has('acct_kirotransport0000001'));
});

test('kiro transport: refresh endpoint unreachable → short token_refresh_unavailable, not reauth', async () => {
  const harness = kiroTransportCtx();
  harness.ctx.deps = {
    refreshKiroAccountAccessToken: async (_account, options) => (options.force
      ? { ok: false, refreshed: false, reason: 'kiro_refresh_transport_failed', unrecoverable: false }
      : { ok: true, refreshed: false }),
    fetchKiroChatCompletion: async () => { throw accessDenied(); }
  };
  await kiroStreamTransport.run(harness.ctx);
  assert.equal(harness.failures.length, 1);
  assert.equal(harness.failures[0].kind, 'token_refresh_unavailable');
  assert.notEqual(harness.failures[0].failureReason, 'auth_invalid_reauth_required');
});

test('kiro transport: refresh_token rejected → still auth_invalid (real reauth)', async () => {
  const harness = kiroTransportCtx();
  harness.ctx.deps = {
    refreshKiroAccountAccessToken: async (_account, options) => (options.force
      ? { ok: false, refreshed: false, reason: 'kiro_refresh_http_401', unrecoverable: true }
      : { ok: true, refreshed: false }),
    fetchKiroChatCompletion: async () => { throw accessDenied(); }
  };
  await kiroStreamTransport.run(harness.ctx);
  assert.equal(harness.failures[0].kind, 'auth_invalid');
  assert.equal(harness.failures[0].failureReason, 'auth_invalid_reauth_required');
});

test('kiro transport: only one forced refresh per account per request', async () => {
  const harness = kiroTransportCtx();
  harness.ctx.forcedRefreshRetryUsed.add('acct_kirotransport0000001');
  let forced = 0;
  harness.ctx.deps = {
    refreshKiroAccountAccessToken: async (_account, options) => {
      if (options.force) forced += 1;
      return { ok: true, refreshed: Boolean(options.force) };
    },
    fetchKiroChatCompletion: async () => { throw accessDenied(); }
  };
  await kiroStreamTransport.run(harness.ctx);
  assert.equal(forced, 0);
  assert.equal(harness.failures[0].kind, 'auth_invalid');
});

const RELAY_BODY = JSON.stringify({
  ok: false,
  error: 'auth_invalid_reauth_required',
  detail: 'no schedulable kiro account: runtime:auth_invalid:auth_invalid_reauth_required=1'
});
const RELAY_ACCOUNT = { accountRef: 'acct_relay', provider: 'claude', apiKeyMode: true, authType: 'api-key', openaiBaseUrl: 'https://proxy.example.com' };

test('relay: remote AIH pool auth exhaustion does not cool the local api key', () => {
  const policy = classifyUpstreamFailure({
    provider: 'claude', statusCode: 401, body: RELAY_BODY, account: RELAY_ACCOUNT,
    detail: 'upstream_401', defaultCooldownMs: 60_000
  });
  assert.equal(policy.kind, 'remote_pool_unavailable');
  assert.equal(policy.shouldMarkFailure, false);
  assert.equal(policy.cooldownMs, 0);
  assert.equal(policy.shouldRetryAnotherAccount, true);
});

test('relay: a genuine 401 from a custom upstream is still api_key_rejected', () => {
  const policy = classifyUpstreamFailure({
    provider: 'claude', statusCode: 401,
    body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
    account: RELAY_ACCOUNT, detail: 'upstream_401', defaultCooldownMs: 60_000
  });
  assert.equal(policy.kind, 'auth_invalid');
  assert.equal(policy.failureReason, 'api_key_rejected');
});

test('relay: detection requires a custom api-key upstream and the AIH envelope', () => {
  assert.equal(isRelayPoolAuthExhaustedResponse({
    provider: 'claude', statusCode: 401, body: RELAY_BODY,
    account: { ...RELAY_ACCOUNT, apiKeyMode: false, authType: 'oauth' }
  }), false);
  assert.equal(isRelayPoolAuthExhaustedResponse({
    provider: 'claude', statusCode: 401,
    body: JSON.stringify({ error: 'auth_invalid_reauth_required', detail: 'no schedulable kiro account' }),
    account: RELAY_ACCOUNT
  }), false, 'missing ok:false envelope');
});

test('gateway: whole pool auth_invalid answers 503 (error code kept), never 401', () => {
  const now = Date.now();
  const accounts = [{
    accountRef: 'acct_x', provider: 'kiro', status: 'up', configured: true,
    authInvalidUntil: now + 3_600_000, cooldownUntil: now + 3_600_000,
    lastFailureKind: 'auth_invalid', lastFailureReason: 'auth_invalid_reauth_required',
    lastError: 'auth_invalid_reauth_required'
  }];
  const response = buildNoAvailableAccountResponse('kiro', accounts, { now });
  assert.equal(response.payload.error, 'auth_invalid_reauth_required');
  assert.equal(response.statusCode, 503);
});

function createStateServiceStub(initialRuntime) {
  const store = { runtimeState: { ...initialRuntime }, status: 'up', configured: true, apiKeyMode: false, authMode: 'oauth' };
  return {
    store,
    getAccountState: () => ({ ...store, runtimeState: { ...store.runtimeState } }),
    recordRuntimeFailure: (_ref, _provider, runtimeState) => { store.runtimeState = runtimeState; return true; },
    clearRuntimeBlock: () => true,
    setOperationalStatus: (_ref, _provider, status) => { store.status = status; return true; }
  };
}

test('codex reconciler: transient refresh failure lifts auth_invalid into a short retry cooldown', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-reconcile-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, { provider: 'codex', cliAccountId: '1', identitySeed: 'codex:upgrade-test' });
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
    auth: { auth_mode: 'chatgpt', tokens: { access_token: 'AT', refresh_token: 'rt_valid', id_token: 'x' } }
  });
  const now = Date.now();
  const stateService = createStateServiceStub({
    authInvalidUntil: now + 365 * 86_400_000,
    cooldownUntil: now + 365 * 86_400_000,
    lastFailureKind: 'auth_invalid',
    lastFailureReason: 'auth_invalid_reauth_required:direct_http_status_401'
  });
  const reconciler = createCodexAuthInvalidReconciler({
    fs,
    aiHomeDir,
    accountStateService: stateService,
    refreshCodexAccessToken: async () => ({ ok: false, refreshed: false, reason: 'account_egress_unavailable' }),
    processObj: { nextTick: (fn) => setImmediate(fn) }
  });
  reconciler.enqueueAuthInvalidReauthRequired('codex', accountRef, 'auth_invalid_reauth_required:direct_http_status_401');
  await reconciler.waitForIdle();
  const runtime = stateService.store.runtimeState;
  assert.equal(runtime.authInvalidUntil, 0);
  assert.equal(runtime.lastFailureKind, 'upstream_error');
  assert.ok(runtime.cooldownUntil > now && runtime.cooldownUntil < now + 10 * 60_000);
  assert.equal(stateService.store.status, 'up');
});
