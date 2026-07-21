const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');

const { handleWebUIRequest } = require('../lib/server/web-ui-router');
const { handleManagementRequest } = require('../lib/server/management-router');

function createResCapture() {
  return {
    statusCode: 0,
    body: '',
    writeHead(code) {
      this.statusCode = code;
    },
    end(chunk = '') {
      this.body = String(chunk);
    }
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

function parseSseJsonEvents(body) {
  return String(body || '')
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .flatMap((block) => {
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .join('\n');
      if (!data) return [];
      try {
        return [JSON.parse(data)];
      } catch (_error) {
        return [];
      }
    });
}

async function waitFor(predicate, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForSseEvent(res, predicate, label) {
  await waitFor(() => parseSseJsonEvents(res.body).some(predicate), label);
  return parseSseJsonEvents(res.body).find(predicate);
}

test('web ui server config endpoints store config and trigger restart helper', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-server-config-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  let savedConfig = null;
  let restarted = false;
  const baseDeps = {
    fs,
    aiHomeDir,
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    },
    readRequestBody: async () => null,
    accountStateIndex: {
      getAccountState() { return null; },
      upsertAccountState() {},
      removeAccount() {}
    },
    getToolAccountIds() { return []; },
    getToolConfigDir() { return '/tmp/config'; },
    getProfileDir() { return '/tmp/profile'; },
    loadServerRuntimeAccounts() { return { codex: [], gemini: [], claude: [] }; },
    applyReloadState() {},
    checkStatus() { return { configured: false, accountName: 'Unknown' }; },
    ensureSessionStoreLinks() {},
    readServerConfig() {
      return savedConfig || { host: '127.0.0.1', port: 8317, apiKey: '', managementKey: '', openNetwork: false };
    },
    writeServerConfig(config) {
      savedConfig = { ...(savedConfig || {}), ...config };
      return savedConfig;
    },
    async restartServerWithStoredConfig() {
      restarted = true;
      return { pid: 1234, appliedConfig: savedConfig };
    }
  };

  const setRes = createResCapture();
  const setHandled = await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/server-config',
    url: new URL('http://localhost/v0/webui/server-config'),
    req: { headers: {} },
    res: setRes,
    options: {},
    state: {},
    deps: {
      ...baseDeps,
      readRequestBody: async () => Buffer.from(JSON.stringify({
        config: { host: '0.0.0.0', port: 9000, apiKey: 'x', openNetwork: true }
      }), 'utf8')
    }
  });
  assert.equal(setHandled, true);
  assert.equal(setRes.statusCode, 200);
  const setPayload = JSON.parse(setRes.body);
  assert.equal(setPayload.config.apiKey, '');
  assert.equal(setPayload.config.managementKey, '');
  assert.equal(setPayload.config.apiKeyConfigured, true);
  assert.equal(setPayload.config.managementKeyConfigured, false);
  assert.doesNotMatch(setRes.body, /"apiKey":"x"/);

  const getRes = createResCapture();
  const getHandled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/server-config',
    url: new URL('http://localhost/v0/webui/server-config'),
    req: { headers: {} },
    res: getRes,
    options: {},
    state: {},
    deps: baseDeps
  });
  assert.equal(getHandled, true);
  const getPayload = JSON.parse(getRes.body);
  assert.equal(getPayload.config.port, 9000);
  assert.equal(getPayload.config.apiKey, '');
  assert.equal(getPayload.config.managementKey, '');
  assert.equal(getPayload.config.apiKeyConfigured, true);
  assert.equal(getPayload.config.managementKeyConfigured, false);
  assert.doesNotMatch(getRes.body, /"apiKey":"x"/);

  const partialRes = createResCapture();
  await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/server-config',
    url: new URL('http://localhost/v0/webui/server-config'),
    req: { headers: {} },
    res: partialRes,
    options: {},
    state: {},
    deps: {
      ...baseDeps,
      readRequestBody: async () => Buffer.from(JSON.stringify({
        config: { port: 9001, apiKey: '', managementKey: '' }
      }), 'utf8')
    }
  });
  assert.equal(savedConfig.port, 9001);
  assert.equal(savedConfig.apiKey, 'x');
  assert.equal(savedConfig.managementKey, undefined);

  const rejectedKeyRes = createResCapture();
  await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/server-config',
    url: new URL('http://localhost/v0/webui/server-config'),
    req: { headers: {} },
    res: rejectedKeyRes,
    options: {},
    state: {},
    deps: {
      ...baseDeps,
      readRequestBody: async () => Buffer.from(JSON.stringify({
        config: { managementKey: 'must-use-the-dedicated-rotation-route' }
      }), 'utf8')
    }
  });
  assert.equal(rejectedKeyRes.statusCode, 400);
  assert.equal(JSON.parse(rejectedKeyRes.body).error, 'management_key_rotation_required');
  assert.equal(savedConfig.managementKey, undefined);

  const rotatedKey = 'rotated-management-key-that-is-long-enough';
  const rotateRes = createResCapture();
  const rotations = [];
  await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/server-config/management-key/rotate',
    url: new URL('http://localhost/v0/webui/server-config/management-key/rotate'),
    req: { headers: { authorization: 'Bearer current-key' } },
    res: rotateRes,
    options: {},
    state: {},
    deps: {
      ...baseDeps,
      readRequestBody: async () => Buffer.from(JSON.stringify({ managementKey: rotatedKey }), 'utf8'),
      rotateManagementKey(input) {
        rotations.push(input);
        savedConfig.managementKey = input.managementKey;
        return { managementKeyConfigured: true, rotatedAt: 123 };
      }
    }
  });
  assert.equal(rotateRes.statusCode, 200);
  assert.deepEqual(JSON.parse(rotateRes.body), {
    ok: true,
    managementKeyConfigured: true,
    rotatedAt: 123
  });
  assert.equal(rotations.length, 1);
  assert.equal(rotations[0].managementKey, rotatedKey);
  assert.equal(rotateRes.body.includes(rotatedKey), false);

  const restartRes = createResCapture();
  const restartHandled = await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/server/restart',
    url: new URL('http://localhost/v0/webui/server/restart'),
    req: { headers: {} },
    res: restartRes,
    options: {},
    state: {},
    deps: baseDeps
  });
  assert.equal(restartHandled, true);
  assert.equal(restartRes.statusCode, 202);
  assert.equal(restarted, false);
  const restartBody = JSON.parse(restartRes.body);
  assert.equal(restartBody.accepted, true);
  assert.equal(restartBody.restarting, true);
  assert.equal(restartBody.job.status, 'queued');
  assert.match(restartBody.job.jobId, /^server-restart-/);

  await waitFor(() => restarted, 'background restart helper');
});

test('web ui server restart publishes management watch lifecycle events', async () => {
  const state = {
    startedAt: Date.now(),
    accounts: { codex: [], gemini: [], claude: [], agy: [] },
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
    sessionAffinity: { codex: new Map(), gemini: new Map(), claude: new Map(), agy: new Map() },
    executors: {},
    modelsCache: { ids: [], updatedAt: 0, byAccount: {}, sourceCount: 0 },
    modelRegistry: { updatedAt: 0 }
  };
  const watchReq = new EventEmitter();
  watchReq.headers = {};
  const watchRes = createStreamResCapture();
  const deps = {
    fs,
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    },
    readRequestBody: async () => null,
    parseAuthorizationBearer: () => '',
    buildManagementStatusPayload: () => ({ ok: true, totalAccounts: 0, activeAccounts: 0, uptimeSec: 1 }),
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
    buildManagementAccountsPayload: () => ({ ok: true, accounts: [] }),
    getProfileDir: () => '',
    getToolConfigDir: () => '',
    async restartServerWithStoredConfig() {
      return {
        pid: 4321,
        appliedConfig: {
          host: '127.0.0.1',
          port: 9527,
          apiKey: 'restart-api-secret',
          managementKey: 'restart-management-secret'
        }
      };
    }
  };

  const watchHandled = await handleManagementRequest({
    method: 'GET',
    pathname: '/v0/management/watch',
    url: new URL('http://localhost/v0/management/watch'),
    req: watchReq,
    res: watchRes,
    options: {},
    state,
    requiredManagementKey: '',
    deps
  });
  assert.equal(watchHandled, true);
  assert.equal(watchRes.statusCode, 200);

  const restartRes = createResCapture();
  const restartHandled = await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/server/restart',
    url: new URL('http://localhost/v0/webui/server/restart'),
    req: { headers: {} },
    res: restartRes,
    options: {},
    state,
    deps
  });
  assert.equal(restartHandled, true);
  assert.equal(restartRes.statusCode, 202);
  const body = JSON.parse(restartRes.body);
  const jobId = body.job.jobId;

  assert.ok(parseSseJsonEvents(watchRes.body).some((event) => event.type === 'restart' && event.jobId === jobId && event.status === 'queued'));
  const started = await waitForSseEvent(
    watchRes,
    (event) => event.type === 'restart' && event.jobId === jobId && event.status === 'started' && event.pid === 4321,
    'restart started event'
  );
  assert.equal(started.appliedConfig.apiKey, '');
  assert.equal(started.appliedConfig.managementKey, '');
  assert.equal(started.appliedConfig.apiKeyConfigured, true);
  assert.equal(started.appliedConfig.managementKeyConfigured, true);
  assert.doesNotMatch(watchRes.body, /restart-api-secret|restart-management-secret/);
  watchReq.emit('close');
});

test('web ui management watch route works when management API requires a key', async () => {
  const state = {
    startedAt: Date.now(),
    accounts: { codex: [], gemini: [], claude: [], agy: [] },
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
    sessionAffinity: { codex: new Map(), gemini: new Map(), claude: new Map(), agy: new Map() },
    executors: {},
    modelsCache: { ids: [], updatedAt: 0, byAccount: {}, sourceCount: 0 },
    modelRegistry: { updatedAt: 0 }
  };
  const deps = {
    fs,
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    },
    readRequestBody: async () => null,
    parseAuthorizationBearer: () => '',
    buildManagementStatusPayload: () => ({ ok: true, totalAccounts: 0, activeAccounts: 0, uptimeSec: 1 }),
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
    buildManagementAccountsPayload: () => ({ ok: true, accounts: [] }),
    getProfileDir: () => '',
    getToolConfigDir: () => ''
  };

  const protectedReq = new EventEmitter();
  protectedReq.headers = {};
  const protectedRes = createResCapture();
  const protectedHandled = await handleManagementRequest({
    method: 'GET',
    pathname: '/v0/management/watch',
    url: new URL('http://localhost/v0/management/watch'),
    req: protectedReq,
    res: protectedRes,
    options: { managementKey: 'secret' },
    state,
    requiredManagementKey: 'secret',
    deps
  });
  assert.equal(protectedHandled, true);
  assert.equal(protectedRes.statusCode, 401);

  const webUiReq = new EventEmitter();
  webUiReq.headers = {};
  const webUiRes = createStreamResCapture();
  const webUiHandled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/management/watch',
    url: new URL('http://localhost/v0/webui/management/watch'),
    req: webUiReq,
    res: webUiRes,
    options: { managementKey: 'secret' },
    state,
    deps
  });
  assert.equal(webUiHandled, true);
  assert.equal(webUiRes.statusCode, 200);
  const events = parseSseJsonEvents(webUiRes.body);
  assert.equal(events.some((event) => event.type === 'connected'), true);
  assert.equal(events.some((event) => event.type === 'snapshot' && event.status.ok === true), true);

  webUiReq.emit('close');
});

test('web ui management usage route works when management API requires a key', async () => {
  let querySeen = null;
  const deps = {
    fs,
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    },
    readRequestBody: async () => null,
    parseAuthorizationBearer: () => '',
    modelUsageService: {
      syncPricingIfStale: async () => {},
      getStats(query) {
        querySeen = query;
        return { totalTokens: 42, totalPrompts: 1 };
      }
    }
  };

  const protectedRes = createResCapture();
  const protectedHandled = await handleManagementRequest({
    method: 'GET',
    pathname: '/v0/management/usage/stats',
    url: new URL('http://localhost/v0/management/usage/stats?from=2026-06-21&to=2026-06-21'),
    req: { headers: {} },
    res: protectedRes,
    options: { managementKey: 'secret' },
    state: {},
    requiredManagementKey: 'secret',
    deps
  });
  assert.equal(protectedHandled, true);
  assert.equal(protectedRes.statusCode, 401);

  const webUiRes = createResCapture();
  const webUiHandled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/management/usage/stats',
    url: new URL('http://localhost/v0/webui/management/usage/stats?from=2026-06-21&to=2026-06-21'),
    req: { headers: {} },
    res: webUiRes,
    options: { managementKey: 'secret' },
    state: {},
    deps
  });
  assert.equal(webUiHandled, true);
  assert.equal(webUiRes.statusCode, 200);
  const payload = JSON.parse(webUiRes.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.stats.totalTokens, 42);
  assert.equal(querySeen.from, '2026-06-21');
  assert.equal(querySeen.to, '2026-06-21');
});

test('web ui management status route works when management API requires a key', async () => {
  const deps = {
    fs,
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    },
    readRequestBody: async () => null,
    parseAuthorizationBearer: () => '',
    buildManagementStatusPayload: () => ({ ok: true, totalAccounts: 3, activeAccounts: 2, uptimeSec: 10 }),
    buildManagementMetricsPayload: () => ({ ok: true }),
    buildManagementAccountsPayload: () => ({ ok: true, accounts: [] })
  };

  const protectedRes = createResCapture();
  const protectedHandled = await handleManagementRequest({
    method: 'GET',
    pathname: '/v0/management/status',
    url: new URL('http://localhost/v0/management/status'),
    req: { headers: {} },
    res: protectedRes,
    options: { managementKey: 'secret' },
    state: {},
    requiredManagementKey: 'secret',
    deps
  });
  assert.equal(protectedHandled, true);
  assert.equal(protectedRes.statusCode, 401);

  const webUiRes = createResCapture();
  const webUiHandled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/management/status',
    url: new URL('http://localhost/v0/webui/management/status'),
    req: { headers: {} },
    res: webUiRes,
    options: { managementKey: 'secret' },
    state: {},
    deps
  });
  assert.equal(webUiHandled, true);
  assert.equal(webUiRes.statusCode, 200);
  const payload = JSON.parse(webUiRes.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.totalAccounts, 3);
});
