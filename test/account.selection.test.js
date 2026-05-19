const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAccountSelectionService } = require('../lib/cli/services/account/selection');

function createJwt(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `header.${encoded}.signature`;
}

test('getNextAvailableId skips indexed auth-invalid account before switching', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-selection-'));
  try {
    const profilesDir = path.join(root, 'profiles');
    fs.mkdirSync(path.join(profilesDir, 'codex', '10015'), { recursive: true });
    fs.mkdirSync(path.join(profilesDir, 'codex', '10016'), { recursive: true });

    const index = {
      getNextCandidateId: () => '10015',
      getAccountState: (_provider, accountId) => {
        if (String(accountId) === '10015') {
          return {
            runtime_state: {
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
      profilesDir,
      getAccountStateIndex: () => index,
      getToolAccountIds: () => ['10015', '10016'],
      checkStatus: () => ({ configured: true, accountName: 'oauth@example.com' }),
      stateIndexClient: { upsert() {} },
      refreshIndexedStateForAccount: (_provider, accountId) => ({
        configured: true,
        apiKeyMode: false,
        remainingPct: String(accountId) === '10016' ? 50 : 99,
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
    const profilesDir = path.join(root, 'profiles');
    const expiredDir = path.join(profilesDir, 'codex', '10015', '.codex');
    const freshDir = path.join(profilesDir, 'codex', '10016', '.codex');
    fs.mkdirSync(expiredDir, { recursive: true });
    fs.mkdirSync(freshDir, { recursive: true });
    fs.writeFileSync(path.join(expiredDir, 'auth.json'), JSON.stringify({
      tokens: { access_token: createJwt({ exp: Math.floor(Date.now() / 1000) - 60 }) }
    }), 'utf8');
    fs.writeFileSync(path.join(freshDir, 'auth.json'), JSON.stringify({
      tokens: { access_token: createJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }) }
    }), 'utf8');
    const refreshed = [];
    const runtimeWrites = [];

    const index = {
      getNextCandidateId: () => null,
      getAccountState: () => null
    };
    const accountStateService = {
      recordRuntimeFailure(provider, accountId, runtimeState, baseState) {
        runtimeWrites.push({ provider, accountId, runtimeState, baseState });
        return true;
      }
    };

    const service = createAccountSelectionService({
      path,
      fs,
      profilesDir,
      getAccountStateIndex: () => index,
      getToolAccountIds: () => ['10015', '10016'],
      checkStatus: () => ({ configured: true, accountName: 'oauth@example.com' }),
      accountStateService,
      refreshIndexedStateForAccount: (_provider, accountId, options) => {
        refreshed.push({ accountId, options });
        return {
          configured: true,
          apiKeyMode: false,
          remainingPct: 50,
          schedulableStatus: 'schedulable'
        };
      }
    });

    assert.equal(service.getNextAvailableId('codex', '10014', { refreshSnapshot: false }), '10016');
    assert.deepEqual(refreshed, [{ accountId: '10016', options: { refreshSnapshot: false } }]);
    assert.equal(runtimeWrites.length, 1);
    assert.equal(runtimeWrites[0].accountId, '10015');
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
    const profilesDir = path.join(root, 'profiles');
    const refreshableDir = path.join(profilesDir, 'codex', '10015', '.codex');
    fs.mkdirSync(refreshableDir, { recursive: true });
    fs.writeFileSync(path.join(refreshableDir, 'auth.json'), JSON.stringify({
      tokens: {
        access_token: createJwt({ exp: Math.floor(Date.now() / 1000) - 60 }),
        refresh_token: 'rt_refreshable'
      }
    }), 'utf8');
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
      profilesDir,
      getAccountStateIndex: () => index,
      getToolAccountIds: () => ['10015'],
      checkStatus: () => ({ configured: true, accountName: 'oauth@example.com' }),
      stateIndexClient: { upsert() {} },
      refreshIndexedStateForAccount: (_provider, accountId, options) => {
        refreshed.push({ accountId, options });
        return {
          configured: true,
          apiKeyMode: false,
          remainingPct: 50,
          schedulableStatus: 'schedulable'
        };
      }
    });

    assert.equal(service.getNextAvailableId('codex', '10014', { refreshSnapshot: false }), '10015');
    assert.deepEqual(refreshed, [{ accountId: '10015', options: { refreshSnapshot: false } }]);
    assert.deepEqual(runtimeWrites, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getNextAvailableId ignores expired codex id token when access token is fresh', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-selection-id-token-expired-'));
  try {
    const profilesDir = path.join(root, 'profiles');
    const accountDir = path.join(profilesDir, 'codex', '10015', '.codex');
    fs.mkdirSync(accountDir, { recursive: true });
    fs.writeFileSync(path.join(accountDir, 'auth.json'), JSON.stringify({
      tokens: {
        access_token: createJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        id_token: createJwt({ exp: Math.floor(Date.now() / 1000) - 60 })
      }
    }), 'utf8');
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
      profilesDir,
      getAccountStateIndex: () => index,
      getToolAccountIds: () => ['10015'],
      checkStatus: () => ({ configured: true, accountName: 'oauth@example.com' }),
      stateIndexClient: { upsert() {} },
      refreshIndexedStateForAccount: (_provider, accountId, options) => {
        refreshed.push({ accountId, options });
        return {
          configured: true,
          apiKeyMode: false,
          remainingPct: 50,
          schedulableStatus: 'schedulable'
        };
      }
    });

    assert.equal(service.getNextAvailableId('codex', '10014', { refreshSnapshot: false }), '10015');
    assert.deepEqual(refreshed, [{ accountId: '10015', options: { refreshSnapshot: false } }]);
    assert.deepEqual(runtimeWrites, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getNextAvailableId can select external api-key account but skips self relay', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-selection-api-key-'));
  try {
    const profilesDir = path.join(root, 'profiles');
    const selfDir = path.join(profilesDir, 'codex', '10');
    const externalDir = path.join(profilesDir, 'codex', '10014');
    fs.mkdirSync(path.join(selfDir, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(externalDir, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(selfDir, '.aih_env.json'), JSON.stringify({
      OPENAI_API_KEY: 'sk-self-relay',
      OPENAI_BASE_URL: 'http://127.0.0.1:8317/v1'
    }), 'utf8');
    fs.writeFileSync(path.join(externalDir, '.aih_env.json'), JSON.stringify({
      OPENAI_API_KEY: 'sk-external-relay',
      OPENAI_BASE_URL: 'https://relay.example.com/v1'
    }), 'utf8');

    const index = {
      getNextCandidateId: () => null,
      getAccountState: () => null
    };
    const upserts = [];
    const accountStateService = {
      syncAccountBaseState(provider, accountId, state) {
        upserts.push({ provider, accountId, state });
        return true;
      }
    };

    const service = createAccountSelectionService({
      path,
      fs,
      profilesDir,
      getAccountStateIndex: () => index,
      getToolAccountIds: () => ['10', '10014'],
      checkStatus: () => ({ configured: true, accountName: 'API Key' }),
      accountStateService,
      refreshIndexedStateForAccount: () => null,
      readServerConfig: () => ({ host: '127.0.0.1', port: 8317 })
    });

    assert.equal(service.getNextAvailableId('codex', '10015'), '10014');
    assert.equal(upserts.find((item) => item.accountId === '10').state.apiKeyMode, true);
    assert.equal(upserts.find((item) => item.accountId === '10014').state.apiKeyMode, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getNextAvailableId skips claude self relay api-key accounts but keeps external localhost proxies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-selection-claude-self-relay-'));
  try {
    const profilesDir = path.join(root, 'profiles');
    const selfDir = path.join(profilesDir, 'claude', '10');
    const externalDir = path.join(profilesDir, 'claude', '10014');
    fs.mkdirSync(path.join(selfDir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(externalDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(selfDir, '.aih_env.json'), JSON.stringify({
      ANTHROPIC_API_KEY: 'sk-self-relay',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:8317/v1'
    }), 'utf8');
    fs.writeFileSync(path.join(externalDir, '.aih_env.json'), JSON.stringify({
      ANTHROPIC_API_KEY: 'sk-external-relay',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9090/v1'
    }), 'utf8');

    const index = {
      getNextCandidateId: () => null,
      getAccountState: () => null
    };
    const upserts = [];
    const accountStateService = {
      syncAccountBaseState(provider, accountId, state) {
        upserts.push({ provider, accountId, state });
        return true;
      }
    };

    const service = createAccountSelectionService({
      path,
      fs,
      profilesDir,
      getAccountStateIndex: () => index,
      getToolAccountIds: () => ['10', '10014'],
      checkStatus: () => ({ configured: true, accountName: 'API Key' }),
      accountStateService,
      refreshIndexedStateForAccount: () => null,
      readServerConfig: () => ({ host: '127.0.0.1', port: 8317 })
    });

    assert.equal(service.getNextAvailableId('claude', '10015'), '10014');
    assert.equal(upserts.find((item) => item.accountId === '10').state.apiKeyMode, true);
    assert.equal(upserts.find((item) => item.accountId === '10014').state.apiKeyMode, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getNextLoginableId skips api-key accounts and falls back to configured oauth login', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-selection-loginable-'));
  try {
    const profilesDir = path.join(root, 'profiles');
    const apiKeyDir = path.join(profilesDir, 'codex', '10');
    const oauthDir = path.join(profilesDir, 'codex', '20', '.codex');
    fs.mkdirSync(path.join(apiKeyDir, '.codex'), { recursive: true });
    fs.mkdirSync(oauthDir, { recursive: true });
    fs.writeFileSync(path.join(apiKeyDir, '.aih_env.json'), JSON.stringify({
      OPENAI_API_KEY: 'sk-external-relay',
      OPENAI_BASE_URL: 'https://relay.example.com/v1'
    }), 'utf8');
    fs.writeFileSync(path.join(oauthDir, 'auth.json'), JSON.stringify({
      tokens: { access_token: createJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }) }
    }), 'utf8');

    const index = {
      getNextCandidateId: () => null,
      getAccountState: () => null
    };

    const service = createAccountSelectionService({
      path,
      fs,
      profilesDir,
      getAccountStateIndex: () => index,
      getToolAccountIds: () => ['10', '20'],
      checkStatus: (_provider, profileDir) => {
        if (String(profileDir).endsWith('/10')) return { configured: true, accountName: 'API Key: sk-ex...elay' };
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
    const profilesDir = path.join(root, 'profiles');
    fs.mkdirSync(path.join(profilesDir, 'claude', '3'), { recursive: true });
    fs.mkdirSync(path.join(profilesDir, 'claude', '4'), { recursive: true });

    const index = {
      getNextCandidateId: () => null,
      getAccountState: (_provider, accountId) => {
        if (String(accountId) === '3') {
          return {
            runtime_state: {
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
      profilesDir,
      getAccountStateIndex: () => index,
      getToolAccountIds: () => ['3', '4'],
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
    const profilesDir = path.join(root, 'profiles');
    fs.mkdirSync(path.join(profilesDir, 'codex', '10016'), { recursive: true });
    const refreshOptions = [];

    const index = {
      getNextCandidateId: () => '10016',
      getAccountState: () => null
    };

    const service = createAccountSelectionService({
      path,
      fs,
      profilesDir,
      getAccountStateIndex: () => index,
      getToolAccountIds: () => ['10016'],
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
