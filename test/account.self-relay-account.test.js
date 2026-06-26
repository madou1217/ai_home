const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildAihServerProfileEnv,
  deleteSelfRelayAccounts
} = require('../lib/account/self-relay-account');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

test('deleteSelfRelayAccounts deletes numeric AIH server relay profiles and keeps external localhost proxies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-self-relay-cleanup-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const profilesDir = path.join(aiHomeDir, 'profiles');
    const getProfileDir = (provider, accountId) => path.join(profilesDir, provider, String(accountId));
    const getToolConfigDir = (provider, accountId) => path.join(
      getProfileDir(provider, accountId),
      provider === 'codex' ? '.codex' : provider === 'claude' ? '.claude' : '.gemini'
    );

    writeJson(path.join(getProfileDir('codex', '5'), '.aih_env.json'), {
      OPENAI_API_KEY: 'dummy',
      OPENAI_BASE_URL: 'http://127.0.0.1:8317/v1'
    });
    writeJson(path.join(getToolConfigDir('codex', '5'), 'auth.json'), {
      OPENAI_API_KEY: 'dummy'
    });
    writeJson(path.join(getProfileDir('claude', '1'), '.aih_env.json'), {
      ANTHROPIC_API_KEY: 'dummy',
      ANTHROPIC_BASE_URL: 'http://localhost:8317/v1'
    });
    writeJson(path.join(getProfileDir('codex', '6'), '.aih_env.json'), {
      OPENAI_API_KEY: 'external-local',
      OPENAI_BASE_URL: 'http://127.0.0.1:9090/v1'
    });
    fs.writeFileSync(path.join(profilesDir, 'codex', '.aih_default'), '5', 'utf8');
    fs.writeFileSync(path.join(profilesDir, 'claude', '.aih_default'), '1', 'utf8');
    writeJson(path.join(aiHomeDir, 'codex-desktop-hook-state.json'), {
      desktopAccountId: '5',
      kept: true
    });

    const deletedStates = [];
    const result = deleteSelfRelayAccounts({
      fs,
      profilesDir,
      aiHomeDir,
      getProfileDir,
      getToolConfigDir,
      checkStatus: () => ({ configured: true, accountName: 'API Key' }),
      accountStateService: {
        deleteAccount(provider, accountId) {
          deletedStates.push({ provider, accountId });
          return true;
        }
      },
      serverPort: 9527
    });

    assert.deepEqual(result.deleted.map((item) => `${item.provider}/${item.accountId}`).sort(), ['claude/1', 'codex/5']);
    assert.equal(fs.existsSync(getProfileDir('codex', '5')), false);
    assert.equal(fs.existsSync(getProfileDir('claude', '1')), false);
    assert.equal(fs.existsSync(getProfileDir('codex', '6')), true);
    assert.equal(fs.existsSync(path.join(profilesDir, 'codex', '.aih_default')), false);
    assert.equal(fs.existsSync(path.join(profilesDir, 'claude', '.aih_default')), false);
    assert.deepEqual(deletedStates.sort((a, b) => `${a.provider}/${a.accountId}`.localeCompare(`${b.provider}/${b.accountId}`)), [
      { provider: 'claude', accountId: '1' },
      { provider: 'codex', accountId: '5' }
    ]);
    const desktopState = JSON.parse(fs.readFileSync(path.join(aiHomeDir, 'codex-desktop-hook-state.json'), 'utf8'));
    assert.equal(desktopState.desktopAccountId, undefined);
    assert.equal(desktopState.kept, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('buildAihServerProfileEnv maps server config to Codex and Claude client environment variables', () => {
  assert.deepEqual(buildAihServerProfileEnv('codex', {}), {
    OPENAI_API_KEY: 'dummy',
    OPENAI_BASE_URL: 'http://127.0.0.1:9527/v1'
  });

  assert.deepEqual(buildAihServerProfileEnv('codex', {
    host: '0.0.0.0',
    port: 8317,
    apiKey: 'server-key'
  }), {
    OPENAI_API_KEY: 'server-key',
    OPENAI_BASE_URL: 'http://127.0.0.1:8317/v1'
  });

  assert.deepEqual(buildAihServerProfileEnv('claude', {
    host: '127.0.0.1',
    port: 8317,
    apiKey: ''
  }), {
    ANTHROPIC_API_KEY: 'dummy',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317'
  });
});
