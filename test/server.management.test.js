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
