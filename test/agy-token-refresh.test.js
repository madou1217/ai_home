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
        seenBody = JSON.parse(String(init && init.body || '{}'));
        return {
          ok: true,
          text: async () => JSON.stringify({
            access_token: 'new-token',
            expires_in: 3600,
            id_token: 'header.eyJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20ifQ.signature'
          })
        };
      }
    });

    const saved = JSON.parse(fs.readFileSync(oauthPath, 'utf8'));
    const cachePath = path.join(configDir, 'email.cache');
    const cachedEmail = fs.readFileSync(cachePath, 'utf8').trim();

    assert.equal(result.ok, true);
    assert.equal(seenBody.client_id, Buffer.from('MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==', 'base64').toString('utf8'));
    assert.equal(seenBody.client_secret, Buffer.from('R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6cURBZg==', 'base64').toString('utf8'));
    assert.equal(seenBody.refresh_token, 'refresh-token');
    assert.equal(saved.token.access_token, 'new-token');
    assert.equal(saved.token.expiry, new Date(1700003600000).toISOString());
    assert.equal(cachedEmail, 'test@example.com');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
