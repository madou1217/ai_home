const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  refreshGeminiAccessToken,
  __private
} = require('../lib/server/gemini-token-refresh');

test('Gemini token refresh reads Gemini CLI expiry_date', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-gemini-refresh-'));
  try {
    const configDir = path.join(tmpDir, '.gemini');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'oauth_creds.json'), JSON.stringify({
      access_token: 'token',
      refresh_token: 'refresh',
      expiry_date: 4102444800000
    }, null, 2));

    const expiresAt = __private.resolveTokenExpiryMs({ provider: 'gemini', configDir });

    assert.equal(expiresAt, 4102444800000);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Gemini token refresh uses CLI client defaults when cached creds omit client metadata', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-gemini-refresh-'));
  try {
    const configDir = path.join(tmpDir, '.gemini');
    fs.mkdirSync(configDir, { recursive: true });
    const oauthPath = path.join(configDir, 'oauth_creds.json');
    fs.writeFileSync(oauthPath, JSON.stringify({
      access_token: 'old-token',
      refresh_token: 'refresh-token',
      expiry_date: Date.now() - 60_000
    }, null, 2));

    let seenBody = null;
    const result = await refreshGeminiAccessToken({
      id: '1',
      provider: 'gemini',
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
            expires_in: 3600
          })
        };
      }
    });

    const saved = JSON.parse(fs.readFileSync(oauthPath, 'utf8'));

    assert.equal(result.ok, true);
    assert.equal(seenBody.client_id, '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com');
    assert.equal(typeof seenBody.client_secret, 'string');
    assert.ok(seenBody.client_secret.length > 0);
    assert.equal(seenBody.refresh_token, 'refresh-token');
    assert.equal(saved.access_token, 'new-token');
    assert.equal(saved.expires_at, 1700003600000);
    assert.equal(saved.expiry_date, 1700003600000);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
