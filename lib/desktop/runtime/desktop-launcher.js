'use strict';

const { EventEmitter } = require('node:events');
const readline = require('node:readline');
const { normalizeDesktopEvent, VERSION } = require('./desktop-protocol');

function createDesktopLauncher({ build, spawn, mode = 'helper', config = {} } = {}) {
  if (typeof build !== 'function') throw new TypeError('desktop launcher requires build');
  if (typeof spawn !== 'function') throw new TypeError('desktop launcher requires spawn');
  const lifecycle = new EventEmitter();
  let child = null;
  let startPromise = null;
  let stopped = false;
  let stopping = false;
  let stopPromise = null;
  let resolveStopPromise = null;
  let handshakeTimer = null;
  let handshakePromise = null;
  let resolveHandshake = null;
  let generation = 0;
  let retries = 0;
  let restartTimer = null;
  let parentTimer = null;
  let stderr = '';
  let lastError = null;
  let activeGeneration = 0;
  const maxRestarts = Number.isSafeInteger(config.maxRestarts) ? Math.max(0, config.maxRestarts) : 3;
  const restartDelayMs = Math.max(1, Number(config.restartDelayMs) || 2000);
  const parentPollMs = Math.max(1, Number(config.parentPollMs) || 1000);
  const isParentAlive = typeof config.isParentAlive === 'function'
    ? config.isParentAlive
    : () => {
      const pid = Number(config.parentPid);
      if (!Number.isSafeInteger(pid) || pid <= 1) return true;
      try { process.kill(pid, 0); return true; } catch (_error) { return false; }
    };
  const state = { mode, status: 'idle', generation: 0 };

  function emitStatus(status, detail = '') {
    state.status = status;
    state.detail = detail;
    lifecycle.emit('status', status, detail);
  }

  function clearParentWatch() {
    if (parentTimer) clearInterval(parentTimer);
    parentTimer = null;
  }

  function watchParent() {
    clearParentWatch();
    if (mode !== 'helper' || config.parentPid == null || config.watchParent === false) return;
    parentTimer = setInterval(() => {
      if (!isParentAlive()) stop({ permanent: true });
    }, parentPollMs);
    if (typeof parentTimer.unref === 'function') parentTimer.unref();
  }

  function handleExit(current, code, signal) {
    if (child !== current) return;
    child = null;
    if (handshakeTimer) clearTimeout(handshakeTimer);
    handshakeTimer = null;
    resolveHandshake?.(false);
    resolveHandshake = null;
    handshakePromise = null;
    if (current.__desktopReadline) current.__desktopReadline.close();
    if (stopping || stopped) {
      stopping = false;
      stopPromise = null;
      resolveStopPromise?.();
      resolveStopPromise = null;
      emitStatus('stopped');
      return;
    }
    emitStatus('error', stderr ? '桌面进程已退出' : `桌面进程已退出 (${code ?? signal ?? 'unknown'})`);
    lifecycle.emit('exit', { code, signal, stderr: stderr.slice(-2000) });
    if (mode !== 'helper' || retries++ >= maxRestarts) return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (!stopped) void start();
    }, restartDelayMs);
    if (typeof restartTimer.unref === 'function') restartTimer.unref();
  }

  function attach(current) {
    child = current;
    stderr = '';
    // Generations are scoped to one native child. A restarted child begins at
    // its own protocol epoch and must not inherit the previous process's
    // highest generation.
    activeGeneration = 0;
    current.__desktopGeneration = generation;
    if (current.stderr && typeof current.stderr.on === 'function') current.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-2000);
    });
    if (current.stdout && typeof current.stdout.on === 'function' && typeof current.stdout.resume === 'function') {
      const lines = readline.createInterface({ input: current.stdout });
      current.__desktopReadline = lines;
      lines.on('line', (line) => {
        if (child !== current || line.length > 100000) return;
        let parsed;
        try { parsed = JSON.parse(line); } catch (_error) { return; }
        if (parsed && parsed.version !== undefined && Number(parsed.version) !== VERSION) {
          lastError = { code: 'desktop_protocol_version_unsupported', message: `桌面协议版本不受支持: ${parsed.version}`, retryable: false };
          emitStatus('error', lastError.message);
          resolveHandshake?.(false);
          resolveHandshake = null;
          stop({ permanent: true });
          return;
        }
        const event = normalizeDesktopEvent(parsed, { expectedVersion: VERSION });
        if (event) {
          if (event.type === 'ready') {
            state.handshake = true;
            if (handshakeTimer) clearTimeout(handshakeTimer);
            handshakeTimer = null;
            emitStatus('running');
            resolveHandshake?.(true);
            resolveHandshake = null;
            lifecycle.emit('ready');
          }
          // Chat session and command generations are independent counters.
          // Its bridge validates request/session/command identities; comparing
          // them to one process-wide watermark can silently drop close/open.
          if (event.generation !== undefined && !event.type.startsWith('chat.')) {
            if (event.generation < activeGeneration) return;
            activeGeneration = event.generation;
          }
          lifecycle.emit('event', event);
        }
      });
    }
    current.once?.('error', (error) => {
      lastError = { code: error && error.code || 'desktop_spawn_error', message: error && error.message || '桌面进程无法启动' };
      emitStatus('error', lastError.message);
      if (lifecycle.listenerCount('error') > 0) lifecycle.emit('error', lastError);
    });
    current.once?.('exit', (code, signal) => handleExit(current, code, signal));
    state.handshake = false;
    emitStatus('handshaking');
    send({ version: VERSION, type: 'hello' });
    handshakePromise = new Promise((resolve) => { resolveHandshake = resolve; });
    handshakeTimer = setTimeout(() => {
      if (child === current && !state.handshake) {
        lastError = { code: 'desktop_protocol_handshake_timeout', message: '桌面进程协议握手超时', retryable: true };
        emitStatus('error', lastError.message);
        resolveHandshake?.(false);
        resolveHandshake = null;
        try { current.kill?.('SIGTERM'); } catch (_error) { /* best effort */ }
      }
    }, Math.max(100, Number(config.handshakeTimeoutMs) || 5000));
    watchParent();
    lifecycle.emit('start');
  }

  async function start() {
    if (stopped) return false;
    if (stopping && stopPromise) {
      await stopPromise;
      return start();
    }
    if (child) return true;
    if (startPromise) return startPromise;
    const token = generation;
    startPromise = (async () => {
      emitStatus('starting');
      try {
        const built = await build(config);
        if (stopped || token !== generation) return false;
        // build 可以返回可执行文件路径，或 { command, args }（前置启动器，例如 macOS 的
        // 责任归属启动器）；后者的 args 放在 config.args 之前。
        const executable = built && typeof built === 'object' ? built.command : built;
        const prefixArgs = built && typeof built === 'object' && Array.isArray(built.args) ? built.args : [];
        const args = [...prefixArgs, ...(Array.isArray(config.args) ? config.args : [])];
        const options = { ...(config.spawnOptions || {}) };
        const current = spawn(executable, args, options);
        if (!current || typeof current !== 'object') throw new Error('desktop_spawn_invalid');
        attach(current);
        if (config.awaitHandshake === false) return true;
        return await handshakePromise;
      } catch (error) {
        lastError = { code: error && error.code || 'desktop_build_error', message: error && error.message || '桌面进程构建失败' };
        emitStatus('error', lastError.message);
        if (lifecycle.listenerCount('error') > 0) lifecycle.emit('error', lastError);
        return false;
      } finally {
        startPromise = null;
        if (!stopped && token !== generation && !child) setImmediate(() => { void start(); });
      }
    })();
    return startPromise;
  }

  function stop({ permanent = false } = {}) {
    if (stopped && !child) return;
    if (permanent) stopped = true;
    generation += 1;
    state.generation = generation;
    clearParentWatch();
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    const current = child;
    if (!current || stopping) {
      if (!current) emitStatus('stopped');
      return;
    }
    stopping = true;
    stopPromise = new Promise((resolve) => { resolveStopPromise = resolve; });
    try { current.__desktopReadline?.close(); } catch (_error) { /* best effort */ }
    try { current.stdin?.end?.(); } catch (_error) { /* best effort */ }
    try { current.kill?.('SIGTERM'); } catch (_error) { /* best effort */ }
    emitStatus('stopping');
  }

  function send(event) {
    if (!child || stopping || !child.stdin || child.stdin.writable === false) return false;
    const normalized = normalizeDesktopEvent(event);
    if (!normalized) return false;
    try {
      child.stdin.write(`${JSON.stringify(normalized)}\n`);
      return true;
    } catch (_error) {
      return false;
    }
  }

  return {
    start,
    stop,
    send,
    status: () => ({ ...state, retries, lastError: lastError ? { ...lastError } : null }),
    child: () => child,
    on: (...args) => { lifecycle.on(...args); return lifecycle; },
    once: (...args) => { lifecycle.once(...args); return lifecycle; }
  };
}

module.exports = { createDesktopLauncher };
