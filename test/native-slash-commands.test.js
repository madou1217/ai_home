const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const {
  getProviderSlashCommands,
  validateNativeSlashCommand,
  clearNativeSlashCommandCache
} = require('../lib/server/native-slash-commands');

test('claude slash registry scans non-interactive command blocks and skips interactive variants', (t) => {
  const commandsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-slash-'));
  t.after(() => {
    fs.rmSync(commandsDir, { recursive: true, force: true });
    delete process.env.AIH_CLAUDE_CODE_COMMANDS_DIR;
    clearNativeSlashCommandCache();
  });

  fs.mkdirSync(path.join(commandsDir, 'context'), { recursive: true });
  fs.writeFileSync(
    path.join(commandsDir, 'context', 'index.ts'),
    [
      'export const context = {',
      "  type: 'local-jsx',",
      "  name: 'context',",
      "  description: 'interactive grid',",
      '};',
      'export const contextNonInteractive = {',
      "  type: 'local',",
      "  name: 'context',",
      "  description: 'show current context usage',",
      '  supportsNonInteractive: true,',
      "  argumentHint: '<mode>',",
      '};'
    ].join('\n')
  );

  fs.mkdirSync(path.join(commandsDir, 'compact'), { recursive: true });
  fs.writeFileSync(
    path.join(commandsDir, 'compact', 'index.ts'),
    [
      'const compact = {',
      "  type: 'local',",
      "  name: 'compact',",
      "  description: 'compact context',",
      '  supportsNonInteractive: true,',
      "  aliases: ['cmp'],",
      '};'
    ].join('\n')
  );

  process.env.AIH_CLAUDE_CODE_COMMANDS_DIR = commandsDir;
  clearNativeSlashCommandCache();

  const commands = getProviderSlashCommands('claude');
  assert.deepEqual(
    commands.map((item) => item.command),
    ['/compact', '/context']
  );
  assert.equal(commands.find((item) => item.command === '/context').description, 'show current context usage');
  assert.deepEqual(commands.find((item) => item.command === '/compact').aliases, ['/cmp']);
});

test('validateNativeSlashCommand resolves aliases and rejects unsupported commands', () => {
  const resolved = validateNativeSlashCommand('gemini', '/dir add /tmp');
  assert.equal(resolved.isSlashCommand, true);
  assert.equal(resolved.matched.command, '/directory');

  assert.throws(
    () => validateNativeSlashCommand('codex', '/compact'),
    (error) => error && error.code === 'native_slash_command_unsupported'
  );
});

test('validateNativeSlashCommand rejects embedded slash command mixed with normal text', () => {
  assert.throws(
    () => validateNativeSlashCommand('gemini', '你好呀 /stats'),
    (error) => error && error.code === 'native_slash_command_must_be_standalone'
  );
});
