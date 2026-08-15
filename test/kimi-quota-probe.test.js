'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  upsertAccountRef
} = require('../lib/server/account-ref-store');
const {
  readAccountNativeAuth,
  writeAccountNativeAuth,
  writeAccountCredentials
} = require('../lib/server/account-credential-store');
const {
  USAGE_SNAPSHOT_KINDS,
  getUsageRemainingPctValues,
  getMinRemainingPctFromUsageSnapshot
} = require('../lib/account/usage-remaining');
const {
  createKimiQuotaProbe,
  __private: probePrivate
} = require('../lib/cli/services/usage/kimi-quota-probe');
const {
  refreshKimiAccessToken,
  __private: refreshPrivate
} = require('../lib/server/kimi-token-refresh');

function makeJwt(payload) {
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
  return `${encode({ alg: 'none' })}.${encode(payload)}.sig`;
}

function makeOkResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  };
}

function setupKimiAccount(options = {}) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kimi-quota-'));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'kimi',
    cliAccountId: options.cliAccountId || '1',
    identitySeed: `test:kimi:quota:${options.cliAccountId || '1'}`
  });
  if (options.env) writeAccountCredentials(fs, aiHomeDir, accountRef, options.env);
  if (options.credentials) {
    writeAccountNativeAuth(fs, aiHomeDir, accountRef, { credentials: options.credentials });
  }
  return { aiHomeDir, accountRef };
}

test('parseKimiUsagePayload maps summary and limits into windowed entries', () => {
  const snapshot = probePrivate.parseKimiUsagePayload({
    usage: { used: 200, limit: 1000, resetTime: '2030-01-01T00:00:00Z' },
    limits: [
      {
        name: '5h_burst',
        window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' },
        detail: { used: 10, limit: 50, resetTime: '2030-01-01T00:00:00Z' }
      }
    ]
  }, Date.now(), null);

  assert.equal(snapshot.kind, 'kimi_oauth_usage');
  assert.equal(snapshot.entries.length, 2);
  const weekly = snapshot.entries.find((entry) => entry.bucket === 'weekly');
  assert.equal(weekly.windowMinutes, 10080);
  assert.equal(weekly.window, '7days');
  assert.equal(weekly.remainingPct, 80);
  const burst = snapshot.entries.find((entry) => entry.bucket === '5h_burst');
  assert.equal(burst.windowMinutes, 300);
  assert.equal(burst.window, '5h');
  assert.equal(burst.remainingPct, 80);
});

test('parseKimiUsagePayload returns null for empty payload', () => {
  assert.equal(probePrivate.parseKimiUsagePayload({}, Date.now(), null), null);
  assert.equal(probePrivate.parseKimiUsagePayload(null, Date.now(), null), null);
});

test('usage-remaining registry extracts kimi entries like codex/claude', () => {
  const snapshot = {
    kind: USAGE_SNAPSHOT_KINDS.kimi,
    entries: [{ remainingPct: 79 }, { remainingPct: 96 }]
  };
  assert.deepEqual(getUsageRemainingPctValues(snapshot), [79, 96]);
  assert.equal(getMinRemainingPctFromUsageSnapshot(snapshot), 79);
  assert.equal(USAGE_SNAPSHOT_KINDS.kimi, 'kimi_oauth_usage');
});

test('kimi quota probe fetches /usages with a still-valid access token', async () => {
  const { aiHomeDir, accountRef } = setupKimiAccount({
    credentials: {
      access_token: 'still-valid-token',
      refresh_token: 'rt',
      expires_at: Math.floor(Date.now() / 1000) + 3600
    }
  });
  const calls = [];
  const probe = createKimiQuotaProbe({
    fs,
    aiHomeDir,
    readAccountCredentialRecord: require('../lib/server/account-credential-store').readAccountCredentialRecord,
    fetchWithTimeout: async (url, init) => {
      calls.push({ url, init });
      return makeOkResponse({ usage: { used: 21, limit: 100, resetTime: '2030-01-01T00:00:00Z' } });
    }
  });
  try {
    const result = await probe.probe(accountRef, 5000);
    assert.ok(result.snapshot, 'expected snapshot');
    assert.equal(result.snapshot.entries[0].remainingPct, 79);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://api.kimi.com/coding/v1/usages');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer still-valid-token');
    assert.equal(calls[1].url, 'https://api.kimi.com/coding/v1/me');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('kimi quota probe rejects access-only OAuth even when a base URL env value exists', async () => {
  const { aiHomeDir, accountRef } = setupKimiAccount({
    env: { KIMI_BASE_URL: 'https://api.moonshot.ai/v1' },
    credentials: {
      access_token: 'short-lived-access-only',
      expires_at: Math.floor(Date.now() / 1000) + 3600
    }
  });
  let fetchCalls = 0;
  const probe = createKimiQuotaProbe({
    fs,
    aiHomeDir,
    readAccountCredentialRecord: require('../lib/server/account-credential-store').readAccountCredentialRecord,
    fetchWithTimeout: async () => {
      fetchCalls += 1;
      throw new Error('access-only accounts must not enter the quota probe');
    }
  });
  try {
    const result = await probe.probe(accountRef, 5000);
    assert.equal(result.error, 'missing_oauth_credentials');
    assert.equal(fetchCalls, 0);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('kimi quota probe refreshes expired tokens for second, millisecond, expiresAt, and JWT expiry shapes', async () => {
  const nowMs = Date.now();
  const cases = [
    {
      name: 'seconds expires_at',
      credentials: { expires_at: Math.floor(nowMs / 1000) - 60 }
    },
    {
      name: 'milliseconds expires_at',
      credentials: { expires_at: nowMs - 60_000 }
    },
    {
      name: 'expiresAt alias',
      credentials: { expiresAt: nowMs - 60_000 }
    },
    {
      name: 'JWT exp fallback',
      credentials: { access_token: makeJwt({ exp: Math.floor(nowMs / 1000) - 60 }) }
    }
  ];

  for (const [index, entry] of cases.entries()) {
    const { aiHomeDir, accountRef } = setupKimiAccount({
      cliAccountId: String(30 + index),
      credentials: {
        access_token: `expired-token-${index}`,
        refresh_token: `refresh-token-${index}`,
        ...entry.credentials
      }
    });
    const calls = [];
    const probe = createKimiQuotaProbe({
      fs,
      aiHomeDir,
      now: () => nowMs,
      readAccountCredentialRecord: require('../lib/server/account-credential-store').readAccountCredentialRecord,
      fetchWithTimeout: async (url) => {
        calls.push(url);
        if (url.includes('/api/oauth/token')) {
          return makeOkResponse({
            access_token: `fresh-token-${index}`,
            refresh_token: `rotated-refresh-token-${index}`,
            expires_in: 900
          });
        }
        return makeOkResponse({ usage: { used: 1, limit: 100 } });
      }
    });
    try {
      const result = await probe.probe(accountRef, 5000);
      assert.ok(result.snapshot, entry.name);
      assert.equal(calls[0], 'https://auth.kimi.com/api/oauth/token', entry.name);
    } finally {
      fs.rmSync(aiHomeDir, { recursive: true, force: true });
    }
  }
});

test('kimi quota probe refreshes an expired access token before probing', async () => {
  const { aiHomeDir, accountRef } = setupKimiAccount({
    credentials: {
      access_token: 'expired-token',
      refresh_token: 'rt-old',
      expires_at: Math.floor(Date.now() / 1000) - 60
    }
  });
  const calls = [];
  const hookEvents = [];
  const probe = createKimiQuotaProbe({
    fs,
    aiHomeDir,
    readAccountCredentialRecord: require('../lib/server/account-credential-store').readAccountCredentialRecord,
    accountArtifactHooks: {
      notifyDefaultAccountAuthUpdated: (event) => hookEvents.push(event)
    },
    fetchWithTimeout: async (url, init) => {
      calls.push(url);
      if (url.includes('/api/oauth/token')) {
        return makeOkResponse({
          access_token: 'fresh-token',
          refresh_token: 'rt-new',
          expires_in: 900
        });
      }
      assert.equal(init.headers.Authorization, 'Bearer fresh-token');
      return makeOkResponse({ usage: { used: 4, limit: 100 } });
    }
  });
  try {
    const result = await probe.probe(accountRef, 5000);
    assert.ok(result.snapshot, 'expected snapshot after refresh');
    assert.deepEqual(calls, [
      'https://auth.kimi.com/api/oauth/token',
      'https://api.kimi.com/coding/v1/usages',
      'https://api.kimi.com/coding/v1/me'
    ]);
    // 刷新成功必须回写凭证库，否则下一轮（以及网关加载）仍拿到过期 token。
    const persisted = readAccountNativeAuth(fs, aiHomeDir, accountRef).credentials;
    assert.equal(persisted.access_token, 'fresh-token');
    assert.equal(persisted.refresh_token, 'rt-new');
    assert.deepEqual(hookEvents, [{
      provider: 'kimi',
      accountRef,
      artifactPath: 'app-state.db',
      source: 'token_refresh',
      reason: 'kimi_oauth_token_refreshed'
    }]);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('kimi quota probe forwards proxy, device headers, and timeout through refresh and usage requests', async () => {
  const { aiHomeDir, accountRef } = setupKimiAccount({
    credentials: {
      access_token: 'expired-quota-transport',
      refresh_token: 'rt-quota-transport',
      expires_at: Math.floor(Date.now() / 1000) - 60
    }
  });
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
    deviceId: 'device-quota-456',
    credentials: {
      access_token: 'expired-quota-transport',
      refresh_token: 'rt-quota-transport',
      expires_at: Math.floor(Date.now() / 1000) - 60
    }
  });
  const requests = [];
  const probe = createKimiQuotaProbe({
    fs,
    aiHomeDir,
    readAccountCredentialRecord: require('../lib/server/account-credential-store').readAccountCredentialRecord,
    proxyUrl: 'http://127.0.0.1:7891',
    noProxy: 'usage.internal',
    fetchWithTimeout: async (url, init, timeoutMs, proxyOptions) => {
      requests.push({ url, init, timeoutMs, proxyOptions });
      if (url.endsWith('/api/oauth/token')) {
        return makeOkResponse({
          access_token: 'fresh-quota-transport',
          refresh_token: 'rt-quota-transport-new',
          expires_in: 900
        });
      }
      if (url.endsWith('/usages')) {
        return makeOkResponse({ usage: { used: 5, limit: 100 } });
      }
      return makeOkResponse({});
    }
  });

  try {
    const result = await probe.probe(accountRef, 6123);
    assert.ok(result.snapshot, 'expected a quota snapshot');
    assert.equal(requests.length, 3);
    for (const request of requests) {
      assert.equal(request.timeoutMs, 6123);
      assert.deepEqual(request.proxyOptions, {
        proxyUrl: 'http://127.0.0.1:7891',
        noProxy: 'usage.internal'
      });
      assert.equal(request.init.headers['X-Msh-Device-Id'], 'device-quota-456');
      assert.equal(request.init.headers['X-Msh-Platform'], 'kimi_code_cli');
    }
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('kimi quota probe refreshes and migrates legacy auth refresh-only credentials', async () => {
  const { aiHomeDir, accountRef } = setupKimiAccount();
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
    deviceId: 'legacy-quota-device',
    credentials: {},
    auth: { refresh_token: 'legacy-quota-refresh' }
  });
  const calls = [];
  const probe = createKimiQuotaProbe({
    fs,
    aiHomeDir,
    readAccountCredentialRecord: require('../lib/server/account-credential-store').readAccountCredentialRecord,
    fetchWithTimeout: async (url, init) => {
      calls.push(String(url));
      if (String(url).endsWith('/api/oauth/token')) {
        assert.match(String(init.body || ''), /refresh_token=legacy-quota-refresh/u);
        return makeOkResponse({
          access_token: 'legacy-quota-access-v2',
          refresh_token: 'legacy-quota-refresh-v2',
          expires_in: 900
        });
      }
      if (String(url).endsWith('/usages')) {
        assert.equal(init.headers.Authorization, 'Bearer legacy-quota-access-v2');
        return makeOkResponse({ usage: { used: 10, limit: 100 } });
      }
      return makeOkResponse({});
    }
  });

  try {
    const result = await probe.probe(accountRef, 5000);
    const persisted = readAccountNativeAuth(fs, aiHomeDir, accountRef);
    assert.ok(result.snapshot);
    assert.deepEqual(calls, [
      'https://auth.kimi.com/api/oauth/token',
      'https://api.kimi.com/coding/v1/usages',
      'https://api.kimi.com/coding/v1/me'
    ]);
    assert.equal(persisted.auth, undefined);
    assert.equal(persisted.credentials.access_token, 'legacy-quota-access-v2');
    assert.equal(persisted.credentials.refresh_token, 'legacy-quota-refresh-v2');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('kimi quota probe selects a valid legacy snapshot when canonical credentials are empty', async () => {
  const { aiHomeDir, accountRef } = setupKimiAccount();
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
    deviceId: 'legacy-valid-device',
    credentials: {},
    auth: {
      access_token: 'legacy-valid-access',
      refresh_token: 'legacy-valid-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 3600
    }
  });
  const calls = [];
  const probe = createKimiQuotaProbe({
    fs,
    aiHomeDir,
    readAccountCredentialRecord: require('../lib/server/account-credential-store').readAccountCredentialRecord,
    fetchWithTimeout: async (url, init) => {
      calls.push(String(url));
      assert.equal(String(url).endsWith('/api/oauth/token'), false, 'valid legacy token must not refresh');
      assert.equal(init.headers.Authorization, 'Bearer legacy-valid-access');
      if (String(url).endsWith('/usages')) {
        return makeOkResponse({ usage: { used: 20, limit: 100 } });
      }
      return makeOkResponse({});
    }
  });

  try {
    const result = await probe.probe(accountRef, 5000);
    assert.ok(result.snapshot);
    assert.deepEqual(calls, [
      'https://api.kimi.com/coding/v1/usages',
      'https://api.kimi.com/coding/v1/me'
    ]);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('kimi quota probe skips API key accounts and reports 401 as auth error', async () => {
  const apiKeyAccount = setupKimiAccount({ cliAccountId: '2', env: { MOONSHOT_API_KEY: 'sk-x' } });
  const oauthAccount = setupKimiAccount({
    cliAccountId: '3',
    credentials: {
      access_token: 'valid',
      refresh_token: 'rt',
      expires_at: Math.floor(Date.now() / 1000) + 3600
    }
  });
  const deps = {
    fs,
    readAccountCredentialRecord: require('../lib/server/account-credential-store').readAccountCredentialRecord,
    fetchWithTimeout: async () => makeOkResponse({ error: 'unauthorized' }, 401)
  };
  try {
    const probeForKey = createKimiQuotaProbe({ ...deps, aiHomeDir: apiKeyAccount.aiHomeDir });
    const skipped = await probeForKey.probe(apiKeyAccount.accountRef, 5000);
    assert.equal(skipped.error, 'api_key_mode_not_applicable');

    const probeForOauth = createKimiQuotaProbe({ ...deps, aiHomeDir: oauthAccount.aiHomeDir });
    const unauthorized = await probeForOauth.probe(oauthAccount.accountRef, 5000);
    assert.equal(unauthorized.error, 'kimi_usage_http_401');
    assert.equal(unauthorized.auth, true);
  } finally {
    fs.rmSync(apiKeyAccount.aiHomeDir, { recursive: true, force: true });
    fs.rmSync(oauthAccount.aiHomeDir, { recursive: true, force: true });
  }
});

test('refreshKimiAccessToken fails closed for non-Kimi runtime or credential providers', async () => {
  const valid = setupKimiAccount({
    credentials: {
      access_token: 'provider-guard-access',
      refresh_token: 'provider-guard-refresh',
      expires_at: Math.floor(Date.now() / 1000) - 60
    }
  });
  const foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kimi-provider-guard-'));
  const foreignRef = upsertAccountRef(fs, foreignDir, {
    provider: 'codex',
    cliAccountId: '1',
    identitySeed: 'test:kimi:foreign-provider'
  });
  writeAccountNativeAuth(fs, foreignDir, foreignRef, {
    marker: 'foreign-native-auth',
    credentials: {
      access_token: 'foreign-access',
      refresh_token: 'foreign-refresh',
      expires_at: Math.floor(Date.now() / 1000) - 60
    }
  });
  let fetchCalls = 0;
  const hookEvents = [];
  const depsFor = (aiHomeDir) => ({
    fs,
    aiHomeDir,
    fetchWithTimeout: async () => {
      fetchCalls += 1;
      return makeOkResponse({ access_token: 'must-not-apply', refresh_token: 'must-not-apply' });
    },
    accountArtifactHooks: {
      notifyDefaultAccountAuthUpdated: (event) => hookEvents.push(event)
    }
  });

  try {
    for (const provider of ['', 'codex']) {
      const runtimeAccount = {
        accountRef: valid.accountRef,
        ...(provider ? { provider } : {}),
        accessToken: 'runtime-access',
        refreshToken: 'runtime-refresh',
        tokenExpiresAt: 123,
        deviceId: 'runtime-device'
      };
      const beforeRuntime = { ...runtimeAccount };
      const beforeNativeAuth = readAccountNativeAuth(fs, valid.aiHomeDir, valid.accountRef);
      const result = await refreshKimiAccessToken(runtimeAccount, { force: true }, depsFor(valid.aiHomeDir));

      assert.equal(result.ok, false);
      assert.equal(result.reason, 'not_kimi');
      assert.deepEqual(runtimeAccount, beforeRuntime);
      assert.deepEqual(readAccountNativeAuth(fs, valid.aiHomeDir, valid.accountRef), beforeNativeAuth);
    }

    const foreignRuntime = {
      accountRef: foreignRef,
      provider: 'kimi',
      accessToken: 'foreign-runtime-access',
      refreshToken: 'foreign-runtime-refresh',
      deviceId: 'foreign-runtime-device'
    };
    const beforeForeignRuntime = { ...foreignRuntime };
    const beforeForeignNativeAuth = readAccountNativeAuth(fs, foreignDir, foreignRef);
    const foreignResult = await refreshKimiAccessToken(
      foreignRuntime,
      { force: true },
      depsFor(foreignDir)
    );

    assert.equal(foreignResult.ok, false);
    assert.equal(foreignResult.reason, 'not_kimi');
    assert.deepEqual(foreignRuntime, beforeForeignRuntime);
    assert.deepEqual(readAccountNativeAuth(fs, foreignDir, foreignRef), beforeForeignNativeAuth);
    assert.equal(fetchCalls, 0);
    assert.deepEqual(hookEvents, []);
  } finally {
    fs.rmSync(valid.aiHomeDir, { recursive: true, force: true });
    fs.rmSync(foreignDir, { recursive: true, force: true });
  }
});

test('refreshKimiAccessToken persists rotated tokens and honours not_due', async () => {
  const { aiHomeDir, accountRef } = setupKimiAccount({
    credentials: {
      access_token: 'expired',
      refresh_token: 'rt-1',
      expires_at: Math.floor(Date.now() / 1000) - 10
    }
  });
  const account = { accountRef, provider: 'kimi' };
  const fetchWithTimeout = async () => makeOkResponse({
    access_token: 'at-2',
    refresh_token: 'rt-2',
    expires_in: 900,
    token_type: 'Bearer'
  });
  const hookEvents = [];
  try {
    const refreshed = await refreshKimiAccessToken(account, {}, {
      fs,
      aiHomeDir,
      fetchWithTimeout,
      accountArtifactHooks: {
        notifyDefaultAccountAuthUpdated: (event) => hookEvents.push(event)
      }
    });
    assert.equal(refreshed.ok, true);
    assert.equal(refreshed.refreshed, true);
    const persisted = readAccountNativeAuth(fs, aiHomeDir, accountRef).credentials;
    assert.equal(persisted.access_token, 'at-2');
    assert.equal(persisted.refresh_token, 'rt-2');
    assert.ok(persisted.expires_at > Math.floor(Date.now() / 1000));
    assert.deepEqual(hookEvents, [{
      provider: 'kimi',
      accountRef,
      artifactPath: 'app-state.db',
      source: 'token_refresh',
      reason: 'kimi_oauth_token_refreshed'
    }]);

    // 刚刷新的 token 在未过期且非 force 时不再请求。
    const notDue = await refreshKimiAccessToken(
      { accountRef, provider: 'kimi' },
      {},
      { fs, aiHomeDir, fetchWithTimeout: async () => { throw new Error('must not be called'); } }
    );
    assert.equal(notDue.ok, true);
    assert.equal(notDue.refreshed, false);
    assert.equal(notDue.reason, 'not_due');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('refreshKimiAccessToken updates the runtime account after a successful refresh', async () => {
  const { aiHomeDir, accountRef } = setupKimiAccount({
    credentials: {
      access_token: 'expired-runtime-token',
      refresh_token: 'rt-runtime-old',
      expires_at: Math.floor(Date.now() / 1000) - 10,
      token_type: 'Bearer'
    }
  });
  const account = {
    accountRef,
    provider: 'kimi',
    accessToken: 'expired-runtime-token',
    refreshToken: 'rt-runtime-old',
    tokenExpiresAt: Date.now() - 10_000,
    tokenType: 'Bearer'
  };
  try {
    const result = await refreshKimiAccessToken(account, {}, {
      fs,
      aiHomeDir,
      fetchWithTimeout: async () => makeOkResponse({
        access_token: 'fresh-runtime-token',
        refresh_token: 'rt-runtime-new',
        expires_in: 900,
        token_type: 'Bearer'
      })
    });

    assert.equal(result.ok, true);
    assert.equal(result.refreshed, true);
    assert.equal(account.accessToken, 'fresh-runtime-token');
    assert.equal(account.refreshToken, 'rt-runtime-new');
    assert.equal(account.tokenType, 'Bearer');
    assert.ok(account.tokenExpiresAt > Date.now());
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('refreshKimiAccessToken reloads a valid persisted token into a stale runtime account', async () => {
  const persistedExpirySeconds = Math.floor(Date.now() / 1000) + 3600;
  const { aiHomeDir, accountRef } = setupKimiAccount({
    credentials: {
      access_token: 'persisted-fresh-token',
      refresh_token: 'persisted-refresh-token',
      expires_at: persistedExpirySeconds,
      token_type: 'Bearer'
    }
  });
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
    deviceId: 'persisted-fresh-device',
    credentials: {
      access_token: 'persisted-fresh-token',
      refresh_token: 'persisted-refresh-token',
      expires_at: persistedExpirySeconds,
      token_type: 'Bearer'
    }
  });
  const runtimeAccount = {
    accountRef,
    provider: 'kimi',
    accessToken: 'stale-runtime-token',
    refreshToken: 'stale-runtime-refresh',
    tokenExpiresAt: Date.now() - 10_000,
    deviceId: 'stale-runtime-device'
  };
  let fetchCalls = 0;
  try {
    const result = await refreshKimiAccessToken(runtimeAccount, {}, {
      fs,
      aiHomeDir,
      fetchWithTimeout: async () => {
        fetchCalls += 1;
        throw new Error('refresh must not run for a valid persisted token');
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.refreshed, false);
    assert.equal(result.reason, 'not_due');
    assert.equal(fetchCalls, 0);
    assert.equal(runtimeAccount.accessToken, 'persisted-fresh-token');
    assert.equal(runtimeAccount.refreshToken, 'persisted-refresh-token');
    assert.equal(runtimeAccount.tokenExpiresAt, persistedExpirySeconds * 1000);
    assert.equal(runtimeAccount.deviceId, 'persisted-fresh-device');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('refreshKimiAccessToken singleflights concurrent callers by accountRef across runtime objects', async () => {
  const { aiHomeDir, accountRef } = setupKimiAccount({
    credentials: {
      access_token: 'expired-shared-token',
      refresh_token: 'rt-shared-old',
      expires_at: Math.floor(Date.now() / 1000) - 10
    }
  });
  const gatewayAccount = {
    accountRef,
    provider: 'kimi',
    accessToken: 'expired-shared-token',
    refreshToken: 'rt-shared-old'
  };
  const quotaAccount = {
    accountRef,
    provider: 'kimi',
    accessToken: 'expired-shared-token',
    refreshToken: 'rt-shared-old'
  };
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  let refreshCalls = 0;
  const fetchWithTimeout = async () => {
    refreshCalls += 1;
    await refreshGate;
    return makeOkResponse({
      access_token: 'fresh-shared-token',
      refresh_token: 'rt-shared-new',
      expires_in: 900
    });
  };

  try {
    const gatewayRefresh = refreshKimiAccessToken(
      gatewayAccount,
      { force: true },
      { fs, aiHomeDir, fetchWithTimeout }
    );
    const quotaRefresh = refreshKimiAccessToken(
      quotaAccount,
      { force: true },
      { fs, aiHomeDir, fetchWithTimeout }
    );
    await Promise.resolve();
    const callsBeforeRelease = refreshCalls;
    releaseRefresh();
    const [gatewayResult, quotaResult] = await Promise.all([gatewayRefresh, quotaRefresh]);

    assert.equal(callsBeforeRelease, 1);
    assert.equal(refreshCalls, 1);
    assert.equal(gatewayResult.accessToken, 'fresh-shared-token');
    assert.equal(quotaResult.accessToken, 'fresh-shared-token');
    assert.equal(gatewayAccount.accessToken, 'fresh-shared-token');
    assert.equal(quotaAccount.accessToken, 'fresh-shared-token');
  } finally {
    releaseRefresh();
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('refreshKimiAccessToken does not overwrite credentials replaced while refresh is in flight', async () => {
  const { aiHomeDir, accountRef } = setupKimiAccount({
    credentials: {
      access_token: 'old-login-access',
      refresh_token: 'old-login-refresh',
      expires_at: Math.floor(Date.now() / 1000) - 10
    }
  });
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
    deviceId: 'old-device',
    credentials: {
      access_token: 'old-login-access',
      refresh_token: 'old-login-refresh',
      expires_at: Math.floor(Date.now() / 1000) - 10
    }
  });
  const runtimeAccount = {
    accountRef,
    provider: 'kimi',
    deviceId: 'old-device',
    accessToken: 'old-login-access',
    refreshToken: 'old-login-refresh'
  };
  let markRequestStarted;
  const requestStarted = new Promise((resolve) => { markRequestStarted = resolve; });
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  const hookEvents = [];

  try {
    const refreshPromise = refreshKimiAccessToken(runtimeAccount, { force: true }, {
      fs,
      aiHomeDir,
      accountArtifactHooks: {
        notifyDefaultAccountAuthUpdated: (event) => hookEvents.push(event)
      },
      fetchWithTimeout: async () => {
        markRequestStarted();
        await refreshGate;
        return makeOkResponse({
          access_token: 'stale-refresh-access',
          refresh_token: 'stale-refresh-token',
          expires_in: 900
        });
      }
    });
    await requestStarted;

    writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
      deviceId: 'new-device',
      credentials: {
        access_token: 'new-login-access',
        refresh_token: 'new-login-refresh',
        expires_at: Math.floor(Date.now() / 1000) + 900
      }
    });
    releaseRefresh();
    const result = await refreshPromise;
    const persisted = readAccountNativeAuth(fs, aiHomeDir, accountRef);

    assert.equal(result.ok, false);
    assert.equal(result.refreshed, false);
    assert.equal(result.reason, 'stale_credentials');
    assert.equal(persisted.deviceId, 'new-device');
    assert.equal(persisted.credentials.access_token, 'new-login-access');
    assert.equal(persisted.credentials.refresh_token, 'new-login-refresh');
    assert.equal(runtimeAccount.accessToken, 'old-login-access');
    assert.equal(runtimeAccount.refreshToken, 'old-login-refresh');
    assert.deepEqual(hookEvents, []);
  } finally {
    releaseRefresh();
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('refreshKimiAccessToken retries CAS once when only unrelated native auth fields changed', async () => {
  const { aiHomeDir, accountRef } = setupKimiAccount();
  const originalCredentials = {
    access_token: 'cas-retry-old-access',
    refresh_token: 'cas-retry-same-refresh',
    expires_at: Math.floor(Date.now() / 1000) - 10
  };
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
    deviceId: 'cas-retry-device',
    metadata: { label: 'before' },
    credentials: originalCredentials
  });
  const runtimeAccount = {
    accountRef,
    provider: 'kimi',
    deviceId: 'cas-retry-device',
    accessToken: 'cas-retry-old-access',
    refreshToken: 'cas-retry-same-refresh'
  };
  let markRequestStarted;
  const requestStarted = new Promise((resolve) => { markRequestStarted = resolve; });
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });

  try {
    const refreshPromise = refreshKimiAccessToken(runtimeAccount, { force: true }, {
      fs,
      aiHomeDir,
      fetchWithTimeout: async () => {
        markRequestStarted();
        await refreshGate;
        return makeOkResponse({
          access_token: 'cas-retry-new-access',
          refresh_token: 'cas-retry-rotated-refresh',
          expires_in: 900
        });
      }
    });
    await requestStarted;

    writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
      deviceId: 'cas-retry-device',
      metadata: { label: 'updated-concurrently' },
      credentials: originalCredentials
    });
    releaseRefresh();
    const result = await refreshPromise;
    const persisted = readAccountNativeAuth(fs, aiHomeDir, accountRef);

    assert.equal(result.ok, true);
    assert.equal(result.refreshed, true);
    assert.deepEqual(persisted.metadata, { label: 'updated-concurrently' });
    assert.equal(persisted.credentials.access_token, 'cas-retry-new-access');
    assert.equal(persisted.credentials.refresh_token, 'cas-retry-rotated-refresh');
    assert.equal(runtimeAccount.accessToken, 'cas-retry-new-access');
    assert.equal(runtimeAccount.refreshToken, 'cas-retry-rotated-refresh');
  } finally {
    releaseRefresh();
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('refreshKimiAccessToken forwards proxy, device headers, and timeout to the token request', async () => {
  const { aiHomeDir, accountRef } = setupKimiAccount({
    credentials: {
      access_token: 'expired-transport-token',
      refresh_token: 'rt-transport',
      expires_at: Math.floor(Date.now() / 1000) - 10
    }
  });
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
    deviceId: 'device-transport-123',
    credentials: {
      access_token: 'expired-transport-token',
      refresh_token: 'rt-transport',
      expires_at: Math.floor(Date.now() / 1000) - 10
    }
  });
  let request = null;
  try {
    const result = await refreshKimiAccessToken(
      { accountRef, provider: 'kimi', accessToken: 'expired-transport-token' },
      {
        force: true,
        timeoutMs: 4321,
        proxyUrl: 'http://127.0.0.1:7890',
        noProxy: 'auth.internal'
      },
      {
        fs,
        aiHomeDir,
        fetchWithTimeout: async (url, init, timeoutMs, proxyOptions) => {
          request = { url, init, timeoutMs, proxyOptions };
          return makeOkResponse({
            access_token: 'fresh-transport-token',
            refresh_token: 'rt-transport-new',
            expires_in: 900
          });
        }
      }
    );

    assert.equal(result.ok, true);
    assert.equal(request.timeoutMs, 4321);
    assert.deepEqual(request.proxyOptions, {
      proxyUrl: 'http://127.0.0.1:7890',
      noProxy: 'auth.internal'
    });
    assert.equal(request.init.headers['X-Msh-Device-Id'], 'device-transport-123');
    assert.equal(request.init.headers['X-Msh-Platform'], 'kimi_code_cli');
    assert.match(request.init.headers['User-Agent'], /^kimi-code-cli\//u);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('refreshKimiAccessToken prefers the runtime device id before deriving a new one', async () => {
  const { aiHomeDir, accountRef } = setupKimiAccount({
    credentials: {
      access_token: 'expired-runtime-device-token',
      refresh_token: 'runtime-device-refresh',
      expires_at: Math.floor(Date.now() / 1000) - 10
    }
  });
  let refreshDeviceId = '';
  try {
    const result = await refreshKimiAccessToken({
      accountRef,
      provider: 'kimi',
      deviceId: 'runtime-device-stable'
    }, { force: true }, {
      fs,
      aiHomeDir,
      fetchWithTimeout: async (_url, init) => {
        refreshDeviceId = String(init.headers['X-Msh-Device-Id'] || '');
        return makeOkResponse({
          access_token: 'fresh-runtime-device-token',
          refresh_token: 'runtime-device-refresh-v2',
          expires_in: 900
        });
      }
    });

    assert.equal(result.ok, true);
    assert.equal(refreshDeviceId, 'runtime-device-stable');
    assert.equal(
      readAccountNativeAuth(fs, aiHomeDir, accountRef).deviceId,
      'runtime-device-stable'
    );
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('refreshKimiAccessToken prefers the selected token device claim over stale top-level state', async () => {
  const selectedDeviceId = 'selected-token-device';
  const { aiHomeDir, accountRef } = setupKimiAccount({
    credentials: {
      access_token: makeJwt({
        exp: Math.floor(Date.now() / 1000) - 60,
        device_id: selectedDeviceId
      }),
      refresh_token: 'selected-device-refresh',
      expires_at: Math.floor(Date.now() / 1000) - 60
    }
  });
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
    credentials: readAccountNativeAuth(fs, aiHomeDir, accountRef).credentials,
    deviceId: 'stale-top-level-device'
  });
  let refreshDeviceId = '';
  try {
    const result = await refreshKimiAccessToken(
      { accountRef, provider: 'kimi', deviceId: 'stale-runtime-device' },
      { force: true },
      {
        fs,
        aiHomeDir,
        fetchWithTimeout: async (_url, init) => {
          refreshDeviceId = String(init.headers['X-Msh-Device-Id'] || '');
          return makeOkResponse({
            access_token: 'fresh-selected-device-token',
            refresh_token: 'selected-device-refresh-v2',
            expires_in: 900
          });
        }
      }
    );

    assert.equal(result.ok, true);
    assert.equal(refreshDeviceId, selectedDeviceId);
    assert.equal(result.deviceId, selectedDeviceId);
    assert.equal(readAccountNativeAuth(fs, aiHomeDir, accountRef).deviceId, selectedDeviceId);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('refreshKimiAccessToken migrates legacy auth refresh-only credentials to canonical credentials', async () => {
  const { aiHomeDir, accountRef } = setupKimiAccount();
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
    deviceId: 'legacy-device',
    credentials: {},
    auth: {
      refresh_token: 'legacy-refresh-only',
      token_type: 'Bearer'
    }
  });
  const runtimeAccount = {
    accountRef,
    provider: 'kimi',
    accessToken: '',
    refreshToken: 'legacy-refresh-only',
    deviceId: 'legacy-device'
  };
  let refreshBody = '';
  try {
    const result = await refreshKimiAccessToken(runtimeAccount, { force: true }, {
      fs,
      aiHomeDir,
      fetchWithTimeout: async (_url, init) => {
        refreshBody = String(init && init.body || '');
        return makeOkResponse({
          access_token: 'legacy-migrated-access',
          refresh_token: 'legacy-migrated-refresh',
          expires_in: 900,
          token_type: 'Bearer'
        });
      }
    });
    const persisted = readAccountNativeAuth(fs, aiHomeDir, accountRef);

    assert.equal(result.ok, true);
    assert.equal(result.refreshed, true);
    assert.match(refreshBody, /refresh_token=legacy-refresh-only/u);
    assert.equal(persisted.auth, undefined);
    assert.equal(persisted.credentials.access_token, 'legacy-migrated-access');
    assert.equal(persisted.credentials.refresh_token, 'legacy-migrated-refresh');
    assert.equal(runtimeAccount.accessToken, 'legacy-migrated-access');
    assert.equal(runtimeAccount.refreshToken, 'legacy-migrated-refresh');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('refreshKimiAccessToken maps invalid_grant to refresh_unauthorized', async () => {
  const { aiHomeDir, accountRef } = setupKimiAccount({
    credentials: { access_token: 'expired', refresh_token: 'rt-dead', expires_at: 1 }
  });
  const hookEvents = [];
  try {
    const result = await refreshKimiAccessToken(
      { accountRef, provider: 'kimi' },
      {},
      {
        fs,
        aiHomeDir,
        accountArtifactHooks: {
          notifyDefaultAccountAuthUpdated: (event) => hookEvents.push(event)
        },
        fetchWithTimeout: async () => makeOkResponse({ error: 'invalid_grant' }, 400)
      }
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'refresh_unauthorized');
    assert.deepEqual(hookEvents, []);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('refreshKimiAccessToken does not carry refresh throttling across credential generations', async () => {
  const nowMs = Date.now();
  const { aiHomeDir, accountRef } = setupKimiAccount({
    credentials: {
      access_token: 'generation-one-expired',
      refresh_token: 'generation-one-refresh',
      expires_at: Math.floor(nowMs / 1000) - 10
    }
  });
  let refreshCalls = 0;
  try {
    const firstResult = await refreshKimiAccessToken(
      { accountRef, provider: 'kimi' },
      { nowMs, minAttemptIntervalMs: 30_000 },
      {
        fs,
        aiHomeDir,
        fetchWithTimeout: async () => {
          refreshCalls += 1;
          return makeOkResponse({ error: 'invalid_grant' }, 400);
        }
      }
    );
    assert.equal(firstResult.reason, 'refresh_unauthorized');

    writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
      credentials: {
        access_token: 'generation-two-expired',
        refresh_token: 'generation-two-refresh',
        expires_at: Math.floor(nowMs / 1000) - 5
      }
    });
    const secondResult = await refreshKimiAccessToken(
      { accountRef, provider: 'kimi' },
      { nowMs: nowMs + 1, minAttemptIntervalMs: 30_000 },
      {
        fs,
        aiHomeDir,
        fetchWithTimeout: async () => {
          refreshCalls += 1;
          return makeOkResponse({
            access_token: 'generation-two-fresh',
            refresh_token: 'generation-two-rotated',
            expires_in: 900
          });
        }
      }
    );

    assert.equal(refreshCalls, 2);
    assert.equal(secondResult.ok, true);
    assert.equal(secondResult.accessToken, 'generation-two-fresh');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('resolveKimiTokenExpiryMs falls back to JWT exp when expires_at is missing', () => {
  const expSec = 1_900_000_000;
  const token = makeJwt({ exp: expSec });
  assert.equal(refreshPrivate.resolveKimiTokenExpiryMs({ access_token: token }), expSec * 1000);
  assert.equal(
    refreshPrivate.resolveKimiTokenExpiryMs({ expires_at: 0, expiresAt: expSec }),
    expSec * 1000
  );
  assert.equal(
    refreshPrivate.resolveKimiTokenExpiryMs({ access_token: token, expires_at: 1_800_000_000 }),
    1_800_000_000 * 1000
  );
});

test('normalizeAccountUsageSnapshot passes kimi entries through to the WebUI view', () => {
  const { normalizeAccountUsageSnapshot } = require('../lib/server/account-usage-view');
  const normalized = normalizeAccountUsageSnapshot({
    kind: 'kimi_oauth_usage',
    capturedAt: 123,
    entries: [{ bucket: 'weekly', windowMinutes: 10080, window: '7days', remainingPct: 96.4, resetIn: '6d21h', resetAtMs: 456 }]
  });
  assert.equal(normalized.kind, 'kimi_oauth_usage');
  assert.equal(normalized.entries.length, 1);
  assert.equal(normalized.entries[0].remainingPct, 96.4);
  assert.equal(normalized.entries[0].window, '7days');
});

test('kimi probe attaches nickname, masked phone, and membership level to the snapshot account', () => {
  const { aiHomeDir, accountRef } = setupKimiAccount({
    credentials: {
      access_token: 'still-valid-token',
      refresh_token: 'rt',
      expires_at: Math.floor(Date.now() / 1000) + 3600
    }
  });
  const probe = createKimiQuotaProbe({
    fs,
    aiHomeDir,
    readAccountCredentialRecord: require('../lib/server/account-credential-store').readAccountCredentialRecord,
    fetchWithTimeout: async (url) => {
      if (url.endsWith('/me')) {
        return makeOkResponse({
          nickname: '登月者2115',
          phone: { country_code: '86', number: '186****2115' },
          user_level: 25,
          user_level_name: 'Allegretto'
        });
      }
      return makeOkResponse({
        usage: { used: 24, limit: 100 },
        user: { membership: { level: 'LEVEL_INTERMEDIATE' } }
      });
    }
  });
  return probe.probe(accountRef, 5000).then((result) => {
    assert.ok(result.snapshot, 'expected snapshot');
    assert.deepEqual(result.snapshot.account, {
      displayName: '登月者2115',
      phone: '+86 186****2115',
      planName: 'Allegretto',
      planLevel: 25,
      planType: 'intermediate'
    });
  }).finally(() => {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });
});

test('kimi probe keeps the quota snapshot when /me fails (best-effort identity)', async () => {
  const { aiHomeDir, accountRef } = setupKimiAccount({
    credentials: {
      access_token: 'still-valid-token',
      refresh_token: 'rt',
      expires_at: Math.floor(Date.now() / 1000) + 3600
    }
  });
  const probe = createKimiQuotaProbe({
    fs,
    aiHomeDir,
    readAccountCredentialRecord: require('../lib/server/account-credential-store').readAccountCredentialRecord,
    fetchWithTimeout: async (url) => {
      if (url.endsWith('/me')) throw new Error('network down');
      return makeOkResponse({ usage: { used: 24, limit: 100 } });
    }
  });
  try {
    const result = await probe.probe(accountRef, 5000);
    assert.ok(result.snapshot, 'quota snapshot must survive /me failure');
    assert.equal(result.snapshot.entries[0].remainingPct, 76);
    assert.equal(result.snapshot.account, undefined);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});
