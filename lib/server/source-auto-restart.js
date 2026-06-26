'use strict';

const {
  computeSourceFingerprint,
  getSourceFingerprintFilePath,
  writeRecordedSourceFingerprint
} = require('./source-fingerprint');

function noopController(reason = 'disabled') {
  return {
    enabled: false,
    reason,
    stop() {},
    checkOnce() {
      return { stale: false, reason };
    }
  };
}

function envValue(processObj, key) {
  const env = processObj && processObj.env ? processObj.env : process.env;
  return String(env && env[key] || '').trim();
}

function shouldEnableSourceAutoRestart(processObj) {
  if (envValue(processObj, 'AIH_SERVER_DISABLE_SOURCE_AUTO_RESTART') === '1') return false;
  return envValue(processObj, 'AIH_SERVER_SOURCE_AUTO_RESTART') !== '0';
}

function extractServeArgsFromArgv(argv) {
  const args = Array.isArray(argv) ? argv.map((item) => String(item || '')) : [];
  const serverIndex = args.findIndex((item) => item === 'server');
  if (serverIndex < 0) return [];
  const serveIndex = args.findIndex((item, index) => index > serverIndex && item === 'serve');
  if (serveIndex < 0) return [];
  return args.slice(serveIndex + 1).filter((item) => item !== '');
}

function pushStringOption(args, name, value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) return;
  args.push(name, text);
}

function pushNumberOption(args, name, value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return;
  args.push(name, String(Math.round(num)));
}

function hasOption(args, name) {
  return Array.isArray(args) && args.some((item) => String(item || '') === name);
}

function pushStringOptionIfMissing(args, name, value) {
  if (hasOption(args, name)) return;
  pushStringOption(args, name, value);
}

function pushNumberOptionIfMissing(args, name, value) {
  if (hasOption(args, name)) return;
  pushNumberOption(args, name, value);
}

function buildServeArgsFromOptions(options = {}) {
  const args = [];
  pushStringOption(args, '--host', options.host);
  pushNumberOption(args, '--port', options.port);
  pushStringOption(args, '--api-key', options.apiKey || options.clientKey);
  pushStringOption(args, '--management-key', options.managementKey);
  pushStringOption(args, '--proxy-url', options.proxyUrl);
  pushStringOption(args, '--no-proxy', options.noProxy);
  pushNumberOption(args, '--models-probe-accounts', options.modelsProbeAccounts);
  return args;
}

function appendRestartServeArgsFromOptions(args, options = {}) {
  const next = Array.isArray(args) ? args.slice() : [];
  pushStringOptionIfMissing(next, '--proxy-url', options.proxyUrl);
  pushStringOptionIfMissing(next, '--no-proxy', options.noProxy);
  pushNumberOptionIfMissing(next, '--models-probe-accounts', options.modelsProbeAccounts);
  return next;
}

function buildRestartServeArgs(options = {}, processObj) {
  const argvArgs = extractServeArgsFromArgv(processObj && processObj.argv);
  return argvArgs.length > 0
    ? appendRestartServeArgsFromOptions(argvArgs, options)
    : buildServeArgsFromOptions(options);
}

function startServerSourceAutoRestart(options = {}, deps = {}) {
  const fs = deps.fs;
  const path = deps.path;
  const spawn = deps.spawn;
  const processObj = deps.processObj || process;
  const aiHomeDir = deps.aiHomeDir;
  const entryFilePath = deps.entryFilePath;
  const nodeExecPath = deps.nodeExecPath || (processObj && processObj.execPath) || process.execPath;

  if (!fs || !path || typeof spawn !== 'function' || !aiHomeDir || !entryFilePath) {
    return noopController('missing_source_auto_restart_deps');
  }

  try {
    if (typeof fs.mkdirSync === 'function') fs.mkdirSync(aiHomeDir, { recursive: true });
  } catch (_error) {}

  const sourceFingerprintFile = getSourceFingerprintFilePath(path, aiHomeDir);
  const pid = Number(processObj && processObj.pid) || process.pid;
  writeRecordedSourceFingerprint(fs, path, sourceFingerprintFile, pid, entryFilePath);

  const startupFingerprint = computeSourceFingerprint(fs, path, entryFilePath);
  if (!startupFingerprint.fingerprint) {
    return noopController('source_fingerprint_unavailable');
  }

  let lastFingerprint = startupFingerprint.fingerprint;
  let restartRequested = false;
  let timer = null;

  function requestRestart(reason) {
    if (restartRequested) return { requested: false, reason: 'restart_already_requested' };
    restartRequested = true;
    const serveArgs = buildRestartServeArgs(options, processObj);
    const restartArgs = [entryFilePath, 'server', 'restart', ...serveArgs];
    console.log(`\x1b[36m[aih]\x1b[0m server source changed (${reason || 'source_changed'}), restarting local aih server...`);
    try {
      const child = spawn(nodeExecPath, restartArgs, {
        detached: true,
        stdio: 'ignore',
        env: processObj.env || process.env
      });
      if (child && typeof child.unref === 'function') child.unref();
      return { requested: true, pid: child && child.pid, args: restartArgs };
    } catch (error) {
      restartRequested = false;
      const message = String((error && error.message) || error || 'unknown_error');
      console.warn(`\x1b[33m[aih]\x1b[0m source auto-restart failed: ${message}`);
      return { requested: false, reason: message };
    }
  }

  function checkOnce() {
    if (restartRequested) return { stale: true, reason: 'restart_already_requested' };
    const current = computeSourceFingerprint(fs, path, entryFilePath);
    if (!current.fingerprint) return { stale: false, reason: 'source_fingerprint_unavailable' };
    if (current.fingerprint === lastFingerprint) return { stale: false, reason: '' };
    const restart = requestRestart('source_changed');
    lastFingerprint = current.fingerprint;
    return {
      stale: true,
      reason: 'source_changed',
      restart
    };
  }

  if (shouldEnableSourceAutoRestart(processObj)) {
    const intervalMs = Math.max(
      500,
      Number(envValue(processObj, 'AIH_SERVER_SOURCE_AUTO_RESTART_INTERVAL_MS')) || Number(options.sourceAutoRestartIntervalMs) || 1000
    );
    timer = setInterval(checkOnce, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    enabled: Boolean(timer),
    reason: timer ? '' : 'disabled',
    startupFingerprint: startupFingerprint.fingerprint,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    checkOnce
  };
}

module.exports = {
  buildRestartServeArgs,
  buildServeArgsFromOptions,
  extractServeArgsFromArgv,
  startServerSourceAutoRestart
};
