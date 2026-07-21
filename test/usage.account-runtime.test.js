const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createUsageAccountRuntimeService } = require('../lib/cli/services/usage/account-runtime');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const {
  writeAccountCredentials,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');

test('refreshIndexedStateForAccount preserves manually disabled status while updating usage fields', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-usage-account-runtime-'));
  try {
    const accountRef = registerAccountIdentity(fs, root, {
      provider: 'codex',
      cliAccountId: '1',
      identitySeed: 'oauth:codex:disabled@example.com'
    }).accountRef;
    writeAccountNativeAuth(fs, root, accountRef, {
      auth: { tokens: { refresh_token: 'refresh-token' } }
    });

    const upserts = [];
    const service = createUsageAccountRuntimeService({
      path,
      fs,
      aiHomeDir: root,
      cliConfigs: { codex: {} },
      createUsageScheduler: () => ({ start() {} }),
      getAccountStateIndex: () => ({
        getAccountState() {
          return { status: 'down' };
        }
      }),
      accountStateService: {
        syncAccountBaseState(_cliName, _id, payload) {
          upserts.push(payload);
          return true;
        },
        pruneMissing() {}
      },
      lastActiveAccountByCli: {},
      usageIndexStaleRefreshMs: 60_000,
      usageIndexBgRefreshLimit: 10,
      checkStatus: () => ({ configured: true, accountName: 'user@example.com' }),
      readUsageCache: () => ({
        kind: 'codex_oauth_status',
        entries: [{ window: '5h', remainingPct: 33 }]
      }),
      ensureUsageSnapshot: (_cliName, _id, cache) => cache
    });

    const result = service.refreshIndexedStateForAccount('codex', accountRef, { refreshSnapshot: false });
    assert.equal(result.status, 'down');
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].status, 'down');
    assert.equal(upserts[0].remainingPct, 33);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refreshIndexedStateForAccount clears a legacy agy auth block without a failure reason when OAuth creds are recoverable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-usage-account-runtime-agy-'));
  try {
    const accountRef = registerAccountIdentity(fs, root, {
      provider: 'agy',
      cliAccountId: '1',
      identitySeed: 'oauth:agy:agy@example.com'
    }).accountRef;
    writeAccountNativeAuth(fs, root, accountRef, {
      oauthToken: { token: { refresh_token: 'refresh-token' } },
      email: 'agy@example.com'
    });

    const clears = [];
    const runtimeState = {
      authInvalidUntil: Date.now() + 60_000,
      lastFailureKind: 'auth_invalid',
      lastFailureReason: ''
    };
    const service = createUsageAccountRuntimeService({
      path,
      fs,
      aiHomeDir: root,
      cliConfigs: { agy: {} },
      createUsageScheduler: () => ({ start() {} }),
      getAccountStateIndex: () => ({
        getAccountState() {
          return {
            status: 'up',
            configured: true,
            apiKeyMode: false,
            runtimeState
          };
        }
      }),
      accountStateService: {
        syncAccountBaseState() {
          return true;
        },
        clearRuntimeBlock(capturedAccountRef, provider, payload) {
          clears.push({ provider, accountRef: capturedAccountRef, payload });
          return true;
        },
        pruneMissing() {}
      },
      lastActiveAccountByCli: {},
      usageIndexStaleRefreshMs: 60_000,
      usageIndexBgRefreshLimit: 10,
      checkStatus: () => ({
        configured: true,
        accountName: 'agy@example.com',
        authMode: 'consumer',
        hasAccessToken: true,
        hasRefreshToken: true,
        tokenExpiresAt: Date.now() - 60_000
      }),
      readUsageCache: () => null,
      ensureUsageSnapshot: (_cliName, _id, cache) => cache
    });

    const result = service.refreshIndexedStateForAccount('agy', accountRef, { refreshSnapshot: false });

    assert.equal(result.configured, true);
    assert.equal(clears.length, 1);
    assert.equal(clears[0].provider, 'agy');
    assert.equal(clears[0].accountRef, accountRef);
    assert.equal(clears[0].payload.evidence, 'agy_oauth_credentials_recoverable');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findEnvSandbox matches DB-only credentials before creating a duplicate account', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-usage-account-runtime-db-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const accountRef = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'gemini',
    cliAccountId: '7',
    identitySeed: 'api:gemini:gemini-key'
  }).accountRef;
  writeAccountCredentials(fs, aiHomeDir, accountRef, {
    GEMINI_API_KEY: 'gemini-key'
  });

  const service = createUsageAccountRuntimeService({
    path,
    fs,
    aiHomeDir,
    cliConfigs: { gemini: { envKeys: ['GEMINI_API_KEY'] } },
    createUsageScheduler: () => ({ start() {} }),
    getAccountStateIndex: () => null,
    accountStateService: { pruneMissing() {} },
    lastActiveAccountByCli: {},
    usageIndexStaleRefreshMs: 60_000,
    usageIndexBgRefreshLimit: 10,
    checkStatus: () => ({ configured: true }),
    readUsageCache: () => null,
    ensureUsageSnapshot: (_cliName, _id, cache) => cache
  });

  assert.equal(service.findEnvSandbox('gemini', { GEMINI_API_KEY: 'gemini-key' }), '7');
});
