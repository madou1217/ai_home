const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { handleManagementRequest } = require('../lib/server/management-router');
const { buildManagementModelsResponse } = require('../lib/server/model-endpoints');
const { normalizeMetricErrors } = require('../lib/server/management');
const { SUPPORTED_SERVER_PROVIDERS } = require('../lib/server/providers');

const MANAGEMENT_GEMINI_ACCOUNT_REF = 'acct_0123456789abcdefabcd';
const MANAGEMENT_CODEX_ACCOUNT_REF = 'acct_11111111111111111111';
const MANAGEMENT_GEMINI_SECOND_REF = 'acct_22222222222222222222';
const MANAGEMENT_CODEX_SECOND_REF = 'acct_33333333333333333333';

function buildProviderCounts(overrides = {}) {
  return Object.fromEntries(SUPPORTED_SERVER_PROVIDERS.map((provider) => [
    provider,
    Number(overrides[provider]) || 0
  ]));
}

test('management metric errors expose accountRef without deriving accountKey', () => {
  const errors = normalizeMetricErrors([{
    provider: 'codex',
    accountId: '7',
    accountKey: 'codex:7',
    accountRef: MANAGEMENT_GEMINI_ACCOUNT_REF,
    error: 'upstream failed'
  }, {
    provider: 'gemini',
    accountId: '9',
    error: 'missing ref'
  }]);

  assert.equal(errors[0].accountRef, MANAGEMENT_GEMINI_ACCOUNT_REF);
  assert.equal(Object.prototype.hasOwnProperty.call(errors[0], 'accountKey'), false);
  assert.equal(errors[1].accountRef, '');
  assert.equal(Object.prototype.hasOwnProperty.call(errors[1], 'accountKey'), false);
});

test('management metric errors format friendly account label and preserve project/session context', () => {
  const mockAccounts = {
    codex: [
      { accountRef: 'acct_123', email: 'user@example.com' },
      { accountRef: 'acct_456', apiKeyMode: true }
    ]
  };
  const errors = normalizeMetricErrors([{
    provider: 'codex',
    accountRef: 'acct_123',
    model: 'gpt-5',
    sessionId: 'sess_abc',
    projectPath: '/Users/test/projects/my-app',
    projectDirName: 'my-app',
    error: 'rate_limited'
  }, {
    provider: 'codex',
    accountRef: 'acct_456',
    error: 'auth_failed'
  }, {
    provider: 'codex',
    attemptedAccountRefs: ['acct_1', 'acct_2'],
    error: 'upstream_failed'
  }], mockAccounts);

  assert.equal(errors[0].accountLabel, 'user@example.com');
  assert.equal(errors[0].model, 'gpt-5');
  assert.equal(errors[0].sessionId, 'sess_abc');
  assert.equal(errors[0].projectPath, '/Users/test/projects/my-app');
  assert.equal(errors[0].projectDirName, 'my-app');
  assert.equal(errors[1].accountLabel, 'CODEX 密钥账号');
  assert.equal(errors[2].accountLabel, '尝试了 2 个账号');
  assert.equal(errors[2].attemptedCount, 2);
});

test('management metric errors preserve cross-provider routing and model alias context', () => {
  const errors = normalizeMetricErrors([{
    provider: 'agy',
    effectiveProvider: 'agy',
    familyProvider: 'claude',
    clientProtocol: 'anthropic_messages',
    requestedModel: 'claude-3-7-sonnet',
    effectiveModel: 'agy.gemini-2.5-flash',
    aliasTarget: 'gemini-2.5-flash',
    aliasMatched: true,
    message: 'hit usage limit',
    error: 'upstream_failed'
  }]);

  assert.equal(errors[0].provider, 'agy');
  assert.equal(errors[0].effectiveProvider, 'agy');
  assert.equal(errors[0].familyProvider, 'claude');
  assert.equal(errors[0].clientProtocol, 'anthropic_messages');
  assert.equal(errors[0].requestedModel, 'claude-3-7-sonnet');
  assert.equal(errors[0].effectiveModel, 'agy.gemini-2.5-flash');
  assert.equal(errors[0].aliasTarget, 'gemini-2.5-flash');
  assert.equal(errors[0].aliasMatched, true);
});

function createResCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v; },
    end(chunk = '') { this.body = String(chunk); }
  };
}

function createStreamResCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers = {}) {
      this.statusCode = code;
      this.headers = { ...this.headers, ...headers };
    },
    setHeader(key, value) {
      this.headers[key] = value;
    },
    write(chunk = '') {
      this.body += String(chunk);
      return true;
    },
    end(chunk = '') {
      this.body += String(chunk);
    }
  };
}

test('management router returns false for non-management path', async () => {
  const res = createResCapture();
  const handled = await handleManagementRequest({
    method: 'GET',
    pathname: '/v1/models',
    url: new URL('http://localhost/v1/models'),
    req: { headers: {} },
    res,
    options: {},
    state: {},
    requiredManagementKey: '',
    deps: {}
  });
  assert.equal(handled, false);
});

test('management router fails closed for remote peers when no Management Key is configured', async () => {
  const res = createResCapture();
  const handled = await handleManagementRequest({
    method: 'GET',
    pathname: '/v0/management/status',
    url: new URL('http://server.example.com/v0/management/status'),
    req: { socket: { remoteAddress: '192.0.2.10' }, headers: {} },
    res,
    options: {},
    state: {},
    requiredManagementKey: '',
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (target, statusCode, payload) => {
        target.statusCode = statusCode;
        target.end(JSON.stringify(payload));
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'management_key_not_configured' });
});

test('management models uses remote Gemini catalog instead of stale snapshots', async () => {
  const res = createResCapture();
  let fetchCalls = 0;
  const handled = await handleManagementRequest({
    method: 'GET',
    pathname: '/v0/management/models',
    url: new URL('http://localhost/v0/management/models?refresh=1'),
    req: { headers: {} },
    res,
    options: { provider: 'gemini' },
    state: {
      accounts: {
        codex: [],
        gemini: [{
          id: 'g1',
          accountRef: MANAGEMENT_GEMINI_ACCOUNT_REF,
          provider: 'gemini',
          accessToken: 'token-g1',
          availableModels: ['gemini-2.5-pro']
        }],
        claude: []
      },
      modelRegistry: {
        providers: {
          codex: new Set(),
          gemini: new Set(),
          claude: new Set()
        }
      },
      modelsCache: { ids: [], updatedAt: 0, byAccount: {}, sourceCount: 0 }
    },
    requiredManagementKey: '',
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      buildManagementModelsResponse,
      fetchModelsForAccount: async (options, account) => {
        fetchCalls += 1;
        assert.equal(account.id, 'g1');
        assert.equal(options.ignoreAvailableModelsSnapshot, true);
        return ['gemini-3.1-pro-preview', 'gemini-2.5-flash'];
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(fetchCalls, 1);
  assert.equal(body.source, 'remote');
  assert.equal(body.scannedAccounts, 1);
  assert.deepEqual(body.models, ['gemini-2.5-flash', 'gemini-3.1-pro-preview']);
});

test('management router enforces key and returns unauthorized', async () => {
  const res = createResCapture();
  const handled = await handleManagementRequest({
    method: 'GET',
    pathname: '/v0/management/status',
    url: new URL('http://localhost/v0/management/status'),
    req: { headers: { authorization: 'Bearer wrong' } },
    res,
    options: {},
    state: {},
    requiredManagementKey: 'secret',
    deps: {
      parseAuthorizationBearer: (h) => String(h || '').replace(/^Bearer\s+/i, ''),
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); }
    }
  });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 401);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'unauthorized_management');
});

test('management router reload endpoint returns deterministic payload', async () => {
  const res = createResCapture();
  const state = {
    accounts: {
      codex: [{ id: '1' }],
      gemini: [{ id: '2' }],
      claude: []
    }
  };
  const handled = await handleManagementRequest({
    method: 'POST',
    pathname: '/v0/management/reload',
    url: new URL('http://localhost/v0/management/reload'),
    req: { headers: {} },
    res,
    options: {},
    state,
    requiredManagementKey: '',
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      loadServerRuntimeAccounts: () => ({
        codex: [
          { accountRef: MANAGEMENT_CODEX_ACCOUNT_REF },
          { accountRef: MANAGEMENT_CODEX_SECOND_REF }
        ],
        gemini: [{ accountRef: MANAGEMENT_GEMINI_ACCOUNT_REF }],
        claude: []
      }),
      applyReloadState: (s, runtimeAccounts) => {
        s.accounts = runtimeAccounts;
      },
      fs: {},
      getProfileDir: () => '',
      checkStatus: () => ({ configured: true })
    }
  });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body, {
    ok: true,
    reloaded: 3,
    providers: buildProviderCounts({ codex: 2, gemini: 1 })
  });
});

test('management router returns stable not_found payload for unknown management endpoint', async () => {
  const res = createResCapture();
  const handled = await handleManagementRequest({
    method: 'GET',
    pathname: '/v0/management/unknown',
    url: new URL('http://localhost/v0/management/unknown'),
    req: { headers: {} },
    res,
    options: {},
    state: {},
    requiredManagementKey: '',
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); }
    }
  });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 404);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'management_not_found');
});

test('management base-state upsert cannot carry an operational status change', async () => {
  const res = createResCapture();
  const calls = [];
  const handled = await handleManagementRequest({
    method: 'POST',
    pathname: '/v0/management/state-index/upsert',
    url: new URL('http://localhost/v0/management/state-index/upsert'),
    req: { headers: {} },
    res,
    options: {},
    state: {},
    requiredManagementKey: '',
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        accountRef: MANAGEMENT_CODEX_ACCOUNT_REF,
        provider: 'codex',
        state: { status: 'down', configured: true }
      })),
      accountStateService: {
        syncAccountBaseState(accountRef, provider, baseState) {
          calls.push({ operation: 'base', accountRef, provider, baseState });
          return true;
        },
        setOperationalStatus() {
          calls.push({ operation: 'operational' });
          return true;
        }
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, [{
    operation: 'base',
    accountRef: MANAGEMENT_CODEX_ACCOUNT_REF,
    provider: 'codex',
    baseState: { configured: true }
  }]);
});

test('management operational-status route uses only the explicit status command', async () => {
  const res = createResCapture();
  const calls = [];
  const handled = await handleManagementRequest({
    method: 'POST',
    pathname: '/v0/management/state-index/operational-status',
    url: new URL('http://localhost/v0/management/state-index/operational-status'),
    req: { headers: {} },
    res,
    options: {},
    state: {},
    requiredManagementKey: '',
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      readRequestBody: async () => Buffer.from(JSON.stringify({
        accountRef: MANAGEMENT_CODEX_ACCOUNT_REF,
        provider: 'codex',
        status: 'up',
        baseState: { status: 'down', configured: true }
      })),
      accountStateService: {
        syncAccountBaseState() {
          calls.push({ operation: 'base' });
          return true;
        },
        setOperationalStatus(accountRef, provider, status, baseState) {
          calls.push({ operation: 'operational', accountRef, provider, status, baseState });
          return true;
        }
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, [{
    operation: 'operational',
    accountRef: MANAGEMENT_CODEX_ACCOUNT_REF,
    provider: 'codex',
    status: 'up',
    baseState: { configured: true }
  }]);
});

test('management router serves model usage stats without implicit scan', async () => {
  const res = createResCapture();
  let scanCalls = 0;
  let pricingSyncCalls = 0;
  const handled = await handleManagementRequest({
    method: 'GET',
    pathname: '/v0/management/usage/stats',
    url: new URL('http://localhost/v0/management/usage/stats?from=2026-06-01&to=2026-06-04&provider=codex'),
    req: { headers: {} },
    res,
    options: {},
    state: {},
    requiredManagementKey: '',
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      modelUsageService: {
        syncPricingIfStale: async () => {
          pricingSyncCalls += 1;
          return { ok: true, synced: false, reason: 'fresh' };
        },
        scan: () => { scanCalls += 1; },
        getStats: (query) => ({
          provider: query.provider,
          totalCalls: 2,
          totalTokens: 12
        })
      }
    }
  });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(pricingSyncCalls, 1);
  assert.equal(scanCalls, 0);
  const body = JSON.parse(res.body);
  assert.equal(body.range.from, '2026-06-01');
  assert.equal(body.range.to, '2026-06-04');
  assert.deepEqual(body.stats, {
    provider: 'codex',
    totalCalls: 2,
    totalTokens: 12
  });
});

test('management router serves usage and error request details from one query', async () => {
  const res = createResCapture();
  let capturedQuery = null;
  const details = {
    usage: [{ requestId: 'req-usage', model: 'gpt-5.6-sol' }],
    errors: [{ requestId: 'req-error', statusCode: 502 }]
  };
  const handled = await handleManagementRequest({
    method: 'GET',
    pathname: '/v0/management/usage/requests',
    url: new URL('http://localhost/v0/management/usage/requests?from=2026-08-23&to=2026-08-23&provider=codex&limit=80'),
    req: { headers: {} },
    res,
    options: {},
    state: {},
    requiredManagementKey: '',
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      modelUsageService: {
        syncPricingIfStale: async () => ({ ok: true }),
        getRequestDetails: () => {
          throw new Error('sync request details must stay off the server thread');
        },
        getRequestDetailsAsync: async (query) => {
          capturedQuery = query;
          return details;
        }
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(capturedQuery.provider, 'codex');
  assert.equal(capturedQuery.limit, 80);
  assert.deepEqual(JSON.parse(res.body), {
    ok: true,
    range: { from: '2026-08-23', to: '2026-08-23' },
    ...details
  });
});

test('management router accepts model usage date-time range', async () => {
  const res = createResCapture();
  let capturedQuery = null;
  const from = '2026-06-04T17:00:00+08:00';
  const to = '2026-06-04T18:00:00+08:00';
  const handled = await handleManagementRequest({
    method: 'GET',
    pathname: '/v0/management/usage/stats',
    url: new URL(`http://localhost/v0/management/usage/stats?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&provider=gemini`),
    req: { headers: {} },
    res,
    options: {},
    state: {},
    requiredManagementKey: '',
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      modelUsageService: {
        syncPricingIfStale: async () => ({ ok: true }),
        getStats: (query) => {
          capturedQuery = query;
          return { totalCalls: 0, totalTokens: 0 };
        }
      }
    }
  });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(capturedQuery.provider, 'gemini');
  assert.equal(capturedQuery.fromMs, Date.parse(from));
  assert.equal(capturedQuery.toMs, Date.parse(to));
});

test('management router runs model usage aggregation through the async worker boundary', async () => {
  const res = createResCapture();
  let asyncCalls = 0;
  let syncCalls = 0;
  const handled = await handleManagementRequest({
    method: 'GET',
    pathname: '/v0/management/usage/models',
    url: new URL('http://localhost/v0/management/usage/models?from=2026-06-01&to=2026-06-04&limit=500'),
    req: { headers: {} },
    res,
    options: {},
    state: {},
    requiredManagementKey: '',
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      modelUsageService: {
        syncPricingIfStale: async () => ({ ok: true }),
        getCostByModelAsync: async (query) => {
          asyncCalls += 1;
          assert.equal(query.limit, 500);
          return [{ provider: 'codex', model: 'gpt-5.1-codex', calls: 1 }];
        },
        getCostByModel: () => {
          syncCalls += 1;
          return [];
        }
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(asyncCalls, 1);
  assert.equal(syncCalls, 0);
  assert.deepEqual(JSON.parse(res.body).models, [
    { provider: 'codex', model: 'gpt-5.1-codex', calls: 1 }
  ]);
});

test('management router returns one usage dashboard snapshot through the async worker boundary', async () => {
  const res = createResCapture();
  let asyncCalls = 0;
  let syncCalls = 0;
  const snapshot = {
    stats: { totalCalls: 1, totalTokens: 20 },
    models: [{ provider: 'codex', model: 'gpt-5.1-codex', calls: 1 }],
    sessions: [{ provider: 'codex', sessionId: 'dashboard-session', calls: 1 }],
    modelOptions: [{ provider: 'codex', model: 'gpt-5.1-codex', calls: 1 }]
  };
  const handled = await handleManagementRequest({
    method: 'GET',
    pathname: '/v0/management/usage/dashboard',
    url: new URL('http://localhost/v0/management/usage/dashboard?from=2026-06-01&to=2026-06-04&provider=codex&limit=50'),
    req: { headers: {} },
    res,
    options: {},
    state: {},
    requiredManagementKey: '',
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      modelUsageService: {
        syncPricingIfStale: async () => ({ ok: true }),
        getDashboardAsync: async (query) => {
          asyncCalls += 1;
          assert.equal(query.provider, 'codex');
          assert.equal(query.limit, 50);
          return snapshot;
        },
        getDashboard: () => {
          syncCalls += 1;
          return {};
        }
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(asyncCalls, 1);
  assert.equal(syncCalls, 0);
  assert.deepEqual(JSON.parse(res.body), {
    ok: true,
    range: { from: '2026-06-01', to: '2026-06-04' },
    ...snapshot
  });
});

test('management usage dashboard query streams cumulative shards and supports cancellation', async () => {
  const state = {};
  const writes = [];
  const watchReq = new EventEmitter();
  watchReq.headers = {};
  const watchRes = createStreamResCapture();
  watchRes.write = (chunk = '') => {
    writes.push(String(chunk));
    watchRes.body += String(chunk);
    return true;
  };
  const writeJson = (response, code, payload) => {
    response.statusCode = code;
    response.end(JSON.stringify(payload));
  };
  let releaseQuery;
  let capturedSignal;
  const dashboard = {
    stats: { totalCalls: 2, totalSessions: 1, totalTokens: 30 },
    models: [{ provider: 'codex', model: 'gpt-5.1-codex', calls: 2 }],
    sessions: [{ provider: 'codex', sessionId: 'progressive-session', calls: 2 }],
    modelOptions: [{ provider: 'codex', model: 'gpt-5.1-codex', calls: 2 }]
  };
  const modelUsageService = {
    getDashboardProgressive: async (query, options) => {
      assert.equal(query.provider, 'codex');
      capturedSignal = options.signal;
      options.onProgress({
        completedShards: 1,
        totalShards: 3,
        dashboard
      });
      await new Promise((resolve) => { releaseQuery = resolve; });
      if (options.signal.aborted) {
        const error = new Error('model_usage_query_cancelled');
        error.code = 'model_usage_query_cancelled';
        throw error;
      }
      return dashboard;
    }
  };
  const deps = {
    parseAuthorizationBearer: () => '',
    writeJson,
    modelUsageService
  };

  const watchHandled = await handleManagementRequest({
    method: 'GET',
    pathname: '/v0/management/usage/dashboard/query/watch',
    url: new URL('http://localhost/v0/management/usage/dashboard/query/watch'),
    req: watchReq,
    res: watchRes,
    options: {},
    state,
    requiredManagementKey: '',
    deps
  });
  assert.equal(watchHandled, true);
  assert.equal(watchRes.statusCode, 200);
  assert.match(writes.join(''), /usage-dashboard-query-snapshot/);

  const postRes = createResCapture();
  const handled = await handleManagementRequest({
    method: 'POST',
    pathname: '/v0/management/usage/dashboard/query',
    url: new URL('http://localhost/v0/management/usage/dashboard/query?from=2026-06-01&to=2026-06-03&provider=codex&limit=50'),
    req: { headers: {} },
    res: postRes,
    options: {},
    state,
    requiredManagementKey: '',
    deps
  });
  assert.equal(handled, true);
  assert.equal(postRes.statusCode, 202);
  const started = JSON.parse(postRes.body);
  assert.equal(started.ok, true);
  assert.equal(started.job.status, 'queued');
  assert.match(started.job.id, /^usage-dashboard-query-/);

  while (!releaseQuery) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(capturedSignal.aborted, false);
  assert.match(writes.join(''), /"completedShards":1/);
  assert.match(writes.join(''), /"totalShards":3/);
  assert.match(writes.join(''), /"totalCalls":2/);

  const deleteRes = createResCapture();
  const deleteHandled = await handleManagementRequest({
    method: 'DELETE',
    pathname: `/v0/management/usage/dashboard/query/${started.job.id}`,
    url: new URL(`http://localhost/v0/management/usage/dashboard/query/${started.job.id}`),
    req: { headers: {} },
    res: deleteRes,
    options: {},
    state,
    requiredManagementKey: '',
    deps
  });
  assert.equal(deleteHandled, true);
  assert.equal(deleteRes.statusCode, 200);
  assert.equal(capturedSignal.aborted, true);
  assert.equal(JSON.parse(deleteRes.body).job.status, 'cancelled');
  assert.match(writes.join(''), /"status":"cancelled"/);

  releaseQuery();
  await new Promise((resolve) => setImmediate(resolve));
});

test('management usage scan starts async job and streams progress', async () => {
  let releaseScan;
  const tokenUsageUpdates = [];
  const state = {};
  const writes = [];
  const req = new EventEmitter();
  req.headers = {};
  const streamRes = createStreamResCapture();
  const writeJson = (response, code, payload) => {
    response.statusCode = code;
    response.end(JSON.stringify(payload));
  };
  streamRes.write = (chunk = '') => {
    writes.push(String(chunk));
    streamRes.body += String(chunk);
    return true;
  };

  const watchHandled = await handleManagementRequest({
    method: 'GET',
    pathname: '/v0/management/usage/scan/watch',
    url: new URL('http://localhost/v0/management/usage/scan/watch'),
    req,
    res: streamRes,
    options: {},
    state,
    requiredManagementKey: '',
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson,
      modelUsageService: {
        scan: () => ({})
      }
    }
  });
  assert.equal(watchHandled, true);
  assert.equal(streamRes.statusCode, 200);
  assert.match(writes.join(''), /usage-scan-snapshot/);

  const postRes = createResCapture();
  const handled = await handleManagementRequest({
    method: 'POST',
    pathname: '/v0/management/usage/scan',
    url: new URL('http://localhost/v0/management/usage/scan?from=2026-06-01&to=2026-06-01&provider=codex'),
    req: { headers: {} },
    res: postRes,
    options: {},
    state,
    requiredManagementKey: '',
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson,
      modelUsageService: {
        syncPricingIfStale: async () => {},
        scan: (options) => new Promise((resolve) => {
          assert.deepEqual(options, { provider: 'codex' });
          releaseScan = () => resolve({
            files: 3,
            records: 5,
            prompts: 2,
            skipped: 0,
            providers: {
              codex: { files: 3, records: 5, prompts: 2, skipped: 0 }
            }
          });
        }),
        getAccountTokenUsageAsync: async (options) => {
          assert.deepEqual(options.dimensions, ['day', 'week', 'month', 'total']);
          return {
            acct_0123456789abcdefabcd: {
              day: 500,
              week: 500,
              month: 500,
              total: 500,
              models: [{ model: 'gpt-5.1', day: 500, week: 500, month: 500, total: 500 }]
            }
          };
        }
      },
      onTokenUsageUpdated: (usage, options) => {
        tokenUsageUpdates.push({ usage, options });
      }
    }
  });
  assert.equal(handled, true);
  assert.equal(postRes.statusCode, 202);
  const postBody = JSON.parse(postRes.body);
  assert.equal(postBody.ok, true);
  assert.equal(postBody.accepted, true);
  assert.equal(postBody.job.status, 'queued');
  assert.equal(postBody.job.provider, 'codex');
  assert.equal(Object.prototype.hasOwnProperty.call(postBody, 'result'), false);

  await new Promise((resolve) => setImmediate(resolve));
  assert.match(writes.join(''), /"status":"running"/);
  releaseScan();
  await new Promise((resolve) => setImmediate(resolve));

  const streamed = writes.join('');
  assert.match(streamed, /"type":"usage-scan-job"/);
  assert.match(streamed, /"status":"succeeded"/);
  assert.match(streamed, /"records":5/);
  assert.deepEqual(tokenUsageUpdates, [{
    usage: {
      acct_0123456789abcdefabcd: {
        day: 500,
        week: 500,
        month: 500,
        total: 500,
        models: [{ model: 'gpt-5.1', day: 500, week: 500, month: 500, total: 500 }]
      }
    },
    options: { dimensions: ['day', 'week', 'month', 'total'], generatedAt: tokenUsageUpdates[0].options.generatedAt }
  }]);
  req.emit('close');
});

test('management watch streams snapshot immediately and pushes updates after cooldown clear', async () => {
  const state = {
    startedAt: Date.now() - 5_000,
    strategy: 'round-robin',
    accounts: {
      codex: [{
        id: '1',
        provider: 'codex',
        cooldownUntil: 123,
        consecutiveFailures: 2,
        successCount: 1,
        failCount: 2,
        lastRefresh: 0,
        remainingPct: 50
      }],
      gemini: [],
      claude: []
    },
    metrics: {
      totalRequests: 0,
      totalSuccess: 0,
      totalFailures: 0,
      totalTimeouts: 0,
      routeCounts: {},
      providerCounts: {},
      providerSuccess: {},
      providerFailures: {},
      lastErrors: []
    },
    sessionAffinity: {
      codex: new Map(),
      gemini: new Map(),
      claude: new Map()
    },
    executors: {},
    modelsCache: { ids: [], updatedAt: 0, byAccount: {}, sourceCount: 0 },
    modelRegistry: { updatedAt: 0 }
  };
  const req = new EventEmitter();
  req.headers = {};
  const res = createStreamResCapture();
  const jsonWriter = (response, code, payload) => {
    response.statusCode = code;
    response.end(JSON.stringify(payload));
  };
  const options = {
    backend: 'local',
    host: '127.0.0.1',
    port: 8317,
    provider: 'codex',
    clientKey: ''
  };
  const deps = {
    parseAuthorizationBearer: () => '',
    writeJson: jsonWriter,
    buildManagementStatusPayload: (currentState) => ({
      ok: true,
      totalAccounts: currentState.accounts.codex.length,
      activeAccounts: currentState.accounts.codex.filter((item) => !item.cooldownUntil).length,
      totalRequests: currentState.metrics.totalRequests,
      uptimeSec: 5
    }),
    buildManagementMetricsPayload: () => ({
      ok: true,
      totalRequests: 0,
      totalSuccess: 0,
      totalFailures: 0,
      totalTimeouts: 0,
      successRate: 0,
      timeoutRate: 0,
      routeCounts: {},
      providerCounts: {},
      providerSuccess: {},
      providerFailures: {},
      queue: {},
      lastErrors: []
    }),
    buildManagementAccountsPayload: (currentState) => ({
      ok: true,
      accounts: currentState.accounts.codex.map((item) => ({
        id: item.id,
        provider: 'codex',
        cooldownUntil: item.cooldownUntil,
        consecutiveFailures: item.consecutiveFailures,
        remainingPct: item.remainingPct,
        hasAccessToken: false,
        hasRefreshToken: false,
        lastRefresh: 0,
        successCount: item.successCount,
        failCount: item.failCount,
        lastError: ''
      }))
    }),
    fs: {},
    getProfileDir: () => '',
    getToolConfigDir: () => ''
  };

  const watchHandled = await handleManagementRequest({
    method: 'GET',
    pathname: '/v0/management/watch',
    url: new URL('http://localhost/v0/management/watch'),
    req,
    res,
    options,
    state,
    requiredManagementKey: '',
    deps
  });

  assert.equal(watchHandled, true);
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /"type":"snapshot"/);
  assert.match(res.body, /"cooldownUntil":123/);

  const bodyBeforeSnapshotRequest = res.body;
  const snapshotRes = createResCapture();
  const snapshotHandled = await handleManagementRequest({
    method: 'POST',
    pathname: '/v0/management/watch/snapshot',
    url: new URL('http://localhost/v0/management/watch/snapshot'),
    req: { headers: {} },
    res: snapshotRes,
    options,
    state,
    requiredManagementKey: '',
    deps
  });

  assert.equal(snapshotHandled, true);
  assert.equal(snapshotRes.statusCode, 202);
  assert.equal(JSON.parse(snapshotRes.body).broadcasted, true);
  assert.ok(res.body.length > bodyBeforeSnapshotRequest.length);

  const clearRes = createResCapture();
  const clearHandled = await handleManagementRequest({
    method: 'POST',
    pathname: '/v0/management/cooldown/clear',
    url: new URL('http://localhost/v0/management/cooldown/clear'),
    req: { headers: {} },
    res: clearRes,
    options,
    state,
    requiredManagementKey: '',
    deps
  });

  assert.equal(clearHandled, true);
  assert.equal(clearRes.statusCode, 200);
  assert.match(res.body, /"cooldownUntil":0/);
  req.emit('close');
});

test('management router supports reload and cooldown clear contracts', async () => {
  const state = {
    accounts: {
      codex: [{
        accountRef: MANAGEMENT_CODEX_ACCOUNT_REF,
        cooldownUntil: 123,
        consecutiveFailures: 3,
        lastError: 'upstream_403',
        lastFailureKind: 'auth_invalid',
        lastFailureReason: 'upstream_403',
        lastFailureAt: 123,
        authInvalidUntil: 123
      }],
      gemini: [{ cooldownUntil: 456, consecutiveFailures: 2 }],
      claude: [{ cooldownUntil: 789, consecutiveFailures: 4 }]
    }
  };
  const jsonWriter = (r, code, payload) => {
    r.statusCode = code;
    r.end(JSON.stringify(payload));
  };

  const reloadRes = createResCapture();
  const reloadHandled = await handleManagementRequest({
    method: 'POST',
    pathname: '/v0/management/reload',
    url: new URL('http://localhost/v0/management/reload'),
    req: { headers: {} },
    res: reloadRes,
    options: {},
    state,
    requiredManagementKey: '',
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: jsonWriter,
      loadServerRuntimeAccounts: () => ({
        codex: [{ accountRef: MANAGEMENT_CODEX_ACCOUNT_REF }],
        gemini: [
          { accountRef: MANAGEMENT_GEMINI_ACCOUNT_REF },
          { accountRef: MANAGEMENT_GEMINI_SECOND_REF }
        ],
        claude: []
      }),
      applyReloadState: (s, runtime) => {
        s.accounts.codex = runtime.codex.slice();
        s.accounts.gemini = runtime.gemini.slice();
        s.accounts.claude = runtime.claude.slice();
      },
      fs: {},
      getProfileDir: () => '',
      checkStatus: () => ({ configured: true })
    }
  });
  assert.equal(reloadHandled, true);
  assert.equal(reloadRes.statusCode, 200);
  assert.deepEqual(JSON.parse(reloadRes.body), {
    ok: true,
    reloaded: 3,
    providers: buildProviderCounts({ codex: 1, gemini: 2 })
  });

  const clearRes = createResCapture();
  const runtimeClears = [];
  const clearHandled = await handleManagementRequest({
    method: 'POST',
    pathname: '/v0/management/cooldown/clear',
    url: new URL('http://localhost/v0/management/cooldown/clear'),
    req: { headers: {} },
    res: clearRes,
    options: {},
    state,
    requiredManagementKey: '',
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: jsonWriter,
      accountStateService: {
        clearRuntimeBlock(accountRef, provider, options) {
          const { evidence: _evidence, ...baseState } = options;
          runtimeClears.push({ provider, accountRef, runtimeState: null, baseState });
          return true;
        }
      }
    }
  });
  assert.equal(clearHandled, true);
  assert.equal(clearRes.statusCode, 200);
  assert.deepEqual(JSON.parse(clearRes.body), { ok: true });
  assert.equal(state.accounts.codex[0].cooldownUntil, 0);
  assert.equal(state.accounts.codex[0].consecutiveFailures, 0);
  assert.equal(state.accounts.codex[0].lastError, '');
  assert.equal(state.accounts.codex[0].lastFailureKind, '');
  assert.equal(state.accounts.codex[0].authInvalidUntil, 0);
  assert.equal(state.accounts.gemini[0].cooldownUntil, 0);
  assert.equal(state.accounts.gemini[0].consecutiveFailures, 0);
  assert.equal(state.accounts.claude[0], undefined);
  assert.deepEqual(runtimeClears.map((item) => [item.provider, item.accountRef, item.runtimeState]), [
    ['codex', MANAGEMENT_CODEX_ACCOUNT_REF, null],
    ['gemini', MANAGEMENT_GEMINI_ACCOUNT_REF, null],
    ['gemini', MANAGEMENT_GEMINI_SECOND_REF, null]
  ]);
});

test('management restart endpoint returns deterministic payload', async () => {
  const res = createResCapture();
  const handled = await handleManagementRequest({
    method: 'POST',
    pathname: '/v0/management/restart',
    url: new URL('http://localhost/v0/management/restart'),
    req: { headers: {} },
    res,
    options: {},
    state: {},
    requiredManagementKey: '',
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      restartProxy: async () => ({
        running: true,
        started: {
          started: true,
          pid: 2456,
          appliedConfig: {
            port: 11435,
            host: '127.0.0.1'
          }
        },
        stopped: {
          stopped: true,
          reason: 'restart',
          forced: false
        }
      })
    }
  });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body, {
    ok: true,
    action: 'restart',
    running: true,
    pid: 2456,
    started: true,
    stopped: {
      stopped: true,
      reason: 'restart',
      forced: false
    },
    appliedConfig: {
      port: 11435,
      host: '127.0.0.1'
    }
  });
});

// 回归：reload 必须把 aiHomeDir 传给账号加载器。漏传时凭据目录一条都读不到，
// 整个账号池会被替换成空池，网关随后全线 no_available_account，只能重启恢复。
test('management router reload passes aiHomeDir to the runtime account loader', async () => {
  const res = createResCapture();
  const state = { accounts: { codex: [{ accountRef: MANAGEMENT_CODEX_ACCOUNT_REF }] } };
  let seenArgs = null;
  await handleManagementRequest({
    method: 'POST',
    pathname: '/v0/management/reload',
    url: new URL('http://localhost/v0/management/reload'),
    req: { headers: {} },
    res,
    options: {},
    state,
    requiredManagementKey: '',
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      loadServerRuntimeAccounts: (args) => {
        seenArgs = args;
        return { codex: [{ accountRef: MANAGEMENT_CODEX_ACCOUNT_REF }] };
      },
      applyReloadState: (s, runtimeAccounts) => { s.accounts = runtimeAccounts; },
      fs: {},
      aiHomeDir: '/tmp/ai-home-fixture',
      getProfileDir: () => '',
      checkStatus: () => ({ configured: true })
    }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(seenArgs && seenArgs.aiHomeDir, '/tmp/ai-home-fixture');
});
