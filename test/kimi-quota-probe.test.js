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

test('kimi quota probe refreshes an expired access token before probing', async () => {
  const { aiHomeDir, accountRef } = setupKimiAccount({
    credentials: {
      access_token: 'expired-token',
      refresh_token: 'rt-old',
      expires_at: Math.floor(Date.now() / 1000) - 60
    }
  });
  const calls = [];
  const probe = createKimiQuotaProbe({
    fs,
    aiHomeDir,
    readAccountCredentialRecord: require('../lib/server/account-credential-store').readAccountCredentialRecord,
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
  try {
    const refreshed = await refreshKimiAccessToken(account, {}, { fs, aiHomeDir, fetchWithTimeout });
    assert.equal(refreshed.ok, true);
    assert.equal(refreshed.refreshed, true);
    const persisted = readAccountNativeAuth(fs, aiHomeDir, accountRef).credentials;
    assert.equal(persisted.access_token, 'at-2');
    assert.equal(persisted.refresh_token, 'rt-2');
    assert.ok(persisted.expires_at > Math.floor(Date.now() / 1000));

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

test('refreshKimiAccessToken maps invalid_grant to refresh_unauthorized', async () => {
  const { aiHomeDir, accountRef } = setupKimiAccount({
    credentials: { access_token: 'expired', refresh_token: 'rt-dead', expires_at: 1 }
  });
  try {
    const result = await refreshKimiAccessToken(
      { accountRef, provider: 'kimi' },
      {},
      {
        fs,
        aiHomeDir,
        fetchWithTimeout: async () => makeOkResponse({ error: 'invalid_grant' }, 400)
      }
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'refresh_unauthorized');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('resolveKimiTokenExpiryMs falls back to JWT exp when expires_at is missing', () => {
  const expSec = 1_900_000_000;
  const token = makeJwt({ exp: expSec });
  assert.equal(refreshPrivate.resolveKimiTokenExpiryMs({ access_token: token }), expSec * 1000);
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
          phone: { country_code: '86', number: '186****2115' }
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
