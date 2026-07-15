const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAccountSelectionService } = require('../lib/cli/services/account/selection');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const {
  writeAccountCredentials,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');

function createJwt(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `header.${encoded}.signature`;
}

function registerAccount(aiHomeDir, provider, cliAccountId, options = {}) {
  const accountRef = registerAccountIdentity(fs, aiHomeDir, {
    provider,
    cliAccountId,
    identitySeed: `test:account-selection:${provider}:${cliAccountId}`
  }).accountRef;
  if (options.env) {
    writeAccountCredentials(fs, aiHomeDir, accountRef, options.env);
  } else {
    writeAccountNativeAuth(fs, aiHomeDir, accountRef, options.nativeAuth || {
      auth: { tokens: { refresh_token: `refresh-${cliAccountId}` } }
    });
  }
  return accountRef;
}

test('getNextAvailableId skips indexed auth-invalid account before switching', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-selection-'));
  try {
    const blockedRef = registerAccount(root, 'codex', '10015');
    const availableRef = registerAccount(root, 'codex', '10016');

    const index = {
      getNextCandidateId: () => '10015',
      getAccountState: (accountRef) => {
        if (accountRef === blockedRef) {
          return {
            runtimeState: {
              authInvalidUntil: Date.now() + 60_000,
              lastFailureKind: 'auth_invalid',
              lastFailureReason: 'auth_invalid_reauth_required'
            }
          };
        }
        return null;
      }
    };

    const service = createAccountSelectionService({
      path,
      fs,
      aiHomeDir: root,
      getAccountStateIndex: () => index,
      checkStatus: () => ({ configured: true, accountName: 'oauth@example.com' }),
      refreshIndexedStateForAccount: (_provider, accountRef) => ({
        configured: true,
        apiKeyMode: false,
        remainingPct: accountRef === availableRef ? 50 : 99,
        schedulableStatus: 'schedulable'
      })
    });

    assert.equal(service.getNextAvailableId('codex', '10014'), '10016');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getNextAvailableId skips locally expired codex oauth tokens when no refresh token is available', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-selection-expired-token-'));
  try {
    const expiredRef = registerAccount(root, 'codex', '10015', {
      nativeAuth: { auth: { tokens: { access_token: createJwt({ exp: Math.floor(Date.now() / 1000) - 60 }) } } }
    });
    const freshRef = registerAccount(root, 'codex', '10016', {
      nativeAuth: { auth: { tokens: { access_token: createJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }) } } }
    });
    const refreshed = [];
    const runtimeWrites = [];

    const index = {
      getNextCandidateId: () => null,
      getAccountState: () => null
    };
    const accountStateService = {
      recordRuntimeFailure(accountRef, provider, runtimeState, baseState) {
        runtimeWrites.push({ provider, accountRef, runtimeState, baseState });
        return true;
      }
    };

    const service = createAccountSelectionService({
      path,
      fs,
      aiHomeDir: root,
      getAccountStateIndex: () => index,
      checkStatus: () => ({ configured: true, accountName: 'oauth@example.com' }),
      accountStateService,
      refreshIndexedStateForAccount: (_provider, accountRef, options) => {
        refreshed.push({ accountRef, options });
        return {
          configured: true,
          apiKeyMode: false,
          remainingPct: 50,
          schedulableStatus: 'schedulable'
        };
      }
    });

    assert.equal(service.getNextAvailableId('codex', '10014', { refreshSnapshot: false }), '10016');
    assert.deepEqual(refreshed, [{ accountRef: freshRef, options: { refreshSnapshot: false } }]);
    assert.equal(runtimeWrites.length, 1);
    assert.equal(runtimeWrites[0].accountRef, expiredRef);
    assert.equal(runtimeWrites[0].runtimeState.lastFailureKind, 'auth_invalid');
    assert.equal(runtimeWrites[0].runtimeState.lastFailureReason, 'local_unrefreshable_token_expired');
    assert.equal(runtimeWrites[0].baseState.configured, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getNextAvailableId keeps refreshable codex oauth accounts even when access token is expired', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-selection-refreshable-token-'));
  try {
    const refreshableRef = registerAccount(root, 'codex', '10015', {
      nativeAuth: { auth: { tokens: {
        access_token: createJwt({ exp: Math.floor(Date.now() / 1000) - 60 }),
        refresh_token: 'rt_refreshable'
      } } }
    });
    const refreshed = [];
    const runtimeWrites = [];

    const index = {
      getNextCandidateId: () => null,
      getAccountState: () => null,
      upsertRuntimeState(provider, accountId, runtimeState, baseState) {
        runtimeWrites.push({ provider, accountId, runtimeState, baseState });
        return true;
      }
    };

    const service = createAccountSelectionService({
      path,
      fs,
      aiHomeDir: root,
      getAccountStateIndex: () => index,
      checkStatus: () => ({ configured: true, accountName: 'oauth@example.com' }),
      stateIndexClient: { upsert() {} },
      refreshIndexedStateForAccount: (_provider, accountRef, options) => {
        refreshed.push({ accountRef, options });
        return {
          configured: true,
          apiKeyMode: false,
          remainingPct: 50,
          schedulableStatus: 'schedulable'
        };
      }
    });

    assert.equal(service.getNextAvailableId('codex', '10014', { refreshSnapshot: false }), '10015');
    assert.deepEqual(refreshed, [{ accountRef: refreshableRef, options: { refreshSnapshot: false } }]);
    assert.deepEqual(runtimeWrites, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getNextAvailableId ignores expired codex id token when access token is fresh', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-selection-id-token-expired-'));
  try {
    const accountRef = registerAccount(root, 'codex', '10015', {
      nativeAuth: { auth: { tokens: {
        access_token: createJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        id_token: createJwt({ exp: Math.floor(Date.now() / 1000) - 60 })
      } } }
    });
    const refreshed = [];
    const runtimeWrites = [];

    const index = {
      getNextCandidateId: () => null,
      getAccountState: () => null,
      upsertRuntimeState(provider, accountId, runtimeState, baseState) {
        runtimeWrites.push({ provider, accountId, runtimeState, baseState });
        return true;
      }
    };

    const service = createAccountSelectionService({
      path,
      fs,
      aiHomeDir: root,
      getAccountStateIndex: () => index,
      checkStatus: () => ({ configured: true, accountName: 'oauth@example.com' }),
      stateIndexClient: { upsert() {} },
      refreshIndexedStateForAccount: (_provider, capturedAccountRef, options) => {
        refreshed.push({ accountRef: capturedAccountRef, options });
        return {
          configured: true,
          apiKeyMode: false,
          remainingPct: 50,
          schedulableStatus: 'schedulable'
        };
      }
    });

    assert.equal(service.getNextAvailableId('codex', '10014', { refreshSnapshot: false }), '10015');
    assert.deepEqual(refreshed, [{ accountRef, options: { refreshSnapshot: false } }]);
    assert.deepEqual(runtimeWrites, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getNextAvailableId can select external api-key account but skips self relay', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-selection-api-key-'));
  try {
    const selfRef = registerAccount(root, 'codex', '10', { env: {
      OPENAI_API_KEY: 'sk-self-relay',
      OPENAI_BASE_URL: 'http://127.0.0.1:8317/v1'
    } });
    const externalRef = registerAccount(root, 'codex', '10014', { env: {
      OPENAI_API_KEY: 'sk-external-relay',
      OPENAI_BASE_URL: 'https://relay.example.com/v1'
    } });

    const index = {
      getNextCandidateId: () => null,
      getAccountState: () => null
    };
    const upserts = [];
    const accountStateService = {
      syncAccountBaseState(accountRef, provider, state) {
        upserts.push({ provider, accountRef, state });
        return true;
      }
    };

    const service = createAccountSelectionService({
      path,
      fs,
      aiHomeDir: root,
      getAccountStateIndex: () => index,
      checkStatus: () => ({ configured: true, accountName: 'API Key' }),
      accountStateService,
      refreshIndexedStateForAccount: () => null,
      readServerConfig: () => ({ host: '127.0.0.1', port: 8317 })
    });

    assert.equal(service.getNextAvailableId('codex', '10015'), '10014');
    assert.equal(upserts.find((item) => item.accountRef === selfRef).state.apiKeyMode, true);
    assert.equal(upserts.find((item) => item.accountRef === externalRef).state.apiKeyMode, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getNextAvailableId skips claude self relay api-key accounts but keeps external localhost proxies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-selection-claude-self-relay-'));
  try {
    const selfRef = registerAccount(root, 'claude', '10', { env: {
      ANTHROPIC_API_KEY: 'sk-self-relay',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317/v1'
    } });
    const externalRef = registerAccount(root, 'claude', '10014', { env: {
      ANTHROPIC_API_KEY: 'sk-external-relay',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9090/v1'
    } });

    const index = {
      getNextCandidateId: () => null,
      getAccountState: () => null
    };
    const upserts = [];
    const accountStateService = {
      syncAccountBaseState(accountRef, provider, state) {
        upserts.push({ provider, accountRef, state });
        return true;
      }
    };

    const service = createAccountSelectionService({
      path,
      fs,
      aiHomeDir: root,
      getAccountStateIndex: () => index,
      checkStatus: () => ({ configured: true, accountName: 'API Key' }),
      accountStateService,
      refreshIndexedStateForAccount: () => null,
      readServerConfig: () => ({ host: '127.0.0.1', port: 8317 })
    });

    assert.equal(service.getNextAvailableId('claude', '10015'), '10014');
    assert.equal(upserts.find((item) => item.accountRef === selfRef).state.apiKeyMode, true);
    assert.equal(upserts.find((item) => item.accountRef === externalRef).state.apiKeyMode, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getNextLoginableId skips api-key accounts and falls back to configured oauth login', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-selection-loginable-'));
  try {
    const apiKeyRef = registerAccount(root, 'codex', '10', { env: {
      OPENAI_API_KEY: 'sk-external-relay',
      OPENAI_BASE_URL: 'https://relay.example.com/v1'
    } });
    const oauthRef = registerAccount(root, 'codex', '20', {
      nativeAuth: { auth: { tokens: { access_token: createJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }) } } }
    });

    const index = {
      getNextCandidateId: () => null,
      getAccountState: () => null
    };

    const service = createAccountSelectionService({
      path,
      fs,
      aiHomeDir: root,
      getAccountStateIndex: () => index,
      checkStatus: (_provider, accountRef) => {
        if (accountRef === apiKeyRef) return { configured: true, accountName: 'API Key: sk-ex...elay' };
        assert.equal(accountRef, oauthRef);
        return { configured: true, accountName: 'oauth@example.com' };
      },
      stateIndexClient: { upsert() {} },
      refreshIndexedStateForAccount: () => null,
      readServerConfig: () => ({ host: '127.0.0.1', port: 8317 })
    });

    assert.equal(service.getNextLoginableId('codex', null, { refreshSnapshot: false }), '20');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getNextAvailableId skips runtime-blocked api-key accounts during fallback scan', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-selection-runtime-api-key-'));
  try {
    const blockedRef = registerAccount(root, 'claude', '3', { env: { ANTHROPIC_API_KEY: 'blocked-key' } });
    registerAccount(root, 'claude', '4', { env: { ANTHROPIC_API_KEY: 'current-key' } });

    const index = {
      getNextCandidateId: () => null,
      getAccountState: (accountRef) => {
        if (accountRef === blockedRef) {
          return {
            runtimeState: {
              rateLimitUntil: Date.now() + 60_000,
              lastFailureKind: 'rate_limited',
              lastFailureReason: 'usage_limit_reached'
            }
          };
        }
        return null;
      }
    };

    const service = createAccountSelectionService({
      path,
      fs,
      aiHomeDir: root,
      getAccountStateIndex: () => index,
      checkStatus: () => ({ configured: true, accountName: 'API Key: sk-22...7f02' }),
      stateIndexClient: { upsert() {} },
      refreshIndexedStateForAccount: () => null
    });

    assert.equal(service.getNextAvailableId('claude', '4', { refreshSnapshot: false }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getNextAvailableId can avoid live usage refresh for runtime switching', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-selection-fast-'));
  try {
    registerAccount(root, 'codex', '10016');
    const refreshOptions = [];

    const index = {
      getNextCandidateId: () => '10016',
      getAccountState: () => null
    };

    const service = createAccountSelectionService({
      path,
      fs,
      aiHomeDir: root,
      getAccountStateIndex: () => index,
      checkStatus: () => ({ configured: true, accountName: 'oauth@example.com' }),
      stateIndexClient: { upsert() {} },
      refreshIndexedStateForAccount: (_provider, _accountId, options) => {
        refreshOptions.push(options);
        return {
          configured: true,
          apiKeyMode: false,
          remainingPct: 50,
          schedulableStatus: 'schedulable'
        };
      }
    });

    assert.equal(service.getNextAvailableId('codex', '10015', { refreshSnapshot: false }), '10016');
    assert.deepEqual(refreshOptions, [{ refreshSnapshot: false }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
