'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerAccountIdentity } = require('../lib/account/account-registration');
const { createAccountStatusChecker } = require('../lib/cli/services/account/status');
const {
  writeAccountCredentials,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');

function createFixture(t, options = {}) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-status-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const checkStatus = createAccountStatusChecker({
    fs,
    BufferImpl: Buffer,
    aiHomeDir,
    nowMs: options.nowMs
  });

  function register(provider, cliAccountId, data = {}) {
    const registration = registerAccountIdentity(fs, aiHomeDir, {
      provider,
      cliAccountId,
      identitySeed: `status:${provider}:${cliAccountId}@example.com`
    });
    if (data.env) {
      writeAccountCredentials(fs, aiHomeDir, registration.accountRef, data.env);
    }
    if (data.nativeAuth) {
      writeAccountNativeAuth(fs, aiHomeDir, registration.accountRef, data.nativeAuth);
    }
    return registration.accountRef;
  }

  return { checkStatus, register };
}

function createJwt(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `header.${encoded}.signature`;
}

test('status checker reads API-key credentials only from app-state.db', (t) => {
  const { checkStatus, register } = createFixture(t);
  const cases = [
    ['codex', '1', { OPENAI_API_KEY: 'sk-codex-123456789' }, 'API Key: sk-co...6789'],
    ['claude', '2', { ANTHROPIC_AUTH_TOKEN: 'sk-claude-123456789' }, 'Auth Token: sk-cl...6789'], // gitleaks:allow
    ['gemini', '3', { GEMINI_API_KEY: 'gemini-123456789' }, 'API Key: gemin...6789']
  ];

  for (const [provider, cliAccountId, env, accountName] of cases) {
    const accountRef = register(provider, cliAccountId, { env });
    assert.deepEqual(checkStatus(provider, accountRef), {
      configured: true,
      accountName,
      source: 'app-state.db'
    });
  }
});

test('status checker rejects an unregistered accountRef', (t) => {
  const { checkStatus } = createFixture(t);
  assert.deepEqual(checkStatus('codex', 'acct_00000000000000000000'), {
    configured: false,
    accountName: 'Unknown'
  });
});

test('Codex OAuth requires an access token and derives identity from DB auth', (t) => {
  const { checkStatus, register } = createFixture(t);
  const refreshOnlyRef = register('codex', '10', {
    nativeAuth: { auth: { tokens: { refresh_token: 'refresh-only' } } }
  });
  const idOnlyRef = register('codex', '11', {
    nativeAuth: { auth: { tokens: { id_token: createJwt({ email: 'id-only@example.com' }) } } }
  });
  const accessRef = register('codex', '12', {
    nativeAuth: {
      auth: {
        tokens: {
          access_token: createJwt({
            'https://api.openai.com/profile': { email: 'codex@example.com' }
          })
        }
      }
    }
  });

  assert.equal(checkStatus('codex', refreshOnlyRef).configured, false);
  assert.equal(checkStatus('codex', idOnlyRef).configured, false);
  assert.deepEqual(checkStatus('codex', accessRef), {
    configured: true,
    accountName: 'codex@example.com'
  });
});

test('Gemini OAuth status is derived from DB-native auth', (t) => {
  const { checkStatus, register } = createFixture(t);
  const emptyRef = register('gemini', '20', {
    nativeAuth: { oauthCreds: {}, googleAccounts: {} }
  });
  const oauthRef = register('gemini', '21', {
    nativeAuth: {
      oauthCreds: { refresh_token: 'gemini-refresh' },
      googleAccounts: { active: 'gemini@example.com' }
    }
  });

  assert.equal(checkStatus('gemini', emptyRef).configured, false);
  assert.deepEqual(checkStatus('gemini', oauthRef), {
    configured: true,
    accountName: 'gemini@example.com'
  });
});

test('AGY OAuth and token status are derived from DB credentials', (t) => {
  const { checkStatus, register } = createFixture(t);
  const oauthRef = register('agy', '30', {
    nativeAuth: {
      oauthToken: {
        auth_method: 'consumer',
        token: {
          access_token: 'agy-access',
          refresh_token: 'agy-refresh',
          expiry: '2100-01-01T00:00:00Z'
        }
      },
      email: 'agy@example.com'
    }
  });
  const tokenRef = register('agy', '31', {
    env: { AGY_ACCESS_TOKEN: 'agy-env-token' },
    nativeAuth: { email: 'agy-token@example.com' }
  });

  const oauth = checkStatus('agy', oauthRef);
  assert.equal(oauth.configured, true);
  assert.equal(oauth.accountName, 'agy@example.com');
  assert.equal(oauth.authMode, 'consumer');
  assert.equal(oauth.source, 'app-state.db');
  assert.equal(oauth.hasAccessToken, true);
  assert.equal(oauth.hasRefreshToken, true);

  assert.deepEqual(checkStatus('agy', tokenRef), {
    configured: true,
    accountName: 'agy-token@example.com',
    email: 'agy-token@example.com',
    authMode: 'access-token',
    source: 'app-state.db'
  });
});

test('AGY OAuth metadata remains authoritative when a DB env token also exists', (t) => {
  const { checkStatus, register } = createFixture(t);
  const accountRef = register('agy', '32', {
    env: { AGY_ACCESS_TOKEN: 'env-token' },
    nativeAuth: {
      oauthToken: {
        auth_method: 'consumer',
        token: { refresh_token: 'oauth-refresh' }
      },
      email: 'oauth@example.com'
    }
  });

  const status = checkStatus('agy', accountRef);
  assert.equal(status.configured, true);
  assert.equal(status.accountName, 'oauth@example.com');
  assert.equal(status.authMode, 'consumer');
  assert.equal(status.hasRefreshToken, true);
});

test('Claude OAuth requires an access token and keeps account identities distinct', (t) => {
  const { checkStatus, register } = createFixture(t);
  const refreshOnlyRef = register('claude', '40', {
    nativeAuth: {
      credentials: { claudeAiOauth: { refreshToken: 'claude-refresh' } }
    }
  });
  const firstRef = register('claude', '41', {
    nativeAuth: {
      credentials: {
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-first-token',
          account: { emailAddress: 'first@example.com' }
        }
      }
    }
  });
  const secondRef = register('claude', '42', {
    nativeAuth: {
      credentials: {
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-second-token',
          account: { uuid: '12345678-aaaa-bbbb-cccc-123456789abc' }
        }
      }
    }
  });

  assert.equal(checkStatus('claude', refreshOnlyRef).configured, false);
  assert.deepEqual(checkStatus('claude', firstRef), {
    configured: true,
    accountName: 'first@example.com'
  });
  assert.deepEqual(checkStatus('claude', secondRef), {
    configured: true,
    accountName: 'Claude 12345678'
  });
});

test('Claude OAuth rejects only expired access tokens that cannot be refreshed', (t) => {
  const { checkStatus, register } = createFixture(t, { nowMs: 2_000_000_000_000 });
  const expiredRef = register('claude', '43', {
    nativeAuth: {
      credentials: {
        claudeAiOauth: {
          accessToken: 'expired-access-token',
          expiresAt: 1_900_000_000_000
        }
      }
    }
  });
  const refreshableRef = register('claude', '44', {
    nativeAuth: {
      credentials: {
        claudeAiOauth: {
          accessToken: 'refreshable-access-token',
          refreshToken: 'refresh-token',
          expiresAt: 1_900_000_000_000
        }
      }
    }
  });
  const activeRef = register('claude', '45', {
    nativeAuth: {
      credentials: {
        claudeAiOauth: {
          accessToken: 'active-access-token',
          expiresAt: 2_100_000_000_000
        }
      }
    }
  });

  assert.deepEqual(checkStatus('claude', expiredRef), {
    configured: false,
    accountName: 'Unknown'
  });
  assert.equal(checkStatus('claude', refreshableRef).configured, true);
  assert.equal(checkStatus('claude', activeRef).configured, true);
});

test('OpenCode auth status is derived from DB-native auth', (t) => {
  const { checkStatus, register } = createFixture(t);
  const accountRef = register('opencode', '50', {
    nativeAuth: {
      auth: {
        'opencode-go': {
          type: 'api',
          key: 'opencode-secret-1234',
          email: 'opencode@example.com'
        }
      }
    }
  });

  assert.deepEqual(checkStatus('opencode', accountRef), {
    configured: true,
    accountName: 'opencode@example.com',
    authMode: 'opencode-auth',
    providers: ['opencode-go'],
    source: 'app-state.db'
  });
});
