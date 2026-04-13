const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');
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

function createStreamResCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    writeHead(code, headers = {}) {
      this.statusCode = code;
      this.headers = { ...this.headers, ...headers };
    },
    write(chunk = '') {
      this.body += String(chunk);
      return true;
    },
    end(chunk = '') {
      this.body += String(chunk);
      this.writableEnded = true;
    }
  };
}

test('web ui accounts list returns fast snapshot without synchronously depending on checkStatus', async () => {
  const res = createResCapture();
  let checkStatusCalls = 0;
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/accounts',
    url: new URL('http://localhost/v0/webui/accounts'),
    req: { headers: {} },
    res,
    options: {},
    state: {
      accounts: { codex: [], gemini: [], claude: [] }
    },
    deps: {
      fs: {
        existsSync(filePath) {
          return String(filePath).endsWith('/auth.json');
        },
        readFileSync() {
          throw new Error('unexpected_sync_read');
        }
      },
      writeJson: (response, code, payload) => {
        response.statusCode = code;
        response.end(JSON.stringify(payload));
      },
      readRequestBody: async () => null,
      accountStateIndex: {
        getAccountState() {
          return {
            configured: true,
            api_key_mode: false,
            exhausted: false,
            remaining_pct: 61,
            display_name: 'codex-1',
            updated_at: 100
          };
        }
      },
      getToolAccountIds(provider) {
        return provider === 'codex' ? ['1'] : [];
      },
      getToolConfigDir: () => '/tmp/codex/1/.codex',
      getProfileDir: () => '/tmp/codex/1',
      loadServerRuntimeAccounts: () => ({ codex: [], gemini: [], claude: [] }),
      applyReloadState: () => {},
      checkStatus() {
        checkStatusCalls += 1;
        throw new Error('check_status_should_not_block_fast_snapshot');
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.accounts.length, 1);
  assert.equal(body.accounts[0].configured, true);
  assert.equal(body.accounts[0].remainingPct, 61);
  assert.equal(checkStatusCalls, 0);

  await new Promise((resolve) => setTimeout(resolve, 20));
});

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

test('web ui accounts list restores persisted snapshot across fresh state without rescanning account ids', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-accounts-cache-'));
  const accountRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-account-root-'));
  try {
    const profileDir = path.join(accountRoot, 'profile');
    const configDir = path.join(accountRoot, 'profile', '.codex');
    fs.ensureDirSync(configDir);
    fs.writeFileSync(path.join(configDir, 'auth.json'), JSON.stringify({ tokens: {} }), 'utf8');
    const writeJson = (response, code, payload) => {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    };

    const warmRes = createResCapture();
    const warmHandled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/accounts',
      url: new URL('http://localhost/v0/webui/accounts'),
      req: { headers: {} },
      res: warmRes,
      options: {},
      state: {
        accounts: { codex: [], gemini: [], claude: [] }
      },
      deps: {
        aiHomeDir,
        fs,
        writeJson,
        readRequestBody: async () => null,
        accountStateIndex: {
          getAccountState() {
            return {
              configured: true,
              api_key_mode: false,
              exhausted: false,
              remaining_pct: 48,
              display_name: 'persisted@example.com',
              updated_at: 222
            };
          }
        },
        getToolAccountIds(provider) {
          return provider === 'codex' ? ['7'] : [];
        },
        getToolConfigDir: () => configDir,
        getProfileDir: () => profileDir,
        loadServerRuntimeAccounts: () => ({ codex: [], gemini: [], claude: [] }),
        applyReloadState: () => {},
        checkStatus() {
          return { configured: false, accountName: 'Unknown' };
        }
      }
    });

    assert.equal(warmHandled, true);
    assert.equal(warmRes.statusCode, 200);

    const coldRes = createResCapture();
    let getToolAccountIdsCalls = 0;
    const coldHandled = await handleWebUIRequest({
      method: 'GET',
      pathname: '/v0/webui/accounts',
      url: new URL('http://localhost/v0/webui/accounts'),
      req: { headers: {} },
      res: coldRes,
      options: {},
      state: {
        accounts: { codex: [], gemini: [], claude: [] }
      },
      deps: {
        aiHomeDir,
        fs,
        writeJson,
        readRequestBody: async () => null,
        accountStateIndex: {
          getAccountState() {
            throw new Error('state_index_should_not_be_read_for_persisted_snapshot');
          }
        },
        getToolAccountIds() {
          getToolAccountIdsCalls += 1;
          throw new Error('account_ids_should_not_be_scanned_for_persisted_snapshot');
        },
        getToolConfigDir: () => configDir,
        getProfileDir: () => profileDir,
        loadServerRuntimeAccounts: () => ({ codex: [], gemini: [], claude: [] }),
        applyReloadState: () => {},
        checkStatus() {
          throw new Error('check_status_should_not_block_persisted_snapshot');
        }
      }
    });

    assert.equal(coldHandled, true);
    assert.equal(coldRes.statusCode, 200);
    const body = JSON.parse(coldRes.body);
    assert.equal(body.accounts.length, 1);
    assert.equal(body.accounts[0].provider, 'codex');
    assert.equal(body.accounts[0].accountId, '7');
    assert.equal(body.accounts[0].displayName, 'persisted@example.com');
    assert.equal(body.accounts[0].remainingPct, 48);
    assert.equal(getToolAccountIdsCalls, 0);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
    fs.rmSync(accountRoot, { recursive: true, force: true });
  }
});

test('web ui accounts list reuses fast snapshot within short ttl', async () => {
  const state = {
    accounts: { codex: [], gemini: [], claude: [] },
    __webUiAccountsLive: {
      records: new Map(),
      metadata: new Map(),
      usageSnapshots: new Map(),
      watchers: new Set(),
      hydrating: false,
      queued: false,
      lastHydratedAt: Date.now(),
      revision: 0,
      fastSnapshot: null,
      fastSnapshotAt: 0
    }
  };
  let getToolAccountIdsCalls = 0;
  const deps = {
    fs: {
      existsSync(filePath) {
        return String(filePath).endsWith('/auth.json');
      },
      readFileSync() {
        return JSON.stringify({
          tokens: {
            id_token: 'header.eyJlbWFpbCI6ImNhY2hlZEBleGFtcGxlLmNvbSJ9.signature'
          }
        });
      }
    },
    writeJson: (response, code, payload) => {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    },
    readRequestBody: async () => null,
    accountStateIndex: {
      getAccountState() {
        return {
          configured: true,
          api_key_mode: false,
          exhausted: false,
          remaining_pct: 55,
          display_name: 'codex-1',
          updated_at: 100
        };
      }
    },
    getToolAccountIds(provider) {
      getToolAccountIdsCalls += 1;
      return provider === 'codex' ? ['1'] : [];
    },
    getToolConfigDir: () => '/tmp/codex/1/.codex',
    getProfileDir: () => '/tmp/codex/1',
    loadServerRuntimeAccounts: () => ({ codex: [], gemini: [], claude: [] }),
    applyReloadState: () => {},
    checkStatus() {
      return { configured: true, accountName: 'cached@example.com' };
    }
  };

  const firstRes = createResCapture();
  await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/accounts',
    url: new URL('http://localhost/v0/webui/accounts'),
    req: { headers: {} },
    res: firstRes,
    options: {},
    state,
    deps
  });

  const secondRes = createResCapture();
  await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/accounts',
    url: new URL('http://localhost/v0/webui/accounts'),
    req: { headers: {} },
    res: secondRes,
    options: {},
    state,
    deps
  });

  assert.equal(firstRes.statusCode, 200);
  assert.equal(secondRes.statusCode, 200);
  assert.equal(getToolAccountIdsCalls, 3);
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

test('web ui accounts watch streams snapshot immediately and completes hydration lifecycle', async () => {
  const req = new EventEmitter();
  req.headers = {};
  const res = createStreamResCapture();
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/accounts/watch',
    url: new URL('http://localhost/v0/webui/accounts/watch'),
    req,
    res,
    options: {},
    state: {
      accounts: { codex: [], gemini: [], claude: [] }
    },
    deps: {
      fs: {
        existsSync(filePath) {
          return String(filePath).endsWith('/auth.json');
        },
        readFileSync() {
          return JSON.stringify({
            tokens: {
              id_token: 'header.eyJlbWFpbCI6Imh5ZHJhdGVkQGV4YW1wbGUuY29tIn0=.signature'
            }
          });
        }
      },
      writeJson: (response, code, payload) => {
        response.statusCode = code;
        response.end(JSON.stringify(payload));
      },
      readRequestBody: async () => null,
      accountStateIndex: {
        getAccountState() {
          return {
            configured: true,
            api_key_mode: false,
            exhausted: false,
            remaining_pct: 54,
            display_name: 'stale@example.com',
            updated_at: 555
          };
        }
      },
      getToolAccountIds(provider) {
        return provider === 'codex' ? ['9'] : [];
      },
      getToolConfigDir: () => '/tmp/codex/9/.codex',
      getProfileDir: () => '/tmp/codex/9',
      loadServerRuntimeAccounts: () => ({ codex: [], gemini: [], claude: [] }),
      applyReloadState: () => {},
      checkStatus() {
        return { configured: true, accountName: 'hydrated@example.com' };
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'text/event-stream');
  assert.match(res.body, /"type":"connected"/);
  assert.match(res.body, /"type":"snapshot"/);
  assert.match(res.body, /hydrated@example.com/);

  await new Promise((resolve) => setTimeout(resolve, 60));
  req.emit('close');

  assert.match(res.body, /"type":"hydrated"/);
});
