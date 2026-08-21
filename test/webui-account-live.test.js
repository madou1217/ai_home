const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  deleteAccountCredentials,
  listAccountCredentialRecords,
  writeAccountCredentials,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');
const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { writeDefaultAccountRef } = require('../lib/account/default-account-store');
const { createAccountStateIndex } = require('../lib/account/state-index');
const { writeAccountUsageSnapshot } = require('../lib/account/usage-snapshot-store');
const { resolveAccountRuntimeDir } = require('../lib/runtime/aih-storage-layout');
const {
  ensureAccountsSnapshotLoaded,
  persistAccountsSnapshot
} = require('../lib/server/webui-accounts-cache');

const {
  readAccountsFastSnapshot,
  refreshLiveAccountRecord,
  removeLiveAccountRecord,
  emitAccountsAuthJobEvent,
  emitAccountTokenConsumedEvent,
  updateCachedAccountTokenUsage,
  __private
} = require('../lib/server/webui-account-live');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function registerDbAccount(aiHomeDir, provider, cliAccountId, options = {}) {
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider,
    cliAccountId,
    identitySeed: options.identitySeed || `oauth:${provider}:live-${cliAccountId}@example.com`
  });
  if (options.env && Object.keys(options.env).length > 0) {
    writeAccountCredentials(fs, aiHomeDir, accountRef, options.env);
  }
  if (options.nativeAuth && Object.keys(options.nativeAuth).length > 0) {
    writeAccountNativeAuth(fs, aiHomeDir, accountRef, options.nativeAuth);
  }
  if (options.usageSnapshot) {
    writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, options.usageSnapshot);
  }
  return accountRef;
}

test('fast account snapshot rejects only irrecoverable expired Claude OAuth credentials', () => {
  const expiredAccessOnly = {
    env: {},
    nativeAuth: {
      credentials: {
        claudeAiOauth: {
          accessToken: 'expired-access-token',
          expiresAt: 1_900_000_000_000
        }
      }
    }
  };
  const refreshable = {
    env: {},
    nativeAuth: {
      credentials: {
        claudeAiOauth: {
          accessToken: 'refreshable-access-token',
          refreshToken: 'refresh-token',
          expiresAt: 1_900_000_000_000
        }
      }
    }
  };

  assert.deepEqual(__private.readFastAccountPresence('claude', expiredAccessOnly, null, { nowMs: 2_000_000_000_000 }), {
    configured: false,
    apiKeyMode: false
  });
  assert.deepEqual(__private.readFastAccountPresence('claude', refreshable, null, { nowMs: 2_000_000_000_000 }), {
    configured: true,
    apiKeyMode: false
  });
});

test('fast account snapshot recognizes kimi OAuth credentials under $.credentials', () => {
  // 回归：kimi-code 凭证落在 native_auth_json 的 $.credentials；此前 fast 快照没有
  // kimi 分支，configured 恒为 false，WebUI 连锁显示"未配置/授权超时/待探测"。
  const withRefreshOnly = {
    env: {},
    nativeAuth: { credentials: { refresh_token: 'rt_kimi' } }
  };
  const withAccess = {
    env: {},
    nativeAuth: { credentials: { access_token: 'at_kimi', refresh_token: 'rt_kimi' } }
  };
  const accessOnly = {
    env: {},
    nativeAuth: { credentials: { access_token: 'at_kimi_expiring' } }
  };
  const baseUrlOnlyAccess = {
    env: { KIMI_BASE_URL: 'https://api.moonshot.ai/v1' },
    nativeAuth: { credentials: { access_token: 'at_kimi_behind_base_url' } }
  };
  const apiKey = {
    env: {
      KIMI_BASE_URL: 'https://api.moonshot.ai/v1',
      MOONSHOT_API_KEY: 'sk-kimi'
    },
    nativeAuth: { credentials: {} }
  };
  const legacyBehindEmptyCanonical = {
    env: {},
    nativeAuth: {
      credentials: {},
      auth: { access_token: 'at_kimi_legacy', refresh_token: 'rt_kimi_legacy' }
    }
  };
  const empty = { env: {}, nativeAuth: { credentials: {} } };

  assert.deepEqual(__private.readFastAccountPresence('kimi', withRefreshOnly, null), {
    configured: true,
    apiKeyMode: false
  });
  assert.deepEqual(__private.readFastAccountPresence('kimi', withAccess, null), {
    configured: true,
    apiKeyMode: false
  });
  assert.deepEqual(__private.readFastAccountPresence('kimi', accessOnly, null), {
    configured: false,
    apiKeyMode: false
  });
  assert.deepEqual(__private.readFastAccountPresence('kimi', baseUrlOnlyAccess, null), {
    configured: false,
    apiKeyMode: false
  });
  assert.deepEqual(__private.readFastAccountPresence('kimi', apiKey, null), {
    configured: true,
    apiKeyMode: true
  });
  assert.deepEqual(__private.readFastAccountPresence('kimi', legacyBehindEmptyCanonical, null), {
    configured: true,
    apiKeyMode: false
  });
  assert.deepEqual(__private.readFastAccountPresence('kimi', empty, null), {
    configured: false,
    apiKeyMode: false
  });
});

function buildRefreshContext(options) {
  const {
    aiHomeDir,
    provider,
    accountRef,
    stateInfo = {},
    runtimeAccount = null,
    status = { configured: true, accountName: '' }
  } = options;
  const profileDir = resolveAccountRuntimeDir(aiHomeDir, provider, accountRef);
  const configSubdirs = {
    agy: ['.gemini', 'antigravity-cli'],
    claude: ['.claude'],
    codex: ['.codex'],
    gemini: ['.gemini'],
    opencode: ['.config', 'opencode']
  };
  const configDir = path.join(profileDir, ...(configSubdirs[provider] || []));
  const accounts = { agy: [], claude: [], codex: [], gemini: [], opencode: [] };
  if (runtimeAccount) accounts[provider] = [{ ...runtimeAccount, provider, accountRef }];
  return {
    state: { accounts },
    fs,
    aiHomeDir,
    options: {},
    accountStateIndex: {
      getAccountState(candidateRef) {
        return candidateRef === accountRef ? stateInfo : null;
      }
    },
    getToolConfigDir() {
      return configDir;
    },
    getProfileDir() {
      return profileDir;
    },
    checkStatus() {
      return status;
    },
    getLastUsageProbeState() {
      return null;
    },
    getLastUsageProbeError() {
      return '';
    }
  };
}

function buildCodexUsageSnapshot(email, remainingPct) {
  return {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    account: {
      planType: 'pro',
      email,
      upstreamAccountId: `upstream_${email}`,
      organizationId: ''
    },
    entries: [
      {
        bucket: 'primary',
        windowMinutes: 10080,
        window: '7days',
        remainingPct,
        resetIn: '166h',
        resetAtMs: Date.now() + 600000000
      }
    ]
  };
}

test('removeLiveAccountRecord broadcasts account-removed over SSE and WebSocket watchers', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-account-live-remove-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const accountRef = 'acct_07000000000000000000';
  const account = {
    provider: 'codex',
    accountRef,
    status: 'up',
    displayName: 'remove@example.com',
    configured: true,
    apiKeyMode: false,
    remainingPct: null,
    updatedAt: 1,
    planType: 'oauth',
    email: 'remove@example.com',
    configDir: '/tmp/codex/7/.codex',
    profileDir: '/tmp/codex/7'
  };
  const sseRes = {
    body: '',
    write(chunk = '') {
      this.body += String(chunk);
      return true;
    }
  };
  const wsClient = {
    readyState: 1,
    frames: [],
    send(frame) {
      this.frames.push(String(frame));
    }
  };
  const liveState = {
    records: new Map([[accountRef, account]]),
    metadata: new Map([[accountRef, { value: { email: 'remove@example.com', planType: 'oauth' } }]]),
    usageSnapshots: new Map([[accountRef, { value: {} }]]),
    watchers: new Set([{ res: sseRes, heartbeat: null }]),
    webSocketWatchers: new Set([{ client: wsClient, heartbeat: null }]),
    webSocketServer: null,
    loadedFromDisk: true,
    hydrating: false,
    queued: false,
    lastHydratedAt: 0,
    revision: 3,
    roleSignature: '',
    fastSnapshot: {
      accounts: [account],
      hydrating: false
    },
    fastSnapshotAt: Date.now()
  };
  const state = {
    __webUiAccountsLive: liveState
  };

  const removed = removeLiveAccountRecord({ state, fs, aiHomeDir: root }, 'codex', accountRef, 'unit_test_delete');

  assert.equal(removed, true);
  assert.equal(liveState.records.has(accountRef), false);
  assert.equal(liveState.metadata.has(accountRef), false);
  assert.equal(liveState.usageSnapshots.has(accountRef), false);
  assert.match(sseRes.body, /"type":"account-removed"/);
  assert.match(sseRes.body, /"provider":"codex"/);
  assert.match(sseRes.body, new RegExp(`"accountRef":"${accountRef}"`));
  assert.equal(wsClient.frames.length, 1);
  assert.equal(JSON.parse(wsClient.frames[0]).type, 'account-removed');
  assert.equal(JSON.parse(wsClient.frames[0]).accountRef, accountRef);
});

test('token usage cache refresh updates account records and broadcasts token usage', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-account-token-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const accountRef = 'acct_0c000000000000000000';
  const account = {
    provider: 'codex',
    accountRef,
    status: 'up',
    displayName: 'token@example.com',
    configured: true,
    apiKeyMode: false,
    remainingPct: 100,
    updatedAt: 1,
    planType: 'pro',
    email: 'token@example.com',
    tokenUsage: null
  };
  const sseRes = {
    body: '',
    write(chunk = '') {
      this.body += String(chunk);
      return true;
    }
  };
  const wsClient = {
    readyState: 1,
    frames: [],
    send(frame) {
      this.frames.push(String(frame));
    }
  };
  const liveState = {
    records: new Map([[accountRef, account]]),
    metadata: new Map(),
    usageSnapshots: new Map(),
    watchers: new Set([{ res: sseRes, heartbeat: null }]),
    webSocketWatchers: new Set([{ client: wsClient, heartbeat: null }]),
    webSocketServer: null,
    loadedFromDisk: true,
    hydrating: false,
    queued: false,
    revision: 1,
    fastSnapshot: null,
    fastSnapshotAt: 0
  };
  const state = { __webUiAccountsLive: liveState };

  const cache = updateCachedAccountTokenUsage({ state, fs, aiHomeDir: root }, {
    [accountRef]: {
      day: 500_000_000,
      week: 1_000_000_000,
      month: 10_000_000_000,
      total: 42_000_000_000,
      models: [{
        model: 'gpt-5.6-luna',
        day: 500_000_000,
        dayCostUsd: 1.25,
        week: 1_000_000_000,
        weekCostUsd: 2.5,
        month: 10_000_000_000,
        monthCostUsd: null,
        total: 42_000_000_000,
        totalCostUsd: 12.5
      }]
    }
  }, { generatedAt: 1234 });

  assert.equal(cache.generatedAt, 1234);
  assert.equal(cache.schemaVersion, 3);
  assert.deepEqual(liveState.records.get(accountRef).tokenUsage, {
    day: 500_000_000,
    week: 1_000_000_000,
    month: 10_000_000_000,
    total: 42_000_000_000,
    models: [{
      model: 'gpt-5.6-luna',
      day: 500_000_000,
      dayCostUsd: 1.25,
      week: 1_000_000_000,
      weekCostUsd: 2.5,
      month: 10_000_000_000,
      monthCostUsd: null,
      total: 42_000_000_000,
      totalCostUsd: 12.5
    }]
  });
  assert.match(sseRes.body, /"type":"account"/);
  assert.match(sseRes.body, /"dayCostUsd":1\.25/);
  assert.match(sseRes.body, /"monthCostUsd":null/);
  assert.equal(wsClient.frames.length, 1);
  assert.deepEqual(JSON.parse(wsClient.frames[0]).account.tokenUsage, {
    day: 500_000_000,
    week: 1_000_000_000,
    month: 10_000_000_000,
    total: 42_000_000_000,
    models: [{
      model: 'gpt-5.6-luna',
      day: 500_000_000,
      dayCostUsd: 1.25,
      week: 1_000_000_000,
      weekCostUsd: 2.5,
      month: 10_000_000_000,
      monthCostUsd: null,
      total: 42_000_000_000,
      totalCostUsd: 12.5
    }]
  });
});

test('accountRef-keyed live records remove stale entries without parsing composite keys', () => {
  const activeRef = 'acct_08000000000000000000';
  const staleRef = 'acct_09000000000000000000';
  const liveState = {
    records: new Map([
      [activeRef, { provider: 'codex', accountRef: activeRef }],
      [staleRef, { provider: 'gemini', accountRef: staleRef }]
    ]),
    metadata: new Map([[staleRef, { value: {} }]]),
    usageSnapshots: new Map([[staleRef, { value: {} }]]),
    watchers: new Set(),
    webSocketWatchers: new Set(),
    webSocketServer: null,
    loadedFromDisk: true,
    hydrating: false,
    queued: false,
    revision: 0,
    fastSnapshot: null,
    fastSnapshotAt: 0
  };
  const state = { __webUiAccountsLive: liveState };

  __private.removeMissingLiveAccountRecords(
    { state, fs, aiHomeDir: '' },
    new Set([activeRef]),
    'unit_test_reconcile'
  );

  assert.deepEqual([...liveState.records.keys()], [activeRef]);
  assert.equal(liveState.metadata.has(staleRef), false);
  assert.equal(liveState.usageSnapshots.has(staleRef), false);
});

test('persisted account snapshots restore and reconcile by accountRef only', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-account-cache-key-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const activeRef = 'acct_0a000000000000000000';
  const staleRef = 'acct_0b000000000000000000';
  const ctx = { fs, aiHomeDir: root };

  persistAccountsSnapshot(ctx, { revision: 0 }, {
    accounts: [
      { provider: 'codex', accountRef: activeRef, displayName: 'old' },
      { provider: 'codex', accountRef: activeRef, displayName: 'current' },
      { provider: 'claude', accountRef: staleRef, displayName: 'stale' }
    ],
    hydrating: false
  });

  const liveState = {
    records: new Map(),
    metadata: new Map(),
    usageSnapshots: new Map(),
    watchers: new Set(),
    webSocketWatchers: new Set(),
    loadedFromDisk: false,
    hydrating: false,
    revision: 0,
    fastSnapshot: null,
    fastSnapshotAt: 0
  };
  ensureAccountsSnapshotLoaded(ctx, liveState);

  assert.deepEqual([...liveState.records.keys()].sort(), [activeRef, staleRef].sort());
  assert.equal(liveState.records.get(activeRef).displayName, 'current');

  __private.removeMissingLiveAccountRecords(
    { ...ctx, state: { __webUiAccountsLive: liveState } },
    new Set([activeRef]),
    'unit_test_reconcile'
  );
  assert.deepEqual([...liveState.records.keys()], [activeRef]);
});

test('accounts live poll derives deletion from the canonical DB and broadcasts removal', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-account-live-canonical-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const accountRef = registerDbAccount(root, 'codex', '8', {
    nativeAuth: { auth: { tokens: { access_token: 'at_8', refresh_token: 'rt_8' } } }
  });

  const account = {
    provider: 'codex',
    accountRef,
    status: 'up',
    displayName: 'external@example.com',
    configured: true,
    apiKeyMode: false,
    remainingPct: null,
    updatedAt: 1,
    planType: 'oauth',
    email: 'external@example.com'
  };
  const sseRes = {
    body: '',
    write(chunk = '') {
      this.body += String(chunk);
      return true;
    }
  };
  const wsClient = {
    readyState: 1,
    frames: [],
    send(frame) {
      this.frames.push(String(frame));
    }
  };
  const liveState = {
    records: new Map([[accountRef, account]]),
    metadata: new Map(),
    usageSnapshots: new Map(),
    watchers: new Set([{ res: sseRes, heartbeat: null }]),
    webSocketWatchers: new Set([{ client: wsClient, heartbeat: null }]),
    webSocketServer: null,
    loadedFromDisk: true,
    hydrating: false,
    queued: false,
    snapshotRefreshScheduled: false,
    canonicalPoller: null,
    canonicalSignature: '',
    hydrationPromise: null,
    lastHydratedAt: 0,
    revision: 1,
    roleSignature: '',
    fastSnapshot: {
      accounts: [account],
      hydrating: false
    },
    fastSnapshotAt: Date.now()
  };
  const state = { __webUiAccountsLive: liveState, accounts: { codex: [account] } };
  let reloaded = false;
  const ctx = {
    state,
    fs,
    aiHomeDir: root,
    loadServerRuntimeAccounts: () => {
      reloaded = true;
      return { codex: [], gemini: [], claude: [], agy: [], opencode: [] };
    },
    applyReloadState(targetState, runtimeAccounts) {
      targetState.accounts = runtimeAccounts;
    }
  };
  liveState.canonicalSignature = __private.buildCanonicalAccountsSignature(ctx);
  deleteAccountCredentials(fs, root, accountRef);

  const changed = await __private.pollCanonicalAccountsOnce(ctx);

  assert.equal(changed, true);
  assert.equal(reloaded, true);
  assert.equal(liveState.records.has(accountRef), false);
  assert.match(sseRes.body, /"type":"account-removed"/);
  assert.match(sseRes.body, /"reason":"canonical_account_missing"/);
  const removedFrame = wsClient.frames
    .map((frame) => JSON.parse(frame))
    .find((frame) => frame.type === 'account-removed');
  assert.ok(removedFrame);
  assert.equal(removedFrame.accountRef, accountRef);
});

test('accounts canonical signature includes DB-backed role changes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-account-live-role-signature-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const accountRef = registerDbAccount(root, 'codex', '9', {
    nativeAuth: { auth: { tokens: { access_token: 'at_9', refresh_token: 'rt_9' } } }
  });

  const ctx = { fs, aiHomeDir: root };

  const before = __private.buildCanonicalAccountsSignature(ctx);
  writeDefaultAccountRef(fs, root, 'codex', accountRef);
  const after = __private.buildCanonicalAccountsSignature(ctx);

  assert.notEqual(after, before);
  assert.match(after, new RegExp(`roles:codex:${accountRef}`));
});

test('accounts canonical signature includes Kimi Desktop effective region changes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-account-live-region-signature-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const accountRef = registerDbAccount(root, 'kimi', '10', {
    nativeAuth: { auth: { tokens: { access_token: 'at_10', refresh_token: 'rt_10' } } }
  });
  const regionPath = path.join(
    resolveAccountRuntimeDir(root, 'kimi', accountRef),
    'electron-user-data',
    'bridge-store',
    'region.json'
  );
  const ctx = { fs, aiHomeDir: root };

  const before = __private.buildCanonicalAccountsSignature(ctx);
  writeJson(regionPath, { lastEffective: 'china' });
  const after = __private.buildCanonicalAccountsSignature(ctx);

  assert.notEqual(after, before);
  assert.match(after, new RegExp(`${accountRef}:[^|]*,china(?:\\||$)`));
});

test('background hydration does not overwrite a newer operational status with queued state', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-account-live-status-race-'));
  const accountStateIndex = createAccountStateIndex({ fs, aiHomeDir: root });
  t.after(() => {
    accountStateIndex.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  registerDbAccount(root, 'codex', '20', {
    nativeAuth: { auth: { tokens: { access_token: 'at_20', refresh_token: 'rt_20' } } }
  });
  registerDbAccount(root, 'codex', '21', {
    nativeAuth: { auth: { tokens: { access_token: 'at_21', refresh_token: 'rt_21' } } }
  });
  const [leadingRecord, targetRecord] = listAccountCredentialRecords(fs, root, 'codex');
  const leadingRef = leadingRecord.accountRef;
  const targetRef = targetRecord.accountRef;
  accountStateIndex.upsertAccountState(leadingRef, 'codex', {
    status: 'down',
    configured: true,
    displayName: 'leading@example.com'
  });
  accountStateIndex.upsertAccountState(targetRef, 'codex', {
    status: 'down',
    configured: true,
    displayName: 'target@example.com'
  });
  let operationalChangeApplied = false;
  const state = {
    accounts: { codex: [], gemini: [], claude: [], agy: [] }
  };
  const ctx = {
    state,
    fs,
    aiHomeDir: root,
    options: {},
    accountStateIndex,
    checkStatus(_provider, accountRef) {
      if (accountRef === leadingRef && !operationalChangeApplied) {
        operationalChangeApplied = true;
        assert.equal(accountStateIndex.setStatus(targetRef, 'up'), true);
      }
      return {
        configured: true,
        accountName: accountRef === targetRef ? 'target@example.com' : 'leading@example.com'
      };
    },
    getLastUsageProbeState() {
      return null;
    },
    getLastUsageProbeError() {
      return '';
    }
  };

  await __private.refreshAccountsFromCanonicalSource(ctx, { force: true });

  assert.equal(operationalChangeApplied, true);
  assert.equal(state.__webUiAccountsLive.records.get(targetRef).status, 'up');
});

test('accounts live poll invalidates derived caches before hydrating canonical usage changes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-account-live-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const freshSnapshot = buildCodexUsageSnapshot('fresh@example.com', 72);
  const accountRef = registerDbAccount(root, 'codex', '9', {
    nativeAuth: { auth: { auth_mode: 'chatgpt', tokens: { refresh_token: 'rt_9', access_token: 'at_9' } } },
    usageSnapshot: freshSnapshot
  });
  const profileDir = resolveAccountRuntimeDir(root, 'codex', accountRef);
  const configDir = path.join(profileDir, '.codex');

  const staleSnapshot = buildCodexUsageSnapshot('stale@example.com', 5);
  const staleAccount = {
    provider: 'codex',
    accountRef,
    status: 'up',
    displayName: 'stale@example.com',
    configured: true,
    apiKeyMode: false,
    remainingPct: 5,
    usageSnapshot: staleSnapshot,
    updatedAt: staleSnapshot.capturedAt,
    planType: 'pro',
    email: 'stale@example.com',
    configDir,
    profileDir
  };
  const sseRes = {
    body: '',
    write(chunk = '') {
      this.body += String(chunk);
      return true;
    }
  };
  const liveState = {
    records: new Map([[accountRef, staleAccount]]),
    metadata: new Map([[accountRef, {
      expiresAt: Date.now() + 60_000,
      value: { email: 'stale@example.com', planType: 'pro' }
    }]]),
    usageSnapshots: new Map([[accountRef, {
      expiresAt: Date.now() + 60_000,
      value: staleSnapshot
    }]]),
    watchers: new Set([{ res: sseRes, heartbeat: null }]),
    webSocketWatchers: new Set(),
    webSocketServer: null,
    loadedFromDisk: true,
    hydrating: false,
    queued: false,
    snapshotRefreshScheduled: false,
    canonicalPoller: null,
    canonicalSignature: 'stale-signature',
    hydrationPromise: null,
    lastHydratedAt: 0,
    revision: 1,
    roleSignature: '',
    fastSnapshot: {
      accounts: [staleAccount],
      hydrating: false
    },
    fastSnapshotAt: Date.now()
  };
  const state = {
    __webUiAccountsLive: liveState,
    accounts: { codex: [], gemini: [], claude: [], agy: [] }
  };

  const changed = await __private.pollCanonicalAccountsOnce({
    state,
    fs,
    aiHomeDir: root,
    options: {},
    accountStateIndex: {
      getAccountState(candidateRef) {
        if (candidateRef === accountRef) {
          return {
            status: 'up',
            configured: true,
            apiKeyMode: false,
            displayName: 'fresh@example.com',
            updatedAt: 456
          };
        }
        return null;
      },
      listAccountStates(provider) {
        return provider === 'codex'
          ? [{ accountRef, status: 'up', configured: true, displayName: 'fresh@example.com', updatedAt: 456 }]
          : [];
      }
    },
    getToolConfigDir() {
      return configDir;
    },
    getProfileDir() {
      return profileDir;
    },
    loadServerRuntimeAccounts() {
      return { codex: [], gemini: [], claude: [], agy: [] };
    },
    applyReloadState(targetState, runtimeAccounts) {
      targetState.accounts = runtimeAccounts;
    },
    checkStatus() {
      return { configured: true, accountName: 'fresh@example.com' };
    },
    getLastUsageProbeState() {
      return null;
    },
    getLastUsageProbeError() {
      return '';
    }
  });

  const nextRecord = liveState.records.get(accountRef);
  const cachedSnapshot = liveState.usageSnapshots.get(accountRef);

  assert.equal(changed, true);
  assert.equal(nextRecord.email, 'fresh@example.com');
  assert.equal(nextRecord.remainingPct, 72);
  assert.equal(nextRecord.usageSnapshot.entries[0].remainingPct, 72);
  assert.equal(cachedSnapshot.value.account.email, 'fresh@example.com');
  assert.match(sseRes.body, /"type":"account"/);
  assert.match(sseRes.body, /fresh@example.com/);
});

test('emitAccountsAuthJobEvent broadcasts auth-job over SSE and WebSocket watchers', () => {
  const sseRes = {
    body: '',
    write(chunk = '') {
      this.body += String(chunk);
      return true;
    }
  };
  const wsClient = {
    readyState: 1,
    frames: [],
    send(frame) {
      this.frames.push(String(frame));
    }
  };
  const state = {
    __webUiAccountsLive: {
      records: new Map(),
      metadata: new Map(),
      usageSnapshots: new Map(),
      watchers: new Set([{ res: sseRes, heartbeat: null }]),
      webSocketWatchers: new Set([{ client: wsClient, heartbeat: null }]),
      webSocketServer: null,
      loadedFromDisk: true,
      hydrating: false,
      queued: false,
      lastHydratedAt: 0,
      revision: 1,
      roleSignature: '',
      fastSnapshot: null,
      fastSnapshotAt: 0
    }
  };
  const job = {
    id: 'job-live',
    provider: 'codex',
    accountRef: 'acct_12000000000000000000',
    authMode: 'oauth-browser',
    status: 'running',
    logs: 'waiting',
    _ptyProcess: {}
  };

  emitAccountsAuthJobEvent({ state }, job);

  assert.match(sseRes.body, /"type":"auth-job"/);
  assert.match(sseRes.body, /"id":"job-live"/);
  assert.equal(wsClient.frames.length, 1);
  const frame = JSON.parse(wsClient.frames[0]);
  assert.equal(frame.type, 'auth-job');
  assert.equal(frame.job.id, 'job-live');
  assert.equal(Object.prototype.hasOwnProperty.call(frame.job, '_ptyProcess'), false);
});

test('emitAccountTokenConsumedEvent broadcasts token-consumed over SSE and WebSocket watchers', () => {
  const sseRes = {
    body: '',
    write(chunk = '') {
      this.body += String(chunk);
      return true;
    }
  };
  const wsClient = {
    readyState: 1,
    frames: [],
    send(frame) {
      this.frames.push(String(frame));
    }
  };
  const state = {
    __webUiAccountsLive: {
      records: new Map(),
      metadata: new Map(),
      usageSnapshots: new Map(),
      watchers: new Set([{ res: sseRes, heartbeat: null }]),
      webSocketWatchers: new Set([{ client: wsClient, heartbeat: null }]),
      webSocketServer: null,
      loadedFromDisk: true,
      hydrating: false,
      queued: false,
      lastHydratedAt: 0,
      revision: 1,
      roleSignature: '',
      fastSnapshot: null,
      fastSnapshotAt: 0
    }
  };

  emitAccountTokenConsumedEvent(state, {
    provider: 'codex',
    accountRef: 'acct_12000000000000000000',
    model: 'gpt-5.6-terra',
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150
    },
    timestampMs: 12_345
  });

  assert.match(sseRes.body, /"type":"token-consumed"/);
  assert.match(sseRes.body, /"accountRef":"acct_12000000000000000000"/);
  assert.equal(wsClient.frames.length, 1);
  const frame = JSON.parse(wsClient.frames[0]);
  assert.equal(frame.type, 'token-consumed');
  assert.equal(frame.provider, 'codex');
  assert.equal(frame.accountRef, 'acct_12000000000000000000');
  assert.equal(frame.model, 'gpt-5.6-terra');
  assert.deepEqual(frame.tokens, { input: 100, output: 50, total: 150 });
  assert.equal(frame.occurredAt, 12_345);
});

test('emitAccountTokenConsumedEvent broadcasts anthropic cache/reasoning tokens as input+output', () => {
  const sseRes = {
    body: '',
    write(chunk = '') {
      this.body += String(chunk);
      return true;
    }
  };
  const state = {
    __webUiAccountsLive: {
      records: new Map(),
      metadata: new Map(),
      usageSnapshots: new Map(),
      watchers: new Set([{ res: sseRes, heartbeat: null }]),
      webSocketWatchers: new Set(),
      webSocketServer: null,
      loadedFromDisk: true,
      hydrating: false,
      queued: false,
      lastHydratedAt: 0,
      revision: 1,
      roleSignature: '',
      fastSnapshot: null,
      fastSnapshotAt: 0
    }
  };

  emitAccountTokenConsumedEvent(state, {
    provider: 'claude',
    accountRef: 'acct_12000000000000000001',
    model: 'claude-opus',
    usage: {
      input_tokens: 10,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 5,
      output_tokens: 20,
      reasoning_tokens: 4
    },
    timestampMs: 12_346
  });

  const frame = JSON.parse(sseRes.body.replace(/^data: /, '').trim());
  assert.equal(frame.type, 'token-consumed');
  assert.deepEqual(frame.tokens, { input: 45, output: 20, total: 65 });
});

test('emitAccountTokenConsumedEvent tolerates missing live state and ignores empty payloads', () => {
  const state = {};
  assert.doesNotThrow(() => emitAccountTokenConsumedEvent(state, {}));
  assert.doesNotThrow(() => emitAccountTokenConsumedEvent(state, {
    provider: 'codex',
    accountRef: 'acct_12000000000000000000',
    usage: {}
  }));
  assert.doesNotThrow(() => emitAccountTokenConsumedEvent(null, {
    provider: 'codex',
    accountRef: 'acct_12000000000000000000',
    usage: { total_tokens: 5 }
  }));
});

test('refreshLiveAccountRecord prefers trusted usage snapshot remaining over stale indexed/runtime remaining', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-account-live-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const usageSnapshot = {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    account: {
      planType: 'free',
      email: 'code5@meadeo.com',
      upstreamAccountId: 'upstream_5',
      organizationId: ''
    },
    entries: [
      {
        bucket: 'primary',
        windowMinutes: 300,
        window: '5h',
        remainingPct: 0,
        resetIn: '5h',
        resetAtMs: Date.now() + 18000000
      },
      {
        bucket: 'primary',
        windowMinutes: 10080,
        window: '7days',
        remainingPct: 75,
        resetIn: '166h',
        resetAtMs: Date.now() + 600000000
      }
    ]
  };
  const accountRef = registerDbAccount(root, 'codex', '5', {
    nativeAuth: { auth: { tokens: { refresh_token: 'rt_5', access_token: 'at_5' } } },
    usageSnapshot
  });
  const ctx = buildRefreshContext({
    aiHomeDir: root,
    provider: 'codex',
    accountRef,
    stateInfo: {
      configured: true,
      apiKeyMode: false,
      remainingPct: 75,
      displayName: 'code5@meadeo.com',
      updatedAt: 123
    },
    runtimeAccount: {
      email: 'code5@meadeo.com',
      remainingPct: 75,
      cooldownUntil: 0
    },
    status: { configured: true, accountName: 'code5@meadeo.com' }
  });

  const record = await refreshLiveAccountRecord(ctx, 'codex', accountRef, {
    skipUsageRefresh: true,
    skipRuntimeReload: true
  });

  assert.equal(record.remainingPct, 0);
  assert.equal(record.quotaStatus, 'exhausted');
  assert.equal(record.schedulableStatus, 'blocked_by_quota');
  assert.equal(record.usageSnapshot.entries[0].remainingPct, 0);
  assert.equal(record.usageSnapshot.entries[1].remainingPct, 75);
});

test('refreshLiveAccountRecord lets auth-invalid runtime state override usage remaining', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-account-live-auth-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const usageSnapshot = {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    account: {
      planType: 'pro',
      email: 'expired@example.com'
    },
    entries: [
      {
        bucket: 'primary',
        windowMinutes: 10080,
        remainingPct: 95
      }
    ]
  };
  const accountRef = registerDbAccount(root, 'codex', '10015', {
    nativeAuth: { auth: { tokens: { refresh_token: 'rt_10015', access_token: 'at_10015' } } },
    usageSnapshot
  });
  const ctx = buildRefreshContext({
    aiHomeDir: root,
    provider: 'codex',
    accountRef,
    stateInfo: {
      status: 'up',
      configured: true,
      apiKeyMode: false,
      remainingPct: 95,
      displayName: 'expired@example.com',
      runtimeState: {
        authInvalidUntil: Date.now() + 60_000,
        lastFailureKind: 'auth_invalid',
        lastFailureReason: 'token_expired'
      }
    },
    status: { configured: true, accountName: 'expired@example.com' }
  });

  const record = await refreshLiveAccountRecord(ctx, 'codex', accountRef, {
    skipUsageRefresh: true,
    skipRuntimeReload: true
  });

  assert.equal(record.runtimeStatus, 'auth_invalid');
  assert.equal(record.runtimeReason, 'token_expired');
  assert.equal(record.remainingPct, null);
  assert.equal(record.schedulableStatus, 'blocked_by_runtime_status');
  assert.equal(record.schedulableReason, 'auth_invalid');
});

test('refreshLiveAccountRecord lets persisted runtime state override healthy in-memory account', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-account-live-persisted-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const usageSnapshot = {
    schemaVersion: 2,
    kind: 'gemini_oauth_stats',
    source: 'gemini_refresh_user_quota',
    capturedAt: Date.now(),
    models: [
      {
        model: 'gemini-2.5-pro',
        remainingPct: 100,
        resetIn: '24h',
        resetAtMs: Date.now() + 86_400_000
      }
    ]
  };
  const accountRef = registerDbAccount(root, 'gemini', '3', {
    nativeAuth: {
      oauthCreds: { access_token: 'at_3', refresh_token: 'rt_3' },
      googleAccounts: { active: 'gemini@example.com' }
    },
    usageSnapshot
  });
  const ctx = buildRefreshContext({
    aiHomeDir: root,
    provider: 'gemini',
    accountRef,
    stateInfo: {
      status: 'up',
      configured: true,
      apiKeyMode: false,
      remainingPct: 100,
      displayName: 'gemini@example.com',
      runtimeState: {
        cooldownUntil: Date.now() + 60_000,
        authInvalidUntil: Date.now() + 60_000,
        lastFailureKind: 'auth_invalid',
        lastFailureReason: 'auth_invalid_reauth_required'
      }
    },
    runtimeAccount: {
      email: 'gemini@example.com',
      remainingPct: 100,
      cooldownUntil: 0,
      authInvalidUntil: 0
    },
    status: { configured: true, accountName: 'gemini@example.com' }
  });

  const record = await refreshLiveAccountRecord(ctx, 'gemini', accountRef, {
    skipUsageRefresh: true,
    skipRuntimeReload: true
  });

  assert.equal(record.runtimeStatus, 'auth_invalid');
  assert.equal(record.runtimeReason, 'auth_invalid_reauth_required');
  assert.equal(record.remainingPct, null);
  assert.equal(record.schedulableStatus, 'blocked_by_runtime_status');
});

test('refreshLiveAccountRecord blocks AGY access-only DB accounts from schedulable pool', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-account-live-agy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const expiry = new Date(Date.now() + 3_600_000).toISOString();
  const accountRef = registerDbAccount(root, 'agy', '1', { nativeAuth: {
    oauthToken: {
      token: { access_token: 'agy-access', refresh_token: '', expiry },
      auth_method: 'consumer'
    },
    email: 'agy@example.com'
  } });
  const ctx = buildRefreshContext({
    aiHomeDir: root,
    provider: 'agy',
    accountRef,
    stateInfo: { status: 'up', configured: true, apiKeyMode: false, remainingPct: 0 },
    status: {
      configured: true,
      accountName: 'agy@example.com',
      hasAccessToken: true,
      hasRefreshToken: false,
      tokenExpiresAt: Date.now() + 3_600_000
    }
  });

  const record = await refreshLiveAccountRecord(ctx, 'agy', accountRef, {
    skipUsageRefresh: true,
    skipRuntimeReload: true
  });

  assert.equal(record.configured, true);
  assert.equal(record.email, 'agy@example.com');
  assert.equal(record.remainingPct, null);
  assert.equal(record.quotaStatus, 'pending');
  assert.equal(record.schedulableStatus, 'blocked_by_policy');
  assert.equal(record.schedulableReason, 'agy_access_token_required');
});

test('refreshLiveAccountRecord ignores a legacy agy auth block without a failure reason when OAuth creds are recoverable', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-account-live-agy-current-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const expiry = new Date(Date.now() - 60_000).toISOString();
  const accountRef = registerDbAccount(root, 'agy', '1', { nativeAuth: {
    oauthToken: {
      token: { access_token: 'agy-token', refresh_token: 'agy-refresh', expiry },
      auth_method: 'consumer'
    },
    email: 'agy@example.com'
  } });
  const ctx = buildRefreshContext({
    aiHomeDir: root,
    provider: 'agy',
    accountRef,
    stateInfo: {
      status: 'up',
      configured: true,
      apiKeyMode: false,
      displayName: 'agy@example.com',
      runtimeState: {
        authInvalidUntil: Date.now() + 60_000,
        lastFailureKind: 'auth_invalid',
        lastFailureReason: ''
      }
    },
    runtimeAccount: {
      email: 'agy@example.com',
      accessToken: 'agy-token',
      cooldownUntil: 0,
      authInvalidUntil: 0
    },
    status: {
      configured: true,
      accountName: 'agy@example.com',
      authMode: 'consumer',
      hasAccessToken: true,
      hasRefreshToken: true,
      tokenExpiresAt: Date.now() - 60_000
    }
  });

  const record = await refreshLiveAccountRecord(ctx, 'agy', accountRef, {
    skipUsageRefresh: true,
    skipRuntimeReload: true
  });

  assert.equal(record.configured, true);
  assert.equal(record.runtimeStatus, 'healthy');
  assert.equal(record.runtimeReason, '');
  assert.equal(record.schedulableStatus, 'schedulable');
});

test('refreshLiveAccountRecord does not show agy_access_token_required when refresh_token exists but access_token is missing', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-account-live-agy-refresh-only-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const expiry = new Date(Date.now() - 3_600_000).toISOString();
  const accountRef = registerDbAccount(root, 'agy', '1', { nativeAuth: {
    oauthToken: {
      token: { access_token: '', refresh_token: 'agy-refresh-token', expiry },
      auth_method: 'consumer'
    },
    email: 'agy@example.com'
  } });
  const ctx = buildRefreshContext({
    aiHomeDir: root,
    provider: 'agy',
    accountRef,
    stateInfo: { status: 'up', configured: true, apiKeyMode: false },
    status: {
      configured: true,
      accountName: 'agy@example.com',
      authMode: 'consumer',
      hasAccessToken: false,
      hasRefreshToken: true,
      tokenExpiresAt: Date.now() - 3_600_000
    }
  });

  const record = await refreshLiveAccountRecord(ctx, 'agy', accountRef, {
    skipUsageRefresh: true,
    skipRuntimeReload: true
  });

  assert.equal(record.configured, true);
  // With a refresh_token available, the daemon can recover — must NOT show blocked_by_policy
  assert.notEqual(record.schedulableReason, 'agy_access_token_required');
  assert.notEqual(record.schedulableStatus, 'blocked_by_policy');
});

test('refreshLiveAccountRecord shows exhausted quota for free agy accounts with model quota cooldown', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-account-live-agy-free-exhausted-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const expiry = new Date(Date.now() + 3_600_000).toISOString();
  const usageSnapshot = {
    schemaVersion: 2,
    kind: 'agy_code_assist_quota',
    source: 'agy_fetch_available_models',
    capturedAt: Date.now(),
    account: {
      email: 'agy-free@example.com',
      planType: 'oauth',
      subscriptionTier: 'Antigravity Starter Quota',
      project: 'projects/agy-free'
    },
    models: [
      {
        model: 'claude-opus-4-6-thinking',
        remainingPct: 100,
        resetIn: '24h',
        resetAtMs: Date.now() + 86_400_000
      },
      {
        model: 'gemini-3-flash',
        remainingPct: 100,
        resetIn: '24h',
        resetAtMs: Date.now() + 86_400_000
      }
    ]
  };
  const accountRef = registerDbAccount(root, 'agy', '5', {
    nativeAuth: {
      oauthToken: {
        token: {
          access_token: 'agy-token',
          refresh_token: 'agy-refresh-token',
          expiry
        },
        auth_method: 'consumer'
      },
      email: 'agy-free@example.com'
    },
    usageSnapshot
  });
  const runtimeState = {
    lastFailureKind: 'model_quota_exhausted',
    lastFailureReason: 'HTTP 429 RESOURCE_EXHAUSTED Resource has been exhausted (e.g. check quota)',
    modelCooldowns: {
      'claude-opus-4-6-thinking': Date.now() + 60_000
    }
  };
  const ctx = buildRefreshContext({
    aiHomeDir: root,
    provider: 'agy',
    accountRef,
    stateInfo: {
      status: 'up',
      configured: true,
      apiKeyMode: false,
      displayName: 'agy-free@example.com',
      runtimeState
    },
    runtimeAccount: {
      email: 'agy-free@example.com',
      accessToken: 'agy-token',
      refreshToken: 'agy-refresh-token',
      ...runtimeState
    },
    status: {
      configured: true,
      accountName: 'agy-free@example.com',
      authMode: 'consumer',
      hasAccessToken: true,
      hasRefreshToken: true,
      tokenExpiresAt: Date.now() + 3_600_000
    }
  });

  const record = await refreshLiveAccountRecord(ctx, 'agy', accountRef, {
    skipUsageRefresh: true,
    skipRuntimeReload: true
  });

  assert.equal(record.planType, 'free');
  assert.equal(record.remainingPct, 0);
  assert.equal(record.quotaStatus, 'exhausted');
  assert.equal(record.schedulableStatus, 'blocked_by_quota');
  assert.deepEqual(record.usageSnapshot.models.map((model) => model.remainingPct), [0, 0]);
});

test('legacy AGY directory fixtures are not used as credential truth', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-account-live-agy-directory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profileDir = path.join(root, 'profiles', 'agy', '5');
  const configDir = path.join(profileDir, '.gemini', 'antigravity-cli');
  const expiry = new Date(Date.now() + 3_600_000).toISOString();
  fs.mkdirSync(configDir, { recursive: true });
  writeJson(path.join(configDir, 'antigravity-oauth-token'), {
    token: {
      access_token: 'agy-token',
      refresh_token: 'agy-refresh-token',
      expiry
    },
    auth_method: 'consumer'
  });
  const record = await refreshLiveAccountRecord(buildRefreshContext({
    aiHomeDir: root,
    provider: 'agy',
    accountRef: 'acct_05000000000000000000'
  }), 'agy', 'acct_05000000000000000000', {
    skipUsageRefresh: true,
    skipRuntimeReload: true
  });
  assert.equal(record, null);
});

test('refreshLiveAccountRecord treats OpenCode as schedulable without usage collection', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-account-live-opencode-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const accountRef = registerDbAccount(root, 'opencode', '1', { nativeAuth: { auth: {
    anthropic: { type: 'api', key: 'sk-ant' },
    codex: { type: 'api', key: 'sk-codex' },
    'opencode-go': { type: 'api', key: 'sk-opencode-go-12345678' }
  } } });
  const ctx = buildRefreshContext({
    aiHomeDir: root,
    provider: 'opencode',
    accountRef,
    stateInfo: { status: 'up', configured: true, apiKeyMode: false },
    runtimeAccount: {
      displayName: 'OpenCode Go API (...5678)',
      apiKeyMode: false,
      authType: 'opencode-auth',
      accessToken: 'opencode-local',
      quotaStatus: 'not_applicable',
      schedulableStatus: 'schedulable'
    },
    status: {
      configured: true,
      accountName: 'OpenCode Go API (...5678)',
      authMode: 'opencode-auth'
    }
  });

  const record = await refreshLiveAccountRecord(ctx, 'opencode', accountRef, {
    skipUsageRefresh: true,
    skipRuntimeReload: true
  });

  assert.equal(record.displayName, 'OpenCode Go API (...5678)');
  assert.equal(record.quotaStatus, 'not_applicable');
  assert.equal(record.schedulableStatus, 'schedulable');
  assert.equal(record.remainingPct, null);
  assert.equal(record.usageSnapshot, null);
});

test('refreshLiveAccountRecord treats Grok as schedulable without usage collection', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-account-live-grok-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const accountRef = registerDbAccount(root, 'grok', '1', { nativeAuth: { auth: {
    'https://auth.x.ai::client': {
      key: 'grok-access-token',
      refresh_token: 'grok-refresh-token',
      email: 'grok@example.com',
      principal_id: 'grok-user-id'
    }
  } } });
  const ctx = buildRefreshContext({
    aiHomeDir: root,
    provider: 'grok',
    accountRef,
    stateInfo: { status: 'up', configured: true, apiKeyMode: false, displayName: 'grok@example.com' },
    runtimeAccount: {
      email: 'grok@example.com',
      apiKeyMode: false,
      authType: 'oauth',
      accessToken: 'grok-access-token',
      quotaStatus: 'not_applicable',
      schedulableStatus: 'schedulable'
    },
    status: {
      configured: true,
      accountName: 'grok@example.com',
      authMode: 'oauth',
      hasAccessToken: true,
      hasRefreshToken: true
    }
  });

  const record = await refreshLiveAccountRecord(ctx, 'grok', accountRef, {
    skipUsageRefresh: true,
    skipRuntimeReload: true
  });

  assert.equal(record.quotaStatus, 'not_applicable');
  assert.equal(record.schedulableStatus, 'schedulable');
  assert.equal(record.remainingPct, null);
  assert.equal(record.usageSnapshot, null);
});

test('refreshLiveAccountRecord surfaces kimi /me identity as nickname email and masked phone displayName', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-account-live-kimi-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const usageSnapshot = {
    schemaVersion: 2,
    kind: 'kimi_oauth_usage',
    source: 'kimi_oauth_usages_api',
    capturedAt: Date.now(),
    account: {
      planType: 'basic',
      planName: 'Allegretto',
      displayName: '登月者2115',
      phone: '+86 186****2115'
    },
    entries: [
      { bucket: 'weekly', windowMinutes: 10080, window: '7days', remainingPct: 51 }
    ]
  };
  const accountRef = registerDbAccount(root, 'kimi', '1', {
    nativeAuth: {
      credentials: {
        access_token: 'kimi-access-token',
        refresh_token: 'kimi-refresh-token',
        token_type: 'Bearer',
        expires_at: Math.floor(Date.now() / 1000) + 3600
      }
    },
    usageSnapshot
  });
  const ctx = buildRefreshContext({
    aiHomeDir: root,
    provider: 'kimi',
    accountRef,
    stateInfo: {
      status: 'up',
      configured: true,
      apiKeyMode: false,
      remainingPct: 51,
      displayName: ''
    },
    status: { configured: true, accountName: '' }
  });
  writeJson(path.join(
    resolveAccountRuntimeDir(root, 'kimi', accountRef),
    'electron-user-data',
    'bridge-store',
    'region.json'
  ), { lastEffective: 'china' });

  const record = await refreshLiveAccountRecord(ctx, 'kimi', accountRef, {
    skipUsageRefresh: true,
    skipRuntimeReload: true
  });

  assert.equal(record.email, '登月者2115');
  assert.equal(record.displayName, '+86 186****2115');
  assert.equal(record.planType, 'basic');
  assert.equal(record.planName, 'Allegretto');
  assert.equal(record.region, 'china');
});

test('fast account snapshot preserves the Kimi public subscription name', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-account-fast-kimi-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const usageSnapshot = {
    schemaVersion: 2,
    kind: 'kimi_oauth_usage',
    source: 'kimi_oauth_usages_api',
    capturedAt: Date.now(),
    account: {
      planType: 'intermediate',
      planName: 'Allegretto',
      displayName: '登月者2115',
      phone: '+86 186****2115'
    },
    entries: [
      { bucket: 'weekly', windowMinutes: 10080, window: '7days', remainingPct: 51 }
    ]
  };
  const accountRef = registerDbAccount(root, 'kimi', '1', {
    nativeAuth: {
      credentials: {
        access_token: 'kimi-access-token',
        refresh_token: 'kimi-refresh-token',
        expires_at: Math.floor(Date.now() / 1000) + 3600
      }
    },
    usageSnapshot
  });
  const ctx = buildRefreshContext({
    aiHomeDir: root,
    provider: 'kimi',
    accountRef,
    stateInfo: {
      status: 'up',
      configured: true,
      apiKeyMode: false,
      remainingPct: 51,
      displayName: ''
    },
    status: { configured: true, accountName: '' }
  });
  writeJson(path.join(
    resolveAccountRuntimeDir(root, 'kimi', accountRef),
    'electron-user-data',
    'bridge-store',
    'region.json'
  ), { lastEffective: 'overseas' });

  const snapshot = readAccountsFastSnapshot(ctx);
  const record = snapshot.accounts.find((item) => item.accountRef === accountRef);

  assert.ok(record);
  assert.equal(record.planType, 'intermediate');
  assert.equal(record.planName, 'Allegretto');
  assert.equal(record.region, 'overseas');
});
