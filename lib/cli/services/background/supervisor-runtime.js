'use strict';

const { calculateReconnectDelay } = require('../../../runtime/reconnect-backoff');
const { SHUTDOWN_GRACE_MS } = require('../../../server/inference-drain');
const { runFabricRegistryAgent } = require('../fabric/registry-agent');
const { runNodeRelayConnect } = require('../node/relay-client');
const { runNodeWebrtcConnect } = require('../node/webrtc-client');
const {
  listEffectiveBackgroundComponents,
  readBackgroundSupervisorState
} = require('./supervisor-state-store');

const DEFAULT_RESTART_DELAY_MS = 1000;
const DEFAULT_RESTART_MAX_DELAY_MS = 30000;
// 后台 worker（relay / webrtc / registry-agent）的停机上限：这些是**可放弃**的连接，
// 都响应 AbortSignal（实测 relay 约 1.2s 退出），卡住就直接放弃，不拖住重启。
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3000;
// 内嵌 server 的停机上限与 server 自己的停机预算同源（inference-drain.js 的 SHUTDOWN_GRACE_MS），
// 两段预算各自计时：此前两者共用一个 15s deadline，与 server 声明的排空上限互相矛盾，
// 停机时间由"谁的超时更短"偶然决定（线上 343 次关闭里 149 次打满 15s）。
const DEFAULT_SERVER_SHUTDOWN_TIMEOUT_MS = SHUTDOWN_GRACE_MS;

const BLOCKED_ERROR_CODES = new Set([
  'invalid_fabric_node_id',
  'invalid_relay_url',
  'invalid_webrtc_url',
  'management_key_required',
  'missing_fabric_registry_endpoint',
  'missing_management_key',
  'missing_relay_node_id',
  'missing_relay_url',
  'missing_webrtc_node_id',
  'missing_webrtc_url',
  'unsupported_background_component'
]);

function nonEmptyString(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function componentType(component) {
  const args = Array.isArray(component && component.args) ? component.args : [];
  const prefix = args.slice(0, 3).join(' ');
  if (prefix === 'node relay connect') return 'relay';
  if (prefix === 'node webrtc connect') return 'webrtc';
  if (prefix === 'fabric registry agent') return 'registry-agent';
  return '';
}

function createUnsupportedComponentError(component) {
  const error = new Error(`unsupported_background_component:${nonEmptyString(component && component.id)}`);
  error.code = 'unsupported_background_component';
  return error;
}

function resolveServerOptions(deps) {
  if (typeof deps.resolveServerOptions === 'function') {
    return deps.resolveServerOptions() || {};
  }
  const readServerConfig = deps.readServerConfig;
  const buildServerArgsFromConfig = deps.buildServerArgsFromConfig;
  const parseServerServeArgs = deps.parseServerServeArgs;
  if (typeof readServerConfig !== 'function'
    || typeof buildServerArgsFromConfig !== 'function'
    || typeof parseServerServeArgs !== 'function') {
    return {};
  }
  const config = readServerConfig() || {};
  return parseServerServeArgs(buildServerArgsFromConfig(config)) || {};
}

function runComponent(component, signal, deps) {
  const type = componentType(component);
  const args = component.args.slice(3);
  const commonContext = {
    ...(deps.runtimeContext || {}),
    processObj: deps.processObj || process,
    signal
  };
  if (type === 'relay') {
    const runner = deps.runNodeRelayConnect || runNodeRelayConnect;
    return runner(args, { ...commonContext, ...(deps.nodeContext || {}), signal });
  }
  if (type === 'webrtc') {
    const runner = deps.runNodeWebrtcConnect || runNodeWebrtcConnect;
    return runner(args, { ...commonContext, ...(deps.nodeContext || {}), signal });
  }
  if (type === 'registry-agent') {
    const runner = deps.runFabricRegistryAgent || runFabricRegistryAgent;
    const fabricContext = deps.fabricContext || {};
    const env = {
      ...((fabricContext && fabricContext.env) || (commonContext.processObj && commonContext.processObj.env) || {})
    };
    delete env.AIH_SERVER_MANAGEMENT_KEY;
    return runner(args, { ...commonContext, ...fabricContext, env, signal });
  }
  throw createUnsupportedComponentError(component);
}

function isBlockedError(error) {
  if (BLOCKED_ERROR_CODES.has(nonEmptyString(error && error.code))) return true;
  const statusCode = Number(error && (error.statusCode || error.status)) || 0;
  return statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429;
}

async function runBackgroundSupervisor(deps = {}) {
  const fs = deps.fs || require('node:fs');
  const path = deps.path || require('node:path');
  const processObj = deps.processObj || process;
  const consoleImpl = deps.consoleImpl || console;
  const schedule = deps.setTimeout || setTimeout;
  const cancelSchedule = deps.clearTimeout || clearTimeout;
  const scheduleShutdown = deps.setShutdownTimeout || setTimeout;
  const cancelShutdown = deps.clearShutdownTimeout || clearTimeout;

  // 给一个 promise 加独立 deadline；返回 'settled' 或 'timeout'。
  // 每次调用都新建并清理自己的 timer —— 两段预算各自计时，互不干扰。
  async function raceWithDeadline(promise, timeoutMs) {
    let timer = null;
    const deadline = new Promise((resolve) => {
      timer = scheduleShutdown(() => resolve('timeout'), timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
    try {
      return await Promise.race([promise, deadline]);
    } finally {
      if (timer) cancelShutdown(timer);
    }
  }
  const aiHomeDir = nonEmptyString(deps.aiHomeDir);
  const readState = typeof deps.readState === 'function'
    ? deps.readState
    : () => readBackgroundSupervisorState({ fs, path, aiHomeDir });
  const components = listEffectiveBackgroundComponents(readState());
  if (components.length === 0) return;

  const controller = new AbortController();
  const workers = new Map();
  let serverHandle = null;
  let stopping = false;
  let stopPromise = null;
  let resolveStopped;
  const stopped = new Promise((resolve) => {
    resolveStopped = resolve;
  });

  function logComponent(component, level, message) {
    const writer = consoleImpl[level] || consoleImpl.log || console.log;
    writer.call(consoleImpl, `[aih:background:${component.id}] ${message}`);
  }

  function removeSignalHandlers() {
    if (typeof processObj.removeListener !== 'function') return;
    processObj.removeListener('SIGINT', onSigint);
    processObj.removeListener('SIGTERM', onSigterm);
  }

  function scheduleRestart(worker, error) {
    if (stopping || controller.signal.aborted) return;
    if (isBlockedError(error)) {
      logComponent(worker.component, 'error', `blocked: ${nonEmptyString(error.code || error.message)}`);
      return;
    }
    const delayMs = calculateReconnectDelay(worker.attempts, {
      reconnectDelayMs: Number(deps.restartDelayMs) || DEFAULT_RESTART_DELAY_MS,
      reconnectMaxDelayMs: Number(deps.restartMaxDelayMs) || DEFAULT_RESTART_MAX_DELAY_MS,
      reconnectJitterRatio: 0
    });
    logComponent(
      worker.component,
      'warn',
      `runtime stopped${error ? `: ${nonEmptyString(error.code || error.message)}` : ''}; restarting in ${delayMs}ms`
    );
    worker.timer = schedule(() => {
      worker.timer = null;
      startWorker(worker);
    }, delayMs);
    if (worker.timer && typeof worker.timer.unref === 'function') worker.timer.unref();
  }

  function startWorker(worker) {
    if (stopping || controller.signal.aborted || worker.timer) return;
    worker.attempts += 1;
    worker.promise = Promise.resolve()
      .then(() => runComponent(worker.component, controller.signal, deps))
      .then(
        () => scheduleRestart(worker, null),
        (error) => scheduleRestart(worker, error)
      );
  }

  async function stop(signal = 'shutdown') {
    if (stopPromise) return stopPromise;
    stopping = true;
    removeSignalHandlers();
    controller.abort(signal);
    for (const worker of workers.values()) {
      if (worker.timer) {
        cancelSchedule(worker.timer);
        worker.timer = null;
      }
    }
    stopPromise = (async () => {
      const shutdownTimeoutMs = Math.max(
        1,
        Number(deps.shutdownTimeoutMs) || DEFAULT_SHUTDOWN_TIMEOUT_MS
      );
      const serverShutdownTimeoutMs = Math.max(
        1,
        Number(deps.serverShutdownTimeoutMs) || DEFAULT_SERVER_SHUTDOWN_TIMEOUT_MS
      );
      const writer = consoleImpl.warn || consoleImpl.log || console.warn;
      const log = (message) => writer.call(consoleImpl, message);

      // 两段预算，不是一个：worker 卡住可以被放弃，server 的推理排空不行。
      // 两者**并发**启动（server 的停机必须立刻开始，不能被卡死的 worker 推迟），
      // 但各自持有独立的 deadline —— 这样"worker 挂死"不再让 server 的排空被截断。
      const workerTasks = Array.from(workers.values(), (worker) => worker.promise).filter(Boolean);
      const workerShutdown = workerTasks.length > 0
        ? raceWithDeadline(
          Promise.allSettled(workerTasks).then(() => 'settled'),
          shutdownTimeoutMs
        ).then((outcome) => {
          if (outcome === 'timeout') {
            log(`[aih:background] worker shutdown deadline reached after ${shutdownTimeoutMs}ms; abandoning ${workerTasks.length} background worker(s)`);
          }
          return outcome;
        })
        : Promise.resolve('settled');

      const serverShutdown = (serverHandle && typeof serverHandle.stop === 'function')
        ? raceWithDeadline(
          Promise.resolve().then(() => serverHandle.stop(signal)).then(() => 'settled'),
          serverShutdownTimeoutMs
        ).then((outcome) => {
          if (outcome === 'timeout') {
            log(`[aih:background] server shutdown deadline reached after ${serverShutdownTimeoutMs}ms; forcing exit with inference drain unfinished`);
          }
          return outcome;
        })
        : Promise.resolve('settled');

      await Promise.all([workerShutdown, serverShutdown]);
      resolveStopped();
    })();
    return stopPromise;
  }

  function onSigint() {
    void stop('SIGINT');
  }

  function onSigterm() {
    void stop('SIGTERM');
  }

  if (typeof processObj.once === 'function') {
    processObj.once('SIGINT', onSigint);
    processObj.once('SIGTERM', onSigterm);
  }

  try {
    if (typeof deps.startLocalServer !== 'function') {
      throw new Error('background_server_runtime_unavailable');
    }
    serverHandle = await deps.startLocalServer({
      ...resolveServerOptions(deps),
      manageProcessLifecycle: false
    });
    if (!serverHandle || typeof serverHandle.stop !== 'function') {
      throw new Error('background_server_lifecycle_unavailable');
    }
    for (const component of components) {
      if (component.id === 'server') continue;
      const worker = { component, attempts: 0, promise: null, timer: null };
      workers.set(component.id, worker);
      startWorker(worker);
    }
    const lifecycleWaiters = [stopped.then(() => 'stopped')];
    if (serverHandle.closed && typeof serverHandle.closed.then === 'function') {
      lifecycleWaiters.push(Promise.resolve(serverHandle.closed).then(() => 'server-closed'));
    }
    const lifecycleEvent = await Promise.race(lifecycleWaiters);
    if (lifecycleEvent === 'server-closed') {
      if (!stopping) {
        const error = new Error('background_server_stopped');
        error.code = 'background_server_stopped';
        await stop('server-closed');
        throw error;
      }
      await stopped;
    }
  } catch (error) {
    await stop('startup-error');
    throw error;
  } finally {
    removeSignalHandlers();
  }
}

module.exports = {
  BLOCKED_ERROR_CODES,
  DEFAULT_RESTART_DELAY_MS,
  DEFAULT_RESTART_MAX_DELAY_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_SERVER_SHUTDOWN_TIMEOUT_MS,
  componentType,
  runBackgroundSupervisor
};
