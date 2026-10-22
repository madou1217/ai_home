const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

// AGENTS.md 的硬要求：这些入口的 `--help` 必须打印用法并以 0 退出。
// 事故背景：`aih backup --help` 从未接线，`backup` 落到 ai-cli 兜底路由后
// 被当成未知工具报错（exit 1）；其余入口此前已可用。这里用真实进程守住整组。
const HELP_ENTRIES = [
  ['claude', '--help'],
  ['claude', 'resume', '--help'],
  ['edge', '--help'],
  ['update', '--help'],
  ['usage', '--help'],
  ['server', '--help'],
  ['node', '--help'],
  ['fabric', '--help'],
  ['ssh', '--help'],
  ['plugin', '--help'],
  ['backup', '--help'],
  ['ls', '--help'],
  ['sessions', '--help']
];

const CLI_PATH = path.resolve(__dirname, '../bin/ai-home.js');

function runCli(argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...argv], {
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('every AGENTS-listed command prints usage for --help and exits 0', async () => {
  const results = await Promise.all(HELP_ENTRIES.map(async (argv) => ({
    argv,
    ...(await runCli(argv))
  })));

  for (const { argv, code, stdout, stderr } of results) {
    const label = `aih ${argv.join(' ')}`;
    const output = `${stdout}${stderr}`;
    assert.equal(code, 0, `${label} must exit 0 (got ${code})\n${output}`);
    assert.ok(output.trim().length > 0, `${label} must print usage text`);
    // 每个用法里都会出现产品名，用它挡掉「静默退出 0」这种假通过。
    assert.match(output, /aih/i, `${label} must print usage mentioning aih\n${output}`);
  }
});

test('aih backup without a subcommand prints usage and exits 0', async () => {
  const { code, stdout, stderr } = await runCli(['backup']);
  const output = `${stdout}${stderr}`;
  assert.equal(code, 0);
  assert.match(output, /AIH Backup/i);
});

test('aih backup with an unknown subcommand prints usage and exits 1', async () => {
  const { code, stdout, stderr } = await runCli(['backup', 'bogus']);
  const output = `${stdout}${stderr}`;
  assert.equal(code, 1);
  assert.match(output, /AIH Backup/i);
});
