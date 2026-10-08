'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createGrokQuotaProbe,
  parseGrokBillingPayload
} = require('../lib/cli/services/usage/grok-quota-probe');
const { GROK_BILLING_URL, GROK_BILLING_LEGACY_URL, GROK_USER_URL, GROK_BILLING_GRPC_URL } = require('../lib/account/grok-endpoints');
const {
  USAGE_SNAPSHOT_KINDS,
  USAGE_SOURCE_GROK,
  getMinRemainingPctFromUsageSnapshot
} = require('../lib/account/usage-remaining');

test('Grok billing parser keeps the real billing period when upstream omits a percentage', () => {
  const snapshot = parseGrokBillingPayload({
    config: {
      currentPeriod: {
        start: '2030-01-01T00:00:00Z',
        end: '2030-01-08T00:00:00Z'
      },
      onDemandCap: 0,
      onDemandUsed: 0,
      prepaidBalance: 0
    }
  }, 1_700_000_000_000, { email: 'user@example.com', subscriptionTier: 'Free' });

  assert.equal(snapshot.kind, USAGE_SNAPSHOT_KINDS.grok);
  assert.equal(snapshot.source, USAGE_SOURCE_GROK);
  assert.equal(snapshot.account.planType, 'free');
  assert.equal(snapshot.account.planName, 'Free');
  assert.equal(snapshot.account.email, 'user@example.com');
  assert.equal(snapshot.entries[0].windowMinutes, 10_080);
  assert.equal(snapshot.entries[0].remainingPct, null);
  assert.equal(snapshot.entries[0].resetAtMs, Date.parse('2030-01-08T00:00:00Z'));
  assert.equal(getMinRemainingPctFromUsageSnapshot(snapshot), null);
});

test('Grok billing parser converts an explicit credit usage percentage to remaining percentage', () => {
  const snapshot = parseGrokBillingPayload({
    config: {
      currentPeriod: {
        start: '2030-01-01T00:00:00Z',
        end: '2030-01-08T00:00:00Z'
      },
      creditUsagePercent: 37.5
    }
  }, 1_700_000_000_000);

  assert.equal(snapshot.entries[0].remainingPct, 62.5);
});

test('Grok legacy included-credit bills use measured usage and a positive included limit', () => {
  const config = { billingPeriodStart: '2030-01-01T00:00:00Z', billingPeriodEnd: '2030-02-01T00:00:00Z' };
  for (const [used, expected] of [[0, 100], [4277, 100 - 4277 / 60000 * 100], [60000, 0], [70000, 0]]) {
    const snapshot = parseGrokBillingPayload({ config: { ...config, monthlyLimit: { val: 60000 }, used: { val: used } } }, 1000);
    assert.equal(snapshot.entries[0].remainingPct, expected);
    assert.equal(snapshot.entries[0].windowMinutes, 44640);
  }
  for (const invalid of [undefined, null, 0, -1, false, '', 'invalid']) {
    const snapshot = parseGrokBillingPayload({ config: {
      ...config, monthlyLimit: { val: invalid }, used: { val: 38 },
      onDemandCap: { val: 100 }, prepaidBalance: { val: 1000 }
    } }, 1000);
    assert.equal(snapshot.entries[0].remainingPct, null, String(invalid));
  }
  for (const invalid of [undefined, null, false, '', [], {}, 'invalid', -1]) {
    assert.equal(parseGrokBillingPayload({ config: {
      ...config, monthlyLimit: { val: 60000 }, used: { val: invalid }
    } }, 1000).entries[0].remainingPct, null);
  }
  assert.equal(parseGrokBillingPayload({ config: {
    ...config, creditUsagePercent: 60, monthlyLimit: { val: 100 }, used: { val: 25 }
  } }, 1000).entries[0].remainingPct, 40);
});

test('Grok quota probe excludes API-key accounts from OAuth billing requests', async () => {
  let fetchCalls = 0;
  const probe = createGrokQuotaProbe({
    fs: {},
    aiHomeDir: '/tmp/aih-test',
    readAccountCredentialRecord: () => ({
      provider: 'grok',
      env: { XAI_API_KEY: 'test-key' },
      nativeAuth: { auth: {} }
    }),
    fetchWithTimeout: async () => {
      fetchCalls += 1;
      throw new Error('API-key accounts must not use OAuth billing');
    }
  });

  const result = await probe.probe('acct_0123456789abcdef0123', 1_000);
  assert.equal(result.error, 'api_key_mode_not_applicable');
  assert.equal(fetchCalls, 0);
});

const PERIOD_PAYLOAD = { config: { currentPeriod: {
  start: '2030-01-01T00:00:00Z', end: '2030-01-08T00:00:00Z'
} } };
const ACCOUNT_REF = 'acct_0123456789abcdef0123';

function probeFixture(overrides = {}) {
  const record = { provider: 'grok', env: {}, nativeAuth: { auth: {
    key: 'access-token', refresh_token: 'refresh-token', email: 'user@example.com'
  } } };
  const calls = [];
  const egress = { proxyUrl: 'http://account-proxy', noProxy: 'localhost' };
  const nowMs = 1_700_000_000_000;
  const service = createGrokQuotaProbe({
    fs: {}, aiHomeDir: '/tmp/aih-test', now: () => nowMs, usageSnapshotSchemaVersion: 1,
    readAccountCredentialRecord: () => record,
    resolveAccountEgressRequestOptions: async (input) => {
      assert.equal(input.accountRef, ACCOUNT_REF);
      assert.equal(input.provider, 'grok');
      return { ok: true, options: egress };
    },
    fetchWithTimeout: async (url, init, timeoutMs, options) => {
      calls.push({ url, init, timeoutMs, options });
      if (url === GROK_BILLING_GRPC_URL) return { ok: false, status: 503 };
      return { ok: true, status: 200, json: async () => url === GROK_BILLING_URL
        ? PERIOD_PAYLOAD : { email: 'user@example.com', subscriptionTier: null } };
    },
    ...overrides
  });
  return { service, record, calls, egress, nowMs };
}

test('Grok OAuth billing probe uses account egress and keeps an omitted subscription unknown', async () => {
  const f = probeFixture();
  const result = await f.service.probe(ACCOUNT_REF, 5_000);
  assert.equal(result.snapshot.entries[0].remainingPct, null);
  assert.equal(result.snapshot.account.planName, '');
  assert.equal(result.snapshot.schemaVersion, 1);
  assert.deepEqual(f.calls.map((call) => call.url), [GROK_BILLING_URL, GROK_USER_URL, GROK_BILLING_GRPC_URL, GROK_BILLING_LEGACY_URL]);
  for (const call of f.calls) {
    assert.deepEqual(call.options, f.egress);
    assert.equal(call.init.headers.Authorization, 'Bearer access-token');
  }
});

test('Grok billing probe retains quota if identity lookup fails and rejects changed credentials', async () => {
  const f = probeFixture({ fetchWithTimeout: async (url) => {
    if (url === GROK_USER_URL) throw new Error('identity unavailable');
    return { ok: true, status: 200, json: async () => PERIOD_PAYLOAD };
  } });
  assert.equal((await f.service.probe(ACCOUNT_REF)).snapshot.entries[0].remainingPct, null);
  let reads = 0;
  const changed = probeFixture({ readAccountCredentialRecord: () => {
    reads += 1;
    return reads === 1 ? f.record : { ...f.record, nativeAuth: { auth: { key: 'different-token' } } };
  } });
  assert.equal((await changed.service.probe(ACCOUNT_REF)).error, 'credential_changed_during_probe');
});

test('Grok billing probe refreshes once on 401 and retries with the persisted token', async () => {
  let refreshes = 0;
  let billingCalls = 0;
  const f = probeFixture({
    refreshGrokAccessToken: async (account, options) => {
      refreshes += 1;
      assert.equal(options.force, true);
      account.accessToken = 'refreshed-token';
      f.record.nativeAuth.auth.key = account.accessToken;
      return { ok: true, persisted: true };
    },
    fetchWithTimeout: async (url, init) => {
      if (url === GROK_BILLING_URL && ++billingCalls === 1) return { ok: false, status: 401 };
      assert.equal(init.headers.Authorization, 'Bearer refreshed-token');
      return { ok: true, status: 200, json: async () => url === GROK_BILLING_URL ? PERIOD_PAYLOAD : {} };
    }
  });
  assert.ok((await f.service.probe(ACCOUNT_REF)).snapshot);
  assert.equal(refreshes, 1);
  assert.equal(billingCalls, 2);
});

test('Grok billing probe does not refresh twice if a pre-refreshed expired token still gets 401', async () => {
  let refreshes = 0;
  const f = probeFixture({
    refreshGrokAccessToken: async (account) => {
      refreshes += 1;
      account.accessToken = 'refreshed-token';
      f.record.nativeAuth.auth.key = account.accessToken;
      return { ok: true };
    },
    fetchWithTimeout: async () => ({ ok: false, status: 401 })
  });
  f.record.nativeAuth.auth.expires_at = new Date(f.nowMs - 1_000).toISOString();
  const result = await f.service.probe(ACCOUNT_REF);
  assert.equal(result.error, 'grok_billing_http_401');
  assert.equal(result.auth, true);
  assert.equal(refreshes, 1);
});

test('Grok fills a period-only REST quota from the same OAuth account gRPC bill', async () => {
  const nowMs = Date.parse('2026-10-07T00:00:00Z');
  // 当前真实 gRPC 响应：有效 weekly 周期，proto3 的 credit_usage_percent 缺省为零。
  const responseBytes = Buffer.from('AAAAADAKLhIAGgAiBgiAxfbVBioGCIC6m9YGQhIIAhIGCIDF9tUGGgYIgLqb1gZYAWIAaAGAAAAAD2dycGMtc3RhdHVzOjANCg==', 'base64');
  const f = probeFixture({
    now: () => nowMs,
    fetchWithTimeout: async (url, init, timeoutMs, options) => {
      f.calls.push({ url, init, timeoutMs, options });
      if (url === GROK_BILLING_GRPC_URL) return {
        ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => responseBytes
      };
      return { ok: true, status: 200, json: async () => url === GROK_BILLING_URL ? PERIOD_PAYLOAD : {} };
    }
  });
  const result = await f.service.probe(ACCOUNT_REF, 8000);
  assert.equal(result.snapshot.entries[0].remainingPct, 100);
  assert.equal(result.snapshot.entries[0].resetAtMs, Date.parse('2026-10-08T00:00:00Z'),
    'the numeric gRPC bill must retain its own period rather than a stale REST period');
  const request = f.calls.find((call) => call.url === GROK_BILLING_GRPC_URL);
  assert.equal(request.init.headers.Authorization, 'Bearer access-token');
  assert.equal(request.init.headers['Content-Type'], 'application/grpc-web+proto');
  assert.equal(request.init.body.toString('hex'), '00000000020800');
  assert.equal(request.timeoutMs, 6000);
  assert.deepEqual(request.options, f.egress);
});

test('Grok still checks supplementary billing when REST returns no usable period or percentage', async () => {
  const responseBytes = Buffer.from('AAAAADAKLhIAGgAiBgiAxfbVBioGCIC6m9YGQhIIAhIGCIDF9tUGGgYIgLqb1gZYAWIAaAGAAAAAD2dycGMtc3RhdHVzOjANCg==', 'base64');
  const f = probeFixture({
    now: () => Date.parse('2026-10-07T00:00:00Z'),
    fetchWithTimeout: async (url) => url === GROK_BILLING_GRPC_URL
      ? { ok: true, status: 200, arrayBuffer: async () => responseBytes }
      : { ok: true, status: 200, json: async () => ({}) }
  });
  const result = await f.service.probe(ACCOUNT_REF);
  assert.equal(result.snapshot.entries[0].remainingPct, 100);
  assert.equal(result.snapshot.entries[0].resetAtMs, Date.parse('2026-10-08T00:00:00Z'));
  assert.equal(result.snapshot.entries[0].windowMinutes, 10080);
  assert.equal(result.snapshot.account.email, 'user@example.com');
});

test('Grok still reads the independent gRPC bill when primary billing times out or is unavailable', async () => {
  const responseBytes = Buffer.from('AAAAADAKLhIAGgAiBgiAxfbVBioGCIC6m9YGQhIIAhIGCIDF9tUGGgYIgLqb1gZYAWIAaAGAAAAAD2dycGMtc3RhdHVzOjANCg==', 'base64');
  for (const failure of ['timeout', 408, 500, 503]) {
    const f = probeFixture({
      now: () => Date.parse('2026-10-07T00:00:00Z'),
      fetchWithTimeout: async (url, init, timeoutMs, options) => {
        f.calls.push({ url, init, timeoutMs, options });
        if (url === GROK_BILLING_URL) {
          if (failure === 'timeout') throw new Error('timeout');
          return { ok: false, status: failure };
        }
        if (url === GROK_BILLING_GRPC_URL) return {
          ok: true, status: 200, arrayBuffer: async () => responseBytes
        };
        return { ok: true, status: 200, json: async () => ({}) };
      }
    });
    const result = await f.service.probe(ACCOUNT_REF);
    assert.equal(result.snapshot.entries[0].remainingPct, 100, String(failure));
    assert.equal(result.snapshot.entries[0].resetAtMs, Date.parse('2026-10-08T00:00:00Z'));
    assert.equal(result.auth, undefined);
    assert.deepEqual(f.calls.map(call => call.url), [GROK_BILLING_URL, GROK_USER_URL, GROK_BILLING_GRPC_URL]);
    assert.ok(f.calls.every(call => call.options === f.egress));
  }
});

test('Grok falls back to legacy billing after unavailable REST and gRPC services', async () => {
  const f = probeFixture({ fetchWithTimeout: async (url) => {
    if (url === GROK_BILLING_URL) throw new Error('timeout');
    if (url === GROK_BILLING_GRPC_URL) return { ok: false, status: 503 };
    return { ok: true, status: 200, json: async () => url === GROK_BILLING_LEGACY_URL ? {
      config: { monthlyLimit: { val: 100 }, used: { val: 25 },
        billingPeriodStart: '2030-01-01T00:00:00Z', billingPeriodEnd: '2030-02-01T00:00:00Z' }
    } : {} };
  } });
  const result = await f.service.probe(ACCOUNT_REF);
  assert.equal(result.snapshot.entries[0].remainingPct, 75);
  assert.equal(result.snapshot.entries[0].resetAtMs, Date.parse('2030-02-01T00:00:00Z'));
});

test('Grok preserves the primary failure when every billing source is unavailable', async () => {
  for (const failure of ['timeout', 503]) {
    const f = probeFixture({ fetchWithTimeout: async (url) => {
      if (url === GROK_BILLING_URL && failure !== 'timeout') return { ok: false, status: failure };
      throw new Error('unavailable');
    } });
    const result = await f.service.probe(ACCOUNT_REF);
    assert.equal(result.error, failure === 'timeout' ? 'grok_billing_probe_failed' : 'grok_billing_http_503');
    assert.equal(result.snapshot, undefined);
    assert.equal(result.auth, undefined);
  }
});

test('Grok does not continue to other billing endpoints after a primary denial or rate limit', async () => {
  for (const status of [403, 429]) {
    const calls = [];
    const f = probeFixture({ fetchWithTimeout: async (url) => {
      calls.push(url);
      return { ok: false, status };
    } });
    assert.equal((await f.service.probe(ACCOUNT_REF)).error, `grok_billing_http_${status}`);
    assert.deepEqual(calls, [GROK_BILLING_URL]);
  }
});

test('Grok skips supplementary billing when REST already reports numeric quota', async () => {
  const calls = [];
  const f = probeFixture({ fetchWithTimeout: async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => url === GROK_BILLING_URL
      ? { config: { ...PERIOD_PAYLOAD.config, creditUsagePercent: 37.5 } } : {} };
  } });
  assert.equal((await f.service.probe(ACCOUNT_REF)).snapshot.entries[0].remainingPct, 62.5);
  assert.deepEqual(calls, [GROK_BILLING_URL, GROK_USER_URL]);
});

test('a numeric legacy Grok bill replaces an unavailable credits window with its own monthly period', async () => {
  const f = probeFixture({ fetchWithTimeout: async (url, init, timeoutMs, options) => {
    f.calls.push({ url, init, timeoutMs, options });
    if (url === GROK_BILLING_GRPC_URL) return { ok: false, status: 503 };
    return { ok: true, status: 200, json: async () => url === GROK_BILLING_LEGACY_URL ? {
      config: { monthlyLimit: { val: 100 }, used: { val: 25 },
        billingPeriodStart: '2030-01-01T00:00:00Z', billingPeriodEnd: '2030-02-01T00:00:00Z' }
    } : url === GROK_BILLING_URL ? PERIOD_PAYLOAD : {} };
  } });
  const result = await f.service.probe(ACCOUNT_REF, 8000);
  assert.equal(result.snapshot.entries[0].remainingPct, 75);
  assert.equal(result.snapshot.entries[0].resetAtMs, Date.parse('2030-02-01T00:00:00Z'));
  assert.equal(result.snapshot.entries[0].windowMinutes, 44640);
  const request = f.calls.find(call => call.url === GROK_BILLING_LEGACY_URL);
  assert.equal(request.init.headers.Authorization, 'Bearer access-token');
  assert.equal(request.init.headers['x-xai-token-auth'], 'xai-grok-cli');
  assert.equal(request.timeoutMs, 6000);
  assert.deepEqual(request.options, f.egress);
});

test('an empty legacy included limit or denied legacy endpoint preserves unknown credits and valid auth', async () => {
  for (const denied of [true, false]) {
    const f = probeFixture({ fetchWithTimeout: async (url) => {
      if (url === GROK_BILLING_GRPC_URL) return { ok: false, status: 503 };
      if (url === GROK_BILLING_LEGACY_URL) return { ok: !denied, status: denied ? 401 : 200,
        json: async () => ({ config: { monthlyLimit: { val: 0 }, used: { val: 38 } } }) };
      return { ok: true, status: 200, json: async () => url === GROK_BILLING_URL ? PERIOD_PAYLOAD : {} };
    } });
    const result = await f.service.probe(ACCOUNT_REF);
    assert.equal(result.snapshot.entries[0].remainingPct, null);
    assert.equal(result.snapshot.entries[0].resetAtMs, Date.parse(PERIOD_PAYLOAD.config.currentPeriod.end));
    assert.equal(result.auth, undefined);
  }
});

test('supplementary Grok billing errors preserve a valid REST period without invalidating auth', async () => {
  for (const failure of ['timeout', 'grpc-auth', 'malformed']) {
    const f = probeFixture({ fetchWithTimeout: async (url) => {
      if (url === GROK_BILLING_GRPC_URL) {
        if (failure === 'timeout') throw new Error('timeout');
        return { ok: true, status: 200, headers: { get: () => failure === 'grpc-auth' ? '16' : null },
          arrayBuffer: async () => Buffer.from([0, 0]) };
      }
      return { ok: true, status: 200, json: async () => url === GROK_BILLING_URL ? PERIOD_PAYLOAD : {} };
    } });
    const result = await f.service.probe(ACCOUNT_REF);
    assert.equal(result.snapshot.entries[0].remainingPct, null, failure);
    assert.equal(result.snapshot.entries[0].resetAtMs, Date.parse(PERIOD_PAYLOAD.config.currentPeriod.end), failure);
    assert.equal(result.auth, undefined, failure);
  }
});

test('Grok discards a billing result when the credential rotates during supplementary lookup', async () => {
  const f = probeFixture({ fetchWithTimeout: async (url) => {
    if (url === GROK_BILLING_GRPC_URL) {
      f.record.nativeAuth.auth.key = 'rotated-token';
      return { ok: false, status: 503 };
    }
    return { ok: true, status: 200, json: async () => url === GROK_BILLING_URL ? PERIOD_PAYLOAD : {} };
  } });
  assert.equal((await f.service.probe(ACCOUNT_REF)).error, 'credential_changed_during_probe');
});
