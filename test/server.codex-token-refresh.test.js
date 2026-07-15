const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const {
  readAccountNativeAuth,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');
const { refreshCodexAccessToken } = require('../lib/server/codex-token-refresh');

function createJwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

function createCodexFixture(t, auth, cliAccountId = '1') {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-refresh-db-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const registration = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId,
    identitySeed: `oauth:codex:refresh-${cliAccountId}@example.com`
  });
  writeAccountNativeAuth(fs, aiHomeDir, registration.accountRef, { auth });
  return { aiHomeDir, accountRef: registration.accountRef };
}

test('refreshCodexAccessToken skips when token is not due', async (t) => {
  let fetchCalled = false;
  const fixture = createCodexFixture(t, {
    tokens: {
      access_token: 'old-token',
      refresh_token: 'rt_123'
    }
  });
  const account = {
    provider: 'codex',
    accountRef: fixture.accountRef,
    refreshToken: 'rt_123',
    accessToken: 'old-token',
    tokenExpiresAt: Date.now() + 10 * 60 * 1000
  };

  const result = await refreshCodexAccessToken(account, {
    force: false,
    nowMs: Date.now(),
    skewMs: 5 * 60 * 1000
  }, {
    fs,
    aiHomeDir: fixture.aiHomeDir,
    fetchWithTimeout: async () => {
      fetchCalled = true;
      throw new Error('should_not_call');
    }
  });

  assert.equal(fetchCalled, false);
  assert.equal(result.ok, true);
  assert.equal(result.refreshed, false);
  assert.equal(result.reason, 'not_due');
});

test('refreshCodexAccessToken prefers access token expiry over stale auth expired field', async (t) => {
  const accessToken = createJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const fixture = createCodexFixture(t, {
    auth_mode: 'chatgpt',
    tokens: {
      access_token: accessToken,
      refresh_token: 'rt_current',
      id_token: createJwt({ exp: Math.floor(Date.now() / 1000) - 3600 }),
      account_id: 'acc_1'
    },
    expired: new Date(Date.now() - 3600_000).toISOString(),
    last_refresh: new Date().toISOString()
  });

  let fetchCalled = false;
  const account = {
    provider: 'codex',
    accessToken: 'old-token',
    refreshToken: 'rt_current',
    tokenExpiresAt: Date.now() - 60_000,
    accountRef: fixture.accountRef
  };

  const result = await refreshCodexAccessToken(account, {
    force: false,
    nowMs: Date.now(),
    skewMs: 5 * 60 * 1000
  }, {
    fs,
    aiHomeDir: fixture.aiHomeDir,
    fetchWithTimeout: async () => {
      fetchCalled = true;
      throw new Error('fresh access token should not refresh');
    }
  });

  assert.equal(fetchCalled, false);
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'not_due');
  assert.equal(account.accessToken, accessToken);
});

test('refreshCodexAccessToken force refresh updates account and persists auth snapshot', async (t) => {
  const fixture = createCodexFixture(t, {
    auth_mode: 'chatgpt',
    tokens: {
      access_token: 'old-token',
      refresh_token: 'opaque-old',
      id_token: 'id_old',
      account_id: 'acc_1'
    },
    last_refresh: '2026-03-01T00:00:00.000Z'
  });

  const account = {
    provider: 'codex',
    accountRef: fixture.accountRef,
    upstreamAccountId: 'acc_1',
    accessToken: 'old-token',
    idToken: 'id_old',
    refreshToken: 'opaque-old',
    oauthClientId: 'app_test_client'
  };

  const nowMs = Date.now();
  let seenUrl = '';
  let seenBody = null;
  const result = await refreshCodexAccessToken(account, {
    force: true,
    nowMs
  }, {
    fs,
    aiHomeDir: fixture.aiHomeDir,
    fetchWithTimeout: async (url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init && init.body || '{}'));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: 'new-token',
          refresh_token: 'opaque-new',
          id_token: 'id_new',
          expires_in: 3600
        })
      };
    }
  });

  assert.equal(seenUrl, 'https://auth.openai.com/oauth/token');
  assert.equal(seenBody.client_id, 'app_test_client');
  assert.equal(seenBody.grant_type, 'refresh_token');
  assert.equal(result.ok, true);
  assert.equal(result.refreshed, true);
  assert.equal(account.accessToken, 'new-token');
  assert.equal(account.refreshToken, 'opaque-new');
  assert.equal(account.idToken, 'id_new');
  assert.ok(Number.isFinite(account.tokenExpiresAt));

  const saved = readAccountNativeAuth(fs, fixture.aiHomeDir, fixture.accountRef).auth;
  assert.equal(saved.tokens.access_token, 'new-token');
  assert.equal(saved.tokens.refresh_token, 'opaque-new');
  assert.equal(saved.tokens.id_token, 'id_new');
  assert.equal(saved.tokens.account_id, 'acc_1');
  assert.equal(typeof saved.last_refresh, 'string');
  assert.equal(typeof saved.expired, 'string');
});

test('refreshCodexAccessToken rereads rotated auth file before reusing stale refresh token', async (t) => {
  const fixture = createCodexFixture(t, {
    auth_mode: 'chatgpt',
    tokens: {
      access_token: createJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      refresh_token: 'rt_new',
      id_token: 'id_new',
      account_id: 'acc_1'
    },
    expired: new Date(Date.now() + 3600_000).toISOString(),
    last_refresh: new Date().toISOString()
  });

  let fetchCalled = false;
  const account = {
    provider: 'codex',
    accountRef: fixture.accountRef,
    accessToken: 'old-token',
    idToken: 'id_old',
    refreshToken: 'rt_old',
    tokenExpiresAt: Date.now() - 60_000
  };

  const result = await refreshCodexAccessToken(account, {
    force: true,
    nowMs: Date.now()
  }, {
    fs,
    aiHomeDir: fixture.aiHomeDir,
    fetchWithTimeout: async () => {
      fetchCalled = true;
      throw new Error('stale refresh token should not be used');
    }
  });

  assert.equal(fetchCalled, false);
  assert.equal(result.ok, true);
  assert.equal(result.refreshed, false);
  assert.equal(result.reason, 'already_refreshed');
  assert.equal(account.refreshToken, 'rt_new');
});
