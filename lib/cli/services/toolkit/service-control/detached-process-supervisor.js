'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { spawn: nodeSpawn } = require('node:child_process');

const DEFAULT_BACKOFF_MS = Object.freeze([1000, 2000, 5000, 10000, 30000, 60000]);
const STABLE_UPTIME_MS = 60 * 1000;
const STOP_GRACE_MS = 5000;

function defaultIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function defaultKill(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (_error) {
    return false;
  }
}

/**
 * 以 detached 方式守护一个长驻进程：
 * - 进程脱离 AIH 生命周期运行（AIH 重启不会断隧道），stdout/stderr 追加到日志文件；
 * - pid 与启动参数持久化，AIH 重启后 adopt() 重新接管；
 * - 退出检测 = 子进程 exit 事件（自启进程）+ 存活轮询（接管进程）；
 * - 期望运行且开启自动重启时按退避表重启，稳定运行一段时间后退避归零。
 */
function createDetachedProcessSupervisor(options = {}) {
  const fs = options.fs || nodeFs;
  const path = options.path || nodePath;
  const spawn = options.spawn || nodeSpawn;
  const isAlive = options.isAlive || defaultIsAlive;
  const kill = options.kill || defaultKill;
  const now = options.now || Date.now;
  const timers = {
    setTimeout: options.setTimeout || setTimeout,
    clearTimeout: options.clearTimeout || clearTimeout,
    setInterval: options.setInterval || setInterval,
    clearInterval: options.clearInterval || clearInterval
  };
  const backoffMs = Array.isArray(options.backoffMs) && options.backoffMs.length ? options.backoffMs : DEFAULT_BACKOFF_MS;
  const stableUptimeMs = Number(options.stableUptimeMs) > 0 ? Number(options.stableUptimeMs) : STABLE_UPTIME_MS;
  const pollIntervalMs = Number(options.pollIntervalMs) > 0 ? Number(options.pollIntervalMs) : 3000;
  const store = options.stateStore;
  const logFile = String(options.logFile || '');

  const runtime = {
    phase: 'stopped',
    pid: 0,
    startedAt: 0,
    restarts: 0,
    consecutiveFailures: 0,
    nextRestartAt: 0,
    lastExit: null,
    lastError: ''
  };
  let restartTimer = null;
  let pollTimer = null;

  function unref(timer) {
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  function ensurePolling() {
    if (pollTimer) return;
    pollTimer = unref(timers.setInterval(() => {
      if (runtime.pid && !isAlive(runtime.pid)) handleExit(runtime.pid, { code: null, signal: null, reason: 'process-gone' });
    }, pollIntervalMs));
  }

  function stopPolling() {
    if (!pollTimer) return;
    timers.clearInterval(pollTimer);
    pollTimer = null;
  }

  function cancelRestart() {
    if (restartTimer) timers.clearTimeout(restartTimer);
    restartTimer = null;
    runtime.nextRestartAt = 0;
  }

  function openLog() {
    if (!logFile) return 'ignore';
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    return fs.openSync(logFile, 'a');
  }

  function launch(spec) {
    const command = String(spec && spec.command || '').trim();
    if (!command) return { ok: false, error: 'service_launch_spec_missing', message: '缺少启动命令。' };
    let logFd = 'ignore';
    let child;
    try {
      logFd = openLog();
      child = spawn(command, Array.isArray(spec.args) ? spec.args : [], {
        cwd: spec.cwd || undefined,
        env: spec.env || process.env,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', logFd, logFd]
      });
    } catch (error) {
      runtime.lastError = String(error && error.message || error);
      return { ok: false, error: 'service_spawn_failed', message: runtime.lastError };
    } finally {
      if (typeof logFd === 'number') {
        try { fs.closeSync(logFd); } catch (_error) {}
      }
    }
    const pid = Number(child && child.pid) || 0;
    if (!pid) {
      runtime.lastError = '进程未能启动';
      return { ok: false, error: 'service_spawn_failed', message: runtime.lastError };
    }
    if (typeof child.on === 'function') {
      child.on('error', (error) => { runtime.lastError = String(error && error.message || error); });
      child.on('exit', (code, signal) => handleExit(pid, { code, signal, reason: 'exit' }));
    }
    if (typeof child.unref === 'function') child.unref();
    runtime.phase = 'running';
    runtime.pid = pid;
    runtime.startedAt = now();
    runtime.lastError = '';
    store.write({ pid, startedAt: runtime.startedAt, launch: spec });
    ensurePolling();
    return { ok: true, pid };
  }

  function scheduleRestart() {
    const delay = backoffMs[Math.min(runtime.consecutiveFailures, backoffMs.length - 1)];
    runtime.phase = 'backoff';
    runtime.nextRestartAt = now() + delay;
    restartTimer = unref(timers.setTimeout(() => {
      restartTimer = null;
      runtime.nextRestartAt = 0;
      const state = store.read();
      if (state.desired !== 'running') return;
      runtime.restarts += 1;
      const result = launch(state.launch || {});
      if (!result.ok) {
        runtime.consecutiveFailures += 1;
        scheduleRestart();
      }
    }, delay));
  }

  function handleExit(pid, exit) {
    if (!pid || pid !== runtime.pid) return;
    const uptime = runtime.startedAt ? now() - runtime.startedAt : 0;
    runtime.lastExit = { code: exit.code, signal: exit.signal, reason: exit.reason, at: now(), uptimeMs: uptime };
    runtime.pid = 0;
    runtime.startedAt = 0;
    store.write({ pid: 0, startedAt: 0 });
    const state = store.read();
    if (state.desired === 'running' && state.autoRestart) {
      runtime.consecutiveFailures = uptime >= stableUptimeMs ? 0 : runtime.consecutiveFailures + 1;
      scheduleRestart();
      return;
    }
    runtime.phase = 'stopped';
    stopPolling();
  }

  function start(spec) {
    cancelRestart();
    if (runtime.pid && isAlive(runtime.pid)) return { ok: true, pid: runtime.pid, alreadyRunning: true };
    store.write({ desired: 'running' });
    runtime.consecutiveFailures = 0;
    return launch(spec);
  }

  function waitForExit(pid, timeoutMs) {
    return new Promise((resolve) => {
      const deadline = now() + timeoutMs;
      const check = () => {
        if (!isAlive(pid)) return resolve(true);
        if (now() >= deadline) return resolve(false);
        timers.setTimeout(check, 100);
      };
      check();
    });
  }

  async function stop() {
    store.write({ desired: 'stopped' });
    cancelRestart();
    const pid = runtime.pid || Number(store.read().pid) || 0;
    if (pid && isAlive(pid)) {
      kill(pid, 'SIGTERM');
      if (!(await waitForExit(pid, STOP_GRACE_MS))) kill(pid, 'SIGKILL');
    }
    runtime.phase = 'stopped';
    runtime.pid = 0;
    runtime.startedAt = 0;
    store.write({ pid: 0, startedAt: 0 });
    stopPolling();
    return { ok: true };
  }

  async function restart(spec) {
    await stop();
    return start(spec);
  }

  /** AIH 启动时调用：接管仍存活的进程；进程已退出且配置为随 AIH 启动时重新拉起。 */
  function adopt() {
    const state = store.read();
    const pid = Number(state.pid) || 0;
    if (pid && isAlive(pid)) {
      runtime.phase = 'running';
      runtime.pid = pid;
      runtime.startedAt = Number(state.startedAt) || now();
      ensurePolling();
      return { ok: true, adopted: true, pid };
    }
    if (pid) store.write({ pid: 0, startedAt: 0 });
    if (state.desired === 'running' && state.autoStart && state.launch) {
      return { ...launch(state.launch), restored: true };
    }
    return { ok: true, adopted: false };
  }

  function status() {
    const state = store.read();
    if (runtime.phase === 'running' && runtime.pid && !isAlive(runtime.pid)) {
      handleExit(runtime.pid, { code: null, signal: null, reason: 'process-gone' });
    }
    return {
      phase: runtime.phase,
      pid: runtime.pid,
      startedAt: runtime.startedAt,
      restarts: runtime.restarts,
      consecutiveFailures: runtime.consecutiveFailures,
      nextRestartAt: runtime.nextRestartAt,
      lastExit: runtime.lastExit,
      lastError: runtime.lastError,
      desired: state.desired,
      autoStart: Boolean(state.autoStart),
      autoRestart: Boolean(state.autoRestart)
    };
  }

  function updateSettings(patch = {}) {
    const next = {};
    if (typeof patch.autoStart === 'boolean') next.autoStart = patch.autoStart;
    if (typeof patch.autoRestart === 'boolean') next.autoRestart = patch.autoRestart;
    store.write(next);
    if (next.autoRestart === false && runtime.phase === 'backoff') {
      cancelRestart();
      runtime.phase = 'stopped';
    }
    return status();
  }

  function dispose() {
    cancelRestart();
    stopPolling();
  }

  return { adopt, dispose, restart, start, status, stop, updateSettings };
}

module.exports = {
  DEFAULT_BACKOFF_MS,
  createDetachedProcessSupervisor
};
