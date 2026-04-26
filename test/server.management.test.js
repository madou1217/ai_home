const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildManagementStatusPayload,
  buildManagementAccountsPayload,
  applyReloadState
} = require('../lib/server/management');

test('management payloads expose runtime status breakdown', () => {
  const now = Date.now();
  const state = {
    strategy: 'round-robin',
    startedAt: now - 5000,
    accounts: {
      codex: [
        { id: 'c1', provider: 'codex', email: 'a@example.com', cooldownUntil: 0, successCount: 1, failCount: 0 },
        { id: 'c2', provider: 'codex', email: 'b@example.com', cooldownUntil: now + 60000, rateLimitUntil: now + 60000, lastFailureReason: 'quota' }
      ],
      gemini: [
        { id: 'g1', provider: 'gemini', email: 'g@example.com', cooldownUntil: now + 60000, authInvalidUntil: now + 60000, lastFailureReason: 'invalid auth' }
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
  assert.equal(accounts.accounts.find((item) => item.id === 'c2').runtimeStatus, 'rate_limited');
  assert.equal(accounts.accounts.find((item) => item.id === 'g1').runtimeStatus, 'auth_invalid');
});

test('management accounts payload exposes schedulable status and reasons', () => {
  const state = {
    accounts: {
      codex: [
        {
          id: '9',
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
    fs: {
      existsSync(filePath) {
        return String(filePath).endsWith('/.aih_usage.json');
      },
      readFileSync(filePath) {
        if (String(filePath).endsWith('/.aih_usage.json')) {
          return JSON.stringify({
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
        }
        throw new Error(`unexpected_read:${filePath}`);
      }
    },
    getProfileDir: () => '/tmp/profile'
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
          id: '10026',
          provider: 'codex',
          email: '',
          accountId: '10026',
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

test('management accounts payload includes normalized usage snapshots', () => {
  const state = {
    accounts: {
      codex: [
        { id: '8', provider: 'codex', email: 'c@example.com', remainingPct: null, cooldownUntil: 0 }
      ],
      gemini: [],
      claude: []
    }
  };

  const accounts = buildManagementAccountsPayload(state, {
    fs: {
      existsSync(filePath) {
        return String(filePath).endsWith('/.aih_usage.json');
      },
      readFileSync(filePath) {
        if (String(filePath).endsWith('/.aih_usage.json')) {
          return JSON.stringify({
            schemaVersion: 2,
            kind: 'codex_oauth_status',
            source: 'codex_app_server',
            capturedAt: Date.now(),
            account: {
              planType: 'plus',
              email: 'c@example.com',
              accountId: 'acct-8',
              organizationId: 'org-8'
            },
            entries: [
              { bucket: 'primary', windowMinutes: 300, window: '5h', remainingPct: 61, resetIn: '3h', resetAtMs: Date.now() + 10800000 },
              { bucket: 'secondary', windowMinutes: 10080, window: '7days', remainingPct: 88, resetIn: '6d', resetAtMs: Date.now() + 518400000 }
            ]
          });
        }
        throw new Error(`unexpected_read:${filePath}`);
      }
    },
    getProfileDir: (_provider, id) => `/tmp/${id}`,
    getToolConfigDir: (_provider, id) => `/tmp/${id}/.codex`
  });

  assert.equal(accounts.accounts[0].remainingPct, 61);
  assert.equal(accounts.accounts[0].configured, true);
  assert.equal(accounts.accounts[0].apiKeyMode, false);
  assert.equal(accounts.accounts[0].planType, 'plus');
  assert.equal(accounts.accounts[0].usageSnapshot.account.accountId, 'acct-8');
  assert.equal(accounts.accounts[0].usageSnapshot.kind, 'codex_oauth_status');
  assert.equal(accounts.accounts[0].usageSnapshot.entries.length, 2);
});

test('management accounts payload prefers trusted usage snapshot remaining over stale runtime remaining', () => {
  const state = {
    accounts: {
      codex: [
        { id: '18', provider: 'codex', email: 'fresh@example.com', remainingPct: 0, cooldownUntil: 0 }
      ],
      gemini: [],
      claude: []
    }
  };

  const accounts = buildManagementAccountsPayload(state, {
    fs: {
      existsSync(filePath) {
        return String(filePath).endsWith('/.aih_usage.json');
      },
      readFileSync(filePath) {
        if (String(filePath).endsWith('/.aih_usage.json')) {
          return JSON.stringify({
            schemaVersion: 2,
            kind: 'codex_oauth_status',
            source: 'codex_app_server',
            capturedAt: Date.now(),
            account: {
              planType: 'team',
              email: 'fresh@example.com',
              accountId: 'acct-18',
              organizationId: 'org-18'
            },
            entries: [
              { bucket: 'primary', windowMinutes: 300, window: '5h', remainingPct: 89, resetIn: '2h', resetAtMs: Date.now() + 7200000 },
              { bucket: 'secondary', windowMinutes: 10080, window: '7days', remainingPct: 73, resetIn: '6d', resetAtMs: Date.now() + 518400000 }
            ]
          });
        }
        throw new Error(`unexpected_read:${filePath}`);
      }
    },
    getProfileDir: (_provider, id) => `/tmp/${id}`,
    getToolConfigDir: (_provider, id) => `/tmp/${id}/.codex`
  });

  assert.equal(accounts.accounts[0].remainingPct, 73);
  assert.equal(accounts.accounts[0].quotaStatus, 'available');
  assert.equal(accounts.accounts[0].schedulableStatus, 'schedulable');
});

test('applyReloadState invalidates web ui models cache when accounts change', () => {
  const state = {
    accounts: { codex: [{ id: 'old' }], gemini: [], claude: [] },
    cursors: { codex: 9, gemini: 7, claude: 5 },
    sessionAffinity: { codex: new Map([['a', 1]]), gemini: new Map(), claude: new Map() },
    modelsCache: { updatedAt: 123, ids: ['x'], byAccount: { old: ['x'] }, sourceCount: 1 },
    webUiModelsCache: {
      updatedAt: 456,
      signature: 'codex:old|gemini:|claude:',
      source: 'remote',
      byProvider: { codex: ['gpt-5.4'] }
    }
  };

  applyReloadState(state, {
    codex: [{ id: 'new' }],
    gemini: [{ id: 'g1' }],
    claude: []
  });

  assert.equal(state.cursors.codex, 0);
  assert.equal(state.cursors.gemini, 0);
  assert.equal(state.modelsCache.updatedAt, 0);
  assert.equal(state.webUiModelsCache.updatedAt, 0);
  assert.deepEqual(state.webUiModelsCache.byProvider, {});
  assert.equal(state.webUiModelsCache.signature, '');
});
