const test = require('node:test');
const assert = require('node:assert/strict');
const { createUsagePresenterService } = require('../lib/cli/services/usage/presenter');

function accountRefForId(id) {
  return `acct_${Number(id).toString(16).padStart(20, '0')}`;
}

function createPresenterHarness(overrides = {}) {
  const upserts = [];
  const options = {
    usageCacheMaxAgeMs: 24 * 60 * 60 * 1000,
    readUsageCache: overrides.readUsageCache || (() => null),
    ensureUsageSnapshot: overrides.ensureUsageSnapshot || ((_, __, cache) => cache),
    ensureUsageSnapshotAsync: overrides.ensureUsageSnapshotAsync || (async (_, __, cache) => cache),
    getClaudeUsageAuthForSandbox: () => null,
    getLastUsageProbeError: () => '',
    checkStatus: overrides.checkStatus || (() => ({ configured: true, accountName: 'tester@example.com' })),
    getProfileDir: () => '/tmp/.ai_home/profiles/codex/1',
    filterExistingAccountIds: (cliName, ids) => ids,
    getAccountStateIndex: () => ({ listStates: () => [] }),
    getToolAccountIds: overrides.getToolAccountIds || (() => ['1']),
    resolveAccountScope: (provider, selector) => ({
      provider,
      accountRef: accountRefForId(selector)
    }),
    getDefaultParallelism: () => 10,
    accountStateService: {
      syncAccountBaseState: (_cliName, _id, payload) => {
        upserts.push(payload);
        return true;
      }
    },
    getAccountQuotaState: () => ({ quotaStatus: 'available' }),
    getMinRemainingPctFromCache: (cache) => {
      if (!cache || !Array.isArray(cache.entries)) return null;
      const values = cache.entries
        .map((entry) => Number(entry && entry.remainingPct))
        .filter((value) => Number.isFinite(value));
      if (values.length === 0) return null;
      return Math.min(...values);
    },
    processObj: {
      env: {},
      stdout: { isTTY: false, write() {} }
    }
  };
  const service = createUsagePresenterService({ ...options, ...overrides });
  return { service, upserts };
}

test('buildUsageProbePayloadAsync carries minRemainingPct from refreshed snapshot', async () => {
  const snapshot = {
    capturedAt: Date.now(),
    kind: 'codex_oauth_status',
    entries: [
      { window: '5h', remainingPct: 42 },
      { window: '7days', remainingPct: 80 }
    ]
  };
  const { service } = createPresenterHarness({
    readUsageCache: () => null,
    ensureUsageSnapshotAsync: async () => snapshot
  });

  const payload = await service.buildUsageProbePayloadAsync('codex', '1');
  assert.equal(payload.status, 'ok');
  assert.equal(payload.minRemainingPct, 42);
});

test('printAllUsageSnapshots updates state from probe payload without re-reading cache', async () => {
  const snapshot = {
    capturedAt: Date.now(),
    kind: 'codex_oauth_status',
    entries: [
      { window: '5h', remainingPct: 42 },
      { window: '7days', remainingPct: 80 }
    ]
  };
  let readCalls = 0;
  const { service, upserts } = createPresenterHarness({
    readUsageCache: () => {
      readCalls += 1;
      return null;
    },
    ensureUsageSnapshotAsync: async () => snapshot
  });
  const oldLog = console.log;
  console.log = () => {};
  try {
    await service.printAllUsageSnapshots('codex', { jobs: 1 });
  } finally {
    console.log = oldLog;
  }

  assert.equal(readCalls, 1);
  assert.equal(upserts.length > 0, true);
  assert.deepEqual(upserts[0], {
    status: 'up',
    configured: true,
    apiKeyMode: false,
    remainingPct: 42
  });
});

test('printAllUsageSnapshots passes forceRefresh through probe options when refresh requested', async () => {
  const snapshot = {
    capturedAt: Date.now(),
    kind: 'codex_oauth_status',
    entries: [
      { window: '5h', remainingPct: 42 }
    ]
  };
  const seenOptions = [];
  const { service } = createPresenterHarness({
    ensureUsageSnapshotAsync: async (_cliName, _id, _cache, options) => {
      seenOptions.push(options);
      return snapshot;
    }
  });
  const oldLog = console.log;
  console.log = () => {};
  try {
    await service.printAllUsageSnapshots('codex', { jobs: 1, refresh: true });
    await service.printAllUsageSnapshots('codex', { jobs: 1 });
  } finally {
    console.log = oldLog;
  }

  assert.equal(seenOptions.length, 2);
  assert.equal(seenOptions[0].forceRefresh, true);
  assert.equal(seenOptions[1].forceRefresh, false);
});

test('printAllUsageSnapshots auto-enables high concurrency bulk codex scans', async () => {
  const snapshot = {
    capturedAt: Date.now(),
    kind: 'codex_oauth_status',
    entries: [
      { window: '5h', remainingPct: 42 }
    ]
  };
  const ids = Array.from({ length: 250 }, (_, index) => String(index + 1));
  const seenOptions = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const { service } = createPresenterHarness({
    getToolAccountIds: () => ids,
    ensureUsageSnapshotAsync: async (_cliName, _id, _cache, options) => {
      seenOptions.push(options);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return snapshot;
    }
  });
  const oldLog = console.log;
  console.log = () => {};
  try {
    await service.printAllUsageSnapshots('codex');
  } finally {
    console.log = oldLog;
  }

  assert.equal(seenOptions.length, ids.length);
  assert.equal(seenOptions.every((options) => options.bulkScan === true), true);
  assert.equal(seenOptions.every((options) => options.skipCodexAppServerFallback === true), true);
  assert.equal(seenOptions.every((options) => options.allowCodexTokenRefresh === false), true);
  assert.equal(maxInFlight > 10, true);
});

test('printAllUsageSnapshots schedules ten thousand codex accounts in bulk batches', async () => {
  const snapshot = {
    capturedAt: Date.now(),
    kind: 'codex_oauth_status',
    entries: [
      { window: '5h', remainingPct: 42 }
    ]
  };
  const ids = Array.from({ length: 10_000 }, (_, index) => String(index + 1));
  const seenOptions = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const { service, upserts } = createPresenterHarness({
    getToolAccountIds: () => ids,
    ensureUsageSnapshotAsync: async (_cliName, _id, _cache, options) => {
      seenOptions.push(options);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return snapshot;
    }
  });
  const oldLog = console.log;
  console.log = () => {};
  try {
    await service.printAllUsageSnapshots('codex');
  } finally {
    console.log = oldLog;
  }

  assert.equal(seenOptions.length, ids.length);
  assert.equal(upserts.length, ids.length);
  assert.equal(maxInFlight, 100);
  assert.equal(seenOptions.every((options) => options.bulkScan === true), true);
  assert.equal(seenOptions.every((options) => options.probeTimeoutMs === 10000), true);
  assert.equal(seenOptions.every((options) => options.skipCodexAppServerFallback === true), true);
  assert.equal(seenOptions.every((options) => options.allowCodexTokenRefresh === false), true);
});

test('printAllUsageSnapshots keeps -j as an explicit concurrency cap', async () => {
  const snapshot = {
    capturedAt: Date.now(),
    kind: 'codex_oauth_status',
    entries: [
      { window: '5h', remainingPct: 42 }
    ]
  };
  const ids = Array.from({ length: 20 }, (_, index) => String(index + 1));
  let inFlight = 0;
  let maxInFlight = 0;
  const { service } = createPresenterHarness({
    getToolAccountIds: () => ids,
    ensureUsageSnapshotAsync: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return snapshot;
    }
  });
  const oldLog = console.log;
  console.log = () => {};
  try {
    await service.printAllUsageSnapshots('codex', { jobs: 3 });
  } finally {
    console.log = oldLog;
  }

  assert.equal(maxInFlight <= 3, true);
});

test('printUsageSnapshotAsync explains codex team fallback without numeric rate limits', async () => {
  const snapshot = {
    capturedAt: Date.now(),
    kind: 'codex_oauth_status',
    fallbackSource: 'account_read',
    account: {
      planType: 'team',
      email: 'code5@meadeo.com'
    },
    entries: [
      { window: 'plan:team code5@meadeo.com', remainingPct: null, resetIn: 'unknown' }
    ]
  };
  const { service } = createPresenterHarness({
    ensureUsageSnapshotAsync: async () => snapshot
  });
  const logs = [];
  const oldLog = console.log;
  console.log = (message) => logs.push(String(message));
  try {
    await service.printUsageSnapshotAsync('codex', '5', { noCache: true });
  } finally {
    console.log = oldLog;
  }

  assert.equal(logs.some((line) => line.includes('plan:team code5@meadeo.com')), true);
  assert.equal(logs.some((line) => line.includes('account/read fallback returned no numeric rate limits')), true);
});

test('printUsageSnapshotAsync prefers auth recovery hint after codex direct auth failure', async () => {
  const snapshot = {
    capturedAt: Date.now(),
    kind: 'codex_oauth_status',
    fallbackSource: 'account_read',
    account: {
      planType: 'team',
      email: 'code5@meadeo.com'
    },
    entries: [
      { window: 'plan:team code5@meadeo.com', remainingPct: null, resetIn: 'unknown' }
    ]
  };
  const { service } = createPresenterHarness({
    ensureUsageSnapshotAsync: async () => snapshot,
    getLastUsageProbeError: () => 'direct_http_status_401 refresh_failed_after_account_read_fallback'
  });
  const logs = [];
  const oldLog = console.log;
  console.log = (message) => logs.push(String(message));
  try {
    await service.printUsageSnapshotAsync('codex', '5', { noCache: true });
  } finally {
    console.log = oldLog;
  }

  assert.equal(logs.some((line) => line.includes('Account token appears invalid/expired')), true);
  assert.equal(logs.some((line) => line.includes('workspace entitlement is missing')), false);
});

test('printUsageSnapshotAsync waits for codex auth-invalid reconciliation before returning', async () => {
  const order = [];
  const { service } = createPresenterHarness({
    ensureUsageSnapshotAsync: async () => {
      order.push('snapshot');
      return null;
    },
    codexAuthInvalidReconciler: {
      waitForIdle: async () => {
        order.push('idle');
      }
    }
  });
  const oldLog = console.log;
  console.log = () => {};
  try {
    await service.printUsageSnapshotAsync('codex', '5', { noCache: true });
  } finally {
    console.log = oldLog;
  }

  assert.deepEqual(order, ['snapshot', 'idle']);
});

test('printAllUsageSnapshots waits for codex auth-invalid reconciliation after workers finish', async () => {
  const order = [];
  const snapshot = {
    capturedAt: Date.now(),
    kind: 'codex_oauth_status',
    entries: [
      { window: '5h', remainingPct: 42 }
    ]
  };
  const { service } = createPresenterHarness({
    getToolAccountIds: () => ['1', '2'],
    ensureUsageSnapshotAsync: async (_cliName, id) => {
      order.push(`snapshot:${id}`);
      return snapshot;
    },
    codexAuthInvalidReconciler: {
      waitForIdle: async () => {
        order.push('idle');
      }
    }
  });
  const oldLog = console.log;
  console.log = () => {};
  try {
    await service.printAllUsageSnapshots('codex', { jobs: 1 });
  } finally {
    console.log = oldLog;
  }

  assert.deepEqual(order, [
    `snapshot:${accountRefForId('1')}`,
    `snapshot:${accountRefForId('2')}`,
    'idle'
  ]);
});

test('printUsageSnapshotAsync agy preflight prints local diagnostics without refreshing usage', async () => {
  const { service } = createPresenterHarness({
    ensureUsageSnapshotAsync: async () => {
      throw new Error('preflight must not refresh usage');
    },
    buildAgyUsagePreflight: () => ({
      profileDir: '/tmp/agy/1',
      configDir: '/tmp/agy/1/.gemini/antigravity-cli',
      nativeAuthPresent: true,
      nativeAccessTokenPresent: true,
      envAccessTokenPresent: false,
      selectedTokenSource: 'app-state.db:native-auth',
      refreshTokenPresent: true,
      emailPresent: true,
      tokenExpiresAt: '2026-06-08T02:00:22.390Z',
      tokenExpired: false,
      refreshDue: false,
      usageCachePresent: false,
      usageCacheKind: '',
      usageCacheCapturedAt: '',
      codeAssistClientVersion: '2.0.6',
      codeAssistUserAgent: 'Antigravity/2.0.6 (Macintosh; Intel Mac OS X 10_15_7) Chrome/132.0.6834.160 Electron/39.2.3',
      quotaBaseUrls: ['https://daily-cloudcode-pa.googleapis.com/v1internal']
    })
  });
  const logs = [];
  const oldLog = console.log;
  console.log = (message) => logs.push(String(message));
  try {
    await service.printUsageSnapshotAsync('agy', '1', { preflight: true });
  } finally {
    console.log = oldLog;
  }

  assert.equal(logs.some((line) => line.includes('AGY usage preflight for Account ID 1')), true);
  assert.equal(logs.some((line) => line.includes('selected=app-state.db:native-auth')), true);
  assert.equal(logs.some((line) => line.includes('codeAssistClientVersion: 2.0.6')), true);
  assert.equal(logs.some((line) => line.includes('local-only')), true);
});

test('printAllUsageSnapshots agy preflight summarizes local readiness without refreshing usage', async () => {
  const reports = {
    1: {
      id: '1',
      nativeAuthPresent: true,
      nativeAccessTokenPresent: true,
      envAccessTokenPresent: false,
      selectedTokenSource: 'app-state.db:native-auth',
      refreshTokenPresent: true,
      tokenExpired: false,
      refreshDue: false,
      tokenExpiresAt: '2026-06-08T02:00:00.000Z',
      usageCachePresent: false,
      codeAssistClientVersion: '2.0.6',
      codeAssistUserAgent: 'Antigravity/2.0.6',
      quotaBaseUrls: ['https://daily-cloudcode-pa.googleapis.com/v1internal']
    },
    5: {
      id: '5',
      nativeAuthPresent: true,
      nativeAccessTokenPresent: true,
      envAccessTokenPresent: false,
      selectedTokenSource: 'app-state.db:native-auth',
      refreshTokenPresent: true,
      tokenExpired: true,
      refreshDue: true,
      tokenExpiresAt: '2026-06-05T11:16:17.493Z',
      usageCachePresent: false,
      codeAssistClientVersion: '2.0.6',
      codeAssistUserAgent: 'Antigravity/2.0.6',
      quotaBaseUrls: ['https://daily-cloudcode-pa.googleapis.com/v1internal']
    }
  };
  const { service } = createPresenterHarness({
    getToolAccountIds: () => ['5', '1'],
    ensureUsageSnapshotAsync: async () => {
      throw new Error('preflight must not refresh usage');
    },
    buildAgyUsagePreflight: (_provider, accountRef) => (
      accountRef === accountRefForId('1') ? reports[1] : reports[5]
    )
  });
  const logs = [];
  const oldLog = console.log;
  console.log = (message) => logs.push(String(message));
  try {
    await service.printAllUsageSnapshots('agy', { preflight: true });
  } finally {
    console.log = oldLog;
  }

  assert.equal(logs.some((line) => line.includes('AGY usage preflight for all local accounts')), true);
  assert.equal(logs.some((line) => line.includes('Account ID 1') && line.includes('refreshDue=no')), true);
  assert.equal(logs.some((line) => line.includes('Account ID 5') && line.includes('refreshDue=yes')), true);
  assert.equal(logs.some((line) => line.includes('direct_ready=1')), true);
  assert.equal(logs.some((line) => line.includes('Recommended first live probe target: agy Account ID 1')), true);
});

test('printAllUsageSnapshots preserves manually disabled status when updating indexed usage state', async () => {
  const snapshot = {
    capturedAt: Date.now(),
    kind: 'codex_oauth_status',
    entries: [
      { window: '5h', remainingPct: 21 }
    ]
  };
  const { service, upserts } = createPresenterHarness({
    fs: {
      existsSync(filePath) {
        return String(filePath).endsWith('/.aih_status');
      },
      readFileSync(filePath) {
        if (String(filePath).endsWith('/.aih_status')) return 'down\n';
        throw new Error(`unexpected_read:${filePath}`);
      }
    },
    getAccountStateIndex: () => ({
      getAccountState: () => ({
        status: 'down'
      })
    }),
    ensureUsageSnapshotAsync: async () => snapshot
  });
  const oldLog = console.log;
  console.log = () => {};
  try {
    await service.printAllUsageSnapshots('codex', { jobs: 1 });
  } finally {
    console.log = oldLog;
  }

  assert.equal(upserts.length > 0, true);
  assert.equal(upserts[0].status, 'down');
  assert.equal(upserts[0].remainingPct, 21);
});
