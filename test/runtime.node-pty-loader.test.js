const test = require('node:test');
const assert = require('node:assert/strict');
const { assertPtySpawnUsable, loadNodePty } = require('../lib/runtime/node-pty-loader');

test('assertPtySpawnUsable rejects modules without spawn', () => {
  assert.throws(() => assertPtySpawnUsable({}, { selfTest: false }), /node_pty_spawn_unavailable/);
});

test('loadNodePty falls back when primary spawn is broken', () => {
  const fallback = {
    spawn() {
      return { kill() {} };
    }
  };
  const primary = {
    spawn() {
      throw new Error('posix_spawnp failed.');
    }
  };
  const loaded = loadNodePty({
    forceReload: true,
    requireImpl(name) {
      if (name === 'node-pty') return primary;
      if (name === '@lydell/node-pty') return fallback;
      throw new Error(`unexpected package ${name}`);
    }
  });
  assert.equal(loaded, fallback);
});

test('node-pty self test uses ConPTY DLL on Windows', () => {
  const calls = [];
  const ptyModule = {
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { kill() {} };
    }
  };

  assertPtySpawnUsable(ptyModule, {
    processObj: {
      platform: 'win32',
      execPath: 'C:\\Node\\node.exe',
      env: {},
      cwd: () => 'C:\\repo'
    }
  });

  assert.equal(calls[0].options.useConptyDll, true);
});
