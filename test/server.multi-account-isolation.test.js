'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { refreshCodexAccessToken } = require('../lib/server/codex-token-refresh');
const { refreshGeminiAccessToken } = require('../lib/server/gemini-token-refresh');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const {
  readAccountNativeAuth,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');

function createFixture(t, prefix) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  return aiHomeDir;
}

function registerAccount(aiHomeDir, provider, cliAccountId, nativeAuth) {
  const registration = registerAccountIdentity(fs, aiHomeDir, {
    provider,
    cliAccountId,
    identitySeed: `oauth:${provider}:isolation-${cliAccountId}@example.com`
  });
  writeAccountNativeAuth(fs, aiHomeDir, registration.accountRef, nativeAuth);
  return registration.accountRef;
}

describe('Multi-Account Isolation', () => {
  it('isolates concurrent Codex refreshes by accountRef', async (t) => {
    const aiHomeDir = createFixture(t, 'aih-codex-isolation-db-');
    const account1Ref = registerAccount(aiHomeDir, 'codex', '1', {
      auth: {
        tokens: {
          access_token: 'old_token_account_1',
          refresh_token: 'rt_refresh_1',
          id_token: 'id_token_1',
          account_id: 'acc_1'
        },
        last_refresh: '2026-01-01T00:00:00.000Z'
      }
    });
    const account2Ref = registerAccount(aiHomeDir, 'codex', '2', {
      auth: {
        tokens: {
          access_token: 'old_token_account_2',
          refresh_token: 'rt_refresh_2',
          id_token: 'id_token_2',
          account_id: 'acc_2'
        },
        last_refresh: '2026-01-01T00:00:00.000Z'
      }
    });
    const expiresAt = Date.now() + 2 * 60 * 1000;
    const accounts = [
      { provider: 'codex', accountRef: account1Ref, upstreamAccountId: 'acc_1', refreshToken: 'rt_refresh_1', accessToken: 'old_token_account_1', tokenExpiresAt: expiresAt },
      { provider: 'codex', accountRef: account2Ref, upstreamAccountId: 'acc_2', refreshToken: 'rt_refresh_2', accessToken: 'old_token_account_2', tokenExpiresAt: expiresAt }
    ];
    const mockFetch = async (_url, options) => {
      const refreshToken = JSON.parse(options.body).refresh_token;
      return {
        ok: true,
        text: async () => JSON.stringify({
          access_token: refreshToken === 'rt_refresh_1' ? 'NEW_TOKEN_ACCOUNT_1' : 'NEW_TOKEN_ACCOUNT_2',
          refresh_token: refreshToken,
          expires_in: 3600
        })
      };
    };

    const results = await Promise.all(accounts.map((account) => refreshCodexAccessToken(
      account,
      { force: true, timeoutMs: 5000 },
      { fs, aiHomeDir, fetchWithTimeout: mockFetch }
    )));

    assert.equal(results.every((result) => result.ok && result.refreshed), true);
    const refreshed1 = readAccountNativeAuth(fs, aiHomeDir, account1Ref).auth;
    const refreshed2 = readAccountNativeAuth(fs, aiHomeDir, account2Ref).auth;
    assert.equal(refreshed1.tokens.access_token, 'NEW_TOKEN_ACCOUNT_1');
    assert.equal(refreshed1.tokens.refresh_token, 'rt_refresh_1');
    assert.equal(refreshed2.tokens.access_token, 'NEW_TOKEN_ACCOUNT_2');
    assert.equal(refreshed2.tokens.refresh_token, 'rt_refresh_2');
    assert.notEqual(refreshed1.tokens.access_token, refreshed2.tokens.access_token);
    assert.notEqual(refreshed1.last_refresh, '2026-01-01T00:00:00.000Z');
    assert.notEqual(refreshed2.last_refresh, '2026-01-01T00:00:00.000Z');
  });

  it('isolates concurrent Gemini refreshes by accountRef', async (t) => {
    const aiHomeDir = createFixture(t, 'aih-gemini-isolation-db-');
    const expiresAt = Date.now() + 2 * 60 * 1000;
    const account1Ref = registerAccount(aiHomeDir, 'gemini', '1', { oauthCreds: {
      access_token: 'old_gemini_token_1',
      refresh_token: 'gemini_refresh_1',
      client_id: 'client_1',
      client_secret: 'secret_1',
      expires_at: expiresAt
    } });
    const account2Ref = registerAccount(aiHomeDir, 'gemini', '2', { oauthCreds: {
      access_token: 'old_gemini_token_2',
      refresh_token: 'gemini_refresh_2',
      client_id: 'client_2',
      client_secret: 'secret_2',
      expires_at: expiresAt
    } });
    const accounts = [
      { provider: 'gemini', accountRef: account1Ref, authType: 'oauth-personal', accessToken: 'old_gemini_token_1', tokenExpiresAt: expiresAt },
      { provider: 'gemini', accountRef: account2Ref, authType: 'oauth-personal', accessToken: 'old_gemini_token_2', tokenExpiresAt: expiresAt }
    ];
    const mockFetch = async (_url, options) => {
      const refreshToken = JSON.parse(options.body).refresh_token;
      return {
        ok: true,
        text: async () => JSON.stringify({
          access_token: refreshToken === 'gemini_refresh_1' ? 'NEW_GEMINI_TOKEN_1' : 'NEW_GEMINI_TOKEN_2',
          expires_in: 3600
        })
      };
    };

    await Promise.all(accounts.map((account) => refreshGeminiAccessToken(
      account,
      { force: true },
      { fs, aiHomeDir, fetchWithTimeout: mockFetch }
    )));

    const refreshed1 = readAccountNativeAuth(fs, aiHomeDir, account1Ref).oauthCreds;
    const refreshed2 = readAccountNativeAuth(fs, aiHomeDir, account2Ref).oauthCreds;
    assert.equal(refreshed1.access_token, 'NEW_GEMINI_TOKEN_1');
    assert.equal(refreshed2.access_token, 'NEW_GEMINI_TOKEN_2');
    assert.notEqual(refreshed1.access_token, refreshed2.access_token);
  });

  it('isolates providers that share the same CLI selector', async (t) => {
    const aiHomeDir = createFixture(t, 'aih-cross-provider-isolation-db-');
    const expiresAt = Date.now() + 2 * 60 * 1000;
    const codexRef = registerAccount(aiHomeDir, 'codex', '1', { auth: {
      tokens: {
        access_token: 'codex_token',
        refresh_token: 'rt_codex_refresh',
        id_token: 'id_token',
        account_id: 'upstream_codex_1'
      }
    } });
    const geminiRef = registerAccount(aiHomeDir, 'gemini', '1', { oauthCreds: {
      access_token: 'gemini_token',
      refresh_token: 'gemini_refresh',
      client_id: 'client',
      client_secret: 'secret',
      expires_at: expiresAt
    } });
    assert.notEqual(codexRef, geminiRef);

    const mockFetch = async () => ({
      ok: true,
      text: async () => JSON.stringify({
        access_token: 'NEW_TOKEN',
        refresh_token: 'rt_new',
        expires_in: 3600
      })
    });
    await Promise.all([
      refreshCodexAccessToken({
        provider: 'codex',
        accountRef: codexRef,
        upstreamAccountId: 'upstream_codex_1',
        refreshToken: 'rt_codex_refresh',
        tokenExpiresAt: expiresAt
      }, { force: true }, { fs, aiHomeDir, fetchWithTimeout: mockFetch }),
      refreshGeminiAccessToken({
        provider: 'gemini',
        accountRef: geminiRef,
        authType: 'oauth-personal',
        tokenExpiresAt: expiresAt
      }, { force: true }, { fs, aiHomeDir, fetchWithTimeout: mockFetch })
    ]);

    const refreshedCodex = readAccountNativeAuth(fs, aiHomeDir, codexRef).auth;
    const refreshedGemini = readAccountNativeAuth(fs, aiHomeDir, geminiRef).oauthCreds;
    assert.equal(refreshedCodex.tokens.access_token, 'NEW_TOKEN');
    assert.equal(refreshedGemini.access_token, 'NEW_TOKEN');
    assert.ok(refreshedCodex.tokens);
    assert.equal(Object.hasOwn(refreshedGemini, 'tokens'), false);
  });
});
