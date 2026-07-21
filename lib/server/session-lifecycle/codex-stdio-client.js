'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  CODEX_APP_SERVER_PASSTHROUGH_ENV
} = require('../codex-app-server-hook-wrapper');

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
  const spawnImpl = options.spawnImpl || spawn;
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  const requestTimeoutMs = Math.max(100, Number(options.requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS);
  const onStderr = typeof options.onStderr === 'function' ? options.onStderr : () => {};
  const state = {
    child: null,
    closed: false,
    connecting: null,
    nextId: 1,
    pending: new Map(),
    ready: false,
    stdoutBuffer: ''
  };

  async function ensureReady() {
    if (state.closed) throw codedError('codex_lifecycle_client_closed', 'Codex lifecycle client 已关闭');
    if (state.child && state.ready) return state.child;
    if (state.connecting) return state.connecting;
    state.connecting = connect().finally(() => {
      state.connecting = null;
    });
    return state.connecting;
  }

  async function connect() {
    const runtimeEnv = buildCodexHostLifecycleEnv({ env: options.env, hostHomeDir });
    fs.mkdirSync(runtimeEnv.CODEX_HOME, { recursive: true });
    const child = spawnImpl(executablePath, ['app-server', '--listen', 'stdio://'], {
      cwd: hostHomeDir,
      env: runtimeEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    state.child = child;
    state.ready = false;
    state.stdoutBuffer = '';
    bindChild(child);
    await waitForSpawn(child);
    try {
      await requestOn(child, 'initialize', {
        clientInfo: {
          name: 'aih-session-lifecycle',
          title: 'AIH Session Lifecycle',
          version: '1.0.0'
        },
        capabilities: { experimentalApi: true }
      });
      notifyOn(child, 'initialized', {});
      if (state.child !== child || state.closed) {
        throw codedError('codex_lifecycle_transport_closed', 'Codex lifecycle transport 已关闭');
      }
      state.ready = true;
      return child;
    } catch (error) {
      terminateChild(child);
      if (state.child === child) state.child = null;
      throw error;
    }
  }

  function bindChild(child) {
    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', (chunk) => handleStdout(child, chunk));
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => {
        const text = String(chunk || '').trim();
        if (text) onStderr(text);
      });
    }
    child.once('error', (error) => handleClosed(child, error));
    child.once('exit', (code, signal) => handleClosed(child, codedError(
      'codex_lifecycle_transport_closed',
      `Codex lifecycle app-server 已退出(${Number(code) || 0}:${signal || 'none'})`
    )));
  }

  function handleStdout(child, chunk) {
    if (state.child !== child) return;
    state.stdoutBuffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    const lines = state.stdoutBuffer.replace(/\r\n/g, '\n').split('\n');
    state.stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (_error) {
        continue;
      }
      settleResponse(message);
    }
  }

  function settleResponse(message) {
    if (!message || message.id === undefined || message.method) return;
    const id = String(message.id);
    const waiter = state.pending.get(id);
    if (!waiter) return;
    state.pending.delete(id);
    clearTimeout(waiter.timer);
    if (message.error) {
      const error = codedError(
        'codex_app_server_rpc_error',
        String(message.error.message || 'Codex app-server RPC error')
      );
      error.rpcCode = Number(message.error.code);
      if (message.error.data !== undefined) error.rpcData = message.error.data;
      waiter.reject(error);
      return;
    }
    waiter.resolve(message.result);
  }

  function handleClosed(child, cause) {
    if (state.child !== child) return;
    state.child = null;
    state.ready = false;
    const error = cause && cause.code === 'codex_lifecycle_transport_closed'
      ? cause
      : codedError(
        'codex_lifecycle_transport_closed',
        String(cause && cause.message || 'Codex lifecycle transport 已关闭')
      );
    rejectPending(error);
  }

  function requestOn(child, method, params) {
    const id = state.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(String(id));
        reject(codedError('session_lifecycle_timeout', `Codex lifecycle ${method} 超时`));
      }, requestTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      state.pending.set(String(id), { method, reject, resolve, timer });
      try {
        child.stdin.write(`${payload}\n`);
      } catch (error) {
        clearTimeout(timer);
        state.pending.delete(String(id));
        reject(codedError('codex_lifecycle_transport_closed', String(error && error.message || error)));
      }
    });
  }

  function notifyOn(child, method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  function rejectPending(error) {
    for (const [, waiter] of state.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    state.pending.clear();
  }

  return {
    async request(method, params) {
      const child = await ensureReady();
      return requestOn(child, method, params);
    },
    close() {
      if (state.closed) return false;
      state.closed = true;
      state.ready = false;
      rejectPending(codedError('codex_lifecycle_client_closed', 'Codex lifecycle client 已关闭'));
      terminateChild(state.child);
      state.child = null;
      return true;
    }
  };
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(codedError('codex_lifecycle_spawn_failed', String(error && error.message || error)));
    };
    const cleanup = () => {
      child.removeListener('spawn', onSpawn);
      child.removeListener('error', onError);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

function terminateChild(child) {
  if (!child || typeof child.kill !== 'function') return;
  try { child.kill(); } catch (_error) {}
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
