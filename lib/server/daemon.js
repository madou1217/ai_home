'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { createServerDaemonService } = require('../cli/services/server/daemon');

function buildProcessObject(options) {
  const processObj = options.processObj || process;
  const nodeExecPath = options.nodeExecPath || processObj.execPath || process.execPath;
  return {
    ...processObj,
    execPath: nodeExecPath,
    env: processObj.env || process.env,
    platform: processObj.platform || process.platform,
    kill: typeof processObj.kill === 'function' ? processObj.kill.bind(processObj) : process.kill.bind(process)
  };
}

function buildAppliedConfig(parsed) {
  const cfg = parsed || {};
  return {
    host: cfg.host,
    port: cfg.port,
    codexBaseUrl: cfg.codexBaseUrl,
    geminiBaseUrl: cfg.geminiBaseUrl,
    claudeBaseUrl: cfg.claudeBaseUrl,
    codexModels: cfg.codexModels,
    proxyUrl: cfg.proxyUrl,
    noProxy: cfg.noProxy,
    strategy: cfg.strategy,
    backend: cfg.backend,
    provider: cfg.provider,
    cooldownMs: cfg.cooldownMs,
    upstreamTimeoutMs: cfg.upstreamTimeoutMs,
    maxAttempts: cfg.maxAttempts,
    modelsCacheTtlMs: cfg.modelsCacheTtlMs,
    modelsProbeAccounts: cfg.modelsProbeAccounts,
    failureThreshold: cfg.failureThreshold,
    logRequests: cfg.logRequests,
    codexMaxConcurrency: cfg.codexMaxConcurrency,
    geminiMaxConcurrency: cfg.geminiMaxConcurrency,
    claudeMaxConcurrency: cfg.claudeMaxConcurrency,
    agyMaxConcurrency: cfg.agyMaxConcurrency,
    opencodeMaxConcurrency: cfg.opencodeMaxConcurrency,
    queueLimit: cfg.queueLimit,
    clientKeyConfigured: Boolean(cfg.clientKey),
    managementKeyConfigured: Boolean(cfg.managementKey)
  };
}

function parseAppliedConfig(parseServeArgs, rawServeArgs) {
  try {
    return buildAppliedConfig(parseServeArgs(rawServeArgs || []));
  } catch (_error) {
    return {};
  }
}

function normalizeRestartOptions(options = {}) {
  if (!options || typeof options !== 'object') return {};
  if (!options.startOptions && !options.stopOptions) return options;
  return {
    ...(options.startOptions || {}),
    gracefulStopWaitMs: Number(
      options.stopOptions && options.stopOptions.gracefulStopWaitMs
    ) || Number(options.gracefulStopWaitMs) || 500
  };
}

function createServerDaemonController(opts) {
  const options = opts || {};
  const parseServeArgs = options.parseServeArgs || options.parseServerServeArgs;
  if (typeof parseServeArgs !== 'function') throw new Error('server_daemon_missing_parseProxyServeArgs');

  const service = createServerDaemonService({
    fs: options.fs || fs,
    path: options.path || path,
    spawn: options.spawn || spawn,
    spawnSync: options.spawnSync || spawnSync,
    fetchImpl: options.fetchImpl,
    processObj: buildProcessObject(options),
    ensureDir: options.ensureDir,
    parseServeArgs,
    readServerConfig: options.readServerConfig,
    buildServerArgsFromConfig: options.buildServerArgsFromConfig,
    aiHomeDir: options.aiHomeDir,
    hostHomeDir: options.hostHomeDir,
    pidFile: options.pidFile,
    logFile: options.logFile,
    launchdLabel: options.launchdLabel,
    launchdPlist: options.launchdPlist,
    entryFilePath: options.entryFilePath || options.entryScriptPath,
    defaultPort: options.defaultPort
  });

  async function start(rawServeArgs, startOptions) {
    const result = await service.start(rawServeArgs || [], startOptions || {});
    return {
      ...result,
      appliedConfig: parseAppliedConfig(parseServeArgs, rawServeArgs)
    };
  }

  async function restart(rawServeArgs, restartOptions = {}) {
    const result = await service.restart(rawServeArgs || [], normalizeRestartOptions(restartOptions));
    return {
      ...result,
      stopped: result.stoppedForRestart,
      running: Boolean(result.started || result.alreadyRunning),
      appliedConfig: parseAppliedConfig(parseServeArgs, rawServeArgs)
    };
  }

  return {
    start,
    restart,
    stop: service.stop,
    status: service.getStatus,
    autostartStatus: service.getAutostartStatus,
    installAutostart: service.installAutostart,
    uninstallAutostart: service.uninstallAutostart
  };
}

module.exports = {
  createServerDaemonController
};
