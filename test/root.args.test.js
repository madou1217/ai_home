const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRootCommandArgs } = require('../lib/cli/commands/root/args');

test('normalizeRootCommandArgs maps `serve` to `server start` by default', () => {
  const out = normalizeRootCommandArgs(['serve', '--port', '8317']);
  assert.equal(out.cmd, 'server');
  assert.deepEqual(out.args, ['server', 'start', '--port', '8317']);
});

test('normalizeRootCommandArgs maps `serve help` to `server help`', () => {
  const out = normalizeRootCommandArgs(['serve', 'help']);
  assert.equal(out.cmd, 'server');
  assert.deepEqual(out.args, ['server', 'help']);
});

test('normalizeRootCommandArgs keeps non-serve commands unchanged', () => {
  const out = normalizeRootCommandArgs(['codex', '10086']);
  assert.equal(out.cmd, 'codex');
  assert.deepEqual(out.args, ['codex', '10086']);
});
