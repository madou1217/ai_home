const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { handleManagementRequest } = require('../lib/server/management-router');

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
        codex: [{ id: '11' }, { id: '12' }],
        gemini: [{ id: '21' }],
        claude: []
      }),
      applyReloadState: (s, runtimeAccounts) => {
        s.accounts = runtimeAccounts;
      },
      fs: {},
      getToolAccountIds: () => [],
      getToolConfigDir: () => '',
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
    providers: {
      codex: 2,
      gemini: 1,
      claude: 0
    }
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

  const watchHandled = await handleManagementRequest({
    method: 'GET',
    pathname: '/v0/management/watch',
    url: new URL('http://localhost/v0/management/watch'),
    req,
    res,
    options: {
      backend: 'local',
      host: '127.0.0.1',
      port: 8317,
      provider: 'codex',
      clientKey: ''
    },
    state,
    requiredManagementKey: '',
    deps: {
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
    }
  });

  assert.equal(watchHandled, true);
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /"type":"snapshot"/);
  assert.match(res.body, /"cooldownUntil":123/);

  const clearRes = createResCapture();
  const clearHandled = await handleManagementRequest({
    method: 'POST',
    pathname: '/v0/management/cooldown/clear',
    url: new URL('http://localhost/v0/management/cooldown/clear'),
    req: { headers: {} },
    res: clearRes,
    options: {
      backend: 'local',
      host: '127.0.0.1',
      port: 8317,
      provider: 'codex',
      clientKey: ''
    },
    state,
    requiredManagementKey: '',
    deps: {
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
    }
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
        id: 'c1',
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
        codex: [{ id: 'c1' }],
        gemini: [{ id: 'g1' }, { id: 'g2' }],
        claude: []
      }),
      applyReloadState: (s, runtime) => {
        s.accounts.codex = runtime.codex.slice();
        s.accounts.gemini = runtime.gemini.slice();
        s.accounts.claude = runtime.claude.slice();
      },
      fs: {},
      getToolAccountIds: () => [],
      getToolConfigDir: () => '',
      getProfileDir: () => '',
      checkStatus: () => ({ configured: true })
    }
  });
  assert.equal(reloadHandled, true);
  assert.equal(reloadRes.statusCode, 200);
  assert.deepEqual(JSON.parse(reloadRes.body), {
    ok: true,
    reloaded: 3,
    providers: { codex: 1, gemini: 2, claude: 0 }
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
      accountStateIndex: {
        upsertRuntimeState(provider, accountId, runtimeState, baseState) {
          runtimeClears.push({ provider, accountId, runtimeState, baseState });
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
  assert.deepEqual(runtimeClears.map((item) => [item.provider, item.accountId, item.runtimeState]), [
    ['codex', 'c1', null],
    ['gemini', 'g1', null],
    ['gemini', 'g2', null]
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
