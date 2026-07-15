const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRootCommandArgs } = require('../lib/cli/commands/root/args');

test('normalizeRootCommandArgs maps bare `serve` to daemon start', () => {
  const out = normalizeRootCommandArgs(['serve']);
  assert.equal(out.cmd, 'server');
  assert.deepEqual(out.args, ['server', 'start']);
});

test('normalizeRootCommandArgs maps `serve` options to foreground server serve', () => {
  const out = normalizeRootCommandArgs(['serve', '--port', '8317']);
  assert.equal(out.cmd, 'server');
  assert.deepEqual(out.args, ['server', 'serve', '--port', '8317']);
});

test('normalizeRootCommandArgs maps `serve help` to `server help`', () => {
  const out = normalizeRootCommandArgs(['serve', 'help']);
  assert.equal(out.cmd, 'server');
  assert.deepEqual(out.args, ['server', 'help']);
});

test('normalizeRootCommandArgs maps daemon alias to server command', () => {
  const out = normalizeRootCommandArgs(['daemon', 'autostart', 'status']);
  assert.equal(out.cmd, 'server');
  assert.deepEqual(out.args, ['server', 'autostart', 'status']);
});

test('normalizeRootCommandArgs keeps removed `provider` alias unchanged', () => {
  assert.deepEqual(normalizeRootCommandArgs(['provider']), {
    cmd: 'provider',
    args: ['provider']
  });
  assert.deepEqual(normalizeRootCommandArgs(['provider', 'status']), {
    cmd: 'provider',
    args: ['provider', 'status']
  });
});

test('normalizeRootCommandArgs keeps non-serve commands unchanged', () => {
  const out = normalizeRootCommandArgs(['codex', '10086']);
  assert.equal(out.cmd, 'codex');
  assert.deepEqual(out.args, ['codex', '10086']);
});
