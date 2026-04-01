const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAccountCleanupService } = require('../lib/cli/services/account/cleanup');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-cleanup-'));
}

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.`;
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

test('cleanupCodexAccounts deletes remaining-0 and status-401 free accounts without cascading cliproxyapi cleanup by default', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const homeDir = path.join(root, 'home');
  const profilesDir = path.join(homeDir, '.ai_home', 'profiles');
  const codexDir = path.join(profilesDir, 'codex');
  const clipDir = path.join(homeDir, '.cli-proxy-api');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.mkdirSync(clipDir, { recursive: true });

  writeJson(path.join(codexDir, '1', '.codex', 'auth.json'), {
    tokens: {
      id_token: makeJwt({ email: 'one@example.com' }),
      access_token: makeJwt({ email: 'one@example.com' }),
      refresh_token: 'rt_one',
      account_id: 'acct-one'
    }
  });
  writeJson(path.join(codexDir, '1', '.aih_usage.json'), {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    entries: [{ window: '5h', remainingPct: 50 }]
  });

  writeJson(path.join(codexDir, '2', '.codex', 'auth.json'), {
    tokens: {
      id_token: makeJwt({ email: 'two@example.com' }),
      access_token: makeJwt({ email: 'two@example.com' }),
      refresh_token: 'rt_two',
      account_id: 'acct-two'
    }
  });
  writeJson(path.join(codexDir, '2', '.aih_usage.json'), {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    entries: [{ window: '5h', remainingPct: 0 }]
  });

  writeJson(path.join(codexDir, '3', '.codex', 'auth.json'), {
    tokens: {
      id_token: makeJwt({ email: 'three@example.com' }),
      access_token: makeJwt({ email: 'three@example.com' }),
      refresh_token: 'rt_three',
      account_id: 'acct-three'
    }
  });

  fs.writeFileSync(path.join(clipDir, 'config.yaml'), 'auth-dir: "~/.cli-proxy-api"\n', 'utf8');
  writeJson(path.join(clipDir, 'two@example.com.json'), {
    type: 'codex',
    email: 'two@example.com',
    refresh_token: 'rt_two',
    account_id: 'acct-two'
  });
  writeJson(path.join(clipDir, 'three@example.com.json'), {
    type: 'codex',
    email: 'three@example.com',
    refresh_token: 'rt_three',
    account_id: 'acct-three'
  });

  const deleted = [];
  const service = createAccountCleanupService({
    fs,
    path,
    hostHomeDir: homeDir,
    profilesDir,
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    getAccountStateIndex: () => ({
      deleteAccountState: (provider, id) => deleted.push({ provider, id })
    }),
    checkStatus: () => ({ configured: true, accountName: 'OAuth' }),
    readUsageCache: (_cliName, id) => readJsonSafe(path.join(codexDir, String(id), '.aih_usage.json')),
    ensureUsageSnapshotAsync: async (_cliName, id, cache) => cache || { entries: [{ remainingPct: 99 }] },
    getLastUsageProbeError: (_cliName, id) => (String(id) === '3' ? 'direct_http_status_401' : '')
  });

  const scanEvents = [];
  const result = await service.cleanupCodexAccounts({
    onScanProgress: (event) => scanEvents.push(event)
  });
  assert.equal(result.jobs, 1000);
  assert.equal(result.scannedAccounts, 3);
  assert.deepEqual(result.removedAccounts.map((item) => item.id), ['2', '3']);
  assert.equal(result.removedAccounts.some((item) => item.reasons.includes('remaining_0')), true);
  assert.equal(result.removedAccounts.some((item) => item.reasons.includes('status_401')), true);
  assert.equal(scanEvents[0].total, 3);
  assert.equal(scanEvents.at(-1).scanned, 3);
  assert.deepEqual(deleted, [
    { provider: 'codex', id: '2' },
    { provider: 'codex', id: '3' }
  ]);
  assert.equal(fs.existsSync(path.join(codexDir, '1')), true);
  assert.equal(fs.existsSync(path.join(codexDir, '2')), false);
  assert.equal(fs.existsSync(path.join(codexDir, '3')), false);
  assert.deepEqual(result.removedCliproxyapiFiles, []);
  assert.equal(fs.existsSync(path.join(clipDir, 'two@example.com.json')), true);
  assert.equal(fs.existsSync(path.join(clipDir, 'three@example.com.json')), true);
});

test('cleanupCodexAccounts deletes cached remaining-0 accounts without forcing a fresh usage probe first', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const homeDir = path.join(root, 'home');
  const profilesDir = path.join(homeDir, '.ai_home', 'profiles');
  const codexDir = path.join(profilesDir, 'codex');
  fs.mkdirSync(codexDir, { recursive: true });

  writeJson(path.join(codexDir, '11', '.codex', 'auth.json'), {
    tokens: {
      id_token: makeJwt({ email: 'cached@example.com' }),
      access_token: makeJwt({ email: 'cached@example.com' }),
      refresh_token: 'rt_cached',
      account_id: 'acct-cached'
    }
  });
  writeJson(path.join(codexDir, '11', '.aih_usage.json'), {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    entries: [{ window: '5h', remainingPct: 0 }]
  });

  let refreshedIds = [];
  const service = createAccountCleanupService({
    fs,
    path,
    profilesDir,
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    getAccountStateIndex: () => null,
    checkStatus: () => ({ configured: true, accountName: 'OAuth' }),
    readUsageCache: (_cliName, id) => readJsonSafe(path.join(codexDir, String(id), '.aih_usage.json')),
    ensureUsageSnapshotAsync: async (_cliName, id) => {
      refreshedIds.push(String(id));
      throw new Error('should_not_refresh_cached_remaining_0');
    },
    getLastUsageProbeError: () => ''
  });

  const result = await service.cleanupCodexAccounts();
  assert.deepEqual(result.removedAccounts.map((item) => item.id), ['11']);
  assert.deepEqual(refreshedIds, []);
  assert.equal(fs.existsSync(path.join(codexDir, '11')), false);
});

test('cleanupCodexAccounts deletes cached low-remaining free accounts without forcing a fresh usage probe first', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const profilesDir = path.join(root, '.ai_home', 'profiles');
  const codexDir = path.join(profilesDir, 'codex');
  fs.mkdirSync(codexDir, { recursive: true });

  writeJson(path.join(codexDir, '12', '.codex', 'auth.json'), {
    tokens: {
      id_token: makeJwt({
        email: 'lowfree@example.com',
        'https://api.openai.com/auth': { chatgpt_plan_type: 'free' }
      }),
      access_token: makeJwt({
        email: 'lowfree@example.com',
        'https://api.openai.com/auth': { chatgpt_plan_type: 'free' }
      }),
      refresh_token: 'rt_low_free',
      account_id: 'acct-low-free'
    }
  });
  writeJson(path.join(codexDir, '12', '.aih_usage.json'), {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    entries: [{ window: '5h', remainingPct: 7 }]
  });

  let refreshedIds = [];
  const service = createAccountCleanupService({
    fs,
    path,
    profilesDir,
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    getAccountStateIndex: () => null,
    checkStatus: () => ({ configured: true, accountName: 'OAuth' }),
    readUsageCache: (_cliName, id) => readJsonSafe(path.join(codexDir, String(id), '.aih_usage.json')),
    ensureUsageSnapshotAsync: async (_cliName, id) => {
      refreshedIds.push(String(id));
      throw new Error('should_not_refresh_cached_low_remaining');
    },
    getLastUsageProbeError: () => ''
  });

  const result = await service.cleanupCodexAccounts();
  assert.deepEqual(result.removedAccounts.map((item) => item.id), ['12']);
  assert.equal(result.removedAccounts[0].reasons.includes('remaining_lt_10_free'), true);
  assert.deepEqual(refreshedIds, []);
  assert.equal(fs.existsSync(path.join(codexDir, '12')), false);
});

test('cleanupCodexAccounts keeps cached low-remaining non-free accounts', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const profilesDir = path.join(root, '.ai_home', 'profiles');
  const codexDir = path.join(profilesDir, 'codex');
  fs.mkdirSync(codexDir, { recursive: true });

  writeJson(path.join(codexDir, '13', '.codex', 'auth.json'), {
    tokens: {
      id_token: makeJwt({
        email: 'lowpaid@example.com',
        'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' }
      }),
      access_token: makeJwt({
        email: 'lowpaid@example.com',
        'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' }
      }),
      refresh_token: 'rt_low_paid',
      account_id: 'acct-low-paid'
    }
  });
  writeJson(path.join(codexDir, '13', '.aih_usage.json'), {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    entries: [{ window: '5h', remainingPct: 7 }]
  });

  const service = createAccountCleanupService({
    fs,
    path,
    profilesDir,
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    getAccountStateIndex: () => null,
    checkStatus: () => ({ configured: true, accountName: 'OAuth' }),
    readUsageCache: (_cliName, id) => readJsonSafe(path.join(codexDir, String(id), '.aih_usage.json')),
    ensureUsageSnapshotAsync: async (_cliName, _id, cache) => cache,
    getLastUsageProbeError: () => ''
  });

  const result = await service.cleanupCodexAccounts();
  assert.deepEqual(result.removedAccounts, []);
  assert.equal(fs.existsSync(path.join(codexDir, '13')), true);
});

test('cleanupCodexAccounts skips positive-cache accounts without live refresh by default', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const profilesDir = path.join(root, '.ai_home', 'profiles');
  const codexDir = path.join(profilesDir, 'codex');
  fs.mkdirSync(codexDir, { recursive: true });

  writeJson(path.join(codexDir, '21', '.codex', 'auth.json'), {
    tokens: {
      id_token: makeJwt({ email: 'positive@example.com' }),
      access_token: makeJwt({ email: 'positive@example.com' }),
      refresh_token: 'rt_positive',
      account_id: 'acct-positive'
    }
  });
  writeJson(path.join(codexDir, '21', '.aih_usage.json'), {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt: Date.now(),
    entries: [{ window: '5h', remainingPct: 83 }]
  });

  let refreshCalled = false;
  const service = createAccountCleanupService({
    fs,
    path,
    profilesDir,
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    getAccountStateIndex: () => null,
    checkStatus: () => ({ configured: true, accountName: 'OAuth' }),
    readUsageCache: (_cliName, id) => readJsonSafe(path.join(codexDir, String(id), '.aih_usage.json')),
    ensureUsageSnapshotAsync: async () => {
      refreshCalled = true;
      return null;
    },
    getLastUsageProbeError: () => ''
  });

  const result = await service.cleanupCodexAccounts();
  assert.deepEqual(result.removedAccounts, []);
  assert.equal(refreshCalled, false);
  assert.equal(fs.existsSync(path.join(codexDir, '21')), true);
});

test('cleanupCodexAccounts queries usage when cache is missing and deletes account when live result is remaining-0', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const profilesDir = path.join(root, '.ai_home', 'profiles');
  const codexDir = path.join(profilesDir, 'codex');
  fs.mkdirSync(codexDir, { recursive: true });

  writeJson(path.join(codexDir, '22', '.codex', 'auth.json'), {
    tokens: {
      id_token: makeJwt({ email: 'missing-cache@example.com' }),
      access_token: makeJwt({ email: 'missing-cache@example.com' }),
      refresh_token: 'rt_missing_cache',
      account_id: 'acct-missing-cache'
    }
  });

  let refreshCalled = false;
  const service = createAccountCleanupService({
    fs,
    path,
    profilesDir,
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    getAccountStateIndex: () => null,
    checkStatus: () => ({ configured: true, accountName: 'OAuth' }),
    readUsageCache: () => null,
    ensureUsageSnapshotAsync: async () => {
      refreshCalled = true;
      return {
        schemaVersion: 2,
        kind: 'codex_oauth_status',
        source: 'codex_app_server',
        capturedAt: Date.now(),
        entries: [{ window: '5h', remainingPct: 0 }]
      };
    },
    getLastUsageProbeError: () => ''
  });

  const result = await service.cleanupCodexAccounts();
  assert.equal(refreshCalled, true);
  assert.deepEqual(result.removedAccounts.map((item) => item.id), ['22']);
  assert.equal(fs.existsSync(path.join(codexDir, '22')), false);
});

test('cleanupCodexAccounts queries usage when cache is missing and deletes free account when live result is below 10%', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const profilesDir = path.join(root, '.ai_home', 'profiles');
  const codexDir = path.join(profilesDir, 'codex');
  fs.mkdirSync(codexDir, { recursive: true });

  writeJson(path.join(codexDir, '23', '.codex', 'auth.json'), {
    tokens: {
      id_token: makeJwt({
        email: 'missing-lowfree@example.com',
        'https://api.openai.com/auth': { chatgpt_plan_type: 'free' }
      }),
      access_token: makeJwt({
        email: 'missing-lowfree@example.com',
        'https://api.openai.com/auth': { chatgpt_plan_type: 'free' }
      }),
      refresh_token: 'rt_missing_low_free',
      account_id: 'acct-missing-low-free'
    }
  });

  let refreshCalled = false;
  const service = createAccountCleanupService({
    fs,
    path,
    profilesDir,
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    getAccountStateIndex: () => null,
    checkStatus: () => ({ configured: true, accountName: 'OAuth' }),
    readUsageCache: () => null,
    ensureUsageSnapshotAsync: async () => {
      refreshCalled = true;
      return {
        schemaVersion: 2,
        kind: 'codex_oauth_status',
        source: 'codex_app_server',
        capturedAt: Date.now(),
        entries: [{ window: '5h', remainingPct: 6 }]
      };
    },
    getLastUsageProbeError: () => ''
  });

  const result = await service.cleanupCodexAccounts();
  assert.equal(refreshCalled, true);
  assert.deepEqual(result.removedAccounts.map((item) => item.id), ['23']);
  assert.equal(result.removedAccounts[0].reasons.includes('remaining_lt_10_free'), true);
  assert.equal(fs.existsSync(path.join(codexDir, '23')), false);
});

test('cleanupCodexAccounts scans accounts in bisection order instead of always from the head', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const profilesDir = path.join(root, '.ai_home', 'profiles');
  const codexDir = path.join(profilesDir, 'codex');
  fs.mkdirSync(codexDir, { recursive: true });

  for (const id of ['1', '2', '3', '4', '5', '6', '7']) {
    writeJson(path.join(codexDir, id, '.codex', 'auth.json'), {
      tokens: {
        id_token: makeJwt({ email: `${id}@example.com` }),
        access_token: makeJwt({ email: `${id}@example.com` }),
        refresh_token: `rt_${id}`,
        account_id: `acct-${id}`
      }
    });
    writeJson(path.join(codexDir, id, '.aih_usage.json'), {
      schemaVersion: 2,
      kind: 'codex_oauth_status',
      source: 'codex_app_server',
      capturedAt: Date.now(),
      entries: [{ window: '5h', remainingPct: 50 }]
    });
  }

  const service = createAccountCleanupService({
    fs,
    path,
    profilesDir,
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    getAccountStateIndex: () => null,
    checkStatus: () => ({ configured: true, accountName: 'OAuth' }),
    readUsageCache: (_cliName, id) => readJsonSafe(path.join(codexDir, String(id), '.aih_usage.json')),
    ensureUsageSnapshotAsync: async (_cliName, _id, cache) => cache,
    getLastUsageProbeError: () => ''
  });

  const scannedIds = [];
  await service.cleanupCodexAccounts({
    jobs: 1,
    onScanProgress: (event) => {
      if (event && event.id) scannedIds.push(String(event.id));
    }
  });

  assert.deepEqual(scannedIds, ['4', '2', '6', '1', '3', '5', '7']);
});

test('cleanupCodexAccounts does not persist a cleanup cursor between runs', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const profilesDir = path.join(root, '.ai_home', 'profiles');
  const codexDir = path.join(profilesDir, 'codex');
  fs.mkdirSync(codexDir, { recursive: true });

  for (const id of ['1', '2', '3', '4', '5', '6', '7']) {
    writeJson(path.join(codexDir, id, '.codex', 'auth.json'), {
      tokens: {
        id_token: makeJwt({ email: `${id}@example.com` }),
        access_token: makeJwt({ email: `${id}@example.com` }),
        refresh_token: `rt_${id}`,
        account_id: `acct-${id}`
      }
    });
    writeJson(path.join(codexDir, id, '.aih_usage.json'), {
      schemaVersion: 2,
      kind: 'codex_oauth_status',
      source: 'codex_app_server',
      capturedAt: Date.now(),
      entries: [{ window: '5h', remainingPct: 50 }]
    });
  }

  const service = createAccountCleanupService({
    fs,
    path,
    profilesDir,
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    getAccountStateIndex: () => null,
    checkStatus: () => ({ configured: true, accountName: 'OAuth' }),
    readUsageCache: (_cliName, id) => readJsonSafe(path.join(codexDir, String(id), '.aih_usage.json')),
    ensureUsageSnapshotAsync: async (_cliName, _id, cache) => cache,
    getLastUsageProbeError: () => ''
  });

  const firstRun = [];
  await service.cleanupCodexAccounts({
    jobs: 1,
    onScanProgress: (event) => {
      if (event && event.id) firstRun.push(String(event.id));
    }
  });

  const secondRun = [];
  await service.cleanupCodexAccounts({
    jobs: 1,
    onScanProgress: (event) => {
      if (event && event.id) secondRun.push(String(event.id));
    }
  });

  const cleanupStateDir = path.join(root, '.ai_home', 'runtime-locks', 'codex-cleanup');
  assert.equal(fs.existsSync(path.join(cleanupStateDir, 'cursor.json')), false);
  assert.equal(firstRun[0], secondRun[0]);
});

test('cleanupCodexAccounts assigns different worker slots to concurrent runs', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const profilesDir = path.join(root, '.ai_home', 'profiles');
  const codexDir = path.join(profilesDir, 'codex');
  fs.mkdirSync(codexDir, { recursive: true });

  for (const id of ['1', '2', '3', '4', '5', '6', '7']) {
    writeJson(path.join(codexDir, id, '.codex', 'auth.json'), {
      tokens: {
        id_token: makeJwt({ email: `${id}@example.com` }),
        access_token: makeJwt({ email: `${id}@example.com` }),
        refresh_token: `rt_${id}`,
        account_id: `acct-${id}`
      }
    });
    writeJson(path.join(codexDir, id, '.aih_usage.json'), {
      schemaVersion: 2,
      kind: 'codex_oauth_status',
      source: 'codex_app_server',
      capturedAt: Date.now(),
      entries: [{ window: '5h', remainingPct: 50 }]
    });
  }

  let releaseGate;
  const slowGate = new Promise((resolve) => {
    releaseGate = resolve;
  });

  function createService() {
    return createAccountCleanupService({
      fs,
      path,
      profilesDir,
      getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
      getAccountStateIndex: () => null,
      checkStatus: () => ({ configured: true, accountName: 'OAuth' }),
      readUsageCache: (_cliName, id) => readJsonSafe(path.join(codexDir, String(id), '.aih_usage.json')),
      ensureUsageSnapshotAsync: async (_cliName, _id, cache) => {
        await slowGate;
        return cache;
      },
      getLastUsageProbeError: () => ''
    });
  }

  const firstEvents = [];
  const secondEvents = [];
  const firstPromise = createService().cleanupCodexAccounts({
    jobs: 1,
    workerWarmupMs: 100,
    onScanProgress: (event) => {
      if (event && event.id) firstEvents.push(event);
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  const secondPromise = createService().cleanupCodexAccounts({
    jobs: 1,
    workerWarmupMs: 100,
    onScanProgress: (event) => {
      if (event && event.id) secondEvents.push(event);
    }
  });
  await new Promise((resolve) => setImmediate(resolve));

  releaseGate();
  await Promise.all([firstPromise, secondPromise]);

  assert.equal(firstEvents.length > 0, true);
  assert.equal(secondEvents.length > 0, true);
  assert.notEqual(firstEvents[0].workerSlot, secondEvents[0].workerSlot);
});

test('cleanupCodexAccounts skips accounts already claimed by another cleanup worker', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const profilesDir = path.join(root, '.ai_home', 'profiles');
  const codexDir = path.join(profilesDir, 'codex');
  fs.mkdirSync(codexDir, { recursive: true });

  for (const id of ['1', '2']) {
    writeJson(path.join(codexDir, id, '.codex', 'auth.json'), {
      tokens: {
        id_token: makeJwt({ email: `${id}@example.com` }),
        access_token: makeJwt({ email: `${id}@example.com` }),
        refresh_token: `rt_${id}`,
        account_id: `acct-${id}`
      }
    });
    writeJson(path.join(codexDir, id, '.aih_usage.json'), {
      schemaVersion: 2,
      kind: 'codex_oauth_status',
      source: 'codex_app_server',
      capturedAt: Date.now(),
      entries: [{ window: '5h', remainingPct: 0 }]
    });
  }

  const claimDir = path.join(root, '.ai_home', 'runtime-locks', 'codex-cleanup', 'claims');
  fs.mkdirSync(claimDir, { recursive: true });
  fs.writeFileSync(path.join(claimDir, '1.lock'), `${JSON.stringify({ pid: process.pid, claimedAt: Date.now() })}\n`, 'utf8');

  const service = createAccountCleanupService({
    fs,
    path,
    profilesDir,
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    getAccountStateIndex: () => null,
    checkStatus: () => ({ configured: true, accountName: 'OAuth' }),
    readUsageCache: (_cliName, id) => readJsonSafe(path.join(codexDir, String(id), '.aih_usage.json')),
    ensureUsageSnapshotAsync: async (_cliName, _id, cache) => cache,
    getLastUsageProbeError: () => ''
  });

  const result = await service.cleanupCodexAccounts({ jobs: 1 });
  assert.deepEqual(result.removedAccounts.map((item) => item.id), ['2']);
  assert.equal(fs.existsSync(path.join(codexDir, '1')), true);
  assert.equal(fs.existsSync(path.join(codexDir, '2')), false);
});

test('parseDeleteSelectorTokens supports comma lists and ranges', async () => {
  const root = mkTmpDir();
  try {
    const profilesDir = path.join(root, '.ai_home', 'profiles');
    const service = createAccountCleanupService({
      fs,
      path,
      profilesDir,
      getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
      getAccountStateIndex: () => null,
      checkStatus: () => ({ configured: true, accountName: 'OAuth' }),
      readUsageCache: () => null,
      ensureUsageSnapshotAsync: async () => null,
      getLastUsageProbeError: () => ''
    });
    assert.deepEqual(service.parseDeleteSelectorTokens(['1,2', '4-6', '6', '9']), ['1', '2', '4', '5', '6', '9']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deleteAccountsForCli removes selected account directories and reports missing ids', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const profilesDir = path.join(root, '.ai_home', 'profiles');
  const codexDir = path.join(profilesDir, 'codex');
  fs.mkdirSync(path.join(codexDir, '1', '.codex'), { recursive: true });
  fs.mkdirSync(path.join(codexDir, '2', '.codex'), { recursive: true });

  const deletedStateRows = [];
  const service = createAccountCleanupService({
    fs,
    path,
    profilesDir,
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    getAccountStateIndex: () => ({
      deleteAccountState: (provider, id) => deletedStateRows.push({ provider, id })
    }),
    checkStatus: () => ({ configured: true, accountName: 'OAuth' }),
    readUsageCache: () => null,
    ensureUsageSnapshotAsync: async () => null,
    getLastUsageProbeError: () => ''
  });

  const result = service.deleteAccountsForCli('codex', ['1', '3', '2']);
  assert.deepEqual(result.deletedIds, ['1', '2']);
  assert.deepEqual(result.missingIds, ['3']);
  assert.equal(fs.existsSync(path.join(codexDir, '1')), false);
  assert.equal(fs.existsSync(path.join(codexDir, '2')), false);
  assert.deepEqual(deletedStateRows, [
    { provider: 'codex', id: '1' },
    { provider: 'codex', id: '2' }
  ]);
});

test('deleteAllAccountsForCli removes all numeric accounts for a provider', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const profilesDir = path.join(root, '.ai_home', 'profiles');
  const codexDir = path.join(profilesDir, 'codex');
  fs.mkdirSync(path.join(codexDir, '1', '.codex'), { recursive: true });
  fs.mkdirSync(path.join(codexDir, '7', '.codex'), { recursive: true });
  fs.mkdirSync(path.join(codexDir, '.tmp'), { recursive: true });

  const service = createAccountCleanupService({
    fs,
    path,
    profilesDir,
    getProfileDir: (cliName, id) => path.join(profilesDir, cliName, String(id)),
    getAccountStateIndex: () => null,
    checkStatus: () => ({ configured: true, accountName: 'OAuth' }),
    readUsageCache: () => null,
    ensureUsageSnapshotAsync: async () => null,
    getLastUsageProbeError: () => ''
  });

  const result = service.deleteAllAccountsForCli('codex');
  assert.equal(result.totalBeforeDelete, 2);
  assert.deepEqual(result.deletedIds, ['1', '7']);
  assert.equal(fs.existsSync(path.join(codexDir, '1')), false);
  assert.equal(fs.existsSync(path.join(codexDir, '7')), false);
  assert.equal(fs.existsSync(path.join(codexDir, '.tmp')), true);
});

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}
