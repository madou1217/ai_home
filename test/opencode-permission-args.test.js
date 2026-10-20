'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  placeOpenCodePermissionArgs
} = require('../lib/runtime/opencode-permission-args');

test('opencode permission flag leads the root TUI command', () => {
  assert.deepEqual(placeOpenCodePermissionArgs([], ['--auto']), ['--auto']);
  assert.deepEqual(
    placeOpenCodePermissionArgs(['--model', 'gpt-5'], ['--auto']),
    ['--auto', '--model', 'gpt-5']
  );
  assert.deepEqual(
    placeOpenCodePermissionArgs(['--continue'], ['--auto']),
    ['--auto', '--continue']
  );
});

test('opencode permission flag follows the run subcommand only', () => {
  assert.deepEqual(
    placeOpenCodePermissionArgs(['run', '--format', 'json', 'prompt'], ['--auto']),
    ['run', '--auto', '--format', 'json', 'prompt']
  );
});

test('opencode permission flag is never injected into management subcommands', () => {
  for (const argv of [
    ['serve'],
    ['models'],
    ['session', 'list'],
    ['mcp', 'list'],
    ['auth', 'login']
  ]) {
    assert.deepEqual(placeOpenCodePermissionArgs(argv, ['--auto']), argv);
  }
});

test('opencode permission placement is a no-op without derived flags', () => {
  assert.deepEqual(placeOpenCodePermissionArgs(['run', 'prompt'], []), ['run', 'prompt']);
});
