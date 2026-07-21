const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const persistentSession = require('../lib/runtime/persistent-session');
const registry = require('../lib/runtime/persistent-session-registry');
const { openAppStateDatabase } = require('../lib/server/app-state-store');
const { upsertAccountRefRecordInDatabase } = require('../lib/server/account-ref-store');
const {
  buildRestoreForwardArgs,
  buildRestoreChildEnv,
  planRestoreActions,
  createPersistentSessionRestore
} = require('../lib/cli/services/ai-cli/persistent-session-restore');

const ACCOUNT_REF_1 = 'acct_00000000000000000001';
const ACCOUNT_REF_2 = 'acct_00000000000000000002';
const CLAUDE_SOCKET = persistentSession.deriveSocket('claude', ACCOUNT_REF_1);
const CODEX_SOCKET = persistentSession.deriveSocket('codex', ACCOUNT_REF_2);

function makeAihHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-restore-'));
}

function entry(overrides = {}) {
  return {
    provider: 'claude',
    runtimeScope: ACCOUNT_REF_1,
    gateway: false,
    accountRef: ACCOUNT_REF_1,
    socket: CLAUDE_SOCKET,
    session: 'p-alpha-abc123',
    cwd: '/work/alpha',
    label: '',
    forwardArgs: [],
    createdAt: 1000,
    updatedAt: 1000,
    unrecoverable: '',
    ...overrides
  };
}

function registerRestoreAccount(aiHomeDir, provider, accountRef, cliAccountId) {
  const db = openAppStateDatabase(fs, aiHomeDir);
  try {
    upsertAccountRefRecordInDatabase(db, { provider, accountRef, cliAccountId });
  } finally {
    db.close();
  }
}

test('buildRestoreForwardArgs picks provider-native resume', () => {
  assert.deepEqual(buildRestoreForwardArgs('codex'), ['/resume']);
  assert.deepEqual(buildRestoreForwardArgs('claude'), ['--continue']);
  assert.deepEqual(buildRestoreForwardArgs('gemini'), []);
  assert.deepEqual(buildRestoreForwardArgs('agy'), []);
});

test('buildRestoreChildEnv sets detached target and strips interactive session flags', () => {
  const env = buildRestoreChildEnv({
    PATH: '/bin',
    [persistentSession.SESSION_ENV]: 'old-label',
    [persistentSession.RESUME_ENV]: '1',
    [persistentSession.MIRROR_ENV]: '1',
    [persistentSession.MARKER_ENV]: '1'
  }, entry(), persistentSession);
  assert.equal(env[persistentSession.DETACHED_ENV], '1');
  assert.equal(env[persistentSession.TARGET_ENV], 'p-alpha-abc123');
  assert.equal(env.PATH, '/bin');
  assert.ok(!(persistentSession.SESSION_ENV in env));
  assert.ok(!(persistentSession.RESUME_ENV in env));
  assert.ok(!(persistentSession.MIRROR_ENV in env));
  assert.ok(!(persistentSession.MARKER_ENV in env));
});

test('planRestoreActions: alive sessions are touched, missing-on-live-server dropped', () => {
  const probeBySocket = {
    [CLAUDE_SOCKET]: { trusted: true, noServer: false, aliveNames: new Set(['p-alpha-abc123']) }
  };
  const plan = planRestoreActions(
    [entry(), entry({ session: 'p-alpha-abc123-2' })],
    probeBySocket,
    { bootTimeMs: 500 }
  );
  assert.equal(plan.alive.length, 1);
  assert.equal(plan.drop.length, 1);
  assert.equal(plan.drop[0].session, 'p-alpha-abc123-2');
  assert.equal(plan.restore.length, 0);
});

test('planRestoreActions: no server + updatedAt before boot => reboot victim to restore', () => {
  const probeBySocket = { [CLAUDE_SOCKET]: { trusted: true, noServer: true, aliveNames: new Set() } };
  const plan = planRestoreActions(
    [entry({ updatedAt: 1000 })],
    probeBySocket,
    { bootTimeMs: 2000, cwdExists: () => true }
  );
  assert.equal(plan.restore.length, 1);
  assert.equal(plan.drop.length, 0);
});

test('planRestoreActions: no server + updatedAt after boot => ended this boot, dropped', () => {
  const probeBySocket = { [CLAUDE_SOCKET]: { trusted: true, noServer: true, aliveNames: new Set() } };
  const plan = planRestoreActions(
    [entry({ updatedAt: 9000 })],
    probeBySocket,
    { bootTimeMs: 2000, cwdExists: () => true }
  );
  assert.equal(plan.restore.length, 0);
  assert.equal(plan.drop.length, 1);
});

test('planRestoreActions: missing cwd => unrecoverable, untrusted probe => untouched', () => {
  const probeBySocket = {
    [CLAUDE_SOCKET]: { trusted: true, noServer: true, aliveNames: new Set() },
    [CODEX_SOCKET]: { trusted: false }
  };
  const plan = planRestoreActions(
    [
      entry({ updatedAt: 1000 }),
      entry({
        provider: 'codex',
        runtimeScope: ACCOUNT_REF_2,
        accountRef: ACCOUNT_REF_2,
        socket: CODEX_SOCKET,
        session: 'p-beta-def456'
      })
    ],
    probeBySocket,
    { bootTimeMs: 2000, cwdExists: () => false }
  );
  assert.equal(plan.unrecoverable.length, 1);
  assert.equal(plan.unrecoverable[0].unrecoverable, 'cwd-missing');
  assert.equal(plan.unknown.length, 1);
  assert.equal(plan.restore.length, 0);
});

test('restorePersistentSessions spawns detached aih children with resume args for reboot victims', () => {
  const home = makeAihHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-project-'));
  registerRestoreAccount(home, 'claude', ACCOUNT_REF_1, '1');
  registerRestoreAccount(home, 'codex', ACCOUNT_REF_2, '2');
  registry.writeEntry(home, entry({ cwd }), { now: 1000 });
  registry.writeEntry(home, entry({
    provider: 'codex',
    runtimeScope: ACCOUNT_REF_2,
    accountRef: ACCOUNT_REF_2,
    socket: CODEX_SOCKET,
    session: 's-work',
    cwd
  }), { now: 1000 });

  const spawned = [];
  const { restorePersistentSessions } = createPersistentSessionRestore({
    fs,
    path,
    os,
    processObj: { pid: 42, platform: 'linux', env: { PATH: '/bin' }, execPath: '/usr/bin/node' },
    aiHomeDir: home,
    aihBinPath: '/repo/bin/ai-home.js',
    persistentSession: {
      ...persistentSession,
      detectTmux: () => ({ available: true, reason: 'ok', command: 'tmux', viaShell: false })
    },
    spawnSync: () => ({ status: 1, stderr: 'no server running on /tmp/tmux-501/aih', stdout: '' }),
    spawn: (cmd, args, options) => {
      spawned.push({ cmd, args, options });
      return { unref() {} };
    }
  });

  const result = restorePersistentSessions({ now: 10000, bootTimeMs: 5000 });
  assert.equal(result.restored, 2);
  assert.equal(spawned.length, 2);

  const claudeChild = spawned.find((c) => c.args.includes('claude'));
  assert.deepEqual(claudeChild.args, ['/repo/bin/ai-home.js', 'claude', '1', '--continue']);
  assert.equal(claudeChild.options.cwd, cwd);
  assert.equal(claudeChild.options.detached, true);
  assert.equal(claudeChild.options.env[persistentSession.DETACHED_ENV], '1');
  assert.equal(claudeChild.options.env[persistentSession.TARGET_ENV], 'p-alpha-abc123');

  const codexChild = spawned.find((c) => c.args.includes('codex'));
  assert.deepEqual(codexChild.args, ['/repo/bin/ai-home.js', 'codex', '2', '/resume']);
  assert.equal(codexChild.options.env[persistentSession.TARGET_ENV], 's-work');

  // Lock is released so a subsequent run re-plans (children were spawned but
  // the fake spawn creates no real sessions, so they are victims again).
  const again = restorePersistentSessions({ now: 20000, bootTimeMs: 5000 });
  assert.equal(again.restored, 2);
});

test('restorePersistentSessions restores gateway targets without a synthetic account selector', () => {
  const home = makeAihHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-gateway-project-'));
  const socket = persistentSession.deriveSocket('codex', persistentSession.GATEWAY_RUNTIME_SCOPE);
  registry.writeEntry(home, entry({
    provider: 'codex',
    runtimeScope: persistentSession.GATEWAY_RUNTIME_SCOPE,
    gateway: true,
    accountRef: '',
    socket,
    session: 's-gateway',
    cwd
  }), { now: 1000 });

  const spawned = [];
  const { restorePersistentSessions } = createPersistentSessionRestore({
    fs,
    path,
    os,
    processObj: { pid: 42, platform: 'linux', env: {}, execPath: '/usr/bin/node' },
    aiHomeDir: home,
    aihBinPath: '/repo/bin/ai-home.js',
    persistentSession: {
      ...persistentSession,
      detectTmux: () => ({ available: true, reason: 'ok', command: 'tmux', viaShell: false })
    },
    spawnSync: () => ({ status: 1, stderr: 'no server running', stdout: '' }),
    spawn: (cmd, args, options) => {
      spawned.push({ cmd, args, options });
      return { unref() {} };
    }
  });

  const result = restorePersistentSessions({ now: 10000, bootTimeMs: 5000 });
  assert.equal(result.restored, 1);
  assert.deepEqual(spawned[0].args, ['/repo/bin/ai-home.js', 'codex', '/resume']);
  assert.equal(result.restoredSessions[0].gateway, true);
  assert.equal(Object.hasOwn(result.restoredSessions[0], 'cliAccountId'), false);
});

test('restorePersistentSessions drops entries for sessions closed on a live server and touches alive ones', () => {
  const home = makeAihHome();
  registry.writeEntry(home, entry({ session: 'p-alpha-abc123' }), { now: 1000 });
  registry.writeEntry(home, entry({ session: 'p-alpha-abc123-2' }), { now: 1000 });

  const listLine = ['p-alpha-abc123', '1', '123', '/work/alpha', 't', 'w', 'claude', '9', '2026-06-utf8', '', '0', '']
    .join(persistentSession.SESSION_LIST_SEPARATOR);
  const { restorePersistentSessions } = createPersistentSessionRestore({
    fs,
    path,
    os,
    processObj: { pid: 42, platform: 'linux', env: {}, execPath: '/usr/bin/node' },
    aiHomeDir: home,
    aihBinPath: '/repo/bin/ai-home.js',
    persistentSession: {
      ...persistentSession,
      detectTmux: () => ({ available: true, reason: 'ok', command: 'tmux', viaShell: false })
    },
    spawnSync: () => ({ status: 0, stderr: '', stdout: `${listLine}\n` }),
    spawn: () => { throw new Error('must not spawn'); }
  });

  const result = restorePersistentSessions({ now: 9000, bootTimeMs: 500 });
  assert.equal(result.restored, 0);
  assert.equal(result.alive, 1);
  assert.equal(result.dropped, 1);
  const rest = registry.listEntries(home);
  assert.equal(rest.length, 1);
  assert.equal(rest[0].session, 'p-alpha-abc123');
  assert.equal(rest[0].updatedAt, 9000);
});

test('restorePersistentSessions is a no-op inside a restore child and without tmux', () => {
  const home = makeAihHome();
  registry.writeEntry(home, entry(), { now: 1000 });

  const child = createPersistentSessionRestore({
    fs,
    path,
    os,
    processObj: { pid: 1, platform: 'linux', env: { [persistentSession.DETACHED_ENV]: '1' }, execPath: 'node' },
    aiHomeDir: home,
    persistentSession
  });
  assert.equal(child.restorePersistentSessions().skipped, 'restore-child');

  const noTmux = createPersistentSessionRestore({
    fs,
    path,
    os,
    processObj: { pid: 1, platform: 'linux', env: {}, execPath: 'node' },
    aiHomeDir: home,
    persistentSession: {
      ...persistentSession,
      detectTmux: () => ({ available: false, reason: 'not-found', command: '', viaShell: false })
    }
  });
  assert.equal(noTmux.restorePersistentSessions().skipped, 'no-tmux');
});

test('restorePersistentSessions honours the restore lock (concurrent runner skips)', () => {
  const home = makeAihHome();
  registry.writeEntry(home, entry(), { now: 1000 });
  const dir = registry.registryDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.restore.lock'), '999 5', 'utf8');

  const { restorePersistentSessions } = createPersistentSessionRestore({
    fs,
    path,
    os,
    processObj: { pid: 42, platform: 'linux', env: {}, execPath: 'node' },
    aiHomeDir: home,
    persistentSession: {
      ...persistentSession,
      detectTmux: () => ({ available: true, reason: 'ok', command: 'tmux', viaShell: false })
    },
    spawnSync: () => ({ status: 1, stderr: 'no server running', stdout: '' }),
    spawn: () => { throw new Error('must not spawn'); }
  });
  assert.equal(restorePersistentSessions({ now: Date.now() }).skipped, 'locked');
});
