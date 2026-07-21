'use strict';

const nodePath = require('node:path');
const nodeOs = require('node:os');
const { isAccountRef } = require('../../../account/public-account-ref');
const persistentSession = require('../../../runtime/persistent-session');
const persistentSessionRegistry = require('../../../runtime/persistent-session-registry');
const { resolveAccountRuntimeDir } = require('../../../runtime/aih-storage-layout');

const NEW_SESSION_ACTIONS = new Set([
  'new',
  'new-compatible',
  'new-completed'
]);
const FORWARDED_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP']);

function shouldWrapPersistentProviderLaunch(context = {}) {
  return context.usesAuthProjection === true
    && context.gateway !== true
    && context.isLogin !== true
    && NEW_SESSION_ACTIONS.has(String(context.action || '').trim());
}

function createContextError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeSupervisorContext(raw = {}, pathImpl = nodePath) {
  const provider = String(raw.provider || '').trim().toLowerCase();
  const accountRef = String(raw.accountRef || '').trim();
  const runtimeDir = String(raw.runtimeDir || '').trim();
  const aiHomeDir = String(raw.aiHomeDir || '').trim();
  const hostHomeDir = String(raw.hostHomeDir || '').trim();
  const socket = String(raw.socket || '').trim();
  const session = String(raw.session || '').trim();
  const command = String(raw.command || '').trim();
  const args = Array.isArray(raw.args) ? raw.args.map((arg) => String(arg)) : [];

  if (!provider || !isAccountRef(accountRef)) {
    throw createContextError('persistent_provider_supervisor_identity_invalid');
  }
  if (
    !pathImpl.isAbsolute(runtimeDir)
    || !pathImpl.isAbsolute(aiHomeDir)
    || !pathImpl.isAbsolute(hostHomeDir)
  ) {
    throw createContextError('persistent_provider_supervisor_path_invalid');
  }
  const resolvedHostHomeDir = pathImpl.resolve(hostHomeDir);
  const resolvedAiHomeDir = pathImpl.resolve(aiHomeDir);
  const aiHomeRelative = pathImpl.relative(resolvedHostHomeDir, resolvedAiHomeDir);
  if (
    !aiHomeRelative
    || pathImpl.isAbsolute(aiHomeRelative)
    || aiHomeRelative === '..'
    || aiHomeRelative.startsWith(`..${pathImpl.sep}`)
  ) {
    throw createContextError('persistent_provider_supervisor_path_invalid');
  }
  const expectedRuntimeDir = resolveAccountRuntimeDir(aiHomeDir, provider, accountRef);
  if (!expectedRuntimeDir || pathImpl.resolve(runtimeDir) !== pathImpl.resolve(expectedRuntimeDir)) {
    throw createContextError('persistent_provider_supervisor_projection_invalid');
  }
  if (
    !persistentSession.isSafeSessionName(session)
    || !persistentSessionRegistry.entryFileName(socket, session)
    || socket !== persistentSession.deriveSocket(provider, accountRef)
  ) {
    throw createContextError('persistent_provider_supervisor_registry_invalid');
  }
  if (!command || args.some((arg) => arg.includes('\0'))) {
    throw createContextError('persistent_provider_supervisor_launch_invalid');
  }

  return {
    provider,
    accountRef,
    runtimeDir: pathImpl.resolve(runtimeDir),
    aiHomeDir: resolvedAiHomeDir,
    hostHomeDir: resolvedHostHomeDir,
    socket,
    session,
    command,
    args
  };
}

function buildPersistentProviderSupervisorLaunch(inner = {}, context = {}, options = {}) {
  const pathImpl = options.path || nodePath;
  const entryPath = String(options.entryPath || '').trim();
  const nodeExecPath = String(options.nodeExecPath || '').trim();
  if (
    !entryPath
    || !pathImpl.isAbsolute(entryPath)
    || !nodeExecPath
    || !pathImpl.isAbsolute(nodeExecPath)
  ) {
    throw createContextError('persistent_provider_supervisor_entry_invalid');
  }
  const normalized = normalizeSupervisorContext({
    ...context,
    command: inner.command,
    args: inner.args
  }, pathImpl);
  return {
    command: nodeExecPath,
    args: [
      entryPath,
      '--provider', normalized.provider,
      '--account-ref', normalized.accountRef,
      '--runtime-dir', normalized.runtimeDir,
      '--ai-home', normalized.aiHomeDir,
      '--host-home', normalized.hostHomeDir,
      '--socket', normalized.socket,
      '--session', normalized.session,
      '--', normalized.command,
      ...normalized.args
    ]
  };
}

function parsePersistentProviderSupervisorArgs(argv = [], options = {}) {
  const values = Array.isArray(argv) ? argv.map((value) => String(value)) : [];
  const separatorIndex = values.indexOf('--');
  if (separatorIndex < 0 || separatorIndex >= values.length - 1) {
    throw createContextError('persistent_provider_supervisor_argv_invalid');
  }
  const metadata = {};
  const flags = {
    '--provider': 'provider',
    '--account-ref': 'accountRef',
    '--runtime-dir': 'runtimeDir',
    '--ai-home': 'aiHomeDir',
    '--host-home': 'hostHomeDir',
    '--socket': 'socket',
    '--session': 'session'
  };
  for (let index = 0; index < separatorIndex; index += 2) {
    const field = flags[values[index]];
    const value = values[index + 1];
    if (!field || typeof value === 'undefined' || Object.prototype.hasOwnProperty.call(metadata, field)) {
      throw createContextError('persistent_provider_supervisor_argv_invalid');
    }
    metadata[field] = value;
  }
  const command = values[separatorIndex + 1];
  const args = values.slice(separatorIndex + 2);
  return normalizeSupervisorContext({ ...metadata, command, args }, options.path || nodePath);
}

function childExitCode(exitCode, signal, signalNumbers = nodeOs.constants.signals) {
  if (Number.isInteger(exitCode)) return Math.max(0, exitCode);
  const signalNumber = Number(signalNumbers && signalNumbers[signal]) || 0;
  return signalNumber > 0 ? 128 + signalNumber : 1;
}

function combineCleanupErrors(errors) {
  const list = errors.filter(Boolean);
  if (list.length === 0) return null;
  const detail = list
    .map((error) => String((error && error.message) || error || 'unknown_error'))
    .join('; ');
  const combined = new Error(`persistent_provider_cleanup_failed:${detail}`);
  combined.code = 'persistent_provider_cleanup_failed';
  combined.errors = list;
  return combined;
}

function writeSupervisorError(processObj, error) {
  const message = String((error && error.message) || error || 'unknown_error');
  try {
    if (processObj && processObj.stderr && typeof processObj.stderr.write === 'function') {
      processObj.stderr.write(`\n[aih] Persistent provider cleanup failed: ${message}\n`);
    }
  } catch (_error) {}
}

function runPersistentProviderSupervisor(rawContext = {}, dependencies = {}) {
  const context = normalizeSupervisorContext(rawContext, dependencies.path || nodePath);
  const processObj = dependencies.processObj || process;
  const spawn = dependencies.spawn || require('node:child_process').spawn;
  const captureAuth = dependencies.captureAuth;
  const reconcileResources = dependencies.reconcileResources;
  const removeRegistry = dependencies.removeRegistry;
  if (
    typeof captureAuth !== 'function'
    || typeof reconcileResources !== 'function'
    || typeof removeRegistry !== 'function'
  ) {
    throw createContextError('persistent_provider_supervisor_dependencies_invalid');
  }

  let child;
  try {
    child = spawn(context.command, context.args, {
      cwd: processObj.cwd(),
      env: processObj.env,
      stdio: 'inherit'
    });
  } catch (error) {
    processObj.exitCode = 1;
    writeSupervisorError(processObj, error);
    return Promise.resolve({ exitCode: 1, error });
  }

  return new Promise((resolve) => {
    let settled = false;
    const installedSignals = [];
    const finish = (result) => {
      if (settled) return;
      settled = true;
      for (const [signal, handler] of installedSignals) {
        try { processObj.removeListener(signal, handler); } catch (_error) {}
      }
      processObj.exitCode = result.exitCode;
      resolve(result);
    };

    for (const signal of FORWARDED_SIGNALS) {
      if (!processObj || typeof processObj.on !== 'function') continue;
      const handler = () => {
        try { child.kill(signal); } catch (_error) {}
      };
      try {
        processObj.on(signal, handler);
        installedSignals.push([signal, handler]);
      } catch (_error) {}
    }

    child.once('error', (error) => {
      writeSupervisorError(processObj, error);
      finish({ exitCode: 1, error });
    });
    child.once('close', async (exitCode, signal) => {
      if (settled) return;
      const cleanupErrors = [];
      try {
        await captureAuth(context);
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await reconcileResources(context);
      } catch (error) {
        cleanupErrors.push(error);
      }
      let cleanupError = combineCleanupErrors(cleanupErrors);
      if (!cleanupError) {
        try {
          const removed = await removeRegistry(context);
          if (removed === false) {
            throw createContextError('persistent_provider_registry_remove_failed');
          }
        } catch (error) {
          cleanupError = combineCleanupErrors([error]);
        }
      }
      if (cleanupError) writeSupervisorError(processObj, cleanupError);
      finish({
        exitCode: cleanupError
          ? 1
          : childExitCode(exitCode, signal, dependencies.signalNumbers),
        childExitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: String(signal || ''),
        error: cleanupError
      });
    });
  });
}

module.exports = {
  FORWARDED_SIGNALS,
  NEW_SESSION_ACTIONS,
  buildPersistentProviderSupervisorLaunch,
  normalizeSupervisorContext,
  parsePersistentProviderSupervisorArgs,
  runPersistentProviderSupervisor,
  shouldWrapPersistentProviderLaunch
};
