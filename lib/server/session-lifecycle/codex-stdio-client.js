'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  CODEX_APP_SERVER_PASSTHROUGH_ENV
} = require('../codex-app-server-hook-wrapper');
const {
  createCodexAppServerStdioRpcClient
} = require('../codex-app-server-stdio-rpc-client');

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const ACCOUNT_ENV_KEYS = Object.freeze([
  'AIH_ACCOUNT_REF',
  'AIH_ACCOUNT_ID',
  'AIH_CLI_ACCOUNT_ID',
  'AIH_PROFILE_DIR',
  'AIH_RUNTIME_SCOPE'
]);

function buildCodexHostLifecycleEnv(options = {}) {
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  if (!hostHomeDir) throw new TypeError('Codex lifecycle hostHomeDir is required');
  const env = { ...(options.env || process.env || {}) };
  for (const key of ACCOUNT_ENV_KEYS) delete env[key];
  env.HOME = hostHomeDir;
  env.USERPROFILE = hostHomeDir;
  env.CODEX_HOME = path.join(hostHomeDir, '.codex');
  env.CODEX_SQLITE_HOME = env.CODEX_HOME;
  env.XDG_CONFIG_HOME = hostHomeDir;
  env.XDG_DATA_HOME = path.join(hostHomeDir, '.local', 'share');
  env.XDG_STATE_HOME = path.join(hostHomeDir, '.local', 'state');
  env[CODEX_APP_SERVER_PASSTHROUGH_ENV] = '1';
  return env;
}

function createCodexLifecycleStdioClient(runtime = {}, options = {}) {
  const executablePath = String(runtime.executablePath || '').trim();
  if (!executablePath) throw new TypeError('Codex lifecycle executablePath is required');
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  const requestTimeoutMs = Math.max(100, Number(options.requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS);
  const runtimeEnv = buildCodexHostLifecycleEnv({ env: options.env, hostHomeDir });
  fs.mkdirSync(runtimeEnv.CODEX_HOME, { recursive: true });
  return createCodexAppServerStdioRpcClient({
    command: executablePath,
    args: ['app-server', '--listen', 'stdio://'],
    cwd: hostHomeDir,
    env: runtimeEnv,
    spawnImpl: options.spawnImpl,
    requestTimeoutMs,
    onStderr: options.onStderr,
    clientInfo: {
      name: 'aih-session-lifecycle',
      title: 'AIH Session Lifecycle',
      version: '1.0.0'
    },
    capabilities: { experimentalApi: true },
    errors: {
      clientClosed: () => codedError('codex_lifecycle_client_closed', 'Codex lifecycle client 已关闭'),
      transportClosed: (cause) => codedError(
        'codex_lifecycle_transport_closed',
        cause && Object.prototype.hasOwnProperty.call(cause, 'code')
          ? `Codex lifecycle app-server 已退出(${Number(cause.code) || 0}:${cause.signal || 'none'})`
          : String(cause && cause.message || 'Codex lifecycle transport 已关闭')
      ),
      spawnFailed: (error) => codedError(
        'codex_lifecycle_spawn_failed',
        String(error && error.message || error)
      ),
      timeout: (method) => codedError('session_lifecycle_timeout', `Codex lifecycle ${method} 超时`)
    }
  });
}

function codedError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

module.exports = {
  buildCodexHostLifecycleEnv,
  createCodexLifecycleStdioClient
};
