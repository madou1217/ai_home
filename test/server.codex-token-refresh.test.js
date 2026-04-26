const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { refreshCodexAccessToken } = require('../lib/server/codex-token-refresh');

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
