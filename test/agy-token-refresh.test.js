const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  refreshAgyAccessToken,
  __private
} = require('../lib/server/agy-token-refresh');

test('Agy token refresh reads agy token expiry', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-agy-refresh-'));
  try {
    const configDir = path.join(tmpDir, '.gemini', 'antigravity-cli');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'antigravity-oauth-token'), JSON.stringify({
      token: {
        access_token: 'token',
        refresh_token: 'refresh',
        expiry: '2100-01-01T00:00:00Z'
      },
      auth_method: 'consumer'
    }, null, 2));

    const expiresAt = __private.resolveTokenExpiryMs({ provider: 'agy', configDir });

    assert.equal(expiresAt, Date.parse('2100-01-01T00:00:00Z'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Agy token refresh uses CLI client defaults when cached creds omit client metadata', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-agy-refresh-'));
  try {
    const configDir = path.join(tmpDir, '.gemini', 'antigravity-cli');
    fs.mkdirSync(configDir, { recursive: true });
    const oauthPath = path.join(configDir, 'antigravity-oauth-token');
    fs.writeFileSync(oauthPath, JSON.stringify({
      token: {
        access_token: 'old-token',
        refresh_token: 'refresh-token',
        expiry: '2000-01-01T00:00:00Z'
      },
      auth_method: 'consumer'
    }, null, 2));

    let seenBody = null;
    const result = await refreshAgyAccessToken({
      id: '1',
      provider: 'agy',
      authType: 'oauth-personal',
      accessToken: 'old-token',
      configDir
    }, { force: true, nowMs: 1700000000000 }, {
      fetchWithTimeout: async (_url, init) => {
        seenBody = Object.fromEntries(new URLSearchParams(String(init && init.body || '')));
        assert.match(String(init.headers && init.headers['content-type'] || ''), /application\/x-www-form-urlencoded/);
        return {
          ok: true,
          text: async () => JSON.stringify({
            access_token: 'new-token',
            refresh_token: 'new-refresh-token',
            token_type: 'Bearer',
            expires_in: 3600,
            id_token: 'header.eyJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20ifQ.signature'
          })
        };
      }
    });

    const saved = JSON.parse(fs.readFileSync(oauthPath, 'utf8'));
    const cachePath = path.join(configDir, 'email.cache');
    const cachedEmail = fs.readFileSync(cachePath, 'utf8').trim();
    const defaultCredential = __private.resolveAgyOAuthClientCredentialCandidates({}, {})[0];

    assert.equal(result.ok, true);
    assert.equal(seenBody.client_id, defaultCredential.clientId);
    assert.equal(seenBody.client_secret, defaultCredential.clientSecret);
    assert.equal(seenBody.refresh_token, 'refresh-token');
    assert.equal(saved.token.access_token, 'new-token');
    assert.equal(saved.token.refresh_token, 'new-refresh-token');
    assert.equal(saved.token.token_type, 'Bearer');
    assert.equal(saved.token.expiry, new Date(1700003600000).toISOString());
    assert.equal(cachedEmail, 'test@example.com');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Agy token refresh tries the next client credential after invalid_client', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-agy-refresh-'));
  try {
    const configDir = path.join(tmpDir, '.gemini', 'antigravity-cli');
    fs.mkdirSync(configDir, { recursive: true });
    const oauthPath = path.join(configDir, 'antigravity-oauth-token');
    fs.writeFileSync(oauthPath, JSON.stringify({
      token: {
        access_token: 'old-token',
        refresh_token: 'refresh-token',
        expiry: '2000-01-01T00:00:00Z'
      },
      auth_method: 'consumer'
    }, null, 2));

    const calls = [];
    const result = await refreshAgyAccessToken({
      id: '1',
      provider: 'agy',
      authType: 'oauth-personal',
      accessToken: 'old-token',
      configDir
    }, {
      force: true,
      nowMs: 1700000000000,
      clientCredentials: [
        { clientId: 'bad-client-id', clientSecret: 'bad-client-secret' },
        { clientId: 'good-client-id', clientSecret: 'good-client-secret' }
      ]
    }, {
      fetchWithTimeout: async (_url, init) => {
        const body = Object.fromEntries(new URLSearchParams(String(init && init.body || '')));
        calls.push(body);
        if (body.client_id === 'bad-client-id') {
          return {
            ok: false,
            status: 401,
            text: async () => JSON.stringify({
              error: 'invalid_client',
              error_description: 'The provided client secret is invalid.'
            })
          };
        }
        return {
          ok: true,
          text: async () => JSON.stringify({
            access_token: 'new-token',
            expires_in: 3600
          })
        };
      }
    });

    const saved = JSON.parse(fs.readFileSync(oauthPath, 'utf8'));

    assert.equal(result.ok, true);
    assert.equal(result.refreshed, true);
    assert.deepEqual(calls.map((body) => body.client_id), ['bad-client-id', 'good-client-id']);
    assert.equal(saved.token.access_token, 'new-token');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Agy token refresh does not rotate client credentials after invalid_grant', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-agy-refresh-'));
  try {
    const configDir = path.join(tmpDir, '.gemini', 'antigravity-cli');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'antigravity-oauth-token'), JSON.stringify({
      token: {
        access_token: 'old-token',
        refresh_token: 'refresh-token',
        expiry: '2000-01-01T00:00:00Z'
      },
      auth_method: 'consumer'
    }, null, 2));

    const calls = [];
    const result = await refreshAgyAccessToken({
      id: '1',
      provider: 'agy',
      authType: 'oauth-personal',
      accessToken: 'old-token',
      configDir
    }, {
      force: true,
      nowMs: 1700000000000,
      clientCredentials: [
        { clientId: 'first-client-id', clientSecret: 'first-client-secret' },
        { clientId: 'second-client-id', clientSecret: 'second-client-secret' }
      ]
    }, {
      fetchWithTimeout: async (_url, init) => {
        const body = Object.fromEntries(new URLSearchParams(String(init && init.body || '')));
        calls.push(body);
        return {
          ok: false,
          status: 400,
          text: async () => JSON.stringify({
            error: 'invalid_grant',
            error_description: 'Bad refresh token.'
          })
        };
      }
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'refresh_invalid_grant');
    assert.deepEqual(calls.map((body) => body.client_id), ['first-client-id']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Agy token refresh prefers cached client metadata over defaults', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-agy-refresh-'));
  try {
    const configDir = path.join(tmpDir, '.gemini', 'antigravity-cli');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'antigravity-oauth-token'), JSON.stringify({
      client_id: 'cached-client-id',
      client_secret: 'cached-client-secret',
      token: {
        access_token: 'old-token',
        refresh_token: 'refresh-token',
        expiry: '2000-01-01T00:00:00Z'
      },
      auth_method: 'consumer'
    }, null, 2));

    let seenBody = null;
    const result = await refreshAgyAccessToken({
      id: '1',
      provider: 'agy',
      authType: 'oauth-personal',
      accessToken: 'old-token',
      configDir
    }, { force: true, nowMs: 1700000000000 }, {
      fetchWithTimeout: async (_url, init) => {
        seenBody = Object.fromEntries(new URLSearchParams(String(init && init.body || '')));
        return {
          ok: true,
          text: async () => JSON.stringify({
            access_token: 'new-token',
            expires_in: 3600
          })
        };
      }
    });

    assert.equal(result.ok, true);
    assert.equal(seenBody.client_id, 'cached-client-id');
    assert.equal(seenBody.client_secret, 'cached-client-secret');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Agy token refresh exposes OAuth error code without raw secret detail', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-agy-refresh-'));
  try {
    const configDir = path.join(tmpDir, '.gemini', 'antigravity-cli');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'antigravity-oauth-token'), JSON.stringify({
      token: {
        access_token: 'old-token',
        refresh_token: 'refresh-token',
        expiry: '2000-01-01T00:00:00Z'
      },
      auth_method: 'consumer'
    }, null, 2));

    const result = await refreshAgyAccessToken({
      id: '1',
      provider: 'agy',
      authType: 'oauth-personal',
      accessToken: 'old-token',
      configDir
    }, { force: true, nowMs: 1700000000000 }, {
      fetchWithTimeout: async () => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({
          error: 'invalid_client',
          error_description: 'The OAuth client is invalid.'
        })
      })
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'refresh_invalid_client');
    assert.equal(result.oauthError, 'invalid_client');
    assert.equal(result.detail, 'The OAuth client is invalid.');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('shouldRefreshToken forces refresh when access_token is empty and no expiry info', () => {
  // Account has only a refresh_token — no access_token and no expiry info.
  // The daemon must still attempt a refresh so the account can self-heal.
  const accountWithoutAccessToken = {
    provider: 'agy',
    accessToken: '',
    refreshToken: 'agy-refresh',
    tokenExpiresAt: null,
    configDir: '/nonexistent'
  };
  const nowMs = Date.now();
  const skewMs = 5 * 60 * 1000;

  // Import the private function via the module's __private export
  const result = __private.shouldRefreshToken(accountWithoutAccessToken, nowMs, skewMs);
  assert.equal(result, true, 'should force refresh when access_token is absent');
});

test('shouldRefreshToken does not force refresh when access_token is present and expiry is unknown', () => {
  const accountWithAccessToken = {
    provider: 'agy',
    accessToken: 'valid-token',
    refreshToken: 'agy-refresh',
    tokenExpiresAt: null,
    configDir: '/nonexistent'
  };
  const nowMs = Date.now();
  const skewMs = 5 * 60 * 1000;

  const result = __private.shouldRefreshToken(accountWithAccessToken, nowMs, skewMs);
  assert.equal(result, false, 'should not force refresh when access_token is present');
});
