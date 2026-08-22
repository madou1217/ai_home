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
  resolveRunMultiplexerBinding,
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
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return {
      ...parsed,
      multiplexer: storedAppServerMultiplexer(parsed)
    };
  } catch (_error) {
    return null;
  }
}

function writeAppServerState(aiHomeDir, accountRef, state) {
  const normalized = {
    ...(state && typeof state === 'object' ? state : {}),
    multiplexer: storedAppServerMultiplexer(state)
  };
  if (!normalized.multiplexer) return null;
  const filePath = appServerStatePath(aiHomeDir, accountRef);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(appServerStateDir(aiHomeDir), { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(normalized, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, filePath);
    return normalized;
  } catch (_error) {
    try { fs.unlinkSync(tempPath); } catch (_cleanupError) { /* best-effort */ }
    return null;
  }
}

function storedAppServerMultiplexer(state) {
  const value = normalizeString(state && state.multiplexer).toLowerCase();
  if (!value) return 'tmux';
  if (value === 'tmux' || value === 'herdr') return value;
  return '';
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
    if (!isAlive(socket, options)) {
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
  const checkReady = options.checkReadyzImpl || checkReadyz;
  const pickPort = options.pickFreePortImpl || pickFreePort;
  const runtimeFingerprint = normalizeString(options.runtimeFingerprint);
  const existing = readAppServerState(aiHomeDir, runtimeScope);
  const sameRuntime = !runtimeFingerprint
    || normalizeString(existing && existing.runtimeFingerprint) === runtimeFingerprint;
  if (existing && !existing.multiplexer) {
    throw codedError('codex_app_server_state_invalid', 'codex app-server backend state 非法,拒绝自动选择其他 driver');
  }
  if (sameRuntime && existing && Number(existing.port) > 0 && await checkReady(Number(existing.port))) {
    return { port: Number(existing.port), reused: true };
  }

  if (existing) {
    const existingBinding = resolveRunMultiplexerBinding({
      spawnSyncImpl: options.spawnSyncImpl,
      multiplexerType: storedAppServerMultiplexer(existing)
    });
    if (!existingBinding.available) {
      throw codedError(
        'codex_app_server_tmux_unavailable',
        `codex app-server 的 ${existingBinding.name} backend 不可用,无法安全管理已有进程`
      );
    }
    cleanupRunSocket(normalizeString(existing.socket) || appServerSocketName(runtimeScope), {
      multiplexerBinding: existingBinding
    });
  }

  const multiplexerBinding = resolveRunMultiplexerBinding({ spawnSyncImpl: options.spawnSyncImpl });
  if (!multiplexerBinding.available) {
    throw codedError('codex_app_server_tmux_unavailable', 'tmux 不可用,无法常驻 codex app-server');
  }

  const {
    buildProviderEnv: defaultBuildProviderEnv,
    resolveNativeCliLaunch: defaultResolveNativeCliLaunch
  } = require('./native-session-chat');
  const buildProviderEnv = options.buildProviderEnvImpl || defaultBuildProviderEnv;
  const resolveNativeCliLaunch = options.resolveNativeCliLaunchImpl || defaultResolveNativeCliLaunch;
  const runtimeDir = getProfileDir('codex', accountRef, { gateway });
  const providerEnv = buildProviderEnv('codex', runtimeDir, options.env || process.env, {
    accountRef,
    aiHomeDir,
    gateway
  });
  const env = codexAppServerLaunchEnv(providerEnv, { gateway });
  const launch = resolveCodexAppServerLaunch(options, env, resolveNativeCliLaunch);
  const socket = appServerSocketName(runtimeScope);
  if (!existing) cleanupRunSocket(socket, { multiplexerBinding });

  const port = await pickPort();
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
    multiplexerBinding
  });
  if (!spawned.ok) {
    throw codedError('codex_app_server_spawn_failed', `codex app-server 启动失败(${spawned.error})`);
  }
  // readiness 之前先落 backend 身份：server 若在启动窗口崩溃，下一次仍能用原 driver 收养/清理。
  const persistedState = writeAppServerState(aiHomeDir, runtimeScope, {
    ...(gateway ? { gateway: true } : { accountRef }),
    runtimeScope,
    ...(runtimeFingerprint ? { runtimeFingerprint } : {}),
    multiplexer: spawned.multiplexer,
    port,
    socket,
    startedAt: Date.now()
  });
  if (!persistedState) {
    cleanupRunSocket(socket, { multiplexerBinding });
    throw codedError('codex_app_server_state_write_failed', 'codex app-server backend state 写入失败');
  }
  try {
    await waitForAppServerReady(port, socket, {
      logPath,
      checkReadyz: checkReady,
      multiplexerBinding
    });
  } catch (error) {
    cleanupRunSocket(socket, { multiplexerBinding });
    throw error;
  }
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
  appServerStatePath,
  codexAppServerLaunchEnv,
  ensureCodexAppServerEndpoint,
  readAppServerState,
  resolveCodexAppServerLaunch,
  storedAppServerMultiplexer,
  writeAppServerState,
  waitForAppServerReady
};
