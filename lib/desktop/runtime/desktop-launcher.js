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
  let generation = 0;
  let retries = 0;
  let restartTimer = null;
  let parentTimer = null;
  let stderr = '';
  let lastError = null;
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
    if (current.__desktopReadline) current.__desktopReadline.close();
    if (stopping || stopped) {
      stopping = false;
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
        const event = normalizeDesktopEvent(parsed, { expectedVersion: VERSION });
        if (event) lifecycle.emit('event', event);
      });
    }
    current.once?.('error', (error) => {
      lastError = { code: error && error.code || 'desktop_spawn_error', message: error && error.message || '桌面进程无法启动' };
      emitStatus('error', lastError.message);
      if (lifecycle.listenerCount('error') > 0) lifecycle.emit('error', lastError);
    });
    current.once?.('exit', (code, signal) => handleExit(current, code, signal));
    emitStatus('running');
    watchParent();
    lifecycle.emit('start');
  }

  async function start() {
    if (stopped) return false;
    if (child) return true;
    if (startPromise) return startPromise;
    const token = generation;
    startPromise = (async () => {
      emitStatus('starting');
      try {
        const executable = await build(config);
        if (stopped || token !== generation) return false;
        const args = Array.isArray(config.args) ? config.args.slice() : [];
        const options = { ...(config.spawnOptions || {}) };
        const current = spawn(executable, args, options);
        if (!current || typeof current !== 'object') throw new Error('desktop_spawn_invalid');
        attach(current);
        return true;
      } catch (error) {
        lastError = { code: error && error.code || 'desktop_build_error', message: error && error.message || '桌面进程构建失败' };
        emitStatus('error', lastError.message);
        if (lifecycle.listenerCount('error') > 0) lifecycle.emit('error', lastError);
        return false;
      } finally {
        startPromise = null;
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
