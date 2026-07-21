'use strict';

const { calculateReconnectDelay } = require('../../../runtime/reconnect-backoff');
const { runFabricRegistryAgent } = require('../fabric/registry-agent');
const { runNodeRelayConnect } = require('../node/relay-client');
const { runNodeWebrtcConnect } = require('../node/webrtc-client');
const {
  listEffectiveBackgroundComponents,
  readBackgroundSupervisorState
} = require('./supervisor-state-store');

const DEFAULT_RESTART_DELAY_MS = 1000;
const DEFAULT_RESTART_MAX_DELAY_MS = 30000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15000;

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
    delete env.AIH_MANAGEMENT_KEY;
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
      const cleanupTasks = Array.from(workers.values(), (worker) => worker.promise).filter(Boolean);
      if (serverHandle && typeof serverHandle.stop === 'function') {
        cleanupTasks.push(Promise.resolve().then(() => serverHandle.stop(signal)));
      }
      const shutdownTimeoutMs = Math.max(
        1,
        Number(deps.shutdownTimeoutMs) || DEFAULT_SHUTDOWN_TIMEOUT_MS
      );
      let timeout = null;
      const deadline = new Promise((resolve) => {
        timeout = scheduleShutdown(() => resolve('timeout'), shutdownTimeoutMs);
        if (timeout && typeof timeout.unref === 'function') timeout.unref();
      });
      const outcome = await Promise.race([
        Promise.allSettled(cleanupTasks).then(() => 'settled'),
        deadline
      ]);
      if (timeout) cancelShutdown(timeout);
      if (outcome === 'timeout') {
        const writer = consoleImpl.warn || consoleImpl.log || console.warn;
        writer.call(consoleImpl, `[aih:background] shutdown deadline reached after ${shutdownTimeoutMs}ms`);
      }
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
  componentType,
  runBackgroundSupervisor
};
