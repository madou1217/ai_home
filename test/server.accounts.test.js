const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCodexServerAccounts } = require('../lib/server/accounts');

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
