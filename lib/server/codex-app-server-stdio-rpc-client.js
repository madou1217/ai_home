'use strict';

const { spawn } = require('node:child_process');

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function createCodexAppServerStdioRpcClient(options = {}) {
  const command = text(options.command);
  if (!command) throw new TypeError('Codex app-server stdio command is required');
  const args = Array.isArray(options.args) ? options.args.map(String) : [];
  const spawnImpl = options.spawnImpl || spawn;
  const requestTimeoutMs = Math.max(
    100,
    Number(options.requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS
  );
  const onStderr = typeof options.onStderr === 'function' ? options.onStderr : () => {};
  const accountIdentityValidator = typeof options.accountIdentityValidator === 'function'
    ? options.accountIdentityValidator
    : null;
  const state = {
    child: null,
    closed: false,
    connecting: null,
    nextId: 1,
    pending: new Map(),
    ready: false,
    stdoutBuffer: ''
  };

  function createError(name, fallbackCode, fallbackMessage, ...argsForFactory) {
    const factory = options.errors && options.errors[name];
    if (typeof factory === 'function') return factory(...argsForFactory);
    return codedError(fallbackCode, fallbackMessage);
  }

  async function ensureReady() {
    if (state.closed) {
      throw createError(
        'clientClosed',
        'codex_app_server_stdio_client_closed',
        'Codex app-server stdio client 已关闭'
      );
    }
    if (state.child && state.ready) return state.child;
    if (state.connecting) return state.connecting;
    state.connecting = connect().finally(() => {
      state.connecting = null;
    });
    return state.connecting;
  }

  async function connect() {
    let child;
    try {
      child = spawnImpl(command, args, {
        cwd: options.cwd,
        env: options.env || process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(options.spawnOptions || {})
      });
    } catch (error) {
      throw createError(
        'spawnFailed',
        'codex_app_server_stdio_spawn_failed',
        `Codex app-server stdio 启动失败: ${text(error && error.message) || 'unknown'}`,
        error
      );
    }
    if (!child || !child.stdin || !child.stdout) {
      terminateChild(child);
      throw createError(
        'spawnFailed',
        'codex_app_server_stdio_spawn_failed',
        'Codex app-server stdio 启动失败: invalid child process'
      );
    }
    state.child = child;
    state.ready = false;
    state.stdoutBuffer = '';
    bindChild(child);
    try {
      await waitForSpawn(child, createError);
      const initializeResult = await requestOn(child, 'initialize', {
        clientInfo: options.clientInfo || {
          name: 'aih-management',
          title: 'AI Home Management',
          version: '1.0.0'
        },
        capabilities: options.capabilities === undefined
          ? { experimentalApi: true }
          : options.capabilities
      });
      notifyOn(child, 'initialized', {});
      if (accountIdentityValidator) {
        const accountResult = await requestOn(child, 'account/read', { refreshToken: false });
        await accountIdentityValidator({ initializeResult, accountResult });
      }
      if (state.child !== child || state.closed) {
        throw createError(
          'transportClosed',
          'codex_app_server_stdio_transport_closed',
          'Codex app-server stdio transport 已关闭'
        );
      }
      state.ready = true;
      return child;
    } catch (error) {
      invalidateChild(child, error);
      throw error;
    }
  }

  function bindChild(child) {
    child.stdout.on('data', (chunk) => handleStdout(child, chunk));
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => {
        const value = String(chunk || '').trim();
        if (value) onStderr(value);
      });
    }
    if (child.stdin && typeof child.stdin.on === 'function') {
      child.stdin.on('error', (error) => handleClosed(child, error));
    }
    child.once('error', (error) => handleClosed(child, error));
    child.once('exit', (code, signal) => handleClosed(child, createError(
      'transportClosed',
      'codex_app_server_stdio_transport_closed',
      `Codex app-server stdio 已退出(${Number(code) || 0}:${signal || 'none'})`,
      { code, signal }
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
        text(message.error.message) || 'Codex app-server RPC error'
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
    const error = cause && cause.code && String(cause.code).startsWith('codex_')
      ? cause
      : createError(
          'transportClosed',
          'codex_app_server_stdio_transport_closed',
          text(cause && cause.message) || 'Codex app-server stdio transport 已关闭',
          cause
        );
    rejectPending(error);
  }

  function invalidateChild(child, error) {
    if (state.child !== child) return;
    state.child = null;
    state.ready = false;
    terminateChild(child);
    rejectPending(error);
  }

  function requestOn(child, method, params) {
    const id = state.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(String(id));
        const error = createError(
          'timeout',
          'codex_app_server_stdio_timeout',
          `Codex app-server ${method} 超时`,
          method
        );
        reject(error);
        invalidateChild(child, error);
      }, requestTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      state.pending.set(String(id), { reject, resolve, timer });
      try {
        child.stdin.write(`${payload}\n`);
      } catch (error) {
        clearTimeout(timer);
        state.pending.delete(String(id));
        reject(createError(
          'transportClosed',
          'codex_app_server_stdio_transport_closed',
          text(error && error.message) || 'Codex app-server stdio transport 已关闭',
          error
        ));
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

  return Object.freeze({
    async request(method, params = {}) {
      const child = await ensureReady();
      return requestOn(child, method, params);
    },
    close() {
      if (state.closed) return false;
      state.closed = true;
      state.ready = false;
      rejectPending(createError(
        'clientClosed',
        'codex_app_server_stdio_client_closed',
        'Codex app-server stdio client 已关闭'
      ));
      terminateChild(state.child);
      state.child = null;
      return true;
    }
  });
}

function waitForSpawn(child, createError) {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(createError(
        'spawnFailed',
        'codex_app_server_stdio_spawn_failed',
        `Codex app-server stdio 启动失败: ${text(error && error.message) || 'unknown'}`,
        error
      ));
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
  if (!child) return;
  try {
    if (child.stdin && typeof child.stdin.end === 'function' && !child.stdin.writableEnded) {
      child.stdin.end();
    }
  } catch (_error) {}
  try {
    if (typeof child.kill === 'function') child.kill();
  } catch (_error) {}
}

function codedError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

module.exports = {
  createCodexAppServerStdioRpcClient
};
