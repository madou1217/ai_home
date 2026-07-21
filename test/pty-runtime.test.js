const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fsBase = require('node:fs');
const fse = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { createPtyRuntime } = require('../lib/cli/services/pty/runtime');
const { createSessionStoreService } = require('../lib/cli/services/session-store');
const { AIH_SERVER_PROFILE_ID } = require('../lib/account/self-relay-account');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { writeDefaultAccountRef } = require('../lib/account/default-account-store');
const { writeAccountCredentials } = require('../lib/server/account-credential-store');
const { listCliAccountRefRecords } = require('../lib/server/account-ref-store');
const persistentSession = require('../lib/runtime/persistent-session');
const persistentSessionRegistry = require('../lib/runtime/persistent-session-registry');
const {
  parsePersistentProviderSupervisorArgs
} = require('../lib/cli/services/pty/persistent-provider-supervisor');
const ptyLaunch = require('../lib/runtime/pty-launch');
const {
  resolveAccountRuntimeDir,
  resolveLoginRuntimeDir
} = require('../lib/runtime/aih-storage-layout');
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
const { encodeClipboardImageFrames } = require('../lib/cli/services/ssh-clipboard/frames');
const {
  OSC52_PREFIX,
  OSC5522_PREFIX,
  PASTE_EVENTS_5522_DISABLE,
  PASTE_EVENTS_5522_ENABLE,
  PASTE_EVENTS_5522_SUPPORT_QUERY,
  STRING_TERMINATOR
} = require('../lib/cli/services/ssh-clipboard/terminal-clipboard');
const { buildShimRequestFrame } = require('../lib/cli/services/ssh-clipboard/shim-protocol');

function pngBuffer(seed = 'x') {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(seed)
  ]);
}

function tiffBuffer(seed = 'x') {
  return Buffer.concat([
    Buffer.from([0x49, 0x49, 0x2a, 0x00]),
    Buffer.from(seed)
  ]);
}

function assertTomlPathValue(content, key, expectedPath) {
  const escapedKey = String(key || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(content || '').match(new RegExp(`^${escapedKey} = "([^"]+)"$`, 'm'));
  assert.ok(match, `missing TOML path key: ${key}`);
  const actual = path.normalize(match[1].replace(/\\\\/g, '\\'));
  const expected = path.normalize(expectedPath);
  assert.equal(actual, expected);
}

function assertStrictFreshSessionLaunch(spawn, baseSession) {
  assert.equal(spawn.args.includes('new-session'), true);
  assert.equal(spawn.args.includes('attach-session'), false);
  assert.equal(spawn.args.includes('-A'), false);
  assert.equal(spawn.args.includes('-D'), false);
  assert.equal(spawn.args.includes('-d'), false);
  const sessionIndex = spawn.args.indexOf('-s');
  assert.notEqual(sessionIndex, -1);
  const sessionName = spawn.args[sessionIndex + 1];
  assert.notEqual(sessionName, baseSession);
  assert.equal(sessionName.startsWith(`${baseSession}-`), true);
  return sessionName;
}

function createMockProcess(env = {}, platform = 'linux', cwd = os.tmpdir(), options = {}) {
  const proc = new EventEmitter();
  const rawModeCalls = [];
  const writes = [];

  const stdout = new EventEmitter();
  stdout.columns = 80;
  stdout.rows = 24;
  if (options.stdoutIsTTY) stdout.isTTY = true;
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
  const { proc, rawModeCalls, writes } = createMockProcess(env, overrides.platform || 'linux', mockCwd, {
    stdoutIsTTY: overrides.stdoutIsTTY
  });
  proc.pid = Number(overrides.pid || 10001);
  const lockRootBase = fsBase.mkdtempSync(path.join(os.tmpdir(), 'aih-pty-lock-'));
  const lockRoot = path.join(lockRootBase, 'workspace', 'ai_home');
  fsBase.mkdirSync(lockRoot, { recursive: true });
  const profileRoot = overrides.aiHomeDir || lockRoot;
  const hostHomeDir = overrides.hostHomeDir || path.dirname(profileRoot);
  const getProfileDir = overrides.getProfileDir
    || ((cliName, accountRef) => resolveAccountRuntimeDir(profileRoot, cliName, accountRef));
  const getAccountRuntimeDir = overrides.getAccountRuntimeDir || getProfileDir;
  const getGatewayRuntimeDir = overrides.getGatewayRuntimeDir || (() => hostHomeDir);
  const getLoginRuntimeDir = overrides.getLoginRuntimeDir
    || ((cliName, loginSessionId) => resolveLoginRuntimeDir(profileRoot, cliName, loginSessionId));
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
    mkdtempSync: fsBase.mkdtempSync.bind(fsBase),
    mkdirSync: fsBase.mkdirSync.bind(fsBase),
    openSync: fsBase.openSync.bind(fsBase),
    readSync: fsBase.readSync.bind(fsBase),
    writeFileSync: fsBase.writeFileSync.bind(fsBase),
    appendFileSync: fsBase.appendFileSync.bind(fsBase),
    closeSync: fsBase.closeSync.bind(fsBase),
    unlinkSync: fsBase.unlinkSync.bind(fsBase),
    rmSync: fsBase.rmSync.bind(fsBase)
  };
  Object.assign(fsImpl, overrides.fs || {});

  const getAccountStateIndex = overrides.getAccountStateIndex || (() => ({
    getAccountState: () => null,
    upsertRuntimeState: () => true
  }));
  const accountStateService = overrides.accountStateService || {
    recordRuntimeFailure(accountRef, provider, runtimeState, baseState) {
      const index = getAccountStateIndex();
      if (!index || typeof index.upsertRuntimeState !== 'function') return false;
      return index.upsertRuntimeState(accountRef, provider, runtimeState, baseState);
    },
    clearRuntimeBlock(accountRef, provider, options = {}) {
      const index = getAccountStateIndex();
      if (!index || typeof index.upsertRuntimeState !== 'function') return false;
      const { evidence: _evidence, ...baseState } = options;
      return index.upsertRuntimeState(accountRef, provider, null, baseState);
    }
  };

  const runtimeImpl = createPtyRuntime({
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
    buildPtyLaunch: overrides.buildPtyLaunch || ((command, args) => ({ command, args })),
    resolveWindowsBatchLaunch: overrides.resolveWindowsBatchLaunch || ((_cliName, cliBin) => ({ launchBin: cliBin, envPatch: {} })),
    resolveWindowsNodeShimLaunch: overrides.resolveWindowsNodeShimLaunch,
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
    getAccountRuntimeDir,
    getGatewayRuntimeDir,
    getLoginRuntimeDir,
    getProfileDir,
    askYesNo: overrides.askYesNo || (() => false),
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
    DatabaseSync: overrides.DatabaseSync,
    fetchSshClipAgentImage: overrides.fetchSshClipAgentImage
  });
  const resolvedAccountRefs = new Map();
  const resolveHarnessAccountRef = (provider, cliAccountId) => {
    const key = `${provider}:${cliAccountId}`;
    if (resolvedAccountRefs.has(key)) return resolvedAccountRefs.get(key);
    const accountRef = registerAccountIdentity(fsBase, profileRoot, {
      provider,
      cliAccountId,
      identitySeed: `test:${provider}:pty:${cliAccountId}`
    }).accountRef;
    writeAccountCredentials(fsBase, profileRoot, accountRef, { AIH_TEST_CONFIGURED: '1' });
    resolvedAccountRefs.set(key, accountRef);
    return accountRef;
  };
  const runtime = {
    ...runtimeImpl,
    runCliPtyTracked(cliName, accountSelector, forwardArgs, isLogin, spawnOptions = {}) {
      const selector = String(accountSelector || '').trim();
      if (!/^\d+$/.test(selector)) {
        return runtimeImpl.runCliPtyTracked(cliName, selector, forwardArgs, isLogin, spawnOptions);
      }
      return runtimeImpl.runCliPtyTracked(
        cliName,
        resolveHarnessAccountRef(cliName, selector),
        forwardArgs,
        isLogin,
        { ...spawnOptions, cliAccountId: spawnOptions.cliAccountId || selector }
      );
    }
  };

  return {
    runtime,
    proc,
    writes,
    ptyWrites,
    spawns,
    backgroundSpawns,
    rawModeCalls,
    getSchedulerCalls: () => schedulerCalls,
    resolveHarnessAccountRef,
    lockRoot,
    aiHomeDir: profileRoot,
    hostHomeDir,
    cwd: mockCwd
  };
}

function fakeCodexNodeShimLaunch(_cliBin, args) {
  return {
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\tools\\node_modules\\@openai\\codex\\bin\\codex.js', ...(Array.isArray(args) ? args : [])],
    envPatch: {
      NODE_PATH: 'C:\\tools\\node_modules'
    }
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

test('runtime uses headless direct spawn for claude print prompts', () => {
  const directSpawns = [];
  const { runtime, spawns, writes } = createRuntimeHarness({
    AIH_PROVIDER_SESSION_CORRELATION_ID: 'stale-parent-run'
  }, {
    resolveCliPath: () => '/usr/local/bin/claude',
    spawn: (command, args, options) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      directSpawns.push({ command, args, options, child });
      return child;
    }
  });

  runtime.runCliPtyTracked('claude', '4', ['-p', '只输出 ok'], false);

  assert.equal(spawns.length, 0);
  assert.equal(directSpawns.length, 1);
  assert.equal(directSpawns[0].command, '/usr/local/bin/claude');
  assert.deepEqual(directSpawns[0].args, ['-p', '只输出 ok']);
  assert.match(
    directSpawns[0].options.env.AIH_PROVIDER_SESSION_CORRELATION_ID,
    /^[0-9a-f-]{36}$/
  );
  assert.notEqual(
    directSpawns[0].options.env.AIH_PROVIDER_SESSION_CORRELATION_ID,
    'stale-parent-run'
  );

  directSpawns[0].child.stdout.emit('data', Buffer.from('ok\n'));
  assert.match(writes.join(''), /ok/);
});

test('headless direct 仅在 stream-json 输入时接通 stdin', () => {
  const directSpawns = [];
  const makeSpawn = () => (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.writable = true;
    child.stdin.write = () => true;
    child.stdin.end = () => {};
    child.kill = () => {};
    directSpawns.push({ command, args, options, child });
    return child;
  };

  // stream-json 输入 → stdin 接通（'pipe'）
  {
    directSpawns.length = 0;
    const { runtime } = createRuntimeHarness({}, {
      resolveCliPath: () => '/usr/local/bin/claude',
      spawn: makeSpawn()
    });
    runtime.runCliPtyTracked('claude', '4',
      ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json'], false);
    assert.equal(directSpawns.length, 1);
    assert.equal(directSpawns[0].options.stdio[0], 'pipe');
  }

  // 普通文本 -p → stdin 仍忽略（'ignore'），行为不变
  {
    directSpawns.length = 0;
    const { runtime } = createRuntimeHarness({}, {
      resolveCliPath: () => '/usr/local/bin/claude',
      spawn: makeSpawn()
    });
    runtime.runCliPtyTracked('claude', '4', ['-p', 'hello'], false);
    assert.equal(directSpawns.length, 1);
    assert.equal(directSpawns[0].options.stdio[0], 'ignore');
  }
});

test('runtime preserves caller TERM for provider PTY clients', () => {
  const { runtime, proc, spawns, rawModeCalls, aiHomeDir, resolveHarnessAccountRef } = createRuntimeHarness({
    TERM: 'xterm-256color'
  });

  runtime.runCliPtyTracked('codex', '10086', ['--version'], false);

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].options.name, 'xterm-256color');
  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime falls back to xterm-256color when caller TERM is unsafe', () => {
  const { runtime, proc, spawns, rawModeCalls } = createRuntimeHarness({
    TERM: 'bad term\nvalue'
  });

  runtime.runCliPtyTracked('codex', '10086', ['--version'], false);

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].options.name, 'xterm-256color');
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
  assert.equal(spawns[0].options.rows, 24);

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
  const harness = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0'
  }, {
    aiHomeDir,
    ensureSessionStoreLinks: (cliName, accountRef) => {
      calls.push({
        cliName,
        accountRef,
        accountCodexDirExists: fsBase.existsSync(path.join(resolveAccountRuntimeDir(aiHomeDir, 'codex', accountRef), '.codex'))
      });
      return { migrated: 0, linked: 0 };
    }
  });
  const { runtime, proc, rawModeCalls, resolveHarnessAccountRef } = harness;
  const accountRef = resolveHarnessAccountRef('codex', '10086');

  runtime.runCliPtyTracked('codex', '10086', ['--version'], false);

  assert.equal(calls.length >= 2, true);
  assert.deepEqual(calls[0], {
    cliName: 'codex',
    accountRef,
    accountCodexDirExists: false
  });
  assert.equal(calls.some((call) => call.accountCodexDirExists), true);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime blocks a projected provider launch when resources remain unreconciled', () => {
  const { runtime, spawns } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0'
  }, {
    ensureSessionStoreLinks: () => ({ unresolved: ['sessions'] })
  });

  assert.throws(
    () => runtime.runCliPtyTracked('codex', '10086', ['--version'], false),
    (error) => error && error.code === 'provider_resource_reconcile_incomplete'
  );
  assert.equal(spawns.length, 0);
});

test('runtime keeps codex account auth isolated while sharing host sqlite state', () => {
  const { runtime, proc, spawns, aiHomeDir, hostHomeDir, rawModeCalls, resolveHarnessAccountRef } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0'
  });
  const accountRef = resolveHarnessAccountRef('codex', '10086');
  const accountConfigDir = path.join(resolveAccountRuntimeDir(aiHomeDir, 'codex', accountRef), '.codex');
  const hostCodexHome = path.join(hostHomeDir, '.codex');

  try {
    runtime.runCliPtyTracked('codex', '10086', ['--version'], false);

    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].options.env.CODEX_HOME, accountConfigDir);
    assert.equal(spawns[0].options.env.CODEX_SQLITE_HOME, hostCodexHome);
    const synced = fsBase.readFileSync(path.join(accountConfigDir, 'config.toml'), 'utf8');
    assertTomlPathValue(synced, 'sqlite_home', hostCodexHome);
  } finally {
    assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  }
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime ignores stale opencode auth projection because DB is the only auth truth', () => {
  const aiHomeDir = fsBase.mkdtempSync(path.join(os.tmpdir(), 'aih-pty-opencode-'));
  const hostHomeDir = fsBase.mkdtempSync(path.join(os.tmpdir(), 'aih-pty-opencode-host-'));
  try {
    const harness = createRuntimeHarness({
      AIH_RUNTIME_SHOW_USAGE: '0',
      HOME: hostHomeDir
    }, {
      aiHomeDir,
      hostHomeDir,
      resolveCliPath: () => '/usr/local/bin/opencode',
      fs: {
        lstatSync: fsBase.lstatSync.bind(fsBase),
        readlinkSync: fsBase.readlinkSync.bind(fsBase),
        symlinkSync: fsBase.symlinkSync.bind(fsBase)
      }
    });
    const accountRef = harness.resolveHarnessAccountRef('opencode', '1');
    const profileDir = resolveAccountRuntimeDir(aiHomeDir, 'opencode', accountRef);
    const bridgeDataDir = path.join(profileDir, '.local', 'share', 'aih-opencode-runtime', 'opencode');
    fsBase.mkdirSync(bridgeDataDir, { recursive: true });
    fsBase.writeFileSync(path.join(bridgeDataDir, 'auth.json'), '{"split":true}\n', 'utf8');

    harness.runtime.runCliPtyTracked('opencode', '1', ['--version'], false);
    assert.equal(harness.spawns.length, 1);
  } finally {
    fsBase.rmSync(aiHomeDir, { recursive: true, force: true });
    fsBase.rmSync(hostHomeDir, { recursive: true, force: true });
  }
});

test('runtime asks before installing psmux on Windows and degrades when declined', () => {
  const calls = [];
  const { runtime, proc, spawns, rawModeCalls } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    Path: ''
  }, {
    platform: 'win32',
    stdoutIsTTY: true,
    buildPtyLaunch: ptyLaunch.buildPtyLaunch,
    resolveWindowsNodeShimLaunch: fakeCodexNodeShimLaunch,
    resolveCliPath: (name) => (name === 'codex' ? 'C:\\tools\\codex.cmd' : ''),
    askYesNo: (query, defaultYes) => {
      calls.push({ query, defaultYes });
      return false;
    },
    spawnSync: (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: '' };
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].defaultYes, false);
  assert.match(calls[0].query, /psmux/);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, 'cmd.exe');
  assert.equal(spawns[0].args.includes('chcp 65001>nul & C:\\tools\\codex.cmd'), true);
  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime wraps native Windows psmux for Codex by default', () => {
  const psmuxPath = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\psmux.exe';
  const syncCalls = [];
  const { runtime, proc, spawns, rawModeCalls, resolveHarnessAccountRef } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    Path: ''
  }, {
    platform: 'win32',
    stdoutIsTTY: true,
    buildPtyLaunch: ptyLaunch.buildPtyLaunch,
    resolveWindowsNodeShimLaunch: fakeCodexNodeShimLaunch,
    resolveCliPath: (name) => {
      if (name === 'psmux') return psmuxPath;
      if (name === 'codex') return 'C:\\tools\\codex.cmd';
      return '';
    },
    fs: {
      existsSync: (target) => {
        if (target === psmuxPath) return true;
        return fsBase.existsSync(String(target || ''));
      }
    },
    spawnSync: (command, args, options) => {
      syncCalls.push({ command, args, options });
      return { status: 0, stdout: '' };
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  const accountRef = resolveHarnessAccountRef('codex', '10086');

  assert.equal(syncCalls.some((call) => call.command === psmuxPath && call.args.includes('list-sessions')), true);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, psmuxPath);
  assert.deepEqual(spawns[0].args.slice(0, 4), ['-u', '-L', `aih-codex-${accountRef}`, '-f']);
  assert.equal(spawns[0].args.includes('new-session'), true);
  assert.equal(spawns[0].args.includes('-A'), false);
  assert.equal(spawns[0].args.includes('-D'), false);
  assert.equal(spawns[0].args.includes('C:\\tools\\codex.cmd'), false);
  assert.equal(spawns[0].args.includes('C:\\Program Files\\nodejs\\node.exe'), true);
  assert.equal(spawns[0].args.includes('C:\\tools\\node_modules\\@openai\\codex\\bin\\codex.js'), true);
  assert.equal(spawns[0].args.includes('NODE_PATH=C:\\tools\\node_modules'), true);
  assert.equal(
    spawns[0].args.includes(`${persistentSession.PSMUX_CODEX_LAUNCH_RUNTIME_MARKER_KEY}=${persistentSession.PSMUX_CODEX_LAUNCH_RUNTIME_MARKER_VALUE}`),
    true
  );
  assert.equal(spawns[0].options.env.AIH_PERSIST_ACTIVE, '1');
  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime installs psmux on Windows, re-detects it, and wraps the launch', () => {
  let installed = false;
  const calls = [];
  const psmuxPath = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\psmux.exe';
  const { runtime, proc, spawns, rawModeCalls, resolveHarnessAccountRef } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    Path: ''
  }, {
    platform: 'win32',
    stdoutIsTTY: true,
    buildPtyLaunch: ptyLaunch.buildPtyLaunch,
    resolveWindowsNodeShimLaunch: fakeCodexNodeShimLaunch,
    resolveCliPath: (name) => (name === 'codex' ? 'C:\\tools\\codex.cmd' : ''),
    askYesNo: () => true,
    fs: {
      existsSync: (target) => {
        if (target === psmuxPath) return installed;
        return fsBase.existsSync(String(target || ''));
      }
    },
    spawnSync: (command, args, options) => {
      calls.push({ command, args, options });
      if (command === 'winget') {
        installed = true;
        return { status: 0 };
      }
      if (command === psmuxPath && args.includes('list-sessions')) {
        return { status: 0, stdout: '' };
      }
      return { status: 1, stdout: '' };
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  const accountRef = resolveHarnessAccountRef('codex', '10086');

  assert.equal(calls[0].command, 'winget');
  assert.deepEqual(calls[0].args.slice(0, 4), ['install', '--id', 'marlocarlo.psmux', '--exact']);
  assert.equal(calls.some((call) => call.command === psmuxPath && call.args.includes('list-sessions')), true);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, psmuxPath);
  assert.deepEqual(spawns[0].args.slice(0, 4), ['-u', '-L', `aih-codex-${accountRef}`, '-f']);
  assert.equal(spawns[0].args.includes('new-session'), true);
  assert.equal(spawns[0].args.includes('-A'), false);
  assert.equal(spawns[0].args.includes('-D'), false);
  assert.equal(spawns[0].args.includes('C:\\tools\\codex.cmd'), false);
  assert.equal(spawns[0].args.includes('C:\\Program Files\\nodejs\\node.exe'), true);
  assert.equal(spawns[0].args.includes('C:\\tools\\node_modules\\@openai\\codex\\bin\\codex.js'), true);
  assert.equal(spawns[0].args.includes('NODE_PATH=C:\\tools\\node_modules'), true);
  assert.equal(
    spawns[0].args.includes(`${persistentSession.PSMUX_CODEX_LAUNCH_RUNTIME_MARKER_KEY}=${persistentSession.PSMUX_CODEX_LAUNCH_RUNTIME_MARKER_VALUE}`),
    true
  );
  assert.equal(spawns[0].options.env.AIH_PERSIST_ACTIVE, '1');
  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime avoids psmux attach-or-create when session probing falls back to a unique session', () => {
  const fallbackProjectCwd = 'C:\\work\\ai_home';
  const fallbackPsmuxPath = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\psmux.exe';
  const fallbackSyncCalls = [];
  const { runtime, proc, spawns, rawModeCalls } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    Path: ''
  }, {
    cwd: fallbackProjectCwd,
    platform: 'win32',
    stdoutIsTTY: true,
    buildPtyLaunch: ptyLaunch.buildPtyLaunch,
    resolveWindowsNodeShimLaunch: fakeCodexNodeShimLaunch,
    resolveCliPath: (name) => {
      if (name === 'psmux') return fallbackPsmuxPath;
      if (name === 'codex') return 'C:\\tools\\codex.cmd';
      return '';
    },
    fs: {
      existsSync: (target) => {
        if (target === fallbackPsmuxPath) return true;
        return fsBase.existsSync(String(target || ''));
      }
    },
    spawnSync: (command, args, options) => {
      fallbackSyncCalls.push({ command, args, options });
      if (command === fallbackPsmuxPath && args.includes('list-sessions')) {
        return { status: 1, stdout: '', stderr: 'unexpected psmux probe failure' };
      }
      return { status: 0, stdout: '' };
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);

  assert.equal(fallbackSyncCalls.some((call) => call.command === fallbackPsmuxPath && call.args.includes('list-sessions')), true);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, fallbackPsmuxPath);
  assert.equal(spawns[0].args.includes('new-session'), true);
  assert.equal(spawns[0].args.includes('-A'), false);
  assert.equal(spawns[0].args.includes('-D'), false);
  assert.equal(spawns[0].args.includes('C:\\tools\\codex.cmd'), false);
  assert.equal(spawns[0].args.includes('C:\\Program Files\\nodejs\\node.exe'), true);
  assert.equal(spawns[0].args.includes('C:\\tools\\node_modules\\@openai\\codex\\bin\\codex.js'), true);
  assert.equal(spawns[0].args.includes('NODE_PATH=C:\\tools\\node_modules'), true);
  assert.equal(
    spawns[0].args.includes(`${persistentSession.PSMUX_CODEX_LAUNCH_RUNTIME_MARKER_KEY}=${persistentSession.PSMUX_CODEX_LAUNCH_RUNTIME_MARKER_VALUE}`),
    true
  );

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime re-enters Windows psmux Codex sessions with an exclusive explicit attach', () => {
  const explicitAttachProjectCwd = 'C:\\work\\ai_home';
  const explicitAttachBaseSession = persistentSession.deriveSessionName({ cwd: explicitAttachProjectCwd });
  const explicitAttachSeparator = persistentSession.SESSION_LIST_SEPARATOR;
  const explicitAttachPsmuxPath = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\psmux.exe';
  const explicitAttachSyncCalls = [];
  const { runtime, proc, spawns, writes, ptyWrites, rawModeCalls } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0',
    AIH_SESSION_TARGET: explicitAttachBaseSession,
    AIH_SESSION_MIRROR: '1',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    Path: ''
  }, {
    cwd: explicitAttachProjectCwd,
    platform: 'win32',
    stdoutIsTTY: true,
    buildPtyLaunch: ptyLaunch.buildPtyLaunch,
    resolveWindowsNodeShimLaunch: fakeCodexNodeShimLaunch,
    resolveCliPath: (name) => {
      if (name === 'psmux') return explicitAttachPsmuxPath;
      if (name === 'codex') return 'C:\\tools\\codex.cmd';
      return '';
    },
    fs: {
      existsSync: (target) => {
        if (target === explicitAttachPsmuxPath) return true;
        return fsBase.existsSync(String(target || ''));
      }
    },
    spawnSync: (command, args, options) => {
      explicitAttachSyncCalls.push({ command, args, options });
      if (command === explicitAttachPsmuxPath && args.includes('list-sessions')) {
        return {
          status: 0,
          stdout: [
            explicitAttachBaseSession,
            '1',
            '100',
            explicitAttachProjectCwd,
            'codex task',
            'codex',
            'node',
            '123',
            persistentSession.UTF8_RUNTIME_MARKER_VALUE,
            '',
            '0',
            persistentSession.PSMUX_CODEX_LAUNCH_RUNTIME_MARKER_VALUE
          ].join(explicitAttachSeparator)
        };
      }
      return { status: 0, stdout: '' };
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);

  assert.equal(explicitAttachSyncCalls.some((call) => call.command === explicitAttachPsmuxPath && call.args.includes('list-sessions')), true);
  const detachCall = explicitAttachSyncCalls.find((call) => call.command === explicitAttachPsmuxPath && call.args.includes('detach-client'));
  assert.ok(detachCall);
  assert.deepEqual(detachCall.args.slice(-3), ['detach-client', '-s', explicitAttachBaseSession]);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, explicitAttachPsmuxPath);
  assert.equal(spawns[0].args.includes('new-session'), false);
  assert.equal(spawns[0].args.includes('-A'), false);
  assert.deepEqual(spawns[0].args.slice(-3), ['attach-session', '-t', explicitAttachBaseSession]);
  assert.equal(spawns[0].args.includes('C:\\tools\\codex.cmd'), false);

  spawns[0].proc._onData('live repaint from psmux\r\n');
  assert.equal(writes.some((line) => line.includes('live repaint from psmux')), true);
  proc.stdin.emit('data', Buffer.from('hello'));
  assert.equal(String(ptyWrites[ptyWrites.length - 1]), 'hello');
  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime rejects legacy Windows psmux Codex targets without direct launch marker', () => {
  const legacyProjectCwd = 'C:\\work\\ai_home';
  const legacyBaseSession = persistentSession.deriveSessionName({ cwd: legacyProjectCwd });
  const legacySeparator = persistentSession.SESSION_LIST_SEPARATOR;
  const legacyPsmuxPath = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\psmux.exe';
  const legacySyncCalls = [];
  const { runtime, spawns } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0',
    AIH_SESSION_TARGET: legacyBaseSession,
    AIH_SESSION_MIRROR: '1',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    Path: ''
  }, {
    cwd: legacyProjectCwd,
    platform: 'win32',
    stdoutIsTTY: true,
    buildPtyLaunch: ptyLaunch.buildPtyLaunch,
    resolveWindowsNodeShimLaunch: fakeCodexNodeShimLaunch,
    resolveCliPath: (name) => {
      if (name === 'psmux') return legacyPsmuxPath;
      if (name === 'codex') return 'C:\\tools\\codex.cmd';
      return '';
    },
    fs: {
      existsSync: (target) => {
        if (target === legacyPsmuxPath) return true;
        return fsBase.existsSync(String(target || ''));
      }
    },
    spawnSync: (command, args, options) => {
      legacySyncCalls.push({ command, args, options });
      if (command === legacyPsmuxPath && args.includes('list-sessions')) {
        return {
          status: 0,
          stdout: [
            legacyBaseSession,
            '1',
            '100',
            legacyProjectCwd,
            'codex task',
            'codex',
            'node',
            '123',
            persistentSession.UTF8_RUNTIME_MARKER_VALUE,
            '',
            '0',
            ''
          ].join(legacySeparator)
        };
      }
      return { status: 0, stdout: '' };
    }
  });

  assert.throws(
    () => runtime.runCliPtyTracked('codex', '10086', [], false),
    (error) => error && error.code === 'persistent_session_target_unavailable'
  );

  assert.equal(legacySyncCalls.some((call) => call.command === legacyPsmuxPath && call.args.includes('detach-client')), false);
  assert.equal(legacySyncCalls.some((call) => call.args.includes('kill-server')), false);
  assert.equal(spawns.length, 0);
});

test('runtime bare launch creates a fresh Windows psmux session without reusing a completed pane', () => {
  const completedProjectCwd = 'C:\\work\\ai_home';
  const completedBaseSession = persistentSession.deriveSessionName({ cwd: completedProjectCwd });
  const completedSeparator = persistentSession.SESSION_LIST_SEPARATOR;
  const completedPsmuxPath = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\psmux.exe';
  const completedSyncCalls = [];
  const { runtime, proc, spawns, rawModeCalls } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    Path: ''
  }, {
    cwd: completedProjectCwd,
    platform: 'win32',
    stdoutIsTTY: true,
    buildPtyLaunch: ptyLaunch.buildPtyLaunch,
    resolveWindowsNodeShimLaunch: fakeCodexNodeShimLaunch,
    resolveCliPath: (name) => {
      if (name === 'psmux') return completedPsmuxPath;
      if (name === 'codex') return 'C:\\tools\\codex.cmd';
      return '';
    },
    fs: {
      existsSync: (target) => {
        if (target === completedPsmuxPath) return true;
        return fsBase.existsSync(String(target || ''));
      }
    },
    spawnSync: (command, args, options) => {
      completedSyncCalls.push({ command, args, options });
      if (command === completedPsmuxPath && args.includes('list-sessions')) {
        return {
          status: 0,
          stdout: [
            completedBaseSession,
            '0',
            '100',
            completedProjectCwd,
            'session completed',
            'codex',
            'node',
            '123',
            persistentSession.UTF8_RUNTIME_MARKER_VALUE,
            '',
            '1',
            persistentSession.PSMUX_CODEX_LAUNCH_RUNTIME_MARKER_VALUE
          ].join(completedSeparator)
        };
      }
      return { status: 0, stdout: '' };
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);

  assert.equal(completedSyncCalls.some((call) => call.command === completedPsmuxPath && call.args.includes('list-sessions')), true);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, completedPsmuxPath);
  assertStrictFreshSessionLaunch(spawns[0], completedBaseSession);
  assert.equal(spawns[0].args.includes('C:\\tools\\codex.cmd'), false);
  assert.equal(spawns[0].args.includes('C:\\Program Files\\nodejs\\node.exe'), true);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime bare launch creates a fresh Windows psmux session without reusing a completed live pane', () => {
  const screenCompletedProjectCwd = 'C:\\work\\ai_home';
  const screenCompletedBaseSession = persistentSession.deriveSessionName({ cwd: screenCompletedProjectCwd });
  const screenCompletedSeparator = persistentSession.SESSION_LIST_SEPARATOR;
  const screenCompletedPsmuxPath = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\psmux.exe';
  const screenCompletedSyncCalls = [];
  const { runtime, proc, spawns, rawModeCalls } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    Path: ''
  }, {
    cwd: screenCompletedProjectCwd,
    platform: 'win32',
    stdoutIsTTY: true,
    buildPtyLaunch: ptyLaunch.buildPtyLaunch,
    resolveWindowsNodeShimLaunch: fakeCodexNodeShimLaunch,
    resolveCliPath: (name) => {
      if (name === 'psmux') return screenCompletedPsmuxPath;
      if (name === 'codex') return 'C:\\tools\\codex.cmd';
      return '';
    },
    fs: {
      existsSync: (target) => {
        if (target === screenCompletedPsmuxPath) return true;
        return fsBase.existsSync(String(target || ''));
      }
    },
    spawnSync: (command, args, options) => {
      screenCompletedSyncCalls.push({ command, args, options });
      if (command === screenCompletedPsmuxPath && args.includes('list-sessions')) {
        return {
          status: 0,
          stdout: [
            screenCompletedBaseSession,
            '1',
            '100',
            screenCompletedProjectCwd,
            'codex',
            'codex',
            'node',
            '123',
            persistentSession.UTF8_RUNTIME_MARKER_VALUE,
            '',
            '0',
            persistentSession.PSMUX_CODEX_LAUNCH_RUNTIME_MARKER_VALUE
          ].join(screenCompletedSeparator)
        };
      }
      if (command === screenCompletedPsmuxPath && args.includes('capture-pane')) {
        return { status: 0, stdout: 'last turn\nSession completed\n' };
      }
      return { status: 0, stdout: '' };
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);

  assert.equal(screenCompletedSyncCalls.some((call) => call.command === screenCompletedPsmuxPath && call.args.includes('capture-pane')), true);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, screenCompletedPsmuxPath);
  assertStrictFreshSessionLaunch(spawns[0], screenCompletedBaseSession);
  assert.equal(spawns[0].args.includes('C:\\tools\\codex.cmd'), false);
  assert.equal(spawns[0].args.includes('C:\\Program Files\\nodejs\\node.exe'), true);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime bare launch creates a fresh strict tmux session when a project session is attached', () => {
  const cwd = '/tmp/aih-parallel-project';
  const baseSession = persistentSession.deriveSessionName({ cwd });
  const spawnSyncCalls = [];
  const { runtime, proc, spawns, rawModeCalls } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0'
  }, {
    cwd,
    stdoutIsTTY: true,
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : '/usr/bin/codex'),
    spawnSync: (command, args, options) => {
      spawnSyncCalls.push({ command, args, options });
      if (args.includes('list-sessions')) {
        return { status: 0, stdout: `${baseSession}\t1\t100\t${cwd}\n` };
      }
      return { status: 0, stdout: '' };
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, '/usr/bin/tmux');
  const sessionName = assertStrictFreshSessionLaunch(spawns[0], baseSession);
  const correlationId = spawns[0].options.env.AIH_PROVIDER_SESSION_CORRELATION_ID;
  assert.match(correlationId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(spawnSyncCalls.map((call) => call.args[3]), [
    'set-environment',
    'set-environment',
    'set-environment',
    'set-environment',
    'source-file',
    'list-sessions',
    'set-environment',
    'set-environment',
    'set-environment',
    'set-environment'
  ]);
  assert.equal(spawnSyncCalls.every((call) => call.options.env.LANG === 'C.UTF-8'), true);
  assert.equal(spawnSyncCalls.every((call) => call.options.env.LC_CTYPE === 'C.UTF-8'), true);
  assert.equal(spawnSyncCalls.every((call) => call.options.env.LC_ALL === 'C.UTF-8'), true);
  assert.deepEqual(
    spawnSyncCalls
      .filter((call) => call.args[3] === 'set-environment')
      .map((call) => call.args.slice(4)),
    [
      ['-g', 'LANG', 'C.UTF-8'],
      ['-g', 'LC_CTYPE', 'C.UTF-8'],
      ['-g', 'LC_ALL', 'C.UTF-8'],
      ['-g', 'AIH_PROVIDER_SESSION_CORRELATION_ID', correlationId],
      ['-t', sessionName, 'LANG', 'C.UTF-8'],
      ['-t', sessionName, 'LC_CTYPE', 'C.UTF-8'],
      ['-t', sessionName, 'LC_ALL', 'C.UTF-8'],
      ['-t', sessionName, 'AIH_PROVIDER_SESSION_CORRELATION_ID', correlationId]
    ]
  );
  assert.deepEqual(
    spawns[0].args.filter((arg, index, args) => args[index - 1] === '-e'),
    [
      'LANG=C.UTF-8',
      'LC_CTYPE=C.UTF-8',
      'LC_ALL=C.UTF-8',
      `AIH_PROVIDER_SESSION_CORRELATION_ID=${correlationId}`,
      `${persistentSession.PROVIDER_SUPERVISOR_RUNTIME_MARKER_KEY}=${persistentSession.PROVIDER_SUPERVISOR_RUNTIME_MARKER_VALUE}`,
      `${persistentSession.UTF8_RUNTIME_MARKER_KEY}=${persistentSession.UTF8_RUNTIME_MARKER_VALUE}`
    ]
  );
  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime applies Claude tmux render compatibility only when persistent tmux wraps Claude', () => {
  const cwd = '/tmp/aih-claude-render-project';
  const baseSession = persistentSession.deriveSessionName({ cwd });
  const spawnSyncCalls = [];
  const { runtime, proc, spawns, resolveHarnessAccountRef } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0'
  }, {
    cwd,
    stdoutIsTTY: true,
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : '/usr/local/bin/claude'),
    spawnSync: (command, args, options) => {
      spawnSyncCalls.push({ command, args, options });
      if (args.includes('list-sessions')) {
        return { status: 0, stdout: '' };
      }
      return { status: 0, stdout: '' };
    }
  });

  runtime.runCliPtyTracked('claude', '4', [], false);
  const accountRef = resolveHarnessAccountRef('claude', '4');
  const socket = `aih-claude-${accountRef}`;

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, '/usr/bin/tmux');
  const sessionName = assertStrictFreshSessionLaunch(spawns[0], baseSession);
  const correlationId = spawns[0].options.env.AIH_PROVIDER_SESSION_CORRELATION_ID;
  assert.match(correlationId, /^[0-9a-f-]{36}$/);
  assert.equal(spawns[0].options.env.CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT, '1');
  assert.equal(spawns[0].options.env.CLAUDE_CODE_FORCE_SYNC_OUTPUT, '1');
  assert.equal(spawns[0].options.env.CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL, '1');
  assert.equal(
    spawns[0].options.env[persistentSession.CLAUDE_RENDER_RUNTIME_MARKER_KEY],
    persistentSession.CLAUDE_RENDER_RUNTIME_MARKER_VALUE
  );
  assert.equal(
    spawns[0].args.includes('CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT=1'),
    true
  );
  assert.equal(
    spawns[0].args.includes('CLAUDE_CODE_FORCE_SYNC_OUTPUT=1'),
    true
  );
  assert.equal(
    spawns[0].args.includes('CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL=1'),
    true
  );
  assert.equal(
    spawns[0].args.includes(
      `${persistentSession.CLAUDE_RENDER_RUNTIME_MARKER_KEY}=${persistentSession.CLAUDE_RENDER_RUNTIME_MARKER_VALUE}`
    ),
    true
  );
  assert.equal(
    spawnSyncCalls.some((call) => call.args.join('\x1f') === [
      '-u',
      '-L',
      socket,
      'set-environment',
      '-t',
      sessionName,
      'CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT',
      '1'
    ].join('\x1f')),
    true
  );
  assert.equal(
    spawnSyncCalls.some((call) => call.args.join('\x1f') === [
      '-u',
      '-L',
      socket,
      'set-environment',
      '-t',
      sessionName,
      'CLAUDE_CODE_FORCE_SYNC_OUTPUT',
      '1'
    ].join('\x1f')),
    true
  );
  assert.equal(
    spawnSyncCalls.some((call) => call.args.join('\x1f') === [
      '-u',
      '-L',
      socket,
      'set-environment',
      '-t',
      sessionName,
      'CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL',
      '1'
    ].join('\x1f')),
    true
  );
  assert.equal(
    spawnSyncCalls.some((call) => call.args.join('\x1f') === [
      '-u',
      '-L',
      socket,
      'set-environment',
      '-t',
      sessionName,
      persistentSession.CLAUDE_RENDER_RUNTIME_MARKER_KEY,
      persistentSession.CLAUDE_RENDER_RUNTIME_MARKER_VALUE
    ].join('\x1f')),
    true
  );
  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime leaves direct Claude launches without tmux render compatibility env', () => {
  const { runtime, proc, spawns } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0'
  }, {
    stdoutIsTTY: true,
    resolveCliPath: (name) => (name === 'claude' ? '/usr/local/bin/claude' : '')
  });

  runtime.runCliPtyTracked('claude', '4', [], false);

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, '/usr/local/bin/claude');
  assert.equal(spawns[0].options.env.CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT, undefined);
  assert.equal(spawns[0].options.env.CLAUDE_CODE_FORCE_SYNC_OUTPUT, undefined);
  assert.equal(spawns[0].options.env.CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL, undefined);
  assert.equal(spawns[0].options.env[persistentSession.CLAUDE_RENDER_RUNTIME_MARKER_KEY], undefined);
  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime uses zh_CN UTF-8 tmux env for macOS generic UTF-8 sessions', () => {
  const cwd = '/tmp/aih-macos-cjk-project';
  const baseSession = persistentSession.deriveSessionName({ cwd });
  const spawnSyncCalls = [];
  const { runtime, proc, spawns } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0',
    LANG: 'C.UTF-8'
  }, {
    cwd,
    platform: 'darwin',
    stdoutIsTTY: true,
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : '/usr/bin/codex'),
    spawnSync: (command, args, options) => {
      spawnSyncCalls.push({ command, args, options });
      if (args.includes('list-sessions')) {
        return { status: 0, stdout: `${baseSession}\t0\t100\t${cwd}\n` };
      }
      return { status: 0, stdout: '' };
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, '/usr/bin/tmux');
  const sessionName = assertStrictFreshSessionLaunch(spawns[0], baseSession);
  const correlationId = spawns[0].options.env.AIH_PROVIDER_SESSION_CORRELATION_ID;
  assert.match(correlationId, /^[0-9a-f-]{36}$/);
  assert.equal(spawnSyncCalls.every((call) => call.options.env.LANG === 'zh_CN.UTF-8'), true);
  assert.equal(spawnSyncCalls.every((call) => call.options.env.LC_CTYPE === 'zh_CN.UTF-8'), true);
  assert.equal(spawnSyncCalls.every((call) => call.options.env.LC_ALL === 'zh_CN.UTF-8'), true);
  assert.deepEqual(
    spawnSyncCalls
      .filter((call) => call.args[3] === 'set-environment')
      .map((call) => call.args.slice(4)),
    [
      ['-g', 'LANG', 'zh_CN.UTF-8'],
      ['-g', 'LC_CTYPE', 'zh_CN.UTF-8'],
      ['-g', 'LC_ALL', 'zh_CN.UTF-8'],
      ['-g', 'AIH_PROVIDER_SESSION_CORRELATION_ID', correlationId],
      ['-t', sessionName, 'LANG', 'zh_CN.UTF-8'],
      ['-t', sessionName, 'LC_CTYPE', 'zh_CN.UTF-8'],
      ['-t', sessionName, 'LC_ALL', 'zh_CN.UTF-8'],
      ['-t', sessionName, 'AIH_PROVIDER_SESSION_CORRELATION_ID', correlationId]
    ]
  );
  assert.deepEqual(
    spawns[0].args.filter((arg, index, args) => args[index - 1] === '-e'),
    [
      'LANG=zh_CN.UTF-8',
      'LC_CTYPE=zh_CN.UTF-8',
      'LC_ALL=zh_CN.UTF-8',
      `AIH_PROVIDER_SESSION_CORRELATION_ID=${correlationId}`,
      `${persistentSession.PROVIDER_SUPERVISOR_RUNTIME_MARKER_KEY}=${persistentSession.PROVIDER_SUPERVISOR_RUNTIME_MARKER_VALUE}`,
      `${persistentSession.UTF8_RUNTIME_MARKER_KEY}=${persistentSession.UTF8_RUNTIME_MARKER_VALUE}`
    ]
  );
  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime bare launch leaves detached stale tmux sessions untouched and creates fresh', () => {
  const cwd = '/tmp/aih-legacy-utf8-project';
  const baseSession = persistentSession.deriveSessionName({ cwd });
  const sep = persistentSession.SESSION_LIST_SEPARATOR;
  const syncCalls = [];
  const { runtime, proc, spawns } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0'
  }, {
    cwd,
    stdoutIsTTY: true,
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : '/usr/bin/codex'),
    spawnSync: (_command, args) => {
      syncCalls.push(args.slice());
      if (args.includes('list-sessions')) {
        return {
          status: 0,
          stdout: [
            baseSession,
            '0',
            '100',
            cwd,
            'old task',
            'codex',
            'node',
            '123',
            ''
          ].join(sep)
        };
      }
      return { status: 0, stdout: '' };
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);

  assert.ok(!syncCalls.some((args) => args.includes('kill-server')), 'bare launch must not cycle an existing server');
  assertStrictFreshSessionLaunch(spawns[0], baseSession);
  assert.equal(spawns[0].args.includes(`${persistentSession.UTF8_RUNTIME_MARKER_KEY}=${persistentSession.UTF8_RUNTIME_MARKER_VALUE}`), true);
  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime bare launch leaves an attached stale session untouched and creates fresh', () => {
  const cwd = '/tmp/aih-legacy-utf8-attached-project';
  const baseSession = persistentSession.deriveSessionName({ cwd });
  const sep = persistentSession.SESSION_LIST_SEPARATOR;
  const syncCalls = [];
  const { runtime, proc, spawns } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0'
  }, {
    cwd,
    stdoutIsTTY: true,
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : '/usr/bin/codex'),
    spawnSync: (_command, args) => {
      syncCalls.push(args.slice());
      if (args.includes('list-sessions')) {
        return {
          status: 0,
          // session is ATTACHED (field 1 = '1') — server must not be cycled
          stdout: [baseSession, '1', '100', cwd, 'live task', 'codex', 'node', '123', ''].join(sep)
        };
      }
      return { status: 0, stdout: '' };
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);

  assert.ok(!syncCalls.some((args) => args.includes('kill-server')), 'bare launch must not cycle an existing server');
  assertStrictFreshSessionLaunch(spawns[0], baseSession);
  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime bare launch keeps strict fresh tmux create when session probing fails', () => {
  const cwd = '/tmp/aih-probe-fail-project';
  const baseSession = persistentSession.deriveSessionName({ cwd });
  const { runtime, proc, spawns, rawModeCalls } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0'
  }, {
    cwd,
    pid: 22222,
    stdoutIsTTY: true,
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : '/usr/bin/codex'),
    spawnSync: (_command, args) => {
      if (args.includes('list-sessions')) {
        return { status: 2, stdout: '', stderr: 'tmux list failed unexpectedly' };
      }
      return { status: 0, stdout: '' };
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, '/usr/bin/tmux');
  assertStrictFreshSessionLaunch(spawns[0], baseSession);
  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime bare launch creates a fresh strict tmux session when no server exists yet', () => {
  const cwd = '/tmp/aih-no-server-project';
  const baseSession = persistentSession.deriveSessionName({ cwd });
  const { runtime, proc, spawns, rawModeCalls } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0'
  }, {
    cwd,
    stdoutIsTTY: true,
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : '/usr/bin/codex'),
    spawnSync: (_command, args) => {
      if (args.includes('list-sessions')) {
        return { status: 1, stdout: '', stderr: 'error connecting to /tmp/tmux-501/aih-codex-10086 (No such file or directory)' };
      }
      return { status: 0, stdout: '' };
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, '/usr/bin/tmux');
  assertStrictFreshSessionLaunch(spawns[0], baseSession);
  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime supervises the inner provider only when creating a projected persistent session', () => {
  const cwd = '/tmp/aih-supervised-provider-project';
  const baseSession = persistentSession.deriveSessionName({ cwd });
  const {
    runtime,
    proc,
    spawns,
    rawModeCalls,
    resolveHarnessAccountRef,
    aiHomeDir,
    hostHomeDir
  } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0'
  }, {
    cwd,
    stdoutIsTTY: true,
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : '/usr/bin/codex'),
    spawnSync: (_command, args) => {
      if (args.includes('list-sessions')) {
        return { status: 1, stdout: '', stderr: 'no server running' };
      }
      return { status: 0, stdout: '' };
    }
  });

  runtime.runCliPtyTracked('codex', '10086', ['--model', 'gpt-5'], false);

  assert.equal(spawns.length, 1);
  const sessionName = assertStrictFreshSessionLaunch(spawns[0], baseSession);
  const innerIndex = spawns[0].args.indexOf('--');
  const supervisorArgs = spawns[0].args.slice(innerIndex + 1);
  assert.equal(supervisorArgs[0], process.execPath);
  assert.match(supervisorArgs[1], /persistent-provider-supervisor-entry\.js$/);
  assert.equal(
    spawns[0].args.includes(
      `${persistentSession.PROVIDER_SUPERVISOR_RUNTIME_MARKER_KEY}=${persistentSession.PROVIDER_SUPERVISOR_RUNTIME_MARKER_VALUE}`
    ),
    true
  );
  const context = parsePersistentProviderSupervisorArgs(supervisorArgs.slice(2));
  const accountRef = resolveHarnessAccountRef('codex', '10086');
  assert.deepEqual(context, {
    provider: 'codex',
    accountRef,
    runtimeDir: resolveAccountRuntimeDir(aiHomeDir, 'codex', accountRef),
    aiHomeDir,
    hostHomeDir,
    socket: persistentSession.deriveSocket('codex', accountRef),
    session: sessionName,
    command: '/usr/bin/codex',
    args: ['--model', 'gpt-5']
  });
  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime creates a fresh unique projected session when the same-cwd base is detached', () => {
  const cwd = '/tmp/aih-supervisor-fresh-project';
  const baseSession = persistentSession.deriveSessionName({ cwd });
  const separator = persistentSession.SESSION_LIST_SEPARATOR;
  const { runtime, proc, spawns, rawModeCalls } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0'
  }, {
    cwd,
    stdoutIsTTY: true,
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : '/usr/bin/codex'),
    spawnSync: (_command, args) => {
      if (args.includes('list-sessions')) {
        return {
          status: 0,
          stdout: [
            baseSession,
            '0',
            '100',
            cwd,
            'codex',
            'codex',
            'node',
            '123',
            persistentSession.UTF8_RUNTIME_MARKER_VALUE,
            '',
            '0',
            '',
            cwd,
            persistentSession.PROVIDER_SUPERVISOR_RUNTIME_MARKER_VALUE
          ].join(separator)
        };
      }
      return { status: 0, stdout: '' };
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, '/usr/bin/tmux');
  assertStrictFreshSessionLaunch(spawns[0], baseSession);
  const innerIndex = spawns[0].args.indexOf('--');
  const innerArgs = spawns[0].args.slice(innerIndex + 1);
  assert.equal(innerArgs[0], process.execPath);
  assert.equal(innerArgs.some((arg) => /persistent-provider-supervisor-entry\.js$/.test(arg)), true);
  assert.equal(spawns[0].options.env.AIH_PERSIST_ACTIVE, '1');
  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime attaches an explicit detached session target exactly', () => {
  const cwd = '/tmp/aih-explicit-detached-target-project';
  const targetSession = persistentSession.deriveSessionName({ cwd });
  const separator = persistentSession.SESSION_LIST_SEPARATOR;
  const { runtime, proc, spawns, rawModeCalls } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0',
    AIH_SESSION_TARGET: targetSession
  }, {
    cwd,
    stdoutIsTTY: true,
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : '/usr/bin/codex'),
    spawnSync: (_command, args) => {
      if (args.includes('list-sessions')) {
        return {
          status: 0,
          stdout: [
            targetSession,
            '0',
            '100',
            cwd,
            'codex',
            'codex',
            'node',
            '123',
            persistentSession.UTF8_RUNTIME_MARKER_VALUE,
            '',
            '0',
            '',
            cwd,
            persistentSession.PROVIDER_SUPERVISOR_RUNTIME_MARKER_VALUE
          ].join(separator)
        };
      }
      return { status: 0, stdout: '' };
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, '/usr/bin/tmux');
  assert.equal(spawns[0].args.includes('new-session'), false);
  assert.equal(spawns[0].args.includes('-A'), false);
  assert.equal(spawns[0].args.includes('-D'), false);
  assert.equal(spawns[0].args.includes('-d'), false);
  assert.deepEqual(spawns[0].args.slice(-3), ['attach-session', '-t', targetSession]);
  assert.equal(spawns[0].options.env.AIH_PERSIST_ACTIVE, '1');
  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime still attaches an exact picker target when the session probe is unavailable', () => {
  const cwd = '/tmp/aih-explicit-target-probe-fail-project';
  const targetSession = `${persistentSession.deriveSessionName({ cwd })}-picked`;
  const { runtime, proc, spawns, rawModeCalls } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0',
    AIH_SESSION_TARGET: targetSession,
    AIH_SESSION_MIRROR: '1'
  }, {
    cwd,
    stdoutIsTTY: true,
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : '/usr/bin/codex'),
    spawnSync: (_command, args) => {
      if (args.includes('list-sessions')) {
        return { status: 2, stdout: '', stderr: 'tmux list failed unexpectedly' };
      }
      return { status: 0, stdout: '' };
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].args.includes('new-session'), false);
  assert.equal(spawns[0].args.includes('-d'), false);
  assert.deepEqual(spawns[0].args.slice(-3), ['attach-session', '-t', targetSession]);
  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime rejects a missing exact target without creating or replacing a session', () => {
  const cwd = '/tmp/aih-explicit-target-missing-project';
  const targetSession = `${persistentSession.deriveSessionName({ cwd })}-picked`;
  const siblingSession = `${persistentSession.deriveSessionName({ cwd })}-sibling`;
  const syncCalls = [];
  const { runtime, spawns } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0',
    AIH_SESSION_TARGET: targetSession,
    AIH_SESSION_MIRROR: '1'
  }, {
    cwd,
    stdoutIsTTY: true,
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : '/usr/bin/codex'),
    spawnSync: (_command, args) => {
      syncCalls.push(args.slice());
      if (args.includes('list-sessions')) {
        return { status: 0, stdout: `${siblingSession}\t0\t100\t${cwd}\n` };
      }
      return { status: 0, stdout: '' };
    }
  });

  assert.throws(
    () => runtime.runCliPtyTracked('codex', '10086', [], false),
    (error) => error && error.code === 'persistent_session_target_missing'
  );
  assert.equal(spawns.length, 0);
  assert.equal(syncCalls.some((args) => args.includes('kill-server')), false);
  assert.equal(syncCalls.some((args) => args.includes('detach-client')), false);
});

test('runtime rejects an unsafe exact target instead of falling back to fresh or latest', () => {
  const syncCalls = [];
  const { runtime, spawns } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0',
    AIH_SESSION_TARGET: 'unsafe target',
    AIH_SESSION_MIRROR: '1'
  }, {
    stdoutIsTTY: true,
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : '/usr/bin/codex'),
    spawnSync: (_command, args) => {
      syncCalls.push(args.slice());
      return { status: 0, stdout: '' };
    }
  });

  assert.throws(
    () => runtime.runCliPtyTracked('codex', '10086', [], false),
    (error) => error && error.code === 'persistent_session_target_unavailable'
  );
  assert.equal(spawns.length, 0);
  assert.equal(syncCalls.some((args) => args.includes('list-sessions')), false);
});

test('runtime rejects an incompatible exact target without cycling the account tmux server', () => {
  const cwd = '/tmp/aih-explicit-target-incompatible-project';
  const targetSession = `${persistentSession.deriveSessionName({ cwd })}-picked`;
  const separator = persistentSession.SESSION_LIST_SEPARATOR;
  const syncCalls = [];
  const { runtime, spawns } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0',
    AIH_SESSION_TARGET: targetSession,
    AIH_SESSION_MIRROR: '1'
  }, {
    cwd,
    stdoutIsTTY: true,
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : '/usr/bin/codex'),
    spawnSync: (_command, args) => {
      syncCalls.push(args.slice());
      if (args.includes('list-sessions')) {
        return {
          status: 0,
          stdout: [
            targetSession,
            '0',
            '100',
            cwd,
            'codex',
            'codex',
            'node',
            '123',
            '',
            '',
            '0',
            '',
            cwd,
            persistentSession.PROVIDER_SUPERVISOR_RUNTIME_MARKER_VALUE
          ].join(separator)
        };
      }
      return { status: 0, stdout: '' };
    }
  });

  assert.throws(
    () => runtime.runCliPtyTracked('codex', '10086', [], false),
    (error) => error && error.code === 'persistent_session_target_unavailable'
  );
  assert.equal(syncCalls.some((args) => args.includes('kill-server')), false);
  assert.equal(spawns.length, 0);
});

test('runtime bare launch leaves an incompatible projected pane untouched and creates supervised fresh', () => {
  const cwd = '/tmp/aih-supervisor-legacy-project';
  const baseSession = persistentSession.deriveSessionName({ cwd });
  const separator = persistentSession.SESSION_LIST_SEPARATOR;
  const syncCalls = [];
  const { runtime, proc, spawns, rawModeCalls } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0'
  }, {
    cwd,
    stdoutIsTTY: true,
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : '/usr/bin/codex'),
    spawnSync: (_command, args) => {
      syncCalls.push(args.slice());
      if (args.includes('list-sessions')) {
        return {
          status: 0,
          stdout: [
            baseSession,
            '0',
            '100',
            cwd,
            'codex',
            'codex',
            'node',
            '123',
            persistentSession.UTF8_RUNTIME_MARKER_VALUE,
            '',
            '0',
            '',
            cwd,
            ''
          ].join(separator)
        };
      }
      return { status: 0, stdout: '' };
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);

  assert.ok(!syncCalls.some((args) => args.includes('kill-server')), 'bare launch must not cycle an existing server');
  assertStrictFreshSessionLaunch(spawns[0], baseSession);
  assert.equal(
    spawns[0].args.some((arg) => /persistent-provider-supervisor-entry\.js$/.test(arg)),
    true
  );
  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime blocks persistent tmux launch when its registry entry cannot be written', (t) => {
  const aiHomeDir = fsBase.mkdtempSync(path.join(os.tmpdir(), 'aih-persist-registry-fail-'));
  t.after(() => fsBase.rmSync(aiHomeDir, { recursive: true, force: true }));
  const registryRoot = path.join(aiHomeDir, 'run', 'persistent-sessions');
  let registryWriteAttempts = 0;
  const { runtime, spawns } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0'
  }, {
    aiHomeDir,
    stdoutIsTTY: true,
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : '/usr/bin/codex'),
    fs: {
      writeFileSync(targetPath, ...args) {
        const resolved = path.resolve(String(targetPath || ''));
        if (resolved.startsWith(`${path.resolve(registryRoot)}${path.sep}`)) {
          registryWriteAttempts += 1;
          const error = new Error('simulated registry write failure');
          error.code = 'EIO';
          throw error;
        }
        return fsBase.writeFileSync(targetPath, ...args);
      }
    },
    spawnSync: (_command, args) => {
      if (args.includes('list-sessions')) {
        return { status: 1, stdout: '', stderr: 'no server running' };
      }
      return { status: 0, stdout: '' };
    }
  });

  assert.throws(
    () => runtime.runCliPtyTracked('codex', '10086', [], false),
    (error) => error && error.code === 'persistent_session_registry_write_failed'
  );
  assert.equal(registryWriteAttempts, 1);
  assert.equal(spawns.length, 0);
});

test('outer tmux cleanup retains a supervisor-owned registry after inner cleanup failure', (t) => {
  const hostHomeDir = fsBase.mkdtempSync(path.join(os.tmpdir(), 'aih-supervisor-registry-retain-'));
  const aiHomeDir = path.join(hostHomeDir, '.ai_home');
  t.after(() => fsBase.rmSync(hostHomeDir, { recursive: true, force: true }));
  const { runtime, spawns } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0'
  }, {
    aiHomeDir,
    hostHomeDir,
    stdoutIsTTY: true,
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : '/usr/bin/codex'),
    spawnSync: (_command, args) => {
      if (args.includes('list-sessions')) {
        return { status: 1, stdout: '', stderr: 'no server running' };
      }
      return { status: 0, stdout: '' };
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  const beforeExit = persistentSessionRegistry.listEntries(aiHomeDir);
  assert.equal(beforeExit.length, 1);
  assert.equal(beforeExit[0].supervisorManaged, true);

  assert.throws(
    () => spawns[0].proc._onExit({ exitCode: 1 }),
    /EXIT:1/
  );
  const afterExit = persistentSessionRegistry.listEntries(aiHomeDir);
  assert.equal(afterExit.length, 1);
  assert.equal(afterExit[0].session, beforeExit[0].session);
});

test('detached restore preserves the original persistent-session registry metadata', (t) => {
  const hostHomeDir = fsBase.mkdtempSync(path.join(os.tmpdir(), 'aih-restore-registry-host-'));
  const aiHomeDir = path.join(hostHomeDir, '.ai_home');
  const cwd = '/tmp/aih-restore-registry-project';
  const targetSession = `${persistentSession.deriveSessionName({ cwd })}-original`;
  t.after(() => fsBase.rmSync(hostHomeDir, { recursive: true, force: true }));
  const { runtime, proc, spawns, resolveHarnessAccountRef } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0',
    [persistentSession.DETACHED_ENV]: '1',
    [persistentSession.TARGET_ENV]: targetSession
  }, {
    aiHomeDir,
    hostHomeDir,
    cwd,
    stdoutIsTTY: false,
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : '/usr/bin/codex'),
    spawnSync: (_command, args) => {
      if (args.includes('list-sessions')) {
        return { status: 1, stdout: '', stderr: 'no server running' };
      }
      return { status: 0, stdout: '' };
    }
  });
  const accountRef = resolveHarnessAccountRef('codex', '10086');
  const socket = persistentSession.deriveSocket('codex', accountRef);
  persistentSessionRegistry.writeEntry(aiHomeDir, {
    provider: 'codex',
    runtimeScope: accountRef,
    gateway: false,
    accountRef,
    socket,
    session: targetSession,
    cwd,
    label: 'original-label',
    forwardArgs: ['--model', 'gpt-original'],
    supervisorManaged: true
  }, { now: 1000 });

  runtime.runCliPtyTracked('codex', '10086', ['resume', 'native-restore'], false);

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].args.includes('new-session'), true);
  assert.equal(spawns[0].args.includes('-A'), true);
  assert.equal(spawns[0].args.includes('-d'), true);
  const [entry] = persistentSessionRegistry.listEntries(aiHomeDir);
  assert.equal(entry.session, targetSession);
  assert.equal(entry.cwd, cwd);
  assert.equal(entry.label, 'original-label');
  assert.deepEqual(entry.forwardArgs, ['--model', 'gpt-original']);
  assert.equal(entry.supervisorManaged, true);
  assert.equal(entry.createdAt, 1000);
  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime fails closed when explicit resume cannot probe the latest project session', () => {
  const cwd = '/tmp/aih-resume-probe-fail-project';
  const { runtime, spawns } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0',
    AIH_SESSION_RESUME: '1'
  }, {
    cwd,
    stdoutIsTTY: true,
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : '/usr/bin/codex'),
    spawnSync: (_command, args) => {
      if (args.includes('list-sessions')) {
        return { status: 2, stdout: '', stderr: 'tmux list failed unexpectedly' };
      }
      return { status: 0, stdout: '' };
    }
  });

  assert.throws(
    () => runtime.runCliPtyTracked('codex', '10086', [], false),
    (error) => error && error.code === 'persistent_session_probe_failed'
  );
  assert.equal(spawns.length, 0);
});

test('runtime explicit resume selects the newest existing project session', () => {
  const cwd = '/tmp/aih-resume-newest-project';
  const baseSession = persistentSession.deriveSessionName({ cwd });
  const olderSession = `${baseSession}-older`;
  const newestSession = `${baseSession}-newest`;
  const separator = persistentSession.SESSION_LIST_SEPARATOR;
  const row = (name, created) => [
    name,
    '0',
    String(created),
    cwd,
    'codex',
    'codex',
    'node',
    '123',
    persistentSession.UTF8_RUNTIME_MARKER_VALUE,
    '',
    '0',
    '',
    cwd,
    persistentSession.PROVIDER_SUPERVISOR_RUNTIME_MARKER_VALUE
  ].join(separator);
  const { runtime, proc, spawns, rawModeCalls } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0',
    AIH_SESSION_RESUME: '1'
  }, {
    cwd,
    stdoutIsTTY: true,
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : '/usr/bin/codex'),
    spawnSync: (_command, args) => {
      if (args.includes('list-sessions')) {
        return {
          status: 0,
          stdout: `${row(olderSession, 100)}\n${row(newestSession, 200)}\n`
        };
      }
      return { status: 0, stdout: '' };
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].args.includes('new-session'), false);
  assert.deepEqual(spawns[0].args.slice(-4), ['attach-session', '-d', '-t', newestSession]);
  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime explicit resume breaks same-second tmux creation ties with the fresh-name timestamp', () => {
  const cwd = '/tmp/aih-resume-same-second-project';
  const olderSession = persistentSession.deriveFreshSessionName({ cwd, now: 1000, pid: 1 });
  const newerSession = persistentSession.deriveFreshSessionName({ cwd, now: 1001, pid: 1 });
  const separator = persistentSession.SESSION_LIST_SEPARATOR;
  const row = (name) => [
    name,
    '0',
    '100',
    cwd,
    'codex',
    'codex',
    'node',
    '123',
    persistentSession.UTF8_RUNTIME_MARKER_VALUE,
    '',
    '0',
    '',
    cwd,
    persistentSession.PROVIDER_SUPERVISOR_RUNTIME_MARKER_VALUE
  ].join(separator);
  const { runtime, proc, spawns, rawModeCalls } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0',
    AIH_SESSION_RESUME: '1'
  }, {
    cwd,
    stdoutIsTTY: true,
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : '/usr/bin/codex'),
    spawnSync: (_command, args) => {
      if (args.includes('list-sessions')) {
        return { status: 0, stdout: `${row(olderSession)}\n${row(newerSession)}\n` };
      }
      return { status: 0, stdout: '' };
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);

  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args.slice(-4), ['attach-session', '-d', '-t', newerSession]);
  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime attaches an exact session picker target in mirror mode without detaching peers', () => {
  const { runtime, proc, spawns, rawModeCalls, resolveHarnessAccountRef } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0',
    AIH_SESSION_TARGET: 'p-picked',
    AIH_SESSION_MIRROR: '1',
    LANG: 'C',
    LC_ALL: 'C'
  }, {
    stdoutIsTTY: true,
    resolveCliPath: (name) => (name === 'tmux' ? '/usr/bin/tmux' : '/usr/bin/codex'),
    spawnSync: (_command, args) => {
      if (args.includes('list-sessions')) {
        return { status: 0, stdout: 'p-picked\t1\t100\t/tmp/picked\n' };
      }
      return { status: 0, stdout: '' };
    }
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  const accountRef = resolveHarnessAccountRef('codex', '10086');

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, '/usr/bin/tmux');
  assert.deepEqual(spawns[0].args.slice(0, 3), ['-u', '-L', `aih-codex-${accountRef}`]);
  assert.equal(spawns[0].args.includes('new-session'), false);
  assert.equal(spawns[0].args.includes('-A'), false);
  assert.equal(spawns[0].args.includes('-D'), false);
  assert.equal(spawns[0].args.includes('-d'), false);
  assert.deepEqual(spawns[0].args.slice(-3), ['attach-session', '-t', 'p-picked']);
  assert.equal(spawns[0].options.env.LANG, 'C.UTF-8');
  assert.equal(spawns[0].options.env.LC_CTYPE, 'C.UTF-8');
  assert.equal(spawns[0].options.env.LC_ALL, 'C.UTF-8');
  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime records Claude Stop hook JSON validation diagnostics from PTY output', async (t) => {
  const aiHomeDir = fsBase.mkdtempSync(path.join(os.tmpdir(), 'aih-pty-claude-hook-diag-'));
  const hostHomeDir = fsBase.mkdtempSync(path.join(os.tmpdir(), 'aih-pty-claude-host-'));
  t.after(() => {
    fsBase.rmSync(aiHomeDir, { recursive: true, force: true });
    fsBase.rmSync(hostHomeDir, { recursive: true, force: true });
  });
  const cwd = '/tmp/aih-claude-project';
  const sessionId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
  const projectDir = path.join(hostHomeDir, '.claude', 'projects', '-tmp-aih-claude-project');
  fsBase.mkdirSync(projectDir, { recursive: true });
  fsBase.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), JSON.stringify({
    type: 'attachment',
    timestamp: new Date().toISOString(),
    cwd,
    sessionId,
    attachment: {
      type: 'hook_non_blocking_error',
      hookName: 'Stop',
      hookEvent: 'Stop',
      stderr: 'JSON validation failed',
      stdout: '```json\n{"ok":true}\n```',
      exitCode: 1,
      command: 'finish the task',
      durationMs: 10,
      toolUseID: 'tool-1'
    }
  }) + '\n', 'utf8');

  const { runtime, proc, spawns, writes, rawModeCalls } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0',
    AIH_CLAUDE_HOOK_DIAGNOSTIC_DELAY_MS: '1'
  }, {
    aiHomeDir,
    hostHomeDir,
    cwd,
    resolveCliPath: () => '/usr/local/bin/claude',
    serverDaemon: { status: () => ({ running: true, ready: true, state: 'running' }) },
    readServerConfig: () => ({ host: '0.0.0.0', port: 8317, apiKey: 'server-key' })
  });

  runtime.runCliPtyTracked('claude', '', ['--resume', sessionId], false, { gateway: true });
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, '/usr/local/bin/claude');
  assert.equal(spawns[0].options.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8317');
  spawns[0].proc._onData('Ran 1 stop hook\r\nStop hook error: JSON validation failed\r\n');
  await new Promise((resolve) => setTimeout(resolve, 25));

  const logPath = path.join(aiHomeDir, 'logs', 'claude', 'hook-diagnostics.jsonl');
  assert.equal(fsBase.existsSync(logPath), true);
  const entry = JSON.parse(fsBase.readFileSync(logPath, 'utf8').trim());
  assert.equal(entry.kind, 'claude_stop_hook_json_validation');
  assert.equal(entry.accountRef, undefined);
  assert.equal(entry.gateway, true);
  assert.deepEqual(entry.relay, {
    kind: 'aih_server',
    baseUrl: 'http://127.0.0.1:8317',
    gateway: true,
    providerMode: 'auto'
  });
  assert.equal(entry.latest.sessionId, sessionId);
  assert.equal(entry.latest.stderr, 'JSON validation failed');
  assert.match(writes.join(''), /Claude Stop hook diagnostic saved/);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime records Claude tool protocol diagnostics from PTY output', async (t) => {
  const aiHomeDir = fsBase.mkdtempSync(path.join(os.tmpdir(), 'aih-pty-claude-tool-diag-'));
  const hostHomeDir = fsBase.mkdtempSync(path.join(os.tmpdir(), 'aih-pty-claude-tool-host-'));
  t.after(() => {
    fsBase.rmSync(aiHomeDir, { recursive: true, force: true });
    fsBase.rmSync(hostHomeDir, { recursive: true, force: true });
  });
  const cwd = '/tmp/aih-claude-tool-project';
  const sessionId = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa';
  const projectDir = path.join(hostHomeDir, '.claude', 'projects', '-tmp-aih-claude-tool-project');
  fsBase.mkdirSync(projectDir, { recursive: true });
  fsBase.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), [
    JSON.stringify({
      type: 'system',
      timestamp: new Date().toISOString(),
      cwd,
      sessionId,
      tools: [{
        name: 'CustomFetch',
        input_schema: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url']
        }
      }]
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date().toISOString(),
      cwd,
      sessionId,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_fetch', name: 'CustomFetch', input: {} }]
      }
    })
  ].join('\n'), 'utf8');

  const { runtime, proc, spawns, writes, rawModeCalls } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0',
    AIH_CLAUDE_HOOK_DIAGNOSTIC_DELAY_MS: '1'
  }, {
    aiHomeDir,
    hostHomeDir,
    cwd,
    resolveCliPath: () => '/usr/local/bin/claude',
    serverDaemon: { status: () => ({ running: true, ready: true, state: 'running' }) },
    readServerConfig: () => ({ host: '0.0.0.0', port: 8317, apiKey: 'server-key' })
  });

  runtime.runCliPtyTracked('claude', '', ['--resume', sessionId], false, { gateway: true });
  assert.equal(spawns.length, 1);
  spawns[0].proc._onData('[Tool use interrupted]\r\n');
  await new Promise((resolve) => setTimeout(resolve, 25));

  const logPath = path.join(aiHomeDir, 'logs', 'claude', 'hook-diagnostics.jsonl');
  assert.equal(fsBase.existsSync(logPath), true);
  const entry = JSON.parse(fsBase.readFileSync(logPath, 'utf8').trim());
  assert.equal(entry.kind, 'claude_tool_protocol');
  assert.equal(entry.accountRef, undefined);
  assert.equal(entry.gateway, true);
  assert.equal(entry.latest.toolName, 'CustomFetch');
  assert.deepEqual(entry.latest.missingRequired, ['url']);
  assert.equal(entry.latest.requiredSource, 'tool_schema');
  assert.match(writes.join(''), /Claude tool protocol diagnostic saved/);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime coalesces Claude tool diagnostics without transcript evidence and keeps PTY output quiet', async (t) => {
  const aiHomeDir = fsBase.mkdtempSync(path.join(os.tmpdir(), 'aih-pty-claude-tool-diag-quiet-'));
  const hostHomeDir = fsBase.mkdtempSync(path.join(os.tmpdir(), 'aih-pty-claude-tool-host-quiet-'));
  t.after(() => {
    fsBase.rmSync(aiHomeDir, { recursive: true, force: true });
    fsBase.rmSync(hostHomeDir, { recursive: true, force: true });
  });

  const { runtime, proc, spawns, writes, rawModeCalls } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0',
    AIH_CLAUDE_HOOK_DIAGNOSTIC_DELAY_MS: '1',
    AIH_CLAUDE_DIAGNOSTIC_NO_EVIDENCE_COOLDOWN_MS: '60000'
  }, {
    aiHomeDir,
    hostHomeDir,
    cwd: '/tmp/aih-claude-tool-no-evidence-project',
    resolveCliPath: () => '/usr/local/bin/claude',
    serverDaemon: { status: () => ({ running: true, ready: true, state: 'running' }) },
    readServerConfig: () => ({ host: '0.0.0.0', port: 8317, apiKey: 'server-key' })
  });

  runtime.runCliPtyTracked('claude', '', ['--resume', 'old-session-id'], false, { gateway: true });
  assert.equal(spawns.length, 1);
  spawns[0].proc._onData('old resume text [Tool use interrupted]\r\n');
  spawns[0].proc._onData('more old replay [Tool use interrupted]\r\n');
  await new Promise((resolve) => setTimeout(resolve, 25));
  spawns[0].proc._onData('later replay [Tool use interrupted]\r\n');
  await new Promise((resolve) => setTimeout(resolve, 25));

  const logPath = path.join(aiHomeDir, 'logs', 'claude', 'hook-diagnostics.jsonl');
  assert.equal(fsBase.existsSync(logPath), true);
  const entries = fsBase.readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'claude_tool_protocol');
  assert.equal(entries[0].foundTranscriptEvidence, false);
  assert.doesNotMatch(writes.join(''), /Claude tool protocol diagnostic saved/);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime rebuilds codex account config from host template and account auth overrides', () => {
  const { runtime, proc, aiHomeDir, hostHomeDir, rawModeCalls, resolveHarnessAccountRef } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0'
  });
  const accountRef = resolveHarnessAccountRef('codex', '10014');
  const hostConfigDir = path.join(hostHomeDir, '.codex');
  const accountConfigDir = path.join(resolveAccountRuntimeDir(aiHomeDir, 'codex', accountRef), '.codex');
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
  assertTomlPathValue(synced, 'sqlite_home', hostConfigDir);
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
  const events = [];
  const hooks = createAccountArtifactHookService({
    fs: fsBase,
    path,
    getProfileDir: (provider, accountRef) => resolveAccountRuntimeDir(aiHomeDir, provider, accountRef),
    providerHookRegistry: createDefaultProviderArtifactHookRegistry({
      providerOptions: {
        codex: {
          onAccountConfigUpdated: (event) => events.push(event)
        }
      }
    })
  });
  const { runtime, proc, rawModeCalls, resolveHarnessAccountRef } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0'
  }, {
    aiHomeDir,
    hostHomeDir,
    getProfileDir: (provider, accountRef) => resolveAccountRuntimeDir(aiHomeDir, provider, accountRef),
    accountArtifactHooks: hooks
  });
  const accountRef = resolveHarnessAccountRef('codex', '10014');
  const hostConfigDir = path.join(hostHomeDir, '.codex');
  const accountConfigDir = path.join(resolveAccountRuntimeDir(aiHomeDir, 'codex', accountRef), '.codex');
  fsBase.mkdirSync(hostConfigDir, { recursive: true });
  fsBase.mkdirSync(accountConfigDir, { recursive: true });
  fsBase.writeFileSync(path.join(hostConfigDir, 'config.toml'), 'model = "host-model"\n', 'utf8');
  fsBase.writeFileSync(path.join(accountConfigDir, 'config.toml'), 'model = "account-model"\n', 'utf8');

  runtime.runCliPtyTracked('codex', '10014', ['--version'], false);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'account_config_updated');
  assert.equal(events[0].provider, 'codex');
  assert.equal(events[0].accountRef, accountRef);
  assert.equal(events[0].source, 'pty_config_sync');
  assert.deepEqual(events[0].changedPaths, [path.join(accountConfigDir, 'config.toml')]);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime ignores sibling codex account config while rebuilding from host template', () => {
  const { runtime, proc, aiHomeDir, hostHomeDir, rawModeCalls, resolveHarnessAccountRef } = createRuntimeHarness({
    AIH_RUNTIME_SHOW_USAGE: '0'
  });
  const trustedAccountRef = resolveHarnessAccountRef('codex', '10086');
  const targetAccountRef = resolveHarnessAccountRef('codex', '10014');
  const hostConfigDir = path.join(hostHomeDir, '.codex');
  const trustedAccountConfigDir = path.join(resolveAccountRuntimeDir(aiHomeDir, 'codex', trustedAccountRef), '.codex');
  const targetAccountConfigDir = path.join(resolveAccountRuntimeDir(aiHomeDir, 'codex', targetAccountRef), '.codex');
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
  const { runtime, proc, spawns, rawModeCalls, aiHomeDir, resolveHarnessAccountRef } = createRuntimeHarness({
    AIH_CODEX_ENABLE_REMOTE_PROXY: '1'
  }, {
    serverDaemon: { status: () => ({ running: true, ready: true, state: 'running' }) },
    readServerConfig: () => ({ host: '0.0.0.0', port: 9527, apiKey: 'secret-key' })
  });
  writeDefaultAccountRef(fsBase, aiHomeDir, 'codex', resolveHarnessAccountRef('codex', '10086'));
  runtime.runCliPtyTracked('codex', '10086', ['--version'], false);
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, [
    '--remote-auth-token-env',
    'AIH_CODEX_REMOTE_AUTH_TOKEN',
    '--remote',
    'ws://127.0.0.1:9527',
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
  const hostConfigDir = path.join(path.dirname(lockRoot), '.codex');
  fsBase.mkdirSync(hostConfigDir, { recursive: true });
  const hostConfig = [
    'preferred_auth_method = "apikey"',
    'model_provider = "aih_1"',
    '',
    '[model_providers.aih_1]',
    'name = "aih codex"',
    'base_url = "https://upstream.example.com/v1"',
    'bearer_token = "host-token"',
    'wire_api = "responses"',
    ''
  ].join('\n');
  fsBase.writeFileSync(path.join(hostConfigDir, 'config.toml'), hostConfig, 'utf8');

  runtime.runCliPtyTracked('codex', '', ['--version'], false, { gateway: true });

  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, [
    '-c', 'suppress_unstable_features_warning=true',
    '-c', 'model_provider=aih_server',
    '-c', 'model_providers.aih_server.base_url=http://127.0.0.1:8317/v1',
    '-c', 'model_providers.aih_server.wire_api=responses',
    '-c', 'model_providers.aih_server.env_key=OPENAI_API_KEY',
    '--version'
  ]);
  assert.doesNotMatch(spawns[0].args.join(' '), /secret-key/);
  assert.equal(spawns[0].options.env.OPENAI_API_KEY, 'secret-key');
  assert.equal(spawns[0].options.env.OPENAI_BASE_URL, 'http://127.0.0.1:8317/v1');
  assert.equal(spawns[0].options.env.CODEX_HOME, hostConfigDir);
  const gatewayRuntimeDir = path.join(lockRoot, 'run', 'internal', 'codex');
  assert.equal(fsBase.existsSync(gatewayRuntimeDir), false);
  assert.equal(fsBase.readFileSync(path.join(hostConfigDir, 'config.toml'), 'utf8'), hostConfig);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime does not create an account directory for codex API-key accounts', () => {
  const harness = createRuntimeHarness({ AIH_RUNTIME_SHOW_USAGE: '0' });
  const { runtime, proc, spawns, aiHomeDir, hostHomeDir, rawModeCalls } = harness;
  const accountRef = harness.resolveHarnessAccountRef('codex', '1');
  writeAccountCredentials(fsBase, aiHomeDir, accountRef, {
    OPENAI_API_KEY: 'sk-runtime-test',
    OPENAI_BASE_URL: 'https://relay.example.com/v1'
  });

  runtime.runCliPtyTracked('codex', '1', ['--version'], false);

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].options.env.CODEX_HOME, path.join(hostHomeDir, '.codex'));
  assert.equal(
    fsBase.existsSync(resolveAccountRuntimeDir(aiHomeDir, 'codex', accountRef)),
    false
  );

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime routes Claude gateway through the shared host config without an internal profile', () => {
  const harness = createRuntimeHarness({ AIH_RUNTIME_SHOW_USAGE: '0' }, {
    resolveCliPath: () => '/usr/bin/claude',
    serverDaemon: { status: () => ({ running: true, ready: true, state: 'running' }) },
    readServerConfig: () => ({ host: '127.0.0.1', port: 9527, apiKey: 'gateway-key' })
  });
  const { runtime, proc, spawns, lockRoot, hostHomeDir, rawModeCalls } = harness;

  runtime.runCliPtyTracked('claude', '', ['--version'], false, { gateway: true });

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].options.env.ANTHROPIC_API_KEY, 'gateway-key');
  assert.equal(spawns[0].options.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9527');
  assert.equal(spawns[0].options.env.CLAUDE_CONFIG_DIR, path.join(hostHomeDir, '.claude'));
  assert.equal(fsBase.existsSync(path.join(lockRoot, 'run', 'internal', 'claude')), false);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime injects codex remote proxy for built-in AIH server resume by default', () => {
  const { runtime, proc, spawns, rawModeCalls } = createRuntimeHarness({}, {
    serverDaemon: { status: () => ({ running: true, ready: true, state: 'running' }) },
    readServerConfig: () => ({ host: '0.0.0.0', port: 9527, apiKey: 'secret-key' })
  });

  runtime.runCliPtyTracked('codex', '', ['resume', 'thread-id'], false, { gateway: true });

  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, [
    '--remote-auth-token-env',
    'AIH_CODEX_REMOTE_AUTH_TOKEN',
    '--remote',
    'ws://127.0.0.1:9527',
    'resume',
    '-c', 'suppress_unstable_features_warning=true',
    '-c', 'model_provider=aih_server',
    '-c', 'model_providers.aih_server.base_url=http://127.0.0.1:9527/v1',
    '-c', 'model_providers.aih_server.wire_api=responses',
    '-c', 'model_providers.aih_server.env_key=OPENAI_API_KEY',
    'thread-id'
  ]);
  assert.doesNotMatch(spawns[0].args.join(' '), /secret-key/);
  assert.equal(spawns[0].options.env.AIH_CODEX_REMOTE_AUTH_TOKEN, 'secret-key');

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime keeps reboot-restored Codex resume native with gateway credentials', () => {
  const { runtime, proc, spawns, rawModeCalls } = createRuntimeHarness({
    AIH_PERSIST_DETACHED: '1'
  }, {
    serverDaemon: { status: () => ({ running: true, ready: true, state: 'running' }) },
    readServerConfig: () => ({ host: '0.0.0.0', port: 9527, apiKey: '' })
  });

  runtime.runCliPtyTracked('codex', '', ['resume', 'thread-id'], false, { gateway: true });

  assert.equal(spawns.length, 1);
  const separatorIndex = spawns[0].args.indexOf('--');
  const resumeArgs = separatorIndex >= 0
    ? spawns[0].args.slice(separatorIndex + 2)
    : spawns[0].args;
  assert.deepEqual(resumeArgs, [
    'resume',
    '-c', 'suppress_unstable_features_warning=true',
    '-c', 'model_provider=aih_server',
    '-c', 'model_providers.aih_server.base_url=http://127.0.0.1:9527/v1',
    '-c', 'model_providers.aih_server.wire_api=responses',
    '-c', 'model_providers.aih_server.env_key=OPENAI_API_KEY',
    'thread-id'
  ]);
  assert.equal(resumeArgs.includes('--remote'), false);
  assert.equal(spawns[0].options.env.OPENAI_API_KEY, 'dummy');
  assert.equal(spawns[0].options.env.AIH_CODEX_DISABLE_REMOTE_RESUME, '1');
  assert.equal(spawns[0].options.env.AIH_CODEX_REMOTE_AUTH_TOKEN, undefined);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime restarts stale local aih server before injecting codex remote proxy', () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  const statusCalls = [];
  const restartCalls = [];
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
    restart(args, options) {
      restartCalls.push({ args, options });
      return Promise.resolve({ alreadyRunning: false, started: true, ready: false, state: 'starting', pid: 4321 });
    }
  };
  try {
    const { runtime, proc, spawns, rawModeCalls, aiHomeDir, resolveHarnessAccountRef } = createRuntimeHarness({
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
    writeDefaultAccountRef(fsBase, aiHomeDir, 'codex', resolveHarnessAccountRef('codex', '10086'));

    runtime.runCliPtyTracked('codex', '10086', ['resume', 'thread-id'], false);
    assert.deepEqual(restartCalls, [{
      args: [],
      options: { waitForReady: false, readyTimeoutMs: 7000, gracefulStopWaitMs: 500 }
    }]);
    assert.deepEqual(statusCalls, [null, null]);
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
  const { runtime, proc, spawns, rawModeCalls, aiHomeDir, resolveHarnessAccountRef } = createRuntimeHarness({}, {
    serverDaemon: { status: () => ({ running: true, ready: true, state: 'running' }) },
    readServerConfig: () => ({ host: '127.0.0.1', port: 9527, apiKey: 'secret-key' })
  });
  writeDefaultAccountRef(fsBase, aiHomeDir, 'codex', resolveHarnessAccountRef('codex', '10086'));

  runtime.runCliPtyTracked('codex', '10086', ['--version'], false);
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, ['--version']);
  assert.equal(spawns[0].options.env.AIH_CODEX_REMOTE_AUTH_TOKEN, undefined);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime injects codex remote proxy for explicit resume even when remote proxy is not globally enabled', () => {
  const { runtime, proc, spawns, rawModeCalls, aiHomeDir, resolveHarnessAccountRef } = createRuntimeHarness({}, {
    serverDaemon: { status: () => ({ running: true, ready: true, state: 'running' }) },
    readServerConfig: () => ({ host: '127.0.0.1', port: 9527, apiKey: 'secret-key' })
  });
  writeDefaultAccountRef(fsBase, aiHomeDir, 'codex', resolveHarnessAccountRef('codex', '10086'));

  runtime.runCliPtyTracked('codex', '10086', ['resume', 'thread-id'], false);
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, [
    '--remote-auth-token-env',
    'AIH_CODEX_REMOTE_AUTH_TOKEN',
    '--remote',
    'ws://127.0.0.1:9527',
    'resume',
    'thread-id'
  ]);
  assert.equal(spawns[0].options.env.AIH_CODEX_REMOTE_AUTH_TOKEN, 'secret-key');

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime does not override explicit codex remote argument', () => {
  const { runtime, proc, spawns, rawModeCalls, aiHomeDir, resolveHarnessAccountRef } = createRuntimeHarness({}, {
    serverDaemon: { status: () => ({ running: true, ready: true, state: 'running' }) },
    readServerConfig: () => ({ host: '127.0.0.1', port: 8317, apiKey: 'secret-key' })
  });
  writeDefaultAccountRef(fsBase, aiHomeDir, 'codex', resolveHarnessAccountRef('codex', '10086'));
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
    const { runtime, proc, spawns, rawModeCalls, aiHomeDir, resolveHarnessAccountRef } = createRuntimeHarness({
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
    writeDefaultAccountRef(fsBase, aiHomeDir, 'codex', resolveHarnessAccountRef('codex', '10086'));

    runtime.runCliPtyTracked('codex', '10086', ['resume', 'thread-id'], false);
    assert.equal(spawns.length, 1);
    assert.deepEqual(startCalls, [{
      args: [],
      options: { waitForReady: false, readyTimeoutMs: 7000 }
    }]);
    assert.deepEqual(statusCalls, [null, null]);
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
  const { runtime, proc, spawns, rawModeCalls, aiHomeDir, resolveHarnessAccountRef } = createRuntimeHarness({
    AIH_CODEX_ENABLE_REMOTE_PROXY: '1'
  }, {
    serverDaemon: { status: () => ({ running: true, ready: true, state: 'running' }) },
    readServerConfig: () => ({ host: '127.0.0.1', port: 8317, apiKey: 'secret-key' })
  });
  writeDefaultAccountRef(fsBase, aiHomeDir, 'codex', resolveHarnessAccountRef('codex', '99999'));

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

test('runtime starts an unregistered OAuth login in a session-scoped runtime', () => {
  const reconciliationCalls = [];
  const { runtime, proc, spawns, rawModeCalls, aiHomeDir } = createRuntimeHarness({}, {
    ensureSessionStoreLinks(provider, accountRef, options) {
      reconciliationCalls.push({ provider, accountRef, options });
      return { migrated: 0, linked: 0 };
    }
  });
  runtime.runCliPtyTracked('codex', '', ['--no-browser'], true, {
    cliAccountId: '10086',
    loginSessionId: 'auth-test-session'
  });

  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, ['login', '--device-auth']);
  assert.equal(
    spawns[0].options.env.CODEX_HOME,
    path.join(resolveLoginRuntimeDir(aiHomeDir, 'codex', 'auth-test-session'), '.codex')
  );
  const loginRuntimeDir = resolveLoginRuntimeDir(aiHomeDir, 'codex', 'auth-test-session');
  assert.equal(fsBase.existsSync(loginRuntimeDir), true);
  assert.equal(fsBase.statSync(path.join(loginRuntimeDir, '.codex')).isDirectory(), true);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.equal(fsBase.existsSync(loginRuntimeDir), false);
  assert.deepEqual(reconciliationCalls, [
    {
      provider: 'codex',
      accountRef: 'login-auth-test-session',
      options: { projectionRoot: loginRuntimeDir }
    },
    {
      provider: 'codex',
      accountRef: 'login-auth-test-session',
      options: { projectionRoot: loginRuntimeDir }
    }
  ]);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime links Codex pending-login tmp into the host store before native spawn', {
  skip: process.platform === 'win32'
}, (t) => {
  const hostHomeDir = fsBase.mkdtempSync(path.join(os.tmpdir(), 'aih-pending-codex-resources-'));
  const aiHomeDir = path.join(hostHomeDir, '.ai_home');
  const hostCodexTmp = path.join(hostHomeDir, '.codex', 'tmp');
  t.after(() => fsBase.rmSync(hostHomeDir, { recursive: true, force: true }));
  fsBase.mkdirSync(hostCodexTmp, { recursive: true });

  const sessionStore = createSessionStoreService({
    fs: fsBase,
    fse,
    path,
    processObj: process,
    aiHomeDir,
    hostHomeDir,
    cliConfigs: {
      codex: { globalDir: '.codex' }
    },
    getProfileDir: (_provider, accountRef) => resolveAccountRuntimeDir(aiHomeDir, 'codex', accountRef),
    ensureDir: (dirPath) => fsBase.mkdirSync(dirPath, { recursive: true })
  });
  const { runtime, spawns } = createRuntimeHarness({}, {
    aiHomeDir,
    hostHomeDir,
    ensureSessionStoreLinks: sessionStore.ensureSessionStoreLinks
  });
  const loginSessionId = 'auth-shared-tmp';

  runtime.runCliPtyTracked('codex', '', [], true, { loginSessionId });

  const loginRuntimeDir = resolveLoginRuntimeDir(aiHomeDir, 'codex', loginSessionId);
  const pendingCodexTmp = path.join(loginRuntimeDir, '.codex', 'tmp');
  assert.equal(spawns.length, 1);
  assert.equal(fsBase.lstatSync(pendingCodexTmp).isSymbolicLink(), true);
  assert.equal(fsBase.realpathSync(pendingCodexTmp), fsBase.realpathSync(hostCodexTmp));

  const nativeBinary = path.join(hostHomeDir, 'native-codex');
  const generatedTmp = path.join(pendingCodexTmp, 'arg0', 'codex-arg0-test');
  fsBase.writeFileSync(nativeBinary, '', 'utf8');
  fsBase.mkdirSync(generatedTmp, { recursive: true });
  fsBase.symlinkSync(nativeBinary, path.join(generatedTmp, 'apply_patch'));

  assert.throws(() => spawns[0].proc._onExit({ exitCode: 7 }), /EXIT:7/);
  assert.equal(fsBase.existsSync(loginRuntimeDir), false);
  assert.equal(fsBase.lstatSync(path.join(hostCodexTmp, 'arg0', 'codex-arg0-test', 'apply_patch')).isSymbolicLink(), true);
});

test('runtime atomically assigns a Codex CLI id only after pending OAuth succeeds', async (t) => {
  const hostHomeDir = fsBase.mkdtempSync(path.join(os.tmpdir(), 'aih-pending-codex-login-success-'));
  const aiHomeDir = path.join(hostHomeDir, '.ai_home');
  t.after(() => fsBase.rmSync(hostHomeDir, { recursive: true, force: true }));
  const { runtime, proc, spawns, rawModeCalls } = createRuntimeHarness({
    AIH_CODEX_AUTH_PREFLIGHT: '0'
  }, {
    aiHomeDir,
    hostHomeDir,
    fs: {
      chmodSync: fsBase.chmodSync.bind(fsBase),
      renameSync: fsBase.renameSync.bind(fsBase)
    }
  });
  const loginSessionId = 'auth-atomic-success';

  runtime.runCliPtyTracked('codex', '', [], true, { loginSessionId });
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, ['login']);
  assert.equal(fsBase.existsSync(path.join(aiHomeDir, 'app-state.db')), false);

  const loginRuntimeDir = resolveLoginRuntimeDir(aiHomeDir, 'codex', loginSessionId);
  assert.equal(spawns[0].options.env.CODEX_HOME, path.join(loginRuntimeDir, '.codex'));
  assert.equal(fsBase.statSync(spawns[0].options.env.CODEX_HOME).isDirectory(), true);
  const idTokenPayload = Buffer.from(JSON.stringify({ email: 'pending-login@example.com' }))
    .toString('base64url');
  fsBase.writeFileSync(path.join(loginRuntimeDir, '.codex', 'auth.json'), JSON.stringify({
    tokens: {
      access_token: 'test-access-token',
      id_token: `e30.${idTokenPayload}.signature`,
      refresh_token: 'test-refresh-token',
      account_id: 'upstream-test-account'
    }
  }), 'utf8');

  spawns[0].proc._onExit({ exitCode: 0 });
  await new Promise((resolve) => setTimeout(resolve, 600));

  const accounts = listCliAccountRefRecords(fsBase, aiHomeDir, 'codex');
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].cliAccountId, '1');
  assert.equal(spawns.length, 2);
  assert.deepEqual(spawns[1].args, []);
  assert.equal(
    spawns[1].options.env.CODEX_HOME,
    path.join(resolveAccountRuntimeDir(aiHomeDir, 'codex', accounts[0].accountRef), '.codex')
  );
  assert.equal(fsBase.existsSync(loginRuntimeDir), false);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false, true, false]);
});

test('runtime reports a non-zero native Codex login exit without allocating an account', (t) => {
  const hostHomeDir = fsBase.mkdtempSync(path.join(os.tmpdir(), 'aih-pending-codex-login-failure-'));
  const aiHomeDir = path.join(hostHomeDir, '.ai_home');
  t.after(() => fsBase.rmSync(hostHomeDir, { recursive: true, force: true }));
  const { runtime, spawns, rawModeCalls } = createRuntimeHarness({}, {
    aiHomeDir,
    hostHomeDir
  });
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    runtime.runCliPtyTracked('codex', '', [], true, {
      loginSessionId: 'auth-native-failure'
    });
    assert.equal(spawns.length, 1);
    assert.throws(() => spawns[0].proc._onExit({ exitCode: 7 }), /EXIT:7/);
  } finally {
    console.error = originalError;
  }

  assert.equal(fsBase.existsSync(path.join(aiHomeDir, 'app-state.db')), false);
  assert.equal(
    errors.some((line) => line.includes('native Codex login exited with code 7') && line.includes('No account was created')),
    true
  );
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime relays native Claude OAuth by accountRef while keeping host session state', () => {
  const { runtime, proc, spawns, rawModeCalls, aiHomeDir, hostHomeDir, resolveHarnessAccountRef } = createRuntimeHarness({
    USER: 'model',
    AIH_RUNTIME_SHOW_USAGE: '0'
  }, {
    resolveCliPath: () => '/usr/bin/claude',
    ensureSessionStoreLinks: () => {
      throw new Error('Claude must not enter session-store synchronization');
    }
  });

  runtime.runCliPtyTracked('claude', '4', ['auth', 'status', '--json'], false);
  const accountRef = resolveHarnessAccountRef('claude', '4');
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, ['auth', 'status', '--json']);
  assert.equal(Object.prototype.hasOwnProperty.call(spawns[0].options.env, 'USER'), false);
  assert.equal(spawns[0].options.env.CLAUDE_CONFIG_DIR, path.join(hostHomeDir, '.claude'));
  assert.equal(spawns[0].options.env.ANTHROPIC_API_KEY, 'dummy');
  assert.equal(spawns[0].options.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9527');
  assert.equal(spawns[0].options.env.ANTHROPIC_CUSTOM_HEADERS, `x-account-ref: ${accountRef}`);
  assert.equal(fsBase.existsSync(resolveAccountRuntimeDir(aiHomeDir, 'claude', accountRef)), false);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime does not create an account directory for Claude token accounts', () => {
  const harness = createRuntimeHarness({
    USER: 'model',
    AIH_RUNTIME_SHOW_USAGE: '0'
  }, {
    resolveCliPath: () => '/usr/bin/claude'
  });
  const { runtime, proc, spawns, aiHomeDir, hostHomeDir, rawModeCalls } = harness;
  const accountRef = harness.resolveHarnessAccountRef('claude', '5');
  writeAccountCredentials(fsBase, aiHomeDir, accountRef, {
    ANTHROPIC_AUTH_TOKEN: 'relay-token',
    ANTHROPIC_BASE_URL: 'https://relay.example.com'
  });

  runtime.runCliPtyTracked('claude', '5', ['--version'], false);

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].options.env.CLAUDE_CONFIG_DIR, path.join(hostHomeDir, '.claude'));
  assert.equal(
    fsBase.existsSync(resolveAccountRuntimeDir(aiHomeDir, 'claude', accountRef)),
    false
  );

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime keeps USER and uses a disposable auth directory for Claude login', () => {
  const { runtime, proc, spawns, rawModeCalls, aiHomeDir } = createRuntimeHarness({
    USER: 'model',
    AIH_RUNTIME_SHOW_USAGE: '0'
  }, {
    resolveCliPath: () => '/usr/bin/claude'
  });

  runtime.runCliPtyTracked('claude', '4', [], true, { loginSessionId: 'claude-login-test' });
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].args, ['login']);
  assert.equal(spawns[0].options.env.USER, 'model');
  assert.equal(
    spawns[0].options.env.CLAUDE_CONFIG_DIR,
    path.join(resolveLoginRuntimeDir(aiHomeDir, 'claude', 'claude-login-test'), '.claude')
  );

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
  const { runtime, proc, spawns, rawModeCalls, aiHomeDir, hostHomeDir, resolveHarnessAccountRef } = createRuntimeHarness({
    CODEX_THREAD_ID: 'outer-thread',
    CODEX_TURN_ID: 'outer-turn',
    CODEX_CI: '1',
    CODEX_MANAGED_BY_NPM: '1',
    CODEX_MANAGED_PACKAGE_ROOT: '/tmp/outer-codex',
    CODEX_NETWORK_PROXY_ACTIVE: '1'
  });

  runtime.runCliPtyTracked('codex', '10086', ['--version'], false);
  const accountRef = resolveHarnessAccountRef('codex', '10086');

  assert.equal(spawns.length, 1);
  const env = spawns[0].options.env || {};
  assert.equal(env.CODEX_THREAD_ID, undefined);
  assert.equal(env.CODEX_TURN_ID, undefined);
  assert.equal(env.CODEX_CI, undefined);
  assert.equal(env.CODEX_MANAGED_BY_NPM, undefined);
  assert.equal(env.CODEX_MANAGED_PACKAGE_ROOT, undefined);
  assert.equal(env.CODEX_NETWORK_PROXY_ACTIVE, undefined);
  assert.equal(env.CODEX_HOME, path.join(resolveAccountRuntimeDir(aiHomeDir, 'codex', accountRef), '.codex'));
  assert.equal(env.CODEX_SQLITE_HOME, path.join(hostHomeDir, '.codex'));

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime injects bypass keyring environment variables for agy provider', () => {
  const { runtime, proc, spawns, rawModeCalls } = createRuntimeHarness();
  runtime.runCliPtyTracked('agy', '3', ['--version'], false);
  assert.equal(spawns.length, 1);
  const env = spawns[0].options.env || {};
  assert.equal(env.SSH_CLIENT, '127.0.0.1 12345 22');
  assert.equal(env.SSH_TTY, '/dev/tty');
  assert.equal(env.container, 'docker');
  assert.equal(env.WSL_DISTRO_NAME, 'Ubuntu');

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.deepEqual(rawModeCalls, [true, false]);
});

test('runtime publishes account title for non-usage-managed interactive providers', () => {
  const { runtime, proc, writes } = createRuntimeHarness();
  runtime.runCliPtyTracked('agy', '3', [], false);

  assert.ok(writes.some((line) => /\x1b\]0;[^\x07]*\[a:3\]\x07/.test(line)));

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime publishes claude title without provider text or fake icon', () => {
  const now = Date.now();
  const { runtime, proc, writes } = createRuntimeHarness({}, {
    readUsageCache: () => ({
      kind: 'claude_oauth_usage',
      capturedAt: now,
      entries: [
        { window: '5h', windowMinutes: 300, remainingPct: 58.3 },
        { window: '7days', windowMinutes: 10080, remainingPct: 95.1 }
      ]
    }),
    getUsageRemainingPercentValues: (snapshot) => {
      if (!snapshot || !Array.isArray(snapshot.entries)) return [];
      return snapshot.entries.map((x) => Number(x.remainingPct)).filter((n) => Number.isFinite(n));
    }
  });

  runtime.runCliPtyTracked('claude', '4', [], false);

  const title = writes.find((line) => /\x1b\]0;[^\x07]*\[o:4:5h:58% 7days:95%\]\x07/.test(line));
  assert.ok(title);
  assert.equal(title.includes(' CL '), false);
  assert.equal(title.includes('Claude'), false);
  assert.equal(title.includes('◇'), false);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime keeps Windows Terminal progress clear for idle PTY lifecycle', () => {
  const { runtime, proc, writes } = createRuntimeHarness({
    WT_SESSION: 'wt-session-1',
    AIH_RUNTIME_SHOW_USAGE: '0'
  }, {
    stdoutIsTTY: true
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);

  assert.equal(writes.some((line) => line.includes('\x1b]9;4;3;0\x07')), false);
  assert.ok(writes.some((line) => line.includes('\x1b]9;4;0;0\x07')));
  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.ok(writes.some((line) => line.includes('\x1b]9;4;0;0\x07')));
});

test('runtime does not start usage refresh scheduler in PTY mode by default', () => {
  const { runtime, proc, getSchedulerCalls } = createRuntimeHarness();
  runtime.runCliPtyTracked('codex', '10086', ['--version'], false);
  assert.equal(getSchedulerCalls(), 0);
  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime unrefs the boot animation timer', () => {
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  const timers = [];
  global.setInterval = (callback, ms) => {
    const timer = {
      callback,
      ms,
      unrefCalled: false,
      unref() { this.unrefCalled = true; }
    };
    timers.push(timer);
    return timer;
  };
  global.clearInterval = () => {};

  try {
    const { runtime, proc } = createRuntimeHarness();
    runtime.runCliPtyTracked('codex', '10086', ['--version'], false);

    const bootTimer = timers.find((timer) => timer.ms === 200);
    assert.ok(bootTimer);
    assert.equal(bootTimer.unrefCalled, true);
    assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  } finally {
    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
  }
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
    const { runtime, proc, spawns, aiHomeDir, hostHomeDir, cwd, resolveHarnessAccountRef } = createRuntimeHarness({
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
    const fromAccountRef = resolveHarnessAccountRef('codex', '10086');
    resolveHarnessAccountRef('codex', '10087');

    const hostConfigDir = path.join(hostHomeDir, '.codex');
    fsBase.mkdirSync(hostConfigDir, { recursive: true });
    fsBase.writeFileSync(path.join(hostConfigDir, 'config.toml'), 'model = "gpt-5.5"\n', 'utf8');

    runtime.runCliPtyTracked('codex', '10086', [], false);
    const fromCodexDir = path.join(resolveAccountRuntimeDir(aiHomeDir, 'codex', fromAccountRef), '.codex');
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

test('runtime publishes usage to the terminal title without reserving a screen row', () => {
  const now = Date.now();
  const { runtime, proc, writes, spawns } = createRuntimeHarness({}, {
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

  // Usage rides in the terminal title (OSC 0) with a compact oauth tag:
  // [o:<accid>:<remaining>]. 64.2% → 64%.
  assert.equal(
    writes.some((line) => /\x1b\]0;[^\x07]*\[o:10086:64%\]\x07/.test(line)),
    true
  );
  const titleWriteCountBeforeResize = writes
    .filter((line) => /\x1b\]0;\[o:10086:64%\]\x07/.test(line))
    .length;
  proc.stdout.emit('resize');
  assert.equal(
    writes.filter((line) => /\x1b\]0;\[o:10086:64%\]\x07/.test(line)).length,
    titleWriteCountBeforeResize
  );
  // No scroll-region reservation, no in-screen status row, full-height child.
  assert.equal(writes.some((line) => line.includes('\x1b[1;23r')), false);
  assert.equal(writes.some((line) => /\x1b\[\d+;1H\x1b\[2K/.test(line)), false);
  assert.equal(spawns[0].options.rows, 24);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime forwards PTY output verbatim without injecting viewport sequences', () => {
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
  const checkpoint = writes.length;
  spawns[0].proc._onData('assistant output that should reach the terminal as-is\r\n');
  const outputWrites = writes.slice(checkpoint);

  // The child's output is forwarded untouched — no scroll-region / cursor
  // save-restore wrapper is injected around it anymore.
  assert.equal(outputWrites.some((line) => line.includes('assistant output that should reach the terminal as-is')), true);
  assert.equal(outputWrites.some((line) => line.includes('\x1b[1;23r')), false);
  assert.equal(outputWrites.some((line) => /\x1b\[\d+;1H\x1b\[2K/.test(line)), false);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime resizes the child PTY to full terminal height on resize', () => {
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
  proc.stdout.columns = 100;
  proc.stdout.rows = 18;
  proc.stdout.emit('resize');
  proc.stdout.rows = 30;
  proc.stdout.emit('resize');

  // No reserved row: the child gets the full terminal height.
  assert.deepEqual(spawns[0].proc.resizeCalls, [
    { cols: 100, rows: 18 },
    { cols: 100, rows: 30 }
  ]);

  // And no scroll-region / status-row sequences are emitted on resize.
  const allWrites = writes.join('');
  assert.equal(allWrites.includes('\x1b[1;17r'), false);
  assert.equal(allWrites.includes('\x1b[1;29r'), false);
  assert.equal(/\x1b\[\d+;1H\x1b\[2K/.test(allWrites), false);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime redraws drawer viewport and clears old drawer rows on resize', () => {
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
  const checkpoint = writes.length;
  proc.stdout.columns = 100;
  proc.stdout.rows = 30;
  proc.stdout.emit('resize');

  const resizeWrites = writes.slice(checkpoint).join('');
  assert.deepEqual(spawns[1].proc.resizeCalls, [
    { cols: 80, rows: 4 },
    { cols: 100, rows: 4 }
  ]);
  assert.equal(resizeWrites.includes('\x1b[r'), true);
  assert.equal(resizeWrites.includes('\x1b[17;1H\x1b[2K'), true);
  assert.equal(resizeWrites.includes('\x1b[24;1H\x1b[2K'), true);
  assert.equal(resizeWrites.includes('\x1b[23;1H\x1b[2K'), true);
  assert.equal(resizeWrites.includes('\x1b[30;1H\x1b[2K'), true);
  assert.equal(resizeWrites.includes('\x1b[26;29r'), true);
  assert.equal(resizeWrites.includes('account 10086 usage remaining'), true);
  assert.equal(resizeWrites.includes('┌'), true);
  assert.equal(resizeWrites.includes('└'), true);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime restores full terminal viewport and clears the usage title on cleanup', () => {
  const now = Date.now();
  const { runtime, proc, writes } = createRuntimeHarness({}, {
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
  const checkpoint = writes.length;

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);

  const cleanupWrites = writes.slice(checkpoint).join('');
  assert.equal(cleanupWrites.includes('\x1b[r'), true);
  // The usage title is reset (OSC 0 with empty text) on cleanup.
  assert.equal(cleanupWrites.includes('\x1b]0;\x07'), true);
});

test('runtime runs the child at full terminal height (no reserved status row)', () => {
  const { runtime, proc, spawns } = createRuntimeHarness();

  runtime.runCliPtyTracked('codex', '10086', [], false);

  assert.equal(spawns[0].options.rows, 24);

  proc.stdout.rows = 30;
  proc.stdout.emit('resize');

  assert.deepEqual(spawns[0].proc.resizeCalls, [{ cols: 80, rows: 30 }]);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime treats codex resume as interactive but keeps one-shot commands full height', () => {
  const resumeHarness = createRuntimeHarness();
  resumeHarness.runtime.runCliPtyTracked('codex', '10086', ['resume', 'thread-id'], false);

  assert.equal(resumeHarness.spawns[0].options.rows, 24);
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
      upsertRuntimeState(accountRef, provider, runtimeState, baseState) {
        runtimeUpserts.push({ accountRef, provider, runtimeState, baseState });
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
      upsertRuntimeState(accountRef, provider, runtimeState, baseState) {
        runtimeUpserts.push({ accountRef, provider, runtimeState, baseState });
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
  let standbyAccountRef = '';
  const { runtime, proc, spawns, writes, resolveHarnessAccountRef } = createRuntimeHarness({
    AIH_CODEX_AUTH_PREFLIGHT: '0',
    AIH_RUNTIME_SHOW_USAGE: '0'
  }, {
    getNextAvailableId: () => '10087',
    getAccountStateIndex: () => ({
      getAccountState: (accountRef) => {
        if (accountRef === standbyAccountRef) {
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
      upsertRuntimeState(accountRef, provider, runtimeState, baseState) {
        runtimeUpserts.push({ accountRef, provider, runtimeState, baseState });
        return true;
      }
    })
  });
  standbyAccountRef = resolveHarnessAccountRef('codex', '10087');

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

  // Usage is published to the terminal title (OSC 0) with [o:<accid>:<remaining>],
  // never painted on screen, so it can't disturb the child's cursor/rendering.
  assert.equal(writes.some((line) => /\x1b\]0;[^\x07]*\[o:10086:91%\]\x07/.test(line)), true);
  // It must NOT reserve an in-screen row or scroll region.
  assert.equal(writes.some((line) => /\x1b\[\d+;1H\x1b\[2K/.test(line)), false);
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
  const lockDir = path.join(sharedHome, 'run', 'locks');
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
  const lockPath = path.join(sharedHome, 'run', 'locks', 'windows-clipboard-mirror.lock');
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
  // Initial title from the stale cache: 75.5% → 76%.
  assert.ok(writes.some((line) => /\x1b\]0;[^\x07]*\[o:10086:76%\]\x07/.test(line)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshCalls >= 1, true);
  // After the no-cache refresh the title auto-updates: 63.2% → 63%.
  assert.ok(writes.some((line) => /\x1b\]0;[^\x07]*\[o:10086:63%\]\x07/.test(line)));

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
    const { runtime, proc, writes, spawns, aiHomeDir, resolveHarnessAccountRef } = createRuntimeHarness({}, {
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
    const accountRef = resolveHarnessAccountRef('codex', '10014');
    writeAccountCredentials(fsBase, aiHomeDir, accountRef, {
      OPENAI_API_KEY: 'sk-external-relay'
    });

    runtime.runCliPtyTracked('codex', '10014', [], false);
    for (const tick of intervalTicks) tick();

    assert.equal(spawns.length, 1);
    assert.equal(nextAccountLookups, 0);
    // API-key accounts show a bare tag with no usage figure.
    assert.ok(writes.some((line) => /\x1b\]0;[^\x07]*\[a:10014\]\x07/.test(line)));
    assert.equal(writes.some((line) => line.includes('usage remaining')), false);

    assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  } finally {
    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
  }
});

test('runtime suppresses fixed usage status for built-in aih server profile fullscreen TUI', () => {
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
    const { runtime, proc, writes, spawns } = createRuntimeHarness({}, {
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

    runtime.runCliPtyTracked('codex', '', [], false, { gateway: true });
    for (const tick of intervalTicks) tick();

    assert.equal(spawns.length, 1);
    assert.equal(nextAccountLookups, 0);
    assert.equal(writes.some((line) => line.includes(`account ${AIH_SERVER_PROFILE_ID} api-key mode`)), false);
    assert.equal(writes.some((line) => line.includes(`account ${AIH_SERVER_PROFILE_ID} usage remaining: unknown`)), false);
    assert.equal(writes.some((line) => line.includes(`account ${AIH_SERVER_PROFILE_ID} usage remaining: 0.0%`)), false);

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
  let activeAccountRef = '';
  let standbyAccountRef = '';
  let activeRow = {
    status: 'up',
    configured: true,
    apiKeyMode: false,
    displayName: 'oauth@example.com'
  };
  const { runtime, proc, writes, spawns, resolveHarnessAccountRef } = createRuntimeHarness({}, {
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
      getAccountState: (accountRef) => {
        if (accountRef === activeAccountRef) return activeRow;
        if (accountRef === standbyAccountRef) {
          return {
            status: 'up',
            configured: true,
            apiKeyMode: false,
            displayName: 'standby@example.com'
          };
        }
        return null;
      },
      upsertRuntimeState(accountRef, provider, runtimeState, baseState) {
        upserts.push({ accountRef, provider, runtimeState, baseState });
        activeRow = { ...activeRow, runtimeState };
        return true;
      }
    })
  });
  activeAccountRef = resolveHarnessAccountRef('codex', '10015');
  standbyAccountRef = resolveHarnessAccountRef('codex', '10016');

  runtime.runCliPtyTracked('codex', '10015', [], false);
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].provider, 'codex');
  assert.equal(upserts[0].accountRef, activeAccountRef);
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
      upsertRuntimeState(accountRef, provider, runtimeState, baseState) {
        upserts.push({ accountRef, provider, runtimeState, baseState });
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
  // Initial title from the stale cache: 42.8% → 43%.
  assert.ok(writes.some((line) => /\x1b\]0;[^\x07]*\[o:2:43%\]\x07/.test(line)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshCalls >= 1, true);
  // After refresh: 39.1% → 39%.
  assert.ok(writes.some((line) => /\x1b\]0;[^\x07]*\[o:2:39%\]\x07/.test(line)));

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

test('runtime consumes SSH clipboard paste frames and injects the cached host image path', () => {
  const image = {
    buffer: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('ssh-runtime-paste')
    ]),
    mimeType: 'image/png'
  };
  const encoded = encodeClipboardImageFrames(image, { action: 'paste', chunkSize: 8, id: 'runtime-paste' });
  const { runtime, proc, ptyWrites } = createRuntimeHarness({
    SSH_CONNECTION: '192.0.2.10 50000 192.0.2.20 22',
    SSH_TTY: '/dev/pts/9'
  }, {
    platform: 'linux'
  });

  runtime.runCliPtyTracked('codex', '10086', [], false);
  proc.stdin.emit('data', Buffer.from(encoded.frames.join('')));

  assert.equal(ptyWrites.length, 1);
  const injectedPath = String(ptyWrites[0]);
  assert.equal(path.isAbsolute(injectedPath), true);
  assert.match(injectedPath, /aih_clip_\d+_[a-f0-9]{12}\.png$/);
  assert.deepEqual(fsBase.readFileSync(injectedPath), image.buffer);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime caches SSH clipboard images and pastes the latest image on remote Alt+V', () => {
  const image = {
    buffer: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('ssh-runtime-cache')
    ]),
    mimeType: 'image/png'
  };
  const encoded = encodeClipboardImageFrames(image, { action: 'cache', chunkSize: 4096, id: 'runtime-cache' });
  const { runtime, proc, ptyWrites } = createRuntimeHarness({
    SSH_CONNECTION: '192.0.2.10 50000 192.0.2.20 22',
    SSH_TTY: '/dev/pts/10'
  }, {
    platform: 'linux'
  });

  runtime.runCliPtyTracked('claude', '1', [], false);
  proc.stdin.emit('data', Buffer.from(encoded.frames.join('')));
  assert.equal(ptyWrites.length, 0);

  proc.stdin.emit('data', Buffer.from('\x1bv'));
  assert.equal(ptyWrites.length, 1);
  assert.match(String(ptyWrites[0]), /aih_clip_\d+_[a-f0-9]{12}\.png$/);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime requests terminal clipboard image over the current SSH session', () => {
  const sshTty = `/dev/pts/terminal-clipboard-${process.pid}`;
  const image = {
    buffer: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('ssh-terminal-clipboard')
    ]),
    mimeType: 'image/png'
  };
  const { runtime, proc, ptyWrites, writes } = createRuntimeHarness({
    SSH_CONNECTION: '192.0.2.10 50000 192.0.2.20 22',
    SSH_TTY: sshTty
  }, {
    platform: 'linux'
  });

  runtime.runCliPtyTracked('claude', '1', [], false);
  proc.stdin.emit('data', Buffer.from('\x1bv'));

  assert.equal(ptyWrites.length, 0);
  assert.equal(writes.some((line) => line.includes(`${OSC5522_PREFIX}type=read:id=aih-`) && line.includes(`;${Buffer.from('.').toString('base64')}`)), true);

  const targetsMime = Buffer.from('.', 'utf8').toString('base64');
  const mime = Buffer.from('image/png', 'utf8').toString('base64');
  const mimeListResponse = [
    `${OSC5522_PREFIX}type=read:id=aih-targets:status=OK${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:id=aih-targets:status=DATA:mime=${targetsMime};${Buffer.from('text/plain image/png\n').toString('base64')}${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:id=aih-targets:status=DONE${STRING_TERMINATOR}`
  ].join('');
  proc.stdin.emit('data', Buffer.from(mimeListResponse, 'latin1'));

  assert.equal(writes.some((line) => line.includes(`type=read:mime=${mime}:name=`) && line.includes(`;${mime}${STRING_TERMINATOR}`)), true);

  const response = [
    `${OSC5522_PREFIX}type=read:id=aih-test:status=OK${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:id=aih-test:status=DATA:mime=${mime};${image.buffer.toString('base64')}${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:id=aih-test:status=DONE${STRING_TERMINATOR}`
  ].join('');
  proc.stdin.emit('data', Buffer.from(response, 'latin1'));

  assert.equal(ptyWrites.length, 1);
  const injectedPath = String(ptyWrites[0]);
  assert.match(injectedPath, /aih_clip_\d+_[a-f0-9]{12}\.png$/);
  assert.deepEqual(fsBase.readFileSync(injectedPath), image.buffer);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime reads terminal clipboard image from OSC5522 text/html data URLs', () => {
  const image = {
    buffer: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('ssh-terminal-html-data-url')
    ]),
    mimeType: 'image/png'
  };
  const { runtime, proc, ptyWrites, writes } = createRuntimeHarness({
    SSH_CONNECTION: '192.0.2.10 50000 192.0.2.20 22',
    SSH_TTY: `/dev/pts/terminal-html-data-url-${process.pid}`
  }, {
    platform: 'linux'
  });

  runtime.runCliPtyTracked('claude', '1', [], false);
  proc.stdin.emit('data', Buffer.from('\x1bv'));

  const targetsMime = Buffer.from('.', 'utf8').toString('base64');
  const htmlMime = Buffer.from('text/html', 'utf8').toString('base64');
  const mimeListResponse = [
    `${OSC5522_PREFIX}type=read:id=aih-targets:status=OK${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:id=aih-targets:status=DATA:mime=${targetsMime};${Buffer.from('text/html\n').toString('base64')}${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:id=aih-targets:status=DONE${STRING_TERMINATOR}`
  ].join('');
  proc.stdin.emit('data', Buffer.from(mimeListResponse, 'latin1'));

  assert.equal(writes.some((line) => line.includes(`type=read:mime=${htmlMime}:name=`) && line.includes(`;${htmlMime}${STRING_TERMINATOR}`)), true);

  const html = `<img src="data:image/png;base64,${image.buffer.toString('base64')}">`;
  const response = [
    `${OSC5522_PREFIX}type=read:id=aih-html:status=OK${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:id=aih-html:status=DATA:mime=${htmlMime};${Buffer.from(html).toString('base64')}${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:id=aih-html:status=DONE${STRING_TERMINATOR}`
  ].join('');
  proc.stdin.emit('data', Buffer.from(response, 'latin1'));

  assert.equal(ptyWrites.length, 1);
  const injectedPath = String(ptyWrites[0]);
  assert.match(injectedPath, /aih_clip_\d+_[a-f0-9]{12}\.png$/);
  assert.deepEqual(fsBase.readFileSync(injectedPath), image.buffer);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime preserves CJK/emoji characters in pty output over SSH without latin1 corruption', () => {
  // consumeSshClipboardShimRequests was previously using Buffer.from(text,'latin1') which
  // truncated each Unicode code point > U+00FF to its low byte (e.g. '你' U+4F60 → 0x60 = '`'),
  // then toString('latin1') re-mapped each byte to a Latin-1 char, yielding garbled output
  // instead of the original Chinese characters.
  const chinese = '你好世界✦⚠';
  const { runtime, spawns, writes } = createRuntimeHarness({
    SSH_CONNECTION: '192.0.2.10 50000 192.0.2.20 22',
    SSH_TTY: '/dev/pts/0'
  });
  runtime.runCliPtyTracked('claude', '1', [], false);
  // Emit Chinese text from pty as a UTF-8 decoded string (as node-pty delivers it)
  spawns[0].proc._onData(chinese);
  const received = writes.join('');
  assert.ok(received.includes(chinese), `CJK output corrupted: got ${JSON.stringify(received)}`);
});

test('runtime installs server-side xclip shim and fulfills image reads through parent OSC5522 flow', () => {
  const image = {
    buffer: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('ssh-terminal-xclip-shim')
    ]),
    mimeType: 'image/png'
  };
  const { runtime, proc, spawns, ptyWrites, writes, aiHomeDir } = createRuntimeHarness({
    SSH_CONNECTION: '192.0.2.10 50000 192.0.2.20 22',
    SSH_TTY: `/dev/pts/xclip-shim-${process.pid}`
  }, {
    platform: 'linux'
  });

  runtime.runCliPtyTracked('claude', '1', [], false);
  assert.equal(spawns.length, 1);
  const env = spawns[0].options.env;
  const shimDir = path.join(aiHomeDir, 'run', 'shims', 'ssh-clipboard');
  assert.equal(String(env.PATH || '').split(path.delimiter)[0], shimDir);
  assert.equal(fsBase.existsSync(path.join(shimDir, 'xclip')), true);
  assert.equal(fsBase.existsSync(path.join(shimDir, 'wl-paste')), true);
  assert.equal(fsBase.existsSync(path.join(shimDir, 'pbpaste')), true);
  assert.equal(fsBase.existsSync(path.join(shimDir, 'pngpaste')), true);
  assert.equal(fsBase.existsSync(path.join(shimDir, 'osascript')), true);
  assert.equal(env.AIH_SSH_CLIP_SHIM_BIN_DIR, shimDir);

  const responsePath = path.join(env.AIH_SSH_CLIP_SHIM_DIR, 'responses', 'req-image.json');
  const frame = buildShimRequestFrame({
    id: 'req-image',
    kind: 'read',
    mimeType: 'image/png',
    responsePath
  });
  spawns[0].proc._onData(frame);

  assert.equal(ptyWrites.length, 0);
  assert.equal(writes.some((line) => line.includes(frame)), false);
  const mime = Buffer.from('image/png', 'utf8').toString('base64');
  assert.equal(writes.some((line) => line.includes(`${OSC5522_PREFIX}type=read:id=aih-shim-req-image:mime=${mime}:name=`) && line.includes(`;${mime}${STRING_TERMINATOR}`)), true);

  const response = [
    `${OSC5522_PREFIX}type=read:id=aih-shim-req-image:status=OK${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:id=aih-shim-req-image:status=DATA:mime=${mime};${image.buffer.toString('base64')}${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:id=aih-shim-req-image:status=DONE${STRING_TERMINATOR}`
  ].join('');
  proc.stdin.emit('data', Buffer.from(response, 'latin1'));

  const payload = JSON.parse(fsBase.readFileSync(responsePath, 'utf8'));
  assert.equal(payload.ok, true);
  assert.equal(payload.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(payload.data, 'base64'), image.buffer);
  assert.equal(ptyWrites.length, 0);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime fulfills server-side xclip TARGETS shim requests through OSC5522 MIME list', () => {
  const { runtime, proc, spawns, writes, aiHomeDir } = createRuntimeHarness({
    SSH_CONNECTION: '192.0.2.10 50000 192.0.2.20 22',
    SSH_TTY: `/dev/pts/xclip-targets-shim-${process.pid}`
  }, {
    platform: 'linux'
  });

  runtime.runCliPtyTracked('claude', '1', [], false);
  const env = spawns[0].options.env;
  assert.equal(String(env.PATH || '').split(path.delimiter)[0], path.join(aiHomeDir, 'run', 'shims', 'ssh-clipboard'));

  const responsePath = path.join(env.AIH_SSH_CLIP_SHIM_DIR, 'responses', 'req-targets.json');
  const frame = buildShimRequestFrame({
    id: 'req-targets',
    kind: 'list',
    mimeType: 'TARGETS',
    responsePath
  });
  spawns[0].proc._onData(frame);

  const targetsMime = Buffer.from('.', 'utf8').toString('base64');
  assert.equal(writes.some((line) => line.includes(`${OSC5522_PREFIX}type=read:id=aih-shim-req-targets;${targetsMime}`)), true);

  const response = [
    `${OSC5522_PREFIX}type=read:id=aih-shim-req-targets:status=OK${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:id=aih-shim-req-targets:status=DATA:mime=${targetsMime};${Buffer.from('text/plain image/png text/html\n').toString('base64')}${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:id=aih-shim-req-targets:status=DONE${STRING_TERMINATOR}`
  ].join('');
  proc.stdin.emit('data', Buffer.from(response, 'latin1'));

  const payload = JSON.parse(fsBase.readFileSync(responsePath, 'utf8'));
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.mimeTypes, ['text/plain', 'image/png', 'text/html']);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime does not install server-side clipboard command shims outside SSH sessions', () => {
  const { runtime, proc, spawns, aiHomeDir } = createRuntimeHarness({}, {
    platform: 'linux'
  });

  runtime.runCliPtyTracked('claude', '1', [], false);

  assert.equal(spawns.length, 1);
  const env = spawns[0].options.env;
  assert.equal(env.AIH_SSH_CLIP_SHIM_DIR, undefined);
  assert.notEqual(String(env.PATH || '').split(path.delimiter)[0], path.join(aiHomeDir, 'run', 'shims', 'ssh-clipboard'));

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime treats empty SSH bracketed paste as terminal image paste trigger', () => {
  const { runtime, proc, ptyWrites, writes } = createRuntimeHarness({
    SSH_CONNECTION: '192.0.2.10 50000 192.0.2.20 22',
    SSH_TTY: `/dev/pts/empty-bracketed-image-paste-${process.pid}`
  }, {
    platform: 'linux'
  });

  runtime.runCliPtyTracked('claude', '1', [], false);
  proc.stdin.emit('data', Buffer.from('\x1b[200~\x1b[201~'));

  assert.equal(ptyWrites.length, 0);
  assert.equal(writes.some((line) => line.includes(`${OSC5522_PREFIX}type=read:id=aih-`) && line.includes(`;${Buffer.from('.').toString('base64')}`)), true);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime converts SSH bracketed image data-url paste into cached image path', () => {
  const image = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('ssh-bracketed-data-url')
  ]);
  const payload = `data:image/png;base64,${image.toString('base64')}`;
  const { runtime, proc, ptyWrites } = createRuntimeHarness({
    SSH_CONNECTION: '192.0.2.10 50000 192.0.2.20 22',
    SSH_TTY: `/dev/pts/bracketed-data-url-${process.pid}`
  }, {
    platform: 'linux'
  });

  runtime.runCliPtyTracked('claude', '1', [], false);
  proc.stdin.emit('data', Buffer.from(`\x1b[200~${payload}\x1b[201~`));

  assert.equal(ptyWrites.length, 1);
  const injectedPath = String(ptyWrites[0]);
  assert.match(injectedPath, /aih_clip_\d+_[a-f0-9]{12}\.png$/);
  assert.deepEqual(fsBase.readFileSync(injectedPath), image);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime converts SSH bracketed base64 image paste into cached image path', () => {
  const image = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('ssh-bracketed-base64')
  ]);
  const { runtime, proc, ptyWrites } = createRuntimeHarness({
    SSH_CONNECTION: '192.0.2.10 50000 192.0.2.20 22',
    SSH_TTY: `/dev/pts/bracketed-base64-${process.pid}`
  }, {
    platform: 'linux'
  });

  runtime.runCliPtyTracked('claude', '1', [], false);
  proc.stdin.emit('data', Buffer.from(`\x1b[200~${image.toString('base64')}\x1b[201~`));

  assert.equal(ptyWrites.length, 1);
  const injectedPath = String(ptyWrites[0]);
  assert.match(injectedPath, /aih_clip_\d+_[a-f0-9]{12}\.png$/);
  assert.deepEqual(fsBase.readFileSync(injectedPath), image);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime preserves SSH bracketed text paste when payload is not an image', () => {
  const { runtime, proc, ptyWrites } = createRuntimeHarness({
    SSH_CONNECTION: '192.0.2.10 50000 192.0.2.20 22',
    SSH_TTY: `/dev/pts/bracketed-text-${process.pid}`
  }, {
    platform: 'linux'
  });
  const payload = Buffer.from('\x1b[200~hello\x1b[201~');

  runtime.runCliPtyTracked('claude', '1', [], false);
  proc.stdin.emit('data', payload);

  assert.equal(ptyWrites.length, 1);
  assert.equal(String(ptyWrites[0]), payload.toString('utf8'));

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime enables terminal 5522 paste events during SSH sessions and disables on cleanup', () => {
  const { runtime, proc, writes } = createRuntimeHarness({
    SSH_CONNECTION: '192.0.2.10 50000 192.0.2.20 22',
    SSH_TTY: `/dev/pts/paste-events-${process.pid}`
  }, {
    platform: 'linux'
  });

  runtime.runCliPtyTracked('claude', '1', [], false);
  assert.equal(writes.some((line) => line.includes(PASTE_EVENTS_5522_SUPPORT_QUERY)), true);
  assert.equal(writes.some((line) => line.includes(PASTE_EVENTS_5522_ENABLE)), true);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  assert.equal(writes.some((line) => line.includes(PASTE_EVENTS_5522_DISABLE)), true);
});

test('runtime reports unsupported terminal 5522 support after clipboard timeout', async () => {
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
    const { runtime, proc, ptyWrites, writes } = createRuntimeHarness({
      SSH_CONNECTION: '192.0.2.10 50000 192.0.2.20 22',
      SSH_TTY: `/dev/pts/unsupported-5522-${process.pid}`
    }, {
      platform: 'linux',
      fetchSshClipAgentImage: async () => null
    });

    runtime.runCliPtyTracked('claude', '1', [], false);
    proc.stdin.emit('data', Buffer.from('\x1b[?5522;4$y', 'latin1'));
    proc.stdin.emit('data', Buffer.from('\x1bv'));
    assert.equal(writes.some((line) => line.includes(`${OSC52_PREFIX}c;?`)), true);

    const terminalTimer = timers.find((timer) => timer.ms === 5000 && !timer.cleared);
    assert.ok(terminalTimer);
    terminalTimer.cb();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(ptyWrites.length, 0);
    assert.equal(writes.some((line) => line.includes('Terminal reported OSC 5522 paste-events unsupported')), true);

    assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
});

test('runtime falls back to OSC52 raw clipboard read before any client helper', async () => {
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
    let fetchCalls = 0;
    const image = {
      buffer: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('ssh-terminal-osc52-fallback')
      ]),
      mimeType: 'image/png'
    };
    const { runtime, proc, ptyWrites, writes } = createRuntimeHarness({
      SSH_CONNECTION: '192.0.2.10 50000 192.0.2.20 22',
      SSH_TTY: `/dev/pts/osc52-fallback-${process.pid}`
    }, {
      platform: 'linux',
      fetchSshClipAgentImage: async () => {
        fetchCalls += 1;
        return null;
      }
    });

    runtime.runCliPtyTracked('claude', '1', [], false);
    proc.stdin.emit('data', Buffer.from('\x1bv'));

    const mimeListTimer = timers.find((timer) => timer.ms === 900 && !timer.cleared);
    assert.ok(mimeListTimer);
    mimeListTimer.cb();
    mimeListTimer.cleared = true;
    assert.equal(writes.some((line) => line.includes(`${OSC5522_PREFIX}type=read:id=aih-`) && !line.includes(`;${Buffer.from('.').toString('base64')}`)), true);

    const osc5522Timer = timers.find((timer) => timer.ms === 5000 && !timer.cleared);
    assert.ok(osc5522Timer);
    osc5522Timer.cb();
    osc5522Timer.cleared = true;
    assert.equal(writes.some((line) => line.includes(`${OSC52_PREFIX}c;?`)), true);
    assert.equal(fetchCalls, 0);

    proc.stdin.emit('data', Buffer.from(`${OSC52_PREFIX}c;${image.buffer.toString('base64')}${STRING_TERMINATOR}`, 'latin1'));

    assert.equal(fetchCalls, 0);
    assert.equal(ptyWrites.length, 1);
    const injectedPath = String(ptyWrites[0]);
    assert.match(injectedPath, /aih_clip_\d+_[a-f0-9]{12}\.png$/);
    assert.deepEqual(fsBase.readFileSync(injectedPath), image.buffer);

    assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
});

test('runtime converts OSC52 TIFF clipboard data to a cached PNG path', () => {
  const tiff = tiffBuffer('terminal-app-osc52-tiff');
  const png = pngBuffer('terminal-app-osc52-png');
  const { runtime, proc, ptyWrites } = createRuntimeHarness({
    SSH_CONNECTION: '192.0.2.10 50000 192.0.2.20 22',
    SSH_TTY: `/dev/pts/osc52-tiff-${process.pid}`
  }, {
    platform: 'linux',
    spawnSync: (command, args) => {
      if (command === 'sips' && Array.isArray(args) && args.includes('--out')) {
        fsBase.writeFileSync(args[args.length - 1], png);
        return { status: 0 };
      }
      return { status: 1 };
    }
  });

  runtime.runCliPtyTracked('claude', '1', [], false);
  proc.stdin.emit('data', Buffer.from(`${OSC52_PREFIX}c;${tiff.toString('base64')}${STRING_TERMINATOR}`, 'latin1'));

  assert.equal(ptyWrites.length, 1);
  const injectedPath = String(ptyWrites[0]);
  assert.match(injectedPath, /aih_clip_\d+_[a-f0-9]{12}\.png$/);
  assert.deepEqual(fsBase.readFileSync(injectedPath), png);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime reads image bytes from terminal 5522 paste events without a client helper', () => {
  const image = {
    buffer: Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('ssh-terminal-paste-event')
    ]),
    mimeType: 'image/png'
  };
  const mime = Buffer.from('image/png', 'utf8').toString('base64');
  const pw = Buffer.from('secret', 'utf8').toString('base64');
  const { runtime, proc, ptyWrites, writes } = createRuntimeHarness({
    SSH_CONNECTION: '192.0.2.10 50000 192.0.2.20 22',
    SSH_TTY: `/dev/pts/paste-event-image-${process.pid}`
  }, {
    platform: 'linux'
  });

  runtime.runCliPtyTracked('claude', '1', [], false);
  proc.stdin.emit('data', Buffer.from([
    `${OSC5522_PREFIX}type=read:status=OK:pw=${pw}${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:status=DATA:mime=${mime}${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:status=DONE${STRING_TERMINATOR}`
  ].join(''), 'latin1'));

  assert.equal(writes.some((line) => line.includes(`type=read:mime=${mime}:pw=${pw}:name=`) && line.includes(`;${mime}${STRING_TERMINATOR}`)), true);
  assert.equal(ptyWrites.length, 0);

  proc.stdin.emit('data', Buffer.from([
    `${OSC5522_PREFIX}type=read:status=OK${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:status=DATA:mime=${mime};${image.buffer.toString('base64')}${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:status=DONE${STRING_TERMINATOR}`
  ].join(''), 'latin1'));

  assert.equal(ptyWrites.length, 1);
  const injectedPath = String(ptyWrites[0]);
  assert.match(injectedPath, /aih_clip_\d+_[a-f0-9]{12}\.png$/);
  assert.deepEqual(fsBase.readFileSync(injectedPath), image.buffer);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime refreshes terminal clipboard timeout while OSC5522 image chunks arrive', () => {
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
    const image = {
      buffer: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('ssh-terminal-chunked-paste-event')
      ]),
      mimeType: 'image/png'
    };
    const first = image.buffer.slice(0, 12);
    const second = image.buffer.slice(12);
    const mime = Buffer.from('image/png', 'utf8').toString('base64');
    const pw = Buffer.from('secret', 'utf8').toString('base64');
    const { runtime, proc, ptyWrites, writes } = createRuntimeHarness({
      SSH_CONNECTION: '192.0.2.10 50000 192.0.2.20 22',
      SSH_TTY: `/dev/pts/paste-event-chunked-image-${process.pid}`
    }, {
      platform: 'linux'
    });

    runtime.runCliPtyTracked('claude', '1', [], false);
    proc.stdin.emit('data', Buffer.from([
      `${OSC5522_PREFIX}type=read:status=OK:pw=${pw}${STRING_TERMINATOR}`,
      `${OSC5522_PREFIX}type=read:status=DATA:mime=${mime}${STRING_TERMINATOR}`,
      `${OSC5522_PREFIX}type=read:status=DONE${STRING_TERMINATOR}`
    ].join(''), 'latin1'));

    assert.equal(writes.some((line) => line.includes(`type=read:mime=${mime}:pw=${pw}:name=`) && line.includes(`;${mime}${STRING_TERMINATOR}`)), true);
    const originalTimer = timers.find((timer) => timer.ms === 5000 && !timer.cleared);
    assert.ok(originalTimer);

    proc.stdin.emit('data', Buffer.from([
      `${OSC5522_PREFIX}type=read:status=OK${STRING_TERMINATOR}`,
      `${OSC5522_PREFIX}type=read:status=DATA:mime=${mime};${first.toString('base64')}${STRING_TERMINATOR}`
    ].join(''), 'latin1'));

    assert.equal(originalTimer.cleared, true);
    originalTimer.cb();
    assert.equal(writes.some((line) => line.includes(`${OSC52_PREFIX}c;?`)), false);
    assert.equal(ptyWrites.length, 0);

    proc.stdin.emit('data', Buffer.from([
      `${OSC5522_PREFIX}type=read:status=DATA:mime=${mime};${second.toString('base64')}${STRING_TERMINATOR}`,
      `${OSC5522_PREFIX}type=read:status=DONE${STRING_TERMINATOR}`
    ].join(''), 'latin1'));

    assert.equal(ptyWrites.length, 1);
    const injectedPath = String(ptyWrites[0]);
    assert.match(injectedPath, /aih_clip_\d+_[a-f0-9]{12}\.png$/);
    assert.deepEqual(fsBase.readFileSync(injectedPath), image.buffer);

    assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
});

test('runtime falls back to OSC52 when a 5522 paste-event image read stalls', () => {
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
    let fetchCalls = 0;
    const image = {
      buffer: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('ssh-terminal-paste-event-osc52-fallback')
      ]),
      mimeType: 'image/png'
    };
    const mime = Buffer.from('image/png', 'utf8').toString('base64');
    const pw = Buffer.from('secret', 'utf8').toString('base64');
    const { runtime, proc, ptyWrites, writes } = createRuntimeHarness({
      SSH_CONNECTION: '192.0.2.10 50000 192.0.2.20 22',
      SSH_TTY: `/dev/pts/paste-event-stalled-image-${process.pid}`
    }, {
      platform: 'linux',
      fetchSshClipAgentImage: async () => {
        fetchCalls += 1;
        return null;
      }
    });

    runtime.runCliPtyTracked('claude', '1', [], false);
    proc.stdin.emit('data', Buffer.from([
      `${OSC5522_PREFIX}type=read:status=OK:pw=${pw}${STRING_TERMINATOR}`,
      `${OSC5522_PREFIX}type=read:status=DATA:mime=${mime}${STRING_TERMINATOR}`,
      `${OSC5522_PREFIX}type=read:status=DONE${STRING_TERMINATOR}`
    ].join(''), 'latin1'));

    assert.equal(writes.some((line) => line.includes(`type=read:mime=${mime}:pw=${pw}:name=`) && line.includes(`;${mime}${STRING_TERMINATOR}`)), true);
    const pasteReadTimer = timers.find((timer) => timer.ms === 5000 && !timer.cleared);
    assert.ok(pasteReadTimer);
    pasteReadTimer.cb();

    assert.equal(fetchCalls, 0);
    assert.equal(writes.some((line) => line.includes(`${OSC52_PREFIX}c;?`)), true);

    proc.stdin.emit('data', Buffer.from(`${OSC52_PREFIX}c;${image.buffer.toString('base64')}${STRING_TERMINATOR}`, 'latin1'));

    assert.equal(fetchCalls, 0);
    assert.equal(ptyWrites.length, 1);
    const injectedPath = String(ptyWrites[0]);
    assert.match(injectedPath, /aih_clip_\d+_[a-f0-9]{12}\.png$/);
    assert.deepEqual(fsBase.readFileSync(injectedPath), image.buffer);

    assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
});

test('runtime preserves text/plain terminal 5522 paste events for normal SSH paste', () => {
  const mime = Buffer.from('text/plain', 'utf8').toString('base64');
  const text = Buffer.from('hello from terminal paste', 'utf8');
  const { runtime, proc, ptyWrites, writes } = createRuntimeHarness({
    SSH_CONNECTION: '192.0.2.10 50000 192.0.2.20 22',
    SSH_TTY: `/dev/pts/paste-event-text-${process.pid}`
  }, {
    platform: 'linux'
  });

  runtime.runCliPtyTracked('claude', '1', [], false);
  proc.stdin.emit('data', Buffer.from([
    `${OSC5522_PREFIX}type=read:status=OK${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:status=DATA:mime=${mime}${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:status=DONE${STRING_TERMINATOR}`
  ].join(''), 'latin1'));

  assert.equal(writes.some((line) => line.includes(`type=read:mime=${mime}:name=`) && line.includes(`;${mime}${STRING_TERMINATOR}`)), true);
  assert.equal(ptyWrites.length, 0);

  proc.stdin.emit('data', Buffer.from([
    `${OSC5522_PREFIX}type=read:status=OK${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:status=DATA:mime=${mime};${text.toString('base64')}${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:status=DONE${STRING_TERMINATOR}`
  ].join(''), 'latin1'));

  assert.deepEqual(ptyWrites, [text.toString('utf8')]);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime reports unsupported terminal 5522 paste event MIME and tries OSC52 fallback', () => {
  const mime = Buffer.from('image/heic', 'utf8').toString('base64');
  const { runtime, proc, ptyWrites, writes } = createRuntimeHarness({
    SSH_CONNECTION: '192.0.2.10 50000 192.0.2.20 22',
    SSH_TTY: `/dev/pts/paste-event-unsupported-mime-${process.pid}`
  }, {
    platform: 'linux'
  });

  runtime.runCliPtyTracked('claude', '1', [], false);
  proc.stdin.emit('data', Buffer.from([
    `${OSC5522_PREFIX}type=read:status=OK${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:status=DATA:mime=${mime}${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:status=DONE${STRING_TERMINATOR}`
  ].join(''), 'latin1'));

  assert.equal(ptyWrites.length, 0);
  assert.equal(writes.some((line) => line.includes('did not advertise a supported image MIME type: image/heic')), true);
  assert.equal(writes.some((line) => line.includes('Trying OSC 52 fallback')), true);
  assert.equal(writes.some((line) => line.includes(`${OSC52_PREFIX}c;?`)), true);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime wraps SSH terminal clipboard query when the outer runtime is inside tmux', () => {
  const { runtime, proc, ptyWrites, writes } = createRuntimeHarness({
    SSH_CONNECTION: '192.0.2.10 50000 192.0.2.20 22',
    SSH_TTY: `/dev/pts/tmux-terminal-clipboard-${process.pid}`,
    TMUX: '/tmp/tmux-501/default,1,0'
  }, {
    platform: 'linux'
  });

  runtime.runCliPtyTracked('claude', '1', [], false);
  assert.equal(writes.some((line) => line.includes(`\x1bPtmux;\x1b\x1b[?5522$p`)), true);
  assert.equal(writes.some((line) => line.includes(`\x1bPtmux;\x1b\x1b[?5522h`)), true);
  proc.stdin.emit('data', Buffer.from('\x1bv'));

  assert.equal(ptyWrites.length, 0);
  assert.equal(writes.some((line) => line.includes(`\x1bPtmux;\x1b\x1b]5522;type=read:id=aih-`)), true);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});

test('runtime falls back to SSH clip-agent only after explicit opt-in and terminal clipboard timeouts', async () => {
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
    let fetchCalls = 0;
    const image = {
      buffer: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('ssh-clip-agent-fallback')
      ]),
      mimeType: 'image/png'
    };
    const { runtime, proc, ptyWrites, writes } = createRuntimeHarness({
      SSH_CONNECTION: '192.0.2.10 50000 192.0.2.20 22',
      SSH_TTY: `/dev/pts/clip-agent-fallback-${process.pid}`,
      AIH_SSH_CLIP_AGENT: '1'
    }, {
      platform: 'linux',
      fetchSshClipAgentImage: async () => {
        fetchCalls += 1;
        return image;
      }
    });

    runtime.runCliPtyTracked('claude', '1', [], false);
    proc.stdin.emit('data', Buffer.from('\x1bv'));

    assert.equal(fetchCalls, 0);
    assert.equal(writes.some((line) => line.includes(`${OSC5522_PREFIX}type=read:id=aih-`) && line.includes(`;${Buffer.from('.').toString('base64')}`)), true);

    const mimeListTimer = timers.find((timer) => timer.ms === 900 && !timer.cleared);
    assert.ok(mimeListTimer);
    mimeListTimer.cb();
    mimeListTimer.cleared = true;
    assert.equal(fetchCalls, 0);

    const osc5522Timer = timers.find((timer) => timer.ms === 5000 && !timer.cleared);
    assert.ok(osc5522Timer);
    osc5522Timer.cb();
    osc5522Timer.cleared = true;
    assert.equal(fetchCalls, 0);
    assert.equal(writes.some((line) => line.includes(`${OSC52_PREFIX}c;?`)), true);

    const osc52Timer = timers.find((timer) => timer.ms === 5000 && !timer.cleared);
    assert.ok(osc52Timer);
    osc52Timer.cb();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(fetchCalls, 1);
    assert.equal(ptyWrites.length, 1);
    const injectedPath = String(ptyWrites[0]);
    assert.match(injectedPath, /aih_clip_\d+_[a-f0-9]{12}\.png$/);
    assert.deepEqual(fsBase.readFileSync(injectedPath), image.buffer);

    assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
  } finally {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
  }
});

test('runtime keeps strict zero-client default and does not probe clip-agent without opt-in', async () => {
  const sshTty = `/dev/pts/no-terminal-clipboard-${process.pid}`;
  let fetchCalls = 0;
  const { runtime, proc, ptyWrites, writes } = createRuntimeHarness({
    SSH_CONNECTION: '192.0.2.10 50000 192.0.2.20 22',
    SSH_TTY: sshTty,
    AIH_SSH_TERMINAL_CLIPBOARD: '0'
  }, {
    platform: 'linux',
    fetchSshClipAgentImage: async (options) => {
      fetchCalls += 1;
      options.onUnavailable({
        code: 'ssh_clip_agent_socket_missing',
        socketPath: '/tmp/aih-clip-model.sock'
      });
      return null;
    }
  });

  runtime.runCliPtyTracked('claude', '1', [], false);
  proc.stdin.emit('data', Buffer.from('\x1bv'));
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(ptyWrites.length, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(writes.some((line) => line.includes('Optional non-zero-client fallback is opt-in')), true);
  assert.equal(writes.some((line) => line.includes('clip-agent not connected at /tmp/aih-clip-model.sock')), false);
  assert.equal(writes.some((line) => line.includes('RemoteForward /tmp/aih-clip-model.sock 127.0.0.1:17652')), false);
  assert.equal(writes.some((line) => line.includes('strict zero-client mode')), true);
  assert.equal(writes.some((line) => line.includes('wrapper fallback')), false);

  assert.throws(() => proc.emit('SIGINT'), /EXIT:0/);
});
