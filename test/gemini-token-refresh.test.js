const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { upsertAccountRef } = require('../lib/server/account-ref-store');
const {
  readAccountNativeAuth,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');

const {
  refreshGeminiAccessToken,
  __private
} = require('../lib/server/gemini-token-refresh');

test('Gemini token refresh reads expiry from the canonical account model', () => {
  assert.equal(
    __private.resolveTokenExpiryMs({ provider: 'gemini', tokenExpiresAt: 4102444800000 }),
    4102444800000
  );
});

test('Gemini token refresh uses CLI client defaults and persists refreshed auth to DB', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-gemini-refresh-'));
  try {
    const accountRef = upsertAccountRef(fs, aiHomeDir, {
      provider: 'gemini',
      cliAccountId: '1',
      identitySeed: 'oauth:gemini:refresh@example.com'
    });
    writeAccountNativeAuth(fs, aiHomeDir, accountRef, { oauthCreds: {
      access_token: 'old-token',
      refresh_token: 'refresh-token',
      expiry_date: Date.now() - 60_000
    } });

    let seenBody = null;
    const result = await refreshGeminiAccessToken({
      accountRef,
      provider: 'gemini',
      authType: 'oauth-personal',
      accessToken: 'old-token',
      tokenExpiresAt: Date.now() - 60_000
    }, { force: true, nowMs: 1700000000000 }, {
      fs,
      aiHomeDir,
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

    const saved = readAccountNativeAuth(fs, aiHomeDir, accountRef).oauthCreds;

    assert.equal(result.ok, true);
    assert.equal(seenBody.client_id, '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com');
    assert.equal(typeof seenBody.client_secret, 'string');
    assert.ok(seenBody.client_secret.length > 0);
    assert.equal(seenBody.refresh_token, 'refresh-token');
    assert.equal(saved.access_token, 'new-token');
    assert.equal(saved.expires_at, 1700003600000);
    assert.equal(saved.expiry_date, 1700003600000);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});
