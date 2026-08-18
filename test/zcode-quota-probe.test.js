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
  writeAccountCredentials,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');
const {
  USAGE_SNAPSHOT_KINDS,
  USAGE_SOURCE_ZCODE,
  getUsageRemainingPctValues,
  getMinRemainingPctFromUsageSnapshot
} = require('../lib/account/usage-remaining');
const {
  createZcodeQuotaProbe,
  ZCODE_PLAN_BALANCE_URL,
  __private: probePrivate
} = require('../lib/cli/services/usage/zcode-quota-probe');

function makeOkResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  };
}

function setupZcodeAccount(options = {}) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-quota-'));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'zcode',
    cliAccountId: options.cliAccountId || '1',
    identitySeed: `test:zcode:quota:${options.cliAccountId || '1'}`
  });
  if (options.env) writeAccountCredentials(fs, aiHomeDir, accountRef, options.env);
  if (options.credentials) {
    writeAccountNativeAuth(fs, aiHomeDir, accountRef, { credentials: options.credentials });
  }
  return { aiHomeDir, accountRef };
}

function makeBalancePayload(overrides = {}) {
  return {
    code: 0,
    success: true,
    data: {
      plans: [{ name: 'pro' }],
      balances: [
        {
          show_name: 'GLM 5.3',
          capabilities: ['model:glm-5.3'],
          total_units: 1000,
          used_units: 210,
          remaining_units: 790,
          available_units: 790,
          period: 'daily',
          period_start: 1_780_000_000,
          period_end: 1_780_086_400
        },
        {
          show_name: 'Weekly Pool',
          capabilities: [],
          total_units: 500,
          used_units: 100,
          remaining_units: 400,
          period: 'weekly',
          period_start: 1_780_000_000,
          period_end: 1_780_604_800
        }
      ],
      ...overrides.data
    },
    ...overrides.root
  };
}

test('parseZcodeBalancePayload maps balances into windowed entries', () => {
  const capturedAt = 1_780_000_000_000;
  const snapshot = probePrivate.parseZcodeBalancePayload(makeBalancePayload(), capturedAt);

  assert.equal(snapshot.kind, 'zcode_plan_balance');
  assert.equal(snapshot.source, USAGE_SOURCE_ZCODE);
  assert.equal(snapshot.entries.length, 2);

  const model = snapshot.entries.find((entry) => entry.bucket === 'glm-5.3');
  assert.equal(model.windowMinutes, 1440);
  assert.equal(model.window, '1days');
  assert.equal(model.remainingPct, 79);
  assert.equal(model.resetAtMs, 1_780_086_400_000);
  assert.equal(model.resetIn, '1d0h0m');

  const fallback = snapshot.entries.find((entry) => entry.bucket === 'Weekly Pool');
  assert.equal(fallback.windowMinutes, 10080);
  assert.equal(fallback.window, '7days');
  assert.equal(fallback.remainingPct, 80);

  assert.deepEqual(snapshot.account, { planType: 'pro' });
});

test('parseZcodeBalancePayload prefers remaining_units and clamps remainingPct', () => {
  const snapshot = probePrivate.parseZcodeBalancePayload({
    code: 0,
    data: {
      balances: [
        { show_name: 'a', capabilities: ['model:a'], total_units: 100, used_units: 10, remaining_units: 250, period: 'daily', period_end: 1 },
        { show_name: 'b', capabilities: [], total_units: 200, used_units: 150, period: 'monthly', period_end: 0 },
        { show_name: 'c', capabilities: [], total_units: 0, used_units: 0, remaining_units: 0, period: 'unknown' }
      ]
    }
  }, Date.now());

  const a = snapshot.entries.find((entry) => entry.bucket === 'a');
  assert.equal(a.remainingPct, 100, 'remaining 是上游权威值，超出 100 时 clamp');
  const b = snapshot.entries.find((entry) => entry.bucket === 'b');
  assert.equal(b.remainingPct, 25, 'remaining_units 缺失时按 total-used 推算');
  assert.equal(b.windowMinutes, 43200);
  assert.equal(b.resetAtMs, 0);
  assert.equal(b.resetIn, '');
  const c = snapshot.entries.find((entry) => entry.bucket === 'c');
  assert.equal(c.remainingPct, null, 'total_units 为 0 时无法计算百分比');
  assert.equal(c.windowMinutes, 0);
});

test('parseZcodeBalancePayload derives window from period_start/period_end when period is absent', () => {
  // 真实响应里 balances 条目不带 period 字段（period 只在 plans[*].entitlements 上），
  // 窗口必须从 period_end-period_start 跨度推导，否则窗口标签恒为空。
  const snapshot = probePrivate.parseZcodeBalancePayload({
    code: 0,
    data: {
      balances: [
        {
          show_name: 'GLM-5.3',
          capabilities: ['model:glm-5.3'],
          total_units: 3000000,
          used_units: 0,
          remaining_units: 3000000,
          period_start: 1786982400,
          period_end: 1787068799
        }
      ]
    }
  }, Date.now());

  const entry = snapshot.entries[0];
  assert.equal(entry.windowMinutes, 1440);
  assert.equal(entry.window, '1days');
  assert.equal(entry.remainingPct, 100);
});

test('normalizeAccountUsageSnapshot keeps zcode_plan_balance entries for the WebUI', async () => {
  const { normalizeAccountUsageSnapshot } = require('../lib/server/account-usage-view');
  const normalized = normalizeAccountUsageSnapshot({
    kind: 'zcode_plan_balance',
    capturedAt: 1787020858301,
    source: 'zcode_plan_billing_balance_api',
    account: { planType: 'ZCode Start Plan' },
    entries: [
      { bucket: 'glm-5.3', windowMinutes: 1440, window: '1days', remainingPct: 99.4, resetIn: '13h19m', resetAtMs: 1787068799000 }
    ]
  });
  assert.equal(normalized.kind, 'zcode_plan_balance');
  assert.deepEqual(normalized.account, { planType: 'ZCode Start Plan' });
  assert.deepEqual(normalized.entries[0], {
    bucket: 'glm-5.3',
    windowMinutes: 1440,
    window: '1days',
    remainingPct: 99.4,
    resetIn: '13h19m',
    resetAtMs: 1787068799000
  });
});

test('parseZcodeBalancePayload returns null for missing balances', () => {
  assert.equal(probePrivate.parseZcodeBalancePayload({}, Date.now()), null);
  assert.equal(probePrivate.parseZcodeBalancePayload(null, Date.now()), null);
  assert.equal(probePrivate.parseZcodeBalancePayload({ data: { balances: [] } }, Date.now()), null);
});

test('formatResetInFromMs renders day/hour/minute styles from reset ms', () => {
  const nowMs = 1_000_000_000_000;
  assert.equal(probePrivate.formatResetInFromMs(0, nowMs), '');
  assert.equal(probePrivate.formatResetInFromMs(nowMs + 5 * 3600_000 + 12 * 60_000, nowMs), '5h12m');
  assert.equal(probePrivate.formatResetInFromMs(nowMs + 2 * 86400_000 + 3 * 3600_000 + 4 * 60_000, nowMs), '2d3h4m');
  assert.equal(probePrivate.formatResetInFromMs(nowMs + 9 * 60_000, nowMs), '9m');
});

test('usage-remaining registry extracts zcode entries like codex/claude/kimi', () => {
  const snapshot = {
    kind: USAGE_SNAPSHOT_KINDS.zcode,
    entries: [{ remainingPct: 79 }, { remainingPct: 96 }]
  };
  assert.deepEqual(getUsageRemainingPctValues(snapshot), [79, 96]);
  assert.equal(getMinRemainingPctFromUsageSnapshot(snapshot), 79);
  assert.equal(USAGE_SNAPSHOT_KINDS.zcode, 'zcode_plan_balance');
});

test('zcode quota probe fetches the plan balance endpoint with the jwt token', async () => {
  const { aiHomeDir, accountRef } = setupZcodeAccount({
    credentials: {
      'oauth:zai:access_token': 'zai-access-token',
      zcodejwttoken: 'zcode-jwt-token'
    }
  });
  const calls = [];
  const probe = createZcodeQuotaProbe({
    fs,
    aiHomeDir,
    usageSnapshotSchemaVersion: 2,
    readAccountCredentialRecord: require('../lib/server/account-credential-store').readAccountCredentialRecord,
    fetchWithTimeout: async (url, init, timeoutMs, proxyOptions) => {
      calls.push({ url, init, timeoutMs, proxyOptions });
      return makeOkResponse(makeBalancePayload());
    }
  });
  try {
    const result = await probe.probe(accountRef, 4321);
    assert.ok(result.snapshot, 'expected snapshot');
    assert.equal(result.snapshot.schemaVersion, 2);
    assert.equal(result.snapshot.entries[0].bucket, 'glm-5.3');
    assert.equal(result.snapshot.entries[0].remainingPct, 79);
    assert.deepEqual(result.snapshot.account, { planType: 'pro' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, ZCODE_PLAN_BALANCE_URL);
    assert.equal(calls[0].url, 'https://zcode.z.ai/api/v1/zcode-plan/billing/balance');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer zcode-jwt-token');
    assert.equal(calls[0].timeoutMs, 4321);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('zcode quota probe skips API key accounts without fetching', async () => {
  const { aiHomeDir, accountRef } = setupZcodeAccount({
    env: { ZCODE_API_KEY: 'sk-zcode' },
    credentials: { zcodejwttoken: 'zcode-jwt-token' }
  });
  let fetchCalls = 0;
  const probe = createZcodeQuotaProbe({
    fs,
    aiHomeDir,
    readAccountCredentialRecord: require('../lib/server/account-credential-store').readAccountCredentialRecord,
    fetchWithTimeout: async () => {
      fetchCalls += 1;
      throw new Error('api-key accounts must not enter the quota probe');
    }
  });
  try {
    const result = await probe.probe(accountRef, 5000);
    assert.equal(result.error, 'api_key_mode_not_applicable');
    assert.equal(fetchCalls, 0);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('zcode quota probe reports missing jwt token as auth error', async () => {
  const { aiHomeDir, accountRef } = setupZcodeAccount({
    credentials: { 'oauth:zai:access_token': 'zai-access-only' }
  });
  let fetchCalls = 0;
  const probe = createZcodeQuotaProbe({
    fs,
    aiHomeDir,
    readAccountCredentialRecord: require('../lib/server/account-credential-store').readAccountCredentialRecord,
    fetchWithTimeout: async () => {
      fetchCalls += 1;
      return makeOkResponse({});
    }
  });
  try {
    const result = await probe.probe(accountRef, 5000);
    assert.equal(result.error, 'missing_oauth_credentials');
    assert.equal(result.auth, true);
    assert.equal(fetchCalls, 0);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('zcode quota probe rejects foreign provider credential records', async () => {
  const { aiHomeDir } = setupZcodeAccount();
  const foreignRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId: '9',
    identitySeed: 'test:zcode:foreign-provider'
  });
  const probe = createZcodeQuotaProbe({
    fs,
    aiHomeDir,
    readAccountCredentialRecord: require('../lib/server/account-credential-store').readAccountCredentialRecord,
    fetchWithTimeout: async () => makeOkResponse(makeBalancePayload())
  });
  try {
    const result = await probe.probe(foreignRef, 5000);
    assert.equal(result.error, 'credential_record_missing');
    const missing = await probe.probe('nonexistent-ref', 5000);
    assert.equal(missing.error, 'credential_record_missing');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('zcode quota probe marks 401/403 as auth errors and other statuses as plain http errors', async () => {
  const { aiHomeDir, accountRef } = setupZcodeAccount({
    credentials: { zcodejwttoken: 'zcode-jwt-token' }
  });
  const probeWith = (status) => createZcodeQuotaProbe({
    fs,
    aiHomeDir,
    readAccountCredentialRecord: require('../lib/server/account-credential-store').readAccountCredentialRecord,
    fetchWithTimeout: async () => makeOkResponse({ code: 0 }, status)
  });
  try {
    const unauthorized = await probeWith(401).probe(accountRef, 5000);
    assert.equal(unauthorized.error, 'zcode_balance_http_401');
    assert.equal(unauthorized.auth, true);

    const forbidden = await probeWith(403).probe(accountRef, 5000);
    assert.equal(forbidden.error, 'zcode_balance_http_403');
    assert.equal(forbidden.auth, true);

    const serverError = await probeWith(500).probe(accountRef, 5000);
    assert.equal(serverError.error, 'zcode_balance_http_500');
    assert.equal(serverError.auth, false);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('zcode quota probe treats HTTP 200 business errors as failures', async () => {
  const { aiHomeDir, accountRef } = setupZcodeAccount({
    credentials: { zcodejwttoken: 'zcode-jwt-token' }
  });
  const cases = [
    { name: 'success:false', payload: { code: 0, success: false, data: { balances: [] } } },
    { name: 'code!=0', payload: { code: 10001, data: { balances: [] } } },
    { name: 'string code!=0', payload: { code: '40100', data: { balances: [] } } }
  ];
  try {
    for (const entry of cases) {
      const probe = createZcodeQuotaProbe({
        fs,
        aiHomeDir,
        readAccountCredentialRecord: require('../lib/server/account-credential-store').readAccountCredentialRecord,
        fetchWithTimeout: async () => makeOkResponse(entry.payload)
      });
      const result = await probe.probe(accountRef, 5000);
      assert.equal(result.error, 'zcode_balance_business_error', entry.name);
    }
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('zcode quota probe reports empty_parsed_snapshot when balances is not an array', async () => {
  const { aiHomeDir, accountRef } = setupZcodeAccount({
    credentials: { zcodejwttoken: 'zcode-jwt-token' }
  });
  const probe = createZcodeQuotaProbe({
    fs,
    aiHomeDir,
    readAccountCredentialRecord: require('../lib/server/account-credential-store').readAccountCredentialRecord,
    fetchWithTimeout: async () => makeOkResponse({ code: 0, data: {} })
  });
  try {
    const result = await probe.probe(accountRef, 5000);
    assert.equal(result.error, 'empty_parsed_snapshot');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('zcode quota probe converts fetch exceptions into probe_exception errors', async () => {
  const { aiHomeDir, accountRef } = setupZcodeAccount({
    credentials: { zcodejwttoken: 'zcode-jwt-token' }
  });
  const probe = createZcodeQuotaProbe({
    fs,
    aiHomeDir,
    readAccountCredentialRecord: require('../lib/server/account-credential-store').readAccountCredentialRecord,
    fetchWithTimeout: async () => {
      throw new Error('socket hang up');
    }
  });
  try {
    const result = await probe.probe(accountRef, 5000);
    assert.equal(result.error, 'probe_exception:socket hang up');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('zcode quota probe accepts numeric 200 and string code success shapes', async () => {
  const { aiHomeDir, accountRef } = setupZcodeAccount({
    credentials: { zcodejwttoken: 'zcode-jwt-token' }
  });
  const balances = [{
    show_name: 'GLM 5.3',
    capabilities: ['model:glm-5.3'],
    total_units: 100,
    used_units: 40,
    remaining_units: 60,
    period: 'daily',
    period_end: 1_780_086_400
  }];
  try {
    for (const payload of [
      { code: 200, data: { balances } },
      { code: '0', data: { balances } },
      { data: { balances } }
    ]) {
      const probe = createZcodeQuotaProbe({
        fs,
        aiHomeDir,
        readAccountCredentialRecord: require('../lib/server/account-credential-store').readAccountCredentialRecord,
        fetchWithTimeout: async () => makeOkResponse(payload)
      });
      const result = await probe.probe(accountRef, 5000);
      assert.ok(result.snapshot, `expected snapshot for code=${JSON.stringify(payload.code)}`);
      assert.equal(result.snapshot.entries[0].remainingPct, 60);
    }
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});
