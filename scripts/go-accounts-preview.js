#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PREVIEW_SERVER_PORT = 19527;
const PREVIEW_WEB_PORT = 19528;
const PREVIEW_HOME_NAME = 'aih-go-accounts-preview';
const PREVIEW_MANAGEMENT_KEY = 'aih-go-preview-management-key-2026';
const PREVIEW_CLIENT_KEY = 'aih-go-preview-client-key-2026-only';

// assertPreviewHome 防止任何 preview 调用误用正式 ~/.ai_home。
function assertPreviewHome(previewHome, userHome = os.homedir()) {
  const resolvedPreviewHome = path.resolve(String(previewHome || ''));
  const formalHome = path.resolve(String(userHome || ''), '.ai_home');
  if (resolvedPreviewHome === formalHome) {
    throw new Error(`Go 账号 preview 拒绝使用正式 AIH_HOME: ${formalHome}`);
  }
  return resolvedPreviewHome;
}

// probeLoopbackPort 通过独占监听后立即关闭，避免覆盖正在使用的本地端口。
function probeLoopbackPort(port, netImpl = net) {
  return new Promise((resolve, reject) => {
    const server = netImpl.createServer();
    server.unref();
    server.once('error', (error) => {
      const reason = error?.code === 'EADDRINUSE' ? '已被占用' : '无法探测';
      reject(new Error(`Go 账号 preview 端口 ${port} ${reason}`, { cause: error }));
    });
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close((error) => {
        if (error) {
          reject(new Error(`Go 账号 preview 端口 ${port} 无法释放`, { cause: error }));
          return;
        }
        resolve();
      });
    });
  });
}

function assertNode22(version) {
  const normalized = String(version || '').trim();
  if (!/^v22\./.test(normalized)) {
    throw new Error(`Go 账号 preview Web 需要 Node 22，当前为 ${normalized || '未知版本'}`);
  }
  return normalized;
}

function probeNode22(spawnSyncImpl = spawnSync) {
  const result = spawnSyncImpl('node', ['--version'], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  if (result?.error || result?.status !== 0) {
    throw new Error('Go 账号 preview Web 无法探测 Node 22');
  }
  return assertNode22(result.stdout);
}

function formatPreviewHelp(previewHome = path.join(os.tmpdir(), PREVIEW_HOME_NAME)) {
  return [
    'Go 账号重构 preview（不会替换正式 Node CLI/Server/WebUI）',
    '',
    '启动顺序：',
    '  1. npm run go-preview:server  # Go Server: http://127.0.0.1:19527',
    '  2. npm run go-preview:web     # Preview UI: http://127.0.0.1:19528/ui/accounts',
    '  3. npm run go-cli:preview -- account list',
    '',
    'Preview Web 强制使用 PATH 中的 Node 22，避免 Homebrew npm 误带 Node 24/26。',
    `隔离 AIH_HOME: ${previewHome}`,
    '验收不得直接运行 `go run ./cmd/aih-server`，该入口仍保留正式默认端口。',
  ].join('\n');
}

// createPreviewInvocation 只生成隔离进程描述，不读取或修改正式 AIH_HOME。
function createPreviewInvocation(mode, argumentsList = [], dependencies = {}) {
  const repositoryRoot = path.resolve(
    dependencies.repositoryRoot || path.join(__dirname, '..'),
  );
  const temporaryRoot = path.resolve(dependencies.temporaryRoot || os.tmpdir());
  const previewHome = assertPreviewHome(
    path.join(temporaryRoot, PREVIEW_HOME_NAME),
    dependencies.userHome || os.homedir(),
  );
  const platform = dependencies.platform || process.platform;
  const inheritedEnvironment = dependencies.env || process.env;
  const environment = {
    ...inheritedEnvironment,
    AIH_HOME: previewHome,
    AIH_SERVER_BASE_URL: `http://127.0.0.1:${PREVIEW_SERVER_PORT}`,
    AIH_SERVER_CLIENT_KEY: PREVIEW_CLIENT_KEY,
    AIH_SERVER_MANAGEMENT_KEY: PREVIEW_MANAGEMENT_KEY,
  };

  if (mode === 'server') {
    return {
      command: 'go',
      argumentsList: [
        'run',
        './cmd/aih-server',
        '--host',
        '127.0.0.1',
        '--port',
        String(PREVIEW_SERVER_PORT),
      ],
      cwd: repositoryRoot,
      env: environment,
      previewHome,
    };
  }
  if (mode === 'web') {
    return {
      command: platform === 'win32' ? 'node.exe' : 'node',
      argumentsList: [
        path.join(repositoryRoot, 'web', 'node_modules', '@umijs', 'max', 'bin', 'max.js'),
        'dev',
      ],
      cwd: path.join(repositoryRoot, 'web'),
      env: {
        ...environment,
        // Umi 4 的 dev 命令只从 PORT/HOST 读取监听配置，不接受 --port/--host。
        HOST: '127.0.0.1',
        PORT: String(PREVIEW_WEB_PORT),
        AIH_GO_ACCOUNTS_PREVIEW: '1',
        AIH_GO_ACCOUNTS_PREVIEW_MANAGEMENT_KEY: PREVIEW_MANAGEMENT_KEY,
      },
      previewHome,
    };
  }
  if (mode === 'cli') {
    return {
      command: 'go',
      argumentsList: ['run', './cmd/aih', ...argumentsList],
      cwd: repositoryRoot,
      env: environment,
      previewHome,
    };
  }
  throw new Error(`Go 账号 preview 模式无效: ${String(mode || '')}`);
}

// runPreview 仅在用户显式执行 preview script 时创建临时目录并启动子进程。
async function runPreview(mode, argumentsList = [], dependencies = {}) {
  const invocation = createPreviewInvocation(mode, argumentsList, dependencies);
  const fsImpl = dependencies.fs || fs;
  const nodeVersionProbe = dependencies.nodeVersionProbe || probeNode22;
  const portProbe = dependencies.portProbe || probeLoopbackPort;
  const spawnSyncImpl = dependencies.spawnSync || spawnSync;
  if (mode === 'server') await portProbe(PREVIEW_SERVER_PORT);
  if (mode === 'web') {
    assertNode22(nodeVersionProbe());
    await portProbe(PREVIEW_WEB_PORT);
  }
  fsImpl.mkdirSync(invocation.previewHome, { recursive: true, mode: 0o700 });
  fsImpl.chmodSync(invocation.previewHome, 0o700);
  const result = spawnSyncImpl(invocation.command, invocation.argumentsList, {
    cwd: invocation.cwd,
    env: invocation.env,
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result?.error) throw result.error;
  return Number.isInteger(result?.status) ? result.status : 1;
}

async function main() {
  const [mode, ...argumentsList] = process.argv.slice(2);
  if (mode === 'help' || mode === '--help' || !mode) {
    process.stdout.write(`${formatPreviewHelp()}\n`);
    return;
  }
  try {
    process.exitCode = await runPreview(mode, argumentsList);
  } catch (error) {
    process.stderr.write(`Go 账号 preview 启动失败: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();

module.exports = {
  PREVIEW_SERVER_PORT,
  PREVIEW_WEB_PORT,
  assertNode22,
  assertPreviewHome,
  createPreviewInvocation,
  formatPreviewHelp,
  probeLoopbackPort,
  probeNode22,
  runPreview,
};
