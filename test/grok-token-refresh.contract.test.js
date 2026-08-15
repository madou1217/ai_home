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
const { refreshGrokAccessToken } = require('../lib/server/grok-token-refresh');

function createSampleJwt(expSeconds) {
  const header = Buffer.from(JSON.stringify({ typ: 'at+jwt', alg: 'ES256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'https://auth.x.ai',
    sub: 'user-123',
    aud: 'b1a00492-073a-47ea-816f-4c329264a828',
    client_id: 'b1a00492-073a-47ea-816f-4c329264a828',
    exp: expSeconds
  })).toString('base64url');
  return `${header}.${payload}.mock-sig`;
}

test('grok refresh posts the official contract and persists refreshed auth to DB', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-refresh-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const registration = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'grok',
    cliAccountId: '1',
    identitySeed: 'oauth:grok:refresh@example.com'
  });

  const oldExp = Math.floor((Date.now() - 60_000) / 1000);
  const newExp = Math.floor((Date.now() + 21600_000) / 1000);
  const oldAccessToken = createSampleJwt(oldExp);
  const newAccessToken = createSampleJwt(newExp);

  writeAccountNativeAuth(fs, aiHomeDir, registration.accountRef, {
    auth: {
      'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': {
        key: oldAccessToken,
        refresh_token: 'grok-refresh-token-1',
        email: 'user@example.com',
        oidc_client_id: 'b1a00492-073a-47ea-816f-4c329264a828',
        oidc_issuer: 'https://auth.x.ai',
        expires_at: new Date(oldExp * 1000).toISOString()
      }
    }
  });

  const calls = [];
  const result = await refreshGrokAccessToken({
    accountRef: registration.accountRef,
    provider: 'grok',
    tokenExpiresAt: oldExp * 1000
  }, { force: true }, {
    fs,
    aiHomeDir,
    fetchWithTimeout: async (url, options) => {
      const parsedBody = Object.fromEntries(new URLSearchParams(options.body).entries());
      calls.push({ url, body: parsedBody, headers: options.headers });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: newAccessToken,
          refresh_token: 'grok-refresh-token-2',
          expires_in: 21600
        })
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.refreshed, true);
  assert.equal(result.persisted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://auth.x.ai/oauth2/token');
  assert.equal(calls[0].headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(calls[0].body.grant_type, 'refresh_token');
  assert.equal(calls[0].body.refresh_token, 'grok-refresh-token-1');
  assert.equal(calls[0].body.client_id, 'b1a00492-073a-47ea-816f-4c329264a828');

  const persisted = readAccountNativeAuth(fs, aiHomeDir, registration.accountRef);
  const profile = persisted.auth['https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828'];
  assert.equal(profile.key, newAccessToken);
  assert.equal(profile.refresh_token, 'grok-refresh-token-2');
});

test('grok refresh decodes a headerless gzip success response', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-refresh-gzip-success-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const registration = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'grok',
    cliAccountId: '2',
    identitySeed: 'oauth:grok:gzip-success@example.com'
  });

  const oldExp = Math.floor((Date.now() - 60_000) / 1000);
  const newExp = Math.floor((Date.now() + 21600_000) / 1000);
  const oldAccessToken = createSampleJwt(oldExp);
  const newAccessToken = createSampleJwt(newExp);

  writeAccountNativeAuth(fs, aiHomeDir, registration.accountRef, {
    auth: {
      'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': {
        key: oldAccessToken,
        refresh_token: 'grok-gzip-refresh-1',
        expires_at: new Date(oldExp * 1000).toISOString()
      }
    }
  });

  let requestOptions;
  const responseBody = zlib.gzipSync(Buffer.from(JSON.stringify({
    access_token: newAccessToken,
    refresh_token: 'grok-gzip-refresh-2',
    expires_in: 21600
  })));

  const result = await refreshGrokAccessToken({
    accountRef: registration.accountRef,
    provider: 'grok',
    tokenExpiresAt: oldExp * 1000
  }, { force: true }, {
    fs,
    aiHomeDir,
    fetchWithTimeout: async (_url, options) => {
      requestOptions = options;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => responseBody
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.refreshed, true);
  assert.equal(requestOptions.headers['accept-encoding'], 'identity');
  const persisted = readAccountNativeAuth(fs, aiHomeDir, registration.accountRef);
  const profile = persisted.auth['https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828'];
  assert.equal(profile.key, newAccessToken);
  assert.equal(profile.refresh_token, 'grok-gzip-refresh-2');
});

test('grok refresh safely parses an error response without exposing secrets', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-refresh-error-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const registration = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'grok',
    cliAccountId: '3',
    identitySeed: 'oauth:grok:error@example.com'
  });

  const refreshToken = 'grok-sensitive-refresh-token';
  const accessToken = createSampleJwt(Math.floor((Date.now() - 60_000) / 1000));

  writeAccountNativeAuth(fs, aiHomeDir, registration.accountRef, {
    auth: {
      'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': {
        key: accessToken,
        refresh_token: refreshToken
      }
    }
  });

  const result = await refreshGrokAccessToken({
    accountRef: registration.accountRef,
    provider: 'grok',
    accessToken,
    refreshToken
  }, { force: true }, {
    fs,
    aiHomeDir,
    fetchWithTimeout: async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({
        error: 'invalid_grant',
        error_description: `refresh_token ${refreshToken} is expired`
      })
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'refresh_http_400');
  assert.match(result.detail, /^invalid_grant:/u);
  assert.doesNotMatch(result.detail, /sensitive-refresh/u);
});
