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

// 未知输入不再报错退出，而是「提示行 + 该层级的用法」并以 0 退出（与 `--help` 同形），
// 让用户一眼看到有哪些入口，而不是先猜一句报错是什么意思。
const UNKNOWN_ENTRIES = [
  { argv: ['backup', 'bogus'], notice: /未识别的子命令 'bogus'/, usage: /AIH Backup/i },
  { argv: ['edge', 'bogus'], notice: /未识别的用法 'bogus'/, usage: /aih edge status/ },
  { argv: ['edge', 'remove', 'nginx'], notice: /未识别的用法 'remove nginx'/, usage: /aih edge status/ },
  { argv: ['node', 'bogus'], notice: /未识别的用法 'bogus'/, usage: /AI Home Node/ },
  { argv: ['node', 'relay', 'bogus'], notice: /未识别的用法 'relay bogus'/, usage: /AI Home Node/ },
  { argv: ['fabric', 'bogus'], notice: /未识别的用法 'bogus'/, usage: /AIH Fabric/i },
  { argv: ['plugin', 'bogus'], notice: /未识别的子命令 'bogus'/, usage: /Usage: aih plugin/ },
  { argv: ['update', 'bogus'], notice: /未识别的参数 'bogus'/, usage: /AIH Update/i }
];

test('an unknown subcommand prints a notice plus that level\'s usage and exits 0', async () => {
  const results = await Promise.all(UNKNOWN_ENTRIES.map(async (entry) => ({
    entry,
    ...(await runCli(entry.argv))
  })));

  for (const { entry, code, stdout, stderr } of results) {
    const label = `aih ${entry.argv.join(' ')}`;
    const output = `${stdout}${stderr}`;
    assert.equal(code, 0, `${label} must exit 0\n${output}`);
    assert.match(output, entry.notice, `${label} must name the rejected token\n${output}`);
    assert.match(output, entry.usage, `${label} must print its own usage\n${output}`);
  }
});

test('aih edge without an action still fails with usage (exit 1) — only unknown usage exits 0', async () => {
  const { code, stdout, stderr } = await runCli(['edge']);
  const output = `${stdout}${stderr}`;
  assert.equal(code, 1);
  assert.match(output, /aih edge status/);
});

test('an unknown root command prints a notice plus the root help and exits 0', async () => {
  for (const argv of [['foo'], ['123'], ['99999999']]) {
    const { code, stdout, stderr } = await runCli(argv);
    const output = `${stdout}${stderr}`;
    assert.equal(code, 0, `aih ${argv.join(' ')} must exit 0\n${output}`);
    assert.match(output, new RegExp(`未识别的命令 '${argv[0]}'`), `aih ${argv.join(' ')} must name the rejected token`);
    // 根帮助的特征行，证明展示的是根用法而不是空输出
    assert.match(output, /AI Home \(aih\)/);
    assert.match(output, /Multi-account sandbox manager/);
    assert.match(output, /aih server \[action\]/);
  }
});
