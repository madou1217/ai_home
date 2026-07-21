const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');
const {
  cleanupAuthJobArtifacts,
  handleWebUIRequest,
  handleOauthJobFinishedStateSync
} = require('../lib/server/web-ui-router');
const {
  handleGetAddJobRequest,
  handleAddAccountRequest,
  handleCancelAddJobRequest,
  handleCompleteAddJobCallbackRequest,
  handleDeleteAccountRequest,
  handleReauthAccountRequest,
  handleUpdateAccountRequest,
  handleUpdateAccountStatusRequest
} = require('../lib/server/webui-account-routes');
const { OAUTH_PENDING_FALLBACK_STALE_MS } = require('../lib/server/oauth-pending-state');
const { SUPPORTED_SERVER_PROVIDERS } = require('../lib/server/providers');
const { buildAuthInvalidRuntimeState } = require('../lib/account/runtime-state-builders');
const {
  listAccountCredentialRecords,
  readAccountCredentials,
  writeAccountCredentials,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');
const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { writeAccountUsageSnapshot } = require('../lib/account/usage-snapshot-store');
const {
  readDefaultAccountRef,
  writeDefaultAccountRef
} = require('../lib/account/default-account-store');
const { resolveAccountRuntimeDir } = require('../lib/runtime/aih-storage-layout');
const { createSessionStoreService } = require('../lib/cli/services/session-store');

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
    syncAccountBaseState(accountRef, provider, state) {
      const entry = { accountRef, provider, state };
      upserts.push(baseKind ? { kind: baseKind, ...entry } : entry);
      return true;
    }
  };
}

function createAccountFixture(t, prefix = 'aih-webui-accounts-') {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const stateRows = new Map();
  const accounts = new Map();
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  function buildOauthNativeAuth(provider, cliAccountId) {
    if (provider === 'codex') {
      return {
        auth: {
          tokens: {
            access_token: `codex-access-${cliAccountId}`,
            refresh_token: `codex-refresh-${cliAccountId}`,
            account_id: `upstream-${cliAccountId}`
          }
        }
      };
    }
    if (provider === 'gemini') {
      return {
        oauthCreds: {
          access_token: `gemini-access-${cliAccountId}`,
          refresh_token: `gemini-refresh-${cliAccountId}`
        }
      };
    }
    if (provider === 'claude') {
      return {
        credentials: {
          claudeAiOauth: {
            accessToken: `claude-access-${cliAccountId}`,
            refreshToken: `claude-refresh-${cliAccountId}`
          }
        }
      };
    }
    if (provider === 'opencode') {
      return {
        auth: {
          openai: {
            type: 'oauth',
            access: `opencode-access-${cliAccountId}`,
            refresh: `opencode-refresh-${cliAccountId}`
          }
        }
      };
    }
    return {};
  }

  function buildApiKeyEnv(provider, cliAccountId) {
    if (provider === 'codex') {
      return {
        OPENAI_API_KEY: `codex-key-${cliAccountId}`,
        OPENAI_BASE_URL: 'https://api.openai.com/v1'
      };
    }
    if (provider === 'gemini') return { GEMINI_API_KEY: `gemini-key-${cliAccountId}` };
    if (provider === 'claude') return { ANTHROPIC_API_KEY: `claude-key-${cliAccountId}` };
    return {};
  }

  function register(provider, cliAccountId, options = {}) {
    const slot = `${provider}:${cliAccountId}`;
    if (accounts.has(slot)) return accounts.get(slot);
    const accountRef = upsertAccountRef(fs, aiHomeDir, {
      provider,
      cliAccountId: String(cliAccountId),
      identitySeed: options.identitySeed || `oauth:${provider}:fixture-${cliAccountId}@example.com`
    });
    assert.match(accountRef, /^acct_[a-f0-9]{20}$/);

    const hasExplicitEnv = Object.prototype.hasOwnProperty.call(options, 'env');
    const hasExplicitNativeAuth = Object.prototype.hasOwnProperty.call(options, 'nativeAuth');
    if (hasExplicitEnv) {
      writeAccountCredentials(fs, aiHomeDir, accountRef, options.env || {});
    }
    if (hasExplicitNativeAuth) {
      writeAccountNativeAuth(fs, aiHomeDir, accountRef, options.nativeAuth || {});
    }
    if (!hasExplicitEnv && !hasExplicitNativeAuth) {
      if (options.apiKeyMode) {
        writeAccountCredentials(fs, aiHomeDir, accountRef, buildApiKeyEnv(provider, cliAccountId));
      } else if (options.configured === false) {
        writeAccountNativeAuth(fs, aiHomeDir, accountRef, { pending: true });
      } else if (provider === 'agy') {
        writeAccountCredentials(fs, aiHomeDir, accountRef, {
          AGY_ACCESS_TOKEN: `agy-access-${cliAccountId}`
        });
      } else {
        writeAccountNativeAuth(fs, aiHomeDir, accountRef, buildOauthNativeAuth(provider, cliAccountId));
      }
    }
    if (options.usageSnapshot) {
      writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, options.usageSnapshot);
    }
    if (options.state) {
      stateRows.set(accountRef, {
        accountRef,
        provider,
        ...options.state
      });
    }
    accounts.set(slot, accountRef);
    return accountRef;
  }

  function setState(accountRef, provider, state) {
    stateRows.set(accountRef, { accountRef, provider, ...state });
  }

  const accountStateIndex = {
    getAccountState(accountRef) {
      return stateRows.get(accountRef) || null;
    },
    listStates(provider) {
      return [...stateRows.values()].filter((row) => row.provider === provider);
    }
  };

  function getProfileDir(provider, accountRef) {
    return resolveAccountRuntimeDir(aiHomeDir, provider, accountRef);
  }

  function getToolConfigDir(provider, accountRef) {
    const subdirs = {
      agy: ['.gemini', 'antigravity-cli'],
      claude: ['.claude'],
      codex: ['.codex'],
      gemini: ['.gemini'],
      opencode: ['.config', 'opencode']
    };
    return path.join(getProfileDir(provider, accountRef), ...(subdirs[provider] || []));
  }

  return {
    aiHomeDir,
    accountStateIndex,
    accounts,
    getProfileDir,
    getToolConfigDir,
    register,
    setState
  };
}

function createBaseDeps(fixture, overrides = {}) {
  return {
    fs,
    aiHomeDir: fixture.aiHomeDir,
    writeJson: (response, code, payload) => {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    },
    readRequestBody: async () => null,
    accountStateIndex: fixture.accountStateIndex,
    getToolConfigDir: fixture.getToolConfigDir,
    getProfileDir: fixture.getProfileDir,
    loadServerRuntimeAccounts: () => ({ agy: [], claude: [], codex: [], gemini: [], opencode: [] }),
    applyReloadState: () => {},
    checkStatus: () => ({ configured: true, accountName: '' }),
    ...overrides
  };
}

async function requestAccounts(fixture, options = {}) {
  const res = createResCapture();
  const state = options.state || {
    accounts: { agy: [], claude: [], codex: [], gemini: [], opencode: [] }
  };
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/accounts',
    url: new URL('http://localhost/v0/webui/accounts'),
    req: { headers: {} },
    res,
    options: options.serverOptions || {},
    state,
    deps: createBaseDeps(fixture, options.deps)
  });
  return { handled, res, body: JSON.parse(res.body), state };
}

async function requestDesktopMenu(fixture, options = {}) {
  const res = createResCapture();
  const state = options.state || {
    accounts: { agy: [], claude: [], codex: [], gemini: [], opencode: [] }
  };
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname: '/v0/webui/desktop-menu',
    url: new URL('http://localhost/v0/webui/desktop-menu'),
    req: { headers: {} },
    res,
    options: options.serverOptions || {},
    state,
    deps: createBaseDeps(fixture, options.deps)
  });
  return { handled, res, body: JSON.parse(res.body), state };
}

async function requestAccountSessions(fixture, provider, accountRef, options = {}) {
  const res = createResCapture();
  const pathname = `/v0/webui/sessions/${provider}/${accountRef}`;
  const handled = await handleWebUIRequest({
    method: 'GET',
    pathname,
    url: new URL(`http://localhost${pathname}`),
    req: { headers: {} },
    res,
    options: options.serverOptions || {},
    state: options.state || {
      accounts: { agy: [], claude: [], codex: [], gemini: [], opencode: [] }
    },
    deps: createBaseDeps(fixture, options.deps)
  });
  return { handled, res, body: JSON.parse(res.body) };
}

test('desktop menu route excludes Gemini and emits only providers backed by accounts', async (t) => {
  const fixture = createAccountFixture(t);
  const codexRef = fixture.register('codex', '9101', { apiKeyMode: true });
  fixture.register('gemini', '9102');
  fixture.register('claude', '9103', {
    state: { configured: true, apiKeyMode: false, remainingPct: 55, updatedAt: 100 }
  });
  writeDefaultAccountRef(fs, fixture.aiHomeDir, 'codex', codexRef);

  const { handled, res, body } = await requestDesktopMenu(fixture);

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.version, 1);
  assert.deepEqual(body.providers.map((provider) => provider.id), ['codex', 'claude']);
  assert.equal(body.providers.some((provider) => provider.id === 'gemini'), false);
  assert.equal(body.providers.some((provider) => provider.id === 'agy'), false);
  assert.equal(body.providers[0].accounts[0].accountRef, codexRef);
  assert.equal(body.providers[0].accounts[0].isDefault, true);
  assert.equal(body.providers[0].accounts[0].usageLabel, 'API Key');
});

test('account sessions route reads the canonical provider session catalog', async (t) => {
  const fixture = createAccountFixture(t);
  const accountRef = fixture.register('codex', '9201', { apiKeyMode: true });
  const expectedProjects = [{
    id: 'project-1',
    name: 'ai_home',
    path: '/tmp/ai_home',
    provider: 'codex',
    sessions: []
  }];
  const providerReads = [];

  const { handled, res, body } = await requestAccountSessions(
    fixture,
    'codex',
    accountRef,
    {
      deps: {
        readProjectsFromHostByProviders(providers) {
          providerReads.push(providers);
          return expectedProjects;
        }
      }
    }
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(providerReads, [['codex']]);
  assert.deepEqual(body, { ok: true, projects: expectedProjects });
});

test('web ui accounts list returns fast DB snapshot without synchronously depending on checkStatus', async (t) => {
  const fixture = createAccountFixture(t);
  const accountRef = fixture.register('codex', '1', {
    configured: false,
    state: { configured: true, apiKeyMode: false, remainingPct: 61, updatedAt: 100 }
  });
  let checkStatusCalls = 0;
  const { handled, res, body } = await requestAccounts(fixture, {
    state: {
      accounts: {
        codex: [{ accountRef, apiKeyMode: false }],
        agy: [], claude: [], gemini: [], opencode: []
      }
    },
    deps: {
      checkStatus() {
        checkStatusCalls += 1;
        throw new Error('check_status_should_not_block_fast_snapshot');
      }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.accounts.length, 1);
  assert.equal(body.accounts[0].configured, true);
  assert.equal(body.accounts[0].remainingPct, 61);
  assert.equal(body.providerNativeCapabilities.codex.provider, 'codex');
  assert.equal(body.providerNativeCapabilities.claude.sessions.nativeStore, 'projects/<project>/<session-id>.jsonl');
  assert.equal(body.providerNativeCapabilities.agy.config.userSettings.includes('.gemini/antigravity-cli/settings.json'), true);
  assert.equal(checkStatusCalls, 0);
});

test('web ui accounts list does not let stale state mark an unconfigured DB credential as configured', async (t) => {
  const fixture = createAccountFixture(t);
  const accountRef = fixture.register('codex', '10001', {
    configured: false,
    state: {
      configured: true,
      apiKeyMode: false,
      remainingPct: 0,
      displayName: 'stale@example.com',
      updatedAt: 123
    }
  });
  const { handled, res, body } = await requestAccounts(fixture, {
    deps: { checkStatus: () => ({ configured: false, accountName: 'Unknown' }) }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(body.accounts.length, 1);
  assert.equal(body.accounts[0].accountRef, accountRef);
  assert.equal(body.accounts[0].status, 'up');
  assert.equal(body.accounts[0].displayName, 'stale@example.com');
  assert.equal(body.accounts[0].configured, false);
  assert.equal(body.accounts[0].apiKeyMode, false);
  assert.equal(body.accounts[0].remainingPct, null);
  assert.equal(body.accounts[0].usageSnapshot, null);
  assert.equal(body.accounts[0].updatedAt, 123);
  assert.equal(body.accounts[0].planType, 'pending');
  assert.equal(body.accounts[0].quotaStatus, 'not_applicable');
  assert.equal(body.accounts[0].schedulableReason, 'account_unconfigured');
});

test('web ui accounts list marks stale oauth pending accounts as retryable', async (t) => {
  const fixture = createAccountFixture(t);
  fixture.register('codex', '7', {
    configured: false,
    state: {
      status: 'down',
      configured: false,
      apiKeyMode: false,
      authMode: 'oauth-browser',
      updatedAt: Date.now() - OAUTH_PENDING_FALLBACK_STALE_MS - 1000
    }
  });
  const { body } = await requestAccounts(fixture);

  assert.equal(body.accounts.length, 1);
  assert.equal(body.accounts[0].configured, false);
  assert.equal(body.accounts[0].authMode, 'oauth-browser');
  assert.equal(body.accounts[0].authPending, true);
  assert.equal(body.accounts[0].authPendingStale, true);
});

test('web ui accounts list uses DB account status as the status truth', async (t) => {
  const fixture = createAccountFixture(t);
  fixture.register('codex', '10002', {
    state: { status: 'down', configured: true, apiKeyMode: false }
  });
  const { body } = await requestAccounts(fixture);
  assert.equal(body.accounts.length, 1);
  assert.equal(body.accounts[0].status, 'down');
});

test('web ui accounts cold start rebuilds from current DB state instead of trusting persisted snapshot', async (t) => {
  const fixture = createAccountFixture(t, 'aih-webui-accounts-cache-');
  const accountRef = fixture.register('codex', '7', {
    configured: false,
    state: {
      status: 'up',
      configured: true,
      apiKeyMode: false,
      remainingPct: 48,
      displayName: 'persisted@example.com',
      updatedAt: 222
    }
  });
  const runtimeState = {
    accounts: {
      codex: [{ accountRef, apiKeyMode: false }],
      agy: [], claude: [], gemini: [], opencode: []
    }
  };
  const warm = await requestAccounts(fixture, { state: runtimeState });
  assert.equal(warm.res.statusCode, 200);

  fixture.setState(accountRef, 'codex', {
    status: 'down',
    configured: true,
    apiKeyMode: false,
    remainingPct: 11,
    displayName: 'persisted@example.com',
    updatedAt: 333
  });
  const cold = await requestAccounts(fixture, {
    state: {
      accounts: {
        codex: [{ accountRef, apiKeyMode: false }],
        agy: [], claude: [], gemini: [], opencode: []
      }
    }
  });
  assert.equal(cold.body.accounts.length, 1);
  assert.equal(cold.body.accounts[0].accountRef, accountRef);
  assert.equal(cold.body.accounts[0].status, 'down');
  assert.equal(cold.body.accounts[0].displayName, 'persisted@example.com');
  assert.equal(cold.body.accounts[0].remainingPct, 11);
});

test('web ui accounts list reuses fast snapshot within short ttl', async (t) => {
  const fixture = createAccountFixture(t);
  fixture.register('codex', '1');
  const state = { accounts: { agy: [], claude: [], codex: [], gemini: [], opencode: [] } };
  let canonicalListCalls = 0;
  const deps = {
    listAccountCredentialRecords(fsImpl, aiHomeDir, provider) {
      canonicalListCalls += 1;
      return listAccountCredentialRecords(fsImpl, aiHomeDir, provider);
    }
  };
  const first = await requestAccounts(fixture, { state, deps });
  const second = await requestAccounts(fixture, { state, deps });

  assert.equal(first.res.statusCode, 200);
  assert.equal(second.res.statusCode, 200);
  assert.equal(canonicalListCalls, SUPPORTED_SERVER_PROVIDERS.length);
});

test('web ui accounts list falls back to accountRef runtime remainingPct when DB state usage is missing', async (t) => {
  const fixture = createAccountFixture(t);
  const accountRef = fixture.register('codex', '42', {
    configured: false,
    state: {
      configured: true,
      apiKeyMode: false,
      remainingPct: null,
      displayName: 'runtime@example.com',
      updatedAt: 456
    }
  });
  const { body } = await requestAccounts(fixture, {
    state: {
      accounts: {
        codex: [{ accountRef, remainingPct: 73, apiKeyMode: false }],
        agy: [], claude: [], gemini: [], opencode: []
      }
    }
  });
  assert.equal(body.accounts[0].remainingPct, 73);
  assert.equal(body.accounts[0].configured, true);
  assert.equal(body.accounts[0].apiKeyMode, false);
});

test('web ui accounts list keeps api key accounts out of usage percentage rendering', async (t) => {
  const fixture = createAccountFixture(t);
  const accountRef = fixture.register('codex', '7', {
    apiKeyMode: true,
    state: { configured: true, apiKeyMode: true, remainingPct: 88, updatedAt: 789 }
  });
  const { body } = await requestAccounts(fixture, {
    state: {
      accounts: {
        codex: [{ accountRef, remainingPct: 88, apiKeyMode: true }],
        agy: [], claude: [], gemini: [], opencode: []
      }
    }
  });
  assert.equal(body.accounts[0].apiKeyMode, true);
  assert.equal(body.accounts[0].displayName, 'api.openai.com');
  assert.equal(body.accounts[0].remainingPct, null);
  assert.equal(body.accounts[0].runtimeStatus, undefined);
});

test('web ui accounts list prefers DB usage snapshot capturedAt for updatedAt', async (t) => {
  const fixture = createAccountFixture(t);
  const capturedAt = Date.now() - 15_000;
  fixture.register('codex', '52', {
    usageSnapshot: {
      schemaVersion: 2,
      kind: 'codex_oauth_status',
      source: 'codex_app_server',
      capturedAt,
      entries: [
        { window: '5h', remainingPct: 64 },
        { window: '7days', remainingPct: 83 }
      ]
    },
    state: { configured: true, apiKeyMode: false, remainingPct: 64, updatedAt: 123 }
  });
  const { body } = await requestAccounts(fixture);
  assert.equal(body.accounts[0].updatedAt, capturedAt);
});

test('web ui accounts list falls back to latest probe checkedAt for updatedAt when snapshot is missing', async (t) => {
  const fixture = createAccountFixture(t);
  const accountRef = fixture.register('codex', '77', {
    configured: false,
    state: { configured: true, apiKeyMode: false, remainingPct: null, updatedAt: 123 }
  });
  const probeCheckedAt = Date.now() - 8_000;
  const { body } = await requestAccounts(fixture, {
    state: {
      accounts: {
        codex: [{ accountRef, apiKeyMode: false }],
        agy: [], claude: [], gemini: [], opencode: []
      }
    },
    deps: {
      getLastUsageProbeState(provider, candidateRef) {
        return provider === 'codex' && candidateRef === accountRef
          ? { error: 'timeout', checkedAt: probeCheckedAt }
          : null;
      }
    }
  });
  assert.equal(body.accounts[0].updatedAt, probeCheckedAt);
  assert.equal(body.accounts[0].quotaStatus, 'probe_failed');
});

test('web ui accounts list exposes lastUsedAt from accountRef runtime success timestamp', async (t) => {
  const fixture = createAccountFixture(t);
  const accountRef = fixture.register('codex', '81', { configured: false });
  const lastSuccessAt = Date.now() - 12_000;
  const { body } = await requestAccounts(fixture, {
    state: {
      accounts: {
        codex: [{ accountRef, email: 'used@example.com', apiKeyMode: false, lastSuccessAt }],
        agy: [], claude: [], gemini: [], opencode: []
      }
    }
  });
  assert.equal(body.accounts[0].lastUsedAt, lastSuccessAt);
});

test('web ui accounts list exposes lastUsedAt for every server provider runtime account', async (t) => {
  const fixture = createAccountFixture(t);
  const baseTime = Date.now() - 60_000;
  const providers = ['codex', 'gemini', 'claude', 'agy'];
  const providerAccounts = { agy: [], claude: [], codex: [], gemini: [], opencode: [] };
  providers.forEach((provider, index) => {
    const accountRef = fixture.register(provider, String(index + 1), { configured: false });
    providerAccounts[provider].push({
      accountRef,
      email: `${provider}@example.com`,
      apiKeyMode: false,
      lastSuccessAt: baseTime + index
    });
  });
  const { body } = await requestAccounts(fixture, { state: { accounts: providerAccounts } });
  assert.equal(body.accounts.length, providers.length);
  const byProvider = new Map(body.accounts.map((account) => [account.provider, account]));
  providers.forEach((provider, index) => {
    assert.equal(byProvider.get(provider).lastUsedAt, baseTime + index);
  });
});

test('web ui accounts list marks free accounts below 20 percent as policy blocked', async (t) => {
  const fixture = createAccountFixture(t);
  fixture.register('codex', '91', {
    usageSnapshot: {
      schemaVersion: 2,
      kind: 'codex_oauth_status',
      source: 'codex_app_server',
      capturedAt: Date.now() - 5_000,
      account: { planType: 'free', email: 'free-low@example.com' },
      entries: [
        { window: '5h', remainingPct: 19 },
        { window: '7days', remainingPct: 76 }
      ]
    },
    state: { configured: true, apiKeyMode: false, remainingPct: 19, updatedAt: 123 }
  });
  const { body } = await requestAccounts(fixture);
  assert.equal(body.accounts[0].schedulableStatus, 'blocked_by_policy');
  assert.equal(body.accounts[0].schedulableReason, 'codex_free_plan_below_server_min_remaining');
});

test('web ui accounts list exposes probe_failed quota status when latest usage probe failed', async (t) => {
  const fixture = createAccountFixture(t);
  const accountRef = fixture.register('codex', '77', {
    state: { configured: true, apiKeyMode: false, remainingPct: null, updatedAt: 0 }
  });
  const { body } = await requestAccounts(fixture, {
    deps: {
      getLastUsageProbeError(provider, candidateRef) {
        return provider === 'codex' && candidateRef === accountRef
          ? 'direct_http_status_401'
          : '';
      }
    }
  });
  assert.equal(body.accounts[0].quotaStatus, 'probe_failed');
  assert.equal(body.accounts[0].quotaReason, 'direct_http_status_401');
});

test('web ui refresh usage accepts accountRef job and streams refreshed account record', async (t) => {
  const fixture = createAccountFixture(t);
  const accountRef = fixture.register('codex', '9', {
    configured: false,
    state: { configured: true, apiKeyMode: false, updatedAt: 111 }
  });
  let probeState = null;
  const liveFrames = [];
  const wsClient = {
    readyState: 1,
    send(frame) {
      liveFrames.push(JSON.parse(String(frame)));
    }
  };
  const state = {
    accounts: {
      codex: [{ accountRef, email: 'refresh@example.com', apiKeyMode: false }],
      agy: [], claude: [], gemini: [], opencode: []
    },
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
  const res = createResCapture();
  const pathname = `/v0/webui/accounts/codex/${accountRef}/refresh-usage`;
  const handled = await handleWebUIRequest({
    method: 'POST',
    pathname,
    url: new URL(`http://localhost${pathname}`),
    req: { headers: {} },
    res,
    options: {},
    state,
    deps: createBaseDeps(fixture, {
      ensureUsageSnapshotAsync: async () => {
        probeState = { error: 'timeout', checkedAt: Date.now() };
        return null;
      },
      getLastUsageProbeState: () => probeState,
      loadServerRuntimeAccounts: () => state.accounts,
      applyReloadState(nextState, runtimeAccounts) {
        nextState.accounts = runtimeAccounts;
      },
      checkStatus: () => ({ configured: true, accountName: 'refresh@example.com' })
    })
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 202);
  const body = JSON.parse(res.body);
  assert.equal(body.job.accountRef, accountRef);
  assert.equal(body.job.status, 'queued');
  assert.equal(probeState, null);
  assert.equal(
    await waitFor(
      () => liveFrames.some((frame) => frame.type === 'account-refresh-job' && frame.job.status === 'succeeded'),
      1000
    ),
    true
  );
  const accountFrame = liveFrames.find((frame) => frame.type === 'account');
  assert.equal(accountFrame.account.accountRef, accountRef);
  assert.equal(accountFrame.account.updatedAt, probeState.checkedAt);
  assert.equal(accountFrame.account.quotaStatus, 'probe_failed');
});

test('web ui refresh usage rejects DB api key accounts and reconciles by accountRef', async (t) => {
  const fixture = createAccountFixture(t);
  const accountRef = fixture.register('codex', '12', {
    apiKeyMode: true,
    state: {
      configured: true,
      apiKeyMode: true,
      runtimeState: buildAuthInvalidRuntimeState('auth_invalid_reauth_required')
    }
  });
  const reconcileCalls = [];
  const res = createResCapture();
  const pathname = `/v0/webui/accounts/codex/${accountRef}/refresh-usage`;
  await handleWebUIRequest({
    method: 'POST',
    pathname,
    url: new URL(`http://localhost${pathname}`),
    req: { headers: {} },
    res,
    options: {},
    state: { accounts: { agy: [], claude: [], codex: [], gemini: [], opencode: [] } },
    deps: createBaseDeps(fixture, {
      codexAuthInvalidReconciler: {
        enqueueAuthInvalidReauthRequired(provider, candidateRef, reason) {
          reconcileCalls.push({ provider, accountRef: candidateRef, reason });
          return true;
        }
      }
    })
  });

  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 400);
  assert.equal(body.code, 'api_key_usage_refresh_unsupported');
  assert.deepEqual(reconcileCalls, [{
    provider: 'codex',
    accountRef,
    reason: 'auth_invalid_reauth_required'
  }]);
});

test('web ui refresh usage reads auth-invalid state from accountRef runtime account', async (t) => {
  const fixture = createAccountFixture(t);
  const accountRef = fixture.register('codex', '13', { apiKeyMode: true });
  const reconcileCalls = [];
  const res = createResCapture();
  const pathname = `/v0/webui/accounts/codex/${accountRef}/refresh-usage`;
  await handleWebUIRequest({
    method: 'POST',
    pathname,
    url: new URL(`http://localhost${pathname}`),
    req: { headers: {} },
    res,
    options: {},
    state: {
      accounts: {
        codex: [{
          accountRef,
          provider: 'codex',
          apiKeyMode: true,
          authInvalidUntil: Date.now() + 3600000,
          lastFailureReason: 'auth_invalid_reauth_required'
        }],
        agy: [], claude: [], gemini: [], opencode: []
      }
    },
    deps: createBaseDeps(fixture, {
      codexAuthInvalidReconciler: {
        enqueueAuthInvalidReauthRequired(provider, candidateRef, reason) {
          reconcileCalls.push({ provider, accountRef: candidateRef, reason });
          return true;
        }
      }
    })
  });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(reconcileCalls, [{
    provider: 'codex',
    accountRef,
    reason: 'auth_invalid_reauth_required'
  }]);
});

test('web ui set-default writes accountRef pointer and syncs host config', async (t) => {
  const fixture = createAccountFixture(t, 'aih-webui-set-default-');
  const accountRef = fixture.register('codex', '42', {
    state: { configured: true, apiKeyMode: false, displayName: 'default@example.com' }
  });
  const sessionLinks = [];
  const syncCalls = [];
  const desktopCalls = [];
  const res = createResCapture();
  const pathname = `/v0/webui/accounts/codex/${accountRef}/set-default`;
  await handleWebUIRequest({
    method: 'POST',
    pathname,
    url: new URL(`http://localhost${pathname}`),
    req: { headers: {} },
    res,
    options: {},
    state: { accounts: { codex: [{ accountRef }], agy: [], claude: [], gemini: [], opencode: [] } },
    deps: createBaseDeps(fixture, {
      ensureSessionStoreLinks(provider, candidateRef) {
        sessionLinks.push({ provider, accountRef: candidateRef });
      },
      syncGlobalConfigToHost(provider, candidateRef) {
        syncCalls.push({ provider, accountRef: candidateRef });
        return { ok: true };
      },
      codexDesktopHookService: {
        setDesktopAccountRef(candidateRef) {
          desktopCalls.push({ action: 'set', accountRef: candidateRef });
          return { ok: true, changed: true, desktopAccountRef: candidateRef };
        }
      }
    })
  });

  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.account.isDefault, true);
  assert.equal(readDefaultAccountRef(fs, fixture.aiHomeDir, 'codex'), accountRef);
  assert.deepEqual(sessionLinks, [{ provider: 'codex', accountRef }]);
  assert.deepEqual(syncCalls, [{ provider: 'codex', accountRef }]);
  assert.deepEqual(desktopCalls, [{ action: 'set', accountRef }]);
  assert.deepEqual(body.desktopAccount, {
    eligible: true,
    synced: true,
    changed: true,
    hotSyncQueued: true
  });
});

test('web ui set-default leaves Codex App identity unchanged for api-key accounts', async (t) => {
  const fixture = createAccountFixture(t, 'aih-webui-set-default-apikey-');
  const accountRef = fixture.register('codex', '43', {
    apiKeyMode: true,
    state: { configured: true, apiKeyMode: true, displayName: 'api.openai.com' }
  });
  const res = createResCapture();
  const pathname = `/v0/webui/accounts/codex/${accountRef}/set-default`;
  await handleWebUIRequest({
    method: 'POST',
    pathname,
    url: new URL(`http://localhost${pathname}`),
    req: { headers: {} },
    res,
    options: {},
    state: { accounts: { codex: [{ accountRef }], agy: [], claude: [], gemini: [], opencode: [] } },
    deps: createBaseDeps(fixture, {
      syncGlobalConfigToHost: () => ({ ok: true }),
      codexDesktopHookService: {
        setDesktopAccountRef() {
          throw new Error('api-key account must not replace ChatGPT OAuth identity');
        }
      }
    })
  });

  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(readDefaultAccountRef(fs, fixture.aiHomeDir, 'codex'), accountRef);
  assert.deepEqual(body.desktopAccount, {
    eligible: false,
    synced: false,
    changed: false,
    hotSyncQueued: false,
    reason: 'missing_codex_desktop_oauth'
  });
});

test('web ui clear-default clears only the matching accountRef pointer', async (t) => {
  const fixture = createAccountFixture(t, 'aih-webui-clear-default-');
  const accountRef = fixture.register('codex', '42');
  writeDefaultAccountRef(fs, fixture.aiHomeDir, 'codex', accountRef);
  const res = createResCapture();
  const pathname = `/v0/webui/accounts/codex/${accountRef}/clear-default`;
  await handleWebUIRequest({
    method: 'POST',
    pathname,
    url: new URL(`http://localhost${pathname}`),
    req: { headers: {} },
    res,
    options: {},
    state: { accounts: { codex: [{ accountRef }], agy: [], claude: [], gemini: [], opencode: [] } },
    deps: createBaseDeps(fixture)
  });
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.account.isDefault, false);
  assert.equal(readDefaultAccountRef(fs, fixture.aiHomeDir, 'codex'), '');
});

test('web ui set-default rejects pending oauth accountRef', async (t) => {
  const fixture = createAccountFixture(t, 'aih-webui-set-default-pending-');
  const accountRef = fixture.register('codex', '9', {
    configured: false,
    state: {
      status: 'down',
      configured: false,
      apiKeyMode: false,
      authMode: 'oauth-browser',
      updatedAt: Date.now()
    }
  });
  const syncCalls = [];
  const res = createResCapture();
  const pathname = `/v0/webui/accounts/codex/${accountRef}/set-default`;
  await handleWebUIRequest({
    method: 'POST', pathname, url: new URL(`http://localhost${pathname}`), req: { headers: {} },
    res, options: {}, state: {},
    deps: createBaseDeps(fixture, {
      syncGlobalConfigToHost() {
        syncCalls.push(true);
        return { ok: true };
      }
    })
  });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).code, 'account_auth_pending');
  assert.deepEqual(syncCalls, []);
});

test('web ui set-default rejects unconfigured api key accountRef', async (t) => {
  const fixture = createAccountFixture(t, 'aih-webui-set-default-unconfigured-');
  const accountRef = fixture.register('codex', '8', {
    nativeAuth: { pending: true },
    state: { status: 'down', configured: false, apiKeyMode: true, authMode: 'api-key' }
  });
  const res = createResCapture();
  const pathname = `/v0/webui/accounts/codex/${accountRef}/set-default`;
  await handleWebUIRequest({
    method: 'POST', pathname, url: new URL(`http://localhost${pathname}`), req: { headers: {} },
    res, options: {}, state: {},
    deps: createBaseDeps(fixture, {
      checkStatus: () => ({ configured: false, accountName: '' }),
      syncGlobalConfigToHost: () => ({ ok: true })
    })
  });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).code, 'account_unconfigured');
});

test('web ui set-default rejects a disabled account even when credentials remain configured', async (t) => {
  const fixture = createAccountFixture(t, 'aih-webui-set-default-disabled-');
  const accountRef = fixture.register('codex', '81', {
    state: { status: 'down', configured: true, apiKeyMode: false }
  });
  const syncCalls = [];
  const pathname = `/v0/webui/accounts/codex/${accountRef}/set-default`;
  const res = createResCapture();

  await handleWebUIRequest({
    method: 'POST', pathname, url: new URL(`http://localhost${pathname}`), req: { headers: {} },
    res, options: {}, state: { accounts: { codex: [{ accountRef }], agy: [], claude: [], gemini: [], opencode: [] } },
    deps: createBaseDeps(fixture, {
      syncGlobalConfigToHost() {
        syncCalls.push(true);
        return { ok: true };
      }
    })
  });

  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).code, 'account_disabled');
  assert.deepEqual(syncCalls, []);
});

test('web ui set-default rejects a runtime-blocked account from a stale menu action', async (t) => {
  const fixture = createAccountFixture(t, 'aih-webui-set-default-runtime-blocked-');
  const accountRef = fixture.register('claude', '91', {
    state: { configured: true, apiKeyMode: false }
  });
  const syncCalls = [];
  const pathname = `/v0/webui/accounts/claude/${accountRef}/set-default`;
  const res = createResCapture();

  await handleWebUIRequest({
    method: 'POST', pathname, url: new URL(`http://localhost${pathname}`), req: { headers: {} },
    res, options: {},
    state: {
      accounts: {
        codex: [], agy: [], gemini: [], opencode: [],
        claude: [{
          accountRef,
          runtimeStatus: 'auth_invalid',
          schedulableStatus: 'blocked_by_runtime_status'
        }]
      }
    },
    deps: createBaseDeps(fixture, {
      syncGlobalConfigToHost() {
        syncCalls.push(true);
        return { ok: true };
      }
    })
  });

  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).code, 'account_runtime_unavailable');
  assert.deepEqual(syncCalls, []);
});

test('web ui set-mobile writes desktop accountRef without changing default pointer', async (t) => {
  const fixture = createAccountFixture(t, 'aih-webui-set-mobile-');
  const accountRef = fixture.register('codex', '10009');
  const stateFile = path.join(fixture.aiHomeDir, 'run', 'codex', 'desktop-hook-state.json');
  fs.ensureDirSync(path.dirname(stateFile));
  fs.writeJsonSync(stateFile, {
    enabled: true,
    traceFile: '/tmp/trace.jsonl',
    traceResponses: true
  });
  const res = createResCapture();
  const pathname = `/v0/webui/accounts/codex/${accountRef}/set-mobile`;
  await handleWebUIRequest({
    method: 'POST', pathname, url: new URL(`http://localhost${pathname}`), req: { headers: {} },
    res, options: {}, state: { accounts: { codex: [{ accountRef }], agy: [], claude: [], gemini: [], opencode: [] } },
    deps: createBaseDeps(fixture)
  });
  const hookState = fs.readJsonSync(stateFile);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).account.isMobile, true);
  assert.equal(hookState.desktopAccountRef, accountRef);
  assert.equal(hookState.traceFile, '/tmp/trace.jsonl');
  assert.equal(readDefaultAccountRef(fs, fixture.aiHomeDir, 'codex'), '');
});

test('web ui clear-mobile clears only the matching desktop accountRef', async (t) => {
  const fixture = createAccountFixture(t, 'aih-webui-clear-mobile-');
  const accountRef = fixture.register('codex', '10009');
  const defaultRef = fixture.register('codex', '12');
  writeDefaultAccountRef(fs, fixture.aiHomeDir, 'codex', defaultRef);
  const stateFile = path.join(fixture.aiHomeDir, 'run', 'codex', 'desktop-hook-state.json');
  fs.ensureDirSync(path.dirname(stateFile));
  fs.writeJsonSync(stateFile, {
    enabled: true,
    desktopAccountRef: accountRef,
    traceFile: '/tmp/trace.jsonl',
    traceResponses: true
  });
  const res = createResCapture();
  const pathname = `/v0/webui/accounts/codex/${accountRef}/clear-mobile`;
  await handleWebUIRequest({
    method: 'POST', pathname, url: new URL(`http://localhost${pathname}`), req: { headers: {} },
    res, options: {}, state: { accounts: { codex: [{ accountRef }], agy: [], claude: [], gemini: [], opencode: [] } },
    deps: createBaseDeps(fixture)
  });
  const hookState = fs.readJsonSync(stateFile);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).account.isMobile, false);
  assert.equal(Object.hasOwn(hookState, 'desktopAccountRef'), false);
  assert.equal(readDefaultAccountRef(fs, fixture.aiHomeDir, 'codex'), defaultRef);
});

test('web ui set-mobile rejects DB api key accountRef', async (t) => {
  const fixture = createAccountFixture(t, 'aih-webui-set-mobile-apikey-');
  const accountRef = fixture.register('codex', '10', { apiKeyMode: true });
  const res = createResCapture();
  const pathname = `/v0/webui/accounts/codex/${accountRef}/set-mobile`;
  await handleWebUIRequest({
    method: 'POST', pathname, url: new URL(`http://localhost${pathname}`), req: { headers: {} },
    res, options: {}, state: {}, deps: createBaseDeps(fixture)
  });
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 400);
  assert.equal(body.code, 'missing_codex_desktop_oauth');
});

test('web ui accounts list refreshes DB role markers when accountRef pointers change', async (t) => {
  const fixture = createAccountFixture(t, 'aih-webui-role-markers-');
  const firstRef = fixture.register('codex', '1');
  const secondRef = fixture.register('codex', '2');
  const stateFile = path.join(fixture.aiHomeDir, 'run', 'codex', 'desktop-hook-state.json');
  fs.ensureDirSync(path.dirname(stateFile));
  writeDefaultAccountRef(fs, fixture.aiHomeDir, 'codex', firstRef);
  fs.writeJsonSync(stateFile, { enabled: true, desktopAccountRef: firstRef });
  const state = { accounts: { agy: [], claude: [], codex: [], gemini: [], opencode: [] } };

  const first = (await requestAccounts(fixture, { state })).body.accounts;
  assert.equal(first.find((account) => account.accountRef === firstRef).isDefault, true);
  assert.equal(first.find((account) => account.accountRef === firstRef).isMobile, true);

  writeDefaultAccountRef(fs, fixture.aiHomeDir, 'codex', secondRef);
  fs.writeJsonSync(stateFile, { enabled: true, desktopAccountRef: secondRef });
  const second = (await requestAccounts(fixture, { state })).body.accounts;
  assert.equal(second.find((account) => account.accountRef === firstRef).isDefault, false);
  assert.equal(second.find((account) => account.accountRef === secondRef).isDefault, true);
  assert.equal(second.find((account) => account.accountRef === secondRef).isMobile, true);
});

test('web ui accounts list reads Codex usage snapshot from DB', async (t) => {
  const fixture = createAccountFixture(t);
  fixture.register('codex', '8', {
    usageSnapshot: {
      schemaVersion: 2,
      kind: 'codex_oauth_status',
      source: 'codex_app_server',
      capturedAt: Date.now(),
      entries: [
        { window: '5h', remainingPct: 59 },
        { window: '7days', remainingPct: 81 }
      ]
    }
  });
  const { body } = await requestAccounts(fixture);
  assert.equal(body.accounts[0].remainingPct, 59);
  assert.equal(body.accounts[0].usageSnapshot.kind, 'codex_oauth_status');
  assert.equal(body.accounts[0].usageSnapshot.entries.length, 2);
});

test('web ui accounts list does not keep stale depleted state when DB snapshot has no numeric remaining', async (t) => {
  const fixture = createAccountFixture(t);
  fixture.register('codex', '81', {
    usageSnapshot: {
      schemaVersion: 2,
      kind: 'codex_oauth_status',
      source: 'codex_app_server',
      capturedAt: Date.now(),
      entries: [
        { bucket: 'account', window: 'plan:plus user@example.com', remainingPct: null, resetIn: 'unknown' }
      ]
    },
    state: { configured: true, apiKeyMode: false, remainingPct: 0 }
  });
  const { body } = await requestAccounts(fixture);
  assert.equal(body.accounts[0].remainingPct, null);
  assert.equal(body.accounts[0].quotaStatus, 'pending');
  assert.equal(body.accounts[0].quotaReason, 'provider_returned_no_numeric_usage');
});

test('web ui accounts list reads Gemini usage snapshot models from DB', async (t) => {
  const fixture = createAccountFixture(t);
  fixture.register('gemini', '11', {
    usageSnapshot: {
      schemaVersion: 2,
      kind: 'gemini_oauth_stats',
      source: 'gemini_refresh_user_quota',
      capturedAt: Date.now(),
      models: [
        { model: 'gemini-2.5-pro', remainingPct: 42, resetIn: '2h', resetAtMs: Date.now() + 7200000 },
        { model: 'gemini-2.5-flash', remainingPct: 76, resetIn: '5h', resetAtMs: Date.now() + 18000000 }
      ]
    }
  });
  const { body } = await requestAccounts(fixture);
  assert.equal(body.accounts[0].provider, 'gemini');
  assert.equal(body.accounts[0].remainingPct, 42);
  assert.equal(body.accounts[0].usageSnapshot.models[0].model, 'gemini-2.5-pro');
});

test('web ui accounts list reads AGY Code Assist quota snapshot from DB', async (t) => {
  const fixture = createAccountFixture(t);
  const accountRef = fixture.register('agy', '9', {
    nativeAuth: {
      email: 'agy@example.com',
      oauthToken: {
        auth_method: 'consumer',
        token: { access_token: 'agy-token', refresh_token: 'agy-refresh' }
      }
    },
    usageSnapshot: {
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
    }
  });
  const { body } = await requestAccounts(fixture);
  const agy = body.accounts.find((account) => account.accountRef === accountRef);
  assert.equal(agy.remainingPct, 17);
  assert.equal(agy.quotaStatus, 'available');
  assert.equal(agy.email, 'agy@example.com');
  assert.equal(agy.usageSnapshot.account.subscriptionTier, 'Google AI Pro');
  assert.equal(agy.usageSnapshot.models[0].model, 'claude-sonnet-4-6');
});

test('web ui accounts list classifies Codex team DB fallback without numeric rate limits', async (t) => {
  const fixture = createAccountFixture(t);
  fixture.register('codex', '5', {
    usageSnapshot: {
      schemaVersion: 2,
      kind: 'codex_oauth_status',
      source: 'codex_app_server',
      capturedAt: 1776703050450,
      fallbackSource: 'account_read',
      account: { planType: 'team', email: 'code5@meadeo.com' },
      entries: [{
        bucket: 'account',
        windowMinutes: 0,
        window: 'plan:team code5@meadeo.com',
        remainingPct: null,
        resetIn: 'unknown',
        resetAtMs: 0
      }]
    }
  });
  const { body } = await requestAccounts(fixture);
  assert.equal(body.accounts[0].quotaStatus, 'pending');
  assert.equal(body.accounts[0].quotaReason, 'codex_team_plan_pending_rate_limits');
  assert.equal(body.accounts[0].usageSnapshot.fallbackSource, 'account_read');
});

test('web ui accounts list treats DB auth-only Codex metadata as pending', async (t) => {
  const fixture = createAccountFixture(t);
  const accessToken = 'header.' + Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': {
      chatgpt_plan_type: 'team',
      chatgpt_account_id: 'upstream_9'
    },
    'https://api.openai.com/profile': { email: 'auth-only@example.com' }
  })).toString('base64url') + '.sig';
  fixture.register('codex', '9', {
    nativeAuth: {
      auth: {
        organization_id: 'org_9',
        tokens: { access_token: accessToken }
      }
    },
    state: { configured: true, apiKeyMode: false, displayName: 'auth-only@example.com' }
  });
  const { body } = await requestAccounts(fixture);
  assert.equal(body.accounts[0].quotaStatus, 'pending');
  assert.equal(body.accounts[0].quotaReason, 'auth_metadata_only');
  assert.equal(body.accounts[0].usageSnapshot.fallbackSource, 'auth_json');
  assert.equal(body.accounts[0].usageSnapshot.account.planType, 'team');
  assert.equal(body.accounts[0].usageSnapshot.account.email, 'auth-only@example.com');
});

test('web ui accounts list does not render DB AGY access-token-only account as exhausted', async (t) => {
  const fixture = createAccountFixture(t);
  const accountRef = fixture.register('agy', '1', {
    env: { AGY_ACCESS_TOKEN: 'dummy-access-token' },
    nativeAuth: { email: 'agy@example.com' },
    state: { configured: true, apiKeyMode: false, remainingPct: 0 }
  });
  const { body } = await requestAccounts(fixture);
  const agy = body.accounts.find((account) => account.accountRef === accountRef);
  assert.equal(agy.remainingPct, null);
  assert.equal(agy.quotaStatus, 'pending');
  assert.equal(agy.schedulableStatus, 'blocked_by_policy');
  assert.equal(agy.schedulableReason, 'agy_access_token_required');
});

test('web ui accounts watch streams DB snapshot and completes hydration lifecycle', async (t) => {
  const fixture = createAccountFixture(t);
  fixture.register('codex', '9', {
    state: {
      configured: true,
      apiKeyMode: false,
      remainingPct: 54,
      displayName: 'stale@example.com',
      updatedAt: 555
    }
  });
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
    state: { accounts: { agy: [], claude: [], codex: [], gemini: [], opencode: [] } },
    deps: createBaseDeps(fixture, {
      checkStatus: () => ({ configured: true, accountName: 'hydrated@example.com' })
    })
  });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /stale@example.com/);
  await new Promise((resolve) => setTimeout(resolve, 60));
  req.emit('close');
  assert.match(res.body, /"type":"hydrated"/);
  assert.match(res.body, /hydrated@example.com/);
});

test('web ui accounts snapshot request accepts immediately and refreshes DB watch in background', async (t) => {
  const fixture = createAccountFixture(t);
  const accountRef = fixture.register('codex', '42', {
    configured: false,
    state: {
      configured: true,
      apiKeyMode: false,
      remainingPct: 41,
      displayName: 'snapshot-stale@example.com',
      updatedAt: 444
    }
  });
  const state = { accounts: { agy: [], claude: [], codex: [], gemini: [], opencode: [] } };
  let runtimeReloadCalls = 0;
  const req = new EventEmitter();
  req.headers = {};
  const streamRes = createStreamResCapture();
  const deps = createBaseDeps(fixture, {
    loadServerRuntimeAccounts() {
      runtimeReloadCalls += 1;
      return {
        agy: [], claude: [], gemini: [], opencode: [],
        codex: [{ accountRef, email: 'runtime-after-snapshot@example.com' }]
      };
    },
    applyReloadState(targetState, runtimeAccounts) {
      targetState.accounts = runtimeAccounts;
    },
    checkStatus: () => ({ configured: true, accountName: 'hydrated-after-snapshot@example.com' })
  });
  await handleWebUIRequest({
    method: 'GET', pathname: '/v0/webui/accounts/watch',
    url: new URL('http://localhost/v0/webui/accounts/watch'), req, res: streamRes,
    options: {}, state, deps
  });
  assert.equal(runtimeReloadCalls, 0);

  const snapshotRes = createResCapture();
  await handleWebUIRequest({
    method: 'POST', pathname: '/v0/webui/accounts/watch/snapshot',
    url: new URL('http://localhost/v0/webui/accounts/watch/snapshot'), req: { headers: {} },
    res: snapshotRes, options: {}, state, deps
  });
  assert.equal(snapshotRes.statusCode, 202);
  assert.equal(runtimeReloadCalls, 0);
  const refreshed = await waitFor(() => (
    runtimeReloadCalls > 0
    && streamRes.body.includes('"type":"snapshot-requested"')
    && streamRes.body.includes('"type":"hydrated"')
    && streamRes.body.includes('hydrated-after-snapshot@example.com')
  ), 500);
  req.emit('close');
  assert.equal(refreshed, true);
});

test('web ui add codex oauth defaults to browser auth without allocating a local id', async (t) => {
  const fixture = createAccountFixture(t, 'aih-webui-add-browser-');
  const res = createResCapture();
  const startedCalls = [];

  const handled = await handleAddAccountRequest({
    req: { headers: { host: 'localhost:8317' } },
    res,
    fs,
    aiHomeDir: fixture.aiHomeDir,
    deps: { aiHomeDir: fixture.aiHomeDir },
    state: {},
    readRequestBody: async () => Buffer.from(JSON.stringify({ provider: 'codex' })),
    accountStateIndex: fixture.accountStateIndex,
    getProfileDir: fixture.getProfileDir,
    getToolConfigDir: fixture.getToolConfigDir,
    getAuthJobManager() {
      return {
        startOauthJob(provider, authMode) {
          startedCalls.push({ provider, authMode });
          return {
            jobId: 'job-2',
            provider,
            accountRef: '',
            expiresAt: null,
            pollIntervalMs: 5000
          };
        }
      };
    },
    cleanupAuthJobArtifacts() {},
    loadServerRuntimeAccounts: () => ({ agy: [], claude: [], codex: [], gemini: [], opencode: [] }),
    applyReloadState() {},
    checkStatus: () => ({ configured: false }),
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
  assert.equal(body.accountRef, '');
  assert.deepEqual(startedCalls, [{ provider: 'codex', authMode: 'oauth-browser' }]);
});

test('web ui add api key account persists base url domain as display name', async (t) => {
  const fixture = createAccountFixture(t, 'aih-webui-add-api-key-');
  const res = createResCapture();
  const upserts = [];

  const handled = await handleAddAccountRequest({
    req: { headers: { host: 'accounts.example.com' } },
    res,
    fs,
    aiHomeDir: fixture.aiHomeDir,
    deps: { aiHomeDir: fixture.aiHomeDir },
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
    accountStateIndex: fixture.accountStateIndex,
    accountStateService: createAccountStateServiceRecorder(upserts),
    getProfileDir: fixture.getProfileDir,
    getToolConfigDir: fixture.getToolConfigDir,
    getAuthJobManager() {
      throw new Error('should_not_start_oauth');
    },
    cleanupAuthJobArtifacts() {},
    loadServerRuntimeAccounts: () => ({ agy: [], claude: [], codex: [], gemini: [], opencode: [] }),
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
  assert.match(body.accountRef, /^acct_[a-f0-9]{20}$/);
  assert.equal(readAccountCredentials(fs, fixture.aiHomeDir, body.accountRef).OPENAI_API_KEY, 'sk-test');
  assert.equal(upserts[0].accountRef, body.accountRef);
  assert.equal(upserts[0].state.apiKeyMode, true);
  assert.equal(upserts[0].state.displayName, 'proxy.example.com');
});

test('web ui rejects api key accounts that point back to the current AIH server', async (t) => {
  const fixture = createAccountFixture(t, 'aih-webui-add-self-relay-');
  const res = createResCapture();
  const upserts = [];

  const handled = await handleAddAccountRequest({
    req: { headers: { host: 'accounts.example.com' } },
    res,
    fs,
    aiHomeDir: fixture.aiHomeDir,
    deps: { aiHomeDir: fixture.aiHomeDir },
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
    accountStateIndex: fixture.accountStateIndex,
    accountStateService: createAccountStateServiceRecorder(upserts),
    getProfileDir: fixture.getProfileDir,
    getToolConfigDir: fixture.getToolConfigDir,
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

test('web ui add starts remote browser oauth job instead of rejecting remote webui', async (t) => {
  const fixture = createAccountFixture(t, 'aih-webui-add-remote-');
  const res = createResCapture();
  const startedCalls = [];

  const handled = await handleAddAccountRequest({
    req: { headers: { host: 'accounts.example.com' } },
    res,
    fs,
    aiHomeDir: fixture.aiHomeDir,
    deps: { aiHomeDir: fixture.aiHomeDir },
    state: {},
    readRequestBody: async () => Buffer.from(JSON.stringify({
      provider: 'codex',
      authMode: 'oauth-browser'
    })),
    accountStateIndex: fixture.accountStateIndex,
    getProfileDir: fixture.getProfileDir,
    getToolConfigDir: fixture.getToolConfigDir,
    getAuthJobManager() {
      return {
        startOauthJob(provider, authMode) {
          startedCalls.push({ provider, authMode });
          return {
            jobId: 'job-remote',
            provider,
            accountRef: '',
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
});

test('web ui reauth reuses accountRef and stored auth mode for oauth accounts', async (t) => {
  const fixture = createAccountFixture(t);
  const accountRef = fixture.register('codex', '42', {
    state: {
      displayName: 'codex-user',
      configured: true,
      apiKeyMode: false,
      authMode: 'oauth-device'
    }
  });
  const res = createResCapture();
  const startedCalls = [];

  const handled = await handleReauthAccountRequest({
    pathname: `/v0/webui/accounts/codex/${accountRef}/reauth`,
    req: { headers: {} },
    res,
    fs,
    aiHomeDir: fixture.aiHomeDir,
    accountStateIndex: fixture.accountStateIndex,
    getProfileDir: fixture.getProfileDir,
    getToolConfigDir: fixture.getToolConfigDir,
    getAuthJobManager() {
      return {
        startOauthJob(provider, authMode, options) {
          startedCalls.push({ provider, authMode, options });
          return {
            jobId: 'job-42',
            provider,
            accountRef: options.accountRef,
            expiresAt: null,
            pollIntervalMs: 5000
          };
        }
      };
    },
    deps: { aiHomeDir: fixture.aiHomeDir },
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
  assert.equal(body.accountRef, accountRef);
  assert.equal(body.authMode, 'oauth-device');
  assert.equal(body.jobId, 'job-42');
  assert.deepEqual(startedCalls, [
    {
      provider: 'codex',
      authMode: 'oauth-device',
      options: { accountRef }
    }
  ]);
});

test('web ui reauth starts remote codex browser oauth job by accountRef', async (t) => {
  const fixture = createAccountFixture(t);
  const accountRef = fixture.register('codex', '43', {
    state: { configured: true, apiKeyMode: false, authMode: 'oauth-browser' }
  });
  const res = createResCapture();
  const startedCalls = [];

  const handled = await handleReauthAccountRequest({
    pathname: `/v0/webui/accounts/codex/${accountRef}/reauth`,
    req: { headers: { host: 'accounts.example.com' } },
    res,
    fs,
    aiHomeDir: fixture.aiHomeDir,
    accountStateIndex: fixture.accountStateIndex,
    getProfileDir: fixture.getProfileDir,
    getToolConfigDir: fixture.getToolConfigDir,
    getAuthJobManager() {
      return {
        startOauthJob(provider, authMode, options) {
          startedCalls.push({ provider, authMode, options });
          return {
            jobId: 'job-42',
            provider,
            accountRef: options.accountRef,
            expiresAt: null,
            pollIntervalMs: 5000
          };
        }
      };
    },
    deps: { aiHomeDir: fixture.aiHomeDir },
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
      options: { accountRef }
    }
  ]);
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
              accountRef: 'acct_11111111111111111111',
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
    accountRef: 'acct_99999999999999999999',
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
    accountRef: 'acct_44444444444444444444',
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

test('web ui cleanup removes only the OAuth login runtime and preserves DB account identity', (t) => {
  const fixture = createAccountFixture(t, 'aih-web-reauth-cleanup-');
  const accountRef = fixture.register('agy', '1');
  const runtimeDir = path.join(fixture.aiHomeDir, 'run', 'login', 'agy', 'job-cancelled');
  fs.ensureDirSync(runtimeDir);
  fs.writeFileSync(path.join(runtimeDir, 'token.json'), '{}');
  const hostHomeDir = path.join(fixture.aiHomeDir, 'host-home');
  const ensureSessionStoreLinks = createSessionStoreService({
    fs,
    fse: fs,
    path,
    processObj: process,
    aiHomeDir: fixture.aiHomeDir,
    hostHomeDir,
    cliConfigs: { agy: { globalDir: '.gemini', configSubDir: 'antigravity-cli' } },
    getProfileDir: (provider, ref) => resolveAccountRuntimeDir(fixture.aiHomeDir, provider, ref),
    ensureDir: (dir) => fs.ensureDirSync(dir)
  }).ensureSessionStoreLinks;
  let reloaded = false;
  cleanupAuthJobArtifacts({
    id: 'job-reauth-cancelled',
    provider: 'agy',
    accountRef,
    reauth: true,
    runtimeDir
  }, {
    fs,
    aiHomeDir: fixture.aiHomeDir,
    accountStateIndex: fixture.accountStateIndex,
    ensureSessionStoreLinks,
    loadServerRuntimeAccounts() {
      return { agy: [] };
    },
    applyReloadState() {
      reloaded = true;
    },
    getProfileDir: fixture.getProfileDir,
    getToolConfigDir: fixture.getToolConfigDir,
    checkStatus() {
      return { configured: true };
    },
    options: {}
  }, {});

  assert.equal(fs.existsSync(runtimeDir), false);
  assert.equal(
    fs.readFileSync(path.join(
      hostHomeDir,
      '.gemini',
      'antigravity-cli',
      '.aih-runtime-home',
      'home',
      'token.json'
    ), 'utf8'),
    '{}'
  );
  assert.equal(readAccountCredentials(fs, fixture.aiHomeDir, accountRef).AGY_ACCESS_TOKEN, 'agy-access-1');
  assert.equal(reloaded, true);
});

test('web ui cleanup preserves login runtime when resources cannot reconcile', (t) => {
  const fixture = createAccountFixture(t, 'aih-web-login-reconcile-fail-');
  const accountRef = fixture.register('agy', '2');
  const runtimeDir = path.join(fixture.aiHomeDir, 'run', 'login', 'agy', 'job-failed');
  fs.ensureDirSync(runtimeDir);
  fs.writeFileSync(path.join(runtimeDir, 'late-resource.txt'), 'must-survive', 'utf8');
  const job = {
    id: 'job-failed',
    provider: 'agy',
    accountRef,
    runtimeDir
  };

  cleanupAuthJobArtifacts(job, {
    fs,
    aiHomeDir: fixture.aiHomeDir,
    accountStateIndex: fixture.accountStateIndex,
    ensureSessionStoreLinks() {
      return { unresolved: ['late-resource.txt'] };
    },
    loadServerRuntimeAccounts() {
      throw new Error('must not reload after unsafe cleanup');
    },
    applyReloadState() {},
    getProfileDir: fixture.getProfileDir,
    getToolConfigDir: fixture.getToolConfigDir,
    checkStatus() {
      return { configured: true };
    },
    options: {}
  }, {});

  assert.equal(fs.readFileSync(path.join(runtimeDir, 'late-resource.txt'), 'utf8'), 'must-survive');
  assert.match(job.resourceReconciliationError, /provider_resource_reconcile_incomplete/);
  assert.equal(job._authArtifactsCleaned, undefined);
});

test('web ui cleanup waits for the OAuth writer to exit', (t) => {
  const fixture = createAccountFixture(t, 'aih-web-login-active-writer-');
  const runtimeDir = path.join(fixture.aiHomeDir, 'run', 'login', 'agy', 'job-running');
  fs.ensureDirSync(runtimeDir);
  const job = {
    id: 'job-running',
    provider: 'agy',
    runtimeDir,
    _ptyProcess: { pid: 123 }
  };

  cleanupAuthJobArtifacts(job, { fs }, {});

  assert.equal(fs.existsSync(runtimeDir), true);
  assert.equal(job._authArtifactsCleaned, undefined);
});

test('web ui delete evicts AGY warm writer before reconciling account resources', async (t) => {
  const fixture = createAccountFixture(t, 'aih-web-delete-agy-warm-');
  const accountRef = fixture.register('agy', '31');
  const res = createResCapture();
  const lifecycle = [];

  const handled = await handleDeleteAccountRequest({
    pathname: `/v0/webui/accounts/agy/${accountRef}`,
    res,
    fs,
    deps: {
      aiHomeDir: fixture.aiHomeDir,
      hostHomeDir: path.join(fixture.aiHomeDir, 'host-home')
    },
    state: {},
    accountStateService: {
      deleteAccount() {
        lifecycle.push('state-delete');
        return true;
      }
    },
    ensureSessionStoreLinks() {
      lifecycle.push('reconcile');
      return { migrated: 0, linked: 0 };
    },
    agyWarmPool: {
      async evict(resolvedRef) {
        assert.equal(resolvedRef, accountRef);
        lifecycle.push('evict');
        return true;
      }
    },
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(lifecycle, ['evict', 'reconcile', 'state-delete']);
  assert.equal(readAccountCredentials(fs, fixture.aiHomeDir, accountRef).AGY_ACCESS_TOKEN, undefined);
});

test('web ui delete fails closed when AGY warm writer cannot exit', async (t) => {
  const fixture = createAccountFixture(t, 'aih-web-delete-agy-warm-fail-');
  const accountRef = fixture.register('agy', '32');
  const runtimeDir = resolveAccountRuntimeDir(fixture.aiHomeDir, 'agy', accountRef);
  const resourcePath = path.join(runtimeDir, 'late-resource.txt');
  const res = createResCapture();
  fs.ensureDirSync(runtimeDir);
  fs.writeFileSync(resourcePath, 'must-survive', 'utf8');
  let reconciled = false;
  let stateDeleted = false;

  const handled = await handleDeleteAccountRequest({
    pathname: `/v0/webui/accounts/agy/${accountRef}`,
    res,
    fs,
    deps: { aiHomeDir: fixture.aiHomeDir },
    state: {},
    accountStateService: {
      deleteAccount() {
        stateDeleted = true;
        return true;
      }
    },
    ensureSessionStoreLinks() {
      reconciled = true;
      return { migrated: 0, linked: 0 };
    },
    agyWarmPool: {
      async evict(resolvedRef) {
        assert.equal(resolvedRef, accountRef);
        return false;
      }
    },
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 409);
  assert.equal(JSON.parse(res.body).error, 'account_runtime_active');
  assert.equal(reconciled, false);
  assert.equal(stateDeleted, false);
  assert.equal(fs.readFileSync(resourcePath, 'utf8'), 'must-survive');
  assert.equal(readAccountCredentials(fs, fixture.aiHomeDir, accountRef).AGY_ACCESS_TOKEN, 'agy-access-32');
});

test('web ui delete fails closed while the account has an active native run', async (t) => {
  const fixture = createAccountFixture(t, 'aih-web-delete-native-active-');
  const accountRef = fixture.register('agy', '33');
  const res = createResCapture();
  let evicted = false;
  let reconciled = false;

  const handled = await handleDeleteAccountRequest({
    pathname: `/v0/webui/accounts/agy/${accountRef}`,
    res,
    fs,
    deps: { aiHomeDir: fixture.aiHomeDir },
    state: {},
    accountStateService: { deleteAccount: () => true },
    listNativeChatRuns: () => [{ provider: 'agy', accountRef }],
    ensureSessionStoreLinks() {
      reconciled = true;
      return { migrated: 0, linked: 0 };
    },
    agyWarmPool: {
      async evict() {
        evicted = true;
        return true;
      }
    },
    writeJson(response, code, payload) {
      response.statusCode = code;
      response.end(JSON.stringify(payload));
    }
  });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 409);
  assert.equal(JSON.parse(res.body).error, 'account_runtime_active');
  assert.equal(evicted, false);
  assert.equal(reconciled, false);
  assert.equal(readAccountCredentials(fs, fixture.aiHomeDir, accountRef).AGY_ACCESS_TOKEN, 'agy-access-33');
});

test('web ui reauth rejects DB api key accountRef', async (t) => {
  const fixture = createAccountFixture(t);
  const accountRef = fixture.register('claude', '7', {
    apiKeyMode: true,
    state: { configured: true, apiKeyMode: true, authMode: 'api-key' }
  });
  const res = createResCapture();
  let startCalled = false;

  const handled = await handleReauthAccountRequest({
    pathname: `/v0/webui/accounts/claude/${accountRef}/reauth`,
    req: { headers: {} },
    res,
    fs,
    aiHomeDir: fixture.aiHomeDir,
    accountStateIndex: fixture.accountStateIndex,
    getProfileDir: fixture.getProfileDir,
    getToolConfigDir: fixture.getToolConfigDir,
    getAuthJobManager() {
      return {
        startOauthJob() {
          startCalled = true;
          throw new Error('should_not_start');
        }
      };
    },
    deps: { aiHomeDir: fixture.aiHomeDir },
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

test('web ui reauth starts oauth flow for unconfigured pending accountRef', async (t) => {
  const fixture = createAccountFixture(t);
  const accountRef = fixture.register('codex', '9', {
    configured: false,
    state: {
      status: 'down',
      configured: false,
      apiKeyMode: false,
      authMode: '',
      displayName: 'OAuth 授权中',
      updatedAt: Date.now()
    }
  });
  const res = createResCapture();
  const startedJobs = [];

  const handled = await handleReauthAccountRequest({
    pathname: `/v0/webui/accounts/codex/${accountRef}/reauth`,
    req: { headers: {} },
    res,
    fs,
    aiHomeDir: fixture.aiHomeDir,
    accountStateIndex: fixture.accountStateIndex,
    getProfileDir: fixture.getProfileDir,
    getToolConfigDir: fixture.getToolConfigDir,
    getAuthJobManager() {
      return {
        startOauthJob(provider, authMode, options) {
          startedJobs.push({ provider, authMode, options });
          return {
            provider,
            accountRef: options.accountRef,
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
    deps: { aiHomeDir: fixture.aiHomeDir },
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
  assert.deepEqual(startedJobs[0].options, { accountRef });
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.status, 'pending');
  assert.equal(body.accountRef, accountRef);
  assert.equal(body.jobId, 'job-pending-reauth');
});

test('web ui account update rejects OAuth accountRef', async (t) => {
  const fixture = createAccountFixture(t);
  const accountRef = fixture.register('codex', '42', {
    state: { configured: true, apiKeyMode: false, authMode: 'oauth-browser' }
  });
  const res = createResCapture();
  const before = readAccountCredentials(fs, fixture.aiHomeDir, accountRef);

  const handled = await handleUpdateAccountRequest({
    pathname: `/v0/webui/accounts/codex/${accountRef}/update`,
    req: { headers: {} },
    res,
    readRequestBody: async () => Buffer.from(JSON.stringify({
      apiKey: 'sk-should-not-write',
      baseUrl: 'https://api.example.test/v1'
    })),
    fs,
    aiHomeDir: fixture.aiHomeDir,
    accountStateIndex: fixture.accountStateIndex,
    accountStateService: {
      syncAccountBaseState() {
        throw new Error('should_not_sync');
      }
    },
    getProfileDir: fixture.getProfileDir,
    getToolConfigDir: fixture.getToolConfigDir,
    loadServerRuntimeAccounts() {
      throw new Error('should_not_reload');
    },
    applyReloadState() {},
    checkStatus() {
      return { configured: true, accountName: 'oauth@example.com' };
    },
    deps: { aiHomeDir: fixture.aiHomeDir },
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
  assert.deepEqual(readAccountCredentials(fs, fixture.aiHomeDir, accountRef), before);
});

test('web ui account update switches Claude DB api key account to auth-token credentials', async (t) => {
    const fixture = createAccountFixture(t, 'aih-webui-claude-auth-token-update-');
    const editedAccountRef = fixture.register('claude', '6', {
      env: {
      AIH_CLAUDE_CREDENTIAL_TYPE: 'api-key',
      ANTHROPIC_API_KEY: 'old-api-key',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com'
      },
      state: { configured: true, apiKeyMode: true, authMode: 'api-key' }
    });

    const syncedStates = [];
    const otherAccountRef = fixture.register('claude', '7', { apiKeyMode: true });
    const state = {
      accounts: {
        codex: [],
        gemini: [],
        claude: [{
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
      pathname: `/v0/webui/accounts/claude/${editedAccountRef}/update`,
      req: { headers: {} },
      res,
      readRequestBody: async () => Buffer.from(JSON.stringify({
        authMode: 'auth-token',
        apiKey: 'new-auth-token',
        baseUrl: 'https://anyrouter.top'
      })),
      fs,
      aiHomeDir: fixture.aiHomeDir,
      accountStateIndex: fixture.accountStateIndex,
      accountStateService: {
        syncAccountBaseState(accountRef, provider, state) {
          syncedStates.push({ accountRef, provider, state });
        }
      },
      getProfileDir: fixture.getProfileDir,
      getToolConfigDir: fixture.getToolConfigDir,
      loadServerRuntimeAccounts() {
        return {
          codex: [],
          gemini: [],
          claude: [{
            accountRef: editedAccountRef,
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
      deps: { aiHomeDir: fixture.aiHomeDir },
      state,
      writeJson(response, code, payload) {
        response.statusCode = code;
        response.end(JSON.stringify(payload));
      }
    });

    const envJson = readAccountCredentials(fs, fixture.aiHomeDir, editedAccountRef);
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(envJson.AIH_CLAUDE_CREDENTIAL_TYPE, 'auth-token');
    assert.equal(envJson.ANTHROPIC_AUTH_TOKEN, 'new-auth-token');
    assert.equal(envJson.ANTHROPIC_BASE_URL, 'https://anyrouter.top');
    assert.equal(Object.prototype.hasOwnProperty.call(envJson, 'ANTHROPIC_API_KEY'), false);
    assert.equal(syncedStates.length, 1);
    assert.equal(syncedStates[0].accountRef, editedAccountRef);
    assert.equal(syncedStates[0].state.authMode, 'auth-token');
    assert.equal(syncedStates[0].state.apiKeyMode, true);
    assert.equal(state.webUiModelsCache.firstError, '');
    assert.equal(Object.prototype.hasOwnProperty.call(state.webUiModelsCache.byAccount, editedAccountRef), false);
    assert.deepEqual(state.webUiModelsCache.byAccount[otherAccountRef], ['sonnet[1m]']);
    assert.deepEqual(state.webUiModelsCache.byProvider, { claude: ['opus[1m]'] });
    const body = JSON.parse(res.body);
    assert.equal(body.account.authMode, 'auth-token');
    assert.equal(body.account.apiKeyMode, true);
});

test('web ui account status endpoint updates accountRef without forcing usage refresh', async (t) => {
  const fixture = createAccountFixture(t);
  const accountRef = fixture.register('codex', '42', {
    state: {
      status: 'up',
      configured: true,
      apiKeyMode: false,
      authMode: 'oauth-browser',
      remainingPct: 88,
      displayName: 'codex-user',
      runtimeState: { lastFailureKind: 'auth_invalid' }
    }
  });
  const res = createResCapture();
  const upserts = [];
  const runtimeReloads = [];
  const usageRefreshes = [];
  const modelCache = {
    updatedAt: Date.now(),
    byProvider: { codex: ['gpt-5.5'] },
    byAccount: { [accountRef]: ['gpt-5.5'] },
    errorsByAccount: {},
    accountUpdatedAt: { [accountRef]: Date.now() },
    accountSource: { [accountRef]: 'remote' },
    accountScanned: { [accountRef]: 1 },
    labels: {},
    signature: 'cached',
    source: 'remote',
    sourceCount: 1,
    scannedAccounts: 1,
    firstError: ''
  };
  const handled = await handleUpdateAccountStatusRequest({
    pathname: `/v0/webui/accounts/codex/${accountRef}/status`,
    req: {},
    res,
    state: { webUiModelsCache: modelCache },
    fs,
    aiHomeDir: fixture.aiHomeDir,
    deps: { aiHomeDir: fixture.aiHomeDir },
    readRequestBody: async () => Buffer.from(JSON.stringify({ status: 'down' })),
    accountStateIndex: fixture.accountStateIndex,
    accountStateService: {
      setOperationalStatus(candidateRef, provider, status) {
        fixture.setState(candidateRef, provider, {
          ...fixture.accountStateIndex.getAccountState(candidateRef),
          status
        });
        upserts.push({ kind: 'status', provider, accountRef: candidateRef, status });
        return true;
      }
    },
    getProfileDir: fixture.getProfileDir,
    getToolConfigDir: fixture.getToolConfigDir,
    checkStatus() {
      return { configured: true, accountName: 'codex-user' };
    },
    loadServerRuntimeAccounts() {
      runtimeReloads.push('reload');
      return { agy: [], claude: [], codex: [], gemini: [], opencode: [] };
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
  assert.equal(modelCache.byAccount[accountRef][0], 'gpt-5.5');
  assert.deepEqual(upserts, [
    {
      kind: 'status',
      provider: 'codex',
      accountRef,
      status: 'down'
    }
  ]);
});

test('web ui oauth success preserves manually disabled DB status', async (t) => {
  const fixture = createAccountFixture(t, 'aih-webui-oauth-status-');
  const accountRef = fixture.register('codex', '42', {
    state: {
      status: 'down',
      configured: false,
      apiKeyMode: false,
      authMode: 'oauth-browser',
      displayName: 'codex-user'
    }
  });
  const upserts = [];

  await handleOauthJobFinishedStateSync({
    fs,
    aiHomeDir: fixture.aiHomeDir,
    options: {},
    accountStateIndex: fixture.accountStateIndex,
    accountStateService: {
      syncAccountBaseState(candidateRef, provider, state) {
        upserts.push({ kind: 'account', provider, accountRef: candidateRef, state });
        return true;
      },
      clearRuntimeBlock(candidateRef, provider, options) {
        upserts.push({
          kind: 'runtime',
          provider,
          accountRef: candidateRef,
          runtimeState: null,
          state: options.baseState
        });
        return true;
      }
    },
    getToolConfigDir: fixture.getToolConfigDir,
    getProfileDir: fixture.getProfileDir,
    loadServerRuntimeAccounts() {
      return { codex: [], gemini: [], claude: [] };
    },
    applyReloadState() {},
    checkStatus() {
      return { configured: true, accountName: 'rehydrated@example.com' };
    }
  }, {}, {
    provider: 'codex',
    accountRef,
    authMode: 'oauth-browser',
    status: 'succeeded'
  });

  assert.deepEqual(upserts, [
    {
      kind: 'account',
      provider: 'codex',
      accountRef,
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
      accountRef,
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
