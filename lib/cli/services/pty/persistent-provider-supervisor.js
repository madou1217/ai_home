'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const nodeOs = require('node:os');
const { isAccountRef } = require('../../../account/public-account-ref');
const persistentSession = require('../../../runtime/persistent-session');
const persistentSessionRegistry = require('../../../runtime/persistent-session-registry');
const { resolveAccountRuntimeDir } = require('../../../runtime/aih-storage-layout');
const { isTransientAuthProjection } = require('../../../runtime/transient-auth-projection');

const NEW_SESSION_ACTIONS = new Set([
  'new',
  'new-compatible',
  'new-completed'
]);
const FORWARDED_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP']);
const DEFAULT_PROVIDER_TERMINATION_SETTLE_MS = 250;

function resolveProviderTerminationSignal(signal) {
  // Closing a tmux pane delivers SIGHUP to the foreground process group.
  // Codex can keep its native descendant alive after that signal, so convert
  // the pane lifecycle event into the conventional graceful-termination
  // signal while preserving SIGHUP as the supervisor's public exit reason.
  return signal === 'SIGHUP' ? 'SIGTERM' : signal;
}

function canSignalProviderProcessGroup(processObj) {
  return String(processObj && processObj.platform || process.platform).toLowerCase() !== 'win32'
    && Number.isInteger(Number(processObj && processObj.pid))
    && Number(processObj.pid) > 0
    && typeof processObj.kill === 'function';
}

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
  const isCanonicalRuntime = expectedRuntimeDir
    && pathImpl.resolve(runtimeDir) === pathImpl.resolve(expectedRuntimeDir);
  if (!isCanonicalRuntime && !isTransientAuthProjection(
    nodeFs,
    runtimeDir,
    provider,
    accountRef,
    { path: pathImpl }
  )) {
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
      '--no-warnings',
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

function combineSupervisorErrors(terminationError, cleanupError) {
  if (!terminationError) return cleanupError || null;
  if (!cleanupError) return terminationError;
  const detail = [terminationError, cleanupError]
    .map((error) => String((error && error.message) || error || 'unknown_error'))
    .join('; ');
  const combined = new Error(`persistent_provider_supervisor_failed:${detail}`);
  combined.code = 'persistent_provider_supervisor_failed';
  combined.errors = [terminationError, cleanupError];
  combined.cause = terminationError;
  combined.cleanupError = cleanupError;
  return combined;
}

function writeSupervisorError(dependencies, error) {
  const message = String((error && error.message) || error || 'unknown_error');
  const output = `\n[aih] Persistent provider supervisor failed: ${message}\n`;
  if (dependencies && typeof dependencies.writeError === 'function') {
    try {
      dependencies.writeError(output);
      return;
    } catch (_error) {}
  }
  const processObj = dependencies && dependencies.processObj;
  try {
    if (processObj && processObj.stderr && typeof processObj.stderr.write === 'function') {
      processObj.stderr.write(output);
    }
  } catch (_error) {}
}

function waitForProviderTerminationSettle(dependencies = {}) {
  if (typeof dependencies.waitForTerminationSettle === 'function') {
    return Promise.resolve(dependencies.waitForTerminationSettle());
  }
  const configured = Number(dependencies.terminationSettleMs);
  const delayMs = Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_PROVIDER_TERMINATION_SETTLE_MS;
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function finalizePersistentProviderRun(context, dependencies, termination = {}) {
  const cleanupErrors = [];
  try {
    await dependencies.captureAuth(context);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await dependencies.reconcileResources(context);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length === 0) {
    try {
      await dependencies.removeProjection(context);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  let cleanupError = combineCleanupErrors(cleanupErrors);
  if (!cleanupError) {
    try {
      const removed = await dependencies.removeRegistry(context);
      if (removed === false) {
        throw createContextError('persistent_provider_registry_remove_failed');
      }
    } catch (error) {
      cleanupError = combineCleanupErrors([error]);
    }
  }

  const terminationError = termination.error || null;
  const error = combineSupervisorErrors(terminationError, cleanupError);
  if (error) writeSupervisorError(dependencies, error);
  const result = {
    exitCode: error
      ? 1
      : childExitCode(termination.exitCode, termination.signal, dependencies.signalNumbers),
    childExitCode: Number.isInteger(termination.exitCode) ? termination.exitCode : null,
    signal: String(termination.signal || ''),
    error
  };
  dependencies.processObj.exitCode = result.exitCode;
  return result;
}

function runPersistentProviderSupervisor(rawContext = {}, dependencies = {}) {
  const context = normalizeSupervisorContext(rawContext, dependencies.path || nodePath);
  const processObj = dependencies.processObj || process;
  const spawn = dependencies.spawn || require('node:child_process').spawn;
  const captureAuth = dependencies.captureAuth;
  const reconcileResources = dependencies.reconcileResources;
  const removeProjection = dependencies.removeProjection;
  const removeRegistry = dependencies.removeRegistry;
  if (
    typeof captureAuth !== 'function'
    || typeof reconcileResources !== 'function'
    || typeof removeProjection !== 'function'
    || typeof removeRegistry !== 'function'
  ) {
    throw createContextError('persistent_provider_supervisor_dependencies_invalid');
  }
  const finalizerDependencies = {
    ...dependencies,
    processObj,
    captureAuth,
    reconcileResources,
    removeProjection,
    removeRegistry
  };

  let child;
  try {
    child = spawn(context.command, context.args, {
      cwd: processObj.cwd(),
      env: processObj.env,
      stdio: 'inherit'
    });
  } catch (error) {
    return finalizePersistentProviderRun(context, finalizerDependencies, { error });
  }

  return new Promise((resolve) => {
    let settled = false;
    let finalizing = false;
    let childError = null;
    let requestedTerminationSignal = '';
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
    const finalize = (termination) => {
      if (finalizing) return;
      finalizing = true;
      finalizePersistentProviderRun(context, finalizerDependencies, termination).then(finish, (error) => {
        writeSupervisorError(finalizerDependencies, error);
        finish({ exitCode: 1, childExitCode: null, signal: '', error });
      });
    };

    for (const signal of FORWARDED_SIGNALS) {
      if (!processObj || typeof processObj.on !== 'function') continue;
      const handler = () => {
        // The process-group broadcast below is delivered back to the
        // supervisor itself on POSIX. Treat the first signal as the lifecycle
        // intent and consume every later group echo without rebroadcasting.
        if (requestedTerminationSignal) return;
        requestedTerminationSignal = signal;
        const forwardedSignal = resolveProviderTerminationSignal(signal);
        if (canSignalProviderProcessGroup(processObj)) {
          try {
            processObj.kill(-Number(processObj.pid), forwardedSignal);
            return;
          } catch (_error) {}
        }
        try { child.kill(forwardedSignal); } catch (_error) {}
      };
      try {
        processObj.on(signal, handler);
        installedSignals.push([signal, handler]);
      } catch (_error) {}
    }

    child.once('error', (error) => {
      childError = error;
    });
    child.once('close', (exitCode, signal) => {
      const termination = {
        exitCode,
        signal: requestedTerminationSignal || signal,
        error: childError
      };
      if (!requestedTerminationSignal) {
        finalize(termination);
        return;
      }
      waitForProviderTerminationSettle(finalizerDependencies).then(
        () => finalize(termination),
        (error) => finalize({
          ...termination,
          error: combineSupervisorErrors(childError, error)
        })
      );
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
