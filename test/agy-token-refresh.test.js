'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { registerAccountIdentity } = require('../lib/account/account-registration');
const {
  readAccountNativeAuth,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');
const {
  refreshAgyAccessToken,
  __private
} = require('../lib/server/agy-token-refresh');

function createFixture(t, oauthToken = {}) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-agy-refresh-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const registration = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'agy',
    cliAccountId: '1',
    identitySeed: 'oauth:agy:refresh@example.com'
  });
  const nativeAuth = {
    oauthToken: {
      auth_method: 'consumer',
      token: {
        access_token: 'old-token',
        refresh_token: 'refresh-token',
        expiry: '2000-01-01T00:00:00Z'
      },
      ...oauthToken
    }
  };
  writeAccountNativeAuth(fs, aiHomeDir, registration.accountRef, nativeAuth);
  return {
    aiHomeDir,
    accountRef: registration.accountRef,
    account: {
      accountRef: registration.accountRef,
      provider: 'agy',
      authType: 'oauth-personal',
      accessToken: 'old-token',
      tokenExpiresAt: Date.parse('2000-01-01T00:00:00Z')
    },
    deps: { fs, aiHomeDir }
  };
}

function parseRequestBody(init) {
  return Object.fromEntries(new URLSearchParams(String(init && init.body || '')));
}

test('Agy token refresh reads expiry from the canonical account model', () => {
  assert.equal(
    __private.resolveTokenExpiryMs({ tokenExpiresAt: Date.parse('2100-01-01T00:00:00Z') }),
    Date.parse('2100-01-01T00:00:00Z')
  );
});

test('Agy token refresh uses CLI client defaults and persists refreshed auth to DB', async (t) => {
  const fixture = createFixture(t);
  let seenBody = null;
  const result = await refreshAgyAccessToken(fixture.account, {
    force: true,
    nowMs: 1700000000000
  }, {
    ...fixture.deps,
    fetchWithTimeout: async (_url, init) => {
      seenBody = parseRequestBody(init);
      assert.match(String(init.headers && init.headers['content-type'] || ''), /application\/x-www-form-urlencoded/);
      return {
        ok: true,
        text: async () => JSON.stringify({
          access_token: 'new-token',
          refresh_token: 'new-refresh-token',
          token_type: 'Bearer',
          expires_in: 3600,
          id_token: 'header.eyJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20ifQ.signature' // gitleaks:allow
        })
      };
    }
  });

  const saved = readAccountNativeAuth(fs, fixture.aiHomeDir, fixture.accountRef);
  const defaultCredential = __private.resolveAgyOAuthClientCredentialCandidates({}, {})[0];
  assert.equal(result.ok, true);
  assert.equal(result.persisted, true);
  assert.equal(seenBody.client_id, defaultCredential.clientId);
  assert.equal(seenBody.client_secret, defaultCredential.clientSecret);
  assert.equal(seenBody.refresh_token, 'refresh-token');
  assert.equal(saved.oauthToken.token.access_token, 'new-token');
  assert.equal(saved.oauthToken.token.refresh_token, 'new-refresh-token');
  assert.equal(saved.oauthToken.token.token_type, 'Bearer');
  assert.equal(saved.oauthToken.token.expiry, new Date(1700003600000).toISOString());
  assert.equal(saved.email, 'test@example.com');
});

test('Agy token refresh refreshes an expired token without force', async (t) => {
  const fixture = createFixture(t);
  let calls = 0;
  const result = await refreshAgyAccessToken(fixture.account, {
    force: false,
    nowMs: 1700000000000
  }, {
    ...fixture.deps,
    fetchWithTimeout: async () => {
      calls += 1;
      return {
        ok: true,
        text: async () => JSON.stringify({ access_token: 'new-token', expires_in: 3600 })
      };
    }
  });

  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.refreshed, true);
  assert.equal(fixture.account.accessToken, 'new-token');
});

test('Agy token refresh tries the next client credential after invalid_client', async (t) => {
  const fixture = createFixture(t);
  const calls = [];
  const result = await refreshAgyAccessToken(fixture.account, {
    force: true,
    nowMs: 1700000000000,
    clientCredentials: [
      { clientId: 'bad-client-id', clientSecret: 'bad-client-secret' },
      { clientId: 'good-client-id', clientSecret: 'good-client-secret' }
    ]
  }, {
    ...fixture.deps,
    fetchWithTimeout: async (_url, init) => {
      const body = parseRequestBody(init);
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
        text: async () => JSON.stringify({ access_token: 'new-token', expires_in: 3600 })
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.refreshed, true);
  assert.deepEqual(calls.map((body) => body.client_id), ['bad-client-id', 'good-client-id']);
  assert.equal(
    readAccountNativeAuth(fs, fixture.aiHomeDir, fixture.accountRef).oauthToken.token.access_token,
    'new-token'
  );
});

test('Agy token refresh decodes gzip invalid_client before trying the next credential', async (t) => {
  const fixture = createFixture(t);
  const calls = [];
  const compressedError = zlib.gzipSync(Buffer.from(JSON.stringify({
    error: 'invalid_client',
    error_description: 'The provided client secret is invalid.'
  })));
  const result = await refreshAgyAccessToken(fixture.account, {
    force: true,
    nowMs: 1700000000000,
    clientCredentials: [
      { clientId: 'bad-client-id', clientSecret: 'bad-client-secret' },
      { clientId: 'good-client-id', clientSecret: 'good-client-secret' }
    ]
  }, {
    ...fixture.deps,
    fetchWithTimeout: async (_url, init) => {
      const body = parseRequestBody(init);
      calls.push(body);
      if (body.client_id === 'bad-client-id') {
        return {
          ok: false,
          status: 401,
          headers: new Map([['content-encoding', 'gzip']]),
          arrayBuffer: async () => compressedError,
          text: async () => compressedError.toString('latin1')
        };
      }
      return {
        ok: true,
        text: async () => JSON.stringify({ access_token: 'new-token', expires_in: 3600 })
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.refreshed, true);
  assert.deepEqual(calls.map((body) => body.client_id), ['bad-client-id', 'good-client-id']);
});

test('Agy token refresh does not rotate client credentials after invalid_grant', async (t) => {
  const fixture = createFixture(t);
  const calls = [];
  const result = await refreshAgyAccessToken(fixture.account, {
    force: true,
    nowMs: 1700000000000,
    clientCredentials: [
      { clientId: 'first-client-id', clientSecret: 'first-client-secret' },
      { clientId: 'second-client-id', clientSecret: 'second-client-secret' }
    ]
  }, {
    ...fixture.deps,
    fetchWithTimeout: async (_url, init) => {
      calls.push(parseRequestBody(init));
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
});

test('Agy token refresh prefers cached DB client metadata over defaults', async (t) => {
  const fixture = createFixture(t, {
    client_id: 'cached-client-id',
    client_secret: 'cached-client-secret'
  });
  let seenBody = null;
  const result = await refreshAgyAccessToken(fixture.account, {
    force: true,
    nowMs: 1700000000000
  }, {
    ...fixture.deps,
    fetchWithTimeout: async (_url, init) => {
      seenBody = parseRequestBody(init);
      return {
        ok: true,
        text: async () => JSON.stringify({ access_token: 'new-token', expires_in: 3600 })
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(seenBody.client_id, 'cached-client-id');
  assert.equal(seenBody.client_secret, 'cached-client-secret');
});

test('Agy token refresh exposes OAuth error code without raw secret detail', async (t) => {
  const fixture = createFixture(t);
  const result = await refreshAgyAccessToken(fixture.account, {
    force: true,
    nowMs: 1700000000000,
    clientCredentials: [
      { clientId: 'client-id', clientSecret: 'client-secret' }
    ]
  }, {
    ...fixture.deps,
    fetchWithTimeout: async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({
        error: 'invalid_client',
        error_description: 'The OAuth client-secret rejected refresh-token.'
      })
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'refresh_invalid_client');
  assert.equal(result.oauthError, 'invalid_client');
  assert.equal(result.detail, 'The OAuth [redacted] rejected [redacted].');
  assert.doesNotMatch(JSON.stringify(result), /refresh-token|client-secret/);
});

test('Agy token refresh redacts credentials echoed by the OAuth endpoint', async (t) => {
  const fixture = createFixture(t);
  const result = await refreshAgyAccessToken(fixture.account, {
    force: true,
    nowMs: 1700000000000,
    clientCredentials: [{
      clientId: 'test-client-id',
      clientSecret: 'echoed-client-secret'
    }]
  }, {
    ...fixture.deps,
    fetchWithTimeout: async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({
        error: 'invalid_grant',
        error_description: 'refresh-token echoed-client-secret old-token'
      })
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'refresh_invalid_grant');
  assert.match(result.detail, /\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(result), /refresh-token|echoed-client-secret|old-token/);
});

test('Agy token refresh redacts credentials echoed by a transport exception', async (t) => {
  const fixture = createFixture(t);
  const clientSecret = 'exception/client+secret';
  const encodedClientSecret = encodeURIComponent(clientSecret);
  const result = await refreshAgyAccessToken(fixture.account, {
    force: true,
    nowMs: 1700000000000,
    clientCredentials: [{
      clientId: 'test-client-id',
      clientSecret
    }]
  }, {
    ...fixture.deps,
    fetchWithTimeout: async () => {
      throw new Error(`network failure refresh-token old-token ${encodedClientSecret}`);
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'refresh_exception');
  assert.match(result.detail, /\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`refresh-token|old-token|${encodedClientSecret}`));
});

test('shouldRefreshToken forces refresh when access_token is empty and expiry is unknown', () => {
  const nowMs = Date.now();
  assert.equal(__private.shouldRefreshToken({
    provider: 'agy',
    accessToken: '',
    refreshToken: 'agy-refresh',
    tokenExpiresAt: null
  }, nowMs, 5 * 60 * 1000), true);
});

test('shouldRefreshToken keeps an access token with unknown expiry', () => {
  const nowMs = Date.now();
  assert.equal(__private.shouldRefreshToken({
    provider: 'agy',
    accessToken: 'valid-token',
    refreshToken: 'agy-refresh',
    tokenExpiresAt: null
  }, nowMs, 5 * 60 * 1000), false);
});
