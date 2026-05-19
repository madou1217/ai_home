const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { refreshCodexAccessToken } = require('../lib/server/codex-token-refresh');

function createJwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

test('refreshCodexAccessToken skips when token is not due', async () => {
  let fetchCalled = false;
  const account = {
    provider: 'codex',
    refreshToken: 'rt_123',
    accessToken: 'old-token',
    tokenExpiresAt: Date.now() + 10 * 60 * 1000
  };

  const result = await refreshCodexAccessToken(account, {
    force: false,
    nowMs: Date.now(),
    skewMs: 5 * 60 * 1000
  }, {
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-refresh-expiry-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const accessToken = createJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  const authPath = path.join(root, 'auth.json');
  fs.writeFileSync(authPath, JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      access_token: accessToken,
      refresh_token: 'rt_current',
      id_token: createJwt({ exp: Math.floor(Date.now() / 1000) - 3600 }),
      account_id: 'acc_1'
    },
    expired: new Date(Date.now() - 3600_000).toISOString(),
    last_refresh: new Date().toISOString()
  }, null, 2));

  let fetchCalled = false;
  const account = {
    provider: 'codex',
    accessToken: 'old-token',
    refreshToken: 'rt_current',
    tokenExpiresAt: Date.now() - 60_000,
    codexAuthPath: authPath
  };

  const result = await refreshCodexAccessToken(account, {
    force: false,
    nowMs: Date.now(),
    skewMs: 5 * 60 * 1000
  }, {
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-refresh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const authPath = path.join(root, 'auth.json');
  fs.writeFileSync(authPath, JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      access_token: 'old-token',
      refresh_token: 'rt_old',
      id_token: 'id_old',
      account_id: 'acc_1'
    },
    last_refresh: '2026-03-01T00:00:00.000Z'
  }, null, 2));

  const account = {
    provider: 'codex',
    accountId: 'acc_1',
    accessToken: 'old-token',
    idToken: 'id_old',
    refreshToken: 'rt_old',
    oauthClientId: 'app_test_client',
    codexAuthPath: authPath
  };

  const nowMs = Date.now();
  let seenUrl = '';
  let seenBody = null;
  const result = await refreshCodexAccessToken(account, {
    force: true,
    nowMs
  }, {
    fetchWithTimeout: async (url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init && init.body || '{}'));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: 'new-token',
          refresh_token: 'rt_new',
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
  assert.equal(account.refreshToken, 'rt_new');
  assert.equal(account.idToken, 'id_new');
  assert.ok(Number.isFinite(account.tokenExpiresAt));

  const saved = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  assert.equal(saved.tokens.access_token, 'new-token');
  assert.equal(saved.tokens.refresh_token, 'rt_new');
  assert.equal(saved.tokens.id_token, 'id_new');
  assert.equal(saved.tokens.account_id, 'acc_1');
  assert.equal(typeof saved.last_refresh, 'string');
  assert.equal(typeof saved.expired, 'string');
});

test('refreshCodexAccessToken rereads rotated auth file before reusing stale refresh token', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-refresh-rotated-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const authPath = path.join(root, 'auth.json');
  fs.writeFileSync(authPath, JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      access_token: createJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      refresh_token: 'rt_new',
      id_token: 'id_new',
      account_id: 'acc_1'
    },
    expired: new Date(Date.now() + 3600_000).toISOString(),
    last_refresh: new Date().toISOString()
  }, null, 2));

  let fetchCalled = false;
  const account = {
    provider: 'codex',
    accountId: 'acc_1',
    accessToken: 'old-token',
    idToken: 'id_old',
    refreshToken: 'rt_old',
    tokenExpiresAt: Date.now() - 60_000,
    codexAuthPath: authPath
  };

  const result = await refreshCodexAccessToken(account, {
    force: true,
    nowMs: Date.now()
  }, {
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
