'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTokenRefreshDaemon, __private } = require('../lib/server/token-refresh-daemon');
const { ACCOUNT_RUNTIME_CHANGED } = require('../lib/server/account-runtime-event-types');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');

function createAccountFixture(t, prefix = 'aih-token-refresh-daemon-db-') {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  return {
    aiHomeDir,
    register(provider, cliAccountId, nativeAuth) {
      const registration = registerAccountIdentity(fs, aiHomeDir, {
        provider,
        cliAccountId,
        identitySeed: `oauth:${provider}:daemon-${cliAccountId}@example.com`
      });
      writeAccountNativeAuth(fs, aiHomeDir, registration.accountRef, nativeAuth);
      return registration.accountRef;
    }
  };
}

describe('createTokenRefreshDaemon', () => {
  it('should create daemon with stats', () => {
    const state = {
      accounts: {
        codex: [],
        gemini: [],
        claude: []
      }
    };

    const options = {
      tokenRefreshIntervalMs: 60000,
      tokenRefreshBeforeExpiryMs: 300000
    };

    const mockFetch = async () => ({
      ok: true,
      text: async () => '{"access_token": "mock_token", "expires_in": 3600}'
    });

    const daemon = createTokenRefreshDaemon(state, options, {
      fetchWithTimeout: mockFetch,
      logInfo: () => {},
      logWarn: () => {},
      logError: () => {}
    });

    const stats = daemon.getStats();
    assert.equal(stats.refreshIntervalMs, 60000);
    assert.equal(stats.skewMs, 300000);
    assert.equal(typeof stats.tickCount, 'number');
    assert.equal(typeof stats.totalRefreshed, 'number');
    assert.equal(typeof stats.totalErrors, 'number');

    daemon.stop();
  });

  it('should handle empty accounts gracefully', async () => {
    const state = {
      accounts: {
        codex: [],
        gemini: [],
        claude: []
      }
    };

    const options = {};
    const logs = [];

    const mockFetch = async () => ({
      ok: true,
      text: async () => '{"access_token": "mock_token", "expires_in": 3600}'
    });

    const daemon = createTokenRefreshDaemon(state, options, {
      fetchWithTimeout: mockFetch,
      logInfo: (msg) => logs.push({ level: 'info', msg }),
      logWarn: (msg) => logs.push({ level: 'warn', msg }),
      logError: (msg) => logs.push({ level: 'error', msg })
    });

    // 等待启动任务完成
    await new Promise(resolve => setTimeout(resolve, 100));

    daemon.stop();

    // 应该至少有一条完成日志
    const completedLogs = logs.filter(l => l.msg.includes('completed'));
    assert.ok(completedLogs.length > 0);
  });

  it('should refresh codex accounts when needed', async (t) => {
    const nowMs = Date.now();
    const expiresAt = nowMs + 2 * 60 * 1000; // 2 分钟后过期
    const fixture = createAccountFixture(t);
    const accountRef = fixture.register('codex', '1', { auth: {
      tokens: {
        refresh_token: 'rt_mock_refresh_token',
        access_token: 'mock_access_token'
      }
    } });

    const mockAccount = {
      accountRef,
      provider: 'codex',
      refreshToken: 'rt_mock_refresh_token',
      accessToken: 'mock_access_token',
      tokenExpiresAt: expiresAt
    };

    const state = {
      accounts: {
        codex: [mockAccount],
        gemini: [],
        claude: []
      }
    };

    const options = {
      tokenRefreshIntervalMs: 60000,
      tokenRefreshBeforeExpiryMs: 5 * 60 * 1000 // 提前 5 分钟刷新
    };

    let refreshCalled = false;
    const mockFetch = async (url, opts) => {
      if (url.includes('oauth/token')) {
        refreshCalled = true;
        return {
          ok: true,
          text: async () => JSON.stringify({
            access_token: 'new_mock_token',
            refresh_token: 'rt_new_refresh',
            expires_in: 3600
          })
        };
      }
      return { ok: false, text: async () => '' };
    };

    const logs = [];
    const daemon = createTokenRefreshDaemon(state, options, {
      fs,
      aiHomeDir: fixture.aiHomeDir,
      fetchWithTimeout: mockFetch,
      logInfo: (msg) => logs.push({ level: 'info', msg }),
      logWarn: (msg) => logs.push({ level: 'warn', msg }),
      logError: (msg) => logs.push({ level: 'error', msg })
    });

    // 等待启动任务完成
    await new Promise(resolve => setTimeout(resolve, 200));

    daemon.stop();

    // 验证刷新是否被调用
    assert.ok(refreshCalled, 'Token refresh should be called for expiring token');
  });

  it('clears agy auth block after successful token refresh', async (t) => {
    const fixture = createAccountFixture(t, 'aih-token-refresh-daemon-agy-db-');
    const root = fixture.aiHomeDir;
    try {
      const accountRef = fixture.register('agy', '1', {
        email: 'agy@example.com',
        oauthToken: {
        client_id: 'agy-client-id',
        client_secret: 'agy-client-secret',
        token: {
          access_token: 'old-agy-token',
          refresh_token: 'agy-refresh-token',
          expiry: '2000-01-01T00:00:00Z'
        },
        auth_method: 'consumer'
        }
      });

      const account = {
        accountRef,
        provider: 'agy',
        authType: 'oauth-personal',
        accessToken: 'old-agy-token',
        tokenExpiresAt: Date.now() - 60_000,
        email: 'agy@example.com',
        authInvalidUntil: Date.now() + 60_000,
        consecutiveFailures: 1,
        lastError: 'auth_invalid_reauth_required'
      };
      const state = {
        accounts: {
          codex: [],
          gemini: [],
          claude: [],
          agy: [account]
        }
      };
      const clears = [];
      const events = [];

      const daemon = createTokenRefreshDaemon(state, {
        tokenRefreshIntervalMs: 60000,
        tokenStartupRefreshBeforeExpiryMs: 5 * 60 * 1000
      }, {
        fs,
        aiHomeDir: fixture.aiHomeDir,
        fetchWithTimeout: async (_url, init) => {
          const body = Object.fromEntries(new URLSearchParams(String(init && init.body || '')));
          assert.equal(body.client_id, 'agy-client-id');
          assert.equal(body.client_secret, 'agy-client-secret');
          assert.equal(body.refresh_token, 'agy-refresh-token');
          return {
            ok: true,
            text: async () => JSON.stringify({
              access_token: 'new-agy-token',
              refresh_token: 'agy-refresh-token',
              expires_in: 3600
            })
          };
        },
        accountStateService: {
          clearRuntimeBlock(actualAccountRef, provider, options) {
            clears.push({ accountRef: actualAccountRef, provider, options });
            return true;
          }
        },
        hub: {
          emit(name, event) {
            events.push({ name, event });
          }
        },
        logInfo: () => {},
        logWarn: () => {},
        logError: () => {}
      });

      await new Promise(resolve => setTimeout(resolve, 200));
      daemon.stop();

      assert.equal(account.accessToken, 'new-agy-token');
      assert.equal(account.authInvalidUntil, 0);
      assert.equal(account.consecutiveFailures, 0);
      assert.equal(account.lastError, '');
      assert.equal(clears.length, 1);
      assert.equal(clears[0].provider, 'agy');
      assert.equal(clears[0].accountRef, accountRef);
      assert.equal(clears[0].options.evidence, 'token_refresh_success');
      assert.equal(events.length, 1);
      assert.equal(events[0].event.reason, 'token_refresh_success');
      assert.equal(events[0].event.reloadPool, true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not clear agy runtime memory when persisted clear is rejected', async (t) => {
    const fixture = createAccountFixture(t, 'aih-token-refresh-daemon-agy-rejected-db-');
    const root = fixture.aiHomeDir;
    try {
      const accountRef = fixture.register('agy', '1', {
        email: 'agy@example.com',
        oauthToken: {
        client_id: 'agy-client-id',
        client_secret: 'agy-client-secret',
        token: {
          access_token: 'old-agy-token',
          refresh_token: 'agy-refresh-token',
          expiry: '2000-01-01T00:00:00Z'
        },
        auth_method: 'consumer'
        }
      });

      const account = {
        accountRef,
        provider: 'agy',
        authType: 'oauth-personal',
        accessToken: 'old-agy-token',
        tokenExpiresAt: Date.now() - 60_000,
        email: 'agy@example.com',
        authInvalidUntil: Date.now() + 60_000,
        consecutiveFailures: 1,
        lastError: 'agy_not_signed_in'
      };
      const state = {
        accounts: {
          codex: [],
          gemini: [],
          claude: [],
          agy: [account]
        }
      };
      const clears = [];
      const events = [];

      const daemon = createTokenRefreshDaemon(state, {
        tokenRefreshIntervalMs: 60000,
        tokenStartupRefreshBeforeExpiryMs: 5 * 60 * 1000
      }, {
        fs,
        aiHomeDir: fixture.aiHomeDir,
        fetchWithTimeout: async () => ({
          ok: true,
          text: async () => JSON.stringify({
            access_token: 'new-agy-token',
            refresh_token: 'agy-refresh-token',
            expires_in: 3600
          })
        }),
        accountStateService: {
          clearRuntimeBlock(actualAccountRef, provider, options) {
            clears.push({ accountRef: actualAccountRef, provider, options });
            return false;
          }
        },
        hub: {
          emit(name, event) {
            events.push({ name, event });
          }
        },
        logInfo: () => {},
        logWarn: () => {},
        logError: () => {}
      });

      await new Promise(resolve => setTimeout(resolve, 200));
      daemon.stop();

      assert.equal(account.accessToken, 'new-agy-token');
      assert.ok(account.authInvalidUntil > Date.now());
      assert.equal(account.consecutiveFailures, 1);
      assert.equal(account.lastError, 'agy_not_signed_in');
      assert.equal(clears.length, 1);
      assert.equal(clears[0].options.evidence, 'token_refresh_success');
      assert.equal(events.length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('should not refresh if token is far from expiry', async (t) => {
    const nowMs = Date.now();
    const expiresAt = nowMs + 60 * 60 * 1000; // 1 小时后过期
    const fixture = createAccountFixture(t);
    const accountRef = fixture.register('codex', '1', { auth: {
      tokens: {
        refresh_token: 'rt_mock_refresh_token',
        access_token: 'mock_access_token'
      }
    } });

    const mockAccount = {
      accountRef,
      provider: 'codex',
      refreshToken: 'rt_mock_refresh_token',
      accessToken: 'mock_access_token',
      tokenExpiresAt: expiresAt
    };

    const state = {
      accounts: {
        codex: [mockAccount],
        gemini: [],
        claude: []
      }
    };

    const options = {
      tokenRefreshIntervalMs: 60000,
      tokenRefreshBeforeExpiryMs: 5 * 60 * 1000 // 提前 5 分钟刷新
    };

    let refreshCalled = false;
    const mockFetch = async (url) => {
      if (url.includes('oauth/token')) {
        refreshCalled = true;
      }
      return { ok: false, text: async () => '' };
    };

    const daemon = createTokenRefreshDaemon(state, options, {
      fs,
      aiHomeDir: fixture.aiHomeDir,
      fetchWithTimeout: mockFetch,
      logInfo: () => {},
      logWarn: () => {},
      logError: () => {}
    });

    // 等待启动任务完成
    await new Promise(resolve => setTimeout(resolve, 200));

    daemon.stop();

    // 验证刷新不应该被调用
    assert.ok(!refreshCalled, 'Token refresh should not be called for healthy token');
  });

  it('demotes account to auth_invalid when the refresh token is rejected (invalid_grant)', async (t) => {
    const fixture = createAccountFixture(t, 'aih-token-refresh-daemon-claude-db-');
    const expiresAt = Date.now() - 60_000;
    const accountRef = fixture.register('claude', '4', {
      credentials: {
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-old',
          refreshToken: 'sk-ant-ort01-revoked',
          expiresAt
        }
      }
    });
    const account = {
      accountRef,
      provider: 'claude',
      authType: 'oauth',
      email: 'madou@example.com',
      tokenExpiresAt: expiresAt,
      authInvalidUntil: 0,
      consecutiveFailures: 0
    };
    const state = { accounts: { codex: [], gemini: [], claude: [account], agy: [] } };
    const events = [];

    const daemon = createTokenRefreshDaemon(state, { tokenStartupRefreshBeforeExpiryMs: 5 * 60 * 1000 }, {
      fs,
      aiHomeDir: fixture.aiHomeDir,
      fetchWithTimeout: async (url) => {
        if (String(url).includes('oauth/token')) {
          return { ok: false, status: 400, text: async () => '{"error":"invalid_grant","error_description":"Refresh token not found or invalid"}' };
        }
        return { ok: false, status: 500, text: async () => '' };
      },
      hub: { emit: (name, event) => events.push({ name, event }) },
      logInfo: () => {},
      logWarn: () => {},
      logError: () => {}
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    daemon.stop();

    assert.ok(Number(account.authInvalidUntil) > Date.now(), 'account should be blocked auth_invalid');
    assert.equal(account.lastFailureKind, 'auth_invalid');
    assert.equal(account.lastError, 'token_refresh_refresh_http_400');
    const authEvt = events.find((e) => e.event && e.event.nextStatus === 'auth_invalid');
    assert.ok(authEvt, 'ACCOUNT_RUNTIME_CHANGED auth_invalid should be emitted');
    // The event NAME must equal the canonical constant the listeners subscribe
    // to - emitting a literal 'ACCOUNT_RUNTIME_CHANGED' reaches no listener and
    // silently fails to persist (regression guard for that exact bug).
    assert.equal(authEvt.name, ACCOUNT_RUNTIME_CHANGED);
    assert.equal(ACCOUNT_RUNTIME_CHANGED, 'account.runtime.changed');
    assert.ok(authEvt.event.runtimeState && authEvt.event.runtimeState.authInvalidUntil > Date.now());
    assert.equal(daemon.getStats().totalAuthInvalid, 1);
  });

  it('does NOT demote on a transient refresh failure (network error)', async (t) => {
    const fixture = createAccountFixture(t, 'aih-token-refresh-daemon-claude-transient-db-');
    const expiresAt = Date.now() - 60_000;
    const accountRef = fixture.register('claude', '4', {
      credentials: {
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-old',
          refreshToken: 'sk-ant-ort01-live',
          expiresAt
        }
      }
    });
    const account = {
      accountRef,
      provider: 'claude',
      authType: 'oauth',
      tokenExpiresAt: expiresAt,
      authInvalidUntil: 0
    };
    const state = { accounts: { codex: [], gemini: [], claude: [account], agy: [] } };
    const events = [];

    const daemon = createTokenRefreshDaemon(state, { tokenStartupRefreshBeforeExpiryMs: 5 * 60 * 1000 }, {
      fs,
      aiHomeDir: fixture.aiHomeDir,
      fetchWithTimeout: async () => { throw new Error('socket hang up'); },
      hub: { emit: (name, event) => events.push({ name, event }) },
      logInfo: () => {},
      logWarn: () => {},
      logError: () => {}
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    daemon.stop();

    assert.equal(account.authInvalidUntil, 0, 'transient failure must not block the account');
    assert.ok(!events.some((e) => e.event && e.event.nextStatus === 'auth_invalid'));
    assert.equal(daemon.getStats().totalAuthInvalid, 0);
  });

  it('skips api-key accounts before token refresh', async () => {
    // API-key accounts have no refresh token by design. They must not enter the
    // OAuth refresh path at all, otherwise startup logs report false credential
    // failures for working API-key accounts.
    const codexAccount = {
      accountRef: 'acct_11111111111111111111',
      provider: 'codex',
      authType: 'api-key',
      apiKeyMode: true,
      accessToken: 'sk-codex-apikey',
      tokenExpiresAt: Date.now() - 60_000,
      authInvalidUntil: 0
    };
    const claudeAccount = {
      accountRef: 'acct_22222222222222222222',
      provider: 'claude',
      authType: 'api-key',
      apiKeyMode: true,
      accessToken: 'sk-claude-apikey',
      authInvalidUntil: 0
    };
    const state = { accounts: { codex: [codexAccount], gemini: [], claude: [claudeAccount], agy: [] } };
    const events = [];
    const warnings = [];
    let refreshCalls = 0;

    const daemon = createTokenRefreshDaemon(state, { tokenStartupRefreshBeforeExpiryMs: 5 * 60 * 1000 }, {
      fetchWithTimeout: async () => {
        refreshCalls += 1;
        return { ok: false, status: 400, text: async () => '' };
      },
      hub: { emit: (name, event) => events.push({ name, event }) },
      logInfo: () => {},
      logWarn: (message) => warnings.push(String(message || '')),
      logError: () => {}
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    daemon.stop();

    assert.equal(refreshCalls, 0, 'api-key accounts must not call token refresh executor');
    assert.deepEqual(warnings, []);
    assert.equal(codexAccount.authInvalidUntil, 0, 'api-key account must never be demoted by token refresh');
    assert.equal(claudeAccount.authInvalidUntil, 0, 'api-key account must never be demoted by token refresh');
    assert.ok(!events.some((e) => e.event && e.event.nextStatus === 'auth_invalid'));
    assert.equal(daemon.getStats().totalAuthInvalid, 0);
  });

  it('isUnrecoverableAuthFailure classifies refresh results correctly', () => {
    const f = __private.isUnrecoverableAuthFailure;
    // Unrecoverable: refresh token rejected / absent
    assert.equal(f({ ok: false, reason: 'missing_refresh_token' }), true);
    assert.equal(f({ ok: false, reason: 'refresh_exception', detail: 'oops invalid_grant oops' }), true);
    assert.equal(f({ ok: false, reason: 'refresh_invalid_refresh_token' }), true);
    assert.equal(f({ ok: false, detail: 'Refresh token has been revoked' }), true);
    // Recoverable / not applicable
    assert.equal(f({ ok: false, status: 400, reason: 'refresh_http_400' }), false);
    assert.equal(f({ ok: false, status: 401, reason: 'refresh_http_401' }), false);
    assert.equal(f({ ok: false, status: 403, reason: 'refresh_http_403' }), false);
    assert.equal(f({ ok: false, status: 500, reason: 'refresh_http_500' }), false);
    assert.equal(f({ ok: false, reason: 'refresh_exception', detail: 'socket hang up' }), false);
    assert.equal(f({ ok: true, refreshed: false, reason: 'not_due' }), false);
    assert.equal(f(null), false);
    assert.equal(f(undefined), false);
  });

  it('keeps transient OAuth endpoint 400 and 403 responses recoverable', () => {
    const f = __private.isUnrecoverableAuthFailure;

    assert.equal(f({
      ok: false,
      status: 400,
      reason: 'refresh_http_400',
      detail: 'temporarily_unavailable: retry later'
    }), false);
    assert.equal(f({
      ok: false,
      status: 403,
      reason: 'refresh_http_403',
      detail: 'Cloudflare WAF challenge'
    }), false);
    assert.equal(f({
      ok: false,
      status: 401,
      reason: 'refresh_http_401',
      detail: 'invalid_client while processing refresh token request'
    }), false);
  });
});
