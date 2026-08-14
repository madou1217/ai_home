'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MULTIPLEXER_TYPE,
  MULTIPLEXER_ENV,
  resolveConfiguredType,
  resolveMultiplexerDriver,
  getDriver,
  TmuxDriver,
  HerdrDriver
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
  assert.match(missing.installHint, /install\.sh/);
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
    spawnSyncImpl: mockSpawn
  });
  assert.equal(spawned.ok, true);
  assert.equal(spawnCalls[0].cmd, 'herdr');
  assert.deepEqual(spawnCalls[0].args, [
    'spawn', '--detached', '--session', 'test-socket-run', '--cwd', '/tmp', '--', 'sh', '-c', 'echo hello'
  ]);

  // Has run
  const has = driver.hasRun('test-socket', { spawnSyncImpl: mockSpawn });
  assert.equal(has, true);
  assert.deepEqual(spawnCalls[1].args, ['status', '--session', 'test-socket-run']);

  // Send input
  const sent = driver.sendInput('test-socket', 'y', { spawnSyncImpl: mockSpawn });
  assert.equal(sent, true);
  assert.deepEqual(spawnCalls[2].args, ['send', '--session', 'test-socket-run', '--', 'y', '\n']);

  // Kill
  driver.killRun('test-socket', { spawnSyncImpl: mockSpawn });
  assert.deepEqual(spawnCalls[3].args, ['kill', '--session', 'test-socket-run']);
});
