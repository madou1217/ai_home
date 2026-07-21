'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadAgyServerAccounts,
  loadClaudeServerAccounts,
  loadCodexServerAccounts,
  loadGeminiServerAccounts,
  loadOpenCodeServerAccounts,
  loadServerRuntimeAccounts,
  readTrustedUsageSnapshot
} = require('../lib/server/accounts');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { createAccountStateIndex } = require('../lib/account/state-index');
const { createAccountStateService } = require('../lib/account/state-service');
const { writeAccountUsageSnapshot } = require('../lib/account/usage-snapshot-store');
const {
  writeAccountCredentials,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');
const { setUsageConfig } = require('../lib/usage/config-store');

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return header + '.' + body + '.sig';
}

function createCodexAuth(cliAccountId, options = {}) {
  const accountId = options.upstreamAccountId || 'upstream-' + cliAccountId;
  const accessPayload = {
    exp: options.exp || Math.floor(Date.now() / 1000) + 3600,
    client_id: options.clientId || 'codex-client',
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: options.planType || 'team',
      organizations: options.organizationId
        ? [{ id: options.organizationId, is_default: true }]
        : []
    },
    'https://api.openai.com/profile': {
      email: options.email || 'codex-' + cliAccountId + '@example.com'
    }
  };
  return {
    auth_mode: 'chatgpt',
    tokens: {
      refresh_token: options.refreshToken || 'refresh-' + cliAccountId,
      access_token: options.accessToken || makeJwt(accessPayload),
      id_token: options.idToken || '',
      account_id: accountId
    },
    expired: options.expired || '',
    last_refresh: options.lastRefresh || '2026-07-10T00:00:00.000Z'
  };
}

function codexUsage(remainingPct, account = {}) {
  return {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    account,
    entries: [{
      window: '5h',
      remainingPct,
      resetIn: '1h'
    }]
  };
}

function agyUsage(capturedAt, models, account = {}) {
  return {
    schemaVersion: 2,
    kind: 'agy_code_assist_quota',
    source: 'agy_fetch_available_models',
    capturedAt,
    account,
    models
  };
}

function createFixture(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-server-accounts-db-'));
  const accountStateIndex = createAccountStateIndex({ aiHomeDir, fs });
  const accountStateService = createAccountStateService({ accountStateIndex });
  const statuses = new Map();

  t.after(() => {
    accountStateIndex.close();
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });

  function register(provider, cliAccountId, options = {}) {
    const registration = registerAccountIdentity(fs, aiHomeDir, {
      provider,
      cliAccountId,
      identitySeed: options.identitySeed
        || 'test:' + provider + ':' + cliAccountId + ':' + (options.accountName || 'account')
    });
    const accountRef = registration.accountRef;
    if (options.env && Object.keys(options.env).length > 0) {
      writeAccountCredentials(fs, aiHomeDir, accountRef, options.env);
    }
    if (options.nativeAuth && Object.keys(options.nativeAuth).length > 0) {
      writeAccountNativeAuth(fs, aiHomeDir, accountRef, options.nativeAuth);
    }
    if (options.usage) {
      writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, options.usage);
    }
    statuses.set(accountRef, options.status || {
      configured: options.configured !== false,
      accountName: options.accountName || provider + '-' + cliAccountId + '@example.com'
    });
    if (options.state) {
      accountStateIndex.upsertAccountState(accountRef, provider, options.state);
    }
    return accountRef;
  }

  function deps(overrides = {}) {
    return {
      fs,
      aiHomeDir,
      accountStateIndex,
      accountStateService,
      serverPort: 8317,
      getProfileDir() {
        return '';
      },
      checkStatus(_provider, accountRef) {
        return statuses.get(accountRef) || { configured: false, accountName: 'Unknown' };
      },
      ...overrides
    };
  }

  return {
    aiHomeDir,
    accountStateIndex,
    deps,
    register
  };
}

test('Codex DB accounts remain visible while usage policy controls scheduling', (t) => {
  const fixture = createFixture(t);
  setUsageConfig({ fs, aiHomeDir: fixture.aiHomeDir }, { threshold_pct: 90 });
  const lowRef = fixture.register('codex', '1', {
    nativeAuth: { auth: createCodexAuth('1') },
    usage: codexUsage(9)
  });
  const healthyRef = fixture.register('codex', '2', {
    nativeAuth: { auth: createCodexAuth('2') },
    usage: codexUsage(50)
  });

  const accounts = loadCodexServerAccounts(fixture.deps());

  assert.deepEqual(accounts.map((account) => account.accountRef), [lowRef, healthyRef]);
  assert.equal(accounts[0].remainingPct, 9);
  assert.equal(accounts[0].schedulableStatus, 'blocked_by_policy');
  assert.equal(accounts[0].schedulableReason, 'codex_usage_below_server_threshold');
  assert.equal(accounts[1].remainingPct, 50);
  assert.equal(accounts[1].schedulableStatus, 'schedulable');
});

test('Codex token expiry uses the access token before stale auth metadata', (t) => {
  const fixture = createFixture(t);
  const exp = Math.floor(Date.now() / 1000) + 3600;
  fixture.register('codex', '7', {
    nativeAuth: {
      auth: createCodexAuth('7', {
        exp,
        expired: new Date(Date.now() - 3600_000).toISOString()
      })
    }
  });

  const accounts = loadCodexServerAccounts(fixture.deps());

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].tokenExpiresAt, exp * 1000);
});

test('Codex auth-only accounts remain pending and schedulable', (t) => {
  const fixture = createFixture(t);
  const accountRef = fixture.register('codex', '8', {
    nativeAuth: {
      auth: createCodexAuth('8', {
        planType: 'free',
        email: 'free@example.com'
      })
    }
  });

  const accounts = loadCodexServerAccounts(fixture.deps());

  assert.equal(accounts[0].accountRef, accountRef);
  assert.equal(accounts[0].quotaStatus, 'pending');
  assert.equal(accounts[0].quotaReason, 'auth_metadata_only');
  assert.equal(accounts[0].schedulableStatus, 'schedulable');
});

test('Codex trusted usage falls back to DB auth metadata when quota cache is absent', (t) => {
  const fixture = createFixture(t);
  const accountRef = fixture.register('codex', '3', {
    nativeAuth: {
      auth: createCodexAuth('3', {
        planType: 'team',
        email: 'metadata@example.com',
        upstreamAccountId: 'chatgpt-account-3',
        organizationId: 'org-3'
      })
    }
  });

  const snapshot = readTrustedUsageSnapshot(fixture.deps(), 'codex', accountRef);

  assert.equal(snapshot.fallbackSource, 'auth_json');
  assert.deepEqual(snapshot.account, {
    planType: 'team',
    email: 'metadata@example.com',
    upstreamAccountId: 'chatgpt-account-3',
    organizationId: 'org-3'
  });
  assert.equal(snapshot.entries[0].remainingPct, null);
});

test('Codex trusted usage repairs stale account identity from DB auth metadata', (t) => {
  const fixture = createFixture(t);
  const accountRef = fixture.register('codex', '4', {
    nativeAuth: {
      auth: createCodexAuth('4', {
        planType: 'team',
        email: 'fresh@example.com',
        upstreamAccountId: 'fresh-upstream'
      })
    },
    usage: codexUsage(75, {
      planType: 'free',
      email: 'stale@example.com',
      upstreamAccountId: 'stale-upstream',
      organizationId: ''
    })
  });

  const snapshot = readTrustedUsageSnapshot(fixture.deps(), 'codex', accountRef);

  assert.equal(snapshot.account.planType, 'team');
  assert.equal(snapshot.account.email, 'fresh@example.com');
  assert.equal(snapshot.account.upstreamAccountId, 'fresh-upstream');
  assert.equal(snapshot.entries[0].remainingPct, 75);
});

test('Codex API-key discovery reads DB credentials and rejects only the current relay', (t) => {
  const fixture = createFixture(t);
  const externalRef = fixture.register('codex', '10', {
    env: {
      OPENAI_API_KEY: 'external-key',
      OPENAI_BASE_URL: 'http://127.0.0.1:9527/v1'
    },
    accountName: 'External API'
  });
  fixture.register('codex', '11', {
    env: {
      OPENAI_API_KEY: 'self-key',
      OPENAI_BASE_URL: 'http://127.0.0.1:8317/v1'
    },
    accountName: 'Self relay'
  });

  const accounts = loadCodexServerAccounts(fixture.deps());

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].accountRef, externalRef);
  assert.equal(accounts[0].apiKeyMode, true);
  assert.equal(accounts[0].accessToken, 'external-key');
});

test('Codex API-key credentials take precedence over depleted OAuth metadata', (t) => {
  const fixture = createFixture(t);
  const accountRef = fixture.register('codex', '12', {
    env: {
      OPENAI_API_KEY: 'preferred-key',
      OPENAI_BASE_URL: 'https://proxy.example.com/v1'
    },
    nativeAuth: { auth: createCodexAuth('12') },
    usage: codexUsage(0)
  });

  const accounts = loadCodexServerAccounts(fixture.deps());

  assert.equal(accounts[0].accountRef, accountRef);
  assert.equal(accounts[0].apiKeyMode, true);
  assert.equal(accounts[0].remainingPct, null);
  assert.equal(accounts[0].schedulableStatus, 'schedulable');
});

test('Gemini accounts derive API-key and OAuth state entirely from DB records', (t) => {
  const fixture = createFixture(t);
  const apiKeyRef = fixture.register('gemini', '1', {
    env: { GEMINI_API_KEY: 'gemini-key' },
    accountName: 'Gemini API Key'
  });
  const oauthRef = fixture.register('gemini', '2', {
    nativeAuth: {
      oauthCreds: {
        access_token: 'gemini-access',
        refresh_token: 'gemini-refresh'
      }
    },
    usage: {
      schemaVersion: 2,
      kind: 'gemini_oauth_stats',
      source: 'gemini_refresh_user_quota',
      capturedAt: Date.now(),
      models: [{ model: 'gemini-2.5-pro', remainingPct: 80 }]
    },
    accountName: 'oauth@example.com'
  });

  const accounts = loadGeminiServerAccounts(fixture.deps());

  assert.deepEqual(accounts.map((account) => account.accountRef), [apiKeyRef, oauthRef].sort());
  const apiKeyAccount = accounts.find((account) => account.accountRef === apiKeyRef);
  const oauthAccount = accounts.find((account) => account.accountRef === oauthRef);
  assert.equal(apiKeyAccount.apiKeyMode, true);
  assert.equal(apiKeyAccount.authType, 'api-key');
  assert.equal(apiKeyAccount.accessToken, 'gemini-key');
  assert.equal(oauthAccount.authType, 'oauth-personal');
  assert.equal(oauthAccount.refreshToken, 'gemini-refresh');
  assert.deepEqual(oauthAccount.availableModels, ['gemini-2.5-pro']);
});

test('registered accounts without DB credentials are not discovered', (t) => {
  const fixture = createFixture(t);
  fixture.register('gemini', '9', {
    accountName: 'not-configured@example.com'
  });

  assert.deepEqual(loadGeminiServerAccounts(fixture.deps()), []);
});

test('Claude accounts preserve DB credential type semantics', (t) => {
  const fixture = createFixture(t);
  const apiKeyRef = fixture.register('claude', '1', {
    env: {
      ANTHROPIC_API_KEY: 'claude-api-key',
      ANTHROPIC_BASE_URL: 'https://anthropic-proxy.example.com'
    },
    accountName: 'Claude API Key'
  });
  const authTokenRef = fixture.register('claude', '2', {
    env: {
      AIH_CLAUDE_CREDENTIAL_TYPE: 'auth-token',
      ANTHROPIC_AUTH_TOKEN: 'claude-auth-token',
      ANTHROPIC_BASE_URL: 'https://claude-code.example.com'
    },
    accountName: 'Claude Auth Token'
  });
  const oauthRef = fixture.register('claude', '3', {
    nativeAuth: {
      credentials: {
        claudeAiOauth: {
          accessToken: 'claude-oauth-token',
          refreshToken: 'claude-refresh-token',
          expiresAt: 4102444800000
        }
      }
    },
    accountName: 'oauth@example.com'
  });

  const accounts = loadClaudeServerAccounts(fixture.deps());

  assert.deepEqual(accounts.map((account) => account.accountRef), [apiKeyRef, authTokenRef, oauthRef].sort());
  const apiKeyAccount = accounts.find((account) => account.accountRef === apiKeyRef);
  const authTokenAccount = accounts.find((account) => account.accountRef === authTokenRef);
  const oauthAccount = accounts.find((account) => account.accountRef === oauthRef);
  assert.equal(apiKeyAccount.authType, 'api-key');
  assert.equal(apiKeyAccount.accessToken, 'claude-api-key');
  assert.equal(authTokenAccount.authType, 'auth-token');
  assert.equal(authTokenAccount.accessToken, 'claude-auth-token');
  assert.equal(oauthAccount.authType, 'oauth');
  assert.equal(oauthAccount.accessToken, 'claude-oauth-token');
  assert.equal(oauthAccount.refreshToken, 'claude-refresh-token');
  assert.equal(oauthAccount.tokenExpiresAt, 4102444800000);
  assert.equal(apiKeyAccount.refreshToken, '');
  assert.equal(apiKeyAccount.tokenExpiresAt, null);
});

test('Claude API-key accounts pointing at the current relay are excluded', (t) => {
  const fixture = createFixture(t);
  fixture.register('claude', '4', {
    env: {
      ANTHROPIC_API_KEY: 'self-key',
      ANTHROPIC_BASE_URL: 'http://localhost:8317'
    },
    accountName: 'API Key: self'
  });

  assert.deepEqual(loadClaudeServerAccounts(fixture.deps()), []);
});

test('AGY access tokens and refresh-only OAuth accounts are loaded from DB', (t) => {
  const fixture = createFixture(t);
  const tokenRef = fixture.register('agy', '1', {
    env: {
      AGY_ACCESS_TOKEN: 'agy-access-token',
      AGY_BASE_URL: 'https://daily-cloudcode-pa.googleapis.com/v1internal'
    },
    nativeAuth: { email: 'token@example.com' },
    accountName: 'token@example.com'
  });
  const refreshRef = fixture.register('agy', '2', {
    nativeAuth: {
      email: 'refresh@example.com',
      oauthToken: {
        auth_method: 'consumer',
        token: {
          refresh_token: 'agy-refresh-token'
        }
      }
    },
    accountName: 'refresh@example.com'
  });

  const accounts = loadAgyServerAccounts(fixture.deps());

  assert.deepEqual(accounts.map((account) => account.accountRef), [tokenRef, refreshRef].sort());
  const tokenAccount = accounts.find((account) => account.accountRef === tokenRef);
  const refreshAccount = accounts.find((account) => account.accountRef === refreshRef);
  assert.equal(tokenAccount.accessToken, 'agy-access-token');
  assert.equal(refreshAccount.accessToken, '');
  assert.equal(refreshAccount.refreshToken, 'agy-refresh-token');
});

test('AGY trusted model quota remains model-scoped', (t) => {
  const fixture = createFixture(t);
  const capturedAt = Date.now();
  const accountRef = fixture.register('agy', '3', {
    nativeAuth: {
      email: 'quota@example.com',
      oauthToken: {
        auth_method: 'consumer',
        token: {
          access_token: 'agy-access',
          refresh_token: 'agy-refresh',
          expiry: new Date(Date.now() + 3600_000).toISOString()
        }
      }
    },
    usage: agyUsage(capturedAt, [
      { model: 'claude-sonnet-4-6', remainingPct: 0 },
      { model: 'gemini-3-flash-agent', remainingPct: 76 }
    ], {
      project: 'projects/persisted-runtime-project'
    }),
    accountName: 'quota@example.com'
  });

  const accounts = loadAgyServerAccounts(fixture.deps());
  const snapshot = readTrustedUsageSnapshot(fixture.deps(), 'agy', accountRef);

  assert.deepEqual(accounts[0].availableModels, ['gemini-3-flash-agent']);
  assert.equal(accounts[0].remainingPct, undefined);
  assert.equal(accounts[0].codeAssistQuotaMinRemainingPct, 0);
  assert.equal(accounts[0].codeAssistProject, 'projects/persisted-runtime-project');
  assert.equal(snapshot.capturedAt, capturedAt);
});

test('OpenCode discovery uses DB native auth as its only identity source', (t) => {
  const fixture = createFixture(t);
  const accountRef = fixture.register('opencode', '1', {
    nativeAuth: {
      auth: {
        anthropic: { type: 'api', key: 'sk-ant' },
        openai: { type: 'api', key: 'sk-openai' },
        'opencode-go': { type: 'api', key: 'sk-opencode-go-12345678' },
        google: {}
      }
    },
    configured: false
  });

  const accounts = loadOpenCodeServerAccounts(fixture.deps());

  assert.equal(accounts[0].accountRef, accountRef);
  assert.equal(accounts[0].authPath, 'app-state.db');
  assert.equal(accounts[0].displayName, 'OpenCode Go API (...5678)');
  assert.deepEqual(accounts[0].connectedProviders, ['anthropic', 'openai', 'opencode-go']);
});

test('runtime buckets expose accountRef without CLI identity fields', (t) => {
  const fixture = createFixture(t);
  const accountRef = fixture.register('opencode', '7', {
    nativeAuth: {
      auth: {
        openai: { type: 'api', key: 'sk-openai' }
      }
    },
    configured: false
  });

  const accounts = loadServerRuntimeAccounts(fixture.deps());

  assert.deepEqual(Object.keys(accounts).sort(), ['agy', 'claude', 'codex', 'gemini', 'grok', 'kimi', 'kiro', 'opencode']);
  assert.equal(accounts.opencode[0].accountRef, accountRef);
  assert.equal(Object.hasOwn(accounts.opencode[0], 'id'), false);
  assert.equal(Object.hasOwn(accounts.opencode[0], 'accountId'), false);
  assert.equal(Object.hasOwn(accounts.opencode[0], 'account_id'), false);
  assert.equal(Object.hasOwn(accounts.opencode[0], 'cliAccountId'), false);
});

test('runtime loading excludes accounts disabled in DB state', (t) => {
  const fixture = createFixture(t);
  const disabledRef = fixture.register('claude', '11', {
    nativeAuth: {
      credentials: {
        claudeAiOauth: { accessToken: 'disabled-token' }
      }
    },
    accountName: 'disabled@example.com',
    state: { status: 'down', configured: true }
  });
  const enabledRef = fixture.register('claude', '12', {
    nativeAuth: {
      credentials: {
        claudeAiOauth: { accessToken: 'enabled-token' }
      }
    },
    accountName: 'enabled@example.com',
    state: { status: 'up', configured: true }
  });

  const accounts = loadServerRuntimeAccounts(fixture.deps());

  assert.deepEqual(accounts.claude.map((account) => account.accountRef), [enabledRef]);
  assert.equal(accounts.claude.some((account) => account.accountRef === disabledRef), false);
});

test('runtime loading restores persisted OAuth auth-invalid state by accountRef', (t) => {
  const fixture = createFixture(t);
  const accountRef = fixture.register('codex', '20', {
    nativeAuth: { auth: createCodexAuth('20') }
  });
  fixture.accountStateIndex.upsertRuntimeState(accountRef, 'codex', {
    authInvalidUntil: Date.now() + 600_000,
    lastFailureKind: 'auth_invalid',
    lastFailureReason: 'upstream_401'
  }, {
    configured: true,
    apiKeyMode: false,
    authMode: 'oauth',
    displayName: 'oauth@example.com'
  });

  const accounts = loadServerRuntimeAccounts(fixture.deps());

  assert.equal(accounts.codex[0].lastFailureKind, 'auth_invalid');
  assert.equal(accounts.codex[0].lastFailureReason, 'upstream_401');
});

test('runtime loading clears stale OAuth blocks after DB API-key migration', (t) => {
  const fixture = createFixture(t);
  const accountRef = fixture.register('codex', '21', {
    env: {
      OPENAI_API_KEY: 'migrated-key',
      OPENAI_BASE_URL: 'https://proxy.example.com/v1'
    }
  });
  fixture.accountStateIndex.upsertRuntimeState(accountRef, 'codex', {
    cooldownUntil: Date.now() + 600_000,
    authInvalidUntil: Date.now() + 600_000,
    lastFailureKind: 'auth_invalid',
    lastFailureReason: 'auth_invalid_reauth_required'
  }, {
    configured: true,
    apiKeyMode: false,
    authMode: 'oauth',
    displayName: 'proxy.example.com'
  });

  const accounts = loadServerRuntimeAccounts(fixture.deps());
  const row = fixture.accountStateIndex.getAccountState(accountRef);

  assert.equal(accounts.codex[0].lastFailureKind, '');
  assert.equal(row.apiKeyMode, true);
  assert.equal(row.authMode, 'api-key');
  assert.equal(row.runtimeState, null);
});

test('runtime loading retains auth-invalid state for current API-key mode', (t) => {
  const fixture = createFixture(t);
  const accountRef = fixture.register('codex', '22', {
    env: {
      OPENAI_API_KEY: 'current-key',
      OPENAI_BASE_URL: 'https://proxy.example.com/v1'
    }
  });
  fixture.accountStateIndex.upsertRuntimeState(accountRef, 'codex', {
    authInvalidUntil: Date.now() + 600_000,
    lastFailureKind: 'auth_invalid',
    lastFailureReason: 'auth_invalid_reauth_required'
  }, {
    configured: true,
    apiKeyMode: true,
    authMode: 'api-key',
    displayName: 'proxy.example.com'
  });

  const accounts = loadServerRuntimeAccounts(fixture.deps());

  assert.equal(accounts.codex[0].lastFailureKind, 'auth_invalid');
  assert.ok(accounts.codex[0].authInvalidUntil > Date.now());
});

test('runtime loading clears legacy AGY auth blocks without a failure reason when OAuth metadata is recoverable', (t) => {
  const fixture = createFixture(t);
  const accountRef = fixture.register('agy', '30', {
    nativeAuth: {
      email: 'recoverable@example.com',
      oauthToken: {
        auth_method: 'consumer',
        token: {
          access_token: 'expired-access',
          refresh_token: 'refresh-token',
          expiry: new Date(Date.now() - 60_000).toISOString()
        }
      }
    },
    accountName: 'recoverable@example.com'
  });
  fixture.accountStateIndex.upsertRuntimeState(accountRef, 'agy', {
    authInvalidUntil: Date.now() + 600_000,
    lastFailureKind: 'auth_invalid',
    lastFailureReason: ''
  }, {
    configured: true,
    apiKeyMode: false,
    authMode: 'consumer',
    displayName: 'recoverable@example.com'
  });

  const accounts = loadServerRuntimeAccounts(fixture.deps());

  assert.equal(accounts.agy[0].refreshToken, 'refresh-token');
  assert.equal(accounts.agy[0].lastFailureKind, '');
  assert.equal(fixture.accountStateIndex.getAccountState(accountRef).runtimeState, null);
});

test('runtime loading keeps explicit AGY auth-invalid blocks when a refresh token still exists', (t) => {
  const fixture = createFixture(t);
  const accountRef = fixture.register('agy', '31', {
    nativeAuth: {
      email: 'blocked@example.com',
      oauthToken: {
        auth_method: 'consumer',
        token: {
          access_token: 'expired-access',
          refresh_token: 'failed-refresh-token',
          expiry: new Date(Date.now() - 60_000).toISOString()
        }
      }
    },
    accountName: 'blocked@example.com'
  });
  fixture.accountStateIndex.upsertRuntimeState(accountRef, 'agy', {
    authInvalidUntil: Date.now() + 600_000,
    lastFailureKind: 'auth_invalid',
    lastFailureReason: 'auth_invalid_reauth_required'
  }, {
    configured: true,
    apiKeyMode: false,
    authMode: 'consumer',
    displayName: 'blocked@example.com'
  });

  const accounts = loadServerRuntimeAccounts(fixture.deps());
  const persisted = fixture.accountStateIndex.getAccountState(accountRef);

  assert.equal(accounts.agy[0].refreshToken, 'failed-refresh-token');
  assert.equal(accounts.agy[0].lastFailureKind, 'auth_invalid');
  assert.equal(accounts.agy[0].lastFailureReason, 'auth_invalid_reauth_required');
  assert.equal(persisted.runtimeState.lastFailureReason, 'auth_invalid_reauth_required');
});

test('runtime loading keeps non-recoverable AGY login-missing blocks', (t) => {
  const fixture = createFixture(t);
  const accountRef = fixture.register('agy', '32', {
    nativeAuth: {
      email: 'missing@example.com',
      oauthToken: {
        auth_method: 'consumer',
        token: {
          refresh_token: 'refresh-token'
        }
      }
    },
    accountName: 'missing@example.com'
  });
  fixture.accountStateIndex.upsertRuntimeState(accountRef, 'agy', {
    authInvalidUntil: Date.now() + 600_000,
    lastFailureKind: 'auth_invalid',
    lastFailureReason: 'agy_not_signed_in'
  }, {
    configured: true,
    apiKeyMode: false,
    authMode: 'consumer',
    displayName: 'missing@example.com'
  });

  const accounts = loadServerRuntimeAccounts(fixture.deps());

  assert.equal(accounts.agy[0].lastFailureKind, 'auth_invalid');
  assert.equal(accounts.agy[0].lastFailureReason, 'agy_not_signed_in');
});

test('fresh AGY usage evidence clears a login-missing block after success', (t) => {
  const fixture = createFixture(t);
  const now = Date.now();
  const accountRef = fixture.register('agy', '33', {
    nativeAuth: {
      email: 'probe@example.com',
      oauthToken: {
        auth_method: 'consumer',
        token: {
          access_token: 'agy-access',
          refresh_token: 'agy-refresh',
          expiry: new Date(now + 3600_000).toISOString()
        }
      }
    },
    usage: agyUsage(now, [{ model: 'gemini-2.5-flash', remainingPct: 100 }]),
    accountName: 'probe@example.com'
  });
  fixture.accountStateIndex.upsertRuntimeState(accountRef, 'agy', {
    authInvalidUntil: now + 600_000,
    lastFailureKind: 'auth_invalid',
    lastFailureReason: 'agy_not_signed_in',
    lastFailureAt: now - 60_000
  }, {
    configured: true,
    apiKeyMode: false,
    authMode: 'consumer',
    displayName: 'probe@example.com'
  });

  const accounts = loadServerRuntimeAccounts(fixture.deps());

  assert.equal(accounts.agy[0].lastFailureKind, '');
  assert.equal(fixture.accountStateIndex.getAccountState(accountRef).runtimeState, null);
});

test('stale AGY usage evidence does not clear a later auth failure', (t) => {
  const fixture = createFixture(t);
  const now = Date.now();
  const accountRef = fixture.register('agy', '33', {
    nativeAuth: {
      email: 'stale-probe@example.com',
      oauthToken: {
        auth_method: 'consumer',
        token: {
          refresh_token: 'agy-refresh'
        }
      }
    },
    usage: agyUsage(now - 120_000, [{ model: 'gemini-2.5-flash', remainingPct: 100 }]),
    accountName: 'stale-probe@example.com'
  });
  fixture.accountStateIndex.upsertRuntimeState(accountRef, 'agy', {
    authInvalidUntil: now + 600_000,
    lastFailureKind: 'auth_invalid',
    lastFailureReason: 'agy_not_signed_in',
    lastFailureAt: now - 60_000
  }, {
    configured: true,
    apiKeyMode: false,
    authMode: 'consumer',
    displayName: 'stale-probe@example.com'
  });

  const accounts = loadServerRuntimeAccounts(fixture.deps());

  assert.equal(accounts.agy[0].lastFailureKind, 'auth_invalid');
  assert.ok(accounts.agy[0].authInvalidUntil > now);
});
