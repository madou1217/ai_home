const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fsBase = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPtyRuntime } = require('../lib/cli/services/pty/runtime');

function createMockProcess(env = {}, platform = 'linux') {
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
  proc.argv = [process.execPath, '/tmp/ai-home.js'];
  proc.stdout = stdout;
  proc.stdin = stdin;
  proc.cwd = () => '/tmp';
  proc.exit = (code) => {
    throw new Error(`EXIT:${code}`);
  };

  return { proc, rawModeCalls, writes };
}

function createRuntimeHarness(env = {}, overrides = {}) {
  const { proc, rawModeCalls, writes } = createMockProcess(env, overrides.platform || 'linux');
  proc.pid = Number(overrides.pid || 10001);
  const lockRoot = fsBase.mkdtempSync(path.join(os.tmpdir(), 'aih-pty-lock-'));
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
        onData(cb) { this._onData = cb; },
        onExit(cb) { this._onExit = cb; },
        write(chunk) { ptyWrites.push(chunk); },
        resize() {},
        kill() {}
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
    mkdirSync: fsBase.mkdirSync.bind(fsBase),
    openSync: fsBase.openSync.bind(fsBase),
    writeFileSync: fsBase.writeFileSync.bind(fsBase),
    closeSync: fsBase.closeSync.bind(fsBase),
    unlinkSync: fsBase.unlinkSync.bind(fsBase)
  };
  Object.assign(fsImpl, overrides.fs || {});

  const runtime = createPtyRuntime({
    path: require('node:path'),
    fs: fsImpl,
    processObj: proc,
    pty,
    spawn: spawnImpl,
    execSync: overrides.execSync || (() => {}),
    resolveCliPath: () => '/usr/bin/codex',
    buildPtyLaunch: (command, args) => ({ command, args }),
    resolveWindowsBatchLaunch: (_cliName, cliBin) => ({ launchBin: cliBin, envPatch: {} }),
    readUsageConfig: () => ({}),
    cliConfigs: { codex: { pkg: '@openai/codex', loginArgs: ['login'] } },
    aiHomeDir: overrides.aiHomeDir || lockRoot,
    getProfileDir: () => '/tmp/.ai_home/profiles/codex/10086',
    askYesNo: () => false,
    stripAnsi: (s) => s,
    ensureSessionStoreLinks: () => ({ migrated: 0, linked: 0 }),
    ensureUsageSnapshot: () => null,
    ensureUsageSnapshotAsync: overrides.ensureUsageSnapshotAsync || (async () => null),
    readUsageCache: overrides.readUsageCache || (() => null),
    getUsageRemainingPercentValues: overrides.getUsageRemainingPercentValues || (() => []),
    getNextAvailableId: () => null,
    markActiveAccount: () => {},
    ensureAccountUsageRefreshScheduler: () => { schedulerCalls += 1; },
    refreshIndexedStateForAccount: () => {}
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
    aiHomeDir: overrides.aiHomeDir || lockRoot
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

  assert.equal(writes.some((line) => line.includes('\x1b[s\x1b[999;1H\x1b[2K')), true);
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
