'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAihInvocation,
  resolveAihEntryFile,
  resolveAihExecutable
} = require('../lib/runtime/aih-executable');

test('resolveAihExecutable prefers the packaged launcher over the JS entry', () => {
  assert.equal(resolveAihExecutable({ env: { AIH_EXECUTABLE: '/opt/aih/aih' } }), '/opt/aih/aih');
  assert.equal(resolveAihExecutable({ env: { AIH_CLI_PATH: '/usr/local/bin/aih' } }), '/usr/local/bin/aih');
  assert.equal(resolveAihExecutable({ env: {} }), '');
});

test('buildAihInvocation runs the launcher directly in a packaged install', () => {
  const invocation = buildAihInvocation(['claude', '1'], {
    env: { AIH_EXECUTABLE: '/opt/aih/aih' },
    processObj: { execPath: '/opt/aih/runtime/bin/node', argv: ['node', '/opt/aih/bin/ai-home.js'] }
  });
  assert.deepEqual(invocation, {
    command: '/opt/aih/aih',
    args: ['claude', '1'],
    packaged: true
  });
});

test('buildAihInvocation keeps the node + entry contract for source installs', () => {
  const invocation = buildAihInvocation(['codex', '2'], {
    env: {},
    processObj: { execPath: '/usr/bin/node', argv: ['node', '/srv/ai_home/bin/ai-home.js'] }
  });
  assert.deepEqual(invocation, {
    command: '/usr/bin/node',
    args: ['/srv/ai_home/bin/ai-home.js', 'codex', '2'],
    packaged: false
  });
});

test('resolveAihEntryFile falls back to the repository entry', () => {
  const entry = resolveAihEntryFile({ processObj: { argv: [] } });
  assert.match(entry, /bin[\\/]ai-home\.js$/);
});

test('resolveAihBinPath uses the packaged launcher before argv[1]', () => {
  const { resolveAihBinPath } = require('../lib/cli/commands/shell-router');
  const resolved = resolveAihBinPath({
    env: { AIH_EXECUTABLE: '/opt/aih/aih' },
    processObj: { argv: ['node', '/opt/aih/bin/ai-home.js'] }
  });
  assert.equal(resolved, '/opt/aih/aih');
});
