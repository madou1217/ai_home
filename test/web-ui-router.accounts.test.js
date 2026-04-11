const test = require('node:test');
const assert = require('node:assert/strict');
const { handleWebUIRequest } = require('../lib/server/web-ui-router');

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

test('web ui accounts list uses live status instead of stale configured state index', async () => {
  const res = createResCapture();
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/accounts',
    url: new URL('http://localhost/v0/webui/accounts'),
    req: { headers: {} },
    res,
    options: {},
    state: {},
    deps: {
      fs: {
        existsSync: () => false
      },
      writeJson: (response, code, payload) => {
        response.statusCode = code;
        response.end(JSON.stringify(payload));
      },
      readRequestBody: async () => null,
      accountStateIndex: {
        getAccountState(provider, accountId) {
          if (provider === 'codex' && accountId === '10001') {
            return {
              configured: true,
              api_key_mode: false,
              exhausted: true,
              remaining_pct: 0,
              display_name: 'stale@example.com',
              updated_at: 123
            };
          }
          return null;
        }
      },
      getToolAccountIds(provider) {
        return provider === 'codex' ? ['10001'] : [];
      },
      getToolConfigDir: () => '/tmp/codex/10001/.codex',
      getProfileDir: () => '/tmp/codex/10001',
      loadServerRuntimeAccounts: () => ({ codex: [], gemini: [], claude: [] }),
      applyReloadState: () => {},
      checkStatus() {
        return { configured: false, accountName: 'Unknown' };
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.accounts.length, 1);
  assert.deepEqual(body.accounts[0], {
    provider: 'codex',
    accountId: '10001',
    displayName: 'stale@example.com',
    configured: false,
    apiKeyMode: false,
    exhausted: false,
    remainingPct: null,
    usageSnapshot: null,
    updatedAt: 123,
    planType: 'pending',
    email: '',
    configDir: '/tmp/codex/10001/.codex',
    profileDir: '/tmp/codex/10001'
  });
});

test('web ui accounts list falls back to runtime remainingPct when state index usage is missing', async () => {
  const res = createResCapture();
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/accounts',
    url: new URL('http://localhost/v0/webui/accounts'),
    req: { headers: {} },
    res,
    options: {},
    state: {
      accounts: {
        codex: [
          {
            id: '42',
            remainingPct: 73,
            apiKeyMode: false
          }
        ],
        gemini: [],
        claude: []
      }
    },
    deps: {
      fs: {
        existsSync: () => false
      },
      writeJson: (response, code, payload) => {
        response.statusCode = code;
        response.end(JSON.stringify(payload));
      },
      readRequestBody: async () => null,
      accountStateIndex: {
        getAccountState(provider, accountId) {
          if (provider === 'codex' && accountId === '42') {
            return {
              configured: true,
              api_key_mode: false,
              exhausted: false,
              remaining_pct: null,
              display_name: 'runtime@example.com',
              updated_at: 456
            };
          }
          return null;
        }
      },
      getToolAccountIds(provider) {
        return provider === 'codex' ? ['42'] : [];
      },
      getToolConfigDir: () => '/tmp/codex/42/.codex',
      getProfileDir: () => '/tmp/codex/42',
      loadServerRuntimeAccounts: () => ({ codex: [], gemini: [], claude: [] }),
      applyReloadState: () => {},
      checkStatus() {
        return { configured: true, accountName: 'runtime@example.com' };
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.accounts.length, 1);
  assert.equal(body.accounts[0].remainingPct, 73);
  assert.equal(body.accounts[0].configured, true);
  assert.equal(body.accounts[0].apiKeyMode, false);
});

test('web ui accounts list keeps api key accounts out of usage percentage rendering', async () => {
  const res = createResCapture();
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/accounts',
    url: new URL('http://localhost/v0/webui/accounts'),
    req: { headers: {} },
    res,
    options: {},
    state: {
      accounts: {
        codex: [
          {
            id: '7',
            remainingPct: 88,
            apiKeyMode: true
          }
        ],
        gemini: [],
        claude: []
      }
    },
    deps: {
      fs: {
        existsSync: () => false
      },
      writeJson: (response, code, payload) => {
        response.statusCode = code;
        response.end(JSON.stringify(payload));
      },
      readRequestBody: async () => null,
      accountStateIndex: {
        getAccountState(provider, accountId) {
          if (provider === 'codex' && accountId === '7') {
            return {
              configured: true,
              api_key_mode: true,
              exhausted: false,
              remaining_pct: 88,
              display_name: 'codex-7',
              updated_at: 789
            };
          }
          return null;
        }
      },
      getToolAccountIds(provider) {
        return provider === 'codex' ? ['7'] : [];
      },
      getToolConfigDir: () => '/tmp/codex/7/.codex',
      getProfileDir: () => '/tmp/codex/7',
      loadServerRuntimeAccounts: () => ({ codex: [], gemini: [], claude: [] }),
      applyReloadState: () => {},
      checkStatus() {
        return { configured: true, accountName: 'codex-7' };
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.accounts.length, 1);
  assert.equal(body.accounts[0].apiKeyMode, true);
  assert.equal(body.accounts[0].remainingPct, null);
});

test('web ui accounts list reads codex usage snapshot cache when state index and runtime are missing usage', async () => {
  const res = createResCapture();
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/accounts',
    url: new URL('http://localhost/v0/webui/accounts'),
    req: { headers: {} },
    res,
    options: {},
    state: {
      accounts: {
        codex: [],
        gemini: [],
        claude: []
      }
    },
    deps: {
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
              entries: [
                { window: '5h', remainingPct: 59 },
                { window: '7days', remainingPct: 81 }
              ]
            });
          }
          throw new Error(`unexpected_read:${filePath}`);
        }
      },
      writeJson: (response, code, payload) => {
        response.statusCode = code;
        response.end(JSON.stringify(payload));
      },
      readRequestBody: async () => null,
      accountStateIndex: {
        getAccountState(provider, accountId) {
          if (provider === 'codex' && accountId === '8') {
            return {
              configured: true,
              api_key_mode: false,
              exhausted: false,
              remaining_pct: null,
              display_name: 'cached@example.com',
              updated_at: 999
            };
          }
          return null;
        }
      },
      getToolAccountIds(provider) {
        return provider === 'codex' ? ['8'] : [];
      },
      getToolConfigDir: () => '/tmp/codex/8/.codex',
      getProfileDir: () => '/tmp/codex/8',
      loadServerRuntimeAccounts: () => ({ codex: [], gemini: [], claude: [] }),
      applyReloadState: () => {},
      checkStatus() {
        return { configured: true, accountName: 'cached@example.com' };
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.accounts.length, 1);
  assert.equal(body.accounts[0].remainingPct, 59);
  assert.equal(body.accounts[0].usageSnapshot.kind, 'codex_oauth_status');
  assert.equal(body.accounts[0].usageSnapshot.entries.length, 2);
  assert.equal(body.accounts[0].usageSnapshot.entries[0].window, '5h');
});

test('web ui accounts list reads gemini usage snapshot models for account details', async () => {
  const res = createResCapture();
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/accounts',
    url: new URL('http://localhost/v0/webui/accounts'),
    req: { headers: {} },
    res,
    options: {},
    state: {
      accounts: {
        codex: [],
        gemini: [],
        claude: []
      }
    },
    deps: {
      fs: {
        existsSync(filePath) {
          return String(filePath).endsWith('/.aih_usage.json');
        },
        readFileSync(filePath) {
          if (String(filePath).endsWith('/.aih_usage.json')) {
            return JSON.stringify({
              schemaVersion: 2,
              kind: 'gemini_oauth_stats',
              source: 'gemini_refresh_user_quota',
              capturedAt: Date.now(),
              models: [
                { model: 'gemini-2.5-pro', remainingPct: 42, resetIn: '2h', resetAtMs: Date.now() + 7200000 },
                { model: 'gemini-2.5-flash', remainingPct: 76, resetIn: '5h', resetAtMs: Date.now() + 18000000 }
              ]
            });
          }
          throw new Error(`unexpected_read:${filePath}`);
        }
      },
      writeJson: (response, code, payload) => {
        response.statusCode = code;
        response.end(JSON.stringify(payload));
      },
      readRequestBody: async () => null,
      accountStateIndex: {
        getAccountState(provider, accountId) {
          if (provider === 'gemini' && accountId === '11') {
            return {
              configured: true,
              api_key_mode: false,
              exhausted: false,
              remaining_pct: null,
              display_name: 'gemini@example.com',
              updated_at: 222
            };
          }
          return null;
        }
      },
      getToolAccountIds(provider) {
        return provider === 'gemini' ? ['11'] : [];
      },
      getToolConfigDir: () => '/tmp/gemini/11/.gemini',
      getProfileDir: () => '/tmp/gemini/11',
      loadServerRuntimeAccounts: () => ({ codex: [], gemini: [], claude: [] }),
      applyReloadState: () => {},
      checkStatus() {
        return { configured: true, accountName: 'gemini@example.com' };
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.accounts.length, 1);
  assert.equal(body.accounts[0].provider, 'gemini');
  assert.equal(body.accounts[0].remainingPct, 42);
  assert.equal(body.accounts[0].usageSnapshot.kind, 'gemini_oauth_stats');
  assert.equal(body.accounts[0].usageSnapshot.models.length, 2);
  assert.equal(body.accounts[0].usageSnapshot.models[0].model, 'gemini-2.5-pro');
});
