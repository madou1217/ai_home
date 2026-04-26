const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  loadCodexServerAccounts,
  loadServerRuntimeAccounts,
  readTrustedUsageSnapshot
} = require('../lib/server/accounts');
const { createAccountStateIndex } = require('../lib/account/state-index');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

test('loadCodexServerAccounts skips low-remaining usage accounts by threshold config', (t) => {
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

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, '2');
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
