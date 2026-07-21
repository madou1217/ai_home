'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const {
  AIH_FRP_NAME_PREFIX,
  DEFAULT_LOCAL_SERVER_PORT,
  DEFAULT_WEB_SERVER_PORT,
  assertAihOwnedName,
  normalizeFragmentOptions,
  normalizeManagedRouteIdentity,
  prepareFrpcMainConfig,
  renderAihFrpcFragment
} = require('./frp-config-document');
const { createFrpError } = require('./frp-config-errors');
const {
  emptyDesiredFrpState,
  normalizeDesiredFrpRoute,
  parseDesiredFrpState,
  removeDesiredFrpRoute,
  renderDesiredFrpState,
  resolveDesiredFrpStatePath,
  upsertDesiredFrpRoute
} = require('./frp-config-state');
const {
  acquireConfigLock,
  atomicWritePrivate,
  buildDefaultFrpcConfigCandidates,
  discoverFrpcConfigPath,
  isModePrivate,
  resolveHome,
  rollbackFiles,
  snapshotFile
} = require('./frp-config-files');

const DEFAULT_FRP_PROCESS_TIMEOUT_MS = 30_000;
const MAX_FRP_PROCESS_TIMEOUT_MS = 120_000;

function defaultRunProcess(command, args, options = {}) {
  const requestedTimeout = Number(options.timeout);
  const timeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.min(Math.floor(requestedTimeout), MAX_FRP_PROCESS_TIMEOUT_MS)
    : DEFAULT_FRP_PROCESS_TIMEOUT_MS;
  return childProcess.spawnSync(command, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    ...options,
    timeout,
    killSignal: options.killSignal || 'SIGKILL'
  });
}

function defaultRunFrpc(args, context = {}, deps = {}) {
  const runProcess = deps.runProcess || defaultRunProcess;
  return runProcess(context.frpcBinary || deps.frpcBinary || 'frpc', args, { cwd: context.cwd });
}

function defaultRestartFrpc(context = {}, deps = {}) {
  const runProcess = deps.runProcess || defaultRunProcess;
  const platform = deps.platform || process.platform;
  if (Array.isArray(context.restartCommand) && context.restartCommand.length > 0) {
    return runProcess(context.restartCommand[0], context.restartCommand.slice(1));
  }
  if (platform === 'darwin') return runProcess('brew', ['services', 'restart', 'frpc']);
  if (platform === 'linux') return runProcess('systemctl', ['--user', 'restart', 'frpc']);
  throw createFrpError('frp_restart_unavailable', 'Automatic frpc restart is not configured for this platform');
}

async function callOperation(operation, args) {
  try {
    return await operation(...args);
  } catch (error) {
    return { status: 1, stdout: '', stderr: String(error && error.message || error), cause: error };
  }
}

function operationSucceeded(result) {
  return Boolean(result) && (result.ok === true || result.status === 0 || result.code === 0);
}

function secretRepresentations(secrets) {
  const values = Array.isArray(secrets) ? secrets : [secrets];
  const representations = new Set();
  for (const value of values) {
    const secret = String(value || '');
    if (!secret) continue;
    representations.add(secret);
    const encoded = JSON.stringify(secret);
    representations.add(encoded);
    if (encoded.length >= 2) representations.add(encoded.slice(1, -1));
  }
  return Array.from(representations).sort((left, right) => right.length - left.length);
}

function redact(value, secrets) {
  let text = String(value == null ? '' : value);
  for (const secret of secretRepresentations(secrets)) {
    text = text.split(secret).join('<redacted>');
  }
  return text;
}

function operationError(code, label, result, secrets) {
  return createFrpError(code, `${label} failed`, {
    stdout: redact(result && result.stdout, secrets),
    stderr: redact(result && result.stderr, secrets)
  });
}

async function runFrpcStep(args, context, deps) {
  const runFrpc = deps.runFrpc
    ? deps.runFrpc
    : (stepArgs, stepContext) => defaultRunFrpc(stepArgs, stepContext, deps);
  return callOperation(runFrpc, [args, context]);
}

async function runRestartStep(context, deps) {
  const restartFrpc = deps.restartFrpc
    ? deps.restartFrpc
    : (stepContext) => defaultRestartFrpc(stepContext, deps);
  return callOperation(restartFrpc, [context]);
}

async function recoverRuntime(action, context, deps, secrets) {
  const result = action === 'restart'
    ? await runRestartStep(context, deps)
    : await runFrpcStep(['reload', '-c', context.configPath], context, deps);
  return {
    ok: operationSucceeded(result),
    stderr: redact(result && result.stderr, secrets)
  };
}

function resolveAiHomeDir(options, deps) {
  const pathImpl = deps.path || path;
  const env = deps.env || process.env;
  const home = resolveHome(deps);
  return String(options.aiHomeDir || env.AIH_HOME || env.AI_HOME || '').trim()
    || pathImpl.join(home, '.ai_home');
}

function resolveManagedPaths(options, normalized, deps) {
  const pathImpl = deps.path || path;
  const aiHomeDir = resolveAiHomeDir(options, deps);
  const fragmentDir = pathImpl.join(aiHomeDir, 'frp', 'frpc.d');
  return {
    aiHomeDir,
    fragmentDir,
    desiredStatePath: resolveDesiredFrpStatePath(aiHomeDir, { path: pathImpl }),
    includePattern: pathImpl.join(fragmentDir, '*.toml'),
    fragmentPath: pathImpl.join(
      fragmentDir,
      `${AIH_FRP_NAME_PREFIX}${normalized.serverId}-${normalized.role}.toml`
    )
  };
}

function readDesiredState(aiHomeDir, deps) {
  const fsImpl = deps.fs || fs;
  const pathImpl = deps.path || path;
  const desiredStatePath = resolveDesiredFrpStatePath(aiHomeDir, { path: pathImpl });
  const snapshot = snapshotFile(fsImpl, desiredStatePath);
  return {
    desiredStatePath,
    snapshot,
    state: snapshot.exists
      ? parseDesiredFrpState(snapshot.content.toString('utf8'))
      : emptyDesiredFrpState()
  };
}

function hardenDesiredState(aiHomeDir, deps) {
  const fsImpl = deps.fs || fs;
  const pathImpl = deps.path || path;
  let current = readDesiredState(aiHomeDir, deps);
  if (!current.snapshot.exists || isModePrivate(fsImpl, current.desiredStatePath)) return current.state;
  const lock = acquireConfigLock({ aiHomeDir }, deps);
  try {
    current = readDesiredState(aiHomeDir, deps);
    if (current.snapshot.exists && !isModePrivate(fsImpl, current.desiredStatePath)) {
      atomicWritePrivate(
        fsImpl,
        pathImpl,
        current.desiredStatePath,
        renderDesiredFrpState(current.state),
        deps
      );
    }
    return current.state;
  } finally {
    lock.release();
  }
}

function publicApplyReport(plan, dryRun) {
  return {
    ok: true,
    dryRun: Boolean(dryRun),
    configPath: plan.configPath,
    fragmentPath: plan.fragmentPath,
    serverId: plan.normalized.serverId,
    role: plan.normalized.role,
    proxyName: plan.normalized.proxyName,
    action: plan.action,
    changes: {
      main: plan.mainContentChanged,
      fragment: plan.fragmentContentChanged,
      permissions: plan.mainPermissionChanged
        || plan.fragmentPermissionChanged
        || plan.desiredStatePermissionChanged
    }
  };
}

function buildApplyPlan(options, normalized, configPath, managedPaths, deps) {
  const fsImpl = deps.fs || fs;
  const mainSnapshot = snapshotFile(fsImpl, configPath);
  const fragmentSnapshot = snapshotFile(fsImpl, managedPaths.fragmentPath);
  const desiredStateSnapshot = snapshotFile(fsImpl, managedPaths.desiredStatePath);
  const mainOriginal = mainSnapshot.content.toString('utf8');
  const preparedMain = prepareFrpcMainConfig(mainOriginal, {
    includePattern: managedPaths.includePattern,
    webServerPort: options.webServerPort
  });
  const fragmentContent = renderAihFrpcFragment(options);
  const previousFragment = fragmentSnapshot.exists
    ? fragmentSnapshot.content.toString('utf8')
    : '';
  const desiredState = desiredStateSnapshot.exists
    ? parseDesiredFrpState(desiredStateSnapshot.content.toString('utf8'))
    : emptyDesiredFrpState();
  const previousDesiredRoute = desiredState.routes.find((route) => (
    route.role === normalized.role && route.serverId === normalized.serverId
  ));
  const desiredRoute = normalizeDesiredFrpRoute({
    ...options,
    ...normalized,
    configPath
  });
  const nextDesiredStateContent = renderDesiredFrpState(
    upsertDesiredFrpRoute(desiredState, desiredRoute)
  );
  const previousDesiredState = desiredStateSnapshot.exists
    ? desiredStateSnapshot.content.toString('utf8')
    : '';
  const mainContentChanged = preparedMain.content !== mainOriginal;
  const fragmentContentChanged = fragmentContent !== previousFragment;
  const desiredStateContentChanged = nextDesiredStateContent !== previousDesiredState;
  const mainPermissionChanged = !isModePrivate(fsImpl, configPath);
  const fragmentPermissionChanged = !isModePrivate(fsImpl, managedPaths.fragmentPath);
  const desiredStatePermissionChanged = !isModePrivate(fsImpl, managedPaths.desiredStatePath);
  const mainNeedsWrite = mainContentChanged || mainPermissionChanged;
  const fragmentNeedsWrite = fragmentContentChanged || fragmentPermissionChanged;
  const desiredStateNeedsWrite = desiredStateContentChanged || desiredStatePermissionChanged;
  const action = mainContentChanged
    ? 'restart'
    : (fragmentContentChanged ? 'reload' : 'none');
  return {
    ...managedPaths,
    configPath,
    normalized,
    redactionSecrets: [normalized.secretKey, previousDesiredRoute && previousDesiredRoute.secretKey],
    action,
    mainContentChanged,
    fragmentContentChanged,
    desiredStateContentChanged,
    mainPermissionChanged,
    fragmentPermissionChanged,
    desiredStatePermissionChanged,
    mainNeedsWrite,
    fragmentNeedsWrite,
    desiredStateNeedsWrite,
    mainSnapshot,
    fragmentSnapshot,
    desiredStateSnapshot,
    preparedMain,
    fragmentContent,
    nextDesiredStateContent
  };
}

function buildActivationContext(plan) {
  const normalized = plan.normalized;
  const common = {
    role: normalized.role,
    serverId: normalized.serverId,
    proxyName: normalized.proxyName,
    action: plan.action
  };
  return normalized.role === 'provider'
    ? {
      ...common,
      localIP: normalized.localIP,
      localPort: normalized.localPort
    }
    : {
      ...common,
      visitorName: normalized.visitorName,
      bindAddr: normalized.bindAddr,
      bindPort: normalized.bindPort
    };
}

async function rollbackFailedActivation(plan, operationContext, snapshots, cause, deps) {
  const fsImpl = deps.fs || fs;
  const pathImpl = deps.path || path;
  const files = rollbackFiles(fsImpl, pathImpl, snapshots, deps);
  const runtime = plan.action === 'none'
    ? { ok: true, stderr: '' }
    : await recoverRuntime(plan.action, operationContext, deps, plan.redactionSecrets);
  throw createFrpError(
    'frp_activation_validation_failed',
    'FRP activation validation failed',
    {
      validationCode: String(cause && cause.code || 'frp_activation_validation_failed'),
      rollback: {
        ok: files.ok && runtime.ok,
        files,
        runtime
      }
    }
  );
}

async function executeApplyPlan(plan, options, deps) {
  const fsImpl = deps.fs || fs;
  const pathImpl = deps.path || path;
  const report = publicApplyReport(plan, false);
  const validateActivation = typeof options.validateActivation === 'function'
    ? options.validateActivation
    : null;
  if (!plan.mainNeedsWrite
    && !plan.fragmentNeedsWrite
    && !plan.desiredStateNeedsWrite
    && !plan.forceRuntimeApply
    && !validateActivation) return report;

  const snapshots = [plan.mainSnapshot, plan.fragmentSnapshot, plan.desiredStateSnapshot];
  try {
    if (plan.desiredStateNeedsWrite) {
      atomicWritePrivate(
        fsImpl,
        pathImpl,
        plan.desiredStatePath,
        plan.nextDesiredStateContent,
        deps
      );
    }
    if (plan.mainNeedsWrite) {
      atomicWritePrivate(fsImpl, pathImpl, plan.configPath, plan.preparedMain.content, deps);
    }
    if (plan.fragmentNeedsWrite) {
      atomicWritePrivate(fsImpl, pathImpl, plan.fragmentPath, plan.fragmentContent, deps);
    }
  } catch (cause) {
    const rollback = rollbackFiles(fsImpl, pathImpl, snapshots, deps);
    throw createFrpError('frp_config_write_failed', 'Unable to write managed FRP configuration', {
      cause,
      rollback
    });
  }

  const operationContext = {
    configPath: plan.configPath,
    fragmentPath: plan.fragmentPath,
    action: plan.action,
    frpcBinary: options.frpcBinary,
    restartCommand: options.restartCommand
  };
  if (plan.action !== 'none') {
    const verifyResult = await runFrpcStep(['verify', '-c', plan.configPath], operationContext, deps);
    if (!operationSucceeded(verifyResult)) {
      const error = operationError('frp_verify_failed', 'frpc verify', verifyResult, plan.redactionSecrets);
      error.rollback = rollbackFiles(fsImpl, pathImpl, snapshots, deps);
      throw error;
    }

    const applyResult = plan.action === 'restart'
      ? await runRestartStep(operationContext, deps)
      : await runFrpcStep(['reload', '-c', plan.configPath], operationContext, deps);
    if (!operationSucceeded(applyResult)) {
      const code = plan.action === 'restart' ? 'frp_restart_failed' : 'frp_reload_failed';
      const error = operationError(code, `frpc ${plan.action}`, applyResult, plan.redactionSecrets);
      const files = rollbackFiles(fsImpl, pathImpl, snapshots, deps);
      const runtime = await recoverRuntime(
        plan.action,
        operationContext,
        deps,
        plan.redactionSecrets
      );
      error.rollback = {
        ok: files.ok && runtime.ok,
        files,
        runtime
      };
      throw error;
    }
  }
  if (validateActivation) {
    try {
      const validation = await validateActivation(buildActivationContext(plan));
      if (validation === false || (validation && validation.ok === false)) {
        throw createFrpError('frp_activation_rejected', 'FRP activation was rejected');
      }
    } catch (cause) {
      await rollbackFailedActivation(plan, operationContext, snapshots, cause, deps);
    }
  }
  return report;
}

async function applyAihFrpConfig(options = {}, deps = {}) {
  const normalized = normalizeFragmentOptions(options);
  const configPath = discoverFrpcConfigPath(options, deps);
  const managedPaths = resolveManagedPaths(options, normalized, deps);
  const createPlan = () => buildApplyPlan(options, normalized, configPath, managedPaths, deps);

  if (options.dryRun) return publicApplyReport(createPlan(), true);

  const lock = acquireConfigLock(managedPaths, deps);
  try {
    let plan = createPlan();
    if (typeof deps.beforeCommit === 'function') {
      await deps.beforeCommit({
        configPath,
        fragmentPath: managedPaths.fragmentPath,
        lockPath: lock.lockPath
      });
      plan = createPlan();
    }
    return await executeApplyPlan(plan, options, deps);
  } finally {
    lock.release();
  }
}

function publicRemoveReport(identity, removed) {
  return {
    ok: true,
    removed: Boolean(removed),
    role: identity.role,
    serverId: identity.serverId,
    action: removed ? 'reload' : 'none'
  };
}

function assertManagedFragmentPath(managedPaths, deps) {
  const pathImpl = deps.path || path;
  const fileName = pathImpl.basename(managedPaths.fragmentPath);
  if (pathImpl.dirname(managedPaths.fragmentPath) !== managedPaths.fragmentDir
    || !fileName.startsWith(AIH_FRP_NAME_PREFIX)
    || !fileName.endsWith('.toml')) {
    throw createFrpError(
      'frp_managed_fragment_path_invalid',
      'Refusing to remove a non-AIH FRP fragment'
    );
  }
}

async function executeRemovePlan(plan, deps) {
  const fsImpl = deps.fs || fs;
  const pathImpl = deps.path || path;
  const snapshots = [plan.fragmentSnapshot, plan.desiredStateSnapshot];
  try {
    if (plan.fragmentSnapshot.exists) fsImpl.unlinkSync(plan.fragmentPath);
    atomicWritePrivate(
      fsImpl,
      pathImpl,
      plan.desiredStatePath,
      plan.nextDesiredStateContent,
      deps
    );
  } catch (cause) {
    const rollback = rollbackFiles(fsImpl, pathImpl, snapshots, deps);
    throw createFrpError('frp_config_remove_failed', 'Unable to remove managed FRP route', {
      cause,
      rollback
    });
  }

  const operationContext = {
    configPath: plan.configPath,
    fragmentPath: plan.fragmentPath,
    action: 'reload'
  };
  const verifyResult = await runFrpcStep(['verify', '-c', plan.configPath], operationContext, deps);
  if (!operationSucceeded(verifyResult)) {
    const error = operationError(
      'frp_verify_failed',
      'frpc verify',
      verifyResult,
      plan.route.secretKey
    );
    error.rollback = rollbackFiles(fsImpl, pathImpl, snapshots, deps);
    throw error;
  }
  const reloadResult = await runFrpcStep(['reload', '-c', plan.configPath], operationContext, deps);
  if (!operationSucceeded(reloadResult)) {
    const error = operationError(
      'frp_reload_failed',
      'frpc reload',
      reloadResult,
      plan.route.secretKey
    );
    const files = rollbackFiles(fsImpl, pathImpl, snapshots, deps);
    const runtime = await recoverRuntime('reload', operationContext, deps, plan.route.secretKey);
    error.rollback = {
      ok: files.ok && runtime.ok,
      files,
      runtime
    };
    throw error;
  }
  return publicRemoveReport(plan.identity, true);
}

async function removeAihFrpConfig(options = {}, deps = {}) {
  const identity = normalizeManagedRouteIdentity(options);
  const aiHomeDir = resolveAiHomeDir(options, deps);
  const lock = acquireConfigLock({ aiHomeDir }, deps);
  try {
    const current = readDesiredState(aiHomeDir, deps);
    const route = current.state.routes.find((item) => (
      item.role === identity.role && item.serverId === identity.serverId
    ));
    if (!route) return publicRemoveReport(identity, false);
    const managedPaths = resolveManagedPaths({ aiHomeDir }, route, deps);
    assertManagedFragmentPath(managedPaths, deps);
    const fsImpl = deps.fs || fs;
    const fragmentSnapshot = snapshotFile(fsImpl, managedPaths.fragmentPath);
    const nextDesiredStateContent = renderDesiredFrpState(
      removeDesiredFrpRoute(current.state, identity.role, identity.serverId)
    );
    return await executeRemovePlan({
      ...managedPaths,
      identity,
      route,
      configPath: route.configPath,
      fragmentSnapshot,
      desiredStateSnapshot: current.snapshot,
      nextDesiredStateContent
    }, deps);
  } finally {
    lock.release();
  }
}

function skippedReconcileReport(identity) {
  return {
    ok: true,
    skipped: true,
    role: identity.role,
    serverId: identity.serverId,
    action: 'none',
    changes: { main: false, fragment: false, permissions: false }
  };
}

async function reconcileDesiredFrpRoute(identity, aiHomeDir, forceRuntimeApply, deps) {
  const lock = acquireConfigLock({ aiHomeDir }, deps);
  try {
    const createCurrentPlan = () => {
      const current = readDesiredState(aiHomeDir, deps);
      const route = current.state.routes.find((item) => (
        item.role === identity.role && item.serverId === identity.serverId
      ));
      if (!route) return null;
      const normalized = normalizeFragmentOptions(route);
      const configPath = discoverFrpcConfigPath(route, deps);
      const managedPaths = resolveManagedPaths({ aiHomeDir }, normalized, deps);
      return {
        route,
        plan: buildApplyPlan(route, normalized, configPath, managedPaths, deps)
      };
    };
    let current = createCurrentPlan();
    if (!current) return skippedReconcileReport(identity);
    if (typeof deps.beforeCommit === 'function') {
      await deps.beforeCommit({
        configPath: current.plan.configPath,
        fragmentPath: current.plan.fragmentPath,
        lockPath: lock.lockPath
      });
      current = createCurrentPlan();
      if (!current) return skippedReconcileReport(identity);
    }
    if (current.plan.action === 'none' && forceRuntimeApply) {
      current.plan.action = 'reload';
      current.plan.forceRuntimeApply = true;
    }
    return executeApplyPlan(current.plan, current.route, deps);
  } finally {
    lock.release();
  }
}

async function reconcileAihFrpConfig(options = {}, deps = {}) {
  const aiHomeDir = resolveAiHomeDir(options, deps);
  const desiredState = hardenDesiredState(aiHomeDir, deps);
  const report = {
    ok: true,
    total: desiredState.routes.length,
    reconciled: 0,
    unchanged: 0,
    failures: []
  };
  let runtimeApplied = false;
  for (const route of desiredState.routes) {
    try {
      const result = await reconcileDesiredFrpRoute(route, aiHomeDir, !runtimeApplied, deps);
      if (!result.skipped && result.action !== 'none') runtimeApplied = true;
      const changed = !result.skipped && (result.action !== 'none'
        || Boolean(result.changes && (
          result.changes.main
          || result.changes.fragment
          || result.changes.permissions
        )));
      if (changed) report.reconciled += 1;
      else report.unchanged += 1;
    } catch (error) {
      report.ok = false;
      report.failures.push({
        role: route.role,
        serverId: route.serverId,
        error: String(error && error.code || 'frp_reconcile_failed')
      });
    }
  }
  return report;
}

module.exports = {
  AIH_FRP_NAME_PREFIX,
  DEFAULT_LOCAL_SERVER_PORT,
  DEFAULT_FRP_PROCESS_TIMEOUT_MS,
  DEFAULT_WEB_SERVER_PORT,
  applyAihFrpConfig,
  acquireConfigLock,
  assertAihOwnedName,
  atomicWritePrivate,
  buildDefaultFrpcConfigCandidates,
  defaultRunProcess,
  discoverFrpcConfigPath,
  prepareFrpcMainConfig,
  reconcileAihFrpConfig,
  removeAihFrpConfig,
  renderAihFrpcFragment
};
