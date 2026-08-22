'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MULTIPLEXER_TYPE,
  MULTIPLEXER_ENV,
  resolveConfiguredType,
  resolveMultiplexerDriver,
  resolveMultiplexerBinding,
  bindMultiplexerDriver,
  getDriver,
  TmuxDriver,
  HerdrDriver,
  buildHerdrInstallCommand
} = require('../lib/runtime/multiplexer');

test('resolveConfiguredType: parses explicit options and env', () => {
  assert.equal(resolveConfiguredType({ type: 'herdr' }), MULTIPLEXER_TYPE.HERDR);
  assert.equal(resolveConfiguredType({ type: 'TMUX' }), MULTIPLEXER_TYPE.TMUX);
  assert.equal(resolveConfiguredType({ env: { [MULTIPLEXER_ENV]: 'herdr' } }), MULTIPLEXER_TYPE.HERDR);
  assert.equal(resolveConfiguredType({ env: { [MULTIPLEXER_ENV]: 'tmux' } }), MULTIPLEXER_TYPE.TMUX);
  assert.equal(resolveConfiguredType({ env: {} }), MULTIPLEXER_TYPE.AUTO);
  assert.equal(resolveConfiguredType({ type: 'invalid' }), MULTIPLEXER_TYPE.AUTO);
});

test('getDriver: returns registered driver instances', () => {
  const tmux = getDriver('tmux');
  assert.ok(tmux instanceof TmuxDriver);
  assert.equal(tmux.name, 'tmux');

  const herdr = getDriver('herdr');
  assert.ok(herdr instanceof HerdrDriver);
  assert.equal(herdr.name, 'herdr');

  assert.equal(getDriver('unknown'), null);
});

test('resolveMultiplexerDriver: auto mode prefers herdr if available, otherwise falls back to tmux', () => {
  // Scenario 1: herdr is available
  const driverWithHerdr = resolveMultiplexerDriver({
    type: 'auto',
    spawnSync: (cmd) => {
      if (cmd === 'herdr') return { status: 0 };
      return { status: 1 };
    }
  });
  assert.equal(driverWithHerdr.name, 'herdr');

  // Scenario 2: herdr is not available -> fallback to tmux
  const driverWithTmuxFallback = resolveMultiplexerDriver({
    type: 'auto',
    spawnSync: (cmd) => {
      if (cmd === 'herdr') return { status: 1 };
      if (cmd === 'tmux') return { status: 0 };
      return { status: 1 };
    }
  });
  assert.equal(driverWithTmuxFallback.name, 'tmux');
});

test('resolveMultiplexerDriver: native-run spawnSyncImpl participates in driver detection', () => {
  const calls = [];
  const driver = resolveMultiplexerDriver({
    type: 'auto',
    spawnSyncImpl: (cmd, args) => {
      calls.push([cmd, args]);
      return { status: cmd === 'herdr' ? 0 : 1 };
    }
  });

  assert.equal(driver.name, 'herdr');
  assert.deepEqual(calls[0], ['herdr', ['--version']]);
});

test('resolveMultiplexerBinding: pins the detected backend and process dependency across lifecycle calls', () => {
  const calls = [];
  let detectionCount = 0;
  const spawnSyncImpl = (command, args) => {
    calls.push([command, args]);
    if (args[0] === '--version') {
      detectionCount += 1;
      return { status: command === 'herdr' && detectionCount === 1 ? 0 : 1 };
    }
    return { status: 0 };
  };
  const binding = resolveMultiplexerBinding({
    type: 'auto',
    spawnSyncImpl
  });

  assert.equal(binding.name, 'herdr');
  assert.equal(binding.driver.name, 'herdr');
  assert.equal(binding.available, true);
  assert.equal(binding.command, 'herdr');
  assert.equal(binding.spawnSync, spawnSyncImpl);

  assert.equal(binding.hasRun('test-socket'), true);
  binding.killRun('test-socket', {
    command: '/wrong/tmux',
    spawnSync: () => {
      throw new Error('per-call process dependency must not replace the binding');
    }
  });

  assert.equal(detectionCount, 1);
  assert.deepEqual(calls.map(([command]) => command), ['herdr', 'herdr', 'herdr']);
  assert.deepEqual(calls[1][1], ['status', '--session', 'test-socket-run']);
  assert.deepEqual(calls[2][1], ['kill', '--session', 'test-socket-run']);
});

test('resolveMultiplexerBinding: executes lifecycle calls through the detected absolute command', () => {
  const calls = [];
  const binding = resolveMultiplexerBinding({
    type: 'herdr',
    strict: true,
    resolveCommandPath: (command) => command === 'herdr' ? '/opt/herdr/bin/herdr' : '',
    spawnSyncImpl: (command, args) => {
      calls.push([command, args]);
      return { status: 0 };
    }
  });

  const result = binding.spawnHeadlessRun({
    socket: 'absolute-command',
    shellCommand: 'echo ready'
  });

  assert.equal(binding.command, '/opt/herdr/bin/herdr');
  assert.equal(result.ok, true);
  assert.equal(calls[0][0], '/opt/herdr/bin/herdr');
});

test('bindMultiplexerDriver: binds a supplied detection without probing again', () => {
  const calls = [];
  const driver = new HerdrDriver();
  const spawnSyncImpl = (command, args) => {
    calls.push([command, args]);
    return { status: 0 };
  };
  const binding = bindMultiplexerDriver(driver, {
    available: true,
    reason: 'ok',
    command: '/custom/herdr',
    viaShell: false
  }, { spawnSyncImpl });

  assert.equal(binding.hasRun('bound-run'), true);
  assert.deepEqual(calls, [[
    '/custom/herdr',
    ['status', '--session', 'bound-run-run']
  ]]);
});

test('resolveMultiplexerDriver: explicit herdr selection falls back gracefully when missing unless strict', () => {
  const driver = resolveMultiplexerDriver({
    type: 'herdr',
    strict: false,
    spawnSync: (cmd) => {
      if (cmd === 'herdr') return { status: 1 };
      if (cmd === 'tmux') return { status: 0 };
      return { status: 1 };
    }
  });
  assert.equal(driver.name, 'tmux');

  const strictDriver = resolveMultiplexerDriver({
    type: 'herdr',
    strict: true,
    spawnSync: () => ({ status: 1 })
  });
  assert.equal(strictDriver.name, 'herdr');
});

test('buildHerdrInstallCommand: constructs platform-specific installation plan', () => {
  const macBrew = buildHerdrInstallCommand({ platform: 'darwin', hasBrew: true });
  assert.equal(macBrew.command, 'brew');
  assert.deepEqual(macBrew.args, ['install', 'herdr']);

  const macCurl = buildHerdrInstallCommand({ platform: 'darwin', hasBrew: false });
  assert.equal(macCurl.command, 'sh');
  assert.match(macCurl.args[1], /install\.sh/);

  const linux = buildHerdrInstallCommand({ platform: 'linux' });
  assert.equal(linux.command, 'sh');
  assert.match(linux.args[1], /install\.sh/);

  const win = buildHerdrInstallCommand({ platform: 'win32' });
  assert.equal(win.command, 'powershell');
  assert.match(win.args[4], /install\.ps1/);
});

test('HerdrDriver: install executes plan and refreshes detection status', () => {
  const driver = new HerdrDriver();
  let installed = false;
  const mockSpawn = (cmd, args) => {
    if (cmd === 'brew' && args[0] === 'install') {
      installed = true;
      return { status: 0 };
    }
    if (cmd === 'herdr' && args[0] === '--version') {
      return installed ? { status: 0 } : { status: 1 };
    }
    return { status: 1 };
  };

  const result = driver.install({
    platform: 'darwin',
    hasBrew: true,
    spawnSync: mockSpawn
  });

  assert.equal(result.ok, true);
  assert.equal(result.command, 'herdr');
});

test('HerdrDriver: detect identifies availability and returns install hint when missing', () => {
  const driver = new HerdrDriver();

  const available = driver.detect({
    spawnSync: (cmd) => ({ status: cmd === 'herdr' ? 0 : 1 })
  });
  assert.equal(available.available, true);
  assert.equal(available.command, 'herdr');

  const missing = driver.detect({
    spawnSync: () => ({ status: 1 })
  });
  assert.equal(missing.available, false);
  assert.match(missing.installHint, /install/);
});

test('HerdrDriver: buildLaunchArgs formats interactive and detached commands correctly', () => {
  const driver = new HerdrDriver();

  // Create new session
  const create = driver.buildLaunchArgs({
    session: 'my-session',
    cwd: '/projects/demo',
    inner: { command: 'claude', args: ['--model', 'sonnet'] }
  });
  assert.equal(create.command, 'herdr');
  assert.deepEqual(create.args, [
    'spawn', '--session', 'my-session', '--cwd', '/projects/demo', '--', 'claude', '--model', 'sonnet'
  ]);

  // Detached session
  const detached = driver.buildLaunchArgs({
    session: 'bg-session',
    detached: true,
    inner: { command: 'codex', args: [] }
  });
  assert.equal(detached.detached, true);
  assert.deepEqual(detached.args, [
    'spawn', '--detached', '--session', 'bg-session', '--', 'codex'
  ]);

  // Attach existing
  const attach = driver.buildLaunchArgs({
    session: 'my-session',
    attachExisting: true
  });
  assert.deepEqual(attach.args, ['attach', '--session', 'my-session']);
});

test('HerdrDriver: headless run lifecycle (spawn, has, kill, send)', () => {
  const driver = new HerdrDriver();
  const spawnCalls = [];
  const mockSpawn = (cmd, args) => {
    spawnCalls.push({ cmd, args });
    return { status: 0 };
  };

  // Spawn
  const spawned = driver.spawnHeadlessRun({
    socket: 'test-socket',
    shellCommand: 'echo hello',
    cwd: '/tmp',
    spawnSync: mockSpawn
  });
  assert.equal(spawned.ok, true);
  assert.equal(spawnCalls[0].cmd, 'herdr');
  assert.deepEqual(spawnCalls[0].args, [
    'spawn', '--detached', '--session', 'test-socket-run', '--cwd', '/tmp', '--', 'sh', '-c', 'echo hello'
  ]);

  // Has run
  const has = driver.hasRun('test-socket', { spawnSync: mockSpawn });
  assert.equal(has, true);
  assert.deepEqual(spawnCalls[1].args, ['status', '--session', 'test-socket-run']);

  // Send input
  const sent = driver.sendInput('test-socket', 'y', { spawnSync: mockSpawn });
  assert.equal(sent, true);
  assert.deepEqual(spawnCalls[2].args, ['send', '--session', 'test-socket-run', '--', 'y', '\n']);

  // Kill
  driver.killRun('test-socket', { spawnSync: mockSpawn });
  assert.deepEqual(spawnCalls[3].args, ['kill', '--session', 'test-socket-run']);
});

test('TmuxDriver: headless lifecycle uses the canonical command and spawnSync options', () => {
  const driver = new TmuxDriver();
  const calls = [];
  const mockSpawn = (command, args) => {
    calls.push([command, args]);
    return { status: 0 };
  };
  const lifecycleOptions = {
    command: '/opt/tmux/bin/tmux',
    spawnSync: mockSpawn,
    useSystemdScope: false
  };

  const spawned = driver.spawnHeadlessRun({
    ...lifecycleOptions,
    socket: 'tmux-socket',
    shellCommand: 'echo hello',
    cwd: '/tmp'
  });
  assert.equal(spawned.ok, true);
  assert.deepEqual(calls[0], [
    '/opt/tmux/bin/tmux',
    ['-L', 'tmux-socket', 'new-session', '-d', '-s', 'run', '-c', '/tmp', '--', 'sh', '-c', 'echo hello']
  ]);

  assert.equal(driver.hasRun('tmux-socket', lifecycleOptions), true);
  assert.deepEqual(calls[1], [
    '/opt/tmux/bin/tmux',
    ['-L', 'tmux-socket', 'has-session', '-t', 'run']
  ]);

  assert.equal(driver.sendInput('tmux-socket', 'y', lifecycleOptions), true);
  assert.deepEqual(calls[2], [
    '/opt/tmux/bin/tmux',
    ['-L', 'tmux-socket', 'send-keys', '-t', 'run', '-l', '--', 'y']
  ]);
  assert.deepEqual(calls[3], [
    '/opt/tmux/bin/tmux',
    ['-L', 'tmux-socket', 'send-keys', '-t', 'run', 'Enter']
  ]);

  driver.killRun('tmux-socket', lifecycleOptions);
  assert.deepEqual(calls[4], [
    '/opt/tmux/bin/tmux',
    ['-L', 'tmux-socket', 'kill-server']
  ]);
});

test('TmuxDriver: injected systemd probes are scoped to their binding dependency', () => {
  const driver = new TmuxDriver();
  const options = {
    platform: 'linux',
    env: { XDG_RUNTIME_DIR: '/run/user/1000' }
  };

  assert.equal(driver.isSystemdScopeSupported({
    ...options,
    spawnSync: () => ({ status: 0 })
  }), true);
  assert.equal(driver.isSystemdScopeSupported({
    ...options,
    spawnSync: () => ({ status: 1 })
  }), false);
});
