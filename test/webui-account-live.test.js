const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  refreshLiveAccountRecord,
  removeLiveAccountRecord,
  emitAccountsAuthJobEvent,
  __private
} = require('../lib/server/webui-account-live');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
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
      accountId: `acc_${email}`,
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

  const account = {
    provider: 'codex',
    accountId: '7',
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
    records: new Map([['codex:7', account]]),
    metadata: new Map([['codex:7', { value: { email: 'remove@example.com', planType: 'oauth' } }]]),
    usageSnapshots: new Map([['codex:7', { value: {} }]]),
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

  const removed = removeLiveAccountRecord({ state, fs, aiHomeDir: root }, 'codex', '7', 'unit_test_delete');

  assert.equal(removed, true);
  assert.equal(liveState.records.has('codex:7'), false);
  assert.equal(liveState.metadata.has('codex:7'), false);
  assert.equal(liveState.usageSnapshots.has('codex:7'), false);
  assert.match(sseRes.body, /"type":"account-removed"/);
  assert.match(sseRes.body, /"provider":"codex"/);
  assert.match(sseRes.body, /"accountId":"7"/);
  assert.equal(wsClient.frames.length, 1);
  assert.equal(JSON.parse(wsClient.frames[0]).type, 'account-removed');
  assert.equal(JSON.parse(wsClient.frames[0]).accountId, '7');
});

test('accounts live poll derives CLI deletion from canonical profile source and broadcasts removal', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-account-live-canonical-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profileDir = path.join(root, 'profiles', 'codex', '8');
  fs.mkdirSync(path.join(profileDir, '.codex'), { recursive: true });

  const account = {
    provider: 'codex',
    accountId: '8',
    status: 'up',
    displayName: 'external@example.com',
    configured: true,
    apiKeyMode: false,
    remainingPct: null,
    updatedAt: 1,
    planType: 'oauth',
    email: 'external@example.com',
    configDir: path.join(profileDir, '.codex'),
    profileDir
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
    records: new Map([['codex:8', account]]),
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
    canonicalSignature: 'codex:8:old',
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
  fs.rmSync(profileDir, { recursive: true, force: true });

  const changed = await __private.pollCanonicalAccountsOnce({
    state,
    fs,
    aiHomeDir: root,
    getToolAccountIds: () => [],
    loadServerRuntimeAccounts: () => {
      reloaded = true;
      return { codex: [], gemini: [], claude: [], agy: [] };
    },
    applyReloadState(targetState, runtimeAccounts) {
      targetState.accounts = runtimeAccounts;
    }
  });

  assert.equal(changed, true);
  assert.equal(reloaded, true);
  assert.equal(liveState.records.has('codex:8'), false);
  assert.match(sseRes.body, /"type":"account-removed"/);
  assert.match(sseRes.body, /"reason":"canonical_account_missing"/);
  const removedFrame = wsClient.frames
    .map((frame) => JSON.parse(frame))
    .find((frame) => frame.type === 'account-removed');
  assert.ok(removedFrame);
  assert.equal(removedFrame.accountId, '8');
});

test('accounts canonical signature includes role files changed by CLI commands', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-account-live-role-signature-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profileDir = path.join(root, 'profiles', 'codex', '9');
  fs.mkdirSync(path.join(profileDir, '.codex'), { recursive: true });

  const ctx = {
    fs,
    aiHomeDir: root,
    getToolAccountIds(provider) {
      return provider === 'codex' ? ['9'] : [];
    },
    getToolConfigDir(_provider, accountId) {
      return path.join(root, 'profiles', 'codex', String(accountId), '.codex');
    },
    getProfileDir(_provider, accountId) {
      return path.join(root, 'profiles', 'codex', String(accountId));
    }
  };

  const before = __private.buildCanonicalAccountsSignature(ctx);
  fs.writeFileSync(path.join(root, 'profiles', 'codex', '.aih_default'), '9', 'utf8');
  const after = __private.buildCanonicalAccountsSignature(ctx);

  assert.notEqual(after, before);
  assert.match(after, /roles:codex:9/);
});

test('accounts live poll invalidates derived caches before hydrating canonical usage changes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-account-live-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profileDir = path.join(root, 'profiles', 'codex', '9');
  const configDir = path.join(profileDir, '.codex');
  writeJson(path.join(configDir, 'auth.json'), {
    auth_mode: 'chatgpt',
    tokens: {
      refresh_token: 'rt_9',
      access_token: 'at_9'
    }
  });
  writeJson(path.join(profileDir, '.aih_usage.json'), buildCodexUsageSnapshot('fresh@example.com', 72));

  const staleSnapshot = buildCodexUsageSnapshot('stale@example.com', 5);
  const staleAccount = {
    provider: 'codex',
    accountId: '9',
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
    records: new Map([['codex:9', staleAccount]]),
    metadata: new Map([['codex:9', {
      expiresAt: Date.now() + 60_000,
      value: { email: 'stale@example.com', planType: 'pro' }
    }]]),
    usageSnapshots: new Map([['codex:9', {
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
      getAccountState(provider, accountId) {
        if (provider === 'codex' && accountId === '9') {
          return {
            status: 'up',
            configured: true,
            apiKeyMode: false,
            displayName: 'fresh@example.com',
            updatedAt: 456
          };
        }
        return null;
      }
    },
    getToolAccountIds(provider) {
      return provider === 'codex' ? ['9'] : [];
    },
    getToolConfigDir(_provider, accountId) {
      return path.join(root, 'profiles', 'codex', String(accountId), '.codex');
    },
    getProfileDir(_provider, accountId) {
      return path.join(root, 'profiles', 'codex', String(accountId));
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

  const nextRecord = liveState.records.get('codex:9');
  const cachedSnapshot = liveState.usageSnapshots.get('codex:9');

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
    accountId: '12',
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

test('refreshLiveAccountRecord prefers trusted usage snapshot remaining over stale indexed/runtime remaining', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-account-live-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const profileDir = path.join(root, 'profiles', 'codex', '5');
  const configDir = path.join(profileDir, '.codex');
  writeJson(path.join(configDir, 'auth.json'), {
    auth_mode: 'chatgpt',
    tokens: {
      refresh_token: 'rt_5',
      access_token: 'at_5',
      id_token: '',
      account_id: 'acc_5'
    }
  });
  writeJson(path.join(profileDir, '.aih_usage.json'), {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    account: {
      planType: 'free',
      email: 'code5@meadeo.com',
      accountId: 'acc_5',
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
  });

  const ctx = {
    state: {
      accounts: {
        codex: [
          {
            id: '5',
            provider: 'codex',
            email: 'code5@meadeo.com',
            remainingPct: 75,
            cooldownUntil: 0
          }
        ],
        gemini: [],
        claude: []
      }
    },
    fs,
    options: {},
    accountStateIndex: {
      getAccountState(provider, accountId) {
        if (provider === 'codex' && accountId === '5') {
          return {
            configured: true,
            api_key_mode: false,
            remaining_pct: 75,
            display_name: 'code5@meadeo.com',
            updated_at: 123
          };
        }
        return null;
      }
    },
    getToolAccountIds(provider) {
      return provider === 'codex' ? ['5'] : [];
    },
    getToolConfigDir(_provider, accountId) {
      return path.join(root, 'profiles', 'codex', String(accountId), '.codex');
    },
    getProfileDir(_provider, accountId) {
      return path.join(root, 'profiles', 'codex', String(accountId));
    },
    checkStatus() {
      return {
        configured: true,
        accountName: 'code5@meadeo.com'
      };
    },
    getLastUsageProbeState() {
      return null;
    },
    getLastUsageProbeError() {
      return '';
    }
  };

  const record = await refreshLiveAccountRecord(ctx, 'codex', '5', {
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

  const profileDir = path.join(root, 'profiles', 'codex', '10015');
  const configDir = path.join(profileDir, '.codex');
  writeJson(path.join(configDir, 'auth.json'), {
    auth_mode: 'chatgpt',
    tokens: {
      refresh_token: 'rt_10015',
      access_token: 'at_10015'
    }
  });
  writeJson(path.join(profileDir, '.aih_usage.json'), {
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
  });

  const ctx = {
    state: {
      accounts: {
        codex: [],
        gemini: [],
        claude: []
      }
    },
    fs,
    options: {},
    accountStateIndex: {
      getAccountState(provider, accountId) {
        if (provider === 'codex' && accountId === '10015') {
          return {
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
          };
        }
        return null;
      }
    },
    getToolAccountIds(provider) {
      return provider === 'codex' ? ['10015'] : [];
    },
    getToolConfigDir(_provider, accountId) {
      return path.join(root, 'profiles', 'codex', String(accountId), '.codex');
    },
    getProfileDir(_provider, accountId) {
      return path.join(root, 'profiles', 'codex', String(accountId));
    },
    checkStatus() {
      return {
        configured: true,
        accountName: 'expired@example.com'
      };
    },
    getLastUsageProbeState() {
      return null;
    },
    getLastUsageProbeError() {
      return '';
    }
  };

  const record = await refreshLiveAccountRecord(ctx, 'codex', '10015', {
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

  const profileDir = path.join(root, 'profiles', 'gemini', '3');
  const configDir = path.join(profileDir, '.gemini');
  writeJson(path.join(configDir, 'oauth_creds.json'), {
    access_token: 'at_3',
    refresh_token: 'rt_3'
  });
  writeJson(path.join(configDir, 'google_accounts.json'), {
    active: 'gemini@example.com'
  });
  writeJson(path.join(profileDir, '.aih_usage.json'), {
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
  });

  const ctx = {
    state: {
      accounts: {
        codex: [],
        gemini: [
          {
            id: '3',
            provider: 'gemini',
            email: 'gemini@example.com',
            remainingPct: 100,
            cooldownUntil: 0,
            authInvalidUntil: 0
          }
        ],
        claude: []
      }
    },
    fs,
    options: {},
    accountStateIndex: {
      getAccountState(provider, accountId) {
        if (provider === 'gemini' && accountId === '3') {
          return {
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
          };
        }
        return null;
      }
    },
    getToolAccountIds(provider) {
      return provider === 'gemini' ? ['3'] : [];
    },
    getToolConfigDir(_provider, accountId) {
      return path.join(root, 'profiles', 'gemini', String(accountId), '.gemini');
    },
    getProfileDir(_provider, accountId) {
      return path.join(root, 'profiles', 'gemini', String(accountId));
    },
    checkStatus() {
      return {
        configured: true,
        accountName: 'gemini@example.com'
      };
    },
    getLastUsageProbeState() {
      return null;
    },
    getLastUsageProbeError() {
      return '';
    }
  };

  const record = await refreshLiveAccountRecord(ctx, 'gemini', '3', {
    skipUsageRefresh: true,
    skipRuntimeReload: true
  });

  assert.equal(record.runtimeStatus, 'auth_invalid');
  assert.equal(record.runtimeReason, 'auth_invalid_reauth_required');
  assert.equal(record.remainingPct, null);
  assert.equal(record.schedulableStatus, 'blocked_by_runtime_status');
});

test('refreshLiveAccountRecord blocks agy keyring-only accounts from schedulable pool', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-account-live-agy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const profileDir = path.join(root, 'profiles', 'agy', '1');
  const configDir = path.join(profileDir, '.gemini', 'antigravity-cli');
  fs.mkdirSync(path.join(configDir, 'log'), { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'log', 'latest.log'),
    'OAuth: authenticated successfully as agy@example.com\n',
    'utf8'
  );

  const ctx = {
    state: {
      accounts: {
        codex: [],
        gemini: [],
        claude: [],
        agy: []
      }
    },
    fs,
    options: {},
    accountStateIndex: {
      getAccountState() {
        return {
          status: 'up',
          configured: true,
          apiKeyMode: false,
          remainingPct: 0
        };
      }
    },
    getToolAccountIds(provider) {
      return provider === 'agy' ? ['1'] : [];
    },
    getToolConfigDir() {
      return configDir;
    },
    getProfileDir() {
      return profileDir;
    },
    checkStatus() {
      return {
        configured: true,
        accountName: 'agy@example.com'
      };
    },
    getLastUsageProbeState() {
      return null;
    },
    getLastUsageProbeError() {
      return '';
    }
  };

  const record = await refreshLiveAccountRecord(ctx, 'agy', '1', {
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

test('refreshLiveAccountRecord ignores stale agy auth block when OAuth creds are recoverable', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-account-live-agy-current-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const profileDir = path.join(root, 'profiles', 'agy', '1');
  const configDir = path.join(profileDir, '.gemini', 'antigravity-cli');
  fs.mkdirSync(configDir, { recursive: true });
  writeJson(path.join(configDir, 'antigravity-oauth-token'), {
    token: {
      access_token: 'agy-token',
      refresh_token: 'agy-refresh',
      expiry: new Date(Date.now() - 60_000).toISOString()
    },
    auth_method: 'consumer'
  });
  fs.writeFileSync(path.join(configDir, 'email.cache'), 'agy@example.com', 'utf8');

  const ctx = {
    state: {
      accounts: {
        codex: [],
        gemini: [],
        claude: [],
        agy: [
          {
            id: '1',
            provider: 'agy',
            email: 'agy@example.com',
            accessToken: 'agy-token',
            cooldownUntil: 0,
            authInvalidUntil: 0
          }
        ]
      }
    },
    fs,
    options: {},
    accountStateIndex: {
      getAccountState() {
        return {
          status: 'up',
          configured: true,
          apiKeyMode: false,
          displayName: 'agy@example.com',
          runtimeState: {
            authInvalidUntil: Date.now() + 60_000,
            lastFailureKind: 'auth_invalid',
            lastFailureReason: 'auth_invalid_reauth_required'
          }
        };
      }
    },
    getToolAccountIds(provider) {
      return provider === 'agy' ? ['1'] : [];
    },
    getToolConfigDir() {
      return configDir;
    },
    getProfileDir() {
      return profileDir;
    },
    checkStatus() {
      return {
        configured: true,
        accountName: 'agy@example.com',
        authMode: 'consumer',
        hasAccessToken: true,
        hasRefreshToken: true,
        tokenExpiresAt: Date.now() - 60_000
      };
    },
    getLastUsageProbeState() {
      return null;
    },
    getLastUsageProbeError() {
      return '';
    }
  };

  const record = await refreshLiveAccountRecord(ctx, 'agy', '1', {
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

  const profileDir = path.join(root, 'profiles', 'agy', '1');
  const configDir = path.join(profileDir, '.gemini', 'antigravity-cli');
  fs.mkdirSync(configDir, { recursive: true });
  // Token file has only refresh_token; access_token was cleared after expiry
  writeJson(path.join(configDir, 'antigravity-oauth-token'), {
    token: {
      access_token: '',
      refresh_token: 'agy-refresh-token',
      expiry: new Date(Date.now() - 3_600_000).toISOString()
    },
    auth_method: 'consumer'
  });
  fs.writeFileSync(path.join(configDir, 'email.cache'), 'agy@example.com', 'utf8');

  const ctx = {
    state: {
      accounts: {
        codex: [],
        gemini: [],
        claude: [],
        agy: []
      }
    },
    fs,
    options: {},
    accountStateIndex: {
      getAccountState() {
        return {
          status: 'up',
          configured: true,
          apiKeyMode: false
        };
      }
    },
    getToolAccountIds(provider) {
      return provider === 'agy' ? ['1'] : [];
    },
    getToolConfigDir() {
      return configDir;
    },
    getProfileDir() {
      return profileDir;
    },
    checkStatus() {
      return {
        configured: true,
        accountName: 'agy@example.com',
        authMode: 'consumer',
        hasAccessToken: false,
        hasRefreshToken: true,
        tokenExpiresAt: Date.now() - 3_600_000
      };
    },
    getLastUsageProbeState() {
      return null;
    },
    getLastUsageProbeError() {
      return '';
    }
  };

  const record = await refreshLiveAccountRecord(ctx, 'agy', '1', {
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

  const profileDir = path.join(root, 'profiles', 'agy', '5');
  const configDir = path.join(profileDir, '.gemini', 'antigravity-cli');
  fs.mkdirSync(configDir, { recursive: true });
  writeJson(path.join(configDir, 'antigravity-oauth-token'), {
    token: {
      access_token: 'agy-token',
      refresh_token: 'agy-refresh-token',
      expiry: new Date(Date.now() + 3_600_000).toISOString()
    },
    auth_method: 'consumer'
  });
  writeJson(path.join(profileDir, '.aih_usage.json'), {
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
  });

  const runtimeState = {
    lastFailureKind: 'model_quota_exhausted',
    lastFailureReason: 'HTTP 429 RESOURCE_EXHAUSTED Resource has been exhausted (e.g. check quota)',
    modelCooldowns: {
      'claude-opus-4-6-thinking': Date.now() + 60_000
    }
  };
  const ctx = {
    state: {
      accounts: {
        codex: [],
        gemini: [],
        claude: [],
        agy: [{
          id: '5',
          provider: 'agy',
          email: 'agy-free@example.com',
          accessToken: 'agy-token',
          refreshToken: 'agy-refresh-token',
          ...runtimeState
        }]
      }
    },
    fs,
    options: {},
    accountStateIndex: {
      getAccountState() {
        return {
          status: 'up',
          configured: true,
          apiKeyMode: false,
          displayName: 'agy-free@example.com',
          runtimeState
        };
      }
    },
    getToolAccountIds(provider) {
      return provider === 'agy' ? ['5'] : [];
    },
    getToolConfigDir() {
      return configDir;
    },
    getProfileDir() {
      return profileDir;
    },
    checkStatus() {
      return {
        configured: true,
        accountName: 'agy-free@example.com',
        authMode: 'consumer',
        hasAccessToken: true,
        hasRefreshToken: true,
        tokenExpiresAt: Date.now() + 3_600_000
      };
    },
    getLastUsageProbeState() {
      return null;
    },
    getLastUsageProbeError() {
      return '';
    }
  };

  const record = await refreshLiveAccountRecord(ctx, 'agy', '5', {
    skipUsageRefresh: true,
    skipRuntimeReload: true
  });

  assert.equal(record.planType, 'free');
  assert.equal(record.remainingPct, 0);
  assert.equal(record.quotaStatus, 'exhausted');
  assert.equal(record.schedulableStatus, 'blocked_by_quota');
  assert.deepEqual(record.usageSnapshot.models.map((model) => model.remainingPct), [0, 0]);
});

test('refreshLiveAccountRecord treats OpenCode as schedulable without usage collection', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-account-live-opencode-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const profileDir = path.join(root, 'profiles', 'opencode', '1');
  const configDir = path.join(profileDir, '.config', 'opencode');
  writeJson(path.join(profileDir, '.local', 'share', 'opencode', 'auth.json'), {
    anthropic: { type: 'api', key: 'sk-ant' },
    codex: { type: 'api', key: 'sk-codex' },
    'opencode-go': { type: 'api', key: 'sk-opencode-go-12345678' }
  });

  const staleRecord = {
    provider: 'opencode',
    accountId: '1',
    status: 'up',
    displayName: 'OpenCode: anthropic, codex +1',
    configured: true,
    apiKeyMode: false,
    remainingPct: null,
    updatedAt: 1,
    planType: 'oauth',
    email: '',
    configDir,
    profileDir,
    quotaStatus: 'pending',
    schedulableStatus: 'schedulable'
  };
  const runtimeAccount = {
    id: '1',
    accountId: '1',
    provider: 'opencode',
    displayName: 'OpenCode Go API (...5678)',
    apiKeyMode: false,
    authType: 'opencode-auth',
    accessToken: 'opencode-local',
    profileDir,
    configDir,
    quotaStatus: 'not_applicable',
    schedulableStatus: 'schedulable'
  };
  const state = {
    accounts: { opencode: [runtimeAccount] },
    __webUiAccountsLive: {
      records: new Map([['opencode:1', staleRecord]]),
      metadata: new Map(),
      usageSnapshots: new Map(),
      watchers: new Set(),
      webSocketWatchers: new Set(),
      webSocketServer: null,
      loadedFromDisk: true,
      hydrating: false,
      queued: false,
      lastHydratedAt: 0,
      revision: 1,
      roleSignature: '',
      fastSnapshot: {
        accounts: [staleRecord],
        hydrating: false
      },
      fastSnapshotAt: Date.now()
    }
  };
  const ctx = {
    state,
    fs,
    aiHomeDir: root,
    getToolAccountIds(provider) {
      return provider === 'opencode' ? ['1'] : [];
    },
    getToolConfigDir(_provider, accountId) {
      return path.join(root, 'profiles', 'opencode', String(accountId), '.config', 'opencode');
    },
    getProfileDir(_provider, accountId) {
      return path.join(root, 'profiles', 'opencode', String(accountId));
    },
    checkStatus() {
      return {
        configured: true,
        accountName: 'OpenCode Go API (...5678)',
        authMode: 'opencode-auth'
      };
    },
    getLastUsageProbeState() {
      return null;
    },
    getLastUsageProbeError() {
      return '';
    }
  };

  const record = await refreshLiveAccountRecord(ctx, 'opencode', '1', {
    skipUsageRefresh: true,
    skipRuntimeReload: true
  });

  assert.equal(record.displayName, 'OpenCode Go API (...5678)');
  assert.equal(record.quotaStatus, 'not_applicable');
  assert.equal(record.schedulableStatus, 'schedulable');
  assert.equal(record.remainingPct, null);
  assert.equal(record.usageSnapshot, null);
});
