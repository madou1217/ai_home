'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

test('正式入口保持 Node，Go 账号链只通过显式 preview 脚本进入', () => {
  const packageJson = JSON.parse(read('package.json'));
  const executable = read('bin/ai-home.js');
  const postinstall = read('scripts/postinstall.js');

  assert.match(executable, /require\('\.\.\/lib\/cli\/app'\)/);
  assert.doesNotMatch(executable, /go-cli-sidecar|dispatchGoCLI/);
  assert.doesNotMatch(postinstall, /build-go-sidecar|ensureHostGoCLISidecar/);
  assert.equal(packageJson.scripts['go-cli:preview'], 'node scripts/go-accounts-preview.js cli');
  assert.equal(packageJson.scripts['go-preview:server'], 'node scripts/go-accounts-preview.js server');
  assert.equal(packageJson.scripts['go-preview:web'], 'node scripts/go-accounts-preview.js web');
  assert.equal(packageJson.scripts['go-preview:help'], 'node scripts/go-accounts-preview.js help');
  assert.equal(packageJson.scripts['go-cli:build:release'], undefined);
  assert.equal(packageJson.scripts.prepack, undefined);
  assert.equal(packageJson.files, undefined);
});

test('正式 Node help 不宣传尚未切换的 Go account 命令', () => {
  const { createCliHelpService } = require('../lib/cli/commands/help/messages');
  const logs = [];
  const help = createCliHelpService({ log: (value) => logs.push(String(value)) });

  help.showHelp();
  help.showCliUsage('codex');

  const output = logs.join('\n');
  assert.match(output, /^  aih ls\s/m);
  assert.match(output, /^  aih codex login/m);
  assert.doesNotMatch(output, /^  aih account(?:\s|$)/m);
  assert.doesNotMatch(output, /List accounts from the Go Server/);
});

test('默认账号页继续使用 Node API，Go 页面仅由 preview 环境选择', () => {
  const routes = read('web/config/routes.ts');
  const nodeAccounts = read('web/src/pages/Accounts.tsx');
  const previewAccountsPath = path.join(
    repositoryRoot,
    'web/src/pages/AccountsGoPreview.tsx',
  );

  assert.match(routes, /AIH_GO_ACCOUNTS_PREVIEW/);
  assert.match(routes, /component:\s*["']\.\/AccountsGoPreview["']/);
  assert.match(routes, /component:\s*["']\.\/Accounts["']/);
  assert.match(nodeAccounts, /from ['"]@\/services\/api['"]/);
  assert.equal(fs.existsSync(previewAccountsPath), true);
  assert.match(
    fs.readFileSync(previewAccountsPath, 'utf8'),
    /from ['"]@\/services\/account-management\/preview['"]/,
  );
  const previewClientPath = path.join(
    repositoryRoot,
    'web/src/services/account-management/preview.ts',
  );
  assert.equal(fs.existsSync(previewClientPath), true);
  const previewClient = fs.readFileSync(previewClientPath, 'utf8');
  assert.match(previewClient, /window\.location\.origin/);
  assert.doesNotMatch(previewClient, /active-client|control-plane-selection/);
});

test('preview 使用固定独立端口且不复用正式 AIH_HOME', () => {
  const launcherPath = path.join(repositoryRoot, 'scripts/go-accounts-preview.js');
  assert.equal(fs.existsSync(launcherPath), true);
  const launcher = read('scripts/go-accounts-preview.js');

  assert.match(launcher, /19527/);
  assert.match(launcher, /19528/);
  assert.doesNotMatch(launcher, /\b9527\b|\b3001\b/);
  assert.match(launcher, /AIH_HOME/);
  assert.match(launcher, /tmpdir/);
});

test('preview 启动器分别生成隔离的 Server、Web 与 CLI 调用', () => {
  const {
    PREVIEW_SERVER_PORT,
    PREVIEW_WEB_PORT,
    createPreviewInvocation,
  } = require('../scripts/go-accounts-preview');
  const dependencies = {
    env: {
      AIH_HOME: '/Users/example/.ai_home',
      PATH: '/usr/bin',
    },
    platform: 'darwin',
    repositoryRoot: '/workspace/ai_home',
    temporaryRoot: '/private/tmp',
  };

  const server = createPreviewInvocation('server', [], dependencies);
  assert.equal(PREVIEW_SERVER_PORT, 19527);
  assert.equal(PREVIEW_WEB_PORT, 19528);
  assert.equal(server.command, 'go');
  assert.deepEqual(server.argumentsList, [
    'run', './cmd/aih-server', '--host', '127.0.0.1', '--port', '19527',
  ]);
  assert.equal(server.cwd, '/workspace/ai_home');
  assert.equal(server.env.AIH_HOME, '/private/tmp/aih-go-accounts-preview');
  assert.notEqual(server.env.AIH_HOME, dependencies.env.AIH_HOME);
  assert.ok(server.env.AIH_SERVER_MANAGEMENT_KEY.length >= 32);
  assert.ok(server.env.AIH_SERVER_CLIENT_KEY.length >= 32);
  assert.notEqual(
    server.env.AIH_SERVER_MANAGEMENT_KEY,
    server.env.AIH_SERVER_CLIENT_KEY,
  );

  const web = createPreviewInvocation('web', [], dependencies);
  assert.equal(web.command, 'node');
  assert.deepEqual(web.argumentsList, [
    '/workspace/ai_home/web/node_modules/@umijs/max/bin/max.js',
    'dev',
  ]);
  assert.equal(web.cwd, '/workspace/ai_home/web');
  assert.equal(web.env.HOST, '127.0.0.1');
  assert.equal(web.env.PORT, '19528');
  assert.equal(web.env.AIH_GO_ACCOUNTS_PREVIEW, '1');

  const cli = createPreviewInvocation(
    'cli',
    ['account', 'list', '--limit', '5'],
    dependencies,
  );
  assert.equal(cli.command, 'go');
  assert.deepEqual(cli.argumentsList, [
    'run', './cmd/aih', 'account', 'list', '--limit', '5',
  ]);
  assert.equal(cli.env.AIH_SERVER_BASE_URL, 'http://127.0.0.1:19527');
  assert.equal(cli.env.AIH_HOME, server.env.AIH_HOME);
  assert.equal(cli.env.AIH_SERVER_MANAGEMENT_KEY, server.env.AIH_SERVER_MANAGEMENT_KEY);
  assert.throws(
    () => createPreviewInvocation('unknown', [], dependencies),
    /preview 模式无效/,
  );
});

test('preview 启动前按进程职责探测端口，占用时不启动子进程', async () => {
  const { runPreview } = require('../scripts/go-accounts-preview');
  const probedPorts = [];
  const spawnedCommands = [];
  const dependencies = {
    env: {},
    fs: {
      mkdirSync() {},
      chmodSync() {},
    },
    repositoryRoot: '/workspace/ai_home',
    temporaryRoot: '/private/tmp',
    async portProbe(port) {
      probedPorts.push(port);
    },
    nodeVersionProbe() {
      return 'v22.16.0';
    },
    spawnSync(command, argumentsList) {
      spawnedCommands.push([command, argumentsList]);
      return { status: 0 };
    },
  };

  assert.equal(await runPreview('server', [], dependencies), 0);
  assert.equal(await runPreview('web', [], dependencies), 0);
  assert.equal(await runPreview('cli', ['account', 'list'], dependencies), 0);
  assert.deepEqual(probedPorts, [19527, 19528]);
  assert.equal(spawnedCommands.length, 3);

  let spawned = false;
  await assert.rejects(
    runPreview('server', [], {
      ...dependencies,
      async portProbe(port) {
        throw new Error(`preview 端口 ${port} 已被占用`);
      },
      spawnSync() {
        spawned = true;
        return { status: 0 };
      },
    }),
    /19527.*占用/,
  );
  assert.equal(spawned, false);

  await assert.rejects(
    runPreview('web', [], {
      ...dependencies,
      nodeVersionProbe() {
        return 'v26.3.0';
      },
    }),
    /需要 Node 22/,
  );
});

test('preview 帮助明确固定端口、临时目录和禁止直接运行默认 Go Server', () => {
  const {
    assertPreviewHome,
    formatPreviewHelp,
  } = require('../scripts/go-accounts-preview');
  const help = formatPreviewHelp('/private/tmp/aih-go-accounts-preview');

  assert.match(help, /19527/);
  assert.match(help, /19528/);
  assert.match(help, /不得直接运行.*cmd\/aih-server/);
  assert.match(help, /AIH_HOME.*\/private\/tmp\/aih-go-accounts-preview/);
  assert.match(help, /Node 22/);
  assert.doesNotThrow(() => assertPreviewHome(
    '/private/tmp/aih-go-accounts-preview',
    '/Users/example',
  ));
  assert.throws(
    () => assertPreviewHome('/Users/example/.ai_home', '/Users/example'),
    /拒绝使用正式 AIH_HOME/,
  );
});
