'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isSlashPassthroughProvider,
  validateNativeSlashCommand
} = require('../lib/server/native-slash-commands');
const { refreshSlashCapabilities } = require('../lib/server/chat-runtime/session-capabilities');

test('native CLI providers advertise slash passthrough independently of the catalog', () => {
  assert.equal(isSlashPassthroughProvider('codex'), true);
  assert.equal(isSlashPassthroughProvider('unknown-provider'), false);
  const result = validateNativeSlashCommand('codex', '/plugin-command arg');
  assert.equal(result.isSlashCommand, true);
  assert.equal(result.matched.source, 'cli-passthrough');
});

test('capability refresh keeps native catalog entries and marks Chat slash as closed', () => {
  const native = refreshSlashCapabilities({
    provider: 'codex',
    policy: { workspaceMode: 'work' },
    capabilitySnapshot: { slashCommands: ['custom'] }
  });
  assert.deepEqual(native.slashCommands, ['custom', 'agent', 'app', 'approve', 'archive', 'clear', 'compact', 'copy', 'delete', 'diff', 'exit', 'experimental', 'fast', 'feedback', 'fork', 'goal', 'hooks', 'ide', 'import', 'init', 'keymap', 'logout', 'mcp', 'memories', 'mention', 'model', 'new', 'permissions', 'personality', 'pets', 'plan', 'plugins', 'ps', 'raw', 'rename', 'resume', 'review', 'side', 'skills', 'status', 'statusline', 'stop', 'theme', 'title', 'usage', 'vim']);
  assert.equal(native.slashPassthrough, undefined);
  const chat = refreshSlashCapabilities({
    provider: 'codex',
    policy: { workspaceMode: 'chat' },
    capabilitySnapshot: {}
  });
  assert.deepEqual(chat.slashCommands, ['compact', 'goal', 'plan']);
  assert.equal(chat.slashPassthrough, false);
});
