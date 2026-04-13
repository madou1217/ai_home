const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCodexServerAccounts, loadServerRuntimeAccounts } = require('../lib/server/accounts');
const { createAccountStateIndex } = require('../lib/account/state-index');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
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
