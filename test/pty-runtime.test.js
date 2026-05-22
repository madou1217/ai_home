const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fsBase = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPtyRuntime } = require('../lib/cli/services/pty/runtime');
const { AIH_SERVER_PROFILE_ID } = require('../lib/account/self-relay-account');
const {
  createAccountArtifactHookService,
  createDefaultProviderArtifactHookRegistry
} = require('../lib/account/artifact-hooks');
const {
  shouldEnableShellDrawer,
  isShellDrawerToggleSequence,
  resolveShellDrawerLaunch,
  getShellDrawerPtyRows,
  getShellDrawerTotalHeight
} = require('../lib/cli/services/pty/shell-drawer');

function createMockProcess(env = {}, platform = 'linux', cwd = os.tmpdir()) {
  const proc = new EventEmitter();
  const rawModeCalls = [];
  const writes = [];

  const stdout = new EventEmitter();
  stdout.columns = 80;
  stdout.rows = 24;
  stdout.write = (chunk) => { writes.push(String(chunk || '')); };

  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.setRawMode = (enabled) => rawModeCalls.push(Boolean(enabled));
  stdin.resume = () => {};
  stdin.pause = () => {};

  proc.env = { ...env };
  proc.platform = platform;
  proc.execPath = process.execPath;
  proc.argv = [process.execPath, path.join(cwd, 'ai-home.js')];
  proc.stdout = stdout;
  proc.stdin = stdin;
  proc.cwd = () => cwd;
  proc.exit = (code) => {
    throw new Error(`EXIT:${code}`);
  };

  return { proc, rawModeCalls, writes };
}

function createRuntimeHarness(env = {}, overrides = {}) {
  const mockCwd = overrides.cwd || path.resolve(os.tmpdir());
  const { proc, rawModeCalls, writes } = createMockProcess(env, overrides.platform || 'linux', mockCwd);
  proc.pid = Number(overrides.pid || 10001);
  const lockRootBase = fsBase.mkdtempSync(path.join(os.tmpdir(), 'aih-pty-lock-'));
  const lockRoot = path.join(lockRootBase, 'workspace', 'ai_home');
  fsBase.mkdirSync(lockRoot, { recursive: true });
  const profileRoot = overrides.aiHomeDir || lockRoot;
  const hostHomeDir = overrides.hostHomeDir || path.dirname(profileRoot);
  const getProfileDir = overrides.getProfileDir || ((cliName, id) => path.join(profileRoot, 'profiles', cliName, String(id)));
  const alivePids = overrides.alivePids instanceof Set ? overrides.alivePids : null;
  proc.kill = (pid, signal) => {
    if (signal === 0) {
      const safePid = Number(pid);
      if (alivePids) {
        if (alivePids.has(safePid)) return;
      } else if (safePid === proc.pid) {
        return;
      }
    }
    throw new Error('ESRCH');
  };
  const spawns = [];
  const backgroundSpawns = [];
  const ptyWrites = [];
  let schedulerCalls = 0;
  const pty = {
    spawn(command, args, options) {
      const spawnedProc = {
        writes: [],
        resizeCalls: [],
        onData(cb) { this._onData = cb; },
        onExit(cb) { this._onExit = cb; },
        write(chunk) {
          this.writes.push(chunk);
          ptyWrites.push(chunk);
        },
        resize(cols, rows) {
          this.resizeCalls.push({ cols, rows });
        },
        kill() {
          this.killed = true;
        }
      };
      spawns.push({ command, args, options, proc: spawnedProc });
      return spawnedProc;
    }
  };

  const spawnImpl = overrides.spawn || (() => {
    const listeners = {};
    const child = {
      on(event, cb) { listeners[event] = cb; },
      kill() {}
    };
    backgroundSpawns.push({ child, listeners });
    return child;
  });

  const fsImpl = {
    existsSync: (target) => {
      const normalized = String(target || '');
      if (normalized.endsWith('.aih_env.json')) return false;
      return fsBase.existsSync(normalized);
    },
    readFileSync: fsBase.readFileSync.bind(fsBase),
    readdirSync: fsBase.readdirSync.bind(fsBase),
    statSync: fsBase.statSync.bind(fsBase),
    mkdirSync: fsBase.mkdirSync.bind(fsBase),
    openSync: fsBase.openSync.bind(fsBase),
    writeFileSync: fsBase.writeFileSync.bind(fsBase),
    closeSync: fsBase.closeSync.bind(fsBase),
    unlinkSync: fsBase.unlinkSync.bind(fsBase)
  };
  Object.assign(fsImpl, overrides.fs || {});

  const getAccountStateIndex = overrides.getAccountStateIndex || (() => ({
    getAccountState: () => null,
    upsertRuntimeState: () => true
  }));
  const accountStateService = overrides.accountStateService || {
    recordRuntimeFailure(provider, accountId, runtimeState, baseState) {
      const index = getAccountStateIndex();
      if (!index || typeof index.upsertRuntimeState !== 'function') return false;
      return index.upsertRuntimeState(provider, accountId, runtimeState, baseState);
    },
    clearRuntimeBlock(provider, accountId, options = {}) {
      const index = getAccountStateIndex();
      if (!index || typeof index.upsertRuntimeState !== 'function') return false;
      const { evidence: _evidence, ...baseState } = options;
      return index.upsertRuntimeState(provider, accountId, null, baseState);
    }
  };

  const runtime = createPtyRuntime({
    path: require('node:path'),
    fs: fsImpl,
    processObj: proc,
    pty,
    spawn: spawnImpl,
    spawnSync: overrides.spawnSync,
    execSync: overrides.execSync || (() => {}),
    resolveCliPath: overrides.resolveCliPath || (() => '/usr/bin/codex'),
    readServerConfig: overrides.readServerConfig || (() => ({ host: '127.0.0.1', port: 9527, apiKey: '' })),
    serverDaemon: overrides.serverDaemon || { status: () => ({ running: false }) },
    buildPtyLaunch: (command, args) => ({ command, args }),
    resolveWindowsBatchLaunch: (_cliName, cliBin) => ({ launchBin: cliBin, envPatch: {} }),
    shouldEnableShellDrawer,
    isShellDrawerToggleSequence,
    resolveShellDrawerLaunch,
    getShellDrawerPtyRows,
    getShellDrawerTotalHeight,
    readUsageConfig: () => ({}),
    cliConfigs: {
      codex: { pkg: '@openai/codex', loginArgs: ['login'] },
      claude: { pkg: '@anthropic-ai/claude-code', loginArgs: ['login'] }
    },
    aiHomeDir: profileRoot,
    hostHomeDir,
    getProfileDir,
    askYesNo: () => false,
    stripAnsi: (s) => s,
    ensureSessionStoreLinks: overrides.ensureSessionStoreLinks || (() => ({ migrated: 0, linked: 0 })),
    ensureUsageSnapshot: () => null,
    ensureUsageSnapshotAsync: overrides.ensureUsageSnapshotAsync || (async () => null),
    readUsageCache: overrides.readUsageCache || (() => null),
    getLastUsageProbeError: overrides.getLastUsageProbeError || (() => ''),
    getLastUsageProbeState: overrides.getLastUsageProbeState || (() => null),
    getUsageRemainingPercentValues: overrides.getUsageRemainingPercentValues || (() => []),
    getNextAvailableId: overrides.getNextAvailableId || (() => null),
    getAccountStateIndex,
    accountStateService,
    checkStatus: overrides.checkStatus || (() => ({ configured: true, accountName: 'oauth@example.com' })),
    markActiveAccount: () => {},
    ensureAccountUsageRefreshScheduler: () => { schedulerCalls += 1; },
    refreshIndexedStateForAccount: () => {},
    accountArtifactHooks: overrides.accountArtifactHooks,
    repairCodexSessionVisibility: overrides.repairCodexSessionVisibility,
    DatabaseSync: overrides.DatabaseSync
  });

  return {
    runtime,
    proc,
    writes,
    ptyWrites,
    spawns,
    backgroundSpawns,
    rawModeCalls,
    getSchedulerCalls: () => schedulerCalls,
    lockRoot,
    aiHomeDir: profileRoot,
    hostHomeDir,
    cwd: mockCwd
  };
}

test('runtime does not inject --skip-git-repo-check by default', () => {
  const { runtime, proc, spawns, rawModeCalls } = createRuntimeHarness();
  runtime.runCliPtyTracked('codex', '10086', ['--version'], false);
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, ['--version']);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime resolves bare codex slash resume to latest sqlite thread for cwd', () => {
  let expectedCwd = '';

  class FakeDatabaseSync {
    exec() {}
    prepare(sql) {
      if (String(sql || '').startsWith('PRAGMA table_info')) {
        return {
          all: () => [
            { name: 'id' },
            { name: 'cwd' },
            { name: 'updated_at_ms' },
            { name: 'archived' }
          ]
        };
      }
      return {
        get: (cwd) => {
          assert.equal(cwd, expectedCwd);
          return { id: 'thread-abc' };
        }
      };
    }
    close() {}
  }

  const { runtime, proc, spawns, rawModeCalls, hostHomeDir, cwd } = createRuntimeHarness({}, {
    DatabaseSync: FakeDatabaseSync
  });
  expectedCwd = cwd;

  const hostConfigDir = path.join(hostHomeDir, '.codex');
  fsBase.mkdirSync(hostConfigDir, { recursive: true });
  fsBase.writeFileSync(path.join(hostConfigDir, 'config.toml'), 'model = "gpt-5.5"\n', 'utf8');
  fsBase.writeFileSync(path.join(hostConfigDir, 'state_5.sqlite'), '', 'utf8');

  runtime.runCliPtyTracked('codex', '10086', ['/resume'], false);

  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, ['resume', '-m', 'gpt-5.5', 'thread-abc']);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime maps codex slash resume shortcut to native resume command', () => {
  const { runtime, proc, spawns, rawModeCalls } = createRuntimeHarness();

  runtime.runCliPtyTracked('codex', '10086', ['/resume', '--last'], false);

  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, ['resume', '--last']);
  assert.equal(spawns[0].options.rows, 23);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime leaves codex resume visibility to CLI hook without mutating state', () => {
  const calls = [];
  const { runtime, proc, spawns, rawModeCalls } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0'
  }, {
    repairCodexSessionVisibility: () => {
      calls.push(true);
      return { ok: true, scanned: 1 };
    }
  });

  runtime.runCliPtyTracked('codex', '10086', ['resume'], false);

  assert.equal(calls.length, 0);
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, ['resume']);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime reinitializes codex session links after config sync creates account config dir', () => {
  const aiHomeDir = fsBase.mkdtempSync(path.join(os.tmpdir(), 'aih-pty-session-links-'));
  const calls = [];
  const accountCodexDir = path.join(aiHomeDir, 'profiles', 'codex', '10086', '.codex');
  const { runtime, proc, rawModeCalls } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0'
  }, {
    aiHomeDir,
    ensureSessionStoreLinks: (cliName, accountId) => {
      calls.push({
        cliName,
        accountId,
        accountCodexDirExists: fsBase.existsSync(accountCodexDir)
      });
      return { migrated: 0, linked: 0 };
    }
  });

  runtime.runCliPtyTracked('codex', '10086', ['--version'], false);

  assert.equal(calls.length >= 2, true);
  assert.deepEqual(calls[0], {
    cliName: 'codex',
    accountId: '10086',
    accountCodexDirExists: false
  });
  assert.equal(calls.some((call) => call.accountCodexDirExists), true);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime keeps codex account auth isolated while sharing host sqlite state', () => {
  const { runtime, proc, spawns, aiHomeDir, hostHomeDir, rawModeCalls } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0'
  });
  const accountConfigDir = path.join(aiHomeDir, 'profiles', 'codex', '10086', '.codex');
  const hostCodexHome = path.join(hostHomeDir, '.codex');

  try {
    runtime.runCliPtyTracked('codex', '10086', ['--version'], false);

    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].options.env.CODEX_HOME, accountConfigDir);
    assert.equal(spawns[0].options.env.CODEX_SQLITE_HOME, hostCodexHome);
    const synced = fsBase.readFileSync(path.join(accountConfigDir, 'config.toml'), 'utf8');
    assert.match(synced, new RegExp(`^sqlite_home = "${hostCodexHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"$`, 'm'));
  } finally {
    assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  }
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime rebuilds codex account config from host template and account auth overrides', () => {
  const { runtime, proc, aiHomeDir, hostHomeDir, rawModeCalls } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0'
  });
  const hostConfigDir = path.join(hostHomeDir, '.codex');
  const accountConfigDir = path.join(aiHomeDir, 'profiles', 'codex', '10014', '.codex');
  fsBase.mkdirSync(hostConfigDir, { recursive: true });
  fsBase.mkdirSync(accountConfigDir, { recursive: true });
  fsBase.writeFileSync(path.join(hostConfigDir, 'config.toml'), [
    'model = "host-model"',
    'approval_policy = "on-request"',
    '',
    '[projects."/workspace/project-a"]',
    'trust_level = "trusted"',
    ''
  ].join('\n'), 'utf8');
  fsBase.writeFileSync(path.join(accountConfigDir, 'config.toml'), [
    '# Codex configuration for account 10014',
    'preferred_auth_method = "apikey"',
    'model_provider = "openai"',
    'model = "gpt-5.5"',
    'approval_policy = "never"',
    '',
    '[features]',
    'hooks = true',
    ''
  ].join('\n'), 'utf8');

  runtime.runCliPtyTracked('codex', '10014', ['--version'], false);

  const synced = fsBase.readFileSync(path.join(accountConfigDir, 'config.toml'), 'utf8');
  assert.match(synced, new RegExp(`^sqlite_home = "${hostConfigDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"$`, 'm'));
  assert.match(synced, /^model = "host-model"$/m);
  assert.match(synced, /^approval_policy = "on-request"$/m);
  assert.doesNotMatch(synced, /^\[features\]$/m);
  assert.match(synced, /\[projects\."\/workspace\/project-a"\]\ntrust_level = "trusted"/);
  assert.doesNotMatch(synced, /^model = "gpt-5\.5"$/m);
  assert.doesNotMatch(synced, /^approval_policy = "never"$/m);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime emits provider config update hook when codex account config changes', () => {
  const aiHomeDir = fsBase.mkdtempSync(path.join(os.tmpdir(), 'aih-pty-config-hook-'));
  const hostHomeDir = path.join(aiHomeDir, 'host');
  const profilesDir = path.join(aiHomeDir, 'profiles');
  const events = [];
  const hooks = createAccountArtifactHookService({
    fs: fsBase,
    path,
    profilesDir,
    getProfileDir: (provider, accountId) => path.join(profilesDir, provider, String(accountId)),
    providerHookRegistry: createDefaultProviderArtifactHookRegistry({
      providerOptions: {
        codex: {
          onAccountConfigUpdated: (event) => events.push(event)
        }
      }
    })
  });
  const { runtime, proc, rawModeCalls } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0'
  }, {
    aiHomeDir,
    hostHomeDir,
    getProfileDir: (provider, accountId) => path.join(profilesDir, provider, String(accountId)),
    accountArtifactHooks: hooks
  });
  const hostConfigDir = path.join(hostHomeDir, '.codex');
  const accountConfigDir = path.join(profilesDir, 'codex', '10014', '.codex');
  fsBase.mkdirSync(hostConfigDir, { recursive: true });
  fsBase.mkdirSync(accountConfigDir, { recursive: true });
  fsBase.writeFileSync(path.join(hostConfigDir, 'config.toml'), 'model = "host-model"\n', 'utf8');
  fsBase.writeFileSync(path.join(accountConfigDir, 'config.toml'), 'model = "account-model"\n', 'utf8');

  runtime.runCliPtyTracked('codex', '10014', ['--version'], false);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'account_config_updated');
  assert.equal(events[0].provider, 'codex');
  assert.equal(events[0].accountId, '10014');
  assert.equal(events[0].source, 'pty_config_sync');
  assert.deepEqual(events[0].changedPaths, [path.join(accountConfigDir, 'config.toml')]);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime ignores sibling codex account config while rebuilding from host template', () => {
  const { runtime, proc, aiHomeDir, hostHomeDir, rawModeCalls } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0'
  });
  const hostConfigDir = path.join(hostHomeDir, '.codex');
  const trustedAccountConfigDir = path.join(aiHomeDir, 'profiles', 'codex', '10086', '.codex');
  const targetAccountConfigDir = path.join(aiHomeDir, 'profiles', 'codex', '10014', '.codex');
  fsBase.mkdirSync(hostConfigDir, { recursive: true });
  fsBase.mkdirSync(trustedAccountConfigDir, { recursive: true });
  fsBase.mkdirSync(targetAccountConfigDir, { recursive: true });
  fsBase.writeFileSync(path.join(hostConfigDir, 'config.toml'), 'model = "host-model"\n', 'utf8');
  fsBase.writeFileSync(path.join(trustedAccountConfigDir, 'config.toml'), [
    'model = "trusted-account"',
    '',
    '[projects."/workspace/project-a"]',
    'trust_level = "trusted"',
    ''
  ].join('\n'), 'utf8');
  fsBase.writeFileSync(path.join(targetAccountConfigDir, 'config.toml'), 'model = "target-account"\n', 'utf8');

  runtime.runCliPtyTracked('codex', '10014', ['--version'], false);

  const synced = fsBase.readFileSync(path.join(targetAccountConfigDir, 'config.toml'), 'utf8');
  assert.match(synced, /^model = "host-model"$/m);
  assert.doesNotMatch(synced, /^model = "target-account"$/m);
  assert.doesNotMatch(synced, /^model = "trusted-account"$/m);
  assert.doesNotMatch(synced, /\[projects\."\/workspace\/project-a"\]\ntrust_level = "trusted"/);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime auto-skips codex upgrade prompt', () => {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const timers = [];
  global.setTimeout = (cb, ms) => {
    const timer = { cb, ms, cleared: false, unref() {} };
    timers.push(timer);
    return timer;
  };
  global.clearTimeout = (timer) => {
    if (timer) timer.cleared = true;
  };

  try {
    const { runtime, proc, spawns } = createRuntimeHarness({
      AIH_RUNTIME_SHOW_USAGE: '0'
    });

    runtime.runCliPtyTracked('codex', '10086', [], false);
    spawns[0].proc._onData('A new Codex version is available. Upgrade now or skip?');

    assert.deepEqual(spawns[0].proc.writes, []);
    assert.equal(timers.some((timer) => timer.ms === 10_000 && !timer.cleared), true);
    timers.find((timer) => timer.ms === 10_000 && !timer.cleared).cb();
    assert.deepEqual(spawns[0].proc.writes, ['skip\r']);
    assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
});

test('runtime accepts codex default prompt after delay', () => {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const timers = [];
  global.setTimeout = (cb, ms) => {
    const timer = { cb, ms, cleared: false, unref() {} };
    timers.push(timer);
    return timer;
  };
  global.clearTimeout = (timer) => {
    if (timer) timer.cleared = true;
  };

  try {
    const { runtime, proc, spawns } = createRuntimeHarness({
      AIH_RUNTIME_SHOW_USAGE: '0'
    });

    runtime.runCliPtyTracked('codex', '10086', [], false);
    spawns[0].proc._onData([
      'Do you trust the contents of this directory?',
      '› 1. Yes, continue',
      '  2. No, quit',
      'Press enter to continue'
    ].join('\n'));

    assert.deepEqual(spawns[0].proc.writes, []);
    assert.equal(timers.some((timer) => timer.ms === 10_000 && !timer.cleared), true);
    timers.find((timer) => timer.ms === 10_000 && !timer.cleared).cb();
    assert.deepEqual(spawns[0].proc.writes, ['\r']);
    assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
});

test('runtime cancels codex auto prompt when user answers manually', () => {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  const timers = [];
  global.setTimeout = (cb, ms) => {
    const timer = { cb, ms, cleared: false, unref() {} };
    timers.push(timer);
    return timer;
  };
  global.clearTimeout = (timer) => {
    if (timer) timer.cleared = true;
  };

  try {
    const { runtime, proc, spawns } = createRuntimeHarness({
      AIH_RUNTIME_SHOW_USAGE: '0'
    });

    runtime.runCliPtyTracked('codex', '10086', [], false);
    spawns[0].proc._onData('A new Codex version is available. Upgrade now or skip?');
    proc.stdin.emit('data', 'skip\r');

    const promptTimer = timers.find((timer) => timer.ms === 10_000);
    assert.equal(promptTimer.cleared, true);
    promptTimer.cb();
    assert.deepEqual(spawns[0].proc.writes, ['skip\r']);
    assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
});

test('runtime injects --skip-git-repo-check only when explicitly enabled', () => {
  const { runtime, proc, spawns, rawModeCalls } = createRuntimeHarness({
    AIH_CODEX_AUTO_SKIP_REPO_CHECK: '1'
  });
  runtime.runCliPtyTracked('codex', '10086', ['--version'], false);
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, ['--skip-git-repo-check', '--version']);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime injects codex remote proxy when local aih server is running', () => {
  const { runtime, proc, spawns, rawModeCalls, lockRoot } = createRuntimeHarness({
    AIH_CODEX_ENABLE_REMOTE_PROXY: '1'
  }, {
    serverDaemon: { status: () => ({ running: true, ready: true, state: 'running' }) },
    readServerConfig: () => ({ host: '0.0.0.0', port: 8317, apiKey: 'secret-key' })
  });
  const defaultPath = path.join(lockRoot, 'profiles', 'codex', '.aih_default');
  fsBase.mkdirSync(path.dirname(defaultPath), { recursive: true });
  fsBase.writeFileSync(defaultPath, '10086', 'utf8');
  runtime.runCliPtyTracked('codex', '10086', ['--version'], false);
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, [
    '--remote-auth-token-env',
    'AIH_CODEX_REMOTE_AUTH_TOKEN',
    '--remote',
    'ws://127.0.0.1:8317',
    '--version'
  ]);
  assert.equal(spawns[0].options.env.AIH_CODEX_REMOTE_AUTH_TOKEN, 'secret-key');

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime routes codex through the built-in AIH server profile when no account id is provided', () => {
  const { runtime, proc, spawns, rawModeCalls, lockRoot } = createRuntimeHarness({}, {
    serverDaemon: { status: () => ({ running: true, ready: true, state: 'running' }) },
    readServerConfig: () => ({ host: '0.0.0.0', port: 8317, apiKey: 'secret-key' })
  });

  runtime.runCliPtyTracked('codex', AIH_SERVER_PROFILE_ID, ['--version'], false);

  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, ['--version']);
  assert.equal(spawns[0].options.env.OPENAI_API_KEY, 'secret-key');
  assert.equal(spawns[0].options.env.OPENAI_BASE_URL, undefined);
  assert.equal(spawns[0].options.env.CODEX_HOME, path.join(lockRoot, 'profiles', 'codex', AIH_SERVER_PROFILE_ID, '.codex'));
  assert.equal(fsBase.existsSync(path.join(lockRoot, 'profiles', 'codex', AIH_SERVER_PROFILE_ID, '.aih_env.json')), true);
  const envJson = JSON.parse(fsBase.readFileSync(path.join(lockRoot, 'profiles', 'codex', AIH_SERVER_PROFILE_ID, '.aih_env.json'), 'utf8'));
  assert.equal(envJson.OPENAI_BASE_URL, 'http://127.0.0.1:8317/v1');
  assert.equal(envJson.OPENAI_API_KEY, 'secret-key');

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime restarts stale local aih server before injecting codex remote proxy', () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  const statusCalls = [];
  const stopCalls = [];
  const startCalls = [];
  const serverDaemon = {
    status(options) {
      statusCalls.push(options || null);
      if (statusCalls.length === 1) {
        return {
          running: true,
          ready: true,
          state: 'running',
          stale: true,
          staleReason: 'source_changed',
          pid: 1234
        };
      }
      return { running: true, ready: true, state: 'running', stale: false, pid: 4321 };
    },
    stop(options) {
      stopCalls.push(options || null);
      return { stopped: true, pid: 1234 };
    },
    start(args, options) {
      startCalls.push({ args, options });
      return Promise.resolve({ alreadyRunning: false, started: true, ready: false, state: 'starting', pid: 4321 });
    }
  };
  try {
    const { runtime, proc, spawns, rawModeCalls, lockRoot } = createRuntimeHarness({
      AIH_CODEX_ENABLE_REMOTE_PROXY: '1'
    }, {
      serverDaemon,
      readServerConfig: () => ({
        host: '127.0.0.1',
        port: 8317,
        apiKey: 'secret-key',
        managementKey: 'mgmt-secret'
      })
    });
    const defaultPath = path.join(lockRoot, 'profiles', 'codex', '.aih_default');
    fsBase.mkdirSync(path.dirname(defaultPath), { recursive: true });
    fsBase.writeFileSync(defaultPath, '10086', 'utf8');

    runtime.runCliPtyTracked('codex', '10086', ['resume', 'thread-id'], false);
    assert.equal(stopCalls.length, 1);
    assert.deepEqual(stopCalls[0], { gracefulStopWaitMs: 500 });
    assert.deepEqual(startCalls, [{
      args: ['--host', '127.0.0.1', '--port', '8317', '--api-key', 'secret-key', '--management-key', 'mgmt-secret'],
      options: { waitForReady: false, readyTimeoutMs: 7000 }
    }]);
    assert.equal(spawns.length, 1);
    assert.deepEqual(spawns[0].args, [
      '--remote-auth-token-env',
      'AIH_CODEX_REMOTE_AUTH_TOKEN',
      '--remote',
      'ws://127.0.0.1:8317',
      'resume',
      'thread-id'
    ]);
    assert.equal(spawns[0].options.env.AIH_CODEX_REMOTE_AUTH_TOKEN, 'secret-key');
    assert.equal(logs.some((line) => line.includes('server source is stale')), true);

    assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
    assert.deepEqual(rawModeCalls, [true, false]);
  } finally {
    console.log = originalLog;
  }
});

test('runtime does not inject codex remote proxy by default even when local server is running', () => {
  const { runtime, proc, spawns, rawModeCalls, lockRoot } = createRuntimeHarness({}, {
    serverDaemon: { status: () => ({ running: true, ready: true, state: 'running' }) },
    readServerConfig: () => ({ host: '127.0.0.1', port: 8317, apiKey: 'secret-key' })
  });
  const defaultPath = path.join(lockRoot, 'profiles', 'codex', '.aih_default');
  fsBase.mkdirSync(path.dirname(defaultPath), { recursive: true });
  fsBase.writeFileSync(defaultPath, '10086', 'utf8');

  runtime.runCliPtyTracked('codex', '10086', ['--version'], false);
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, ['--version']);
  assert.equal(spawns[0].options.env.AIH_CODEX_REMOTE_AUTH_TOKEN, undefined);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime does not override explicit codex remote argument', () => {
  const { runtime, proc, spawns, rawModeCalls, lockRoot } = createRuntimeHarness({}, {
    serverDaemon: { status: () => ({ running: true, ready: true, state: 'running' }) },
    readServerConfig: () => ({ host: '127.0.0.1', port: 8317, apiKey: 'secret-key' })
  });
  const defaultPath = path.join(lockRoot, 'profiles', 'codex', '.aih_default');
  fsBase.mkdirSync(path.dirname(defaultPath), { recursive: true });
  fsBase.writeFileSync(defaultPath, '10086', 'utf8');
  runtime.runCliPtyTracked('codex', '10086', ['--remote', 'ws://custom-host:9000', '--version'], false);
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, ['--remote', 'ws://custom-host:9000', '--version']);
  assert.equal(spawns[0].options.env.AIH_CODEX_REMOTE_AUTH_TOKEN, undefined);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime autostarts local aih server before injecting codex remote proxy', () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  const statusCalls = [];
  const startCalls = [];
  const serverDaemon = {
    status(options) {
      statusCalls.push(options || null);
      if (statusCalls.length === 1) return { running: false, ready: false, state: 'stopped' };
      return { running: true, ready: true, state: 'running', pid: 4321 };
    },
    start(args, options) {
      startCalls.push({ args, options });
      return Promise.resolve({ alreadyRunning: false, started: true, ready: false, state: 'starting', pid: 4321 });
    }
  };
  try {
    const { runtime, proc, spawns, rawModeCalls, lockRoot } = createRuntimeHarness({
      AIH_CODEX_ENABLE_REMOTE_PROXY: '1'
    }, {
      serverDaemon,
      readServerConfig: () => ({
        host: '127.0.0.1',
        port: 8317,
        apiKey: 'secret-key',
        managementKey: 'mgmt-secret'
      })
    });
    const defaultPath = path.join(lockRoot, 'profiles', 'codex', '.aih_default');
    fsBase.mkdirSync(path.dirname(defaultPath), { recursive: true });
    fsBase.writeFileSync(defaultPath, '10086', 'utf8');

    runtime.runCliPtyTracked('codex', '10086', ['resume', 'thread-id'], false);
    assert.equal(spawns.length, 1);
    assert.deepEqual(startCalls, [{
      args: ['--host', '127.0.0.1', '--port', '8317', '--api-key', 'secret-key', '--management-key', 'mgmt-secret'],
      options: { waitForReady: false, readyTimeoutMs: 7000 }
    }]);
    assert.deepEqual(spawns[0].args, [
      '--remote-auth-token-env',
      'AIH_CODEX_REMOTE_AUTH_TOKEN',
      '--remote',
      'ws://127.0.0.1:8317',
      'resume',
      'thread-id'
    ]);
    assert.equal(spawns[0].options.env.AIH_CODEX_REMOTE_AUTH_TOKEN, 'secret-key');
    assert.equal(logs.some((line) => line.includes('Codex remote proxy server not running')), true);

    assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
    assert.deepEqual(rawModeCalls, [true, false]);
  } finally {
    console.log = originalLog;
  }
});

test('runtime skips codex remote proxy for non-default account ids', () => {
  const { runtime, proc, spawns, rawModeCalls, lockRoot } = createRuntimeHarness({
    AIH_CODEX_ENABLE_REMOTE_PROXY: '1'
  }, {
    serverDaemon: { status: () => ({ running: true, ready: true, state: 'running' }) },
    readServerConfig: () => ({ host: '127.0.0.1', port: 8317, apiKey: 'secret-key' })
  });
  const defaultPath = path.join(lockRoot, 'profiles', 'codex', '.aih_default');
  fsBase.mkdirSync(path.dirname(defaultPath), { recursive: true });
  fsBase.writeFileSync(defaultPath, '99999', 'utf8');

  runtime.runCliPtyTracked('codex', '10086', ['--version'], false);
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, ['--version']);
  assert.equal(spawns[0].options.env.AIH_CODEX_REMOTE_AUTH_TOKEN, undefined);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime forwards login flags when running login flow', () => {
  const { runtime, proc, spawns, rawModeCalls } = createRuntimeHarness();
  runtime.runCliPtyTracked('codex', '10086', ['--no-browser'], true);
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, ['login', '--device-auth']);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime mirrors proxy env vars across lower/upper case for CLI compatibility', () => {
  const { runtime, proc, spawns, rawModeCalls } = createRuntimeHarness({
    https_proxy: 'http://127.0.0.1:6152',
    no_proxy: 'localhost,127.0.0.1'
  });
  runtime.runCliPtyTracked('codex', '10086', ['--version'], false);
  assert.equal(spawns.length, 1);
  const env = spawns[0].options.env || {};
  assert.equal(env.https_proxy, 'http://127.0.0.1:6152');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:6152');
  assert.equal(env.no_proxy, 'localhost,127.0.0.1');
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1');

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime strips inherited codex session env from spawned sandbox', () => {
  const { runtime, proc, spawns, rawModeCalls, aiHomeDir, hostHomeDir } = createRuntimeHarness({
    CODEX_THREAD_ID: 'outer-thread',
    CODEX_TURN_ID: 'outer-turn',
    CODEX_CI: '1',
    CODEX_MANAGED_BY_NPM: '1',
    CODEX_MANAGED_PACKAGE_ROOT: '/tmp/outer-codex',
    CODEX_NETWORK_PROXY_ACTIVE: '1'
  });

  runtime.runCliPtyTracked('codex', '10086', ['--version'], false);

  assert.equal(spawns.length, 1);
  const env = spawns[0].options.env || {};
  assert.equal(env.CODEX_THREAD_ID, undefined);
  assert.equal(env.CODEX_TURN_ID, undefined);
  assert.equal(env.CODEX_CI, undefined);
  assert.equal(env.CODEX_MANAGED_BY_NPM, undefined);
  assert.equal(env.CODEX_MANAGED_PACKAGE_ROOT, undefined);
  assert.equal(env.CODEX_NETWORK_PROXY_ACTIVE, undefined);
  assert.equal(env.CODEX_HOME, path.join(aiHomeDir, 'profiles', 'codex', '10086', '.codex'));
  assert.equal(env.CODEX_SQLITE_HOME, path.join(hostHomeDir, '.codex'));

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime does not start usage refresh scheduler in PTY mode by default', () => {
  const { runtime, proc, getSchedulerCalls } = createRuntimeHarness();
  runtime.runCliPtyTracked('codex', '10086', ['--version'], false);
  assert.equal(getSchedulerCalls(), 0);
  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime starts usage refresh scheduler only when explicitly enabled', () => {
  const { runtime, proc, getSchedulerCalls } = createRuntimeHarness({
    AIH_RUNTIME_ENABLE_USAGE_SCHEDULER: '1'
  });
  runtime.runCliPtyTracked('codex', '10086', ['--version'], false);
  assert.equal(getSchedulerCalls(), 1);
  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime auto-switch resumes the latest codex thread for the current project', () => {
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  const realSetTimeout = global.setTimeout;
  const intervalTicks = [];
  let expectedCwd = '';

  class FakeDatabaseSync {
    constructor() {}
    exec() {}
    prepare(sql) {
      if (String(sql || '').startsWith('PRAGMA table_info')) {
        return {
          all: () => [
            { name: 'id' },
            { name: 'cwd' },
            { name: 'updated_at_ms' },
            { name: 'archived' }
          ]
        };
      }
      return {
        get: (cwd) => {
          assert.equal(cwd, expectedCwd);
          return { id: 'thread-123' };
        }
      };
    }
    close() {}
  }

  global.setInterval = (cb, ms) => {
    if (ms >= 30_000 && typeof cb === 'function') {
      intervalTicks.push(cb);
    }
    return { unref() {} };
  };
  global.clearInterval = () => {};
  global.setTimeout = (cb) => {
    cb();
    return { unref() {} };
  };

  try {
    const now = Date.now();
    const { runtime, proc, spawns, aiHomeDir, hostHomeDir, cwd } = createRuntimeHarness({
      AIH_RUNTIME_SHOW_USAGE: '0'
    }, {
      DatabaseSync: FakeDatabaseSync,
      readUsageCache: () => ({
        capturedAt: now,
        entries: [{ remainingPct: 4 }]
      }),
      getUsageRemainingPercentValues: (snapshot) => {
        if (!snapshot || !Array.isArray(snapshot.entries)) return [];
        return snapshot.entries.map((x) => Number(x.remainingPct)).filter((n) => Number.isFinite(n));
      },
      getNextAvailableId: () => '10087'
    });
    expectedCwd = cwd;

    const hostConfigDir = path.join(hostHomeDir, '.codex');
    fsBase.mkdirSync(hostConfigDir, { recursive: true });
    fsBase.writeFileSync(path.join(hostConfigDir, 'config.toml'), 'model = "gpt-5.5"\n', 'utf8');

    runtime.runCliPtyTracked('codex', '10086', [], false);
    const fromCodexDir = path.join(aiHomeDir, 'profiles', 'codex', '10086', '.codex');
    fsBase.mkdirSync(fromCodexDir, { recursive: true });
    fsBase.writeFileSync(path.join(fromCodexDir, 'state_5.sqlite'), '', 'utf8');

    assert.equal(spawns.length, 1);
    assert.equal(intervalTicks.length > 0, true);
    for (const tick of intervalTicks) {
      tick();
      if (spawns.length === 2) break;
    }

    assert.equal(spawns.length, 2);
    assert.deepEqual(spawns[1].args, ['resume', '-m', 'gpt-5.5', 'thread-123']);

    assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  } finally {
    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
    global.setTimeout = realSetTimeout;
  }
});

test('runtime toggles shell drawer with ctrl+alt+j and routes stdin to shell while open', () => {
  const { runtime, proc, spawns, rawModeCalls, cwd } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0'
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  assert.equal(spawns.length, 1);

  proc.stdin.emit('data', Buffer.from('\x1b\n'));
  assert.equal(spawns.length, 2);
  assert.equal(spawns[1].options.cwd, cwd);
  assert.deepEqual(spawns[1].args, []);
  assert.equal(rawModeCalls[0], true);

  proc.stdin.emit('data', Buffer.from('pwd'));
  assert.deepEqual(spawns[1].proc.writes.map((item) => String(item)), ['pwd']);
  assert.deepEqual(spawns[0].proc.writes, []);

  proc.stdin.emit('data', Buffer.from('\x1b\n'));
  proc.stdin.emit('data', Buffer.from('ls'));
  assert.deepEqual(spawns[1].proc.writes.map((item) => String(item)), ['pwd']);
  assert.deepEqual(spawns[0].proc.writes.map((item) => String(item)), ['ls']);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime resizes shell drawer pty to panel height when terminal size changes', () => {
  const { runtime, proc, spawns } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0',
    AIH_SHELL_DRAWER_HEIGHT: '6'
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  proc.stdin.emit('data', Buffer.from('\x1b\n'));

  assert.equal(spawns.length, 2);
  assert.equal(spawns[1].options.rows, 3);

  proc.stdout.columns = 100;
  proc.stdout.rows = 30;
  proc.stdout.emit('resize');

  assert.deepEqual(spawns[1].proc.resizeCalls, [
    { cols: 80, rows: 3 },
    { cols: 100, rows: 3 }
  ]);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime renders drawer borders when shell drawer opens', () => {
  const { runtime, proc, spawns, writes } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0'
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  proc.stdin.emit('data', Buffer.from('\x1b\n'));
  assert.equal(spawns.length, 2);
  assert.equal(writes.some((line) => line.includes('┌')), true);
  assert.equal(writes.some((line) => line.includes('└')), true);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime redraws drawer frame after shell output and keeps usage summary above drawer', () => {
  const now = Date.now();
  const { runtime, proc, spawns, writes } = createRuntimeHarness({}, {
    readUsageCache: () => ({
      capturedAt: now,
      entries: [{ remainingPct: 64.2 }]
    }),
    getUsageRemainingPercentValues: (snapshot) => {
      if (!snapshot || !Array.isArray(snapshot.entries)) return [];
      return snapshot.entries.map((x) => Number(x.remainingPct)).filter((n) => Number.isFinite(n));
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  proc.stdin.emit('data', Buffer.from('\x1b\n'));
  spawns[1].proc._onData('ls\r\nREADME.md\r\nlib\r\n');

  assert.equal(writes.some((line) => line.includes('account 10086 usage remaining')), true);
  assert.equal(writes.some((line) => line.includes('README.md')), true);
  assert.equal(writes.filter((line) => line.includes('└')).length >= 2, true);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime redraws fixed usage status after child output overwrites bottom row', async () => {
  const now = Date.now();
  const { runtime, proc, spawns, writes } = createRuntimeHarness({}, {
    readUsageCache: () => ({
      capturedAt: now,
      entries: [{ remainingPct: 64.2 }]
    }),
    getUsageRemainingPercentValues: (snapshot) => {
      if (!snapshot || !Array.isArray(snapshot.entries)) return [];
      return snapshot.entries.map((x) => Number(x.remainingPct)).filter((n) => Number.isFinite(n));
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  const before = writes.filter((line) => line.includes('account 10086 usage remaining: 64.2%')).length;
  spawns[0].proc._onData('assistant output that may touch the last row\r\n');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const after = writes.filter((line) => line.includes('account 10086 usage remaining: 64.2%')).length;

  assert.equal(after > before, true);
  assert.equal(writes.some((line) => line.includes('assistant output that may touch the last row')), true);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime reserves the last terminal row for the fixed usage status bar', () => {
  const { runtime, proc, spawns } = createRuntimeHarness();

  runtime.runCliPtyTracked('codex', '10086', [], false);

  assert.equal(spawns[0].options.rows, 23);

  proc.stdout.rows = 30;
  proc.stdout.emit('resize');

  assert.deepEqual(spawns[0].proc.resizeCalls, [{ cols: 80, rows: 29 }]);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime treats codex resume as interactive but keeps one-shot commands full height', () => {
  const resumeHarness = createRuntimeHarness();
  resumeHarness.runtime.runCliPtyTracked('codex', '10086', ['resume', 'thread-id'], false);

  assert.equal(resumeHarness.spawns[0].options.rows, 23);
  assert.throws(() => resumeHarness.proc.emit('SIGINT'), /EXIT:0/);

  const versionHarness = createRuntimeHarness();
  versionHarness.runtime.runCliPtyTracked('codex', '10086', ['--version'], false);

  assert.equal(versionHarness.spawns[0].options.rows, 24);
  assert.throws(() => versionHarness.proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime starts explicit codex resume without startup auth preflight', () => {
  const { runtime, proc, spawns, writes } = createRuntimeHarness({}, {
    getAccountStateIndex: () => ({
      getAccountState: () => ({
        status: 'up',
        configured: true,
        apiKeyMode: false,
        displayName: 'oauth@example.com'
      }),
      upsertRuntimeState: () => true
    })
  });

  runtime.runCliPtyTracked('codex', '10086', ['resume', 'thread-id'], false);

  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, ['resume', 'thread-id']);
  assert.equal(writes.some((line) => line.includes('checking account 10086 auth before starting Codex')), false);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime does not classify claude slash menu usage text as rate limit', async () => {
  const runtimeUpserts = [];
  const { runtime, proc, spawns, writes } = createRuntimeHarness({
    AIH_CODEX_AUTH_PREFLIGHT: '0',
    AIH_RUNTIME_SHOW_USAGE: '0'
  }, {
    getNextAvailableId: () => '10087',
    getAccountStateIndex: () => ({
      getAccountState: () => ({
        status: 'up',
        configured: true,
        apiKeyMode: true,
        displayName: 'API Key: sk-test'
      }),
      upsertRuntimeState(provider, accountId, runtimeState, baseState) {
        runtimeUpserts.push({ provider, accountId, runtimeState, baseState });
        return true;
      }
    })
  });

  runtime.runCliPtyTracked('claude', '4', [], false);
  assert.equal(spawns.length, 1);
  spawns[0].proc._onData([
    '/upgrade                         Upgrade to Max for higher rate limits and more Opus',
    '/usage                           Show plan usage limits'
  ].join('\r\n'));
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(spawns.length, 1);
  assert.equal(runtimeUpserts.length, 0);
  assert.equal(writes.some((line) => line.includes('limit detected')), false);
  assert.equal(writes.some((line) => line.includes('Auto-switch: 4 -> 10087')), false);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime repairs missing Claude native binary before spawning pty', () => {
  const root = fsBase.mkdtempSync(path.join(os.tmpdir(), 'aih-pty-claude-repair-'));
  const cliPath = path.join(root, 'bin', 'claude');
  const pkgRoot = path.join(root, 'bin', 'global', '5', '.pnpm', '@anthropic-ai+claude-code@2.1.140', 'node_modules', '@anthropic-ai', 'claude-code');
  const installScriptPath = path.join(pkgRoot, 'install.cjs');
  fsBase.mkdirSync(path.join(pkgRoot, 'bin'), { recursive: true });
  fsBase.writeFileSync(path.join(pkgRoot, 'package.json'), '{"name":"@anthropic-ai/claude-code"}\n');
  fsBase.writeFileSync(installScriptPath, 'console.log("install")\n', 'utf8');
  fsBase.writeFileSync(cliPath, [
    '#!/bin/sh',
    'basedir=$(dirname "$0")',
    '"$basedir/global/5/.pnpm/@anthropic-ai+claude-code@2.1.140/node_modules/@anthropic-ai/claude-code/bin/claude.exe" "$@"'
  ].join('\n'), 'utf8');
  fsBase.chmodSync(cliPath, 0o755);

  const calls = [];
  let probeCount = 0;
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const { runtime, proc, spawns, rawModeCalls } = createRuntimeHarness({
      AIH_RUNTIME_SHOW_USAGE: '0'
    }, {
      resolveCliPath: () => cliPath,
      spawnSync(command, args) {
        calls.push({ command, args });
        if (command === cliPath) {
          probeCount += 1;
          return probeCount === 1
            ? { status: 1, stdout: '', stderr: 'Error: claude native binary not installed.' }
            : { status: 0, stdout: '2.1.140\n', stderr: '' };
        }
        if (args && args[0] === installScriptPath) {
          return { status: 0, stdout: '', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: 'unexpected command' };
      }
    });

    runtime.runCliPtyTracked('claude', '4', ['--version'], false);

    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].command, cliPath);
    assert.deepEqual(calls.map((call) => [call.command, call.args[0]]), [
      [cliPath, '--version'],
      [process.execPath, installScriptPath],
      [cliPath, '--version']
    ]);
    assert.equal(logs.some((line) => line.includes('postinstall repair completed')), true);
    assert.equal(logs.some((line) => line.includes('native binary not installed')), false);
    assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
    assert.deepEqual(rawModeCalls, [true, false]);
  } finally {
    console.log = originalLog;
    fsBase.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime ignores cli output that only looks like a rate-limit error', async () => {
  const runtimeUpserts = [];
  const { runtime, proc, spawns, writes } = createRuntimeHarness({
    AIH_CODEX_AUTH_PREFLIGHT: '0',
    AIH_RUNTIME_SHOW_USAGE: '0'
  }, {
    getNextAvailableId: () => '10087',
    getAccountStateIndex: () => ({
      getAccountState: () => ({
        status: 'up',
        configured: true,
        apiKeyMode: false,
        displayName: 'limited@example.com'
      }),
      upsertRuntimeState(provider, accountId, runtimeState, baseState) {
        runtimeUpserts.push({ provider, accountId, runtimeState, baseState });
        return true;
      }
    })
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  assert.equal(spawns.length, 1);
  spawns[0].proc._onData('Error: usage limit reached. Please try again later.\r\n');
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(spawns.length, 1);
  assert.notEqual(spawns[0].proc.killed, true);
  assert.equal(runtimeUpserts.length, 0);
  assert.equal(writes.some((line) => line.includes('limit detected')), false);
  assert.equal(writes.some((line) => line.includes('Auto-switch: 10086 -> 10087')), false);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime ignores rate-limit-looking output even when standby account is runtime-blocked', async () => {
  const runtimeUpserts = [];
  const { runtime, proc, spawns, writes } = createRuntimeHarness({
    AIH_CODEX_AUTH_PREFLIGHT: '0',
    AIH_RUNTIME_SHOW_USAGE: '0'
  }, {
    getNextAvailableId: () => '10087',
    getAccountStateIndex: () => ({
      getAccountState: (_provider, accountId) => {
        if (String(accountId) === '10087') {
          return {
            runtime_state: {
              rateLimitUntil: Date.now() + 60_000,
              lastFailureKind: 'rate_limited',
              lastFailureReason: 'usage_limit_reached'
            }
          };
        }
        return {
          status: 'up',
          configured: true,
          apiKeyMode: false,
          displayName: 'limited@example.com'
        };
      },
      upsertRuntimeState(provider, accountId, runtimeState, baseState) {
        runtimeUpserts.push({ provider, accountId, runtimeState, baseState });
        return true;
      }
    })
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  assert.equal(spawns.length, 1);
  spawns[0].proc._onData('Error: usage limit reached. Please try again later.\r\n');
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(spawns.length, 1);
  assert.notEqual(spawns[0].proc.killed, true);
  assert.equal(runtimeUpserts.length, 0);
  assert.equal(writes.some((line) => line.includes('Auto-switch: 10086 -> 10087')), false);
  assert.equal(writes.some((line) => line.includes('no eligible standby account')), false);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime does not start windows clipboard mirror by default on native windows', () => {
  const spawnCalls = [];
  const { runtime, proc } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0'
  }, {
    platform: 'win32',
    spawn: (cmd, args) => {
      spawnCalls.push({ cmd, args });
      return {
        on() {},
        kill() {}
      };
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  assert.equal(spawnCalls.length, 0);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime starts windows clipboard mirror only when explicitly enabled on native windows', () => {
  const spawnCalls = [];
  const { runtime, proc } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0',
    AIH_WINDOWS_IMAGE_CLIPBOARD_MIRROR: '1'
  }, {
    platform: 'win32',
    spawn: (cmd, args) => {
      spawnCalls.push({ cmd, args });
      return {
        on() {},
        kill() {}
      };
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);

  assert.equal(spawnCalls.length > 0, true);
  const encoded = String(spawnCalls[0].args[3] || '');
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.equal(script.includes('GetForegroundWindow'), true);
  assert.equal(script.includes('GetWindowThreadProcessId'), true);
  assert.equal(script.includes('$ownerPid = 10001'), true);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime can disable windows clipboard mirror explicitly', () => {
  const spawnCalls = [];
  const { runtime, proc } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0',
    AIH_WINDOWS_IMAGE_CLIPBOARD_MIRROR: '0'
  }, {
    platform: 'win32',
    spawn: (cmd, args) => {
      spawnCalls.push({ cmd, args });
      return {
        on() {},
        kill() {}
      };
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);

  assert.equal(spawnCalls.length, 0);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime fixed status bar works when stdin is TTY even if stdout.isTTY is absent', async () => {
  const now = Date.now();
  const { runtime, proc, writes } = createRuntimeHarness({}, {
    readUsageCache: () => ({
      capturedAt: now,
      entries: [{ remainingPct: 91 }]
    }),
    getUsageRemainingPercentValues: (snapshot) => {
      if (!snapshot || !Array.isArray(snapshot.entries)) return [];
      return snapshot.entries.map((x) => Number(x.remainingPct)).filter((n) => Number.isFinite(n));
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(
    writes.some((line) => /\x1b\[s\x1b\[\d+;1H\x1b\[2K/.test(line)),
    true
  );
  assert.equal(writes.some((line) => line.startsWith('\r\n')), false);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime enforces single clipboard mirror process across multiple windows PTY instances', () => {
  const sharedHome = fsBase.mkdtempSync(path.join(os.tmpdir(), 'aih-pty-shared-'));
  const alivePids = new Set([11001, 11002]);
  const spawnCalls = [];
  const spawnImpl = (cmd, args) => {
    spawnCalls.push({ cmd, args });
    return {
      on() {},
      kill() {}
    };
  };

  const h1 = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0',
    AIH_WINDOWS_IMAGE_CLIPBOARD_MIRROR: '1'
  }, {
    platform: 'win32',
    aiHomeDir: sharedHome,
    pid: 11001,
    alivePids,
    spawn: spawnImpl
  });
  const h2 = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0',
    AIH_WINDOWS_IMAGE_CLIPBOARD_MIRROR: '1'
  }, {
    platform: 'win32',
    aiHomeDir: sharedHome,
    pid: 11002,
    alivePids,
    spawn: spawnImpl
  });

  h1.runtime.runCliPtyTracked('codex', '10086', [], false);
  h2.runtime.runCliPtyTracked('codex', '10087', [], false);

  assert.equal(spawnCalls.length, 1);

  assert.throws(() => h1.proc.emit('SIGINT'), /EXIT:0/);
  assert.throws(() => h2.proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime recovers stale clipboard mirror lock owned by dead process', () => {
  const sharedHome = fsBase.mkdtempSync(path.join(os.tmpdir(), 'aih-pty-stale-'));
  const lockDir = path.join(sharedHome, 'runtime-locks');
  const lockPath = path.join(lockDir, 'windows-clipboard-mirror.lock');
  fsBase.mkdirSync(lockDir, { recursive: true });
  fsBase.writeFileSync(lockPath, `${JSON.stringify({ pid: 999999, createdAt: Date.now() - 30_000 })}\n`, 'utf8');

  const spawnCalls = [];
  const { runtime, proc } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0',
    AIH_WINDOWS_IMAGE_CLIPBOARD_MIRROR: '1'
  }, {
    platform: 'win32',
    aiHomeDir: sharedHome,
    pid: 31001,
    spawn: (cmd, args) => {
      spawnCalls.push({ cmd, args });
      return {
        on() {},
        kill() {}
      };
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  assert.equal(spawnCalls.length, 1);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime releases clipboard mirror lock when all mirror spawn candidates fail', () => {
  const sharedHome = fsBase.mkdtempSync(path.join(os.tmpdir(), 'aih-pty-failed-spawn-'));
  const lockPath = path.join(sharedHome, 'runtime-locks', 'windows-clipboard-mirror.lock');
  const { runtime, proc } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0',
    AIH_WINDOWS_IMAGE_CLIPBOARD_MIRROR: '1'
  }, {
    platform: 'win32',
    aiHomeDir: sharedHome,
    pid: 41001,
    spawn: () => { throw new Error('spawn failed'); }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  assert.equal(fsBase.existsSync(lockPath), false);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.equal(fsBase.existsSync(lockPath), false);
});

test('runtime shows usage in PTY and auto-updates after direct no-cache refresh', async () => {
  const now = Date.now();
  let cache = {
    capturedAt: now - (6 * 60 * 1000),
    entries: [{ remainingPct: 75.5 }]
  };
  let refreshCalls = 0;
  const { runtime, proc, writes } = createRuntimeHarness({}, {
    readUsageCache: () => cache,
    ensureUsageSnapshotAsync: async () => {
      refreshCalls += 1;
      cache = {
        capturedAt: now,
        entries: [{ remainingPct: 63.2 }]
      };
      return cache;
    },
    getUsageRemainingPercentValues: (snapshot) => {
      if (!snapshot || !Array.isArray(snapshot.entries)) return [];
      return snapshot.entries.map((x) => Number(x.remainingPct)).filter((n) => Number.isFinite(n));
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  assert.ok(writes.some((line) => line.includes('usage remaining refreshing:')));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshCalls >= 1, true);
  assert.ok(writes.some((line) => line.includes('usage remaining: 63.2%')));

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime shows api-key mode without usage remaining and does not threshold-switch it', () => {
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  const intervalTicks = [];
  let nextAccountLookups = 0;

  global.setInterval = (cb, ms) => {
    if (ms >= 30_000 && typeof cb === 'function') intervalTicks.push(cb);
    return { unref() {} };
  };
  global.clearInterval = () => {};

  try {
    const now = Date.now();
    const { runtime, proc, writes, spawns, aiHomeDir } = createRuntimeHarness({}, {
      readUsageCache: () => ({
        capturedAt: now,
        entries: [{ remainingPct: 0 }]
      }),
      getUsageRemainingPercentValues: (snapshot) => {
        if (!snapshot || !Array.isArray(snapshot.entries)) return [];
        return snapshot.entries.map((x) => Number(x.remainingPct)).filter((n) => Number.isFinite(n));
      },
      getNextAvailableId: () => {
        nextAccountLookups += 1;
        return '10037';
      }
    });
    const accountConfigDir = path.join(aiHomeDir, 'profiles', 'codex', '10014', '.codex');
    fsBase.mkdirSync(accountConfigDir, { recursive: true });
    fsBase.writeFileSync(path.join(accountConfigDir, 'auth.json'), JSON.stringify({
      OPENAI_API_KEY: 'sk-external-relay'
    }), 'utf8');

    runtime.runCliPtyTracked('codex', '10014', [], false);
    for (const tick of intervalTicks) tick();

    assert.equal(spawns.length, 1);
    assert.equal(nextAccountLookups, 0);
    assert.ok(writes.some((line) => line.includes('account 10014 api-key mode')));
    assert.equal(writes.some((line) => line.includes('account 10014 usage remaining: 0.0%')), false);

    assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  } finally {
    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
  }
});

test('runtime shows persisted auth-invalid state before stale usage remaining', () => {
  const now = Date.now();
  const { runtime, proc, writes, spawns } = createRuntimeHarness({}, {
    readUsageCache: () => ({
      capturedAt: now,
      entries: [{ remainingPct: 95 }]
    }),
    getUsageRemainingPercentValues: (snapshot) => {
      if (!snapshot || !Array.isArray(snapshot.entries)) return [];
      return snapshot.entries.map((x) => Number(x.remainingPct)).filter((n) => Number.isFinite(n));
    },
    getAccountStateIndex: () => ({
      getAccountState: () => ({
        runtimeState: {
          authInvalidUntil: now + 60_000,
          lastFailureKind: 'auth_invalid',
          lastFailureReason: 'token_expired'
        }
      }),
      upsertRuntimeState: () => true
    })
  });

  runtime.runCliPtyTracked('codex', '10015', [], false);

  assert.equal(spawns.length, 0);
  assert.ok(writes.some((line) => line.includes('account 10015 auth expired')));
  assert.equal(writes.some((line) => line.includes('usage remaining: 95.0%')), false);
  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime auto-switches before starting codex when preflight sees token_expired', async () => {
  const upserts = [];
  const nextLookups = [];
  let activeRow = {
    status: 'up',
    configured: true,
    apiKeyMode: false,
    displayName: 'oauth@example.com'
  };
  const { runtime, proc, writes, spawns } = createRuntimeHarness({}, {
    getNextAvailableId: (provider, currentId, options) => {
      nextLookups.push({ provider, currentId, options });
      return '10016';
    },
    ensureUsageSnapshotAsync: async () => null,
    getLastUsageProbeState: () => ({
      error: 'Provided authentication token is expired. {"code":"token_expired","status":401}',
      checkedAt: Date.now()
    }),
    getAccountStateIndex: () => ({
      getAccountState: (_provider, accountId) => {
        if (String(accountId) === '10015') return activeRow;
        if (String(accountId) === '10016') {
          return {
            status: 'up',
            configured: true,
            apiKeyMode: false,
            displayName: 'standby@example.com'
          };
        }
        return null;
      },
      upsertRuntimeState(provider, accountId, runtimeState, baseState) {
        upserts.push({ provider, accountId, runtimeState, baseState });
        activeRow = { ...activeRow, runtimeState };
        return true;
      }
    })
  });

  runtime.runCliPtyTracked('codex', '10015', [], false);
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].provider, 'codex');
  assert.equal(upserts[0].accountId, '10015');
  assert.equal(upserts[0].runtimeState.lastFailureKind, 'auth_invalid');
  assert.equal(upserts[0].runtimeState.lastFailureReason, 'token_expired');
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].args[0], 'resume');
  assert.equal(spawns[0].args[spawns[0].args.length - 1], '--last');
  assert.ok(writes.some((line) => line.includes('Auto-switch: 10015 -> 10016')));
  assert.equal(nextLookups.some((call) => call.options && call.options.refreshSnapshot === false), true);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime ignores cli output that only looks like auth expired text', async () => {
  const upserts = [];
  const nextLookups = [];
  const { runtime, proc, writes, spawns } = createRuntimeHarness({
    AIH_CODEX_AUTH_PREFLIGHT: '0'
  }, {
    getNextAvailableId: (provider, currentId, options) => {
      nextLookups.push({ provider, currentId, options });
      return '10016';
    },
    getAccountStateIndex: () => ({
      getAccountState: () => ({
        status: 'up',
        configured: true,
        apiKeyMode: false,
        displayName: 'oauth@example.com'
      }),
      upsertRuntimeState(provider, accountId, runtimeState, baseState) {
        upserts.push({ provider, accountId, runtimeState, baseState });
        return true;
      }
    })
  });

  runtime.runCliPtyTracked('codex', '10015', [], false);
  assert.equal(spawns.length, 1);

  spawns[0].proc._onData('Error: Provided authentication token is expired. {"code":"token_expired","status":401}\r\n');
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.notEqual(spawns[0].proc.killed, true);
  assert.equal(spawns.length, 1);
  assert.equal(upserts.length, 0);
  assert.equal(writes.some((line) => line.includes('Auto-switch: 10015 -> 10016')), false);
  assert.equal(nextLookups.length, 0);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime preserves explicit resume target when output contains auth expired text', async () => {
  const { runtime, proc, spawns } = createRuntimeHarness({
    AIH_CODEX_AUTH_PREFLIGHT: '0'
  }, {
    getNextAvailableId: () => '10016',
    getAccountStateIndex: () => ({
      getAccountState: () => ({
        status: 'up',
        configured: true,
        apiKeyMode: false,
        displayName: 'oauth@example.com'
      }),
      upsertRuntimeState: () => true
    })
  });

  runtime.runCliPtyTracked('codex', '10015', ['resume', 'thread-id'], false);
  spawns[0].proc._onData('Error: Provided authentication token is expired. {"code":"token_expired","status":401}\r\n');
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(spawns.length, 1);
  assert.notEqual(spawns[0].proc.killed, true);
  assert.deepEqual(spawns[0].args, ['resume', 'thread-id']);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime shows usage for gemini interactive PTY as well', async () => {
  const now = Date.now();
  let cache = {
    capturedAt: now - (6 * 60 * 1000),
    models: [{ remainingPct: 42.8 }]
  };
  let refreshCalls = 0;
  const { runtime, proc, writes } = createRuntimeHarness({}, {
    readUsageCache: () => cache,
    ensureUsageSnapshotAsync: async () => {
      refreshCalls += 1;
      cache = {
        capturedAt: now,
        models: [{ remainingPct: 39.1 }]
      };
      return cache;
    },
    getUsageRemainingPercentValues: (snapshot) => {
      if (!snapshot || !Array.isArray(snapshot.models)) return [];
      return snapshot.models.map((x) => Number(x.remainingPct)).filter((n) => Number.isFinite(n));
    }
  });

  runtime.runCliPtyTracked('gemini', '2', [], false);
  assert.ok(writes.some((line) => line.includes('account 2 usage remaining refreshing:')));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshCalls >= 1, true);
  assert.ok(writes.some((line) => line.includes('account 2 usage remaining: 39.1%')));

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime resumes usage refresh after idle when user input returns', async () => {
  const realNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    let cache = {
      capturedAt: now - (6 * 60 * 1000),
      entries: [{ remainingPct: 70 }]
    };
    let refreshCalls = 0;
    const { runtime, proc } = createRuntimeHarness({}, {
      readUsageCache: () => cache,
      ensureUsageSnapshotAsync: async () => {
        refreshCalls += 1;
        cache = {
          capturedAt: now,
          entries: [{ remainingPct: 66 }]
        };
        return cache;
      },
      getUsageRemainingPercentValues: (snapshot) => {
        if (!snapshot || !Array.isArray(snapshot.entries)) return [];
        return snapshot.entries.map((x) => Number(x.remainingPct)).filter((n) => Number.isFinite(n));
      }
    });

    runtime.runCliPtyTracked('codex', '10086', [], false);
    await new Promise((resolve) => setImmediate(resolve));
    const beforeResume = refreshCalls;
    assert.equal(beforeResume >= 1, true);

    now += 360_001;
    proc.stdin.emit('data', Buffer.from('x'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(refreshCalls > beforeResume, true);

    assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  } finally {
    Date.now = realNow;
  }
});

test('runtime animates sleeping status while usage refresh is paused by idle', async () => {
  const realNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    const { runtime, proc, writes } = createRuntimeHarness({}, {
      readUsageCache: () => ({
        capturedAt: now,
        entries: [{ remainingPct: 70 }]
      }),
      getUsageRemainingPercentValues: (snapshot) => {
        if (!snapshot || !Array.isArray(snapshot.entries)) return [];
        return snapshot.entries.map((x) => Number(x.remainingPct)).filter((n) => Number.isFinite(n));
      }
    });

    runtime.runCliPtyTracked('codex', '10086', [], false);
    now += 360_001;
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const idleLines = writes.filter((line) => line.includes('sleeping...'));
    const uniqueIdleLines = new Set(idleLines);
    assert.equal(idleLines.length >= 2, true);
    assert.equal(uniqueIdleLines.size >= 2, true);

    assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  } finally {
    Date.now = realNow;
  }
});

test('runtime keeps working comfort message stable within the same rotation window', async () => {
  const realNow = Date.now;
  let now = 1_700_000_123_000;
  Date.now = () => now;
  try {
    const comfortJson = JSON.stringify({
      dawn: ['文案A', '文案B'],
      morning: ['文案A', '文案B'],
      noon: ['文案A', '文案B'],
      afternoon: ['文案A', '文案B'],
      evening: ['文案A', '文案B'],
      night: ['文案A', '文案B']
    });
    const { runtime, proc, writes } = createRuntimeHarness({}, {
      fs: {
        readFileSync: (target, encoding) => {
          const normalized = String(target || '');
          if (normalized.endsWith('working-comfort-messages.json')) {
            return comfortJson;
          }
          return fsBase.readFileSync(target, encoding);
        }
      },
      readUsageCache: () => ({
        capturedAt: now,
        entries: [{ remainingPct: 88 }]
      }),
      getUsageRemainingPercentValues: (snapshot) => {
        if (!snapshot || !Array.isArray(snapshot.entries)) return [];
        return snapshot.entries.map((x) => Number(x.remainingPct)).filter((n) => Number.isFinite(n));
      }
    });

    runtime.runCliPtyTracked('codex', '10086', [], false);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const firstMessage = writes.some((line) => line.includes('文案A')) ? '文案A' : '文案B';
    const secondMessage = firstMessage === '文案A' ? '文案B' : '文案A';
    const checkpoint = writes.length;

    now += 30_000;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const nextWrites = writes.slice(checkpoint);

    assert.equal(nextWrites.some((line) => line.includes(firstMessage)), true);
    assert.equal(nextWrites.some((line) => line.includes(secondMessage)), false);

    assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  } finally {
    Date.now = realNow;
  }
});

test('runtime hot-reloads working comfort messages from json without restarting PTY', async () => {
  let comfortJson = JSON.stringify({
    dawn: ['旧文案'],
    morning: ['旧文案'],
    noon: ['旧文案'],
    afternoon: ['旧文案'],
    evening: ['旧文案'],
    night: ['旧文案']
  });
  const now = Date.now();
  const { runtime, proc, writes } = createRuntimeHarness({}, {
    fs: {
      readFileSync: (target, encoding) => {
        const normalized = String(target || '');
        if (normalized.endsWith('working-comfort-messages.json')) {
          return comfortJson;
        }
        return fsBase.readFileSync(target, encoding);
      }
    },
    readUsageCache: () => ({
      capturedAt: now,
      entries: [{ remainingPct: 88 }]
    }),
    getUsageRemainingPercentValues: (snapshot) => {
      if (!snapshot || !Array.isArray(snapshot.entries)) return [];
      return snapshot.entries.map((x) => Number(x.remainingPct)).filter((n) => Number.isFinite(n));
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.ok(writes.some((line) => line.includes('旧文案')));

  comfortJson = JSON.stringify({
    dawn: ['新文案'],
    morning: ['新文案'],
    noon: ['新文案'],
    afternoon: ['新文案'],
    evening: ['新文案'],
    night: ['新文案']
  });

  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.ok(writes.some((line) => line.includes('新文案')));

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime shows only working status when json file is missing', async () => {
  const now = Date.now();
  const { runtime, proc, writes } = createRuntimeHarness({}, {
    fs: {
      existsSync: (target) => {
        const normalized = String(target || '');
        if (normalized.endsWith('.aih_env.json')) return false;
        if (normalized.endsWith('working-comfort-messages.json')) return false;
        return fsBase.existsSync(normalized);
      }
    },
    readUsageCache: () => ({
      capturedAt: now,
      entries: [{ remainingPct: 88 }]
    }),
    getUsageRemainingPercentValues: (snapshot) => {
      if (!snapshot || !Array.isArray(snapshot.entries)) return [];
      return snapshot.entries.map((x) => Number(x.remainingPct)).filter((n) => Number.isFinite(n));
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.ok(writes.some((line) => line.includes('working...')));
  assert.equal(writes.some((line) => line.includes('先把当前问题落地。') || line.includes('先休息，明天再战。') || line.includes('先慢慢开机。')), false);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime keeps working prefix width stable while comfort message stays the same', async () => {
  const realNow = Date.now;
  let now = 1_700_000_456_000;
  Date.now = () => now;
  try {
    const comfortJson = JSON.stringify({
      dawn: ['稳定文案'],
      morning: ['稳定文案'],
      noon: ['稳定文案'],
      afternoon: ['稳定文案'],
      evening: ['稳定文案'],
      night: ['稳定文案']
    });
    const { runtime, proc, writes } = createRuntimeHarness({}, {
      fs: {
        readFileSync: (target, encoding) => {
          const normalized = String(target || '');
          if (normalized.endsWith('working-comfort-messages.json')) {
            return comfortJson;
          }
          return fsBase.readFileSync(target, encoding);
        }
      },
      readUsageCache: () => ({
        capturedAt: now,
        entries: [{ remainingPct: 88 }]
      }),
      getUsageRemainingPercentValues: (snapshot) => {
        if (!snapshot || !Array.isArray(snapshot.entries)) return [];
        return snapshot.entries.map((x) => Number(x.remainingPct)).filter((n) => Number.isFinite(n));
      }
    });

    runtime.runCliPtyTracked('codex', '10086', [], false);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const workingLines = writes.filter((line) => line.includes('working... 稳定文案'));

    assert.equal(workingLines.length >= 2, true);
    assert.equal(workingLines.some((line) => line.includes('working. 稳定文案') || line.includes('working.. 稳定文案')), false);

    assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  } finally {
    Date.now = realNow;
  }
});

test('runtime prefers powershell.exe first for windows alt+v image paste', () => {
  const execCalls = [];
  const { runtime, proc, ptyWrites } = createRuntimeHarness({}, {
    platform: 'win32',
    execSync: (cmd) => {
      execCalls.push(String(cmd || ''));
      if (String(cmd || '').startsWith('powershell.exe ')) {
        return 'C:\\Temp\\aih-image-paste\\aih_clip_20260308_120000_001.png\r\n';
      }
      throw new Error('unexpected fallback');
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  proc.stdin.emit('data', Buffer.from('\x1bv'));

  assert.equal(execCalls.length >= 1, true);
  assert.equal(execCalls[0].startsWith('powershell.exe '), true);
  assert.equal(String(ptyWrites[0]), 'C:\\Temp\\aih-image-paste\\aih_clip_20260308_120000_001.png');

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime keeps raw ctrl+v behavior on windows even when clipboard contains image', () => {
  const { runtime, proc, ptyWrites } = createRuntimeHarness({}, {
    platform: 'win32',
    execSync: () => 'C:\\Temp\\aih-image-paste\\aih_clip_20260305_120000_001.png\r\n'
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  const ctrlV = Buffer.from([0x16]);
  proc.stdin.emit('data', ctrlV);

  assert.equal(ptyWrites.length > 0, true);
  assert.equal(Buffer.isBuffer(ptyWrites[0]), true);
  assert.equal(ptyWrites[0][0], 0x16);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime intercepts windows alt+v for clipboard image and writes file path into PTY', () => {
  let capturedCommand = '';
  const { runtime, proc, ptyWrites, rawModeCalls } = createRuntimeHarness({}, {
    platform: 'win32',
    execSync: (cmd) => {
      capturedCommand = String(cmd || '');
      return 'C:\\Temp\\aih-image-paste\\aih_clip_20260305_120000_001.png\r\n';
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  proc.stdin.emit('data', Buffer.from('\x1bv'));

  assert.equal(ptyWrites.length > 0, true);
  assert.equal(String(ptyWrites[0]), 'C:\\Temp\\aih-image-paste\\aih_clip_20260305_120000_001.png');
  const match = capturedCommand.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/);
  assert.ok(match && match[1]);
  const script = Buffer.from(String(match[1] || ''), 'base64').toString('utf16le');
  assert.equal(script.includes('AddDays(-1)'), true);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime keeps raw alt+v behavior when clipboard is not image on windows', () => {
  const { runtime, proc, ptyWrites } = createRuntimeHarness({}, {
    platform: 'win32',
    execSync: () => { throw new Error('no image in clipboard'); }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  proc.stdin.emit('data', Buffer.from('\x1bv'));

  assert.equal(ptyWrites.length > 0, true);
  assert.equal(Buffer.isBuffer(ptyWrites[0]), true);
  assert.equal(String(ptyWrites[0]), '\x1bv');

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime keeps raw shift+insert behavior on windows', () => {
  const { runtime, proc, ptyWrites } = createRuntimeHarness({}, {
    platform: 'win32',
    execSync: () => 'C:\\Temp\\aih-image-paste\\aih_clip_20260305_120001_001.png\r\n'
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  proc.stdin.emit('data', Buffer.from('\x1b[2~'));

  assert.equal(ptyWrites.length > 0, true);
  assert.equal(String(ptyWrites[0]), '\x1b[2~');

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime keeps raw ctrl+v CSI-u sequence behavior on windows', () => {
  const { runtime, proc, ptyWrites } = createRuntimeHarness({}, {
    platform: 'win32',
    execSync: () => 'C:\\Temp\\aih-image-paste\\aih_clip_20260305_120003_001.png\r\n'
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  proc.stdin.emit('data', Buffer.from('\x1b[118;5u'));

  assert.equal(ptyWrites.length > 0, true);
  assert.equal(String(ptyWrites[0]), '\x1b[118;5u');

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime keeps raw ctrl+v CSI-u extended sequence behavior on windows', () => {
  const { runtime, proc, ptyWrites } = createRuntimeHarness({}, {
    platform: 'win32',
    execSync: () => 'C:\\Temp\\aih-image-paste\\aih_clip_20260305_120005_001.png\r\n'
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  proc.stdin.emit('data', Buffer.from('\x1b[118;5:1u'));

  assert.equal(ptyWrites.length > 0, true);
  assert.equal(String(ptyWrites[0]), '\x1b[118;5:1u');

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime intercepts windows alt+v CSI-u sequence for clipboard image', () => {
  const { runtime, proc, ptyWrites } = createRuntimeHarness({}, {
    platform: 'win32',
    execSync: () => 'C:\\Temp\\aih-image-paste\\aih_clip_20260305_120007_001.png\r\n'
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  proc.stdin.emit('data', Buffer.from('\x1b[118;3u'));

  assert.equal(ptyWrites.length > 0, true);
  assert.equal(String(ptyWrites[0]), 'C:\\Temp\\aih-image-paste\\aih_clip_20260305_120007_001.png');

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime keeps empty bracketed paste envelope as raw input', () => {
  const { runtime, proc, ptyWrites } = createRuntimeHarness({}, {
    platform: 'win32',
    execSync: () => 'C:\\Temp\\aih-image-paste\\aih_clip_20260305_120004_001.png\r\n'
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  proc.stdin.emit('data', Buffer.from('\x1b[200~\x1b[201~'));

  assert.equal(ptyWrites.length > 0, true);
  assert.equal(String(ptyWrites[0]), '\x1b[200~\x1b[201~');

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime keeps raw ctrl+v behavior in WSL', () => {
  const execCalls = [];
  const { runtime, proc, ptyWrites } = createRuntimeHarness({
    WSL_DISTRO_NAME: 'Ubuntu'
  }, {
    platform: 'linux',
    execSync: (cmd) => {
      execCalls.push(String(cmd));
      return 'C:\\Users\\madou\\AppData\\Local\\Temp\\aih-image-paste\\aih_clip_20260305_120000_001.png\r\n';
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  proc.stdin.emit('data', Buffer.from([0x16]));

  assert.equal(ptyWrites.length > 0, true);
  assert.equal(Buffer.isBuffer(ptyWrites[0]), true);
  assert.equal(ptyWrites[0][0], 0x16);
  assert.equal(execCalls.length, 0);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime intercepts alt+v in WSL and normalizes windows clipboard path', () => {
  const execCalls = [];
  const { runtime, proc, ptyWrites } = createRuntimeHarness({
    WSL_DISTRO_NAME: 'Ubuntu'
  }, {
    platform: 'linux',
    execSync: (cmd) => {
      execCalls.push(String(cmd));
      if (String(cmd).startsWith('powershell.exe ') || String(cmd).startsWith('powershell ')) {
        return 'C:\\Users\\madou\\AppData\\Local\\Temp\\aih-image-paste\\aih_clip_20260305_120000_001.png\r\n';
      }
      if (String(cmd).startsWith('wslpath -u ')) {
        return '/mnt/c/Users/madou/AppData/Local/Temp/aih-image-paste/aih_clip_20260305_120000_001.png\n';
      }
      throw new Error(`unexpected command: ${cmd}`);
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  proc.stdin.emit('data', Buffer.from('\x1bv'));

  assert.equal(ptyWrites.length > 0, true);
  assert.equal(String(ptyWrites[0]), '/mnt/c/Users/madou/AppData/Local/Temp/aih-image-paste/aih_clip_20260305_120000_001.png');
  assert.equal(execCalls.some((cmd) => cmd.startsWith('wslpath -u ')), true);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime keeps raw shift+insert behavior in WSL', () => {
  const { runtime, proc, ptyWrites } = createRuntimeHarness({
    WSL_DISTRO_NAME: 'Ubuntu'
  }, {
    platform: 'linux',
    execSync: (cmd) => {
      if (String(cmd).startsWith('powershell.exe ') || String(cmd).startsWith('powershell ')) {
        return 'C:\\Users\\madou\\AppData\\Local\\Temp\\aih-image-paste\\aih_clip_20260305_120002_001.png\r\n';
      }
      if (String(cmd).startsWith('wslpath -u ')) {
        return '/mnt/c/Users/madou/AppData/Local/Temp/aih-image-paste/aih_clip_20260305_120002_001.png\n';
      }
      throw new Error(`unexpected command: ${cmd}`);
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  proc.stdin.emit('data', Buffer.from('\x1b[2;2~'));

  assert.equal(ptyWrites.length > 0, true);
  assert.equal(String(ptyWrites[0]), '\x1b[2;2~');

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime keeps non-empty bracketed paste payload as raw input', () => {
  const { runtime, proc, ptyWrites } = createRuntimeHarness({
    WSL_DISTRO_NAME: 'Ubuntu'
  }, {
    platform: 'linux',
    execSync: () => { throw new Error('should not call clipboard for non-empty paste payload'); }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  const payload = Buffer.from('\x1b[200~hello\x1b[201~');
  proc.stdin.emit('data', payload);

  assert.equal(ptyWrites.length > 0, true);
  assert.equal(String(ptyWrites[0]), '\x1b[200~hello\x1b[201~');

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime keeps raw ctrl+v behavior on non-WSL linux', () => {
  const { runtime, proc, ptyWrites } = createRuntimeHarness({}, {
    platform: 'linux',
    execSync: () => { throw new Error('should not call clipboard on non-wsl linux'); }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  const ctrlV = Buffer.from([0x16]);
  proc.stdin.emit('data', ctrlV);

  assert.equal(ptyWrites.length > 0, true);
  assert.equal(Buffer.isBuffer(ptyWrites[0]), true);
  assert.equal(ptyWrites[0][0], 0x16);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});
