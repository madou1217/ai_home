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
const { refreshClaudeAccessToken } = require('../lib/server/claude-token-refresh');

test('claude refresh posts the official contract and persists refreshed auth to DB', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-refresh-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const registration = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'claude',
    cliAccountId: '4',
    identitySeed: 'oauth:claude:refresh@example.com'
  });
  writeAccountNativeAuth(fs, aiHomeDir, registration.accountRef, {
    credentials: {
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-old',
        refreshToken: 'sk-ant-ort01-refresh',
        expiresAt: Date.now() - 60_000
      }
    }
  });

  const calls = [];
  const result = await refreshClaudeAccessToken({
    accountRef: registration.accountRef,
    provider: 'claude',
    tokenExpiresAt: Date.now() - 60_000
  }, { force: true }, {
    fs,
    aiHomeDir,
    fetchWithTimeout: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: 'sk-ant-oat01-new',
          refresh_token: 'sk-ant-ort01-new',
          expires_in: 3600
        })
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.refreshed, true);
  assert.equal(result.persisted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://platform.claude.com/v1/oauth/token');
  assert.equal(calls[0].body.grant_type, 'refresh_token');
  assert.equal(calls[0].body.refresh_token, 'sk-ant-ort01-refresh');
  assert.equal(calls[0].body.client_id, '9d1c250a-e61b-44d9-88ed-5944d1962f5e');
  assert.match(String(calls[0].body.scope), /user:inference/);

  const persisted = readAccountNativeAuth(fs, aiHomeDir, registration.accountRef);
  assert.equal(persisted.credentials.claudeAiOauth.accessToken, 'sk-ant-oat01-new');
  assert.equal(persisted.credentials.claudeAiOauth.refreshToken, 'sk-ant-ort01-new');
});

test('claude refresh decodes a headerless gzip success response and requests identity encoding', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-refresh-gzip-success-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const registration = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'claude',
    cliAccountId: '8',
    identitySeed: 'oauth:claude:gzip-success@example.com'
  });
  writeAccountNativeAuth(fs, aiHomeDir, registration.accountRef, {
    credentials: {
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-gzip-old',
        refreshToken: 'sk-ant-ort01-gzip-refresh',
        expiresAt: Date.now() - 60_000
      }
    }
  });

  let requestOptions;
  const responseBody = zlib.gzipSync(Buffer.from(JSON.stringify({
    access_token: 'sk-ant-oat01-gzip-new',
    refresh_token: 'sk-ant-ort01-gzip-new',
    expires_in: 3600
  })));
  const result = await refreshClaudeAccessToken({
    accountRef: registration.accountRef,
    provider: 'claude',
    tokenExpiresAt: Date.now() - 60_000
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
  assert.equal(persisted.credentials.claudeAiOauth.accessToken, 'sk-ant-oat01-gzip-new');
  assert.equal(persisted.credentials.claudeAiOauth.refreshToken, 'sk-ant-ort01-gzip-new');
});

test('claude refresh safely parses a headerless gzip error without exposing secrets or raw body', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-refresh-gzip-error-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const registration = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'claude',
    cliAccountId: '11',
    identitySeed: 'oauth:claude:gzip-error@example.com'
  });
  const accessToken = 'sk-ant-oat01-gzip-sensitive-access';
  const refreshToken = 'sk-ant-ort01-gzip-sensitive-refresh';
  writeAccountNativeAuth(fs, aiHomeDir, registration.accountRef, {
    credentials: {
      claudeAiOauth: {
        accessToken,
        refreshToken,
        expiresAt: Date.now() - 60_000
      }
    }
  });

  const responseBody = zlib.gzipSync(Buffer.from(JSON.stringify({
    error: 'invalid_grant',
    error_description: `refresh ${refreshToken}; access ${accessToken}`,
    diagnostic: 'raw-body-marker-must-not-leak'
  })));
  const result = await refreshClaudeAccessToken({
    accountRef: registration.accountRef,
    provider: 'claude',
    accessToken,
    tokenExpiresAt: Date.now() - 60_000
  }, { force: true }, {
    fs,
    aiHomeDir,
    fetchWithTimeout: async () => ({
      ok: false,
      status: 400,
      arrayBuffer: async () => responseBody
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'refresh_http_400');
  assert.match(result.detail, /^invalid_grant:/u);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /gzip-sensitive|sk-ant-/u);
  assert.doesNotMatch(serialized, /raw-body-marker-must-not-leak/u);
});

test('claude refresh never exposes echoed OAuth secrets in failure detail', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-refresh-redaction-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const registration = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'claude',
    cliAccountId: '9',
    identitySeed: 'oauth:claude:redaction@example.com'
  });
  const accessToken = 'sk-ant-oat01-sensitive-access';
  const refreshToken = 'sk-ant-ort01-sensitive-refresh';
  writeAccountNativeAuth(fs, aiHomeDir, registration.accountRef, {
    credentials: {
      claudeAiOauth: {
        accessToken,
        refreshToken,
        expiresAt: Date.now() - 60_000
      }
    }
  });

  const result = await refreshClaudeAccessToken({
    accountRef: registration.accountRef,
    provider: 'claude',
    accessToken,
    tokenExpiresAt: Date.now() - 60_000
  }, { force: true }, {
    fs,
    aiHomeDir,
    fetchWithTimeout: async () => ({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({
        error: refreshToken,
        error_description: `refresh ${refreshToken}; access ${accessToken}`
      })
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'refresh_http_500');
  assert.match(result.detail, /oauth_token_endpoint_error/u);
  assert.doesNotMatch(result.detail, /sensitive-access|sensitive-refresh/u);
  assert.doesNotMatch(result.detail, /sk-ant-/u);
});

test('claude refresh redacts OAuth secrets from thrown executor errors', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-refresh-exception-redaction-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const registration = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'claude',
    cliAccountId: '10',
    identitySeed: 'oauth:claude:exception-redaction@example.com'
  });
  const accessToken = 'sk-ant-oat01-sensitive-exception-access';
  const refreshToken = 'sk-ant-ort01-sensitive-exception-refresh';
  writeAccountNativeAuth(fs, aiHomeDir, registration.accountRef, {
    credentials: {
      claudeAiOauth: {
        accessToken,
        refreshToken,
        expiresAt: Date.now() - 60_000
      }
    }
  });

  const result = await refreshClaudeAccessToken({
    accountRef: registration.accountRef,
    provider: 'claude',
    accessToken,
    tokenExpiresAt: Date.now() - 60_000
  }, { force: true }, {
    fs,
    aiHomeDir,
    fetchWithTimeout: async () => {
      throw new Error(`refresh ${refreshToken}; access ${accessToken}`);
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'refresh_exception');
  assert.match(result.detail, /\[redacted\]/u);
  assert.doesNotMatch(result.detail, /sensitive-exception/u);
  assert.doesNotMatch(result.detail, /sk-ant-/u);
});
