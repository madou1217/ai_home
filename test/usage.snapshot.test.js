const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createUsageSnapshotService } = require('../lib/cli/services/usage/snapshot');
const { createUsageCacheService } = require('../lib/cli/services/usage/cache');
const { buildAuthInvalidRuntimeState } = require('../lib/account/runtime-state-builders');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-usage-snapshot-'));
}

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

test('codex usage snapshot falls back to account/read payload when rateLimits are unavailable', () => {
  const root = mkTmpDir();
  try {
    const getProfileDir = (cliName, id) => path.join(root, 'profiles', cliName, String(id));
    const getToolConfigDir = (cliName, id) => path.join(getProfileDir(cliName, id), `.${cliName}`);

    const profileDir = getProfileDir('codex', '1');
    fs.mkdirSync(profileDir, { recursive: true });

    const cacheService = createUsageCacheService({
      fs,
      path,
      getProfileDir,
      usageSnapshotSchemaVersion: 2,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api'
    });

    const payload = {
      ok: true,
      account: {
        email: 'user@example.com',
        planType: 'free'
      },
      fallback: 'account_read'
    };
    const stdout = `AIH_CODEX_RATE_LIMIT_JSON_START\n${JSON.stringify(payload)}\nAIH_CODEX_RATE_LIMIT_JSON_END\n`;

    const usageSnapshotService = createUsageSnapshotService({
      fs,
      path,
      spawnSync: () => ({ stdout, stderr: '' }),
      processObj: {
        execPath: process.execPath,
        cwd: () => root,
        env: {},
        platform: process.platform
      },
      resolveCliPath: () => '/usr/bin/codex',
      usageSnapshotSchemaVersion: 2,
      usageRefreshStaleMs: 5 * 60 * 1000,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api',
      getProfileDir,
      getToolConfigDir,
      writeUsageCache: cacheService.writeUsageCache,
      readUsageCache: cacheService.readUsageCache
    });

    const snapshot = usageSnapshotService.ensureUsageSnapshot('codex', '1', null);
    assert.ok(snapshot);
    assert.equal(snapshot.kind, 'codex_oauth_status');
    assert.equal(snapshot.source, 'codex_app_server');
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0].bucket, 'account');
    assert.equal(snapshot.entries[0].remainingPct, null);
    assert.equal(snapshot.fallbackSource, 'account_read');
    assert.equal(snapshot.account.planType, 'free');
    assert.equal(snapshot.account.email, 'user@example.com');
    assert.match(snapshot.entries[0].window, /plan:free/);
    assert.match(snapshot.entries[0].window, /user@example\.com/);

    const cached = cacheService.readUsageCache('codex', '1');
    assert.ok(cached);
    assert.equal(cached.entries[0].bucket, 'account');
    assert.equal(cached.fallbackSource, 'account_read');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('agy usage snapshot reads Antigravity OAuth token and caches fetchAvailableModels quota', async () => {
  const root = mkTmpDir();
  try {
    const getProfileDir = (cliName, id) => path.join(root, 'profiles', cliName, String(id));
    const getToolConfigDir = (cliName, id) => path.join(getProfileDir(cliName, id), '.gemini', 'antigravity-cli');
    const profileDir = getProfileDir('agy', '1');
    const configDir = getToolConfigDir('agy', '1');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'email.cache'), 'agy@example.com', 'utf8');
    fs.writeFileSync(path.join(configDir, 'antigravity-oauth-token'), JSON.stringify({
      auth_method: 'oauth',
      token: {
        access_token: 'agy-access-token',
        refresh_token: 'agy-refresh-token',
        expiry: new Date(Date.now() + 3600000).toISOString()
      }
    }));

    const cacheService = createUsageCacheService({
      fs,
      path,
      getProfileDir,
      usageSnapshotSchemaVersion: 2,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api',
      usageSourceAgyCodeAssist: 'agy_fetch_available_models'
    });

    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({
        url,
        authorization: String(init.headers.authorization || ''),
        body: JSON.parse(init.body || '{}')
      });
      if (String(url).includes(':loadCodeAssist')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            cloudaicompanionProject: 'projects/agy-1',
            paidTier: { name: 'Google AI Pro' }
          })
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          models: {
            'claude-sonnet-4-6': {
              quotaInfo: {
                remainingFraction: 0.33,
                resetTime: new Date(Date.now() + 3600000).toISOString()
              }
            }
          }
        })
      };
    };

    const usageSnapshotService = createUsageSnapshotService({
      fs,
      path,
      spawnSync: () => ({ stdout: '', stderr: '' }),
      fetchImpl,
      processObj: {
        execPath: process.execPath,
        cwd: () => root,
        env: {},
        platform: process.platform
      },
      resolveCliPath: () => '/usr/bin/agy',
      usageSnapshotSchemaVersion: 2,
      usageRefreshStaleMs: 5 * 60 * 1000,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api',
      usageSourceAgyCodeAssist: 'agy_fetch_available_models',
      getProfileDir,
      getToolConfigDir,
      writeUsageCache: cacheService.writeUsageCache,
      readUsageCache: cacheService.readUsageCache,
      accountStateService: { clearRuntimeBlock: () => false }
    });

    const snapshot = await usageSnapshotService.ensureUsageSnapshotAsync('agy', '1', null, { forceRefresh: true });
    assert.ok(snapshot);
    assert.equal(snapshot.kind, 'agy_code_assist_quota');
    assert.equal(snapshot.source, 'agy_fetch_available_models');
    assert.equal(snapshot.account.email, 'agy@example.com');
    assert.equal(snapshot.account.subscriptionTier, 'Google AI Pro');
    assert.equal(snapshot.account.project, 'projects/agy-1');
    assert.equal(snapshot.models[0].model, 'claude-sonnet-4-6');
    assert.equal(snapshot.models[0].remainingPct, 33);
    assert.equal(calls[0].authorization, 'Bearer agy-access-token');

    const cached = cacheService.readUsageCache('agy', '1');
    assert.ok(cached);
    assert.equal(cached.kind, 'agy_code_assist_quota');
    assert.equal(cached.models[0].remainingPct, 33);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('agy usage preflight reports local token and cache readiness without network probe', () => {
  const root = mkTmpDir();
  const oldAgyVersion = process.env.AIH_ANTIGRAVITY_VERSION;
  try {
    process.env.AIH_ANTIGRAVITY_VERSION = '2.0.6';
    const getProfileDir = (cliName, id) => path.join(root, 'profiles', cliName, String(id));
    const getToolConfigDir = (cliName, id) => path.join(getProfileDir(cliName, id), '.gemini', 'antigravity-cli');
    const profileDir = getProfileDir('agy', '7');
    const configDir = getToolConfigDir('agy', '7');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'email.cache'), 'agy7@example.com', 'utf8');
    fs.writeFileSync(path.join(configDir, 'antigravity-oauth-token'), JSON.stringify({
      auth_method: 'oauth',
      token: {
        access_token: 'agy-access-token',
        refresh_token: 'agy-refresh-token',
        expiry: new Date(Date.now() + 3600000).toISOString()
      }
    }, null, 2));

    const cacheService = createUsageCacheService({
      fs,
      path,
      getProfileDir,
      usageSnapshotSchemaVersion: 2,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api',
      usageSourceAgyCodeAssist: 'agy_fetch_available_models'
    });
    cacheService.writeUsageCache('agy', '7', {
      schemaVersion: 2,
      kind: 'agy_code_assist_quota',
      source: 'agy_fetch_available_models',
      capturedAt: 1234,
      models: [{
        model: 'claude-sonnet-4-6',
        remainingPct: 50,
        resetIn: '1h'
      }]
    });

    const usageSnapshotService = createUsageSnapshotService({
      fs,
      path,
      spawnSync: () => ({ stdout: '', stderr: '' }),
      fetchImpl: async () => {
        throw new Error('preflight must not fetch');
      },
      processObj: {
        execPath: process.execPath,
        cwd: () => root,
        env: {
          AIH_AGY_QUOTA_BASE_URLS: 'https://one.example.com/v1internal,https://two.example.com/v1internal',
          AIH_ANTIGRAVITY_VERSION: '2.0.6'
        },
        platform: process.platform
      },
      resolveCliPath: () => '/usr/bin/agy',
      usageSnapshotSchemaVersion: 2,
      usageRefreshStaleMs: 5 * 60 * 1000,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api',
      usageSourceAgyCodeAssist: 'agy_fetch_available_models',
      getProfileDir,
      getToolConfigDir,
      writeUsageCache: cacheService.writeUsageCache,
      readUsageCache: cacheService.readUsageCache,
      accountStateService: { clearRuntimeBlock: () => false }
    });

    const report = usageSnapshotService.buildAgyUsagePreflight('agy', '7');
    assert.equal(report.tokenFileExists, true);
    assert.equal(report.oauthAccessTokenPresent, true);
    assert.equal(report.refreshTokenPresent, true);
    assert.equal(report.selectedTokenSource, 'antigravity-oauth-token');
    assert.equal(report.emailPresent, true);
    assert.equal(report.tokenExpired, false);
    assert.equal(report.refreshDue, false);
    assert.equal(report.usageCachePresent, true);
    assert.equal(report.usageCacheKind, 'agy_code_assist_quota');
    assert.deepEqual(report.quotaBaseUrls, [
      'https://one.example.com/v1internal',
      'https://two.example.com/v1internal'
    ]);
    assert.equal(report.codeAssistClientVersion, '2.0.6');
    assert.equal(Object.prototype.hasOwnProperty.call(report, 'accessToken'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(report, 'refreshToken'), false);
  } finally {
    if (oldAgyVersion === undefined) {
      delete process.env.AIH_ANTIGRAVITY_VERSION;
    } else {
      process.env.AIH_ANTIGRAVITY_VERSION = oldAgyVersion;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('agy usage snapshot refreshes expired Antigravity token before quota probe', async () => {
  const root = mkTmpDir();
  try {
    const getProfileDir = (cliName, id) => path.join(root, 'profiles', cliName, String(id));
    const getToolConfigDir = (cliName, id) => path.join(getProfileDir(cliName, id), '.gemini', 'antigravity-cli');
    const configDir = getToolConfigDir('agy', '1');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'email.cache'), 'old@example.com', 'utf8');
    fs.writeFileSync(path.join(configDir, 'antigravity-oauth-token'), JSON.stringify({
      auth_method: 'oauth',
      token: {
        access_token: 'expired-token',
        refresh_token: 'agy-refresh-token',
        expiry: '2000-01-01T00:00:00.000Z'
      }
    }, null, 2));

    const cacheService = createUsageCacheService({
      fs,
      path,
      getProfileDir,
      usageSnapshotSchemaVersion: 2,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api',
      usageSourceAgyCodeAssist: 'agy_fetch_available_models'
    });

    let refreshCalled = false;
    const seenAuthorization = [];
    const fetchImpl = async (url, init) => {
      seenAuthorization.push(String(init.headers.authorization || ''));
      if (String(url).includes(':loadCodeAssist')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            cloudaicompanionProject: 'projects/agy-refreshed',
            paidTier: { name: 'Google AI Pro' }
          })
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          models: {
            'gemini-3.1-pro-preview': {
              quotaInfo: {
                remainingFraction: 0.88,
                resetTime: new Date(Date.now() + 3600000).toISOString()
              }
            }
          }
        })
      };
    };

    const usageSnapshotService = createUsageSnapshotService({
      fs,
      path,
      spawnSync: () => ({ stdout: '', stderr: '' }),
      fetchImpl,
      fetchWithTimeout: async () => ({ ok: true, text: async () => '{}' }),
      refreshAgyAccessToken: async (account) => {
        refreshCalled = true;
        assert.equal(account.accessToken, 'expired-token');
        fs.writeFileSync(path.join(configDir, 'email.cache'), 'new@example.com', 'utf8');
        fs.writeFileSync(path.join(configDir, 'antigravity-oauth-token'), JSON.stringify({
          auth_method: 'oauth',
          token: {
            access_token: 'fresh-token',
            refresh_token: 'agy-refresh-token',
            expiry: new Date(Date.now() + 3600000).toISOString()
          }
        }, null, 2));
        return { ok: true, refreshed: true, persisted: true };
      },
      processObj: {
        execPath: process.execPath,
        cwd: () => root,
        env: {},
        platform: process.platform
      },
      resolveCliPath: () => '/usr/bin/agy',
      usageSnapshotSchemaVersion: 2,
      usageRefreshStaleMs: 5 * 60 * 1000,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api',
      usageSourceAgyCodeAssist: 'agy_fetch_available_models',
      getProfileDir,
      getToolConfigDir,
      writeUsageCache: cacheService.writeUsageCache,
      readUsageCache: cacheService.readUsageCache,
      accountStateService: { clearRuntimeBlock: () => false }
    });

    const snapshot = await usageSnapshotService.ensureUsageSnapshotAsync('agy', '1', null, { forceRefresh: true });

    assert.equal(refreshCalled, true);
    assert.equal(snapshot.kind, 'agy_code_assist_quota');
    assert.equal(snapshot.account.email, 'new@example.com');
    assert.equal(snapshot.models[0].model, 'gemini-3.1-pro-preview');
    assert.equal(snapshot.models[0].remainingPct, 88);
    assert.deepEqual(Array.from(new Set(seenAuthorization)), ['Bearer fresh-token']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('agy usage snapshot retries quota probe after auth failure refresh', async () => {
  const root = mkTmpDir();
  try {
    const getProfileDir = (cliName, id) => path.join(root, 'profiles', cliName, String(id));
    const getToolConfigDir = (cliName, id) => path.join(getProfileDir(cliName, id), '.gemini', 'antigravity-cli');
    const configDir = getToolConfigDir('agy', '2');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'email.cache'), 'retry@example.com', 'utf8');
    fs.writeFileSync(path.join(configDir, 'antigravity-oauth-token'), JSON.stringify({
      auth_method: 'oauth',
      token: {
        access_token: 'stale-token',
        refresh_token: 'agy-refresh-token',
        expiry: new Date(Date.now() + 3600000).toISOString()
      }
    }, null, 2));

    const cacheService = createUsageCacheService({
      fs,
      path,
      getProfileDir,
      usageSnapshotSchemaVersion: 2,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api',
      usageSourceAgyCodeAssist: 'agy_fetch_available_models'
    });

    const authorizations = [];
    const fetchImpl = async (url, init) => {
      const authorization = String(init.headers.authorization || '');
      authorizations.push(authorization);
      if (authorization === 'Bearer stale-token') {
        return {
          ok: false,
          status: 401,
          text: async () => JSON.stringify({ error: { message: 'invalid token' } })
        };
      }
      if (String(url).includes(':loadCodeAssist')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            cloudaicompanionProject: 'projects/agy-retry',
            paidTier: { name: 'Google AI Pro' }
          })
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          models: {
            'claude-sonnet-4-6': {
              quotaInfo: {
                remainingFraction: 0.51,
                resetTime: new Date(Date.now() + 3600000).toISOString()
              }
            }
          }
        })
      };
    };

    const usageSnapshotService = createUsageSnapshotService({
      fs,
      path,
      spawnSync: () => ({ stdout: '', stderr: '' }),
      fetchImpl,
      fetchWithTimeout: async () => ({ ok: true, text: async () => '{}' }),
      refreshAgyAccessToken: async (_account, options) => {
        if (!options.force) {
          return { ok: true, refreshed: false, reason: 'not_due' };
        }
        fs.writeFileSync(path.join(configDir, 'antigravity-oauth-token'), JSON.stringify({
          auth_method: 'oauth',
          token: {
            access_token: 'retry-token',
            refresh_token: 'agy-refresh-token',
            expiry: new Date(Date.now() + 3600000).toISOString()
          }
        }, null, 2));
        return { ok: true, refreshed: true, persisted: true };
      },
      processObj: {
        execPath: process.execPath,
        cwd: () => root,
        env: {},
        platform: process.platform
      },
      resolveCliPath: () => '/usr/bin/agy',
      usageSnapshotSchemaVersion: 2,
      usageRefreshStaleMs: 5 * 60 * 1000,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api',
      usageSourceAgyCodeAssist: 'agy_fetch_available_models',
      getProfileDir,
      getToolConfigDir,
      writeUsageCache: cacheService.writeUsageCache,
      readUsageCache: cacheService.readUsageCache,
      accountStateService: { clearRuntimeBlock: () => false }
    });

    const snapshot = await usageSnapshotService.ensureUsageSnapshotAsync('agy', '2', null, { forceRefresh: true });

    assert.equal(snapshot.kind, 'agy_code_assist_quota');
    assert.equal(snapshot.models[0].model, 'claude-sonnet-4-6');
    assert.equal(snapshot.models[0].remainingPct, 51);
    assert.equal(authorizations.includes('Bearer stale-token'), true);
    assert.equal(authorizations.includes('Bearer retry-token'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('agy usage snapshot uses refreshed OAuth file token over stale env token', async () => {
  const root = mkTmpDir();
  try {
    const getProfileDir = (cliName, id) => path.join(root, 'profiles', cliName, String(id));
    const getToolConfigDir = (cliName, id) => path.join(getProfileDir(cliName, id), '.gemini', 'antigravity-cli');
    const profileDir = getProfileDir('agy', '3');
    const configDir = getToolConfigDir('agy', '3');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, '.aih_env.json'), JSON.stringify({
      AGY_ACCESS_TOKEN: 'env-stale-token'
    }, null, 2));
    fs.writeFileSync(path.join(configDir, 'email.cache'), 'env@example.com', 'utf8');
    fs.writeFileSync(path.join(configDir, 'antigravity-oauth-token'), JSON.stringify({
      auth_method: 'oauth',
      token: {
        access_token: 'file-expired-token',
        refresh_token: 'agy-refresh-token',
        expiry: '2000-01-01T00:00:00.000Z'
      }
    }, null, 2));

    const cacheService = createUsageCacheService({
      fs,
      path,
      getProfileDir,
      usageSnapshotSchemaVersion: 2,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api',
      usageSourceAgyCodeAssist: 'agy_fetch_available_models'
    });

    const seenAuthorization = [];
    const fetchImpl = async (url, init) => {
      seenAuthorization.push(String(init.headers.authorization || ''));
      if (String(url).includes(':loadCodeAssist')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ cloudaicompanionProject: 'projects/env', paidTier: { name: 'Google AI Pro' } })
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          models: {
            'claude-opus-4.6-thinking': {
              quotaInfo: {
                remainingFraction: 0.64,
                resetTime: new Date(Date.now() + 3600000).toISOString()
              }
            }
          }
        })
      };
    };

    const usageSnapshotService = createUsageSnapshotService({
      fs,
      path,
      spawnSync: () => ({ stdout: '', stderr: '' }),
      fetchImpl,
      fetchWithTimeout: async () => ({ ok: true, text: async () => '{}' }),
      refreshAgyAccessToken: async () => {
        fs.writeFileSync(path.join(configDir, 'antigravity-oauth-token'), JSON.stringify({
          auth_method: 'oauth',
          token: {
            access_token: 'file-fresh-token',
            refresh_token: 'agy-refresh-token',
            expiry: new Date(Date.now() + 3600000).toISOString()
          }
        }, null, 2));
        return { ok: true, refreshed: true, persisted: true };
      },
      processObj: {
        execPath: process.execPath,
        cwd: () => root,
        env: {},
        platform: process.platform
      },
      resolveCliPath: () => '/usr/bin/agy',
      usageSnapshotSchemaVersion: 2,
      usageRefreshStaleMs: 5 * 60 * 1000,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api',
      usageSourceAgyCodeAssist: 'agy_fetch_available_models',
      getProfileDir,
      getToolConfigDir,
      writeUsageCache: cacheService.writeUsageCache,
      readUsageCache: cacheService.readUsageCache,
      accountStateService: { clearRuntimeBlock: () => false }
    });

    const snapshot = await usageSnapshotService.ensureUsageSnapshotAsync('agy', '3', null, { forceRefresh: true });

    assert.equal(snapshot.models[0].model, 'claude-opus-4.6-thinking');
    assert.deepEqual(Array.from(new Set(seenAuthorization)), ['Bearer file-fresh-token']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codex account/read fallback prefers local auth metadata over stale account payload identity', () => {
  const root = mkTmpDir();
  try {
    const getProfileDir = (cliName, id) => path.join(root, 'profiles', cliName, String(id));
    const getToolConfigDir = (cliName, id) => path.join(getProfileDir(cliName, id), `.${cliName}`);

    const profileDir = getProfileDir('codex', '2');
    const codexConfigDir = getToolConfigDir('codex', '2');
    fs.mkdirSync(codexConfigDir, { recursive: true });
    fs.writeFileSync(path.join(codexConfigDir, 'auth.json'), JSON.stringify({
      tokens: {
        access_token: makeJwt({
          client_id: 'app_test',
          'https://api.openai.com/auth': {
            chatgpt_plan_type: 'team',
            chatgpt_account_id: 'acc_real'
          },
          'https://api.openai.com/profile': {
            email: 'real-team@example.com'
          }
        }),
        account_id: 'acc_real'
      }
    }));

    const cacheService = createUsageCacheService({
      fs,
      path,
      getProfileDir,
      usageSnapshotSchemaVersion: 2,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api'
    });

    const payload = {
      ok: true,
      account: {
        email: 'wrong-team@example.com',
        planType: 'team',
        accountId: 'acc_wrong'
      },
      fallback: 'account_read'
    };
    const stdout = `AIH_CODEX_RATE_LIMIT_JSON_START\n${JSON.stringify(payload)}\nAIH_CODEX_RATE_LIMIT_JSON_END\n`;
    const usageSnapshotService = createUsageSnapshotService({
      fs,
      path,
      spawnSync: () => ({ stdout, stderr: '' }),
      processObj: {
        execPath: process.execPath,
        cwd: () => root,
        env: {},
        platform: process.platform
      },
      resolveCliPath: () => '/usr/bin/codex',
      usageSnapshotSchemaVersion: 2,
      usageRefreshStaleMs: 5 * 60 * 1000,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api',
      getProfileDir,
      getToolConfigDir,
      writeUsageCache: cacheService.writeUsageCache,
      readUsageCache: cacheService.readUsageCache
    });

    const snapshot = usageSnapshotService.ensureUsageSnapshot('codex', '2', null);
    assert.equal(snapshot.account.email, 'real-team@example.com');
    assert.equal(snapshot.account.accountId, 'acc_real');
    assert.equal(snapshot.entries[0].window, 'plan:team real-team@example.com');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codex usage snapshot async uses direct HTTP rate-limits by default', async () => {
  const root = mkTmpDir();
  try {
    const getProfileDir = (cliName, id) => path.join(root, 'profiles', cliName, String(id));
    const getToolConfigDir = (cliName, id) => path.join(getProfileDir(cliName, id), `.${cliName}`);
    const profileDir = getProfileDir('codex', '9');
    const codexConfigDir = getToolConfigDir('codex', '9');
    fs.mkdirSync(codexConfigDir, { recursive: true });
    fs.writeFileSync(path.join(codexConfigDir, 'auth.json'), JSON.stringify({
      tokens: {
        access_token: makeJwt({
          client_id: 'app_test',
          'https://api.openai.com/auth': {
            chatgpt_plan_type: 'free',
            chatgpt_account_id: 'acc_1'
          },
          'https://api.openai.com/profile': {
            email: 'direct@example.com'
          }
        }),
        account_id: 'acc_1'
      }
    }));

    const cacheService = createUsageCacheService({
      fs,
      path,
      getProfileDir,
      usageSnapshotSchemaVersion: 2,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api'
    });

    let spawnCalls = 0;
    let fetchCalls = 0;
    const fetchUrls = [];
    const usageSnapshotService = createUsageSnapshotService({
      fs,
      path,
      spawnSync: () => ({ stdout: '', stderr: '' }),
      spawn: () => {
        spawnCalls += 1;
        throw new Error('spawn should not be called when direct HTTP succeeds');
      },
      fetchImpl: async (url) => {
        fetchCalls += 1;
        fetchUrls.push(url);
        return {
          ok: true,
          text: async () => JSON.stringify({
            email: 'direct-from-wham@example.com',
            account_id: 'acc_from_wham',
            plan_type: 'free',
            rate_limit: {
              allowed: true,
              limit_reached: false,
              primary_window: {
                used_percent: 20,
                limit_window_seconds: 18_000,
                reset_after_seconds: 3600
              },
              secondary_window: {
                used_percent: 35,
                limit_window_seconds: 604_800,
                reset_at: Math.floor(Date.now() / 1000) + 86_400
              }
            }
          })
        };
      },
      processObj: {
        execPath: process.execPath,
        cwd: () => root,
        env: {},
        platform: process.platform
      },
      resolveCliPath: () => '/usr/bin/codex',
      usageSnapshotSchemaVersion: 2,
      usageRefreshStaleMs: 5 * 60 * 1000,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api',
      getProfileDir,
      getToolConfigDir,
      writeUsageCache: cacheService.writeUsageCache,
      readUsageCache: cacheService.readUsageCache
    });

    const snapshot = await usageSnapshotService.ensureUsageSnapshotAsync('codex', '9', null);
    assert.ok(snapshot);
    assert.equal(snapshot.kind, 'codex_oauth_status');
    assert.equal(fetchCalls, 1);
    assert.equal(fetchUrls[0], 'https://chatgpt.com/backend-api/wham/usage');
    assert.equal(spawnCalls, 0);
    assert.deepEqual(snapshot.entries.map((entry) => ({
      bucket: entry.bucket,
      window: entry.window,
      remainingPct: entry.remainingPct
    })), [
      { bucket: 'primary', window: '5h', remainingPct: 80 },
      { bucket: 'secondary', window: '7days', remainingPct: 65 }
    ]);
    assert.deepEqual(snapshot.account, {
      planType: 'free',
      email: 'direct@example.com',
      accountId: 'acc_1',
      organizationId: ''
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codex usage snapshot direct HTTP uses proxy-aware fetchWithTimeout by default', async () => {
  const root = mkTmpDir();
  try {
    const getProfileDir = (cliName, id) => path.join(root, 'profiles', cliName, String(id));
    const getToolConfigDir = (cliName, id) => path.join(getProfileDir(cliName, id), `.${cliName}`);
    const codexConfigDir = getToolConfigDir('codex', '91');
    fs.mkdirSync(codexConfigDir, { recursive: true });
    fs.writeFileSync(path.join(codexConfigDir, 'auth.json'), JSON.stringify({
      tokens: {
        access_token: makeJwt({
          client_id: 'app_test',
          'https://api.openai.com/auth': {
            chatgpt_plan_type: 'free',
            chatgpt_account_id: 'acc_proxy'
          },
          'https://api.openai.com/profile': {
            email: 'proxy-aware@example.com'
          }
        }),
        account_id: 'acc_proxy'
      }
    }));

    const cacheService = createUsageCacheService({
      fs,
      path,
      getProfileDir,
      usageSnapshotSchemaVersion: 2,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api'
    });

    const fetchWithTimeoutCalls = [];
    const usageSnapshotService = createUsageSnapshotService({
      fs,
      path,
      spawn: () => {
        throw new Error('spawn should not be called when direct HTTP succeeds');
      },
      fetchWithTimeout: async (url, init, timeoutMs) => {
        fetchWithTimeoutCalls.push({ url, init, timeoutMs });
        return {
          ok: true,
          text: async () => JSON.stringify({
            rate_limits: {
              primary: {
                window_minutes: 300,
                used_percent: 15,
                resets_at: Math.floor(Date.now() / 1000) + 3600
              }
            }
          })
        };
      },
      processObj: {
        execPath: process.execPath,
        cwd: () => root,
        env: {},
        platform: process.platform
      },
      resolveCliPath: () => '/usr/bin/codex',
      usageSnapshotSchemaVersion: 2,
      usageRefreshStaleMs: 5 * 60 * 1000,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api',
      getProfileDir,
      getToolConfigDir,
      writeUsageCache: cacheService.writeUsageCache,
      readUsageCache: cacheService.readUsageCache
    });

    const snapshot = await usageSnapshotService.ensureUsageSnapshotAsync('codex', '91', null);
    assert.ok(snapshot);
    assert.equal(fetchWithTimeoutCalls.length, 1);
    assert.equal(fetchWithTimeoutCalls[0].url, 'https://chatgpt.com/backend-api/wham/usage');
    assert.equal(fetchWithTimeoutCalls[0].timeoutMs, 60000);
    assert.equal(snapshot.entries[0].remainingPct, 85);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codex usage snapshot marks direct 401 as auth-invalid during bulk probe', async () => {
  const root = mkTmpDir();
  try {
    const getProfileDir = (cliName, id) => path.join(root, 'profiles', cliName, String(id));
    const getToolConfigDir = (cliName, id) => path.join(getProfileDir(cliName, id), `.${cliName}`);
    const codexConfigDir = getToolConfigDir('codex', '92');
    fs.mkdirSync(codexConfigDir, { recursive: true });
    fs.writeFileSync(path.join(codexConfigDir, 'auth.json'), JSON.stringify({
      tokens: {
        access_token: makeJwt({
          client_id: 'app_test',
          'https://api.openai.com/auth': {
            chatgpt_plan_type: 'free',
            chatgpt_account_id: 'acc_401'
          },
          'https://api.openai.com/profile': {
            email: 'expired@example.com'
          }
        }),
        account_id: 'acc_401'
      }
    }));

    const runtimeWrites = [];
    const reconcileEvents = [];
    const usageSnapshotService = createUsageSnapshotService({
      fs,
      path,
      spawn: () => {
        throw new Error('app server fallback should be skipped');
      },
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        text: async () => '{}'
      }),
      processObj: {
        execPath: process.execPath,
        cwd: () => root,
        env: {},
        platform: process.platform
      },
      resolveCliPath: () => '/usr/bin/codex',
      usageSnapshotSchemaVersion: 2,
      usageRefreshStaleMs: 5 * 60 * 1000,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api',
      getProfileDir,
      getToolConfigDir,
      accountStateService: {
        recordRuntimeFailure(provider, accountId, runtimeState, baseState) {
          runtimeWrites.push({ provider, accountId, runtimeState, baseState });
          return true;
        }
      },
      codexAuthInvalidReconciler: {
        enqueueUsageProbeFailure(provider, accountId, reason) {
          reconcileEvents.push({ provider, accountId, reason });
          return true;
        }
      },
      writeUsageCache: () => {},
      readUsageCache: () => null
    });

    const snapshot = await usageSnapshotService.ensureUsageSnapshotAsync('codex', '92', null, {
      forceRefresh: true,
      skipCodexAppServerFallback: true,
      allowCodexTokenRefresh: false
    });

    assert.equal(snapshot, null);
    assert.equal(runtimeWrites.length, 1);
    assert.equal(runtimeWrites[0].provider, 'codex');
    assert.equal(runtimeWrites[0].accountId, '92');
    assert.equal(runtimeWrites[0].runtimeState.lastFailureKind, 'auth_invalid');
    assert.match(runtimeWrites[0].runtimeState.lastError, /direct_http_status_401/);
    assert.equal(runtimeWrites[0].baseState.configured, true);
    assert.equal(runtimeWrites[0].baseState.apiKeyMode, false);
    assert.equal(runtimeWrites[0].baseState.displayName, 'expired@example.com');
    assert.deepEqual(reconcileEvents, [{
      provider: 'codex',
      accountId: '92',
      reason: 'auth_invalid_reauth_required:direct_http_status_401'
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codex usage snapshot does not synchronously refresh direct 401', async () => {
  const root = mkTmpDir();
  try {
    const getProfileDir = (cliName, id) => path.join(root, 'profiles', cliName, String(id));
    const getToolConfigDir = (cliName, id) => path.join(getProfileDir(cliName, id), `.${cliName}`);
    const codexConfigDir = getToolConfigDir('codex', '93');
    fs.mkdirSync(codexConfigDir, { recursive: true });
    fs.writeFileSync(path.join(codexConfigDir, 'auth.json'), JSON.stringify({
      tokens: {
        access_token: makeJwt({
          client_id: 'app_test',
          'https://api.openai.com/profile': {
            email: 'refresh-failed@example.com'
          }
        }),
        refresh_token: 'rt_rejected',
        account_id: 'acc_refresh_failed'
      }
    }));

    const fetchUrls = [];
    const runtimeWrites = [];
    const reconcileEvents = [];
    const usageSnapshotService = createUsageSnapshotService({
      fs,
      path,
      spawn: () => {
        throw new Error('app server fallback should be skipped');
      },
      fetchImpl: async (url) => {
        fetchUrls.push(String(url));
        return {
          ok: false,
          status: 401,
          text: async () => '{}'
        };
      },
      processObj: {
        execPath: process.execPath,
        cwd: () => root,
        env: {},
        platform: process.platform
      },
      resolveCliPath: () => '/usr/bin/codex',
      usageSnapshotSchemaVersion: 2,
      usageRefreshStaleMs: 5 * 60 * 1000,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api',
      getProfileDir,
      getToolConfigDir,
      accountStateService: {
        recordRuntimeFailure(provider, accountId, runtimeState, baseState) {
          runtimeWrites.push({ provider, accountId, runtimeState, baseState });
          return true;
        }
      },
      codexAuthInvalidReconciler: {
        enqueueUsageProbeFailure(provider, accountId, reason) {
          reconcileEvents.push({ provider, accountId, reason });
          return true;
        }
      },
      writeUsageCache: () => {},
      readUsageCache: () => null
    });

    const snapshot = await usageSnapshotService.ensureUsageSnapshotAsync('codex', '93', null, {
      forceRefresh: true,
      skipCodexAppServerFallback: true,
      allowCodexTokenRefresh: true
    });

    assert.equal(snapshot, null);
    assert.equal(fetchUrls.some((url) => url.includes('/oauth/token')), false);
    assert.equal(runtimeWrites.length, 1);
    assert.equal(runtimeWrites[0].runtimeState.lastFailureKind, 'auth_invalid');
    assert.match(runtimeWrites[0].runtimeState.lastError, /direct_http_status_401/);
    assert.equal(reconcileEvents.length, 1);
    assert.equal(reconcileEvents[0].provider, 'codex');
    assert.equal(reconcileEvents[0].accountId, '93');
    assert.match(reconcileEvents[0].reason, /direct_http_status_401/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codex usage snapshot enqueues existing auth-invalid runtime for async refresh', async () => {
  const root = mkTmpDir();
  try {
    const getProfileDir = (cliName, id) => path.join(root, 'profiles', cliName, String(id));
    const getToolConfigDir = (cliName, id) => path.join(getProfileDir(cliName, id), `.${cliName}`);
    fs.mkdirSync(getProfileDir('codex', '95'), { recursive: true });

    const reconcileEvents = [];
    const usageSnapshotService = createUsageSnapshotService({
      fs,
      path,
      spawn: () => {
        throw new Error('app server fallback should be skipped');
      },
      fetchImpl: async () => {
        throw new Error('direct usage should not be called without access token');
      },
      processObj: {
        execPath: process.execPath,
        cwd: () => root,
        env: {},
        platform: process.platform
      },
      resolveCliPath: () => '/usr/bin/codex',
      usageSnapshotSchemaVersion: 2,
      usageRefreshStaleMs: 5 * 60 * 1000,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api',
      getProfileDir,
      getToolConfigDir,
      getAccountStateIndex: () => ({
        getAccountState(provider, accountId) {
          assert.equal(provider, 'codex');
          assert.equal(accountId, '95');
          return {
            provider: 'codex',
            account_id: '95',
            runtime_state: buildAuthInvalidRuntimeState('auth_invalid_reauth_required')
          };
        }
      }),
      codexAuthInvalidReconciler: {
        enqueueAuthInvalidReauthRequired(provider, accountId, reason) {
          reconcileEvents.push({ provider, accountId, reason });
          return true;
        }
      },
      writeUsageCache: () => {},
      readUsageCache: () => null
    });

    const snapshot = await usageSnapshotService.ensureUsageSnapshotAsync('codex', '95', null, {
      forceRefresh: true,
      skipCodexAppServerFallback: true
    });

    assert.equal(snapshot, null);
    assert.deepEqual(reconcileEvents, [{
      provider: 'codex',
      accountId: '95',
      reason: 'auth_invalid_reauth_required'
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codex usage snapshot does not mark empty account response as auth-invalid', async () => {
  const root = mkTmpDir();
  try {
    const getProfileDir = (cliName, id) => path.join(root, 'profiles', cliName, String(id));
    const getToolConfigDir = (cliName, id) => path.join(getProfileDir(cliName, id), `.${cliName}`);
    fs.mkdirSync(getProfileDir('codex', '94'), { recursive: true });

    const spawnMock = () => {
      const child = new EventEmitter();
      child.pid = 12345;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.stderr.setEncoding = () => {};
      child.kill = () => {};
      child.stdin = new EventEmitter();
      child.stdin.end = () => {};
      child.stdin.write = (chunk, cb) => {
        const msg = JSON.parse(String(chunk || '').trim());
        process.nextTick(() => {
          if (msg.method === 'initialize') {
            child.stdout.emit('data', `${JSON.stringify({ id: 'aih_init', result: {} })}\n`);
          } else if (msg.method === 'account/rateLimits/read') {
            child.stdout.emit('data', `${JSON.stringify({ id: 'aih_rate', result: {} })}\n`);
          } else if (msg.method === 'account/read') {
            child.stdout.emit('data', `${JSON.stringify({ id: 'aih_account', result: {} })}\n`);
          }
          if (typeof cb === 'function') cb();
        });
        return true;
      };
      return child;
    };

    const runtimeWrites = [];
    const usageSnapshotService = createUsageSnapshotService({
      fs,
      path,
      spawn: spawnMock,
      processObj: {
        execPath: process.execPath,
        cwd: () => root,
        env: {
          AIH_CODEX_USAGE_DIRECT: '0'
        },
        platform: process.platform
      },
      resolveCliPath: () => '/usr/bin/codex',
      usageSnapshotSchemaVersion: 2,
      usageRefreshStaleMs: 5 * 60 * 1000,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api',
      getProfileDir,
      getToolConfigDir,
      accountStateService: {
        recordRuntimeFailure(provider, accountId, runtimeState, baseState) {
          runtimeWrites.push({ provider, accountId, runtimeState, baseState });
          return true;
        }
      },
      writeUsageCache: () => {},
      readUsageCache: () => null
    });

    const snapshot = await usageSnapshotService.ensureUsageSnapshotAsync('codex', '94', null, { forceRefresh: true });

    assert.equal(snapshot, null);
    assert.equal(usageSnapshotService.getLastUsageProbeError('codex', '94'), 'empty_account_response');
    assert.equal(runtimeWrites.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codex usage snapshot success clears stale persisted runtime state', async () => {
  const root = mkTmpDir();
  try {
    const getProfileDir = (cliName, id) => path.join(root, 'profiles', cliName, String(id));
    const getToolConfigDir = (cliName, id) => path.join(getProfileDir(cliName, id), `.${cliName}`);
    const codexConfigDir = getToolConfigDir('codex', '10');
    fs.mkdirSync(codexConfigDir, { recursive: true });
    fs.writeFileSync(path.join(codexConfigDir, 'auth.json'), JSON.stringify({
      tokens: {
        access_token: makeJwt({
          client_id: 'app_test',
          'https://api.openai.com/auth': {
            chatgpt_plan_type: 'team',
            chatgpt_account_id: 'acc_team'
          },
          'https://api.openai.com/profile': {
            email: 'team@example.com'
          }
        }),
        account_id: 'acc_team'
      }
    }));

    const cacheService = createUsageCacheService({
      fs,
      path,
      getProfileDir,
      usageSnapshotSchemaVersion: 2,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api'
    });

    const runtimeWrites = [];
    const usageSnapshotService = createUsageSnapshotService({
      fs,
      path,
      spawn: () => {
        throw new Error('spawn should not be called when direct HTTP succeeds');
      },
      fetchImpl: async () => ({
        ok: true,
        text: async () => JSON.stringify({
          rate_limits: {
            primary: { window_minutes: 300, used_percent: 10, resets_at: Math.floor(Date.now() / 1000) + 3600 }
          }
        })
      }),
      processObj: {
        execPath: process.execPath,
        cwd: () => root,
        env: {},
        platform: process.platform
      },
      resolveCliPath: () => '/usr/bin/codex',
      usageSnapshotSchemaVersion: 2,
      usageRefreshStaleMs: 5 * 60 * 1000,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api',
      getProfileDir,
      getToolConfigDir,
      accountStateService: {
        clearRuntimeBlock(provider, accountId, options) {
          const { evidence: _evidence, ...baseState } = options;
          const runtimeState = null;
          runtimeWrites.push({ provider, accountId, runtimeState, baseState });
          return true;
        }
      },
      writeUsageCache: cacheService.writeUsageCache,
      readUsageCache: cacheService.readUsageCache
    });

    const snapshot = await usageSnapshotService.ensureUsageSnapshotAsync('codex', '10', null);

    assert.ok(snapshot);
    assert.equal(runtimeWrites.length, 1);
    assert.deepEqual(runtimeWrites[0], {
      provider: 'codex',
      accountId: '10',
      runtimeState: null,
      baseState: {
        configured: true,
        apiKeyMode: false,
        displayName: 'team@example.com'
      }
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codex direct 401 queues async reconcile instead of clearing runtime synchronously', async () => {
  const root = mkTmpDir();
  try {
    const getProfileDir = (cliName, id) => path.join(root, 'profiles', cliName, String(id));
    const getToolConfigDir = (cliName, id) => path.join(getProfileDir(cliName, id), `.${cliName}`);
    const codexConfigDir = getToolConfigDir('codex', '16');
    fs.mkdirSync(codexConfigDir, { recursive: true });
    fs.writeFileSync(path.join(codexConfigDir, 'auth.json'), JSON.stringify({
      tokens: {
        access_token: makeJwt({ client_id: 'app_test' }),
        refresh_token: 'rt_refreshable',
        account_id: 'acc_refreshable'
      }
    }));

    const cacheService = createUsageCacheService({
      fs,
      path,
      getProfileDir,
      usageSnapshotSchemaVersion: 2,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api'
    });

    const runtimeWrites = [];
    const reconcileEvents = [];
    const usageSnapshotService = createUsageSnapshotService({
      fs,
      path,
      spawn: () => {
        throw new Error('app server unavailable');
      },
      fetchImpl: async (url) => {
        if (String(url).includes('/oauth/token')) {
          return {
            ok: true,
            text: async () => JSON.stringify({
              access_token: makeJwt({
                client_id: 'app_test',
                'https://api.openai.com/profile': {
                  email: 'refreshable@example.com'
                }
              }),
              refresh_token: 'rt_rotated'
            })
          };
        }
        return {
          ok: false,
          status: 401,
          text: async () => '{}'
        };
      },
      processObj: {
        execPath: process.execPath,
        cwd: () => root,
        env: {},
        platform: process.platform
      },
      resolveCliPath: () => '/usr/bin/codex',
      usageSnapshotSchemaVersion: 2,
      usageRefreshStaleMs: 5 * 60 * 1000,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api',
      getProfileDir,
      getToolConfigDir,
      accountStateService: {
        clearRuntimeBlock(provider, accountId, options) {
          const { evidence: _evidence, ...baseState } = options;
          const runtimeState = null;
          runtimeWrites.push({ provider, accountId, runtimeState, baseState });
          return true;
        }
      },
      codexAuthInvalidReconciler: {
        enqueueUsageProbeFailure(provider, accountId, reason) {
          reconcileEvents.push({ provider, accountId, reason });
          return true;
        }
      },
      writeUsageCache: cacheService.writeUsageCache,
      readUsageCache: cacheService.readUsageCache
    });

    const snapshot = await usageSnapshotService.ensureUsageSnapshotAsync('codex', '16', null, { forceRefresh: true });

    assert.equal(snapshot, null);
    assert.equal(runtimeWrites.length, 0);
    assert.equal(reconcileEvents.length, 1);
    assert.equal(reconcileEvents[0].provider, 'codex');
    assert.equal(reconcileEvents[0].accountId, '16');
    assert.match(reconcileEvents[0].reason, /direct_http_status_401/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codex account/read fallback alone does not clear stale auth-invalid state', async () => {
  const root = mkTmpDir();
  try {
    const getProfileDir = (cliName, id) => path.join(root, 'profiles', cliName, String(id));
    const getToolConfigDir = (cliName, id) => path.join(getProfileDir(cliName, id), `.${cliName}`);
    const codexConfigDir = getToolConfigDir('codex', '17');
    fs.mkdirSync(codexConfigDir, { recursive: true });
    fs.writeFileSync(path.join(codexConfigDir, 'auth.json'), JSON.stringify({
      tokens: {
        access_token: makeJwt({ client_id: 'app_test' }),
        refresh_token: 'rt_still_rejected',
        account_id: 'acc_fallback'
      }
    }));

    const cacheService = createUsageCacheService({
      fs,
      path,
      getProfileDir,
      usageSnapshotSchemaVersion: 2,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api'
    });

    const spawnMock = () => {
      const child = new EventEmitter();
      child.pid = 12345;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.stderr.setEncoding = () => {};
      child.kill = () => {};
      child.stdin = new EventEmitter();
      child.stdin.end = () => {};
      child.stdin.write = (chunk, cb) => {
        const msg = JSON.parse(String(chunk || '').trim());
        process.nextTick(() => {
          if (msg.method === 'initialize') {
            child.stdout.emit('data', `${JSON.stringify({ id: 'aih_init', result: {} })}\n`);
          } else if (msg.method === 'account/rateLimits/read') {
            child.stdout.emit('data', `${JSON.stringify({ id: 'aih_rate', result: {} })}\n`);
          } else if (msg.method === 'account/read') {
            child.stdout.emit('data', `${JSON.stringify({
              id: 'aih_account',
              result: {
                account: {
                  email: 'fallback-team@example.com',
                  planType: 'team'
                }
              }
            })}\n`);
          }
          if (typeof cb === 'function') cb();
        });
        return true;
      };
      return child;
    };

    const runtimeWrites = [];
    const usageSnapshotService = createUsageSnapshotService({
      fs,
      path,
      spawn: spawnMock,
      fetchImpl: async (url) => {
        if (String(url).includes('/oauth/token')) {
          return {
            ok: false,
            status: 401,
            text: async () => '{}'
          };
        }
        return {
          ok: false,
          status: 401,
          text: async () => '{}'
        };
      },
      processObj: {
        execPath: process.execPath,
        cwd: () => root,
        env: { AIH_CODEX_USAGE_DIRECT: '0' },
        platform: process.platform
      },
      resolveCliPath: () => '/usr/bin/codex',
      usageSnapshotSchemaVersion: 2,
      usageRefreshStaleMs: 5 * 60 * 1000,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api',
      getProfileDir,
      getToolConfigDir,
      accountStateService: {
        clearRuntimeBlock(provider, accountId, options) {
          const { evidence: _evidence, ...baseState } = options;
          const runtimeState = null;
          runtimeWrites.push({ provider, accountId, runtimeState, baseState });
          return true;
        }
      },
      writeUsageCache: cacheService.writeUsageCache,
      readUsageCache: cacheService.readUsageCache
    });

    const snapshot = await usageSnapshotService.ensureUsageSnapshotAsync('codex', '17', null, { forceRefresh: true });

    assert.ok(snapshot);
    assert.equal(snapshot.fallbackSource, 'account_read');
    assert.equal(runtimeWrites.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codex usage snapshot async keeps fresh depleted cache until it becomes stale', async () => {
  const root = mkTmpDir();
  try {
    const getProfileDir = (cliName, id) => path.join(root, 'profiles', cliName, String(id));
    const getToolConfigDir = (cliName, id) => path.join(getProfileDir(cliName, id), `.${cliName}`);
    const profileDir = getProfileDir('codex', '11');
    fs.mkdirSync(profileDir, { recursive: true });

    let fetchCalls = 0;
    let spawnCalls = 0;
    const usageSnapshotService = createUsageSnapshotService({
      fs,
      path,
      spawnSync: () => ({ stdout: '', stderr: '' }),
      spawn: () => {
        spawnCalls += 1;
        throw new Error('spawn should not be called');
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error('fetch should not be called');
      },
      processObj: {
        execPath: process.execPath,
        cwd: () => root,
        env: {},
        platform: process.platform
      },
      resolveCliPath: () => '/usr/bin/codex',
      usageSnapshotSchemaVersion: 2,
      usageRefreshStaleMs: 60 * 1000,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api',
      getProfileDir,
      getToolConfigDir,
      writeUsageCache: () => {},
      readUsageCache: () => null
    });

    const now = Date.now();
    const cache = {
      schemaVersion: 2,
      kind: 'codex_oauth_status',
      source: 'codex_app_server',
      capturedAt: now - 10_000,
      entries: [{
        bucket: 'primary',
        windowMinutes: 300,
        window: '5h',
        remainingPct: 0,
        resetIn: '4h',
        resetAtMs: now + 4 * 60 * 60 * 1000
      }]
    };

    const snapshot = await usageSnapshotService.ensureUsageSnapshotAsync('codex', '11', cache);
    assert.equal(snapshot, cache);
    assert.equal(fetchCalls, 0);
    assert.equal(spawnCalls, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codex usage snapshot async drops stale depleted cache when refresh can no longer confirm usage', async () => {
  const root = mkTmpDir();
  try {
    const getProfileDir = (cliName, id) => path.join(root, 'profiles', cliName, String(id));
    const getToolConfigDir = (cliName, id) => path.join(getProfileDir(cliName, id), `.${cliName}`);
    const profileDir = getProfileDir('codex', '111');
    fs.mkdirSync(profileDir, { recursive: true });

    let fetchCalls = 0;
    let spawnCalls = 0;
    const usageSnapshotService = createUsageSnapshotService({
      fs,
      path,
      spawnSync: () => ({ stdout: '', stderr: '' }),
      spawn: () => {
        spawnCalls += 1;
        throw new Error('spawn should be attempted for stale depleted cache');
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        return null;
      },
      processObj: {
        execPath: process.execPath,
        cwd: () => root,
        env: {},
        platform: process.platform
      },
      resolveCliPath: () => '/usr/bin/codex',
      usageSnapshotSchemaVersion: 2,
      usageRefreshStaleMs: 1,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api',
      getProfileDir,
      getToolConfigDir,
      writeUsageCache: () => {},
      readUsageCache: () => null
    });

    const now = Date.now();
    const cache = {
      schemaVersion: 2,
      kind: 'codex_oauth_status',
      source: 'codex_app_server',
      capturedAt: now - 10_000,
      entries: [{
        bucket: 'primary',
        windowMinutes: 300,
        window: '5h',
        remainingPct: 0,
        resetIn: '4h',
        resetAtMs: now + 4 * 60 * 60 * 1000
      }]
    };

    const snapshot = await usageSnapshotService.ensureUsageSnapshotAsync('codex', '111', cache);
    assert.equal(snapshot, null);
    assert.equal(fetchCalls, 0);
    assert.equal(spawnCalls, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codex usage snapshot async still refreshes when remaining is above 0 even if reset is in the future', async () => {
  const root = mkTmpDir();
  try {
    const getProfileDir = (cliName, id) => path.join(root, 'profiles', cliName, String(id));
    const getToolConfigDir = (cliName, id) => path.join(getProfileDir(cliName, id), `.${cliName}`);
    const profileDir = getProfileDir('codex', '12');
    fs.mkdirSync(profileDir, { recursive: true });
    const codexConfigDir = getToolConfigDir('codex', '12');
    fs.mkdirSync(codexConfigDir, { recursive: true });
    fs.writeFileSync(path.join(codexConfigDir, 'auth.json'), JSON.stringify({
      tokens: {
        access_token: 'at_12',
        account_id: 'acc_12'
      }
    }));

    let fetchCalls = 0;
    let spawnCalls = 0;
    const usageSnapshotService = createUsageSnapshotService({
      fs,
      path,
      spawnSync: () => ({ stdout: '', stderr: '' }),
      spawn: () => {
        spawnCalls += 1;
        throw new Error('spawn should not be called');
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        return {
          ok: true,
          text: async () => JSON.stringify({
            rate_limits: {
              primary: { window_minutes: 300, used_percent: 90, resets_at: Math.floor(Date.now() / 1000) + 1800 }
            }
          })
        };
      },
      processObj: {
        execPath: process.execPath,
        cwd: () => root,
        env: {},
        platform: process.platform
      },
      resolveCliPath: () => '/usr/bin/codex',
      usageSnapshotSchemaVersion: 2,
      usageRefreshStaleMs: 1,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api',
      getProfileDir,
      getToolConfigDir,
      writeUsageCache: () => {},
      readUsageCache: () => null
    });

    const now = Date.now();
    const cache = {
      schemaVersion: 2,
      kind: 'codex_oauth_status',
      source: 'codex_app_server',
      capturedAt: now - 10_000,
      entries: [{
        bucket: 'primary',
        windowMinutes: 300,
        window: '5h',
        remainingPct: 56,
        resetIn: '4h',
        resetAtMs: now + 4 * 60 * 60 * 1000
      }]
    };

    const snapshot = await usageSnapshotService.ensureUsageSnapshotAsync('codex', '12', cache);
    assert.ok(snapshot);
    assert.notEqual(snapshot, cache);
    assert.equal(fetchCalls, 1);
    assert.equal(spawnCalls, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codex usage snapshot async forceRefresh bypasses cache freshness checks', async () => {
  const root = mkTmpDir();
  try {
    const getProfileDir = (cliName, id) => path.join(root, 'profiles', cliName, String(id));
    const getToolConfigDir = (cliName, id) => path.join(getProfileDir(cliName, id), `.${cliName}`);
    const profileDir = getProfileDir('codex', '14');
    const codexDir = getToolConfigDir('codex', '14');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({
      tokens: {
        access_token: 'at_14'
      }
    }));

    let fetchCalls = 0;
    const usageSnapshotService = createUsageSnapshotService({
      fs,
      path,
      spawnSync: () => ({ stdout: '', stderr: '' }),
      spawn: () => {
        throw new Error('spawn should not be called');
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        return {
          ok: true,
          text: async () => JSON.stringify({
            rate_limits: {
              primary: { window_minutes: 300, used_percent: 10, resets_at: Math.floor(Date.now() / 1000) + 1800 }
            }
          })
        };
      },
      processObj: {
        execPath: process.execPath,
        cwd: () => root,
        env: {},
        platform: process.platform
      },
      resolveCliPath: () => '/usr/bin/codex',
      usageSnapshotSchemaVersion: 2,
      usageRefreshStaleMs: 5 * 60 * 1000,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api',
      getProfileDir,
      getToolConfigDir,
      writeUsageCache: () => {},
      readUsageCache: () => null
    });

    const now = Date.now();
    const freshCache = {
      schemaVersion: 2,
      kind: 'codex_oauth_status',
      source: 'codex_app_server',
      capturedAt: now,
      entries: [{
        bucket: 'primary',
        windowMinutes: 300,
        window: '5h',
        remainingPct: 88,
        resetIn: '4h',
        resetAtMs: now + 4 * 60 * 60 * 1000
      }]
    };

    const snapshot = await usageSnapshotService.ensureUsageSnapshotAsync('codex', '14', freshCache, { forceRefresh: true });
    assert.ok(snapshot);
    assert.equal(fetchCalls, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codex usage snapshot async skips refresh when resetAtMs is derived from resetIn text', async () => {
  const root = mkTmpDir();
  try {
    const getProfileDir = (cliName, id) => path.join(root, 'profiles', cliName, String(id));
    const getToolConfigDir = (cliName, id) => path.join(getProfileDir(cliName, id), `.${cliName}`);
    const profileDir = getProfileDir('codex', '13');
    fs.mkdirSync(profileDir, { recursive: true });

    let fetchCalls = 0;
    let spawnCalls = 0;
    const usageSnapshotService = createUsageSnapshotService({
      fs,
      path,
      spawnSync: () => ({ stdout: '', stderr: '' }),
      spawn: () => {
        spawnCalls += 1;
        throw new Error('spawn should not be called');
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error('fetch should not be called');
      },
      processObj: {
        execPath: process.execPath,
        cwd: () => root,
        env: {},
        platform: process.platform
      },
      resolveCliPath: () => '/usr/bin/codex',
      usageSnapshotSchemaVersion: 2,
      usageRefreshStaleMs: 1,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api',
      getProfileDir,
      getToolConfigDir,
      writeUsageCache: () => {},
      readUsageCache: () => null
    });

    const now = Date.now();
    const cache = {
      schemaVersion: 2,
      kind: 'codex_oauth_status',
      source: 'codex_app_server',
      capturedAt: now,
      entries: [{
        bucket: 'primary',
        windowMinutes: 10080,
        window: '7days',
        remainingPct: 0,
        resetIn: '93h 45m'
      }]
    };

    const snapshot = await usageSnapshotService.ensureUsageSnapshotAsync('codex', '13', cache);
    assert.equal(snapshot, cache);
    assert.equal(fetchCalls, 0);
    assert.equal(spawnCalls, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codex usage snapshot async tolerates app-server stdin EPIPE and returns cache', async () => {
  const root = mkTmpDir();
  try {
    const getProfileDir = (cliName, id) => path.join(root, 'profiles', cliName, String(id));
    const getToolConfigDir = (cliName, id) => path.join(getProfileDir(cliName, id), `.${cliName}`);
    const profileDir = getProfileDir('codex', '15');
    fs.mkdirSync(profileDir, { recursive: true });

    let spawnCalls = 0;
    const spawnMock = () => {
      spawnCalls += 1;
      const child = new EventEmitter();
      child.pid = 12345;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.stderr.setEncoding = () => {};
      child.kill = () => {};
      child.stdin = new EventEmitter();
      child.stdin.write = (_chunk, cb) => {
        process.nextTick(() => {
          const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
          if (typeof cb === 'function') cb(err);
          child.stdin.emit('error', err);
        });
        return true;
      };
      child.stdin.end = () => {};
      return child;
    };

    const usageSnapshotService = createUsageSnapshotService({
      fs,
      path,
      spawn: spawnMock,
      spawnSync: () => ({ stdout: '', stderr: '' }),
      fetchImpl: async () => null,
      processObj: {
        execPath: process.execPath,
        cwd: () => root,
        env: {},
        platform: process.platform
      },
      resolveCliPath: () => '/usr/bin/codex',
      usageSnapshotSchemaVersion: 2,
      usageRefreshStaleMs: 1,
      usageSourceGemini: 'gemini_refresh_user_quota',
      usageSourceCodex: 'codex_app_server',
      usageSourceClaudeOauth: 'claude_oauth_usage_api',
      usageSourceClaudeAuthToken: 'claude_auth_token_usage_api',
      getProfileDir,
      getToolConfigDir,
      writeUsageCache: () => {},
      readUsageCache: () => null
    });

    const now = Date.now();
    const cache = {
      schemaVersion: 2,
      kind: 'codex_oauth_status',
      source: 'codex_app_server',
      capturedAt: now - 10_000,
      entries: [{
        bucket: 'primary',
        windowMinutes: 300,
        window: '5h',
        remainingPct: 42,
        resetIn: '2h',
        resetAtMs: now + 2 * 60 * 60 * 1000
      }]
    };

    const snapshot = await usageSnapshotService.ensureUsageSnapshotAsync('codex', '15', cache);
    assert.equal(snapshot, cache);
    assert.equal(spawnCalls >= 1, true);
    assert.equal(usageSnapshotService.getLastUsageProbeError('codex', '15'), 'stdin_write_failed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
