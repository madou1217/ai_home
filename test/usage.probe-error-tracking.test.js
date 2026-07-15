const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createUsageSnapshotService } = require('../lib/cli/services/usage/snapshot');
const { createUsageCacheService } = require('../lib/cli/services/usage/cache');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');
const { resolveAccountRuntimeDir } = require('../lib/runtime/aih-storage-layout');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-probe-error-'));
}

function registerUsageAccount(root, provider, cliAccountId = '1') {
  const email = `${provider}-${cliAccountId}@example.com`;
  const accountRef = registerAccountIdentity(fs, root, {
    provider,
    cliAccountId,
    identitySeed: `oauth:${provider}:${email}`
  }).accountRef;
  const nativeAuthByProvider = {
    codex: { auth: { tokens: { access_token: 'fake-token', refresh_token: 'fake-refresh' } } },
    claude: { credentials: { claudeAiOauth: { accessToken: 'fake-token', refreshToken: 'fake-refresh' } } },
    gemini: {
      oauthCreds: { access_token: 'fake-token', refresh_token: 'fake-refresh' },
      googleAccounts: { active: email }
    },
    agy: {
      oauthToken: {
        auth_method: 'consumer',
        token: { access_token: 'fake-token', refresh_token: 'fake-refresh' }
      },
      email
    }
  };
  writeAccountNativeAuth(fs, root, accountRef, nativeAuthByProvider[provider]);
  return accountRef;
}

function makeBaseServiceOptions(root, overrides = {}) {
  const getProfileDir = (cliName, accountRef) => resolveAccountRuntimeDir(root, cliName, accountRef);
  const getToolConfigDir = (cliName, accountRef) => {
    const runtimeDir = getProfileDir(cliName, accountRef);
    if (cliName === 'agy') return path.join(runtimeDir, '.gemini', 'antigravity-cli');
    return path.join(runtimeDir, `.${cliName}`);
  };

  const cacheService = createUsageCacheService({
    fs,
    aiHomeDir: root,
    usageSnapshotSchemaVersion: 2,
    usageSourceGemini: 'gemini_refresh_user_quota',
    usageSourceCodex: 'codex_app_server',
    usageSourceClaudeOauth: 'claude_oauth_usage_api',
    usageSourceClaudeAuthToken: 'claude_auth_token_usage_api'
  });

  return {
    fs,
    path,
    spawnSync: overrides.spawnSync || (() => ({ stdout: '', stderr: '' })),
    processObj: {
      execPath: process.execPath,
      cwd: () => root,
      env: {},
      platform: process.platform
    },
    resolveCliPath: overrides.resolveCliPath || (() => '/usr/bin/fake'),
    aiHomeDir: root,
    usageSnapshotSchemaVersion: 2,
    usageRefreshStaleMs: 5 * 60 * 1000,
    usageSourceGemini: 'gemini_refresh_user_quota',
    usageSourceCodex: 'codex_app_server',
    usageSourceClaudeOauth: 'claude_oauth_usage_api',
    usageSourceClaudeAuthToken: 'claude_auth_token_usage_api',
    getProfileDir,
    getToolConfigDir,
    writeUsageCache: cacheService.writeUsageCache,
    readUsageCache: cacheService.readUsageCache,
    accountStateService: { clearRuntimeBlock: () => false },
    ...overrides
  };
}

// ─── Gemini probe error tracking ────────────────────────────────────────────

test('gemini probe records probe error when output markers are missing', () => {
  const root = mkTmpDir();
  try {
    const accountRef = registerUsageAccount(root, 'gemini');

    const service = createUsageSnapshotService(makeBaseServiceOptions(root, {
      spawnSync: () => ({ stdout: 'garbage output', stderr: '' }),
      resolveCliPath: () => '/usr/bin/gemini'
    }));

    const result = service.ensureUsageSnapshot('gemini', accountRef, null);
    assert.equal(result, null);

    const probeError = service.getLastUsageProbeError('gemini', accountRef);
    assert.ok(probeError, 'should have recorded a probe error');
    assert.ok(probeError.length > 0, 'probe error should be non-empty');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('gemini probe records probe_not_ok when ok is false', () => {
  const root = mkTmpDir();
  try {
    const accountRef = registerUsageAccount(root, 'gemini');

    const payload = JSON.stringify({ ok: false, error: 'auth_failed' });
    const stdout = `AIH_QUOTA_JSON_START\n${payload}\nAIH_QUOTA_JSON_END\n`;

    const service = createUsageSnapshotService(makeBaseServiceOptions(root, {
      spawnSync: () => ({ stdout, stderr: '' }),
      resolveCliPath: () => '/usr/bin/gemini'
    }));

    const result = service.ensureUsageSnapshot('gemini', accountRef, null);
    assert.equal(result, null);

    const probeError = service.getLastUsageProbeError('gemini', accountRef);
    assert.ok(probeError.includes('auth_failed'), `probe error should include the error message, got: ${probeError}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('gemini probe records empty_parsed_snapshot when buckets produce no models', () => {
  const root = mkTmpDir();
  try {
    const accountRef = registerUsageAccount(root, 'gemini');

    const payload = JSON.stringify({ ok: true, buckets: [] });
    const stdout = `AIH_QUOTA_JSON_START\n${payload}\nAIH_QUOTA_JSON_END\n`;

    const service = createUsageSnapshotService(makeBaseServiceOptions(root, {
      spawnSync: () => ({ stdout, stderr: '' }),
      resolveCliPath: () => '/usr/bin/gemini'
    }));

    const result = service.ensureUsageSnapshot('gemini', accountRef, null);
    assert.equal(result, null);

    const probeError = service.getLastUsageProbeError('gemini', accountRef);
    assert.equal(probeError, 'empty_parsed_snapshot');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('gemini probe clears probe error on successful snapshot', () => {
  const root = mkTmpDir();
  try {
    const accountRef = registerUsageAccount(root, 'gemini');

    // First: produce an error
    const failPayload = JSON.stringify({ ok: false, error: 'temp_failure' });
    const failStdout = `AIH_QUOTA_JSON_START\n${failPayload}\nAIH_QUOTA_JSON_END\n`;

    const spawnResults = [
      { stdout: failStdout, stderr: '' },
      {
        stdout: `AIH_QUOTA_JSON_START\n${JSON.stringify({
          ok: true,
          buckets: [{
            modelId: 'gemini-2.5-pro',
            remainingFraction: 0.75,
            resetTime: new Date(Date.now() + 3600000).toISOString()
          }]
        })}\nAIH_QUOTA_JSON_END\n`,
        stderr: ''
      }
    ];
    let callIndex = 0;

    const service = createUsageSnapshotService(makeBaseServiceOptions(root, {
      spawnSync: () => spawnResults[callIndex++],
      resolveCliPath: () => '/usr/bin/gemini'
    }));

    // First call fails
    service.ensureUsageSnapshot('gemini', accountRef, null);
    assert.ok(service.getLastUsageProbeError('gemini', accountRef), 'error should be set after failure');

    // Second call succeeds
    const snapshot = service.ensureUsageSnapshot('gemini', accountRef, null, { forceRefresh: true });
    assert.ok(snapshot, 'snapshot should be returned on success');
    assert.equal(service.getLastUsageProbeError('gemini', accountRef), '', 'probe error should be cleared on success');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('gemini probe records probe_exception on spawnSync throw', () => {
  const root = mkTmpDir();
  try {
    const accountRef = registerUsageAccount(root, 'gemini');

    const service = createUsageSnapshotService(makeBaseServiceOptions(root, {
      spawnSync: () => { throw new Error('spawn failed'); },
      resolveCliPath: () => '/usr/bin/gemini'
    }));

    const result = service.ensureUsageSnapshot('gemini', accountRef, null);
    assert.equal(result, null);

    const probeError = service.getLastUsageProbeError('gemini', accountRef);
    assert.equal(probeError, 'probe_exception');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── Claude probe error tracking ────────────────────────────────────────────

test('claude probe records probe error when output markers are missing', () => {
  const root = mkTmpDir();
  try {
    const accountRef = registerUsageAccount(root, 'claude');

    const service = createUsageSnapshotService(makeBaseServiceOptions(root, {
      spawnSync: () => ({ stdout: 'garbage output', stderr: '' })
    }));

    const result = service.ensureUsageSnapshot('claude', accountRef, null);
    assert.equal(result, null);

    const probeError = service.getLastUsageProbeError('claude', accountRef);
    assert.ok(probeError, 'should have recorded a probe error');
    assert.ok(probeError.length > 0, 'probe error should be non-empty');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('claude probe records probe_not_ok when response is not ok', () => {
  const root = mkTmpDir();
  try {
    const accountRef = registerUsageAccount(root, 'claude');

    const payload = JSON.stringify({ ok: false, error: 'rate_limited', status: 429 });
    const stdout = `AIH_CLAUDE_USAGE_JSON_START\n${payload}\nAIH_CLAUDE_USAGE_JSON_END\n`;

    const service = createUsageSnapshotService(makeBaseServiceOptions(root, {
      spawnSync: () => ({ stdout, stderr: '' })
    }));

    const result = service.ensureUsageSnapshot('claude', accountRef, null);
    assert.equal(result, null);

    const probeError = service.getLastUsageProbeError('claude', accountRef);
    assert.ok(probeError.includes('rate_limited') || probeError.includes('429'),
      `probe error should include error detail, got: ${probeError}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('claude probe records probe_exception on spawnSync throw', () => {
  const root = mkTmpDir();
  try {
    const accountRef = registerUsageAccount(root, 'claude');

    const service = createUsageSnapshotService(makeBaseServiceOptions(root, {
      spawnSync: () => { throw new Error('spawn failed'); }
    }));

    const result = service.ensureUsageSnapshot('claude', accountRef, null);
    assert.equal(result, null);

    const probeError = service.getLastUsageProbeError('claude', accountRef);
    assert.equal(probeError, 'probe_exception');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codex async app-server probe wraps windows batch launch', async () => {
  const root = mkTmpDir();
  try {
    const accountRef = registerUsageAccount(root, 'codex');
    const runtimeDir = resolveAccountRuntimeDir(root, 'codex', accountRef);
    const spawnCalls = [];
    const service = createUsageSnapshotService(makeBaseServiceOptions(root, {
      processObj: {
        execPath: process.execPath,
        cwd: () => root,
        env: { USERPROFILE: root, AIH_CODEX_USAGE_DIRECT: '0' },
        platform: 'win32'
      },
      resolveCliPath: () => 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd',
      spawn(command, args, options) {
        spawnCalls.push({ command, args, options });
        const child = new EventEmitter();
        child.pid = 1234;
        child.stdin = new EventEmitter();
        child.stdin.destroyed = false;
        child.stdin.writableEnded = false;
        child.stdin.write = (_payload, callback) => {
          if (typeof callback === 'function') callback();
        };
        child.stdin.end = () => {};
        child.stdout = new EventEmitter();
        child.stdout.setEncoding = () => {};
        child.stderr = new EventEmitter();
        child.stderr.setEncoding = () => {};
        child.kill = () => {};
        process.nextTick(() => {
          const error = new Error('simulated');
          error.code = 'SIMULATED';
          child.emit('error', error);
        });
        return child;
      }
    }));

    const result = await service.ensureUsageSnapshotAsync('codex', accountRef, null, { forceRefresh: true });
    assert.equal(result, null);
    assert.ok(spawnCalls.length >= 1);
    for (const call of spawnCalls) {
      assert.equal(call.command, 'cmd.exe');
      assert.deepEqual(call.args.slice(0, 3), ['/d', '/s', '/c']);
      assert.match(call.args[3], /codex\.cmd/);
      assert.match(call.args[3], /app-server/);
      assert.equal(call.options.env.HOME, root);
      assert.equal(call.options.env.USERPROFILE, root);
      assert.equal(call.options.env.CODEX_HOME, path.join(runtimeDir, '.codex'));
      assert.equal(call.options.env.CODEX_SQLITE_HOME, path.join(path.dirname(root), '.codex'));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── isUsageManagedCli consistency (via getAccountQuotaState) ────────────────

const { createUsageAccountRuntimeService } = require('../lib/cli/services/usage/account-runtime');

test('getAccountQuotaState calls ensureUsageSnapshot for gemini when refreshSnapshot is true', () => {
  const root = mkTmpDir();
  try {
    const accountRef = registerUsageAccount(root, 'gemini');

    let snapshotCalled = false;
    const service = createUsageAccountRuntimeService({
      path,
      fs,
      aiHomeDir: root,
      cliConfigs: { gemini: {} },
      createUsageScheduler: () => ({ start() {} }),
      getAccountStateIndex: () => null,
      accountStateService: null,
      lastActiveAccountByCli: {},
      usageIndexStaleRefreshMs: 60_000,
      usageIndexBgRefreshLimit: 10,
      checkStatus: () => ({ configured: true, accountName: 'user@example.com' }),
      readUsageCache: () => null,
      ensureUsageSnapshot: (_cliName, _id, cache) => {
        snapshotCalled = true;
        return cache;
      }
    });

    service.getAccountQuotaState('gemini', accountRef, { refreshSnapshot: true });
    assert.equal(snapshotCalled, true, 'ensureUsageSnapshot should be called for gemini');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getAccountQuotaState calls ensureUsageSnapshot for claude when refreshSnapshot is true', () => {
  const root = mkTmpDir();
  try {
    const accountRef = registerUsageAccount(root, 'claude');

    let snapshotCalled = false;
    const service = createUsageAccountRuntimeService({
      path,
      fs,
      aiHomeDir: root,
      cliConfigs: { claude: {} },
      createUsageScheduler: () => ({ start() {} }),
      getAccountStateIndex: () => null,
      accountStateService: null,
      lastActiveAccountByCli: {},
      usageIndexStaleRefreshMs: 60_000,
      usageIndexBgRefreshLimit: 10,
      checkStatus: () => ({ configured: true, accountName: 'user@example.com' }),
      readUsageCache: () => null,
      ensureUsageSnapshot: (_cliName, _id, cache) => {
        snapshotCalled = true;
        return cache;
      }
    });

    service.getAccountQuotaState('claude', accountRef, { refreshSnapshot: true });
    assert.equal(snapshotCalled, true, 'ensureUsageSnapshot should be called for claude');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('getAccountQuotaState calls ensureUsageSnapshot for agy when refreshSnapshot is true', () => {
  const root = mkTmpDir();
  try {
    const accountRef = registerUsageAccount(root, 'agy');

    let snapshotCalled = false;
    const service = createUsageAccountRuntimeService({
      path,
      fs,
      aiHomeDir: root,
      cliConfigs: { agy: {} },
      createUsageScheduler: () => ({ start() {} }),
      getAccountStateIndex: () => null,
      accountStateService: null,
      lastActiveAccountByCli: {},
      usageIndexStaleRefreshMs: 60_000,
      usageIndexBgRefreshLimit: 10,
      checkStatus: () => ({ configured: true, accountName: 'user@example.com' }),
      readUsageCache: () => null,
      ensureUsageSnapshot: (_cliName, _id, cache) => {
        snapshotCalled = true;
        return cache;
      }
    });

    service.getAccountQuotaState('agy', accountRef, { refreshSnapshot: true });
    assert.equal(snapshotCalled, true, 'ensureUsageSnapshot should be called for agy');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ─── getLastUsageProbeState integration ─────────────────────────────────────

test('gemini probe failure records timestamped probe state accessible via getLastUsageProbeState', () => {
  const root = mkTmpDir();
  try {
    const accountRef = registerUsageAccount(root, 'gemini');

    const service = createUsageSnapshotService(makeBaseServiceOptions(root, {
      spawnSync: () => ({ stdout: 'no markers', stderr: '' }),
      resolveCliPath: () => '/usr/bin/gemini'
    }));

    const before = Date.now();
    service.ensureUsageSnapshot('gemini', accountRef, null);
    const after = Date.now();

    const state = service.getLastUsageProbeState('gemini', accountRef);
    assert.ok(state, 'probe state should exist');
    assert.ok(state.error.length > 0, 'probe state error should be non-empty');
    assert.ok(state.checkedAt >= before && state.checkedAt <= after, 'checkedAt should be within test window');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
