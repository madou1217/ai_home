const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createUsageSnapshotService } = require('../lib/cli/services/usage/snapshot');
const { createUsageCacheService } = require('../lib/cli/services/usage/cache');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-usage-snapshot-'));
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
    assert.match(snapshot.entries[0].window, /plan:free/);
    assert.match(snapshot.entries[0].window, /user@example\.com/);

    const cached = cacheService.readUsageCache('codex', '1');
    assert.ok(cached);
    assert.equal(cached.entries[0].bucket, 'account');
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
        access_token: 'at_1',
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
    const usageSnapshotService = createUsageSnapshotService({
      fs,
      path,
      spawnSync: () => ({ stdout: '', stderr: '' }),
      spawn: () => {
        spawnCalls += 1;
        throw new Error('spawn should not be called when direct HTTP succeeds');
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        return {
          ok: true,
          text: async () => JSON.stringify({
            rate_limits: {
              primary: { window_minutes: 300, used_percent: 20, resets_at: Math.floor(Date.now() / 1000) + 3600 }
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
    assert.equal(spawnCalls, 0);
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
