const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { refreshLiveAccountRecord } = require('../lib/server/webui-account-live');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

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
        windowMinutes: 10080,
        window: '7days',
        remainingPct: 94,
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
            remainingPct: 0,
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
            remaining_pct: 0,
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

  assert.equal(record.remainingPct, 94);
  assert.equal(record.quotaStatus, 'available');
  assert.equal(record.schedulableStatus, 'schedulable');
  assert.equal(record.usageSnapshot.entries[0].remainingPct, 94);
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
  assert.equal(record.quotaStatus, 'not_applicable');
  assert.equal(record.schedulableStatus, 'blocked_by_policy');
  assert.equal(record.schedulableReason, 'agy_access_token_required');
});
