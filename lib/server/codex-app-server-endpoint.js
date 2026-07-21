'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { resolveRuntimeTarget } = require('../account/runtime-target');
const {
  buildCodexProviderArgs,
  injectCodexProviderArgs
} = require('../cli/services/ai-cli/codex-provider-args');
const { resolveAihLogPath, resolveAihRunPath } = require('../runtime/aih-storage-layout');
const {
  CODEX_APP_SERVER_PASSTHROUGH_ENV
} = require('./codex-app-server-hook-wrapper');
const {
  cleanupRunSocket,
  hasRunSession,
  isTmuxRunSupported,
  spawnDetachedTmuxRun
} = require('./native-run-tmux');

const READY_TIMEOUT_MS = 20000;
const READY_POLL_INTERVAL_MS = 250;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function codedError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function appServerSocketName(accountRef) {
  const compact = String(accountRef || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 24) || 'unknown';
  return `aih-codexapp-${compact}`;
}

function appServerStateDir(aiHomeDir) {
  const base = normalizeString(aiHomeDir)
    || path.join(normalizeString(process.env.AIH_HOST_HOME) || os.homedir(), '.ai_home');
  return resolveAihRunPath(base, 'codex-app-server');
}

function appServerStatePath(aiHomeDir, accountRef) {
  return path.join(appServerStateDir(aiHomeDir), `${String(accountRef || 'unknown')}.json`);
}

function readAppServerState(aiHomeDir, accountRef) {
  try {
    const parsed = JSON.parse(fs.readFileSync(appServerStatePath(aiHomeDir, accountRef), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function writeAppServerState(aiHomeDir, accountRef, state) {
  try {
    fs.mkdirSync(appServerStateDir(aiHomeDir), { recursive: true });
    fs.writeFileSync(appServerStatePath(aiHomeDir, accountRef), JSON.stringify(state, null, 2), 'utf8');
  } catch (_error) { /* best-effort：状态文件仅用于重启后复用端口 */ }
}

function checkReadyz(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const request = http.get({
      host: '127.0.0.1',
      port,
      path: '/readyz',
      timeout: timeoutMs
    }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
  });
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function shellQuote(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, "'\\''")}'`;
}

async function waitForAppServerReady(port, socket, options = {}) {
  const timeoutMs = options.timeoutMs ?? READY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? READY_POLL_INTERVAL_MS;
  const now = options.now || Date.now;
  const checkReady = options.checkReadyz || checkReadyz;
  const isAlive = options.hasRunSession || hasRunSession;
  const delay = options.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (await checkReady(port)) return;
    if (!isAlive(socket, { spawnSyncImpl: options.spawnSyncImpl })) {
      throw codedError(
        'codex_app_server_process_exited',
        `codex app-server 进程已退出，请检查日志：${options.logPath || 'unknown'}`
      );
    }
    await delay(pollIntervalMs);
  }
  throw codedError(
    'codex_app_server_not_ready',
    `codex app-server ${timeoutMs}ms 内未就绪(port ${port})`
  );
}

async function ensureCodexAppServerEndpoint(options = {}) {
  const target = resolveRuntimeTarget(options);
  const getProfileDir = options.getProfileDir;
  if (!target || typeof getProfileDir !== 'function') {
    throw codedError(
      'native_session_invalid_context',
      'codex app-server 需要账号或 gateway runtime target 与 getProfileDir'
    );
  }
  const { accountRef, gateway, runtimeScope } = target;
  const aiHomeDir = options.aiHomeDir;
  const runtimeFingerprint = normalizeString(options.runtimeFingerprint);
  const existing = readAppServerState(aiHomeDir, runtimeScope);
  const sameRuntime = !runtimeFingerprint
    || normalizeString(existing && existing.runtimeFingerprint) === runtimeFingerprint;
  if (sameRuntime && existing && Number(existing.port) > 0 && await checkReadyz(Number(existing.port))) {
    return { port: Number(existing.port), reused: true };
  }

  if (!isTmuxRunSupported({ spawnSyncImpl: options.spawnSyncImpl })) {
    throw codedError('codex_app_server_tmux_unavailable', 'tmux 不可用,无法常驻 codex app-server');
  }

  const {
    buildProviderEnv,
    resolveNativeCliLaunch
  } = require('./native-session-chat');
  const runtimeDir = getProfileDir('codex', accountRef, { gateway });
  const providerEnv = buildProviderEnv('codex', runtimeDir, options.env || process.env, {
    accountRef,
    aiHomeDir,
    gateway
  });
  const env = codexAppServerLaunchEnv(providerEnv, { gateway });
  const launch = resolveCodexAppServerLaunch(options, env, resolveNativeCliLaunch);
  const socket = appServerSocketName(runtimeScope);
  cleanupRunSocket(socket, { spawnSyncImpl: options.spawnSyncImpl });

  const port = await pickFreePort();
  const logPath = resolveAihLogPath(aiHomeDir, 'codex', 'app-server', `${runtimeScope}.log`);
  try {
    fs.mkdirSync(appServerStateDir(aiHomeDir), { recursive: true });
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
  } catch (_error) { /* 下方写日志时自然报错 */ }
  const providerArgs = buildCodexProviderArgs(env, { force: gateway });
  const appServerArgs = injectCodexProviderArgs([
    'app-server',
    '--listen',
    `ws://127.0.0.1:${port}`
  ], providerArgs);
  const commandLine = [launch.command, ...launch.prefixArgs, ...appServerArgs]
    .map(shellQuote)
    .join(' ');
  const spawned = spawnDetachedTmuxRun({
    socket,
    shellCommand: `exec ${commandLine} >> ${shellQuote(logPath)} 2>&1`,
    cwd: os.homedir(),
    env,
    spawnSyncImpl: options.spawnSyncImpl
  });
  if (!spawned.ok) {
    throw codedError('codex_app_server_spawn_failed', `codex app-server 启动失败(${spawned.error})`);
  }
  try {
    await waitForAppServerReady(port, socket, {
      logPath,
      spawnSyncImpl: options.spawnSyncImpl
    });
  } catch (error) {
    cleanupRunSocket(socket, { spawnSyncImpl: options.spawnSyncImpl });
    throw error;
  }
  writeAppServerState(aiHomeDir, runtimeScope, {
    ...(gateway ? { gateway: true } : { accountRef }),
    runtimeScope,
    ...(runtimeFingerprint ? { runtimeFingerprint } : {}),
    port,
    socket,
    startedAt: Date.now()
  });
  return { port, reused: false };
}

function resolveCodexAppServerLaunch(options, env, fallbackResolver) {
  const executablePath = normalizeString(options.runtimeExecutablePath);
  if (executablePath) return { command: executablePath, prefixArgs: [] };
  return fallbackResolver('codex', { env });
}

function codexAppServerLaunchEnv(providerEnv, options = {}) {
  const env = { ...(providerEnv || {}) };
  if (options.gateway === true) {
    delete env[CODEX_APP_SERVER_PASSTHROUGH_ENV];
  } else {
    env[CODEX_APP_SERVER_PASSTHROUGH_ENV] = '1';
  }
  return env;
}

module.exports = {
  appServerSocketName,
  codexAppServerLaunchEnv,
  ensureCodexAppServerEndpoint,
  resolveCodexAppServerLaunch,
  waitForAppServerReady
};
