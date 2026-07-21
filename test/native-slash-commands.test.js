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

test('claude slash registry merges builtin list with user .md commands', (t) => {
  const commandsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-slash-'));
  t.after(() => {
    fs.rmSync(commandsDir, { recursive: true, force: true });
    delete process.env.AIH_CLAUDE_CODE_COMMANDS_DIR;
    clearNativeSlashCommandCache();
  });

  // 新契约：不再解析 claude 源码(.ts)，清单 = 精选内置静态清单 + <commandsDir>/**/*.md 用户命令。
  fs.writeFileSync(path.join(commandsDir, 'deploy.md'), '# deploy');
  fs.mkdirSync(path.join(commandsDir, 'infra'), { recursive: true });
  fs.writeFileSync(path.join(commandsDir, 'infra', 'restart.md'), '# restart');

  process.env.AIH_CLAUDE_CODE_COMMANDS_DIR = commandsDir;
  clearNativeSlashCommandCache();

  const commands = getProviderSlashCommands('claude');
  const ids = commands.map((item) => item.command);
  // 内置命令在列
  assert.ok(ids.includes('/clear'));
  assert.ok(ids.includes('/help'));
  assert.ok(ids.includes('/compact'));
  // 用户 .md 命令在列（子目录带 namespace 前缀）
  assert.ok(ids.includes('/deploy'));
  assert.ok(ids.includes('/infra:restart'));
  assert.equal(commands.find((item) => item.command === '/deploy').source, 'claude-user');
});

test('validateNativeSlashCommand resolves aliases and passes unknown commands through to the CLI', () => {
  const resolved = validateNativeSlashCommand('gemini', '/dir add /tmp');
  assert.equal(resolved.isSlashCommand, true);
  assert.equal(resolved.matched.command, '/directory');

  // codex /compact 现为内置清单成员
  const codexCompact = validateNativeSlashCommand('codex', '/compact');
  assert.equal(codexCompact.isSlashCommand, true);
  assert.equal(codexCompact.matched.command, '/compact');

  // 新契约：未知命令不再硬拒，透传交给真实 CLI（清单只用于 autocomplete）。
  const passthrough = validateNativeSlashCommand('codex', '/definitely-not-a-real-command');
  assert.equal(passthrough.isSlashCommand, true);
  assert.equal(passthrough.matched.source, 'cli-passthrough');
});

test('五个 provider 的 autocomplete 清单齐备(实测校验的 catalog)', () => {
  const expectations = [
    // [provider, 最少条数, 必含命令样本]
    ['claude', 70, ['/clear', '/plan', '/permissions', '/hooks', '/rewind', '/usage']],
    ['codex', 40, ['/plan', '/permissions', '/hooks', '/review', '/fork', '/vim']],
    ['opencode', 18, ['/share', '/undo', '/models', '/compact', '/export']],
    ['agy', 28, ['/planning', '/permissions', '/artifact', '/hooks', '/tasks']],
    ['gemini', 10, ['/chat', '/memory']]
  ];
  for (const [provider, minCount, samples] of expectations) {
    const commands = getProviderSlashCommands(provider);
    const ids = commands.map((item) => item.command);
    assert.ok(commands.length >= minCount, `${provider} 清单至少 ${minCount} 条(实际 ${commands.length})`);
    for (const sample of samples) {
      assert.ok(ids.includes(sample), `${provider} 清单应含 ${sample}`);
    }
    // 无重复、描述非空
    assert.equal(new Set(ids).size, ids.length, `${provider} 清单无重复`);
    assert.ok(commands.every((item) => item.description), `${provider} 每条都有描述`);
  }
});

test('新增清单的别名解析生效(codex /approvals→/permissions,opencode /q→/exit)', () => {
  const codexApprovals = validateNativeSlashCommand('codex', '/approvals');
  assert.equal(codexApprovals.matched.command, '/permissions');
  const opencodeQ = validateNativeSlashCommand('opencode', '/q');
  assert.equal(opencodeQ.matched.command, '/exit');
  const claudeTp = validateNativeSlashCommand('claude', '/tp');
  assert.equal(claudeTp.matched.command, '/teleport');
});

test('validateNativeSlashCommand rejects embedded slash command mixed with normal text', () => {
  assert.throws(
    () => validateNativeSlashCommand('gemini', '你好呀 /stats'),
    (error) => error && error.code === 'native_slash_command_must_be_standalone'
  );
});
