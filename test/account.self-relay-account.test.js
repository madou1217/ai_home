const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildAihServerProfileEnv,
  deleteSelfRelayAccounts
} = require('../lib/account/self-relay-account');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { writeAccountCredentials } = require('../lib/server/account-credential-store');
const { resolveAccountRef } = require('../lib/server/account-ref-store');
const {
  readAccountUsageSnapshot,
  writeAccountUsageSnapshot
} = require('../lib/account/usage-snapshot-store');
const {
  readTransferMetadata,
  writeTransferMetadata
} = require('../lib/account/transfer-metadata-store');
const { resolveAccountRuntimeDir } = require('../lib/runtime/aih-storage-layout');

function registerApiKeyAccount(aiHomeDir, provider, cliAccountId, credentials) {
  const registration = registerAccountIdentity(fs, aiHomeDir, {
    provider,
    cliAccountId,
    identitySeed: `api-key:${provider}:${credentials.OPENAI_BASE_URL || credentials.ANTHROPIC_BASE_URL}:${cliAccountId}`
  });
  writeAccountCredentials(fs, aiHomeDir, registration.accountRef, credentials);
  return registration.accountRef;
}

test('deleteSelfRelayAccounts deletes DB-backed AIH relays and keeps external localhost proxies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-self-relay-cleanup-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const codexRelayRef = registerApiKeyAccount(aiHomeDir, 'codex', '5', {
      OPENAI_API_KEY: 'dummy',
      OPENAI_BASE_URL: 'http://127.0.0.1:8317/v1'
    });
    const claudeRelayRef = registerApiKeyAccount(aiHomeDir, 'claude', '1', {
      ANTHROPIC_API_KEY: 'dummy',
      ANTHROPIC_BASE_URL: 'http://localhost:8317/v1'
    });
    const externalRef = registerApiKeyAccount(aiHomeDir, 'codex', '6', {
      OPENAI_API_KEY: 'external-local',
      OPENAI_BASE_URL: 'http://127.0.0.1:9090/v1'
    });
    const relayRuntimeDir = resolveAccountRuntimeDir(aiHomeDir, 'codex', codexRelayRef);
    fs.mkdirSync(relayRuntimeDir, { recursive: true });
    fs.writeFileSync(path.join(relayRuntimeDir, 'runtime.txt'), 'stale');
    writeAccountUsageSnapshot(fs, aiHomeDir, codexRelayRef, { remainingPct: 50 });
    writeTransferMetadata(fs, aiHomeDir, codexRelayRef, { importedFrom: 'test' });

    const deletedStates = [];
    const result = deleteSelfRelayAccounts({
      fs,
      aiHomeDir,
      accountStateService: {
        deleteAccount(accountRef) {
          deletedStates.push(accountRef);
          return true;
        }
      },
      serverPort: 8317
    });

    assert.deepEqual(
      result.deleted.map((item) => `${item.provider}/${item.accountRef}`).sort(),
      [`claude/${claudeRelayRef}`, `codex/${codexRelayRef}`].sort()
    );
    assert.equal(resolveAccountRef(fs, aiHomeDir, codexRelayRef), null);
    assert.equal(resolveAccountRef(fs, aiHomeDir, claudeRelayRef), null);
    assert.equal(resolveAccountRef(fs, aiHomeDir, externalRef).accountRef, externalRef);
    assert.equal(readAccountUsageSnapshot(fs, aiHomeDir, codexRelayRef), null);
    assert.deepEqual(readTransferMetadata(fs, aiHomeDir, codexRelayRef), {});
    assert.equal(fs.existsSync(relayRuntimeDir), false);
    assert.deepEqual(deletedStates.sort(), [claudeRelayRef, codexRelayRef].sort());
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
