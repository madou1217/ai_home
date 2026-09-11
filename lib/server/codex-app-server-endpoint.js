'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { resolveRuntimeTarget } = require('../account/runtime-target');
const {
  buildCodexProviderArgs,
  injectCodexProviderArgs
} = require('../cli/services/ai-cli/codex-provider-args');
const { resolveAihLogPath, resolveAihRunPath } = require('../runtime/aih-storage-layout');
const { readCodexGatewayConnection } = require('./codex-gateway-connection');
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
  if (String(accountRef || '').startsWith('chat-')) {
    const scoped = String(accountRef).slice(5).replace(/[^A-Za-z0-9]/g, '');
    return `aih-codexchat-${scoped}`;
  }
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

// 常驻 pane 的网关认证签名：client key 轮换或历史 pane 缺 key 时 readyz 仍 200，
// 复用检查必须比对签名，否则坏 pane 会被无限复用（网关 401 永续）。
function appServerEnvSignature(env = {}) {
  return crypto.createHash('sha256')
    .update(String(env.OPENAI_API_KEY || '')).update('\0')
    .update(String(env.OPENAI_BASE_URL || '')).update('\0')
    .update(String(env.AIH_CODEX_GATEWAY_ACCOUNT_REF || ''))
    .digest('hex').slice(0, 16);
}

// psmux kill-server 杀不掉 launcher pane 里的孙进程（cmd→node 链），孤儿会持有端口与日志锁；
// win32 下按监听端口找 PID 并 taskkill 整棵树。best-effort：任何一步失败都静默。
function killWindowsPortOwner(port, options = {}) {
  if (String(options.platform || process.platform) !== 'win32') return false;
  const target = Number(port);
  if (!Number.isInteger(target) || target <= 0 || target > 65535) return false;
  const spawnImpl = typeof options.spawnSync === 'function'
    ? options.spawnSync
    : (typeof options.spawnSyncImpl === 'function' ? options.spawnSyncImpl : spawnSync);
  let out;
  try {
    out = spawnImpl('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
  } catch (_error) {
    return false;
  }
  if (!out || out.status !== 0 || !out.stdout) return false;
  const pids = new Set();
  for (const line of String(out.stdout).split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    // TCP    127.0.0.1:3503    0.0.0.0:0    LISTENING    31620
    if (parts.length >= 5 && /^TCP$/i.test(parts[0])
        && parts[1].endsWith(`:${target}`) && /LISTEN/i.test(parts[3])) {
      const pid = Number(parts[4]);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
  }
  let killed = false;
  for (const pid of pids) {
    try {
      const result = spawnImpl('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      if (result && result.status === 0) killed = true;
    } catch (_error) { /* 单个失败不影响其余 */ }
  }
  return killed;
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

function cmdQuoteArg(value) {
  // cmd 只认双引号引参；" 在 win32 文件路径里本是非法字符，直接包裹即可。
  return `"${String(value == null ? '' : value)}"`;
}

// Windows 没有 sh，且 psmux 拼接 pane argv 时对空格/嵌套引号不可靠（实测）：
// 把 app-server 启动命令落成 launcher .cmd，pane 直接跑 cmd.exe /d /c <launcher>（裸路径）。
function buildWindowsAppServerLauncher(options = {}) {
  const fsImpl = options.fs || fs;
  const launcherPath = path.join(options.stateDir, `${options.socket}.run.cmd`);
  if (launcherPath.includes(' ')) {
    throw codedError(
      'codex_app_server_windows_path_unsupported',
      `Windows 常驻 app-server 的 launcher 路径不能含空格:${launcherPath}`
    );
  }
  const commandLine = options.commandArgv.map(cmdQuoteArg).join(' ');
  fsImpl.writeFileSync(
    launcherPath,
    `@echo off\r\n${commandLine} >> ${cmdQuoteArg(options.logPath)} 2>&1\r\n`
  );
  return { commandArgv: ['cmd.exe', '/d', '/c', launcherPath], launcherPath };
}

async function waitForAppServerReady(port, socket, options = {}) {
  const timeoutMs = options.timeoutMs ?? READY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? READY_POLL_INTERVAL_MS;
  const now = options.now || Date.now;
  const checkReady = options.checkReadyz || checkReadyz;
  const isAlive = options.hasRunSession || hasRunSession;
  const delay = options.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  // Windows（psmux + cmd launcher）会丢 pane 会话跟踪但进程仍存活：
  // liveness 早退只在 POSIX 可信，win32 下以端口 readyz 为唯一事实来源。
  const trustPaneLiveness = String(options.platform || process.platform) !== 'win32';
  while (now() < deadline) {
    if (await checkReady(port)) return;
    if (trustPaneLiveness && !isAlive(socket, options)) {
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

function invalidateCodexAppServerEndpoint(options = {}) {
  const target = resolveRuntimeTarget(options);
  if (!target || target.gateway) {
    return { ok: false, invalidated: false, reason: 'invalid_account' };
  }
  const { accountRef, runtimeScope } = target;
  const aiHomeDir = options.aiHomeDir;
  const existing = readAppServerState(aiHomeDir, runtimeScope);
  if (!existing) {
    return { ok: true, invalidated: false, reason: 'not_running', accountRef, runtimeScope };
  }
  if (!existing.multiplexer) {
    throw codedError('codex_app_server_state_invalid', 'codex app-server backend state 非法,拒绝清理未知 driver');
  }
  const expectedSocket = appServerSocketName(runtimeScope);
  const storedSocket = normalizeString(existing.socket) || expectedSocket;
  if (storedSocket !== expectedSocket) {
    throw codedError('codex_app_server_state_invalid', 'codex app-server socket 与账号 runtime scope 不匹配');
  }
  const multiplexerBinding = resolveRunMultiplexerBinding({
    spawnSyncImpl: options.spawnSyncImpl,
    multiplexerType: storedAppServerMultiplexer(existing),
    platform: options.platform
  });
  if (!multiplexerBinding.available) {
    throw codedError(
      'codex_app_server_tmux_unavailable',
      `codex app-server 的 ${multiplexerBinding.name} backend 不可用,无法安全失效账号进程`
    );
  }
  cleanupRunSocket(storedSocket, { multiplexerBinding });
  killWindowsPortOwner(Number(existing.port), options);
  if (hasRunSession(storedSocket, { multiplexerBinding })) {
    throw codedError(
      'codex_app_server_invalidation_failed',
      'Codex app-server 账号进程仍在运行,保留 runtime state 以便重试'
    );
  }
  try {
    fs.unlinkSync(appServerStatePath(aiHomeDir, runtimeScope));
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      throw codedError('codex_app_server_state_remove_failed', 'codex app-server 已停止,但 runtime state 清理失败');
    }
  }
  return { ok: true, invalidated: true, accountRef, runtimeScope };
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
  const { accountRef, gateway } = target;
  const runtimeScope = options.runtimeNamespace === 'chat'
    ? `chat-${target.runtimeScope}` : target.runtimeScope;
  const aiHomeDir = options.aiHomeDir;
  const checkReady = options.checkReadyzImpl || checkReadyz;
  const pickPort = options.pickFreePortImpl || pickFreePort;
  const runtimeFingerprint = normalizeString(options.runtimeFingerprint);
  // env 签名提前算好：既驱动复用判定，也是下方 spawn 时 pane env 的网关认证来源。
  const gatewayEnv = readCodexGatewayConnection(fs, aiHomeDir, gateway ? '' : accountRef).env;
  const envSignature = appServerEnvSignature(gatewayEnv);
  const existing = readAppServerState(aiHomeDir, runtimeScope);
  const sameRuntime = !runtimeFingerprint
    || normalizeString(existing && existing.runtimeFingerprint) === runtimeFingerprint;
  const sameEnv = normalizeString(existing && existing.envSignature) === envSignature;
  if (existing && !existing.multiplexer) {
    throw codedError('codex_app_server_state_invalid', 'codex app-server backend state 非法,拒绝自动选择其他 driver');
  }
  if (sameRuntime && sameEnv && existing && Number(existing.port) > 0 && await checkReady(Number(existing.port))) {
    return { port: Number(existing.port), reused: true };
  }

  if (existing) {
    const existingBinding = resolveRunMultiplexerBinding({
      spawnSyncImpl: options.spawnSyncImpl,
      multiplexerType: storedAppServerMultiplexer(existing),
      platform: options.platform
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
    // psmux kill-server 杀不掉 launcher pane 的孙进程（cmd→node 链），孤儿持有端口与日志锁。
    killWindowsPortOwner(Number(existing.port), options);
  }

  const multiplexerBinding = resolveRunMultiplexerBinding({
    spawnSyncImpl: options.spawnSyncImpl,
    platform: options.platform
  });
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
  const providerEnv = await buildProviderEnv('codex', runtimeDir, options.env || process.env, {
    accountRef,
    aiHomeDir,
    gateway
  });
  // app-server 的 -c model_providers.aih_server.* 把流量钉死在本地网关（env_key=OPENAI_API_KEY），
  // pane env 必须携带网关 client key。relay 只在账号自带 OPENAI_API_KEY 时生效，
  // qodercn 等凭证在 native_auth 的账号会拿到空 key → 网关 401 unauthorized_client。
  const env = codexAppServerLaunchEnv({
    ...providerEnv,
    OPENAI_BASE_URL: gatewayEnv.OPENAI_BASE_URL,
    OPENAI_API_KEY: gatewayEnv.OPENAI_API_KEY,
    ...(gatewayEnv.AIH_CODEX_GATEWAY_ACCOUNT_REF
      ? { AIH_CODEX_GATEWAY_ACCOUNT_REF: gatewayEnv.AIH_CODEX_GATEWAY_ACCOUNT_REF }
      : {})
  }, { gateway });
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
  const appServerArgv = [launch.command, ...launch.prefixArgs, ...appServerArgs];
  const platform = String(options.platform || process.platform);
  // POSIX：sh -c "exec <argv> >> log 2>&1"；Windows 无 sh，改走 launcher .cmd + cmd.exe。
  const spawnSpec = platform === 'win32'
    ? buildWindowsAppServerLauncher({
      stateDir: appServerStateDir(aiHomeDir),
      socket,
      commandArgv: appServerArgv,
      logPath
    })
    : { shellCommand: `exec ${appServerArgv.map(shellQuote).join(' ')} >> ${shellQuote(logPath)} 2>&1` };
  const spawned = spawnDetachedTmuxRun({
    socket,
    ...spawnSpec,
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
    envSignature,
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
      multiplexerBinding,
      platform
    });
  } catch (error) {
    cleanupRunSocket(socket, { multiplexerBinding });
    killWindowsPortOwner(port, options);
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
  appServerEnvSignature,
  appServerSocketName,
  appServerStatePath,
  codexAppServerLaunchEnv,
  ensureCodexAppServerEndpoint,
  invalidateCodexAppServerEndpoint,
  readAppServerState,
  resolveCodexAppServerLaunch,
  storedAppServerMultiplexer,
  writeAppServerState,
  waitForAppServerReady
};
