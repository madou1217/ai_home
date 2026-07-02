const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  loadCodexServerAccounts,
  loadGeminiServerAccounts,
  loadClaudeServerAccounts,
  loadAgyServerAccounts,
  loadOpenCodeServerAccounts,
  loadServerRuntimeAccounts,
  readTrustedUsageSnapshot
} = require('../lib/server/accounts');
const { createAccountStateIndex } = require('../lib/account/state-index');
const { createAccountStateService } = require('../lib/account/state-service');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

test('loadCodexServerAccounts keeps low-remaining usage accounts visible but pool-disabled', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-accounts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profilesRoot = path.join(aiHomeDir, 'profiles', 'codex');
  fs.mkdirSync(profilesRoot, { recursive: true });

  writeJson(path.join(aiHomeDir, 'usage-config.json'), { threshold_pct: 90 });

  const ids = ['1', '2'];
  ids.forEach((id) => {
    writeJson(path.join(profilesRoot, id, '.codex', 'auth.json'), {
      auth_mode: 'chatgpt',
      tokens: {
        refresh_token: `rt_${id}`,
        access_token: `at_${id}`,
        id_token: '',
        account_id: `acc_${id}`
      },
      last_refresh: '2026-03-02T00:00:00.000Z'
    });
  });

  writeJson(path.join(profilesRoot, '1', '.aih_usage.json'), {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    entries: [{ window: '5h', remainingPct: 5 }]
  });
  writeJson(path.join(profilesRoot, '2', '.aih_usage.json'), {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    entries: [{ window: '5h', remainingPct: 50 }]
  });

  const accounts = loadCodexServerAccounts({
    fs,
    aiHomeDir,
    getToolAccountIds: () => ids,
    getToolConfigDir: (_cli, id) => path.join(profilesRoot, String(id), '.codex'),
    getProfileDir: (_cli, id) => path.join(profilesRoot, String(id)),
    checkStatus: () => ({ configured: true })
  });

  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].id, '1');
  assert.equal(accounts[0].remainingPct, 5);
  assert.equal(accounts[0].schedulableStatus, 'blocked_by_policy');
  assert.equal(accounts[0].schedulableReason, 'codex_usage_below_server_threshold');
  assert.equal(accounts[1].id, '2');
  assert.equal(accounts[1].remainingPct, 50);
  assert.equal(accounts[1].schedulableStatus, 'schedulable');
});

test('loadCodexServerAccounts uses access token exp before stale auth expired field', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-accounts-expiry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profilesRoot = path.join(aiHomeDir, 'profiles', 'codex');
  const accessExpSeconds = Math.floor(Date.now() / 1000) + 3600;
  fs.mkdirSync(profilesRoot, { recursive: true });

  writeJson(path.join(profilesRoot, '7', '.codex', 'auth.json'), {
    auth_mode: 'chatgpt',
    tokens: {
      refresh_token: 'opaque-7',
      access_token: makeJwt({ exp: accessExpSeconds }),
      id_token: makeJwt({ exp: Math.floor(Date.now() / 1000) - 3600 }),
      account_id: 'acc_7'
    },
    expired: new Date(Date.now() - 3600_000).toISOString(),
    last_refresh: '2026-03-02T00:00:00.000Z'
  });

  const accounts = loadCodexServerAccounts({
    fs,
    aiHomeDir,
    getToolAccountIds: () => ['7'],
    getToolConfigDir: (_cli, id) => path.join(profilesRoot, String(id), '.codex'),
    getProfileDir: (_cli, id) => path.join(profilesRoot, String(id)),
    checkStatus: () => ({ configured: true })
  });

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].tokenExpiresAt, accessExpSeconds * 1000);
});

test('loadCodexServerAccounts keeps codex free accounts below 20% visible but pool-disabled', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-accounts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profilesRoot = path.join(aiHomeDir, 'profiles', 'codex');
  fs.mkdirSync(profilesRoot, { recursive: true });

  writeJson(path.join(aiHomeDir, 'usage-config.json'), { threshold_pct: 95 });

  writeJson(path.join(profilesRoot, '31', '.codex', 'auth.json'), {
    auth_mode: 'chatgpt',
    tokens: {
      refresh_token: 'rt_31',
      access_token: makeJwt({
        'https://api.openai.com/auth': {
          chatgpt_plan_type: 'free'
        }
      }),
      id_token: '',
      account_id: 'acc_31'
    },
    last_refresh: '2026-03-02T00:00:00.000Z'
  });
  writeJson(path.join(profilesRoot, '32', '.codex', 'auth.json'), {
    auth_mode: 'chatgpt',
    tokens: {
      refresh_token: 'rt_32',
      access_token: makeJwt({
        'https://api.openai.com/auth': {
          chatgpt_plan_type: 'team'
        }
      }),
      id_token: '',
      account_id: 'acc_32'
    },
    last_refresh: '2026-03-02T00:00:00.000Z'
  });

  writeJson(path.join(profilesRoot, '31', '.aih_usage.json'), {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    entries: [{ window: '5h', remainingPct: 19 }]
  });
  writeJson(path.join(profilesRoot, '32', '.aih_usage.json'), {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    entries: [{ window: '5h', remainingPct: 19 }]
  });

  const accounts = loadCodexServerAccounts({
    fs,
    aiHomeDir,
    getToolAccountIds: () => ['31', '32'],
    getToolConfigDir: (_cli, id) => path.join(profilesRoot, String(id), '.codex'),
    getProfileDir: (_cli, id) => path.join(profilesRoot, String(id)),
    checkStatus: () => ({ configured: true })
  });

  assert.deepEqual(accounts.map((account) => account.id), ['31', '32']);
  assert.equal(accounts[0].schedulableStatus, 'blocked_by_policy');
  assert.equal(accounts[0].schedulableReason, 'codex_free_plan_below_server_min_remaining');
  assert.equal(accounts[1].schedulableStatus, 'schedulable');
});

test('loadCodexServerAccounts keeps codex free accounts at 20% remaining in server pool', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-accounts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profilesRoot = path.join(aiHomeDir, 'profiles', 'codex');
  fs.mkdirSync(profilesRoot, { recursive: true });

  writeJson(path.join(aiHomeDir, 'usage-config.json'), { threshold_pct: 95 });
  writeJson(path.join(profilesRoot, '41', '.codex', 'auth.json'), {
    auth_mode: 'chatgpt',
    tokens: {
      refresh_token: 'rt_41',
      access_token: makeJwt({
        'https://api.openai.com/auth': {
          chatgpt_plan_type: 'free'
        }
      }),
      id_token: '',
      account_id: 'acc_41'
    },
    last_refresh: '2026-03-02T00:00:00.000Z'
  });
  writeJson(path.join(profilesRoot, '41', '.aih_usage.json'), {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    entries: [{ window: '5h', remainingPct: 20 }]
  });

  const accounts = loadCodexServerAccounts({
    fs,
    aiHomeDir,
    getToolAccountIds: () => ['41'],
    getToolConfigDir: (_cli, id) => path.join(profilesRoot, String(id), '.codex'),
    getProfileDir: (_cli, id) => path.join(profilesRoot, String(id)),
    checkStatus: () => ({ configured: true })
  });

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, '41');
  assert.equal(accounts[0].remainingPct, 20);
});

test('readTrustedUsageSnapshot synthesizes codex account metadata snapshot when usage cache is missing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-accounts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profilesRoot = path.join(aiHomeDir, 'profiles', 'codex');
  fs.mkdirSync(profilesRoot, { recursive: true });

  writeJson(path.join(profilesRoot, '51', '.codex', 'auth.json'), {
    auth_mode: 'chatgpt',
    organization_id: 'org_51',
    tokens: {
      refresh_token: 'rt_51',
      access_token: makeJwt({
        client_id: 'app_51',
        'https://api.openai.com/auth': {
          chatgpt_plan_type: 'team',
          chatgpt_account_id: 'acc_51'
        },
        'https://api.openai.com/profile': {
          email: 'snapshot@example.com'
        }
      }),
      id_token: '',
      account_id: 'acc_51'
    }
  });

  const snapshot = readTrustedUsageSnapshot({
    fs,
    aiHomeDir,
    getProfileDir: (_cli, id) => path.join(profilesRoot, String(id))
  }, 'codex', '51');

  assert.ok(snapshot);
  assert.equal(snapshot.kind, 'codex_oauth_status');
  assert.equal(snapshot.fallbackSource, 'auth_json');
  assert.equal(snapshot.account.planType, 'team');
  assert.equal(snapshot.account.email, 'snapshot@example.com');
  assert.equal(snapshot.account.accountId, 'acc_51');
  assert.equal(snapshot.account.organizationId, 'org_51');
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.entries[0].bucket, 'account');
  assert.equal(snapshot.entries[0].remainingPct, null);
});

test('readTrustedUsageSnapshot repairs stale codex account_read identity from auth metadata', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-accounts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profilesRoot = path.join(aiHomeDir, 'profiles', 'codex');
  fs.mkdirSync(profilesRoot, { recursive: true });

  writeJson(path.join(profilesRoot, '52', '.codex', 'auth.json'), {
    auth_mode: 'chatgpt',
    tokens: {
      refresh_token: 'rt_52',
      access_token: makeJwt({
        client_id: 'app_52',
        'https://api.openai.com/auth': {
          chatgpt_plan_type: 'team',
          chatgpt_account_id: 'acc_real'
        },
        'https://api.openai.com/profile': {
          email: 'real-team@example.com'
        }
      }),
      id_token: '',
      account_id: 'acc_real'
    }
  });
  writeJson(path.join(profilesRoot, '52', '.aih_usage.json'), {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    fallbackSource: 'account_read',
    account: {
      planType: 'team',
      email: 'wrong-team@example.com',
      accountId: 'acc_wrong',
      organizationId: ''
    },
    entries: [{
      bucket: 'account',
      windowMinutes: 0,
      window: 'plan:team wrong-team@example.com',
      remainingPct: null,
      resetIn: 'unknown'
    }]
  });

  const snapshot = readTrustedUsageSnapshot({
    fs,
    aiHomeDir,
    getProfileDir: (_cli, id) => path.join(profilesRoot, String(id))
  }, 'codex', '52');

  assert.equal(snapshot.account.planType, 'team');
  assert.equal(snapshot.account.email, 'real-team@example.com');
  assert.equal(snapshot.account.accountId, 'acc_real');
});

test('readTrustedUsageSnapshot reads trusted AGY Code Assist quota snapshots', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-agy-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profilesRoot = path.join(aiHomeDir, 'profiles', 'agy');
  fs.mkdirSync(profilesRoot, { recursive: true });
  writeJson(path.join(profilesRoot, '7', '.aih_usage.json'), {
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
    models: [{
      model: 'claude-sonnet-4-6',
      remainingPct: 12,
      resetIn: '1h',
      resetAtMs: Date.now() + 3600000
    }]
  });

  const snapshot = readTrustedUsageSnapshot({
    fs,
    aiHomeDir,
    getProfileDir: (_cli, id) => path.join(profilesRoot, String(id))
  }, 'agy', '7');

  assert.ok(snapshot);
  assert.equal(snapshot.kind, 'agy_code_assist_quota');
  assert.equal(snapshot.account.email, 'agy@example.com');
  assert.equal(snapshot.models[0].model, 'claude-sonnet-4-6');
  assert.equal(snapshot.models[0].remainingPct, 12);
});

test('loadCodexServerAccounts includes api key mode accounts in runtime pool', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-accounts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profilesRoot = path.join(aiHomeDir, 'profiles', 'codex');
  fs.mkdirSync(profilesRoot, { recursive: true });

  writeJson(path.join(profilesRoot, '10000', '.codex', 'auth.json'), {
    OPENAI_API_KEY: 'sk-test-runtime'
  });
  writeJson(path.join(profilesRoot, '10000', '.aih_env.json'), {
    OPENAI_API_KEY: 'sk-test-runtime',
    OPENAI_BASE_URL: 'https://sub.devbin.de'
  });

  const accounts = loadCodexServerAccounts({
    fs,
    aiHomeDir,
    getToolAccountIds: () => ['10000'],
    getToolConfigDir: (_cli, id) => path.join(profilesRoot, String(id), '.codex'),
    getProfileDir: (_cli, id) => path.join(profilesRoot, String(id)),
    checkStatus: () => ({ configured: true })
  });

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, '10000');
  assert.equal(accounts[0].apiKeyMode, true);
  assert.equal(accounts[0].authType, 'api-key');
  assert.equal(accounts[0].accessToken, 'sk-test-runtime');
  assert.equal(accounts[0].openaiBaseUrl, 'https://sub.devbin.de');
});

test('loadCodexServerAccounts keeps indexed api key accounts alongside usage candidates', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-accounts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profilesRoot = path.join(aiHomeDir, 'profiles', 'codex');
  fs.mkdirSync(profilesRoot, { recursive: true });

  writeJson(path.join(profilesRoot, '1', '.codex', 'auth.json'), {
    auth_mode: 'chatgpt',
    tokens: {
      refresh_token: 'rt_1',
      access_token: 'at_1',
      id_token: '',
      account_id: 'acc_1'
    }
  });
  writeJson(path.join(profilesRoot, '1', '.aih_usage.json'), {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    entries: [{ window: '5h', remainingPct: 64 }]
  });
  writeJson(path.join(profilesRoot, '10014', '.codex', 'auth.json'), {
    OPENAI_API_KEY: 'sk-10014'
  });
  writeJson(path.join(profilesRoot, '10014', '.aih_env.json'), {
    OPENAI_API_KEY: 'sk-10014',
    OPENAI_BASE_URL: 'https://api.example.com/v1'
  });

  const accounts = loadCodexServerAccounts({
    fs,
    aiHomeDir,
    getToolAccountIds: () => ['1', '10014'],
    listUsageCandidateIds: () => ['1'],
    listConfiguredIds: () => ['1', '10014'],
    getToolConfigDir: (_cli, id) => path.join(profilesRoot, String(id), '.codex'),
    getProfileDir: (_cli, id) => path.join(profilesRoot, String(id)),
    checkStatus: () => ({ configured: true }),
    serverPort: 8317
  });

  assert.deepEqual(accounts.map((account) => account.id), ['1', '10014']);
  assert.equal(accounts[1].apiKeyMode, true);
  assert.equal(accounts[1].remainingPct, null);
  assert.equal(accounts[1].schedulableStatus, 'schedulable');
});

test('loadCodexServerAccounts prefers account api key config over depleted oauth snapshot', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-accounts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profilesRoot = path.join(aiHomeDir, 'profiles', 'codex');
  fs.mkdirSync(profilesRoot, { recursive: true });

  writeJson(path.join(aiHomeDir, 'usage-config.json'), { threshold_pct: 90 });
  writeJson(path.join(profilesRoot, '10', '.codex', 'auth.json'), {
    auth_mode: 'chatgpt',
    tokens: {
      refresh_token: 'rt_10',
      access_token: 'at_10',
      id_token: '',
      account_id: 'acc_10'
    }
  });
  writeJson(path.join(profilesRoot, '10', '.aih_env.json'), {
    OPENAI_API_KEY: 'sk-live-10',
    OPENAI_BASE_URL: 'https://proxy.example.com/v1'
  });
  writeJson(path.join(profilesRoot, '10', '.aih_usage.json'), {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    entries: [{ window: '5h', remainingPct: 0 }]
  });

  const accounts = loadCodexServerAccounts({
    fs,
    aiHomeDir,
    getToolAccountIds: () => ['10'],
    getToolConfigDir: (_cli, id) => path.join(profilesRoot, String(id), '.codex'),
    getProfileDir: (_cli, id) => path.join(profilesRoot, String(id)),
    checkStatus: () => ({ configured: true }),
    serverPort: 8317
  });

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, '10');
  assert.equal(accounts[0].apiKeyMode, true);
  assert.equal(accounts[0].authType, 'api-key');
  assert.equal(accounts[0].accessToken, 'sk-live-10');
  assert.equal(accounts[0].openaiBaseUrl, 'https://proxy.example.com/v1');
  assert.equal(accounts[0].remainingPct, null);
});

test('loadCodexServerAccounts filters api key accounts that point back to current server port', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-accounts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profilesRoot = path.join(aiHomeDir, 'profiles', 'codex');
  fs.mkdirSync(profilesRoot, { recursive: true });

  writeJson(path.join(profilesRoot, '10', '.codex', 'auth.json'), {
    OPENAI_API_KEY: 'dummy'
  });
  writeJson(path.join(profilesRoot, '10', '.aih_env.json'), {
    OPENAI_API_KEY: 'dummy',
    OPENAI_BASE_URL: 'http://localhost:8317/v1'
  });

  const accounts = loadCodexServerAccounts({
    fs,
    aiHomeDir,
    getToolAccountIds: () => ['10'],
    getToolConfigDir: (_cli, id) => path.join(profilesRoot, String(id), '.codex'),
    getProfileDir: (_cli, id) => path.join(profilesRoot, String(id)),
    checkStatus: () => ({ configured: true }),
    serverPort: 8317
  });

  assert.deepEqual(accounts, []);
});

test('loadCodexServerAccounts keeps external localhost api key accounts with different ports', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-accounts-local-proxy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profilesRoot = path.join(aiHomeDir, 'profiles', 'codex');
  fs.mkdirSync(profilesRoot, { recursive: true });

  writeJson(path.join(profilesRoot, '10', '.aih_env.json'), {
    OPENAI_API_KEY: 'self-loop',
    OPENAI_BASE_URL: 'http://127.0.0.1:8317/v1'
  });
  writeJson(path.join(profilesRoot, '11', '.aih_env.json'), {
    OPENAI_API_KEY: 'external-local-proxy',
    OPENAI_BASE_URL: 'http://127.0.0.1:9090/v1'
  });

  const accounts = loadCodexServerAccounts({
    fs,
    aiHomeDir,
    getToolAccountIds: () => ['10', '11'],
    getToolConfigDir: (_cli, id) => path.join(profilesRoot, String(id), '.codex'),
    getProfileDir: (_cli, id) => path.join(profilesRoot, String(id)),
    checkStatus: () => ({ configured: true }),
    serverPort: 8317
  });

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, '11');
  assert.equal(accounts[0].openaiBaseUrl, 'http://127.0.0.1:9090/v1');
  assert.equal(accounts[0].displayName, '127.0.0.1:9090');
});

test('loadGeminiServerAccounts marks env api-key accounts explicitly', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-gemini-api-key-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const profileDir = path.join(root, 'profiles', 'gemini', '3');
  fs.mkdirSync(path.join(profileDir, '.gemini'), { recursive: true });
  writeJson(path.join(profileDir, '.aih_env.json'), {
    GEMINI_API_KEY: 'gemini-key'
  });

  const accounts = loadGeminiServerAccounts({
    fs,
    getToolAccountIds: () => ['3'],
    getProfileDir: () => profileDir,
    checkStatus: () => ({ configured: true, accountName: 'API Key: gem...ikey' })
  });

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].apiKeyMode, true);
  assert.equal(accounts[0].authType, 'api-key');
  assert.equal(accounts[0].accessToken, 'gemini-key');
});

test('loadGeminiServerAccounts reads Code Assist overage strategy from settings', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-gemini-billing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const profileDir = path.join(root, 'profiles', 'gemini', '1');
  const configDir = path.join(profileDir, '.gemini');
  fs.mkdirSync(configDir, { recursive: true });
  writeJson(path.join(configDir, 'settings.json'), {
    security: { auth: { selectedType: 'oauth-personal' } },
    billing: { overageStrategy: 'never' }
  });
  writeJson(path.join(configDir, 'oauth_creds.json'), {
    access_token: 'gemini-token'
  });

  const accounts = loadGeminiServerAccounts({
    fs,
    getToolAccountIds: () => ['1'],
    getProfileDir: () => profileDir,
    checkStatus: () => ({ configured: true, accountName: 'user@example.com' })
  });

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].authType, 'oauth-personal');
  assert.equal(accounts[0].geminiCodeAssistOverageStrategy, 'never');
});

test('loadClaudeServerAccounts marks env api-key accounts explicitly', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-claude-api-key-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const profileDir = path.join(root, 'profiles', 'claude', '3');
  const configDir = path.join(profileDir, '.claude');
  fs.mkdirSync(configDir, { recursive: true });
  writeJson(path.join(profileDir, '.aih_env.json'), {
    ANTHROPIC_API_KEY: 'claude-key',
    ANTHROPIC_BASE_URL: 'https://dashscope.aliyuncs.com/apps/anthropic'
  });

  const accounts = loadClaudeServerAccounts({
    fs,
    getToolAccountIds: () => ['3'],
    getProfileDir: () => profileDir,
    getToolConfigDir: () => configDir,
    checkStatus: () => ({ configured: true, accountName: 'API Key: cla...-key' })
  });

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].apiKeyMode, true);
  assert.equal(accounts[0].authType, 'api-key');
  assert.equal(accounts[0].accessToken, 'claude-key');
  assert.equal(accounts[0].baseUrl, 'https://dashscope.aliyuncs.com/apps/anthropic');
});

test('loadClaudeServerAccounts marks env auth-token accounts explicitly', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-claude-auth-token-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const profileDir = path.join(root, 'profiles', 'claude', '6');
  const configDir = path.join(profileDir, '.claude');
  fs.mkdirSync(configDir, { recursive: true });
  writeJson(path.join(profileDir, '.aih_env.json'), {
    AIH_CLAUDE_CREDENTIAL_TYPE: 'auth-token',
    ANTHROPIC_AUTH_TOKEN: 'claude-code-token',
    ANTHROPIC_BASE_URL: 'https://anyrouter.top'
  });

  const accounts = loadClaudeServerAccounts({
    fs,
    getToolAccountIds: () => ['6'],
    getProfileDir: () => profileDir,
    getToolConfigDir: () => configDir,
    checkStatus: () => ({ configured: true, accountName: 'Auth Token: cla...oken' })
  });

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].apiKeyMode, true);
  assert.equal(accounts[0].authType, 'auth-token');
  assert.equal(accounts[0].credentialType, 'auth-token');
  assert.equal(accounts[0].accessToken, 'claude-code-token');
  assert.equal(accounts[0].baseUrl, 'https://anyrouter.top');
});

test('loadServerRuntimeAccounts preserves claude auth-token identity in runtime state', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-claude-auth-token-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profileDir = path.join(aiHomeDir, 'profiles', 'claude', '6');
  const configDir = path.join(profileDir, '.claude');
  fs.mkdirSync(configDir, { recursive: true });
  writeJson(path.join(profileDir, '.aih_env.json'), {
    AIH_CLAUDE_CREDENTIAL_TYPE: 'auth-token',
    ANTHROPIC_AUTH_TOKEN: 'claude-code-token',
    ANTHROPIC_BASE_URL: 'https://anyrouter.top'
  });

  const accountStateIndex = createAccountStateIndex({ aiHomeDir, fs });
  accountStateIndex.upsertRuntimeState('claude', '6', {
    cooldownUntil: Date.now() + 10 * 60 * 1000,
    authInvalidUntil: Date.now() + 10 * 60 * 1000,
    lastFailureKind: 'auth_invalid',
    lastFailureReason: 'stale_oauth_block'
  }, {
    configured: true,
    apiKeyMode: false,
    authMode: 'oauth',
    displayName: 'Claude OAuth'
  });
  const accountStateService = createAccountStateService({ accountStateIndex });

  const accounts = loadServerRuntimeAccounts({
    fs,
    aiHomeDir,
    accountStateIndex,
    accountStateService,
    getToolAccountIds: (provider) => provider === 'claude' ? ['6'] : [],
    getProfileDir: (provider, id) => path.join(aiHomeDir, 'profiles', provider, String(id)),
    getToolConfigDir: (provider, id) => path.join(aiHomeDir, 'profiles', provider, String(id), `.${provider}`),
    checkStatus: () => ({ configured: true, accountName: 'Auth Token: cla...oken' }),
    serverPort: 8317
  });

  assert.equal(accounts.claude.length, 1);
  assert.equal(accounts.claude[0].authType, 'auth-token');
  assert.equal(accounts.claude[0].uniqueKey, 'auth_token:claude:https://anyrouter.top');

  const row = accountStateIndex.getAccountState('claude', '6');
  assert.equal(row.api_key_mode, true);
  assert.equal(row.auth_mode, 'auth-token');
  assert.equal(row.runtime_state, null);
});

test('loadClaudeServerAccounts filters api key accounts that point back to current server port', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-claude-self-relay-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const profileDir = path.join(root, 'profiles', 'claude', '1');
  const configDir = path.join(profileDir, '.claude');
  fs.mkdirSync(configDir, { recursive: true });
  writeJson(path.join(profileDir, '.aih_env.json'), {
    ANTHROPIC_API_KEY: 'dummy',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317/v1'
  });

  const accounts = loadClaudeServerAccounts({
    fs,
    getToolAccountIds: () => ['1'],
    getProfileDir: () => profileDir,
    getToolConfigDir: () => configDir,
    checkStatus: () => ({ configured: true, accountName: 'API Key: dummy' }),
    serverPort: 8317
  });

  assert.deepEqual(accounts, []);
});

test('loadServerRuntimeAccounts keeps codex api key candidates and still blocks self relay loopback', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profilesRoot = path.join(aiHomeDir, 'profiles', 'codex');
  fs.mkdirSync(profilesRoot, { recursive: true });

  writeJson(path.join(profilesRoot, '10015', '.codex', 'auth.json'), {
    auth_mode: 'chatgpt',
    tokens: {
      refresh_token: 'rt_10015',
      access_token: 'at_10015',
      id_token: '',
      account_id: 'acc_10015'
    }
  });
  writeJson(path.join(profilesRoot, '10015', '.aih_usage.json'), {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    entries: [{ window: '5h', remainingPct: 55 }]
  });
  writeJson(path.join(profilesRoot, '10', '.codex', 'auth.json'), {
    OPENAI_API_KEY: 'sk-self-relay'
  });
  writeJson(path.join(profilesRoot, '10', '.aih_env.json'), {
    OPENAI_API_KEY: 'sk-self-relay',
    OPENAI_BASE_URL: 'http://127.0.0.1:8317/v1'
  });
  writeJson(path.join(profilesRoot, '10014', '.codex', 'auth.json'), {
    OPENAI_API_KEY: 'sk-external-relay'
  });
  writeJson(path.join(profilesRoot, '10014', '.aih_env.json'), {
    OPENAI_API_KEY: 'sk-external-relay',
    OPENAI_BASE_URL: 'https://api.example.com/v1'
  });

  const accountStateIndex = createAccountStateIndex({ aiHomeDir, fs });
  accountStateIndex.upsertAccountState('codex', '10', { configured: true, apiKeyMode: true, remainingPct: null });
  accountStateIndex.upsertAccountState('codex', '10014', { configured: true, apiKeyMode: true, remainingPct: null });
  accountStateIndex.upsertAccountState('codex', '10015', { configured: true, apiKeyMode: false, remainingPct: 55 });

  const accounts = loadServerRuntimeAccounts({
    fs,
    aiHomeDir,
    accountStateIndex,
    getToolAccountIds: () => ['10', '10014', '10015'],
    listUsageCandidateIds: () => ['10015'],
    listConfiguredIds: () => ['10', '10014', '10015'],
    getToolConfigDir: (_cli, id) => path.join(profilesRoot, String(id), '.codex'),
    getProfileDir: (_cli, id) => path.join(profilesRoot, String(id)),
    checkStatus: () => ({ configured: true }),
    serverPort: 8317
  });

  assert.deepEqual(accounts.codex.map((account) => account.id), ['10015', '10014']);
  assert.equal(accounts.codex[0].apiKeyMode, false);
  assert.equal(accounts.codex[1].apiKeyMode, true);
});

test('loadCodexServerAccounts keeps codex team fallback accounts visible but pool-disabled', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-accounts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profilesRoot = path.join(aiHomeDir, 'profiles', 'codex');
  fs.mkdirSync(profilesRoot, { recursive: true });

  ['5', '6'].forEach((id) => {
    writeJson(path.join(profilesRoot, id, '.codex', 'auth.json'), {
      auth_mode: 'chatgpt',
      tokens: {
        refresh_token: `rt_${id}`,
        access_token: `at_${id}`,
        id_token: '',
        account_id: `acc_${id}`
      },
      last_refresh: '2026-03-02T00:00:00.000Z'
    });
  });

  writeJson(path.join(profilesRoot, '5', '.aih_usage.json'), {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    fallbackSource: 'account_read',
    account: {
      planType: 'team',
      email: 'team-bad@example.com'
    },
    entries: [{
      bucket: 'account',
      windowMinutes: 0,
      window: 'plan:team team-bad@example.com',
      remainingPct: null,
      resetIn: 'unknown',
      resetAtMs: 0
    }]
  });
  writeJson(path.join(profilesRoot, '6', '.aih_usage.json'), {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    entries: [{ window: '5h', remainingPct: 50 }]
  });

  const accounts = loadCodexServerAccounts({
    fs,
    aiHomeDir,
    getToolAccountIds: () => ['5', '6'],
    getToolConfigDir: (_cli, id) => path.join(profilesRoot, String(id), '.codex'),
    getProfileDir: (_cli, id) => path.join(profilesRoot, String(id)),
    checkStatus: () => ({ configured: true })
  });

  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].id, '5');
  // Team 账号没有额度数据时，标记为 pending 而不是 blocked_by_policy
  // 这样账号可以进入账号池，等待后续刷新获取额度数据
  assert.equal(accounts[0].schedulableStatus, 'schedulable');
  assert.equal(accounts[0].quotaStatus, 'pending');
  assert.equal(accounts[0].quotaReason, 'codex_team_plan_pending_rate_limits');
  assert.equal(accounts[1].id, '6');
  assert.equal(accounts[1].schedulableStatus, 'schedulable');
});

test('loadCodexServerAccounts keeps codex free fallback accounts visible but pool-disabled', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-accounts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profilesRoot = path.join(aiHomeDir, 'profiles', 'codex');
  fs.mkdirSync(profilesRoot, { recursive: true });

  writeJson(path.join(profilesRoot, '7', '.codex', 'auth.json'), {
    auth_mode: 'chatgpt',
    tokens: {
      refresh_token: 'rt_7',
      access_token: 'at_7',
      id_token: '',
      account_id: 'acc_7'
    },
    last_refresh: '2026-03-02T00:00:00.000Z'
  });
  writeJson(path.join(profilesRoot, '7', '.aih_usage.json'), {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    fallbackSource: 'account_read',
    account: {
      planType: 'free',
      email: 'free-bad@example.com'
    },
    entries: [{
      bucket: 'account',
      windowMinutes: 0,
      window: 'plan:free free-bad@example.com',
      remainingPct: null,
      resetIn: 'unknown',
      resetAtMs: 0
    }]
  });

  const accounts = loadCodexServerAccounts({
    fs,
    aiHomeDir,
    getToolAccountIds: () => ['7'],
    getToolConfigDir: (_cli, id) => path.join(profilesRoot, String(id), '.codex'),
    getProfileDir: (_cli, id) => path.join(profilesRoot, String(id)),
    checkStatus: () => ({ configured: true })
  });

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, '7');
  // Free 账号没有额度数据时，标记为 pending 而不是 blocked_by_policy
  // 这样账号可以进入账号池，等待后续刷新获取额度数据
  assert.equal(accounts[0].schedulableStatus, 'schedulable');
  assert.equal(accounts[0].quotaStatus, 'pending');
  assert.equal(accounts[0].quotaReason, 'codex_free_plan_pending_rate_limits');
});

test('loadServerRuntimeAccounts restores persisted auth_invalid runtime state from account index', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-runtime-restore-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profilesRoot = path.join(aiHomeDir, 'profiles', 'codex');
  fs.mkdirSync(profilesRoot, { recursive: true });

  writeJson(path.join(profilesRoot, '3', '.codex', 'auth.json'), {
    auth_mode: 'chatgpt',
    tokens: {
      refresh_token: 'rt_3',
      access_token: 'at_3',
      id_token: '',
      account_id: 'acc_3'
    },
    last_refresh: '2026-03-02T00:00:00.000Z'
  });

  const accountStateIndex = createAccountStateIndex({ aiHomeDir, fs });
  accountStateIndex.upsertRuntimeState('codex', '3', {
    authInvalidUntil: Date.now() + 10 * 60 * 1000,
    lastFailureKind: 'auth_invalid',
    lastFailureReason: 'upstream_401'
  }, {
    configured: true,
    apiKeyMode: false,
    displayName: 'user@example.com'
  });

  const accounts = loadServerRuntimeAccounts({
    fs,
    aiHomeDir,
    accountStateIndex,
    getToolAccountIds: () => ['3'],
    getToolConfigDir: (_cli, id) => path.join(profilesRoot, String(id), '.codex'),
    getProfileDir: (_cli, id) => path.join(profilesRoot, String(id)),
    checkStatus: () => ({ configured: true })
  });

  assert.equal(accounts.codex.length, 1);
  assert.equal(accounts.codex[0].lastFailureKind, 'auth_invalid');
  assert.equal(accounts.codex[0].lastFailureReason, 'upstream_401');
  assert.ok(Number(accounts.codex[0].authInvalidUntil) > Date.now());
});

test('loadServerRuntimeAccounts migrates stale non-api-key auth_invalid block for configured codex api key accounts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-runtime-api-key-migrate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profilesRoot = path.join(aiHomeDir, 'profiles', 'codex');
  fs.mkdirSync(profilesRoot, { recursive: true });

  writeJson(path.join(profilesRoot, '1', '.aih_env.json'), {
    OPENAI_API_KEY: 'sk-live-1',
    OPENAI_BASE_URL: 'https://www.yeslaoban.com/llm/api/v1'
  });

  const accountStateIndex = createAccountStateIndex({ aiHomeDir, fs });
  accountStateIndex.upsertRuntimeState('codex', '1', {
    cooldownUntil: Date.now() + 10 * 60 * 1000,
    authInvalidUntil: Date.now() + 10 * 60 * 1000,
    lastFailureKind: 'auth_invalid',
    lastFailureReason: 'auth_invalid_reauth_required',
    lastError: 'auth_invalid_reauth_required',
    consecutiveFailures: 1,
    failCount: 1
  }, {
    configured: true,
    apiKeyMode: false,
    displayName: 'yeslaoban.com'
  });
  const accountStateService = createAccountStateService({
    accountStateIndex
  });

  const accounts = loadServerRuntimeAccounts({
    fs,
    aiHomeDir,
    accountStateIndex,
    accountStateService,
    getToolAccountIds: () => ['1'],
    getToolConfigDir: (_cli, id) => path.join(profilesRoot, String(id), '.codex'),
    getProfileDir: (_cli, id) => path.join(profilesRoot, String(id)),
    checkStatus: () => ({ configured: true }),
    serverPort: 8317
  });

  assert.equal(accounts.codex.length, 1);
  assert.equal(accounts.codex[0].apiKeyMode, true);
  assert.equal(accounts.codex[0].lastFailureKind, '');
  assert.equal(accounts.codex[0].authInvalidUntil, 0);
  assert.equal(accounts.codex[0].schedulableStatus, 'schedulable');

  const row = accountStateIndex.getAccountState('codex', '1');
  assert.equal(row.api_key_mode, true);
  assert.equal(row.auth_mode, 'api-key');
  assert.equal(row.runtime_state, null);
  assert.equal(row.display_name, 'yeslaoban.com');
});

test('loadServerRuntimeAccounts migrates api-key rows missing auth_mode while auth_invalid block remains', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-runtime-api-key-partial-migrate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profilesRoot = path.join(aiHomeDir, 'profiles', 'codex');
  fs.mkdirSync(profilesRoot, { recursive: true });

  writeJson(path.join(profilesRoot, '1', '.aih_env.json'), {
    OPENAI_API_KEY: 'sk-live-1',
    OPENAI_BASE_URL: 'https://proxy.example.com/v1'
  });

  const accountStateIndex = createAccountStateIndex({ aiHomeDir, fs });
  accountStateIndex.upsertRuntimeState('codex', '1', {
    cooldownUntil: Date.now() + 10 * 60 * 1000,
    authInvalidUntil: Date.now() + 10 * 60 * 1000,
    lastFailureKind: 'auth_invalid',
    lastFailureReason: 'auth_invalid_reauth_required',
    lastError: 'auth_invalid_reauth_required',
    consecutiveFailures: 1,
    failCount: 1
  }, {
    configured: true,
    apiKeyMode: true,
    displayName: 'proxy.example.com'
  });
  const accountStateService = createAccountStateService({
    accountStateIndex
  });

  const accounts = loadServerRuntimeAccounts({
    fs,
    aiHomeDir,
    accountStateIndex,
    accountStateService,
    getToolAccountIds: () => ['1'],
    getToolConfigDir: (_cli, id) => path.join(profilesRoot, String(id), '.codex'),
    getProfileDir: (_cli, id) => path.join(profilesRoot, String(id)),
    checkStatus: () => ({ configured: true }),
    serverPort: 8317
  });

  assert.equal(accounts.codex[0].lastFailureKind, '');
  const row = accountStateIndex.getAccountState('codex', '1');
  assert.equal(row.api_key_mode, true);
  assert.equal(row.auth_mode, 'api-key');
  assert.equal(row.runtime_state, null);
});

test('loadServerRuntimeAccounts keeps persisted auth_invalid for codex api key accounts already migrated to api-key mode', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-runtime-api-key-auth-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profilesRoot = path.join(aiHomeDir, 'profiles', 'codex');
  fs.mkdirSync(profilesRoot, { recursive: true });

  writeJson(path.join(profilesRoot, '1', '.aih_env.json'), {
    OPENAI_API_KEY: 'sk-live-1',
    OPENAI_BASE_URL: 'https://proxy.example.com/v1'
  });

  const accountStateIndex = createAccountStateIndex({ aiHomeDir, fs });
  accountStateIndex.upsertRuntimeState('codex', '1', {
    cooldownUntil: Date.now() + 10 * 60 * 1000,
    authInvalidUntil: Date.now() + 10 * 60 * 1000,
    lastFailureKind: 'auth_invalid',
    lastFailureReason: 'auth_invalid_reauth_required',
    lastError: 'auth_invalid_reauth_required',
    consecutiveFailures: 1,
    failCount: 1
  }, {
    configured: true,
    apiKeyMode: true,
    authMode: 'api-key',
    displayName: 'proxy.example.com'
  });
  const accountStateService = createAccountStateService({
    accountStateIndex
  });

  const accounts = loadServerRuntimeAccounts({
    fs,
    aiHomeDir,
    accountStateIndex,
    accountStateService,
    getToolAccountIds: () => ['1'],
    getToolConfigDir: (_cli, id) => path.join(profilesRoot, String(id), '.codex'),
    getProfileDir: (_cli, id) => path.join(profilesRoot, String(id)),
    checkStatus: () => ({ configured: true }),
    serverPort: 8317
  });

  assert.equal(accounts.codex.length, 1);
  assert.equal(accounts.codex[0].lastFailureKind, 'auth_invalid');
  assert.equal(accounts.codex[0].lastFailureReason, 'auth_invalid_reauth_required');
  assert.ok(Number(accounts.codex[0].authInvalidUntil) > Date.now());
  assert.deepEqual(accountStateIndex.getAccountState('codex', '1').runtime_state.lastFailureKind, 'auth_invalid');
});

test('loadServerRuntimeAccounts excludes disabled accounts from server pool', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-runtime-disabled-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profilesRoot = path.join(aiHomeDir, 'profiles', 'claude');
  fs.mkdirSync(profilesRoot, { recursive: true });
  writeJson(path.join(profilesRoot, '11', '.claude', '.credentials.json'), {
    claudeAiOauth: { accessToken: 'token-11' }
  });
  writeJson(path.join(profilesRoot, '12', '.claude', '.credentials.json'), {
    claudeAiOauth: { accessToken: 'token-12' }
  });

  const accountStateIndex = createAccountStateIndex({ aiHomeDir, fs });
  accountStateIndex.upsertAccountState('claude', '11', { status: 'down', configured: true });
  accountStateIndex.upsertAccountState('claude', '12', { configured: true });

  const accounts = loadServerRuntimeAccounts({
    fs,
    aiHomeDir,
    accountStateIndex,
    getToolAccountIds: () => ['11', '12'],
    getToolConfigDir: (_cli, id) => path.join(profilesRoot, String(id), '.claude'),
    getProfileDir: (_cli, id) => path.join(profilesRoot, String(id)),
    checkStatus: () => ({ configured: true, accountName: 'user@example.com' })
  });

  assert.deepEqual(accounts.claude.map((account) => account.id), ['12']);
});

test('loadServerRuntimeAccounts excludes accounts disabled by profile status file even when state row is missing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-runtime-status-file-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profilesRoot = path.join(aiHomeDir, 'profiles', 'codex');
  fs.mkdirSync(profilesRoot, { recursive: true });
  writeJson(path.join(profilesRoot, '21', '.codex', 'auth.json'), {
    auth_mode: 'chatgpt',
    tokens: {
      refresh_token: 'rt_21',
      access_token: 'at_21',
      id_token: '',
      account_id: 'acc_21'
    }
  });
  writeJson(path.join(profilesRoot, '22', '.codex', 'auth.json'), {
    auth_mode: 'chatgpt',
    tokens: {
      refresh_token: 'rt_22',
      access_token: 'at_22',
      id_token: '',
      account_id: 'acc_22'
    }
  });
  fs.writeFileSync(path.join(profilesRoot, '21', '.aih_status'), 'down\n', 'utf8');

  const accountStateIndex = createAccountStateIndex({ aiHomeDir, fs });

  const accounts = loadServerRuntimeAccounts({
    fs,
    aiHomeDir,
    accountStateIndex,
    getToolAccountIds: () => ['21', '22'],
    getToolConfigDir: (_cli, id) => path.join(profilesRoot, String(id), '.codex'),
    getProfileDir: (_cli, id) => path.join(profilesRoot, String(id)),
    checkStatus: () => ({ configured: true })
  });

  assert.deepEqual(accounts.codex.map((account) => account.id), ['22']);
});

test('loadAgyServerAccounts includes explicit access-token accounts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-agy-token-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profilesRoot = path.join(aiHomeDir, 'profiles', 'agy');
  const profileDir = path.join(profilesRoot, '1');
  const configDir = path.join(profileDir, '.gemini', 'antigravity-cli');
  fs.mkdirSync(path.join(configDir, 'log'), { recursive: true });
  writeJson(path.join(profileDir, '.aih_env.json'), {
    AGY_ACCESS_TOKEN: 'agy-token',
    AGY_BASE_URL: 'https://daily-cloudcode-pa.googleapis.com/v1internal'
  });
  fs.writeFileSync(path.join(configDir, 'log', 'latest.log'), 'OAuth: authenticated successfully as agy@example.com\n', 'utf8');

  const accounts = loadAgyServerAccounts({
    fs,
    getToolAccountIds: () => ['1'],
    getToolConfigDir: (_cli, id) => path.join(profilesRoot, String(id), '.gemini', 'antigravity-cli'),
    getProfileDir: (_cli, id) => path.join(profilesRoot, String(id)),
    checkStatus: (_cli, pDir) => ({
      configured: true,
      accountName: pDir.endsWith(path.join('agy', '1')) ? 'agy@example.com' : 'Unknown'
    })
  });

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].provider, 'agy');
  assert.equal(accounts[0].authType, 'oauth-personal');
  assert.equal(accounts[0].accessToken, 'agy-token');
  assert.equal(accounts[0].email, 'agy@example.com');
});

test('loadAgyServerAccounts merges indexed ids with filesystem profile ids', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-agy-merge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profilesRoot = path.join(aiHomeDir, 'profiles', 'agy');
  ['1', '2'].forEach((id) => {
    const configDir = path.join(profilesRoot, id, '.gemini', 'antigravity-cli');
    fs.mkdirSync(configDir, { recursive: true });
    writeJson(path.join(configDir, 'antigravity-oauth-token'), {
      token: {
        access_token: `agy-token-${id}`,
        refresh_token: `agy-refresh-${id}`
      }
    });
  });

  const accounts = loadAgyServerAccounts({
    fs,
    getToolAccountIds: () => ['1', '2'],
    listConfiguredIds: () => ['2'],
    getToolConfigDir: (_cli, id) => path.join(profilesRoot, String(id), '.gemini', 'antigravity-cli'),
    getProfileDir: (_cli, id) => path.join(profilesRoot, String(id)),
    checkStatus: (_cli, pDir) => {
      const id = path.basename(pDir);
      return { configured: true, accountName: `agy-${id}@example.com` };
    }
  });

  assert.deepEqual(accounts.map((account) => account.id), ['2', '1']);
  assert.deepEqual(accounts.map((account) => account.accessToken), ['agy-token-2', 'agy-token-1']);
});

test('loadAgyServerAccounts reads model-level quota snapshot into available models', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-agy-quota-models-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profilesRoot = path.join(aiHomeDir, 'profiles', 'agy');
  const profileDir = path.join(profilesRoot, '1');
  const configDir = path.join(profileDir, '.gemini', 'antigravity-cli');
  fs.mkdirSync(configDir, { recursive: true });
  writeJson(path.join(configDir, 'antigravity-oauth-token'), {
    token: {
      access_token: 'agy-token-1',
      refresh_token: 'agy-refresh-1'
    }
  });
  writeJson(path.join(profileDir, '.aih_usage.json'), {
    schemaVersion: 2,
    kind: 'agy_code_assist_quota',
    source: 'agy_fetch_available_models',
    capturedAt: Date.now(),
    models: [
      { model: 'claude-sonnet-4-6', remainingPct: 0 },
      { model: 'gemini-3-flash-agent', remainingPct: 76 }
    ]
  });

  const accounts = loadAgyServerAccounts({
    fs,
    getToolAccountIds: () => ['1'],
    getToolConfigDir: (_cli, id) => path.join(profilesRoot, String(id), '.gemini', 'antigravity-cli'),
    getProfileDir: (_cli, id) => path.join(profilesRoot, String(id)),
    checkStatus: () => ({ configured: true, accountName: 'agy@example.com' })
  });

  assert.equal(accounts.length, 1);
  assert.deepEqual(accounts[0].availableModels, ['gemini-3-flash-agent']);
  assert.equal(accounts[0].usageSnapshot.kind, 'agy_code_assist_quota');
  assert.equal(accounts[0].remainingPct, undefined);
});

test('loadAgyServerAccounts skips keyring-only accounts without explicit API token', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-agy-keyring-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profilesRoot = path.join(aiHomeDir, 'profiles', 'agy');
  const profileDir = path.join(profilesRoot, '1');
  const configDir = path.join(profileDir, '.gemini', 'antigravity-cli');
  fs.mkdirSync(path.join(configDir, 'log'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'log', 'latest.log'), 'OAuth: authenticated successfully as agy@example.com\n', 'utf8');

  const accounts = loadAgyServerAccounts({
    fs,
    getToolAccountIds: () => ['1'],
    getToolConfigDir: (_cli, id) => path.join(profilesRoot, String(id), '.gemini', 'antigravity-cli'),
    getProfileDir: (_cli, id) => path.join(profilesRoot, String(id)),
    checkStatus: () => ({ configured: true, accountName: 'agy@example.com' })
  });

  assert.equal(accounts.length, 0);
});

test('loadServerRuntimeAccounts clears stale agy auth block when OAuth creds are recoverable', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-agy-auth-current-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profilesRoot = path.join(aiHomeDir, 'profiles');
  const profileDir = path.join(profilesRoot, 'agy', '1');
  const configDir = path.join(profileDir, '.gemini', 'antigravity-cli');
  fs.mkdirSync(path.join(configDir, 'log'), { recursive: true });
  writeJson(path.join(configDir, 'antigravity-oauth-token'), {
    token: {
      access_token: 'agy-token',
      refresh_token: 'agy-refresh',
      expiry: new Date(Date.now() - 60_000).toISOString()
    },
    auth_method: 'consumer'
  });
  fs.writeFileSync(path.join(configDir, 'email.cache'), 'agy@example.com', 'utf8');

  const accountStateIndex = createAccountStateIndex({ aiHomeDir, fs });
  accountStateIndex.upsertRuntimeState('agy', '1', {
    authInvalidUntil: Date.now() + 10 * 60 * 1000,
    lastFailureKind: 'auth_invalid',
    lastFailureReason: 'auth_invalid_reauth_required'
  }, {
    configured: true,
    apiKeyMode: false,
    authMode: 'consumer',
    displayName: 'agy@example.com'
  });
  const accountStateService = createAccountStateService({
    accountStateIndex
  });

  const accounts = loadServerRuntimeAccounts({
    fs,
    aiHomeDir,
    accountStateIndex,
    accountStateService,
    getToolAccountIds: (provider) => (provider === 'agy' ? ['1'] : []),
    getToolConfigDir: (provider, id) => path.join(profilesRoot, provider, String(id), '.gemini', 'antigravity-cli'),
    getProfileDir: (provider, id) => path.join(profilesRoot, provider, String(id)),
    checkStatus: (_provider, pDir) => ({
      configured: true,
      accountName: pDir === profileDir ? 'agy@example.com' : 'Unknown'
    })
  });

  assert.equal(accounts.agy.length, 1);
  assert.equal(accounts.agy[0].refreshToken, 'agy-refresh');
  assert.equal(accounts.agy[0].lastFailureKind, '');
  assert.equal(accounts.agy[0].authInvalidUntil, 0);
  assert.equal(accountStateIndex.getAccountState('agy', '1').runtime_state, null);
});

test('loadServerRuntimeAccounts keeps agy login-missing auth block even with refresh token', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-agy-auth-login-missing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profilesRoot = path.join(aiHomeDir, 'profiles');
  const profileDir = path.join(profilesRoot, 'agy', '1');
  const configDir = path.join(profileDir, '.gemini', 'antigravity-cli');
  fs.mkdirSync(path.join(configDir, 'log'), { recursive: true });
  writeJson(path.join(configDir, 'antigravity-oauth-token'), {
    token: {
      access_token: 'agy-token',
      refresh_token: 'agy-refresh',
      expiry: new Date(Date.now() - 60_000).toISOString()
    },
    auth_method: 'consumer'
  });
  fs.writeFileSync(path.join(configDir, 'email.cache'), 'agy@example.com', 'utf8');

  const accountStateIndex = createAccountStateIndex({ aiHomeDir, fs });
  accountStateIndex.upsertRuntimeState('agy', '1', {
    authInvalidUntil: Date.now() + 10 * 60 * 1000,
    lastFailureKind: 'auth_invalid',
    lastFailureReason: 'agy_not_signed_in'
  }, {
    configured: true,
    apiKeyMode: false,
    authMode: 'consumer',
    displayName: 'agy@example.com'
  });
  const accountStateService = createAccountStateService({
    accountStateIndex
  });

  const accounts = loadServerRuntimeAccounts({
    fs,
    aiHomeDir,
    accountStateIndex,
    accountStateService,
    getToolAccountIds: (provider) => (provider === 'agy' ? ['1'] : []),
    getToolConfigDir: (provider, id) => path.join(profilesRoot, provider, String(id), '.gemini', 'antigravity-cli'),
    getProfileDir: (provider, id) => path.join(profilesRoot, provider, String(id)),
    checkStatus: (_provider, pDir) => ({
      configured: true,
      accountName: pDir === profileDir ? 'agy@example.com' : 'Unknown'
    })
  });

  assert.equal(accounts.agy.length, 1);
  assert.equal(accounts.agy[0].lastFailureKind, 'auth_invalid');
  assert.equal(accounts.agy[0].lastFailureReason, 'agy_not_signed_in');
  assert.ok(accounts.agy[0].authInvalidUntil > Date.now());
  assert.ok(accountStateIndex.getAccountState('agy', '1').runtime_state);
});

test('loadServerRuntimeAccounts returns agy provider bucket', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-agy-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profilesRoot = path.join(aiHomeDir, 'profiles');

  const accounts = loadServerRuntimeAccounts({
    fs,
    aiHomeDir,
    getToolAccountIds: (provider) => {
      if (provider === 'agy') return ['1'];
      return [];
    },
    getToolConfigDir: (provider, id) => path.join(profilesRoot, provider, String(id), '.gemini', 'antigravity-cli'),
    getProfileDir: (provider, id) => path.join(profilesRoot, provider, String(id)),
    checkStatus: () => ({ configured: true, accountName: 'agy@example.com' })
  });

  assert.ok(Array.isArray(accounts.agy));
  assert.deepEqual(accounts.agy, []);
});

test('loadOpenCodeServerAccounts uses official auth.json as account identity source', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-opencode-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const profilesRoot = path.join(root, '.ai_home', 'profiles', 'opencode');
  const profileDir = path.join(profilesRoot, '1');
  writeJson(path.join(profileDir, '.local', 'share', 'opencode', 'auth.json'), {
    anthropic: { type: 'api', key: 'sk-ant' },
    openai: { type: 'api', key: 'sk-openai' },
    'opencode-go': { type: 'api', key: 'sk-opencode-go-12345678' },
    google: {}
  });

  const accounts = loadOpenCodeServerAccounts({
    fs,
    getToolAccountIds: () => ['1'],
    getProfileDir: (_provider, id) => path.join(profilesRoot, String(id)),
    getToolConfigDir: (_provider, id) => path.join(profilesRoot, String(id), '.config', 'opencode'),
    checkStatus: () => ({ configured: false })
  });

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].provider, 'opencode');
  assert.equal(accounts[0].authType, 'opencode-auth');
  assert.equal(accounts[0].apiKeyMode, false);
  assert.equal(accounts[0].displayName, 'OpenCode Go API (...5678)');
  assert.deepEqual(accounts[0].connectedProviders, ['anthropic', 'openai', 'opencode-go']);
  assert.equal(accounts[0].quotaStatus, 'not_applicable');
  assert.equal(accounts[0].schedulableStatus, 'schedulable');
  assert.equal(
    accounts[0].authPath,
    path.join(profileDir, '.local', 'share', 'opencode', 'auth.json')
  );
});

test('loadServerRuntimeAccounts returns opencode provider bucket', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-opencode-bucket-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profilesRoot = path.join(aiHomeDir, 'profiles');
  const profileDir = path.join(profilesRoot, 'opencode', '7');
  writeJson(path.join(profileDir, '.local', 'share', 'opencode', 'auth.json'), {
    openai: { type: 'api', key: 'sk-openai' }
  });

  const accounts = loadServerRuntimeAccounts({
    fs,
    aiHomeDir,
    getToolAccountIds: (provider) => provider === 'opencode' ? ['7'] : [],
    getToolConfigDir: (provider, id) => path.join(profilesRoot, provider, String(id), '.config', provider),
    getProfileDir: (provider, id) => path.join(profilesRoot, provider, String(id)),
    checkStatus: () => ({ configured: false })
  });

  assert.ok(Array.isArray(accounts.opencode));
  assert.equal(accounts.opencode.length, 1);
  assert.equal(accounts.opencode[0].id, '7');
  assert.equal(accounts.opencode[0].lastFailureKind, '');
  assert.equal(accounts.opencode[0].consecutiveFailures, 0);
});

test('loadServerRuntimeAccounts auto-clears agy auth_invalid after a successful usage probe', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-agy-authinvalid-clear-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profileDir = path.join(aiHomeDir, 'profiles', 'agy', '1');
  const configDir = path.join(profileDir, '.gemini', 'antigravity-cli');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'antigravity-oauth-token'), JSON.stringify({
    auth_method: 'oauth',
    token: {
      access_token: 'ya29.test',
      refresh_token: 'refresh.test',
      expiry: new Date(Date.now() + 3600 * 1000).toISOString()
    }
  }));

  const lastFailureAt = Date.now() - 60 * 60 * 1000;
  // 失败之后又有一次成功探测：capturedAt 晚于 lastFailureAt。
  writeJson(path.join(profileDir, '.aih_usage.json'), {
    schemaVersion: 2,
    kind: 'agy_code_assist_quota',
    source: 'agy_fetch_available_models',
    capturedAt: Date.now(),
    models: [{ model: 'gemini-2.5-flash', remainingPct: 100 }]
  });

  const accountStateIndex = createAccountStateIndex({ aiHomeDir, fs });
  // 用 agy_not_signed_in（既有逻辑视为不可恢复），专门验证"探测成功"能推翻该误判。
  accountStateIndex.upsertRuntimeState('agy', '1', {
    cooldownUntil: Date.now() + 10 * 60 * 1000,
    authInvalidUntil: Date.now() + 10 * 60 * 1000,
    lastFailureKind: 'auth_invalid',
    lastFailureReason: 'agy_not_signed_in',
    lastError: 'agy_not_signed_in',
    lastFailureAt,
    consecutiveFailures: 1,
    failCount: 1
  }, { configured: true, displayName: 'agy@example.com' });
  const accountStateService = createAccountStateService({ accountStateIndex });

  const accounts = loadServerRuntimeAccounts({
    fs,
    aiHomeDir,
    accountStateIndex,
    accountStateService,
    getToolAccountIds: (cli) => (cli === 'agy' ? ['1'] : []),
    getToolConfigDir: (_cli, id) => path.join(aiHomeDir, 'profiles', 'agy', String(id), '.gemini', 'antigravity-cli'),
    getProfileDir: (_cli, id) => path.join(aiHomeDir, 'profiles', 'agy', String(id)),
    checkStatus: () => ({ configured: true }),
    serverPort: 8317
  });

  assert.equal(accounts.agy.length, 1);
  assert.equal(accounts.agy[0].authInvalidUntil, 0);
  assert.equal(accounts.agy[0].lastFailureKind, '');
});

test('loadServerRuntimeAccounts keeps agy auth_invalid when no successful probe after failure', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-agy-authinvalid-keep-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const profileDir = path.join(aiHomeDir, 'profiles', 'agy', '1');
  const configDir = path.join(profileDir, '.gemini', 'antigravity-cli');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'antigravity-oauth-token'), JSON.stringify({
    auth_method: 'oauth',
    token: { refresh_token: 'refresh.test' }
  }));

  const now = Date.now();
  // 探测发生在失败之前（capturedAt 早于 lastFailureAt）：不能清（真实新失败）。
  writeJson(path.join(profileDir, '.aih_usage.json'), {
    schemaVersion: 2,
    kind: 'agy_code_assist_quota',
    source: 'agy_fetch_available_models',
    capturedAt: now - 2 * 60 * 60 * 1000,
    models: [{ model: 'gemini-2.5-flash', remainingPct: 100 }]
  });

  const accountStateIndex = createAccountStateIndex({ aiHomeDir, fs });
  accountStateIndex.upsertRuntimeState('agy', '1', {
    cooldownUntil: now + 10 * 60 * 1000,
    authInvalidUntil: now + 10 * 60 * 1000,
    lastFailureKind: 'auth_invalid',
    lastFailureReason: 'agy_not_signed_in',
    lastError: 'agy_not_signed_in',
    lastFailureAt: now - 60 * 1000,
    consecutiveFailures: 1,
    failCount: 1
  }, { configured: true, displayName: 'agy@example.com' });
  const accountStateService = createAccountStateService({ accountStateIndex });

  const accounts = loadServerRuntimeAccounts({
    fs,
    aiHomeDir,
    accountStateIndex,
    accountStateService,
    getToolAccountIds: (cli) => (cli === 'agy' ? ['1'] : []),
    getToolConfigDir: (_cli, id) => path.join(aiHomeDir, 'profiles', 'agy', String(id), '.gemini', 'antigravity-cli'),
    getProfileDir: (_cli, id) => path.join(aiHomeDir, 'profiles', 'agy', String(id)),
    checkStatus: () => ({ configured: true }),
    serverPort: 8317
  });

  assert.equal(accounts.agy.length, 1);
  assert.equal(accounts.agy[0].lastFailureKind, 'auth_invalid');
  assert.ok(accounts.agy[0].authInvalidUntil > now);
});
