const test = require('node:test');
const assert = require('node:assert/strict');

const { handleWebUIRequest } = require('../lib/server/web-ui-router');
const { SessionLifecycleError } = require('../lib/server/session-lifecycle');

function createResCapture() {
  return {
    statusCode: 0,
    body: '',
    writeHead(code) { this.statusCode = code; },
    end(chunk = '') { this.body = String(chunk); }
  };
}

function createBaseDeps(sessionLifecycleService, body = null) {
  return {
    fs: require('fs-extra'),
    aiHomeDir: '/tmp/aih-session-lifecycle-route',
    hostHomeDir: '/tmp/aih-session-lifecycle-host',
    sessionLifecycleService,
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    },
    readRequestBody: async () => body === null ? null : Buffer.from(JSON.stringify(body)),
    accountStateIndex: {
      getAccountState() { return null; },
      upsertAccountState() {},
      removeAccount() {}
    },
    getToolAccountIds() { return []; },
    getToolConfigDir() { return '/tmp/config'; },
    getProfileDir() { return '/tmp/profile'; },
    loadServerRuntimeAccounts() { return { codex: [], claude: [], gemini: [], agy: [], opencode: [] }; },
    applyReloadState() {},
    fetchModelsForAccount: async () => [],
    checkStatus() { return { configured: false, accountName: 'Unknown' }; },
    ensureSessionStoreLinks() {},
    pickProjectDirectory() { return null; }
  };
}

async function request(pathname, method, service, body = null) {
  const response = createResCapture();
  const handled = await handleWebUIRequest({
    method,
    pathname,
    url: new URL(`http://localhost${pathname}`),
    req: { headers: {}, url: pathname },
    res: response,
    options: {},
    state: {},
    deps: createBaseDeps(service, body)
  });
  return { handled, response, body: JSON.parse(response.body || '{}') };
}

test('web ui lifecycle capability route returns operation-level provider support', async () => {
  const providers = {
    codex: {
      workflowAvailable: true,
      operations: {
        archive: { support: 'native', available: true },
        listArchived: { support: 'native', available: true },
        unarchive: { support: 'native', available: true }
      }
    }
  };
  const service = { getCapabilities: async () => providers };

  const result = await request('/v0/webui/sessions/lifecycle-capabilities', 'GET', service);

  assert.equal(result.handled, true);
  assert.equal(result.response.statusCode, 200);
  assert.deepEqual(result.body, { ok: true, providers });
});

test('web ui archive route delegates to the lifecycle service without account binding', async () => {
  const calls = [];
  const service = {
    archive: async (input) => {
      calls.push(input);
      return { provider: 'codex', sessionId: input.sessionId, nativeSessionId: input.sessionId, origin: 'native' };
    }
  };

  const result = await request('/v0/webui/sessions/archive', 'POST', service, {
    provider: 'codex',
    sessionId: 'thread-1',
    accountRef: 'acct_must_not_be_forwarded'
  });

  assert.equal(result.response.statusCode, 200);
  assert.deepEqual(calls, [{ provider: 'codex', sessionId: 'thread-1' }]);
  assert.deepEqual(result.body, {
    ok: true,
    provider: 'codex',
    sessionId: 'thread-1',
    nativeSessionId: 'thread-1',
    origin: 'native'
  });
});

test('web ui archived route returns native items, legacy items, and partial errors', async () => {
  const service = {
    listArchived: async () => ({
      archived: [{ id: 'thread-1', provider: 'codex', origin: 'native' }],
      errors: [{ provider: 'codex', code: 'partial', message: 'partial failure' }]
    })
  };

  const result = await request('/v0/webui/sessions/archived', 'GET', service);

  assert.equal(result.response.statusCode, 200);
  assert.deepEqual(result.body, {
    ok: true,
    archived: [{ id: 'thread-1', provider: 'codex', origin: 'native' }],
    errors: [{ provider: 'codex', code: 'partial', message: 'partial failure' }]
  });
});

test('web ui lifecycle routes preserve stable unsupported status and error code', async () => {
  const service = {
    archive: async () => {
      throw new SessionLifecycleError('session_archive_unsupported', 422, {
        provider: 'claude',
        reason: 'native_archive_unsupported',
        message: 'Claude 不支持原生归档'
      });
    }
  };

  const result = await request('/v0/webui/sessions/archive', 'POST', service, {
    provider: 'claude',
    sessionId: 'session-1'
  });

  assert.equal(result.response.statusCode, 422);
  assert.deepEqual(result.body, {
    ok: false,
    error: 'session_archive_unsupported',
    message: 'Claude 不支持原生归档',
    details: {
      provider: 'claude',
      reason: 'native_archive_unsupported',
      message: 'Claude 不支持原生归档'
    }
  });
});
