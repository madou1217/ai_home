const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');
const {
  handleWebUIRequest,
  handleOauthJobFinishedStateSync
} = require('../lib/server/web-ui-router');
const {
  handleGetAddJobRequest,
  handleAddAccountRequest,
  handleCancelAddJobRequest,
  handleCompleteAddJobCallbackRequest,
  handleReauthAccountRequest,
  handleUpdateAccountRequest,
  handleUpdateAccountStatusRequest
} = require('../lib/server/webui-account-routes');
const { OAUTH_PENDING_FALLBACK_STALE_MS } = require('../lib/server/oauth-pending-state');
const { SUPPORTED_SERVER_PROVIDERS } = require('../lib/server/providers');
const { buildAuthInvalidRuntimeState } = require('../lib/account/runtime-state-builders');

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

async function waitFor(predicate, timeoutMs = 200) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

function createAccountStateServiceRecorder(upserts, options = {}) {
  const baseKind = options.baseKind || '';
  return {
    syncAccountBaseState(provider, accountId, state) {
      const entry = { provider, accountId, state };
      upserts.push(baseKind ? { kind: baseKind, ...entry } : entry);
      return true;
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
  assert.equal(body.accounts[0].displayName, '');
  assert.equal(body.accounts[0].remainingPct, 61);
  assert.equal(body.providerNativeCapabilities.codex.provider, 'codex');
  assert.equal(body.providerNativeCapabilities.claude.sessions.nativeStore, 'projects/<project>/<session-id>.jsonl');
  assert.equal(body.providerNativeCapabilities.agy.config.userSettings.includes('.gemini/antigravity-cli/settings.json'), true);
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
  assert.equal(body.accounts[0].provider, 'codex');
  assert.equal(body.accounts[0].accountId, '10001');
  assert.equal(body.accounts[0].status, 'up');
  assert.equal(body.accounts[0].displayName, 'stale@example.com');
  assert.equal(body.accounts[0].configured, false);
  assert.equal(body.accounts[0].apiKeyMode, false);
  assert.equal(body.accounts[0].remainingPct, null);
  assert.equal(body.accounts[0].usageSnapshot, null);
  assert.equal(body.accounts[0].updatedAt, 123);
  assert.equal(body.accounts[0].planType, 'pending');
  assert.equal(body.accounts[0].email, '');
  assert.equal(body.accounts[0].configDir, '/tmp/codex/10001/.codex');
  assert.equal(body.accounts[0].profileDir, '/tmp/codex/10001');
  assert.equal(body.accounts[0].quotaStatus, 'not_applicable');
  assert.equal(body.accounts[0].schedulableStatus, 'blocked_by_account_status');
  assert.equal(body.accounts[0].schedulableReason, 'account_unconfigured');
});

test('web ui accounts list marks stale oauth pending accounts as retryable', async () => {
  const res = createResCapture();
  const staleUpdatedAt = Date.now() - OAUTH_PENDING_FALLBACK_STALE_MS - 1000;
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/accounts',
    url: new URL('http://localhost/v0/webui/accounts'),
    req: { headers: {} },
    res,
    options: {},
    state: {
      accounts: { codex: [], gemini: [], claude: [], agy: [] }
    },
    deps: {
      fs: {
        existsSync() {
          return false;
        },
        readFileSync() {
          throw new Error('unexpected_read');
        }
      },
      writeJson: (response, code, payload) => {
        response.statusCode = code;
        response.end(JSON.stringify(payload));
      },
      readRequestBody: async () => null,
      accountStateIndex: {
        listStates(provider) {
          if (provider !== 'codex') return [];
          return [{
            provider: 'codex',
            accountId: '7',
            status: 'down',
            configured: false,
            apiKeyMode: false,
            authMode: 'oauth-browser',
            displayName: '',
            updatedAt: staleUpdatedAt
          }];
        }
      },
      getToolAccountIds(provider) {
        return provider === 'codex' ? ['7'] : [];
      },
      getToolConfigDir: () => '/tmp/codex/7/.codex',
      getProfileDir: () => '/tmp/codex/7',
      loadServerRuntimeAccounts: () => ({ codex: [], gemini: [], claude: [], agy: [] }),
      applyReloadState: () => {},
      checkStatus() {
        throw new Error('check_status_should_not_run_for_fast_snapshot');
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.accounts.length, 1);
  assert.equal(body.accounts[0].configured, false);
  assert.equal(body.accounts[0].authMode, 'oauth-browser');
  assert.equal(body.accounts[0].authPending, true);
  assert.equal(body.accounts[0].authPendingStale, true);
});

test('web ui accounts list prefers profile status file over missing state index row', async () => {
  const accountRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-status-file-'));
  try {
    const profileDir = path.join(accountRoot, 'profile');
    const configDir = path.join(profileDir, '.codex');
    fs.ensureDirSync(configDir);
    fs.writeFileSync(path.join(configDir, 'auth.json'), JSON.stringify({ tokens: {} }), 'utf8');
    fs.writeFileSync(path.join(profileDir, '.aih_status'), 'down\n', 'utf8');

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
        fs,
        writeJson: (response, code, payload) => {
          response.statusCode = code;
          response.end(JSON.stringify(payload));
        },
        readRequestBody: async () => null,
        accountStateIndex: {
          getAccountState() {
            return null;
          }
        },
        getToolAccountIds(provider) {
          return provider === 'codex' ? ['10002'] : [];
        },
        getToolConfigDir: () => configDir,
        getProfileDir: () => profileDir,
        loadServerRuntimeAccounts: () => ({ codex: [], gemini: [], claude: [] }),
        applyReloadState: () => {},
        checkStatus() {
          return { configured: true, accountName: 'status-file@example.com' };
        }
      }
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.accounts.length, 1);
    assert.equal(body.accounts[0].status, 'down');
  } finally {
    fs.rmSync(accountRoot, { recursive: true, force: true });
  }
});

test('web ui accounts cold start rebuilds status from current state instead of trusting persisted snapshot', async () => {
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
          getAccountState(provider, accountId) {
            if (provider === 'codex' && accountId === '7') {
              return {
                status: 'down',
                configured: true,
                api_key_mode: false,
                remaining_pct: 11,
                display_name: 'persisted@example.com',
                updated_at: 333
              };
            }
            return null;
          }
        },
        getToolAccountIds(provider) {
          getToolAccountIdsCalls += 1;
          return provider === 'codex' ? ['7'] : [];
        },
        getToolConfigDir: () => configDir,
        getProfileDir: () => profileDir,
        loadServerRuntimeAccounts: () => ({ codex: [], gemini: [], claude: [] }),
        applyReloadState: () => {},
        checkStatus() {
          return { configured: true, accountName: 'persisted@example.com' };
        }
      }
    });

    assert.equal(coldHandled, true);
    assert.equal(coldRes.statusCode, 200);
    const body = JSON.parse(coldRes.body);
    assert.equal(body.accounts.length, 1);
    assert.equal(body.accounts[0].provider, 'codex');
    assert.equal(body.accounts[0].accountId, '7');
    assert.equal(body.accounts[0].status, 'down');
    assert.equal(body.accounts[0].displayName, 'persisted@example.com');
    assert.equal(body.accounts[0].remainingPct, 11);
    assert.ok(getToolAccountIdsCalls > 0);
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
  assert.equal(getToolAccountIdsCalls, SUPPORTED_SERVER_PROVIDERS.length);
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
  assert.equal(body.accounts[0].displayName, 'api.openai.com');
  assert.equal(body.accounts[0].remainingPct, null);
  assert.equal(body.accounts[0].runtimeStatus, undefined);
  assert.equal(body.accounts[0].runtimeUntil, undefined);
  assert.equal(body.accounts[0].runtimeReason, undefined);
});

test('web ui accounts list prefers usage snapshot capturedAt for updatedAt', async () => {
  const capturedAt = Date.now() - 15_000;
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
              capturedAt,
              entries: [
                { window: '5h', remainingPct: 64 },
                { window: '7days', remainingPct: 83 }
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
          if (provider === 'codex' && accountId === '52') {
            return {
              configured: true,
              api_key_mode: false,
              remaining_pct: 64,
              display_name: 'updated@example.com',
              updated_at: 123
            };
          }
          return null;
        }
      },
      getToolAccountIds(provider) {
        return provider === 'codex' ? ['52'] : [];
      },
      getToolConfigDir: () => '/tmp/codex/52/.codex',
      getProfileDir: () => '/tmp/codex/52',
      loadServerRuntimeAccounts: () => ({ codex: [], gemini: [], claude: [] }),
      applyReloadState: () => {},
      checkStatus() {
        return { configured: true, accountName: 'updated@example.com' };
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.accounts.length, 1);
  assert.equal(body.accounts[0].updatedAt, capturedAt);
});

test('web ui accounts list falls back to latest probe checkedAt for updatedAt when snapshot is missing', async () => {
  const probeCheckedAt = Date.now() - 8_000;
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
          return String(filePath).endsWith('/auth.json');
        },
        readFileSync() {
          return JSON.stringify({ tokens: {} });
        }
      },
      writeJson: (response, code, payload) => {
        response.statusCode = code;
        response.end(JSON.stringify(payload));
      },
      readRequestBody: async () => null,
      accountStateIndex: {
        getAccountState(provider, accountId) {
          if (provider === 'codex' && accountId === '77') {
            return {
              configured: true,
              api_key_mode: false,
              remaining_pct: null,
              display_name: 'probe-time@example.com',
              updated_at: 123
            };
          }
          return null;
        }
      },
      getToolAccountIds(provider) {
        return provider === 'codex' ? ['77'] : [];
      },
      getToolConfigDir: () => '/tmp/codex/77/.codex',
      getProfileDir: () => '/tmp/codex/77',
      loadServerRuntimeAccounts: () => ({ codex: [], gemini: [], claude: [] }),
      applyReloadState: () => {},
      checkStatus() {
        return { configured: true, accountName: 'probe-time@example.com' };
      },
      getLastUsageProbeState(provider, accountId) {
        if (provider === 'codex' && accountId === '77') {
          return {
            error: 'timeout',
            checkedAt: probeCheckedAt
          };
        }
        return null;
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.accounts.length, 1);
  assert.equal(body.accounts[0].updatedAt, probeCheckedAt);
  assert.equal(body.accounts[0].quotaStatus, 'probe_failed');
});

test('web ui accounts list exposes lastUsedAt from runtime success timestamp', async () => {
  const lastSuccessAt = Date.now() - 12_000;
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
        codex: [{
          id: '81',
          email: 'used@example.com',
          accountId: '81',
          apiKeyMode: false,
          lastSuccessAt
        }],
        gemini: [],
        claude: []
      }
    },
    deps: {
      fs: {
        existsSync(filePath) {
          return String(filePath).endsWith('/auth.json');
        },
        readFileSync() {
          return JSON.stringify({ tokens: {} });
        }
      },
      writeJson: (response, code, payload) => {
        response.statusCode = code;
        response.end(JSON.stringify(payload));
      },
      readRequestBody: async () => null,
      accountStateIndex: {
        getAccountState(provider, accountId) {
          if (provider === 'codex' && accountId === '81') {
            return {
              configured: true,
              api_key_mode: false,
              remaining_pct: null,
              display_name: 'used@example.com',
              updated_at: 123
            };
          }
          return null;
        }
      },
      getToolAccountIds(provider) {
        return provider === 'codex' ? ['81'] : [];
      },
      getToolConfigDir: () => '/tmp/codex/81/.codex',
      getProfileDir: () => '/tmp/codex/81',
      loadServerRuntimeAccounts: () => ({ codex: [], gemini: [], claude: [] }),
      applyReloadState: () => {},
      checkStatus() {
        return { configured: true, accountName: 'used@example.com' };
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.accounts.length, 1);
  assert.equal(body.accounts[0].lastUsedAt, lastSuccessAt);
});

test('web ui accounts list exposes lastUsedAt for every server provider runtime account', async () => {
  const baseTime = Date.now() - 60_000;
  const providers = ['codex', 'gemini', 'claude', 'agy'];
  const providerAccounts = Object.fromEntries(
    providers.map((provider, index) => [
      provider,
      [{
        id: String(index + 1),
        email: `${provider}@example.com`,
        accountId: String(index + 1),
        apiKeyMode: false,
        lastSuccessAt: baseTime + index
      }]
    ])
  );
  const res = createResCapture();
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/accounts',
    url: new URL('http://localhost/v0/webui/accounts'),
    req: { headers: {} },
    res,
    options: {},
    state: {
      accounts: providerAccounts
    },
    deps: {
      fs: {
        existsSync() {
          return false;
        },
        readFileSync() {
          throw new Error('unexpected_read');
        }
      },
      writeJson: (response, code, payload) => {
        response.statusCode = code;
        response.end(JSON.stringify(payload));
      },
      readRequestBody: async () => null,
      accountStateIndex: {
        getAccountState(provider, accountId) {
          if (!providers.includes(provider)) return null;
          return {
            configured: true,
            api_key_mode: false,
            remaining_pct: null,
            display_name: `${provider}@example.com`,
            updated_at: 123 + Number(accountId)
          };
        }
      },
      getToolAccountIds(provider) {
        return providers.includes(provider) ? [String(providers.indexOf(provider) + 1)] : [];
      },
      getToolConfigDir: (provider, accountId) => `/tmp/${provider}/${accountId}/config`,
      getProfileDir: (provider, accountId) => `/tmp/${provider}/${accountId}`,
      loadServerRuntimeAccounts: () => providerAccounts,
      applyReloadState: () => {},
      checkStatus(provider) {
        return { configured: true, accountName: `${provider}@example.com` };
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.accounts.length, providers.length);
  const byProvider = new Map(body.accounts.map((account) => [account.provider, account]));
  providers.forEach((provider, index) => {
    assert.equal(byProvider.get(provider).lastUsedAt, baseTime + index);
  });
});

test('web ui accounts list marks free accounts below 20 percent as policy blocked', async () => {
  const capturedAt = Date.now() - 5_000;
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
              capturedAt,
              account: {
                planType: 'free',
                email: 'free-low@example.com'
              },
              entries: [
                { window: '5h', remainingPct: 19 },
                { window: '7days', remainingPct: 76 }
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
          if (provider === 'codex' && accountId === '91') {
            return {
              configured: true,
              api_key_mode: false,
              remaining_pct: 19,
              display_name: 'free-low@example.com',
              updated_at: 123
            };
          }
          return null;
        }
      },
      getToolAccountIds(provider) {
        return provider === 'codex' ? ['91'] : [];
      },
      getToolConfigDir: () => '/tmp/codex/91/.codex',
      getProfileDir: () => '/tmp/codex/91',
      loadServerRuntimeAccounts: () => ({ codex: [], gemini: [], claude: [] }),
      applyReloadState: () => {},
      checkStatus() {
        return { configured: true, accountName: 'free-low@example.com' };
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.accounts.length, 1);
  assert.equal(body.accounts[0].schedulableStatus, 'blocked_by_policy');
  assert.equal(body.accounts[0].schedulableReason, 'codex_free_plan_below_server_min_remaining');
});

test('web ui accounts list exposes probe_failed quota status when latest usage probe failed', async () => {
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
          return String(filePath).endsWith('/auth.json');
        },
        readFileSync() {
          throw new Error('unexpected_read');
        }
      },
      writeJson: (response, code, payload) => {
        response.statusCode = code;
        response.end(JSON.stringify(payload));
      },
      readRequestBody: async () => null,
      accountStateIndex: {
        getAccountState(provider, accountId) {
          if (provider === 'codex' && accountId === '77') {
            return {
              configured: true,
              api_key_mode: false,
              remaining_pct: null,
              display_name: 'probe@example.com',
              updated_at: 0
            };
          }
          return null;
        }
      },
      getToolAccountIds(provider) {
        return provider === 'codex' ? ['77'] : [];
      },
      getToolConfigDir: () => '/tmp/codex/77/.codex',
      getProfileDir: () => '/tmp/codex/77',
      loadServerRuntimeAccounts: () => ({ codex: [], gemini: [], claude: [] }),
      applyReloadState: () => {},
      checkStatus() {
        return { configured: true, accountName: 'probe@example.com' };
      },
      getLastUsageProbeError(provider, accountId) {
        if (provider === 'codex' && accountId === '77') {
          return 'direct_http_status_401';
        }
        return '';
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.accounts.length, 1);
  assert.equal(body.accounts[0].quotaStatus, 'probe_failed');
  assert.equal(body.accounts[0].quotaReason, 'direct_http_status_401');
});

test('web ui refresh usage accepts background job and streams refreshed account record', async () => {
  let probeState = null;
  const res = createResCapture();
  const liveFrames = [];
  const wsClient = {
    readyState: 1,
    send(frame) {
      liveFrames.push(JSON.parse(String(frame)));
    }
  };
  const state = {
    accounts: { codex: [], gemini: [], claude: [] },
    __webUiAccountsLive: {
      records: new Map(),
      metadata: new Map(),
      usageSnapshots: new Map(),
      watchers: new Set(),
      webSocketWatchers: new Set([{ client: wsClient, heartbeat: null }]),
      webSocketServer: null,
      loadedFromDisk: true,
      hydrating: false,
      queued: false,
      lastHydratedAt: 0,
      revision: 0,
      roleSignature: '',
      fastSnapshot: null,
      fastSnapshotAt: 0
    }
  };
  const handled = await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/accounts/codex/9/refresh-usage',
    url: new URL('http://localhost/v0/webui/accounts/codex/9/refresh-usage'),
    req: { headers: {} },
    res,
    options: {},
    state,
    deps: {
      aiHomeDir: '/tmp/aih',
      fs: {
        existsSync(filePath) {
          return String(filePath).endsWith('/auth.json');
        },
        readFileSync() {
          return JSON.stringify({ tokens: {} });
        },
        mkdirSync() {},
        writeFileSync() {}
      },
      writeJson: (response, code, payload) => {
        response.statusCode = code;
        response.end(JSON.stringify(payload));
      },
      readRequestBody: async () => null,
      accountStateIndex: {
        getAccountState(provider, accountId) {
          if (provider === 'codex' && accountId === '9') {
            return {
              configured: true,
              api_key_mode: false,
              remaining_pct: null,
              display_name: 'refresh@example.com',
              updated_at: 111
            };
          }
          return null;
        }
      },
      getToolAccountIds(provider) {
        return provider === 'codex' ? ['9'] : [];
      },
      getToolConfigDir: () => '/tmp/codex/9/.codex',
      getProfileDir: () => '/tmp/codex/9',
      ensureUsageSnapshotAsync: async () => {
        probeState = {
          error: 'timeout',
          checkedAt: Date.now()
        };
        return null;
      },
      getLastUsageProbeState() {
        return probeState;
      },
      loadServerRuntimeAccounts: () => ({
        codex: [{ id: '9', email: 'refresh@example.com', apiKeyMode: false }],
        gemini: [],
        claude: []
      }),
      applyReloadState(state, runtimeAccounts) {
        state.accounts = runtimeAccounts;
      },
      checkStatus() {
        return { configured: true, accountName: 'refresh@example.com' };
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 202);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.accepted, true);
  assert.equal(body.alreadyRunning, false);
  assert.equal(body.job.provider, 'codex');
  assert.equal(body.job.accountId, '9');
  assert.equal(body.job.status, 'queued');
  assert.equal(probeState, null);
  assert.equal(liveFrames.some((frame) => frame.type === 'account-refresh-job' && frame.job.status === 'queued'), true);

  assert.equal(
    await waitFor(() => liveFrames.some((frame) => frame.type === 'account-refresh-job' && frame.job.status === 'succeeded')),
    true
  );
  assert.ok(probeState);
  const accountFrame = liveFrames.find((frame) => frame.type === 'account');
  assert.ok(accountFrame);
  assert.equal(accountFrame.account.provider, 'codex');
  assert.equal(accountFrame.account.accountId, '9');
  assert.equal(accountFrame.account.updatedAt, probeState.checkedAt);
  assert.equal(accountFrame.account.quotaStatus, 'probe_failed');
});

test('web ui refresh usage rejects api key accounts', async () => {
  const res = createResCapture();
  const reconcileCalls = [];
  const handled = await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/accounts/codex/12/refresh-usage',
    url: new URL('http://localhost/v0/webui/accounts/codex/12/refresh-usage'),
    req: { headers: {} },
    res,
    options: {},
    state: {
      accounts: { codex: [], gemini: [], claude: [] }
    },
    deps: {
      fs: {
        existsSync(filePath) {
          return String(filePath).endsWith('/.aih_env.json');
        },
        readFileSync() {
          return JSON.stringify({ OPENAI_API_KEY: 'dummy' });
        }
      },
      writeJson: (response, code, payload) => {
        response.statusCode = code;
        response.end(JSON.stringify(payload));
      },
      readRequestBody: async () => null,
      accountStateIndex: {
        getAccountState(provider, accountId) {
          if (provider === 'codex' && accountId === '12') {
            return {
              configured: true,
              api_key_mode: true,
              runtime_state: buildAuthInvalidRuntimeState('auth_invalid_reauth_required'),
              display_name: 'codex-12',
              updated_at: 123
            };
          }
          return null;
        }
      },
      getToolAccountIds(provider) {
        return provider === 'codex' ? ['12'] : [];
      },
      getToolConfigDir: () => '/tmp/codex/12/.codex',
      getProfileDir: () => '/tmp/codex/12',
      codexAuthInvalidReconciler: {
        enqueueAuthInvalidReauthRequired(provider, accountId, reason) {
          reconcileCalls.push({ provider, accountId, reason });
          return true;
        }
      },
      checkStatus() {
        return { configured: true, accountName: 'API Key' };
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'api_key_usage_refresh_unsupported');
  assert.deepEqual(reconcileCalls, [{
    provider: 'codex',
    accountId: '12',
    reason: 'auth_invalid_reauth_required'
  }]);
});

test('web ui refresh usage enqueues auth-invalid api key account from runtime state', async () => {
  const res = createResCapture();
  const reconcileCalls = [];
  const handled = await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/accounts/codex/13/refresh-usage',
    url: new URL('http://localhost/v0/webui/accounts/codex/13/refresh-usage'),
    req: { headers: {} },
    res,
    options: {},
    state: {
      accounts: {
        codex: [{
          id: '13',
          provider: 'codex',
          apiKeyMode: true,
          authInvalidUntil: Date.now() + 3600000,
          lastFailureReason: 'auth_invalid_reauth_required'
        }],
        gemini: [],
        claude: []
      }
    },
    deps: {
      fs: {
        existsSync(filePath) {
          return String(filePath).endsWith('/.aih_env.json');
        },
        readFileSync() {
          return JSON.stringify({ OPENAI_API_KEY: 'dummy' });
        }
      },
      writeJson: (response, code, payload) => {
        response.statusCode = code;
        response.end(JSON.stringify(payload));
      },
      readRequestBody: async () => null,
      accountStateIndex: {
        getAccountState() {
          return null;
        }
      },
      getToolAccountIds(provider) {
        return provider === 'codex' ? ['13'] : [];
      },
      getToolConfigDir: () => '/tmp/codex/13/.codex',
      getProfileDir: () => '/tmp/codex/13',
      codexAuthInvalidReconciler: {
        enqueueAuthInvalidReauthRequired(provider, accountId, reason) {
          reconcileCalls.push({ provider, accountId, reason });
          return true;
        }
      },
      checkStatus() {
        return { configured: true, accountName: 'API Key' };
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(reconcileCalls, [{
    provider: 'codex',
    accountId: '13',
    reason: 'auth_invalid_reauth_required'
  }]);
});

test('web ui set-default updates default pointer and syncs host config', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-set-default-'));
  try {
    const profileDir = path.join(aiHomeDir, 'profiles', 'codex', '42');
    const configDir = path.join(profileDir, '.codex');
    fs.ensureDirSync(configDir);
    fs.writeFileSync(path.join(configDir, 'auth.json'), JSON.stringify({
      tokens: {
        access_token: 'access-token',
        refresh_token: 'rt_token'
      }
    }), 'utf8');
    const res = createResCapture();
    const sessionLinks = [];
    const syncCalls = [];

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/codex/42/set-default',
      url: new URL('http://localhost/v0/webui/accounts/codex/42/set-default'),
      req: { headers: {} },
      res,
      options: {},
      state: {
        accounts: {
          codex: [{ id: '42', email: 'default@example.com', apiKeyMode: false }],
          gemini: [],
          claude: []
        }
      },
      deps: {
        aiHomeDir,
        fs,
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
              display_name: 'default@example.com',
              updated_at: 123
            };
          }
        },
        getToolAccountIds(provider) {
          return provider === 'codex' ? ['42'] : [];
        },
        getToolConfigDir: () => configDir,
        getProfileDir: () => profileDir,
        loadServerRuntimeAccounts: () => ({
          codex: [{ id: '42', email: 'default@example.com', apiKeyMode: false }],
          gemini: [],
          claude: []
        }),
        applyReloadState(state, runtimeAccounts) {
          state.accounts = runtimeAccounts;
        },
        checkStatus() {
          return { configured: true, accountName: 'default@example.com' };
        },
        ensureSessionStoreLinks(provider, accountId) {
          sessionLinks.push({ provider, accountId });
        },
        syncGlobalConfigToHost(provider, accountId) {
          syncCalls.push({ provider, accountId });
          return { ok: true };
        }
      }
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.account.isDefault, true);
    assert.equal(fs.readFileSync(path.join(aiHomeDir, 'profiles', 'codex', '.aih_default'), 'utf8'), '42');
    assert.deepEqual(sessionLinks, [{ provider: 'codex', accountId: '42' }]);
    assert.deepEqual(syncCalls, [{ provider: 'codex', accountId: '42' }]);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui clear-default clears only the current default pointer', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-clear-default-'));
  try {
    const profileDir = path.join(aiHomeDir, 'profiles', 'codex', '42');
    const configDir = path.join(profileDir, '.codex');
    fs.ensureDirSync(configDir);
    fs.writeFileSync(path.join(configDir, 'auth.json'), JSON.stringify({
      tokens: {
        access_token: 'access-token',
        refresh_token: 'rt_token'
      }
    }), 'utf8');
    fs.writeFileSync(path.join(aiHomeDir, 'profiles', 'codex', '.aih_default'), '42', 'utf8');

    const res = createResCapture();
    const syncCalls = [];
    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/codex/42/clear-default',
      url: new URL('http://localhost/v0/webui/accounts/codex/42/clear-default'),
      req: { headers: {} },
      res,
      options: {},
      state: {
        accounts: {
          codex: [{ id: '42', email: 'default@example.com', apiKeyMode: false }],
          gemini: [],
          claude: []
        }
      },
      deps: {
        aiHomeDir,
        fs,
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
              display_name: 'default@example.com',
              updated_at: 123
            };
          }
        },
        getToolAccountIds(provider) {
          return provider === 'codex' ? ['42'] : [];
        },
        getToolConfigDir: () => configDir,
        getProfileDir: () => profileDir,
        loadServerRuntimeAccounts: () => ({
          codex: [{ id: '42', email: 'default@example.com', apiKeyMode: false }],
          gemini: [],
          claude: []
        }),
        applyReloadState(state, runtimeAccounts) {
          state.accounts = runtimeAccounts;
        },
        checkStatus() {
          return { configured: true, accountName: 'default@example.com' };
        },
        syncGlobalConfigToHost(provider, accountId) {
          syncCalls.push({ provider, accountId });
          return { ok: true };
        }
      }
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.account.isDefault, false);
    assert.equal(fs.existsSync(path.join(aiHomeDir, 'profiles', 'codex', '.aih_default')), false);
    assert.deepEqual(syncCalls, []);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui set-default rejects pending oauth accounts', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-set-default-pending-'));
  try {
    const res = createResCapture();
    const syncCalls = [];

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/codex/9/set-default',
      url: new URL('http://localhost/v0/webui/accounts/codex/9/set-default'),
      req: { headers: {} },
      res,
      options: {},
      state: {
        accounts: { codex: [], gemini: [], claude: [], agy: [] }
      },
      deps: {
        aiHomeDir,
        fs: {
          existsSync() {
            return false;
          },
          readFileSync() {
            throw new Error('unexpected_read');
          }
        },
        writeJson: (response, code, payload) => {
          response.statusCode = code;
          response.end(JSON.stringify(payload));
        },
        readRequestBody: async () => null,
        accountStateIndex: {
          getAccountState(provider, accountId) {
            if (provider !== 'codex' || accountId !== '9') return null;
            return {
              status: 'down',
              configured: false,
              api_key_mode: false,
              auth_mode: 'oauth-browser',
              display_name: 'OAuth 授权中',
              updated_at: Date.now()
            };
          }
        },
        getToolAccountIds(provider) {
          return provider === 'codex' ? ['9'] : [];
        },
        getToolConfigDir: () => path.join(aiHomeDir, 'profiles', 'codex', '9', '.codex'),
        getProfileDir: () => path.join(aiHomeDir, 'profiles', 'codex', '9'),
        syncGlobalConfigToHost(provider, accountId) {
          syncCalls.push({ provider, accountId });
          return { ok: true };
        }
      }
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'account_auth_pending');
    assert.deepEqual(syncCalls, []);
    assert.equal(fs.existsSync(path.join(aiHomeDir, 'profiles', 'codex', '.aih_default')), false);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui set-default rejects unconfigured api key accounts', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-set-default-unconfigured-'));
  try {
    const res = createResCapture();
    const syncCalls = [];

    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/codex/8/set-default',
      url: new URL('http://localhost/v0/webui/accounts/codex/8/set-default'),
      req: { headers: {} },
      res,
      options: {},
      state: {
        accounts: { codex: [], gemini: [], claude: [], agy: [] }
      },
      deps: {
        aiHomeDir,
        fs: {
          existsSync() {
            return false;
          },
          readFileSync() {
            throw new Error('unexpected_read');
          }
        },
        writeJson: (response, code, payload) => {
          response.statusCode = code;
          response.end(JSON.stringify(payload));
        },
        readRequestBody: async () => null,
        accountStateIndex: {
          getAccountState(provider, accountId) {
            if (provider !== 'codex' || accountId !== '8') return null;
            return {
              status: 'down',
              configured: false,
              api_key_mode: true,
              auth_mode: 'api-key',
              display_name: '',
              updated_at: Date.now()
            };
          }
        },
        getToolAccountIds(provider) {
          return provider === 'codex' ? ['8'] : [];
        },
        getToolConfigDir: () => path.join(aiHomeDir, 'profiles', 'codex', '8', '.codex'),
        getProfileDir: () => path.join(aiHomeDir, 'profiles', 'codex', '8'),
        checkStatus() {
          return { configured: false, accountName: '' };
        },
        syncGlobalConfigToHost(provider, accountId) {
          syncCalls.push({ provider, accountId });
          return { ok: true };
        }
      }
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'account_unconfigured');
    assert.deepEqual(syncCalls, []);
    assert.equal(fs.existsSync(path.join(aiHomeDir, 'profiles', 'codex', '.aih_default')), false);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui set-mobile updates codex desktop hook state without changing default pointer', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-set-mobile-'));
  try {
    const profileDir = path.join(aiHomeDir, 'profiles', 'codex', '10009');
    const configDir = path.join(profileDir, '.codex');
    fs.ensureDirSync(configDir);
    fs.writeFileSync(path.join(configDir, 'auth.json'), JSON.stringify({
      tokens: {
        access_token: 'access-token',
        refresh_token: 'rt_token'
      }
    }), 'utf8');
    fs.writeFileSync(path.join(aiHomeDir, 'codex-desktop-hook-state.json'), JSON.stringify({
      enabled: true,
      desktopAccountId: '10001',
      traceFile: '/tmp/trace.jsonl',
      traceResponses: true
    }, null, 2), 'utf8');

    const res = createResCapture();
    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/codex/10009/set-mobile',
      url: new URL('http://localhost/v0/webui/accounts/codex/10009/set-mobile'),
      req: { headers: {} },
      res,
      options: {},
      state: {
        accounts: {
          codex: [{ id: '10009', email: 'mobile@example.com', apiKeyMode: false }],
          gemini: [],
          claude: []
        }
      },
      deps: {
        aiHomeDir,
        fs,
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
              display_name: 'mobile@example.com',
              updated_at: 123
            };
          }
        },
        getToolAccountIds(provider) {
          return provider === 'codex' ? ['10009'] : [];
        },
        getToolConfigDir: () => configDir,
        getProfileDir: () => profileDir,
        loadServerRuntimeAccounts: () => ({
          codex: [{ id: '10009', email: 'mobile@example.com', apiKeyMode: false }],
          gemini: [],
          claude: []
        }),
        applyReloadState(state, runtimeAccounts) {
          state.accounts = runtimeAccounts;
        },
        checkStatus() {
          return { configured: true, accountName: 'mobile@example.com' };
        }
      }
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const hookState = JSON.parse(fs.readFileSync(path.join(aiHomeDir, 'codex-desktop-hook-state.json'), 'utf8'));
    assert.equal(body.ok, true);
    assert.equal(body.account.isMobile, true);
    assert.equal(hookState.desktopAccountId, '10009');
    assert.equal(hookState.traceFile, '/tmp/trace.jsonl');
    assert.equal(hookState.traceResponses, true);
    assert.equal(fs.existsSync(path.join(aiHomeDir, 'profiles', 'codex', '.aih_default')), false);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui clear-mobile clears only the current Codex App account pointer', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-clear-mobile-'));
  try {
    const profileDir = path.join(aiHomeDir, 'profiles', 'codex', '10009');
    const configDir = path.join(profileDir, '.codex');
    fs.ensureDirSync(configDir);
    fs.writeFileSync(path.join(configDir, 'auth.json'), JSON.stringify({
      tokens: {
        access_token: 'access-token',
        refresh_token: 'rt_token'
      }
    }), 'utf8');
    fs.writeFileSync(path.join(aiHomeDir, 'profiles', 'codex', '.aih_default'), '12', 'utf8');
    fs.writeFileSync(path.join(aiHomeDir, 'codex-desktop-hook-state.json'), JSON.stringify({
      enabled: true,
      desktopAccountId: '10009',
      traceFile: '/tmp/trace.jsonl',
      traceResponses: true
    }, null, 2), 'utf8');

    const res = createResCapture();
    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/codex/10009/clear-mobile',
      url: new URL('http://localhost/v0/webui/accounts/codex/10009/clear-mobile'),
      req: { headers: {} },
      res,
      options: {},
      state: {
        accounts: {
          codex: [{ id: '10009', email: 'mobile@example.com', apiKeyMode: false }],
          gemini: [],
          claude: []
        }
      },
      deps: {
        aiHomeDir,
        fs,
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
              display_name: 'mobile@example.com',
              updated_at: 123
            };
          }
        },
        getToolAccountIds(provider) {
          return provider === 'codex' ? ['10009'] : [];
        },
        getToolConfigDir: () => configDir,
        getProfileDir: () => profileDir,
        loadServerRuntimeAccounts: () => ({
          codex: [{ id: '10009', email: 'mobile@example.com', apiKeyMode: false }],
          gemini: [],
          claude: []
        }),
        applyReloadState(state, runtimeAccounts) {
          state.accounts = runtimeAccounts;
        },
        checkStatus() {
          return { configured: true, accountName: 'mobile@example.com' };
        }
      }
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const hookState = JSON.parse(fs.readFileSync(path.join(aiHomeDir, 'codex-desktop-hook-state.json'), 'utf8'));
    assert.equal(body.ok, true);
    assert.equal(body.account.isMobile, false);
    assert.equal(Object.prototype.hasOwnProperty.call(hookState, 'desktopAccountId'), false);
    assert.equal(hookState.traceFile, '/tmp/trace.jsonl');
    assert.equal(hookState.traceResponses, true);
    assert.equal(fs.readFileSync(path.join(aiHomeDir, 'profiles', 'codex', '.aih_default'), 'utf8'), '12');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui set-mobile rejects codex api-key accounts', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-set-mobile-apikey-'));
  try {
    const profileDir = path.join(aiHomeDir, 'profiles', 'codex', '10');
    const configDir = path.join(profileDir, '.codex');
    fs.ensureDirSync(configDir);
    fs.writeFileSync(path.join(profileDir, '.aih_env.json'), JSON.stringify({
      OPENAI_API_KEY: 'sk-test',
      OPENAI_BASE_URL: 'https://api.example.test/v1'
    }), 'utf8');
    fs.writeFileSync(path.join(configDir, 'auth.json'), JSON.stringify({
      OPENAI_API_KEY: 'sk-test'
    }), 'utf8');

    const res = createResCapture();
    const handled = await handleWebUIRequest({
      method: 'POST',
      pathname: '/v0/webui/accounts/codex/10/set-mobile',
      url: new URL('http://localhost/v0/webui/accounts/codex/10/set-mobile'),
      req: { headers: {} },
      res,
      options: {},
      state: {
        accounts: {
          codex: [{ id: '10', accountId: '10', apiKeyMode: true, authType: 'api-key', openaiBaseUrl: 'https://api.example.test/v1' }],
          gemini: [],
          claude: []
        }
      },
      deps: {
        aiHomeDir,
        fs,
        writeJson: (response, code, payload) => {
          response.statusCode = code;
          response.end(JSON.stringify(payload));
        },
        readRequestBody: async () => null,
        accountStateIndex: {
          getAccountState() {
            return {
              configured: true,
              api_key_mode: true,
              display_name: 'API Key',
              updated_at: 123
            };
          }
        },
        getToolAccountIds(provider) {
          return provider === 'codex' ? ['10'] : [];
        },
        getToolConfigDir: () => configDir,
        getProfileDir: () => profileDir,
        loadServerRuntimeAccounts: () => ({
          codex: [{ id: '10', accountId: '10', apiKeyMode: true, authType: 'api-key', openaiBaseUrl: 'https://api.example.test/v1' }],
          gemini: [],
          claude: []
        }),
        applyReloadState(state, runtimeAccounts) {
          state.accounts = runtimeAccounts;
        },
        checkStatus() {
          return { configured: true, accountName: 'API Key' };
        }
      }
    });

    assert.equal(handled, true);
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'missing_codex_desktop_oauth');
    assert.equal(body.message, 'Codex App 账号需要可用的 ChatGPT OAuth 授权。');
    assert.equal(fs.existsSync(path.join(aiHomeDir, 'codex-desktop-hook-state.json')), false);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('web ui accounts list refreshes role markers when default or mobile account changes', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-role-markers-'));
  try {
    const state = {
      accounts: {
        codex: [
          { id: '1', email: 'one@example.com', apiKeyMode: false },
          { id: '2', email: 'two@example.com', apiKeyMode: false }
        ],
        gemini: [],
        claude: []
      }
    };
    for (const id of ['1', '2']) {
      const configDir = path.join(aiHomeDir, 'profiles', 'codex', id, '.codex');
      fs.ensureDirSync(configDir);
      fs.writeFileSync(path.join(configDir, 'auth.json'), JSON.stringify({
        tokens: {
          access_token: `access-token-${id}`,
          refresh_token: `refresh-token-${id}`
        }
      }), 'utf8');
    }
    fs.writeFileSync(path.join(aiHomeDir, 'profiles', 'codex', '.aih_default'), '1', 'utf8');
    fs.writeFileSync(path.join(aiHomeDir, 'codex-desktop-hook-state.json'), JSON.stringify({
      enabled: true,
      desktopAccountId: '1'
    }), 'utf8');

    const buildDeps = () => ({
      aiHomeDir,
      fs,
      writeJson: (response, code, payload) => {
        response.statusCode = code;
        response.end(JSON.stringify(payload));
      },
      readRequestBody: async () => null,
      accountStateIndex: {
        listStates(provider) {
          return provider === 'codex'
            ? [
                { accountId: '1', configured: true, api_key_mode: false, display_name: 'one@example.com' },
                { accountId: '2', configured: true, api_key_mode: false, display_name: 'two@example.com' }
              ]
            : [];
        },
        getAccountState(provider, accountId) {
          if (provider !== 'codex') return null;
          return {
            accountId,
            configured: true,
            api_key_mode: false,
            display_name: accountId === '1' ? 'one@example.com' : 'two@example.com'
          };
        }
      },
      getToolAccountIds(provider) {
        return provider === 'codex' ? ['1', '2'] : [];
      },
      getToolConfigDir(provider, accountId) {
        return path.join(aiHomeDir, 'profiles', provider, accountId, '.codex');
      },
      getProfileDir(provider, accountId) {
        return path.join(aiHomeDir, 'profiles', provider, accountId);
      },
      loadServerRuntimeAccounts: () => state.accounts,
      applyReloadState(nextState, runtimeAccounts) {
        nextState.accounts = runtimeAccounts;
      },
      checkStatus(_provider, profileDir) {
        const id = path.basename(profileDir);
        return { configured: true, accountName: id === '1' ? 'one@example.com' : 'two@example.com' };
      }
    });
    const requestList = async () => {
      const res = createResCapture();
      const handled = await handleWebUIRequest({
        method: 'GET',
        pathname: '/v0/webui/accounts',
        url: new URL('http://localhost/v0/webui/accounts'),
        req: { headers: {} },
        res,
        options: {},
        state,
        deps: buildDeps()
      });
      assert.equal(handled, true);
      assert.equal(res.statusCode, 200);
      return JSON.parse(res.body).accounts;
    };

    const first = await requestList();
    assert.equal(first.find((account) => account.accountId === '1').isDefault, true);
    assert.equal(first.find((account) => account.accountId === '1').isMobile, true);

    fs.writeFileSync(path.join(aiHomeDir, 'profiles', 'codex', '.aih_default'), '2', 'utf8');
    fs.writeFileSync(path.join(aiHomeDir, 'codex-desktop-hook-state.json'), JSON.stringify({
      enabled: true,
      desktopAccountId: '2'
    }), 'utf8');

    const second = await requestList();
    assert.equal(second.find((account) => account.accountId === '1').isDefault, false);
    assert.equal(second.find((account) => account.accountId === '1').isMobile, false);
    assert.equal(second.find((account) => account.accountId === '2').isDefault, true);
    assert.equal(second.find((account) => account.accountId === '2').isMobile, true);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
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

test('web ui accounts list does not keep stale depleted state when codex snapshot has no numeric remaining', async () => {
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
                { bucket: 'account', window: 'plan:plus user@example.com', remainingPct: null, resetIn: 'unknown' }
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
          if (provider === 'codex' && accountId === '81') {
            return {
              configured: true,
              api_key_mode: false,
              remaining_pct: 0,
              display_name: 'user@example.com',
              updated_at: 999
            };
          }
          return null;
        }
      },
      getToolAccountIds(provider) {
        return provider === 'codex' ? ['81'] : [];
      },
      getToolConfigDir: () => '/tmp/codex/81/.codex',
      getProfileDir: () => '/tmp/codex/81',
      loadServerRuntimeAccounts: () => ({ codex: [], gemini: [], claude: [] }),
      applyReloadState: () => {},
      checkStatus() {
        return { configured: true, accountName: 'user@example.com' };
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.accounts.length, 1);
  assert.equal(body.accounts[0].remainingPct, null);
  // 没有额度数据的账号应该标记为 pending 而不是 provider_unavailable
  assert.equal(body.accounts[0].quotaStatus, 'pending');
  assert.equal(body.accounts[0].quotaReason, 'provider_returned_no_numeric_usage');
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

test('web ui accounts list reads AGY Code Assist quota snapshot models for account details', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-route-agy-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profileDir = path.join(root, 'profiles', 'agy', '9');
  const configDir = path.join(profileDir, '.gemini', 'antigravity-cli');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'email.cache'), 'agy@example.com', 'utf8');
  fs.writeFileSync(path.join(configDir, 'antigravity-oauth-token'), JSON.stringify({
    auth_method: 'oauth',
    token: {
      access_token: 'agy-token'
    }
  }));
  fs.writeFileSync(path.join(profileDir, '.aih_usage.json'), JSON.stringify({
    schemaVersion: 2,
    kind: 'agy_code_assist_quota',
    source: 'agy_fetch_available_models',
    capturedAt: Date.now(),
    account: {
      email: 'agy@example.com',
      planType: 'oauth',
      subscriptionTier: 'Google AI Pro',
      project: 'projects/agy'
    },
    models: [
      { model: 'claude-sonnet-4-6', remainingPct: 17, resetIn: '1h', resetAtMs: Date.now() + 3600000 },
      { model: 'gemini-3.5-flash-high', remainingPct: 62, resetIn: '2h', resetAtMs: Date.now() + 7200000 }
    ]
  }, null, 2));

  const res = createResCapture();
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/accounts',
    url: new URL('http://localhost/v0/webui/accounts'),
    req: { headers: {} },
    res,
    options: {},
    state: {
      accounts: { codex: [], gemini: [], claude: [], agy: [] }
    },
    deps: {
      fs,
      writeJson: (response, code, payload) => {
        response.statusCode = code;
        response.end(JSON.stringify(payload));
      },
      readRequestBody: async () => null,
      accountStateIndex: {
        getAccountState(provider, accountId) {
          if (provider === 'agy' && accountId === '9') {
            return {
              status: 'up',
              configured: true,
              api_key_mode: false,
              remaining_pct: 99,
              display_name: 'stale@example.com',
              updated_at: 222
            };
          }
          return null;
        }
      },
      getToolAccountIds(provider) {
        return provider === 'agy' ? ['9'] : [];
      },
      getToolConfigDir(provider, accountId) {
        return path.join(root, 'profiles', provider, accountId, '.gemini', 'antigravity-cli');
      },
      getProfileDir(provider, accountId) {
        return path.join(root, 'profiles', provider, accountId);
      },
      loadServerRuntimeAccounts: () => ({ codex: [], gemini: [], claude: [], agy: [] }),
      applyReloadState: () => {},
      checkStatus() {
        return { configured: true, accountName: 'agy@example.com' };
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  const agy = body.accounts.find((account) => account.provider === 'agy' && account.accountId === '9');
  assert.ok(agy);
  assert.equal(agy.remainingPct, 17);
  assert.equal(agy.quotaStatus, 'available');
  assert.equal(agy.email, 'agy@example.com');
  assert.equal(agy.usageSnapshot.kind, 'agy_code_assist_quota');
  assert.equal(agy.usageSnapshot.account.subscriptionTier, 'Google AI Pro');
  assert.equal(agy.usageSnapshot.models.length, 2);
  assert.equal(agy.usageSnapshot.models[0].model, 'claude-sonnet-4-6');
});

test('web ui accounts list classifies codex team fallback without numeric rate limits as plan-specific unavailable', async () => {
  const res = createResCapture();
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
          return String(filePath).endsWith('/.aih_usage.json') || String(filePath).endsWith('/auth.json');
        },
        readFileSync(filePath) {
          if (String(filePath).endsWith('/.aih_usage.json')) {
            return JSON.stringify({
              schemaVersion: 2,
              kind: 'codex_oauth_status',
              source: 'codex_app_server',
              capturedAt: 1776703050450,
              fallbackSource: 'account_read',
              account: {
                planType: 'team',
                email: 'code5@meadeo.com'
              },
              entries: [
                {
                  bucket: 'account',
                  windowMinutes: 0,
                  window: 'plan:team code5@meadeo.com',
                  remainingPct: null,
                  resetIn: 'unknown',
                  resetAtMs: 0
                }
              ]
            });
          }
          if (String(filePath).endsWith('/auth.json')) {
            return JSON.stringify({
              tokens: {
                access_token: 'header.' + Buffer.from(JSON.stringify({
                  'https://api.openai.com/auth': {
                    chatgpt_plan_type: 'team'
                  },
                  'https://api.openai.com/profile': {
                    email: 'code5@meadeo.com'
                  }
                })).toString('base64') + '.sig'
              }
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
          if (provider === 'codex' && accountId === '5') {
            return {
              configured: true,
              api_key_mode: false,
              remaining_pct: null,
              display_name: 'code5@meadeo.com',
              updated_at: 1776703050450
            };
          }
          return null;
        }
      },
      getToolAccountIds(provider) {
        return provider === 'codex' ? ['5'] : [];
      },
      getToolConfigDir: () => '/tmp/codex/5/.codex',
      getProfileDir: () => '/tmp/codex/5',
      loadServerRuntimeAccounts: () => ({ codex: [], gemini: [], claude: [] }),
      applyReloadState: () => {},
      checkStatus() {
        return { configured: true, accountName: 'code5@meadeo.com' };
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.accounts.length, 1);
  // Team 账号没有额度数据时，标记为 pending 而不是 provider_unavailable
  assert.equal(body.accounts[0].quotaStatus, 'pending');
  assert.equal(body.accounts[0].quotaReason, 'codex_team_plan_pending_rate_limits');
  assert.equal(body.accounts[0].usageSnapshot.fallbackSource, 'account_read');
  assert.equal(body.accounts[0].usageSnapshot.account.planType, 'team');
});

test('web ui accounts list treats auth-json-only codex metadata as pending until real usage is collected', async () => {
  const res = createResCapture();
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
        readFileSync(filePath) {
          if (String(filePath).endsWith('/auth.json')) {
            return JSON.stringify({
              organization_id: 'org_9',
              tokens: {
                access_token: 'header.' + Buffer.from(JSON.stringify({
                  'https://api.openai.com/auth': {
                    chatgpt_plan_type: 'team',
                    chatgpt_account_id: 'acc_9'
                  },
                  'https://api.openai.com/profile': {
                    email: 'auth-only@example.com'
                  }
                })).toString('base64') + '.sig'
              }
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
          if (provider === 'codex' && accountId === '9') {
            return {
              configured: true,
              api_key_mode: false,
              remaining_pct: null,
              display_name: 'auth-only@example.com',
              updated_at: 1776703050450
            };
          }
          return null;
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
        return { configured: true, accountName: 'auth-only@example.com' };
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.accounts.length, 1);
  assert.equal(body.accounts[0].quotaStatus, 'pending');
  assert.equal(body.accounts[0].quotaReason, 'auth_metadata_only');
  assert.equal(body.accounts[0].remainingPct, null);
  assert.equal(body.accounts[0].usageSnapshot.fallbackSource, 'auth_json');
  assert.equal(body.accounts[0].usageSnapshot.account.planType, 'team');
  assert.equal(body.accounts[0].usageSnapshot.account.email, 'auth-only@example.com');
});

test('web ui accounts list does not render agy keyring-only accounts as exhausted', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-route-agy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profileDir = path.join(root, 'profiles', 'agy', '1');
  const configDir = path.join(profileDir, '.gemini', 'antigravity-cli');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'antigravity-oauth-token'),
    JSON.stringify({
      token: {
        access_token: 'dummy-access-token'
      },
      auth_method: 'oauth'
    }),
    'utf8'
  );

  const res = createResCapture();
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/accounts',
    url: new URL('http://localhost/v0/webui/accounts'),
    req: { headers: {} },
    res,
    options: {},
    state: {
      accounts: { codex: [], gemini: [], claude: [], agy: [] }
    },
    deps: {
      fs,
      writeJson: (response, code, payload) => {
        response.statusCode = code;
        response.end(JSON.stringify(payload));
      },
      readRequestBody: async () => null,
      accountStateIndex: {
        getAccountState(provider, accountId) {
          if (provider === 'agy' && accountId === '1') {
            return {
              status: 'up',
              configured: true,
              api_key_mode: false,
              remaining_pct: 0,
              display_name: 'agy@example.com',
              updated_at: 1776703050450
            };
          }
          return null;
        }
      },
      getToolAccountIds(provider) {
        return provider === 'agy' ? ['1'] : [];
      },
      getToolConfigDir(provider, accountId) {
        return path.join(root, 'profiles', provider, accountId, provider === 'agy' ? '.gemini/antigravity-cli' : `.${provider}`);
      },
      getProfileDir(provider, accountId) {
        return path.join(root, 'profiles', provider, accountId);
      },
      loadServerRuntimeAccounts: () => ({ codex: [], gemini: [], claude: [], agy: [] }),
      applyReloadState: () => {},
      checkStatus() {
        return { configured: true, accountName: 'agy@example.com' };
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  const agy = body.accounts.find((account) => account.provider === 'agy' && account.accountId === '1');
  assert.ok(agy);
  assert.equal(agy.remainingPct, null);
  assert.equal(agy.quotaStatus, 'pending');
  assert.equal(agy.schedulableStatus, 'blocked_by_policy');
  assert.equal(agy.schedulableReason, 'agy_access_token_required');
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
  assert.match(res.body, /stale@example.com/);

  await new Promise((resolve) => setTimeout(resolve, 60));
  req.emit('close');

  assert.match(res.body, /"type":"hydrated"/);
  assert.match(res.body, /hydrated@example.com/);
});

test('web ui accounts snapshot request accepts immediately and refreshes watch in background', async () => {
  const state = {
    accounts: { codex: [], gemini: [], claude: [], agy: [] }
  };
  let runtimeReloadCalls = 0;
  const req = new EventEmitter();
  req.headers = {};
  const streamRes = createStreamResCapture();
  const deps = {
    fs: {
      existsSync(filePath) {
        return String(filePath).endsWith('/auth.json');
      },
      readFileSync() {
        return JSON.stringify({
          tokens: {
            id_token: 'header.eyJlbWFpbCI6InNuYXBzaG90LWZhc3RAZXhhbXBsZS5jb20ifQ==.signature'
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
          remaining_pct: 41,
          display_name: 'snapshot-stale@example.com',
          updated_at: 444
        };
      }
    },
    getToolAccountIds(provider) {
      return provider === 'codex' ? ['42'] : [];
    },
    getToolConfigDir: () => '/tmp/codex/42/.codex',
    getProfileDir: () => '/tmp/codex/42',
    loadServerRuntimeAccounts() {
      runtimeReloadCalls += 1;
      return {
        codex: [{ id: '42', email: 'runtime-after-snapshot@example.com' }],
        gemini: [],
        claude: [],
        agy: []
      };
    },
    applyReloadState(targetState, runtimeAccounts) {
      targetState.accounts = runtimeAccounts;
    },
    checkStatus() {
      return { configured: true, accountName: 'hydrated-after-snapshot@example.com' };
    }
  };

  const watchHandled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/accounts/watch',
    url: new URL('http://localhost/v0/webui/accounts/watch'),
    req,
    res: streamRes,
    options: {},
    state,
    deps
  });
  assert.equal(watchHandled, true);
  assert.equal(streamRes.statusCode, 200);
  assert.equal(runtimeReloadCalls, 0);

  const snapshotRes = createResCapture();
  const snapshotHandled = await handleWebUIRequest({
    method: 'POST',
    pathname: '/v0/webui/accounts/watch/snapshot',
    url: new URL('http://localhost/v0/webui/accounts/watch/snapshot'),
    req: { headers: {} },
    res: snapshotRes,
    options: {},
    state,
    deps
  });

  assert.equal(snapshotHandled, true);
  assert.equal(snapshotRes.statusCode, 202);
  assert.equal(runtimeReloadCalls, 0);
  assert.equal(JSON.parse(snapshotRes.body).accepted, true);

  const refreshed = await waitFor(() => (
    runtimeReloadCalls > 0
    && streamRes.body.includes('"type":"snapshot-requested"')
    && streamRes.body.includes('"type":"hydrated"')
    && streamRes.body.includes('hydrated-after-snapshot@example.com')
  ), 500);
  req.emit('close');

  assert.equal(refreshed, true);
});

test('web ui add codex oauth defaults to browser auth for normal login compatibility', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-add-browser-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const res = createResCapture();
  const startedCalls = [];
  const upserts = [];

  const handled = await handleAddAccountRequest({
    req: { headers: { host: 'localhost:8317' } },
    res,
    fs,
    deps: {},
    state: {},
    readRequestBody: async () => Buffer.from(JSON.stringify({ provider: 'codex' })),
    accountStateIndex: {
      upsertAccountState(provider, accountId, state) {
        upserts.push({ provider, accountId, state });
        return true;
      }
    },
    accountStateService: createAccountStateServiceRecorder(upserts),
    getToolAccountIds() {
      return ['1'];
    },
    getProfileDir(provider, accountId) {
      return path.join(root, provider, String(accountId));
    },
    getToolConfigDir(provider, accountId) {
      return path.join(root, provider, String(accountId), `.${provider}`);
    },
    getAuthJobManager() {
      return {
        startOauthJob(provider, authMode) {
          startedCalls.push({ provider, authMode });
          return {
            jobId: 'job-2',
            provider,
            accountId: '2',
            expiresAt: null,
            pollIntervalMs: 5000
          };
        }
      };
    },
    cleanupAuthJobArtifacts() {},
    loadServerRuntimeAccounts() {
      return { codex: [], gemini: [], claude: [] };
    },
    applyReloadState() {},
    checkStatus() {
      return { configured: false };
    },
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.authMode, 'oauth-browser');
  assert.equal(body.jobId, 'job-2');
  assert.deepEqual(startedCalls, [{ provider: 'codex', authMode: 'oauth-browser' }]);
  assert.equal(upserts[0].state.authMode, 'oauth-browser');
  assert.equal(upserts[0].state.displayName, '');
});

test('web ui add api key account persists base url domain as display name', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-add-api-key-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const res = createResCapture();
  const upserts = [];

  const handled = await handleAddAccountRequest({
    req: { headers: { host: 'accounts.example.com' } },
    res,
    fs,
    deps: {},
    state: {},
    options: { port: 8317 },
    readRequestBody: async () => Buffer.from(JSON.stringify({
      provider: 'codex',
      authMode: 'api-key',
      config: {
        apiKey: 'sk-test',
        baseUrl: 'https://proxy.example.com/v1'
      }
    })),
    accountStateIndex: {
      upsertAccountState(provider, accountId, state) {
        upserts.push({ provider, accountId, state });
        return true;
      }
    },
    accountStateService: createAccountStateServiceRecorder(upserts),
    getToolAccountIds() {
      return [];
    },
    getProfileDir(provider, accountId) {
      return path.join(root, provider, String(accountId));
    },
    getToolConfigDir(provider, accountId) {
      return path.join(root, provider, String(accountId), `.${provider}`);
    },
    getAuthJobManager() {
      throw new Error('should_not_start_oauth');
    },
    cleanupAuthJobArtifacts() {},
    loadServerRuntimeAccounts() {
      return { codex: [], gemini: [], claude: [] };
    },
    applyReloadState() {},
    checkStatus() {
      return { configured: true, accountName: 'API Key' };
    },
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.accountId, '1');
  assert.equal(upserts[0].state.apiKeyMode, true);
  assert.equal(upserts[0].state.displayName, 'proxy.example.com');
});

test('web ui rejects api key accounts that point back to the current AIH server', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-add-self-relay-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const res = createResCapture();
  const upserts = [];

  const handled = await handleAddAccountRequest({
    req: { headers: { host: 'accounts.example.com' } },
    res,
    fs,
    deps: {},
    state: {},
    options: { port: 8317 },
    readRequestBody: async () => Buffer.from(JSON.stringify({
      provider: 'claude',
      authMode: 'api-key',
      config: {
        apiKey: 'sk-test',
        baseUrl: 'http://127.0.0.1:8317/v1'
      }
    })),
    accountStateIndex: {
      upsertAccountState(provider, accountId, state) {
        upserts.push({ provider, accountId, state });
        return true;
      }
    },
    accountStateService: createAccountStateServiceRecorder(upserts),
    getToolAccountIds() {
      return [];
    },
    getProfileDir(provider, accountId) {
      return path.join(root, provider, String(accountId));
    },
    getToolConfigDir(provider, accountId) {
      return path.join(root, provider, String(accountId), `.${provider}`);
    },
    getAuthJobManager() {
      throw new Error('should_not_start_oauth');
    },
    cleanupAuthJobArtifacts() {},
    loadServerRuntimeAccounts() {
      return { codex: [], gemini: [], claude: [] };
    },
    applyReloadState() {},
    checkStatus() {
      return { configured: true, accountName: 'API Key' };
    },
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'self_relay_account_not_allowed');
  assert.equal(upserts.length, 0);
});

test('web ui add starts remote browser oauth job instead of rejecting remote webui', async () => {
  const res = createResCapture();
  const startedCalls = [];
  const upserts = [];

  const handled = await handleAddAccountRequest({
    req: { headers: { host: 'accounts.example.com' } },
    res,
    fs,
    deps: {},
    state: {},
    readRequestBody: async () => Buffer.from(JSON.stringify({
      provider: 'codex',
      authMode: 'oauth-browser'
    })),
    accountStateIndex: {
      upsertAccountState(provider, accountId, state) {
        upserts.push({ provider, accountId, state });
      }
    },
    accountStateService: createAccountStateServiceRecorder(upserts),
    getToolAccountIds() {
      return [];
    },
    getProfileDir() {
      return '/tmp/codex/1';
    },
    getToolConfigDir() {
      return '/tmp/codex/1/.codex';
    },
    getAuthJobManager() {
      return {
        startOauthJob(provider, authMode) {
          startedCalls.push({ provider, authMode });
          return {
            jobId: 'job-remote',
            provider,
            accountId: '1',
            expiresAt: null,
            pollIntervalMs: null
          };
        }
      };
    },
    cleanupAuthJobArtifacts() {},
    loadServerRuntimeAccounts() {
      return { codex: [], gemini: [], claude: [] };
    },
    applyReloadState() {},
    checkStatus() {
      return { configured: false };
    },
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.status, 'pending');
  assert.equal(body.jobId, 'job-remote');
  assert.deepEqual(startedCalls, [{ provider: 'codex', authMode: 'oauth-browser' }]);
  assert.equal(upserts[0].state.authMode, 'oauth-browser');
});

test('web ui reauth reuses original account id and stored auth mode for oauth accounts', async () => {
  const res = createResCapture();
  const startedCalls = [];
  const upserts = [];

  const handled = await handleReauthAccountRequest({
    pathname: '/v0/webui/accounts/codex/42/reauth',
    req: { headers: {} },
    res,
    fs: {
      existsSync(filePath) {
        return String(filePath) === '/tmp/codex/42' || String(filePath).endsWith('/auth.json');
      },
      readFileSync(filePath) {
        if (String(filePath).endsWith('/auth.json')) {
          return JSON.stringify({ tokens: { access_token: 'oauth-token' } });
        }
        throw new Error(`unexpected_read:${filePath}`);
      }
    },
    accountStateIndex: {
      getAccountState() {
        return {
          display_name: 'codex-user',
          api_key_mode: false,
          auth_mode: 'oauth-device'
        };
      },
      upsertAccountState(provider, accountId, state) {
        upserts.push({ provider, accountId, state });
        return true;
      }
    },
    accountStateService: createAccountStateServiceRecorder(upserts),
    getToolAccountIds() {
      return ['42'];
    },
    getProfileDir() {
      return '/tmp/codex/42';
    },
    getToolConfigDir() {
      return '/tmp/codex/42/.codex';
    },
    getAuthJobManager() {
      return {
        startOauthJob(provider, authMode, options) {
          startedCalls.push({ provider, authMode, options });
          return {
            jobId: 'job-42',
            provider,
            accountId: options.accountId,
            expiresAt: null,
            pollIntervalMs: 5000
          };
        }
      };
    },
    deps: {},
    state: {},
    checkStatus() {
      return { configured: true, accountName: 'codex-user' };
    },
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.provider, 'codex');
  assert.equal(body.accountId, '42');
  assert.equal(body.authMode, 'oauth-device');
  assert.equal(body.jobId, 'job-42');
  assert.deepEqual(startedCalls, [
    {
      provider: 'codex',
      authMode: 'oauth-device',
      options: {
        accountId: '42',
        previousAccountState: {
          status: 'up',
          configured: true,
          apiKeyMode: false,
          authMode: 'oauth-device',
          remainingPct: undefined,
          displayName: 'codex-user'
        }
      }
    }
  ]);
  assert.deepEqual(upserts, [
    {
      provider: 'codex',
      accountId: '42',
      state: {
        status: 'up',
        configured: false,
        apiKeyMode: false,
        authMode: 'oauth-device',
        displayName: 'codex-user'
      }
    }
  ]);
});

test('web ui reauth starts remote codex browser oauth job', async () => {
  const res = createResCapture();
  const startedCalls = [];
  const upserts = [];

  const handled = await handleReauthAccountRequest({
    pathname: '/v0/webui/accounts/codex/42/reauth',
    req: { headers: { host: 'accounts.example.com' } },
    res,
    fs: {
      existsSync(filePath) {
        return String(filePath) === '/tmp/codex/42' || String(filePath).endsWith('/auth.json');
      },
      readFileSync(filePath) {
        if (String(filePath).endsWith('/auth.json')) {
          return JSON.stringify({ tokens: { access_token: 'oauth-token' } });
        }
        throw new Error(`unexpected_read:${filePath}`);
      }
    },
    accountStateIndex: {
      getAccountState() {
        return {
          display_name: 'codex-user',
          api_key_mode: false,
          auth_mode: 'oauth-browser'
        };
      },
      upsertAccountState(provider, accountId, state) {
        upserts.push({ provider, accountId, state });
        return true;
      }
    },
    accountStateService: createAccountStateServiceRecorder(upserts),
    getToolAccountIds() {
      return ['42'];
    },
    getProfileDir() {
      return '/tmp/codex/42';
    },
    getToolConfigDir() {
      return '/tmp/codex/42/.codex';
    },
    getAuthJobManager() {
      return {
        startOauthJob(provider, authMode, options) {
          startedCalls.push({ provider, authMode, options });
          return {
            jobId: 'job-42',
            provider,
            accountId: options.accountId,
            expiresAt: null,
            pollIntervalMs: 5000
          };
        }
      };
    },
    deps: {},
    state: {},
    checkStatus() {
      return { configured: true, accountName: 'codex-user' };
    },
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.jobId, 'job-42');
  assert.deepEqual(startedCalls, [
    {
      provider: 'codex',
      authMode: 'oauth-browser',
      options: {
        accountId: '42',
        previousAccountState: {
          status: 'up',
          configured: true,
          apiKeyMode: false,
          authMode: 'oauth-browser',
          remainingPct: undefined,
          displayName: 'codex-user'
        }
      }
    }
  ]);
  assert.equal(upserts[0].state.authMode, 'oauth-browser');
});

test('web ui forwards browser oauth callback through job manager', async () => {
  const res = createResCapture();
  const forwarded = [];

  const handled = await handleCompleteAddJobCallbackRequest({
    pathname: '/v0/webui/accounts/add/jobs/job-1/callback',
    req: {},
    res,
    deps: {},
    state: {},
    readRequestBody: async () => Buffer.from(JSON.stringify({
      callbackUrl: 'http://localhost:1455/auth/callback?code=ok&state=s-1'
    })),
    getAuthJobManager() {
      return {
        async completeBrowserOauthCallback(jobId, callbackUrl) {
          forwarded.push({ jobId, callbackUrl });
          return {
            ok: true,
            job: {
              id: jobId,
              provider: 'codex',
              accountId: '1',
              authMode: 'oauth-browser',
              status: 'running',
              logs: '',
              exitCode: null,
              createdAt: 1,
              updatedAt: 2
            }
          };
        }
      };
    },
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(forwarded, [
    {
      jobId: 'job-1',
      callbackUrl: 'http://localhost:1455/auth/callback?code=ok&state=s-1'
    }
  ]);
  assert.equal(JSON.parse(res.body).job.id, 'job-1');
});

test('web ui auth job poll cleans failed pending oauth account artifacts', async () => {
  const res = createResCapture();
  const failedJob = {
    id: 'job-failed',
    provider: 'codex',
    accountId: '9',
    authMode: 'oauth-browser',
    status: 'failed',
    authProgressState: 'failed',
    error: 'token_exchange_failed',
    updatedAt: Date.now()
  };
  let cleanedJob = null;

  const handled = await handleGetAddJobRequest({
    pathname: '/v0/webui/accounts/add/jobs/job-failed',
    res,
    deps: {},
    state: {},
    getAuthJobManager() {
      return {
        getJob() {
          return failedJob;
        }
      };
    },
    cleanupAuthJobArtifacts(job) {
      cleanedJob = job;
    },
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(cleanedJob, failedJob);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.job.status, 'failed');
});

test('web ui cancel auth job is idempotent when job was already cleaned up', async () => {
  const res = createResCapture();

  const handled = await handleCancelAddJobRequest({
    pathname: '/v0/webui/accounts/add/jobs/missing-job/cancel',
    res,
    deps: {},
    state: {},
    getAuthJobManager() {
      return {
        cancelJob() {
          return { ok: false, code: 'job_not_found' };
        }
      };
    },
    cleanupAuthJobArtifacts() {
      throw new Error('cleanup should not run for missing jobs');
    },
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.job.id, 'missing-job');
  assert.equal(body.job.status, 'cancelled');
  assert.equal(body.job.authProgressState, 'cancelled');
});

test('web ui cancel auth job returns cancelled auth progress state', async () => {
  const res = createResCapture();
  const cancelledJob = {
    id: 'job-1',
    provider: 'agy',
    accountId: '4',
    authMode: 'oauth-browser',
    status: 'cancelled',
    authProgressState: 'cancelled',
    error: '用户取消了 OAuth 授权流程',
    updatedAt: Date.now()
  };
  let cleanedJob = null;

  const handled = await handleCancelAddJobRequest({
    pathname: '/v0/webui/accounts/add/jobs/job-1/cancel',
    res,
    deps: {},
    state: {},
    getAuthJobManager() {
      return {
        cancelJob() {
          return { ok: true, job: cancelledJob };
        }
      };
    },
    cleanupAuthJobArtifacts(job) {
      cleanedJob = job;
    },
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(cleanedJob, cancelledJob);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.job.status, 'cancelled');
  assert.equal(body.job.authProgressState, 'cancelled');
});

test('web ui reauth rejects api key accounts', async () => {
  const res = createResCapture();
  let startCalled = false;

  const handled = await handleReauthAccountRequest({
    pathname: '/v0/webui/accounts/claude/7/reauth',
    req: { headers: {} },
    res,
    fs: {
      existsSync(filePath) {
        return String(filePath) === '/tmp/claude/7';
      },
      readFileSync() {
        throw new Error('unexpected_read');
      }
    },
    accountStateIndex: {
      getAccountState() {
        return {
          api_key_mode: true,
          display_name: 'claude-key'
        };
      }
    },
    getToolAccountIds() {
      return ['7'];
    },
    getProfileDir() {
      return '/tmp/claude/7';
    },
    getToolConfigDir() {
      return '/tmp/claude/7/.claude';
    },
    getAuthJobManager() {
      return {
        startOauthJob() {
          startCalled = true;
          throw new Error('should_not_start');
        }
      };
    },
    deps: {},
    state: {},
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'api_key_reauth_unsupported');
  assert.equal(startCalled, false);
});

test('web ui reauth starts oauth flow for unconfigured pending accounts', async () => {
  const res = createResCapture();
  const syncedStates = [];
  const startedJobs = [];
  const stateRow = {
    status: 'down',
    configured: false,
    api_key_mode: false,
    auth_mode: '',
    display_name: 'OAuth 授权中',
    updated_at: Date.now()
  };

  const handled = await handleReauthAccountRequest({
    pathname: '/v0/webui/accounts/codex/9/reauth',
    req: { headers: {} },
    res,
    fs: {
      existsSync() {
        return false;
      },
      readFileSync() {
        throw new Error('unexpected_read');
      }
    },
    accountStateIndex: {
      getAccountState(provider, accountId) {
        if (provider !== 'codex' || accountId !== '9') return null;
        return stateRow;
      }
    },
    accountStateService: {
      syncAccountBaseState(provider, accountId, state) {
        syncedStates.push({ provider, accountId, state });
        return true;
      }
    },
    getToolAccountIds(provider) {
      return provider === 'codex' ? ['9'] : [];
    },
    getProfileDir() {
      return '/tmp/codex/9';
    },
    getToolConfigDir() {
      return '/tmp/codex/9/.codex';
    },
    getAuthJobManager() {
      return {
        startOauthJob(provider, authMode, options) {
          startedJobs.push({ provider, authMode, options });
          return {
            provider,
            accountId: '10',
            jobId: 'job-pending-reauth',
            expiresAt: Date.now() + 300_000,
            pollIntervalMs: null,
            authorizationUrl: 'https://auth.example.test',
            redirectUri: 'http://127.0.0.1:1455/auth/callback',
            authProgressState: 'awaiting_callback'
          };
        }
      };
    },
    deps: {},
    state: {},
    checkStatus() {
      return { configured: false, accountName: '' };
    },
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(startedJobs.length, 1);
  assert.equal(startedJobs[0].provider, 'codex');
  assert.equal(startedJobs[0].authMode, 'oauth-browser');
  assert.equal(startedJobs[0].options.accountId, '9');
  assert.equal(startedJobs[0].options.previousAccountState.configured, false);
  assert.equal(syncedStates.length, 1);
  assert.equal(syncedStates[0].provider, 'codex');
  assert.equal(syncedStates[0].accountId, '9');
  assert.equal(syncedStates[0].state.configured, false);
  assert.equal(syncedStates[0].state.apiKeyMode, false);
  assert.equal(syncedStates[0].state.authMode, 'oauth-browser');
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.status, 'pending');
  assert.equal(body.accountId, '10');
  assert.equal(body.jobId, 'job-pending-reauth');
});

test('web ui account update rejects oauth accounts', async () => {
  const res = createResCapture();
  let wroteConfig = false;

  const handled = await handleUpdateAccountRequest({
    pathname: '/v0/webui/accounts/codex/42/update',
    req: { headers: {} },
    res,
    readRequestBody: async () => Buffer.from(JSON.stringify({
      apiKey: 'sk-should-not-write',
      baseUrl: 'https://api.example.test/v1'
    })),
    fs: {
      existsSync(filePath) {
        const text = String(filePath);
        return text === '/tmp/codex/42' || text.endsWith('/auth.json');
      },
      readFileSync(filePath) {
        if (String(filePath).endsWith('/auth.json')) {
          return JSON.stringify({ tokens: { access_token: 'oauth-token' } });
        }
        throw new Error(`unexpected_read:${filePath}`);
      },
      writeFileSync() {
        wroteConfig = true;
      },
      mkdirpSync() {},
      ensureDirSync() {},
      mkdirSync() {}
    },
    accountStateIndex: {
      getAccountState() {
        return {
          configured: true,
          api_key_mode: false,
          auth_mode: 'oauth-browser',
          display_name: 'oauth@example.com'
        };
      }
    },
    accountStateService: {
      syncAccountBaseState() {
        throw new Error('should_not_sync');
      }
    },
    getToolAccountIds() {
      return ['42'];
    },
    getProfileDir() {
      return '/tmp/codex/42';
    },
    getToolConfigDir() {
      return '/tmp/codex/42/.codex';
    },
    loadServerRuntimeAccounts() {
      throw new Error('should_not_reload');
    },
    applyReloadState() {},
    checkStatus() {
      return { configured: true, accountName: 'oauth@example.com' };
    },
    deps: {},
    state: {},
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'oauth_config_edit_unsupported');
  assert.equal(wroteConfig, false);
});

test('web ui account update switches claude api key account to auth-token credentials', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-claude-auth-token-update-'));
  try {
    const profileDir = path.join(root, 'profiles', 'claude', '6');
    const configDir = path.join(profileDir, '.claude');
    fs.ensureDirSync(configDir);
    fs.writeFileSync(path.join(profileDir, '.aih_env.json'), JSON.stringify({
      AIH_CLAUDE_CREDENTIAL_TYPE: 'api-key',
      ANTHROPIC_API_KEY: 'old-api-key',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com'
    }, null, 2), 'utf8');

    const syncedStates = [];
    const editedAccountRef = 'acct_aaaaaaaaaaaaaaaaaaaa';
    const otherAccountRef = 'acct_bbbbbbbbbbbbbbbbbbbb';
    const state = {
      accounts: {
        codex: [],
        gemini: [],
        claude: [{
          id: '6',
          accountId: '6',
          accountRef: editedAccountRef,
          provider: 'claude',
          apiKeyMode: true,
          authType: 'api-key'
        }]
      },
      webUiModelsCache: {
        updatedAt: Date.now(),
        byProvider: { claude: ['opus[1m]'] },
        byAccount: {
          [editedAccountRef]: ['opus[1m]'],
          [otherAccountRef]: ['sonnet[1m]']
        },
        errorsByAccount: { [editedAccountRef]: 'Unexpected token <' },
        accountUpdatedAt: {
          [editedAccountRef]: Date.now(),
          [otherAccountRef]: Date.now()
        },
        accountSource: {
          [editedAccountRef]: 'error',
          [otherAccountRef]: 'remote'
        },
        accountScanned: {
          [editedAccountRef]: 1,
          [otherAccountRef]: 1
        },
        labels: {},
        signature: 'stale',
        source: 'local',
        sourceCount: 1,
        scannedAccounts: 1,
        firstError: 'Unexpected token <'
      }
    };
    const res = createResCapture();
    const handled = await handleUpdateAccountRequest({
      pathname: '/v0/webui/accounts/claude/6/update',
      req: { headers: {} },
      res,
      readRequestBody: async () => Buffer.from(JSON.stringify({
        authMode: 'auth-token',
        apiKey: 'new-auth-token',
        baseUrl: 'https://anyrouter.top'
      })),
      fs,
      accountStateIndex: {
        getAccountState() {
          return {
            configured: true,
            api_key_mode: true,
            auth_mode: 'api-key',
            display_name: 'api.anthropic.com'
          };
        }
      },
      accountStateService: {
        syncAccountBaseState(provider, accountId, state) {
          syncedStates.push({ provider, accountId, state });
        }
      },
      getToolAccountIds() {
        return ['6'];
      },
      getProfileDir() {
        return profileDir;
      },
      getToolConfigDir() {
        return configDir;
      },
      loadServerRuntimeAccounts() {
        return {
          codex: [],
          gemini: [],
          claude: [{
            id: '6',
            accountId: '6',
            provider: 'claude',
            apiKeyMode: true,
            authType: 'auth-token',
            credentialType: 'auth-token',
            accessToken: 'new-auth-token',
            baseUrl: 'https://anyrouter.top'
          }]
        };
      },
      applyReloadState(state, runtimeAccounts) {
        state.accounts = runtimeAccounts;
      },
      checkStatus() {
        return { configured: true, accountName: 'Auth Token: new...oken' };
      },
      deps: {},
      state,
      writeJson(response, code, payload) {
        response.statusCode = code;
        response.end(JSON.stringify(payload));
      }
    });

    const envJson = JSON.parse(fs.readFileSync(path.join(profileDir, '.aih_env.json'), 'utf8'));
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(envJson.AIH_CLAUDE_CREDENTIAL_TYPE, 'auth-token');
    assert.equal(envJson.ANTHROPIC_AUTH_TOKEN, 'new-auth-token');
    assert.equal(envJson.ANTHROPIC_BASE_URL, 'https://anyrouter.top');
    assert.equal(Object.prototype.hasOwnProperty.call(envJson, 'ANTHROPIC_API_KEY'), false);
    assert.equal(syncedStates.length, 1);
    assert.equal(syncedStates[0].state.authMode, 'auth-token');
    assert.equal(syncedStates[0].state.apiKeyMode, true);
    assert.equal(state.webUiModelsCache.firstError, '');
    assert.equal(Object.prototype.hasOwnProperty.call(state.webUiModelsCache.byAccount, editedAccountRef), false);
    assert.deepEqual(state.webUiModelsCache.byAccount[otherAccountRef], ['sonnet[1m]']);
    assert.deepEqual(state.webUiModelsCache.byProvider, { claude: ['opus[1m]'] });
    const body = JSON.parse(res.body);
    assert.equal(body.account.authMode, 'auth-token');
    assert.equal(body.account.apiKeyMode, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('web ui account status endpoint updates status without forcing usage refresh', async () => {
  const res = createResCapture();
  const upserts = [];
  const runtimeReloads = [];
  const usageRefreshes = [];
  const modelCache = {
    updatedAt: Date.now(),
    byProvider: { codex: ['gpt-5.5'] },
    byAccount: { acct_cccccccccccccccccccc: ['gpt-5.5'] },
    errorsByAccount: {},
    accountUpdatedAt: { acct_cccccccccccccccccccc: Date.now() },
    accountSource: { acct_cccccccccccccccccccc: 'remote' },
    accountScanned: { acct_cccccccccccccccccccc: 1 },
    labels: {},
    signature: 'cached',
    source: 'remote',
    sourceCount: 1,
    scannedAccounts: 1,
    firstError: ''
  };
  const persistedState = {
    status: 'up',
    configured: true,
    api_key_mode: false,
    auth_mode: 'oauth-browser',
    remaining_pct: 88,
    display_name: 'codex-user',
    runtime_state: { lastFailureKind: 'auth_invalid' }
  };

  const handled = await handleUpdateAccountStatusRequest({
    pathname: '/v0/webui/accounts/codex/42/status',
    req: {},
    res,
    state: { webUiModelsCache: modelCache },
    fs: {
      existsSync(filePath) {
        return String(filePath) === '/tmp/codex/42';
      },
      readFileSync() {
        throw new Error('unexpected_read');
      }
    },
    readRequestBody: async () => Buffer.from(JSON.stringify({ status: 'down' })),
    accountStateIndex: {
      getAccountState() {
        return { ...persistedState };
      },
      setStatus(provider, accountId, status) {
        persistedState.status = status;
        upserts.push({ kind: 'status', provider, accountId, status });
        return true;
      },
      upsertAccountState(provider, accountId, state) {
        persistedState.status = state.status;
        upserts.push({ kind: 'base', provider, accountId, state });
        return true;
      },
      upsertRuntimeState(provider, accountId, runtimeState, state) {
        upserts.push({ kind: 'runtime', provider, accountId, runtimeState, state });
        return true;
      }
    },
    accountStateService: {
      setOperationalStatus(provider, accountId, status) {
        persistedState.status = status;
        upserts.push({ kind: 'status', provider, accountId, status });
        return true;
      }
    },
    getToolAccountIds() {
      return ['42'];
    },
    getProfileDir() {
      return '/tmp/codex/42';
    },
    getToolConfigDir() {
      return '/tmp/codex/42/.codex';
    },
    checkStatus() {
      return { configured: true, accountName: 'codex-user' };
    },
    loadServerRuntimeAccounts() {
      runtimeReloads.push('reload');
      return { codex: [], gemini: [], claude: [] };
    },
    applyReloadState() {},
    ensureUsageSnapshotAsync() {
      usageRefreshes.push('refresh');
      return Promise.resolve(null);
    },
    getLastUsageProbeError() {
      return '';
    },
    getLastUsageProbeState() {
      return null;
    },
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.account.status, 'down');
  assert.deepEqual(runtimeReloads, ['reload']);
  assert.deepEqual(usageRefreshes, []);
  assert.equal(modelCache.byAccount.acct_cccccccccccccccccccc[0], 'gpt-5.5');
  assert.deepEqual(upserts, [
    {
      kind: 'status',
      provider: 'codex',
      accountId: '42',
      status: 'down'
    }
  ]);
});

test('web ui oauth success preserves manually disabled status from profile status file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-oauth-status-'));
  const profileDir = path.join(root, 'profiles', 'codex', '42');
  const configDir = path.join(profileDir, '.codex');
  fs.ensureDirSync(configDir);
  fs.writeFileSync(path.join(profileDir, '.aih_status'), 'down\n', 'utf8');
  fs.writeJsonSync(path.join(configDir, 'auth.json'), {
    tokens: {
      access_token: 'oauth-token'
    }
  });

  const upserts = [];

  await handleOauthJobFinishedStateSync({
    fs,
    accountStateIndex: {
      getAccountState(provider, accountId) {
        if (provider !== 'codex' || accountId !== '42') return null;
        return {
          status: 'down',
          configured: false,
          api_key_mode: false,
          auth_mode: 'oauth-browser',
          display_name: 'codex-user'
        };
      },
      upsertAccountState(provider, accountId, state) {
        upserts.push({ kind: 'account', provider, accountId, state });
        return true;
      },
      upsertRuntimeState(provider, accountId, runtimeState, state) {
        upserts.push({ kind: 'runtime', provider, accountId, runtimeState, state });
        return true;
      }
    },
    accountStateService: {
      syncAccountBaseState(provider, accountId, state) {
        upserts.push({ kind: 'account', provider, accountId, state });
        return true;
      },
      clearRuntimeBlock(provider, accountId, options) {
        const { evidence: _evidence, ...state } = options;
        upserts.push({ kind: 'runtime', provider, accountId, runtimeState: null, state });
        return true;
      }
    },
    getToolAccountIds(provider) {
      return provider === 'codex' ? ['42'] : [];
    },
    getToolConfigDir(provider, accountId) {
      return path.join(root, 'profiles', provider, String(accountId), '.codex');
    },
    getProfileDir(provider, accountId) {
      return path.join(root, 'profiles', provider, String(accountId));
    },
    loadServerRuntimeAccounts() {
      return { codex: [], gemini: [], claude: [] };
    },
    applyReloadState() {},
    checkStatus() {
      return { configured: true, accountName: 'rehydrated@example.com' };
    }
  }, {}, {
    provider: 'codex',
    accountId: '42',
    authMode: 'oauth-browser',
    status: 'succeeded'
  });

  assert.equal(fs.readFileSync(path.join(profileDir, '.aih_status'), 'utf8').trim(), 'down');
  assert.deepEqual(upserts, [
    {
      kind: 'account',
      provider: 'codex',
      accountId: '42',
      state: {
        status: 'down',
        configured: true,
        apiKeyMode: false,
        authMode: 'oauth-browser',
        displayName: 'rehydrated@example.com'
      }
    },
    {
      kind: 'runtime',
      provider: 'codex',
      accountId: '42',
      runtimeState: null,
      state: {
        status: 'down',
        configured: true,
        apiKeyMode: false,
        authMode: 'oauth-browser',
        displayName: 'rehydrated@example.com'
      }
    }
  ]);
});
