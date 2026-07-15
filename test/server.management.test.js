const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { writeAccountUsageSnapshot } = require('../lib/account/usage-snapshot-store');

const {
  buildManagementStatusPayload,
  buildManagementMetricsPayload,
  buildManagementAccountsPayload,
  applyReloadState
} = require('../lib/server/management');

const ACCOUNT_REFS = Object.freeze({
  codex1: 'acct_11111111111111111111',
  codex2: 'acct_22222222222222222222',
  gemini1: 'acct_33333333333333333333',
  agy5: 'acct_55555555555555555555',
  claude3: 'acct_66666666666666666666',
  codexApi: 'acct_77777777777777777777'
});

function createUsageFixture(t, provider, cliAccountId, snapshot) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-management-usage-db-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const registration = registerAccountIdentity(fs, aiHomeDir, {
    provider,
    cliAccountId,
    identitySeed: `oauth:${provider}:management-${cliAccountId}@example.com`
  });
  writeAccountUsageSnapshot(fs, aiHomeDir, registration.accountRef, snapshot);
  return { aiHomeDir, accountRef: registration.accountRef };
}

test('management payloads expose runtime status breakdown', () => {
  const now = Date.now();
  const state = {
    strategy: 'round-robin',
    startedAt: now - 5000,
    accounts: {
      codex: [
        { accountRef: ACCOUNT_REFS.codex1, provider: 'codex', email: 'a@example.com', cooldownUntil: 0, successCount: 1, failCount: 0 },
        { accountRef: ACCOUNT_REFS.codex2, provider: 'codex', email: 'b@example.com', cooldownUntil: now + 60000, rateLimitUntil: now + 60000, lastFailureReason: 'quota' }
      ],
      gemini: [
        { accountRef: ACCOUNT_REFS.gemini1, provider: 'gemini', email: 'g@example.com', cooldownUntil: now + 60000, authInvalidUntil: now + 60000, lastFailureReason: 'invalid auth' }
      ],
      claude: []
    },
    metrics: {
      totalRequests: 1,
      totalSuccess: 1,
      totalFailures: 0,
      totalTimeouts: 0,
      routeCounts: {},
      providerCounts: {},
      providerSuccess: {},
      providerFailures: {},
      lastErrors: []
    },
    executors: {
      codex: { snapshot: () => ({ name: 'codex', running: 0, queued: 0, maxConcurrency: 1, queueLimit: 1, totalScheduled: 0, totalRejected: 0 }) },
      gemini: { snapshot: () => ({ name: 'gemini', running: 0, queued: 0, maxConcurrency: 1, queueLimit: 1, totalScheduled: 0, totalRejected: 0 }) },
      claude: { snapshot: () => ({ name: 'claude', running: 0, queued: 0, maxConcurrency: 1, queueLimit: 1, totalScheduled: 0, totalRejected: 0 }) }
    },
    sessionAffinity: { codex: new Map(), gemini: new Map(), claude: new Map() },
    modelsCache: { ids: [], updatedAt: 0 },
    modelRegistry: { updatedAt: 0 }
  };

  const status = buildManagementStatusPayload(state, {
    backend: 'codex-adapter',
    host: '127.0.0.1',
    port: 8317,
    provider: 'auto'
  });
  const accounts = buildManagementAccountsPayload(state);

  assert.equal(status.statusTotals.healthy, 1);
  assert.equal(status.statusTotals.rate_limited, 1);
  assert.equal(status.statusTotals.auth_invalid, 1);
  assert.equal(accounts.accounts.find((item) => item.accountRef === ACCOUNT_REFS.codex2).runtimeStatus, 'rate_limited');
  assert.equal(accounts.accounts.find((item) => item.accountRef === ACCOUNT_REFS.gemini1).runtimeStatus, 'auth_invalid');
});

test('management payloads prefer persisted runtime state over healthy in-memory account', () => {
  const now = Date.now();
  const state = {
    strategy: 'round-robin',
    startedAt: now - 5000,
    accounts: {
      codex: [],
      gemini: [
        { accountRef: ACCOUNT_REFS.gemini1, provider: 'gemini', email: 'g@example.com', cooldownUntil: 0, authInvalidUntil: 0 }
      ],
      claude: []
    },
    metrics: {
      totalRequests: 1,
      totalSuccess: 0,
      totalFailures: 0,
      totalTimeouts: 0,
      routeCounts: {},
      providerCounts: {},
      providerSuccess: {},
      providerFailures: {},
      lastErrors: []
    },
    executors: {
      codex: { snapshot: () => ({ name: 'codex', running: 0, queued: 0, maxConcurrency: 1, queueLimit: 1, totalScheduled: 0, totalRejected: 0 }) },
      gemini: { snapshot: () => ({ name: 'gemini', running: 0, queued: 0, maxConcurrency: 1, queueLimit: 1, totalScheduled: 0, totalRejected: 0 }) },
      claude: { snapshot: () => ({ name: 'claude', running: 0, queued: 0, maxConcurrency: 1, queueLimit: 1, totalScheduled: 0, totalRejected: 0 }) }
    },
    sessionAffinity: { codex: new Map(), gemini: new Map(), claude: new Map() },
    modelsCache: { ids: [], updatedAt: 0 },
    modelRegistry: { updatedAt: 0 }
  };
  const accountStateIndex = {
    getAccountState(accountRef) {
      if (accountRef === ACCOUNT_REFS.gemini1) {
        return {
          runtimeState: {
            cooldownUntil: now + 60_000,
            authInvalidUntil: now + 60_000,
            lastFailureKind: 'auth_invalid',
            lastFailureReason: 'token_expired'
          }
        };
      }
      return null;
    }
  };

  const status = buildManagementStatusPayload(state, {}, { accountStateIndex });
  const accounts = buildManagementAccountsPayload(state, { accountStateIndex });

  assert.equal(status.statusTotals.auth_invalid, 1);
  assert.equal(accounts.accounts[0].runtimeStatus, 'auth_invalid');
  assert.equal(accounts.accounts[0].runtimeReason, 'token_expired');
});

test('management accounts payload exposes active model cooldowns', () => {
  const now = Date.now();
  const state = {
    accounts: {
      codex: [],
      gemini: [],
      claude: [],
      agy: [{
        accountRef: ACCOUNT_REFS.agy5,
        provider: 'agy',
        email: '',
        cooldownUntil: 0,
        modelCooldowns: {
          'claude-sonnet-4-6': now + 60_000,
          'old-model': now - 1_000
        },
        modelFailures: {
          'claude-sonnet-4-6': 2,
          'old-model': 1
        }
      }]
    }
  };

  const accounts = buildManagementAccountsPayload(state);
  assert.deepEqual(accounts.accounts[0].modelCooldowns, {
    'claude-sonnet-4-6': state.accounts.agy[0].modelCooldowns['claude-sonnet-4-6']
  });
  assert.equal(accounts.accounts[0].modelCooldownCount, 1);
  assert.equal(accounts.accounts[0].runtimeStatus, 'healthy');
});

test('management accounts payload shows exhausted quota for free agy model quota cooldowns', (t) => {
  const now = Date.now();
  const runtimeState = {
    lastFailureKind: 'model_quota_exhausted',
    lastFailureReason: 'HTTP 429 RESOURCE_EXHAUSTED Resource has been exhausted (e.g. check quota)',
    modelCooldowns: {
      'claude-opus-4-6-thinking': now + 60_000
    }
  };
  const fixture = createUsageFixture(t, 'agy', '5', {
    schemaVersion: 2,
    kind: 'agy_code_assist_quota',
    source: 'agy_fetch_available_models',
    capturedAt: now,
    account: {
      email: 'agy-free@example.com',
      planType: 'oauth',
      subscriptionTier: 'Antigravity Starter Quota',
      project: 'projects/agy-free'
    },
    models: [
      {
        model: 'claude-opus-4-6-thinking',
        remainingPct: 100,
        resetIn: '24h',
        resetAtMs: now + 86_400_000
      },
      {
        model: 'gemini-3-flash',
        remainingPct: 100,
        resetIn: '24h',
        resetAtMs: now + 86_400_000
      }
    ]
  });
  const state = {
    accounts: {
      codex: [],
      gemini: [],
      claude: [],
      agy: [{
        accountRef: fixture.accountRef,
        provider: 'agy',
        email: 'agy-free@example.com',
        cooldownUntil: 0,
        ...runtimeState
      }]
    }
  };

  const accounts = buildManagementAccountsPayload(state, {
    fs,
    aiHomeDir: fixture.aiHomeDir
  });

  assert.equal(accounts.accounts[0].planType, 'free');
  assert.equal(accounts.accounts[0].remainingPct, 0);
  assert.equal(accounts.accounts[0].quotaStatus, 'exhausted');
  assert.equal(accounts.accounts[0].schedulableStatus, 'blocked_by_quota');
  assert.deepEqual(accounts.accounts[0].usageSnapshot.models.map((model) => model.remainingPct), [0, 0]);
  assert.deepEqual(accounts.accounts[0].modelCooldowns, {
    'claude-opus-4-6-thinking': runtimeState.modelCooldowns['claude-opus-4-6-thinking']
  });
});

test('management metrics exposes recent error message for dashboard rendering', () => {
  const metrics = buildManagementMetricsPayload({
    metrics: {
      totalRequests: 1,
      totalSuccess: 0,
      totalFailures: 1,
      totalTimeouts: 0,
      routeCounts: {},
      providerCounts: {},
      providerSuccess: {},
      providerFailures: {},
      lastErrors: [
        {
          at: '2026-06-08T07:08:20.786Z',
          route: '/v1/chat/completions',
          provider: 'codex',
          error: 'upstream_failed'
        }
      ]
    },
    executors: {}
  });

  assert.equal(metrics.lastErrors[0].message, 'upstream_failed');
  assert.equal(metrics.lastErrors[0].error, 'upstream_failed');
});

test('management metrics preserves explicit recent error message', () => {
  const metrics = buildManagementMetricsPayload({
    metrics: {
      totalRequests: 1,
      totalSuccess: 0,
      totalFailures: 1,
      totalTimeouts: 0,
      routeCounts: {},
      providerCounts: {},
      providerSuccess: {},
      providerFailures: {},
      lastErrors: [
        {
          at: '2026-06-08T07:08:20.786Z',
          provider: 'claude',
          message: 'HTTP 403 permission denied',
          error: 'legacy_error'
        }
      ]
    },
    executors: {}
  });

  assert.equal(metrics.lastErrors[0].message, 'HTTP 403 permission denied');
  assert.equal(metrics.lastErrors[0].error, 'legacy_error');
});

test('management payloads use cleared persisted runtime state over stale in-memory block', () => {
  const now = Date.now();
  const state = {
    strategy: 'round-robin',
    startedAt: now - 5000,
    accounts: {
      codex: [],
      gemini: [],
      claude: [
        {
          accountRef: ACCOUNT_REFS.claude3,
          provider: 'claude',
          email: '',
          apiKeyMode: true,
          cooldownUntil: now + 60_000,
          rateLimitUntil: now + 60_000,
          lastFailureKind: 'rate_limited',
          lastFailureReason: 'usage_limit_reached'
        }
      ]
    },
    metrics: {
      totalRequests: 1,
      totalSuccess: 0,
      totalFailures: 0,
      totalTimeouts: 0,
      routeCounts: {},
      providerCounts: {},
      providerSuccess: {},
      providerFailures: {},
      lastErrors: []
    },
    executors: {
      codex: { snapshot: () => ({ name: 'codex', running: 0, queued: 0, maxConcurrency: 1, queueLimit: 1, totalScheduled: 0, totalRejected: 0 }) },
      gemini: { snapshot: () => ({ name: 'gemini', running: 0, queued: 0, maxConcurrency: 1, queueLimit: 1, totalScheduled: 0, totalRejected: 0 }) },
      claude: { snapshot: () => ({ name: 'claude', running: 0, queued: 0, maxConcurrency: 1, queueLimit: 1, totalScheduled: 0, totalRejected: 0 }) }
    },
    sessionAffinity: { codex: new Map(), gemini: new Map(), claude: new Map() },
    modelsCache: { ids: [], updatedAt: 0 },
    modelRegistry: { updatedAt: 0 }
  };
  const accountStateIndex = {
    getAccountState(accountRef) {
      if (accountRef === ACCOUNT_REFS.claude3) {
        return {
          runtimeState: null,
          apiKeyMode: true
        };
      }
      return null;
    }
  };

  const status = buildManagementStatusPayload(state, {}, { accountStateIndex });
  const accounts = buildManagementAccountsPayload(state, { accountStateIndex });

  assert.equal(status.statusTotals.healthy, 1);
  assert.equal(status.statusTotals.rate_limited, 0);
  assert.equal(accounts.accounts[0].runtimeStatus, 'healthy');
  assert.equal(accounts.accounts[0].schedulableStatus, 'schedulable');
});

test('management accounts payload exposes schedulable status and reasons', (t) => {
  const fixture = createUsageFixture(t, 'codex', '9', {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    fallbackSource: 'account_read',
    account: {
      planType: 'team',
      email: 'bad@example.com'
    },
    entries: []
  });
  const state = {
    accounts: {
      codex: [
        {
          accountRef: fixture.accountRef,
          provider: 'codex',
          email: 'bad@example.com',
          remainingPct: null,
          cooldownUntil: 0
        }
      ],
      gemini: [],
      claude: []
    }
  };

  const accounts = buildManagementAccountsPayload(state, {
    fs,
    aiHomeDir: fixture.aiHomeDir
  });
  // Team 账号没有额度数据时，标记为 pending 而不是 blocked_by_policy
  // 这样账号可以进入账号池，等待后续刷新获取额度数据
  assert.equal(accounts.accounts[0].schedulableStatus, 'schedulable');
  assert.equal(accounts.accounts[0].quotaStatus, 'pending');
  assert.equal(accounts.accounts[0].quotaReason, 'codex_team_plan_pending_rate_limits');
});

test('management accounts payload exposes api key base url for display labels', () => {
  const state = {
    accounts: {
      codex: [
        {
          accountRef: ACCOUNT_REFS.codexApi,
          provider: 'codex',
          email: '',
          apiKeyMode: true,
          authType: 'api-key',
          openaiBaseUrl: 'https://proxy.example.com/v1',
          cooldownUntil: 0
        }
      ],
      gemini: [],
      claude: []
    }
  };

  const accounts = buildManagementAccountsPayload(state);

  assert.equal(accounts.accounts[0].apiKeyMode, true);
  assert.equal(accounts.accounts[0].baseUrl, 'https://proxy.example.com/v1');
});

test('management accounts payload includes normalized usage snapshots', (t) => {
  const fixture = createUsageFixture(t, 'codex', '8', {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    account: {
      planType: 'plus',
      email: 'c@example.com',
      upstreamAccountId: 'upstream-8',
      organizationId: 'org-8'
    },
    entries: [
      { bucket: 'primary', windowMinutes: 300, window: '5h', remainingPct: 61, resetIn: '3h', resetAtMs: Date.now() + 10800000 },
      { bucket: 'secondary', windowMinutes: 10080, window: '7days', remainingPct: 88, resetIn: '6d', resetAtMs: Date.now() + 518400000 }
    ]
  });
  const state = {
    accounts: {
      codex: [
        { accountRef: fixture.accountRef, provider: 'codex', email: 'c@example.com', remainingPct: null, cooldownUntil: 0 }
      ],
      gemini: [],
      claude: []
    }
  };

  const accounts = buildManagementAccountsPayload(state, {
    fs,
    aiHomeDir: fixture.aiHomeDir
  });

  assert.equal(accounts.accounts[0].remainingPct, 61);
  assert.equal(accounts.accounts[0].configured, true);
  assert.equal(accounts.accounts[0].apiKeyMode, false);
  assert.equal(accounts.accounts[0].planType, 'plus');
  assert.equal(accounts.accounts[0].usageSnapshot.account.upstreamAccountId, 'upstream-8');
  assert.equal(accounts.accounts[0].usageSnapshot.kind, 'codex_oauth_status');
  assert.equal(accounts.accounts[0].usageSnapshot.entries.length, 2);
});

test('management accounts payload prefers trusted usage snapshot remaining over stale runtime remaining', (t) => {
  const fixture = createUsageFixture(t, 'codex', '18', {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    account: {
      planType: 'team',
      email: 'fresh@example.com',
      upstreamAccountId: 'upstream-18',
      organizationId: 'org-18'
    },
    entries: [
      { bucket: 'primary', windowMinutes: 300, window: '5h', remainingPct: 89, resetIn: '2h', resetAtMs: Date.now() + 7200000 },
      { bucket: 'secondary', windowMinutes: 10080, window: '7days', remainingPct: 73, resetIn: '6d', resetAtMs: Date.now() + 518400000 }
    ]
  });
  const state = {
    accounts: {
      codex: [
        { accountRef: fixture.accountRef, provider: 'codex', email: 'fresh@example.com', remainingPct: 0, cooldownUntil: 0 }
      ],
      gemini: [],
      claude: []
    }
  };

  const accounts = buildManagementAccountsPayload(state, {
    fs,
    aiHomeDir: fixture.aiHomeDir
  });

  assert.equal(accounts.accounts[0].remainingPct, 73);
  assert.equal(accounts.accounts[0].quotaStatus, 'available');
  assert.equal(accounts.accounts[0].schedulableStatus, 'schedulable');
});

test('applyReloadState invalidates web ui models cache when accounts change', () => {
  const state = {
    accounts: { codex: [{ accountRef: ACCOUNT_REFS.codex1 }], gemini: [], claude: [] },
    cursors: { codex: 9, gemini: 7, claude: 5 },
    sessionAffinity: { codex: new Map([['a', 1]]), gemini: new Map(), claude: new Map() },
    geminiSessionIdMap: new Map([['g1\u0000thread-a', { sessionId: '12345678-1234-4123-8123-123456789abc' }]]),
    modelsCache: { updatedAt: 123, ids: ['x'], byAccount: { old: ['x'] }, sourceCount: 1 },
    webUiModelsCache: {
      updatedAt: 456,
      signature: 'codex:old|gemini:|claude:',
      source: 'remote',
      byProvider: { codex: ['gpt-5.4'] }
    }
  };

  applyReloadState(state, {
    codex: [{ accountRef: ACCOUNT_REFS.codex2 }],
    gemini: [{ accountRef: ACCOUNT_REFS.gemini1 }],
    claude: []
  });

  assert.equal(state.cursors.codex, 0);
  assert.equal(state.cursors.gemini, 0);
  assert.equal(state.geminiSessionIdMap.size, 0);
  assert.equal(state.modelsCache.updatedAt, 0);
  assert.equal(state.webUiModelsCache.updatedAt, 0);
  assert.deepEqual(state.webUiModelsCache.byProvider, {});
  assert.equal(state.webUiModelsCache.signature, '');
});
