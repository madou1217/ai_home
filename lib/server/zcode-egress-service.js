'use strict';

// ZCode 账号出口编排：绑定读取 → 中立 target 解析 → 节点租约 → sing-box 账号监听
// → 中性数据面探测 → Desktop 生命周期收敛。系统代理与 TUN 只读检测，任何失败都
// fail-closed，不允许回退直连或改写宿主网络。

const {
  EGRESS_MODE_GROUP,
  EGRESS_MODE_NODE,
  readAccountEgressBinding
} = require('../account/zcode-egress-binding-store');
const nodeFs = require('node:fs');
const { getProviderClientSupport, listProviderIds } = require('../provider-catalog');
const { resolveAccountRef } = require('./account-ref-store');
const { getProxyNodeStore } = require('../cli/services/toolkit/proxy-pool/proxy-node-store');
const { APP_STATUS_LAUNCH_READY } = require('./account-app-launcher');
const { getZcodeEgressLeaseStore } = require('./zcode-egress-lease-store');
const { ZcodeEgressHealthMonitor } = require('./zcode-egress-health-monitor');
const { probeZcodeProxy } = require('./zcode-egress-probe');
const { STRATEGY_LOWEST_LATENCY } = require('./zcode-egress-scheduler');
const {
  SUPPORTED_PLATFORM,
  resolveZcodeEgressPlatform,
  resolveZcodeEgressTarget
} = require('./zcode-egress-resolver');
const { getZcodeSingBoxRuntime } = require('./zcode-sing-box-runtime');

const EGRESS_SUPPORTED_PROVIDERS = Object.freeze(listProviderIds());
const ACCOUNT_EGRESS_NO_PROXY = 'localhost,127.0.0.1,::1';
const ACCOUNT_EGRESS_BINDING_UNAVAILABLE = 'account_egress_binding_unavailable';
const ACCOUNT_EGRESS_UNAVAILABLE = 'account_egress_unavailable';
const ZCODE_EGRESS_BINDING_UNAVAILABLE = 'zcode_egress_binding_unavailable';
const ZCODE_EGRESS_UNAVAILABLE = 'zcode_egress_unavailable';
const desktopAccountOperations = new Map();
const accountEgressMutations = new Map();
const defaultHealthMonitors = new Map();
const DEFAULT_ZCODE_LATENCY_MAX_AGE_MS = 5 * 60 * 1000;
const ZCODE_EGRESS_DEPENDENCY_KEYS = Object.freeze([
  'readAccountEgressBinding',
  'nodeStore',
  'getProxyNodeStore',
  'leaseStore',
  'getZcodeEgressLeaseStore',
  'zcodeEgressHealthMonitor',
  'getZcodeEgressHealthMonitor',
  'zcodeSingBoxRuntime',
  'getZcodeSingBoxRuntime',
  'probeProxyServer',
  'execFile',
  'curlPath',
  'proxyProbeUrl',
  'proxyProbeTimeoutMs',
  'latencyProbeConcurrency',
  'latencyProbeMaxAgeMs',
  'latencyProbeNow',
  'latencyProbeTargetUrl',
  'latencyProbeTimeoutMs',
  'random',
  'detectSystemProxy',
  'detectTun'
]);

function pickZcodeEgressDependencies(source = {}) {
  const result = {};
  for (const key of ZCODE_EGRESS_DEPENDENCY_KEYS) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function isEgressSupportedProvider(provider) {
  return EGRESS_SUPPORTED_PROVIDERS.includes(String(provider || '').trim().toLowerCase());
}

function providerEgressError(provider, genericError, zcodeError) {
  return String(provider || '').trim().toLowerCase() === 'zcode'
    ? zcodeError
    : genericError;
}

function buildAccountProxyOptions(options, proxyServer) {
  return {
    ...(options && typeof options === 'object' ? options : {}),
    proxyUrl: `http://${proxyServer}`,
    noProxy: ACCOUNT_EGRESS_NO_PROXY
  };
}

function normalizeLoopbackProxyServer(value) {
  const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(String(value || '').trim());
  if (!match) return '';
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? `127.0.0.1:${port}`
    : '';
}

function resolvedRequestOptions(options, egress) {
  const proxyServer = normalizeLoopbackProxyServer(egress?.proxyServer);
  if (!proxyServer) {
    return {
      ok: false,
      bound: true,
      error: ACCOUNT_EGRESS_UNAVAILABLE,
      egressError: String(egress?.error || 'account_egress_endpoint_invalid'),
      ...(egress?.reason ? { reason: String(egress.reason) } : {})
    };
  }
  return {
    ok: true,
    bound: true,
    options: buildAccountProxyOptions(options, proxyServer),
    egress
  };
}

function buildZcodeEgressOwnerId(accountRef, instanceKind = 'desktop') {
  return `zcode:${String(instanceKind || 'desktop').trim().toLowerCase()}:${String(accountRef || '').trim()}`;
}

function mergeWarnings(...warnings) {
  return [...new Set(warnings.map((warning) => String(warning || '').trim()).filter(Boolean))]
    .join('；');
}

function describeAlreadyRunningWarning({ raced = false, provider = '' } = {}) {
  const clientLabel = String(provider || '').trim().toLowerCase() === 'zcode'
    ? 'ZCode '
    : '客户端';
  return raced
    ? '启动期间已有实例抢先运行，本次预备出口未被该实例加载；请在出口设置中重新实时应用'
    : `${clientLabel}当前实例已运行；出口变更请在出口设置中实时应用`;
}

function resolveRuntime(deps, aiHomeDir) {
  if (deps.zcodeSingBoxRuntime) return deps.zcodeSingBoxRuntime;
  if (typeof deps.getZcodeSingBoxRuntime === 'function') {
    return deps.getZcodeSingBoxRuntime({ aiHomeDir });
  }
  return getZcodeSingBoxRuntime({ aiHomeDir });
}

function resolveLeaseStore(deps, aiHomeDir) {
  if (deps.leaseStore) return deps.leaseStore;
  if (typeof deps.getZcodeEgressLeaseStore === 'function') {
    return deps.getZcodeEgressLeaseStore({ aiHomeDir });
  }
  return getZcodeEgressLeaseStore({ aiHomeDir });
}

function resolveNodeStore(deps) {
  if (deps.nodeStore) return deps.nodeStore;
  if (typeof deps.getProxyNodeStore === 'function') return deps.getProxyNodeStore();
  return getProxyNodeStore();
}

function peekHealthMonitor(deps, aiHomeDir) {
  if (deps.zcodeEgressHealthMonitor) return deps.zcodeEgressHealthMonitor;
  if (typeof deps.getZcodeEgressHealthMonitor === 'function') {
    return deps.getZcodeEgressHealthMonitor({ aiHomeDir, create: false });
  }
  return defaultHealthMonitors.get(String(aiHomeDir || '').trim()) || null;
}

function resolveHealthMonitor(deps, aiHomeDir) {
  if (deps.zcodeEgressHealthMonitor) return deps.zcodeEgressHealthMonitor;
  if (typeof deps.getZcodeEgressHealthMonitor === 'function') {
    return deps.getZcodeEgressHealthMonitor({ aiHomeDir, create: true });
  }
  const key = String(aiHomeDir || '').trim();
  if (!defaultHealthMonitors.has(key)) {
    defaultHealthMonitors.set(key, new ZcodeEgressHealthMonitor({
      probeProxyServer: resolveProbe(deps),
      recoverAccount: ({ recoveryInput, failedNodeIds }) => applyStoredAccountEgress({
        ...(recoveryInput || {}),
        failedNodeIds,
        skipHealthMonitor: true
      })
    }));
  }
  return defaultHealthMonitors.get(key);
}

function untrackAccountHealth(input = {}) {
  const accountRef = String(input.accountRef || '').trim();
  if (!accountRef) return;
  try {
    peekHealthMonitor(input.deps || {}, input.aiHomeDir)?.untrack?.(accountRef);
  } catch {}
}

function trackAccountHealth(input = {}, egress = {}) {
  if (input.skipHealthMonitor || !egress || egress.source !== EGRESS_MODE_GROUP) {
    untrackAccountHealth(input);
    return null;
  }
  const accountRef = String(input.accountRef || '').trim();
  const selectedNodeId = String(egress.selectedNodeId || '').trim();
  const groupId = String(egress.groupId || '').trim();
  const proxyServer = String(egress.proxyServer || '').trim();
  if (!accountRef || !selectedNodeId || !groupId || !proxyServer) {
    untrackAccountHealth(input);
    return null;
  }
  let pid = null;
  try {
    const ownerId = buildZcodeEgressOwnerId(accountRef);
    const lease = resolveLeaseStore(input.deps || {}, input.aiHomeDir).getByOwner?.(ownerId);
    const candidatePid = Number(lease?.pid);
    if (Number.isInteger(candidatePid) && candidatePid > 0) pid = candidatePid;
  } catch {}
  try {
    return resolveHealthMonitor(input.deps || {}, input.aiHomeDir).track?.({
      accountRef,
      proxyServer,
      selectedNodeId,
      groupId,
      pid,
      recoveryInput: {
        fs: input.fs,
        aiHomeDir: input.aiHomeDir,
        provider: input.provider || 'zcode',
        accountRef,
        processObj: input.processObj || process,
        deps: input.deps || {}
      }
    }) || null;
  } catch {
    return null;
  }
}

function resolveProbe(deps) {
  if (typeof deps.probeProxyServer === 'function') return deps.probeProxyServer;
  return (proxyServer) => probeZcodeProxy(proxyServer, {
    execFile: deps.execFile,
    curlPath: deps.curlPath,
    targetUrl: deps.proxyProbeUrl,
    timeoutMs: deps.proxyProbeTimeoutMs
  });
}

function cloneJsonValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function resolveLatencyProbeNow(deps) {
  return typeof deps.latencyProbeNow === 'function'
    ? Number(deps.latencyProbeNow())
    : Date.now();
}

function resolveLatencyMaxAgeMs(deps) {
  const parsed = Number(deps.latencyProbeMaxAgeMs);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_ZCODE_LATENCY_MAX_AGE_MS;
}

function nodeNeedsLatencyRefresh(node, now, maxAgeMs) {
  if (!node?.id || node.disabled === true) return false;
  const latencyMissing = node.latencyMs === null || node.latencyMs === undefined;
  const latencyMs = Number(node.latencyMs);
  if (latencyMissing || !Number.isFinite(latencyMs) || latencyMs < -1) return true;
  const lastChecked = Number(node.lastChecked);
  return !Number.isFinite(lastChecked)
    || lastChecked <= 0
    || now - lastChecked >= maxAgeMs;
}

async function refreshAccountCandidateLatencies(input = {}) {
  const runtime = input.runtime;
  const nodeStore = input.nodeStore;
  if (
    !runtime
    || typeof runtime.measureAccountCandidateLatencies !== 'function'
    || !nodeStore
  ) {
    return { ok: true, refreshed: false, updatedCount: 0 };
  }

  const deps = input.deps || {};
  const now = resolveLatencyProbeNow(deps);
  const maxAgeMs = resolveLatencyMaxAgeMs(deps);
  const failedNodeIds = new Set((input.failedNodeIds || []).map(String));
  const staleNodeIds = (Array.isArray(input.candidateNodes) ? input.candidateNodes : [])
    .filter((node) => !failedNodeIds.has(String(node?.id || '')))
    .filter((node) => nodeNeedsLatencyRefresh(node, now, maxAgeMs))
    .map((node) => String(node.id));
  if (!staleNodeIds.length) {
    return { ok: true, refreshed: false, updatedCount: 0 };
  }

  let measured;
  try {
    measured = await runtime.measureAccountCandidateLatencies({
      accountRef: input.accountRef,
      nodeIds: staleNodeIds,
      concurrency: deps.latencyProbeConcurrency,
      timeoutMs: deps.latencyProbeTimeoutMs,
      targetUrl: deps.latencyProbeTargetUrl
    });
  } catch (error) {
    return runtimeErrorResult('sing_box_delay_probe_failed', error);
  }
  if (!measured?.ok) {
    return {
      ok: false,
      refreshed: false,
      updatedCount: 0,
      error: String(measured?.error || 'sing_box_delay_probe_failed'),
      ...(measured?.reason ? { reason: String(measured.reason) } : {})
    };
  }

  const updates = (Array.isArray(measured.results) ? measured.results : [])
    .filter((result) => result?.measured === true)
    .map((result) => ({
      nodeId: String(result.nodeId || '').trim(),
      latencyMs: result.ok === true ? Number(result.latencyMs) : -1
    }))
    .filter((result) => (
      result.nodeId
      && Number.isFinite(result.latencyMs)
      && result.latencyMs >= -1
    ));
  if (!updates.length) {
    return {
      ok: true,
      refreshed: true,
      updatedCount: 0,
      measuredCount: Number(measured.measuredCount || 0)
    };
  }

  const checkedAt = resolveLatencyProbeNow(deps);
  let persisted;
  try {
    if (typeof nodeStore.updateNodeLatencies === 'function') {
      persisted = nodeStore.updateNodeLatencies(updates, checkedAt);
    } else {
      let updated = 0;
      for (const update of updates) {
        if (nodeStore.updateNodeLatency?.(update.nodeId, update.latencyMs)) updated += 1;
      }
      persisted = { updated, missing: updates.length - updated };
    }
  } catch (error) {
    return runtimeErrorResult('proxy_node_latency_write_failed', error);
  }
  return {
    ok: true,
    refreshed: true,
    updatedCount: Number(persisted?.updated || 0),
    missingCount: Number(persisted?.missing || 0),
    measuredCount: Number(measured.measuredCount || updates.length),
    healthyCount: Number(measured.healthyCount || 0),
    failedCount: Number(measured.failedCount || 0)
  };
}

function enqueueAccountEgressMutation(accountRef, operation) {
  const key = String(accountRef || '').trim();
  if (!key) return Promise.resolve().then(operation);
  const previous = accountEgressMutations.get(key);
  const pending = previous
    ? previous.catch(() => undefined).then(operation)
    : Promise.resolve().then(operation);
  accountEgressMutations.set(key, pending);
  const release = () => {
    if (accountEgressMutations.get(key) === pending) accountEgressMutations.delete(key);
  };
  pending.then(release, release);
  return pending;
}

function enqueueDesktopAccountOperation(provider, accountRef, action, operation) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const normalizedAccountRef = String(accountRef || '').trim();
  if (!normalizedProvider || !normalizedAccountRef) return Promise.resolve().then(operation);

  const operationKey = `${normalizedProvider}:${normalizedAccountRef}`;
  let state = desktopAccountOperations.get(operationKey);
  if (!state) {
    state = { tail: null, open: null };
    desktopAccountOperations.set(operationKey, state);
  }
  const normalizedAction = String(action || '').trim().toLowerCase();
  if (normalizedAction === 'open' && state.open) return state.open;
  if (normalizedAction !== 'open') state.open = null;

  const pending = state.tail
    ? state.tail.catch(() => undefined).then(operation)
    : Promise.resolve().then(operation);
  state.tail = pending;
  if (normalizedAction === 'open') state.open = pending;

  const release = () => {
    if (state.open === pending) state.open = null;
    if (state.tail === pending && desktopAccountOperations.get(operationKey) === state) {
      desktopAccountOperations.delete(operationKey);
    }
  };
  pending.then(release, release);
  return pending;
}

function readStoredBinding(input, deps) {
  if (Object.prototype.hasOwnProperty.call(input, 'binding')) return input.binding;
  const readBinding = typeof deps.readAccountEgressBinding === 'function'
    ? deps.readAccountEgressBinding
    : readAccountEgressBinding;
  return readBinding(input.fs, input.aiHomeDir, input.accountRef);
}

function hasStoredAccountEgressBinding(input = {}) {
  const deps = input.deps || {};
  try {
    return Boolean(readStoredBinding(input, deps));
  } catch {
    // 绑定状态未知时保留数据面，避免关闭 Desktop 意外切断同账号 CLI/Gateway。
    return true;
  }
}

function resolveRunningZcodePid(input = {}, fallbackPid = null) {
  const persistedPid = Number(fallbackPid);
  if (Number.isInteger(persistedPid) && persistedPid > 0) return persistedPid;
  const launcher = input.launcher;
  if (!launcher || typeof launcher.launchAccountApp !== 'function') return null;
  let result;
  try {
    result = launcher.launchAccountApp({
      provider: 'zcode',
      accountRef: String(input.accountRef || '').trim(),
      kind: 'desktop',
      action: 'open',
      deferDesktopSpawn: true
    });
  } catch {
    return null;
  }
  if (!result?.ok || result.status !== 'already_running') return null;
  return (Array.isArray(result.pids) ? result.pids : [])
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .sort((left, right) => left - right)[0] || null;
}

function attachRunningZcodeLease(input, egress) {
  const ownerId = String(egress?.leaseOwnerId || '').trim();
  if (!ownerId) return egress;
  const pid = resolveRunningZcodePid(input);
  if (!pid) return egress;
  try {
    const attached = resolveLeaseStore(input.deps || {}, input.aiHomeDir)
      .attachProcess?.(ownerId, pid);
    return attached ? { ...egress, zcodePid: pid } : egress;
  } catch {
    return egress;
  }
}

function getAccountEgressRuntimeStatus(input = {}) {
  const accountRef = String(input.accountRef || '').trim();
  const provider = String(input.provider || '').trim().toLowerCase();
  if (!isEgressSupportedProvider(provider)) return runtimeErrorResult('egress_unsupported_provider');
  if (!input.fs || !input.aiHomeDir || !accountRef) return runtimeErrorResult('egress_context_missing');
  const deps = input.deps || {};

  let binding;
  try {
    binding = readStoredBinding({ ...input, accountRef }, deps);
  } catch (error) {
    return runtimeErrorResult('egress_binding_read_failed', error);
  }

  let sidecar;
  try {
    sidecar = resolveRuntime(deps, input.aiHomeDir).getStatus?.() || {};
  } catch (error) {
    return runtimeErrorResult('sidecar_status_unavailable', error);
  }
  const account = (Array.isArray(sidecar.accounts) ? sidecar.accounts : [])
    .find((candidate) => candidate?.accountRef === accountRef) || null;

  let lease = null;
  if (binding?.mode === EGRESS_MODE_GROUP || account?.selectedNodeId) {
    try {
      lease = resolveLeaseStore(deps, input.aiHomeDir)
        .getByOwner?.(buildZcodeEgressOwnerId(accountRef)) || null;
    } catch (error) {
      return runtimeErrorResult('zcode_egress_lease_status_unavailable', error);
    }
  }

  let health = { monitoring: false };
  try {
    health = peekHealthMonitor(deps, input.aiHomeDir)?.getStatus?.(accountRef) || health;
  } catch {}

  const port = Number(account?.port);
  const leasePid = Number(lease?.pid);
  const zcodePid = provider === 'zcode'
    ? resolveRunningZcodePid(input, lease?.pid)
    : null;
  const ownerPid = provider === 'zcode'
    ? zcodePid
    : (Number.isInteger(leasePid) && leasePid > 0 ? leasePid : null);
  const selectedNodeId = String(account?.selectedNodeId || lease?.nodeId || '').trim() || null;
  const groupId = String(lease?.groupId || binding?.groupId || '').trim() || null;
  const running = sidecar.running === true && Boolean(account);
  const dataPlaneReady = sidecar.dataPlaneReady === true && running;
  const hasLiveOwnerProcess = Number.isInteger(ownerPid) && ownerPid > 0;
  return {
    ok: true,
    binding: binding || null,
    runtime: {
      running,
      dataPlaneReady,
      proxyServer: Number.isInteger(port) && port > 0 ? `127.0.0.1:${port}` : null,
      source: String(account?.source || binding?.mode || '').trim() || null,
      selectedNodeId,
      groupId,
      ownerPid: hasLiveOwnerProcess ? ownerPid : null,
      zcodePid: Number.isInteger(zcodePid) && zcodePid > 0 ? zcodePid : null,
      canRotate: Boolean(
        binding?.mode === EGRESS_MODE_GROUP
        && dataPlaneReady
        && selectedNodeId
        && hasLiveOwnerProcess
      ),
      sidecar: {
        engine: String(sidecar.engine || 'sing-box'),
        installed: sidecar.installed === true,
        running: sidecar.running === true,
        dataPlaneReady: sidecar.dataPlaneReady === true,
        pid: Number.isInteger(Number(sidecar.pid)) && Number(sidecar.pid) > 0
          ? Number(sidecar.pid)
          : null,
        lastError: sidecar.lastError ? String(sidecar.lastError) : null
      },
      health
    }
  };
}

function releaseAccountLease(input = {}) {
  const accountRef = String(input.accountRef || '').trim();
  if (!accountRef) return;
  const deps = input.deps || {};
  let leaseStore;
  try { leaseStore = resolveLeaseStore(deps, input.aiHomeDir); } catch {}
  try {
    if (typeof leaseStore?.releaseByAccount === 'function') leaseStore.releaseByAccount(accountRef);
    else leaseStore?.release?.(buildZcodeEgressOwnerId(accountRef));
  } catch {}
}

async function releaseAccountResources(input = {}) {
  const accountRef = String(input.accountRef || '').trim();
  if (!accountRef) return;
  const deps = input.deps || {};
  untrackAccountHealth({ accountRef, aiHomeDir: input.aiHomeDir, deps });
  releaseAccountLease({ accountRef, aiHomeDir: input.aiHomeDir, deps });
  let runtime;
  try { runtime = resolveRuntime(deps, input.aiHomeDir); } catch {}
  try { await runtime?.releaseAccount?.(accountRef); } catch {}
}

async function releasePendingSelection(input = {}) {
  const deps = input.deps || {};
  const ownerId = String(input.ownerId || '').trim();
  const preserveAccountEndpoint = input.preserveAccountEndpointOnFailure === true;
  let leaseStore;
  let runtime;
  try { leaseStore = resolveLeaseStore(deps, input.aiHomeDir); } catch {}
  if (!preserveAccountEndpoint) {
    try { runtime = resolveRuntime(deps, input.aiHomeDir); } catch {}
  }
  try { if (ownerId) leaseStore?.release?.(ownerId); } catch {}
  if (!preserveAccountEndpoint) {
    try { await runtime?.releaseAccount?.(input.accountRef); } catch {}
  }
}

async function resolveAccountEgress(input = {}) {
  const { fs, aiHomeDir, provider } = input;
  const accountRef = String(input.accountRef || '').trim();
  if (!isEgressSupportedProvider(provider)) return null;
  if (!fs || !aiHomeDir || !accountRef) throw new Error('egress_context_missing');

  const deps = input.deps || {};
  const readBinding = typeof deps.readAccountEgressBinding === 'function'
    ? deps.readAccountEgressBinding
    : readAccountEgressBinding;
  const binding = readBinding(fs, aiHomeDir, accountRef);
  if (!binding) {
    await releaseAccountResources({ accountRef, aiHomeDir, deps });
    return null;
  }

  const platform = resolveZcodeEgressPlatform({ processObj: input.processObj || process });
  if (platform !== SUPPORTED_PLATFORM) {
    return {
      ok: false,
      proxyServer: '',
      source: '',
      target: null,
      error: 'not_supported',
      platform
    };
  }

  const ownerId = buildZcodeEgressOwnerId(accountRef);
  const needsNodeStore = binding.mode === EGRESS_MODE_NODE || binding.mode === EGRESS_MODE_GROUP;
  const nodeStore = needsNodeStore ? resolveNodeStore(deps) : null;
  let leaseStore = needsNodeStore ? resolveLeaseStore(deps, aiHomeDir) : null;
  let runtime = null;
  const initialLease = leaseStore?.getByOwner?.(ownerId) || null;
  const attachedPid = Number(initialLease?.pid);
  const leasePid = Number.isInteger(attachedPid) && attachedPid > 0 ? attachedPid : null;
  const failedNodeIds = new Set(
    (Array.isArray(input.failedNodeIds) ? input.failedNodeIds : [])
      .map(String)
      .filter(Boolean)
  );
  let lastProbeFailure = null;
  let latencyRefreshAttempted = false;
  let ignoreCurrentLeaseOnce = false;

  for (;;) {
    const existingLease = leaseStore?.getByOwner?.(ownerId) || null;
    const currentNodeId = ignoreCurrentLeaseOnce
      ? ''
      : String(existingLease?.nodeId || '');
    ignoreCurrentLeaseOnce = false;
    const resolvedTarget = await resolveZcodeEgressTarget({
      binding,
      processObj: input.processObj || process,
      ...(nodeStore ? { nodeStore } : {}),
      leaseStore,
      ownerId,
      currentNodeId,
      failedNodeIds: [...failedNodeIds],
      random: deps.random,
      detectSystemProxy: deps.detectSystemProxy,
      detectTun: deps.detectTun
    });
    if (!resolvedTarget.ok) {
      if (lastProbeFailure && resolvedTarget.error === 'no_available_proxy_node') {
        await releasePendingSelection({
          accountRef,
          aiHomeDir,
          deps,
          ownerId,
          preserveAccountEndpointOnFailure: input.preserveAccountEndpointOnFailure
        });
        return lastProbeFailure;
      }
      if (latencyRefreshAttempted && resolvedTarget.error === 'no_available_proxy_node') {
        await releasePendingSelection({
          accountRef,
          aiHomeDir,
          deps,
          ownerId,
          preserveAccountEndpointOnFailure: input.preserveAccountEndpointOnFailure
        });
      }
      return { ...resolvedTarget, proxyServer: '' };
    }

    runtime ||= resolveRuntime(deps, aiHomeDir);
    if (!leaseStore) leaseStore = resolveLeaseStore(deps, aiHomeDir);
    let leaseAcquired = false;
    if (resolvedTarget.selectedNodeId) {
      try {
        leaseStore.acquire({
          ownerId,
          accountRef,
          instanceKind: 'desktop',
          groupId: String(resolvedTarget.groupId || ''),
          nodeId: resolvedTarget.selectedNodeId,
          ...(leasePid ? { pid: leasePid } : {})
        });
        leaseAcquired = true;
      } catch (error) {
        return {
          ok: false,
          proxyServer: '',
          source: '',
          error: 'zcode_egress_lease_failed',
          reason: String(error?.message || error || 'unknown')
        };
      }
    } else {
      try { leaseStore?.release?.(ownerId); } catch {}
    }

    let endpoint;
    try {
      endpoint = await runtime.ensureAccountEndpoint({ accountRef, resolvedTarget });
    } catch (error) {
      endpoint = {
        ok: false,
        error: 'sing_box_apply_failed',
        reason: String(error?.message || error || 'unknown')
      };
    }
    if (!endpoint?.ok || !String(endpoint.proxyServer || '').trim()) {
      await releasePendingSelection({
        accountRef,
        aiHomeDir,
        deps,
        ownerId,
        preserveAccountEndpointOnFailure: input.preserveAccountEndpointOnFailure
      });
      return {
        ok: false,
        proxyServer: '',
        source: '',
        error: String(endpoint?.error || 'sing_box_apply_failed'),
        ...(endpoint?.reason ? { reason: String(endpoint.reason) } : {})
      };
    }

    // ZCode 的节点租约最终绑定 Desktop PID；其它 provider 可能只通过 CLI 或
    // Gateway 使用 endpoint，因此绑定共享 sidecar PID，避免 60s 待定租约过期后
    // 分组调度误把同一节点重复分配给其它账号。
    if (leaseAcquired && provider !== 'zcode') {
      let sidecarPid = Number(endpoint?.sidecar?.pid);
      if (!Number.isInteger(sidecarPid) || sidecarPid <= 0) {
        try { sidecarPid = Number(runtime.getStatus?.().pid); } catch {}
      }
      if (!Number.isInteger(sidecarPid) || sidecarPid <= 0) {
        await releasePendingSelection({
          accountRef,
          aiHomeDir,
          deps,
          ownerId,
          preserveAccountEndpointOnFailure: input.preserveAccountEndpointOnFailure
        });
        return {
          ok: false,
          proxyServer: '',
          source: '',
          error: 'account_egress_sidecar_process_missing'
        };
      }
      try {
        leaseStore.attachProcess?.(ownerId, sidecarPid);
      } catch (error) {
        await releasePendingSelection({
          accountRef,
          aiHomeDir,
          deps,
          ownerId,
          preserveAccountEndpointOnFailure: input.preserveAccountEndpointOnFailure
        });
        return {
          ok: false,
          proxyServer: '',
          source: '',
          error: 'account_egress_lease_attach_failed',
          reason: String(error?.message || error || 'unknown')
        };
      }
    }

    if (
      binding.mode === EGRESS_MODE_GROUP
      && !latencyRefreshAttempted
      && resolvedTarget.selection?.sticky !== true
      && resolvedTarget.selection?.strategy === STRATEGY_LOWEST_LATENCY
    ) {
      latencyRefreshAttempted = true;
      const refreshed = await refreshAccountCandidateLatencies({
        accountRef,
        runtime,
        nodeStore,
        candidateNodes: resolvedTarget.candidateNodes,
        failedNodeIds: [...failedNodeIds],
        deps
      });
      if (refreshed.updatedCount > 0) {
        ignoreCurrentLeaseOnce = true;
        continue;
      }
    }

    const proxyServer = String(endpoint.proxyServer).trim();
    let probe;
    try {
      probe = await resolveProbe(deps)(proxyServer);
    } catch (error) {
      probe = { ok: false, reason: String(error?.message || error || 'unknown') };
    }
    if (probe?.ok) {
      return {
        ok: true,
        proxyServer,
        source: resolvedTarget.source,
        selectedNodeId: resolvedTarget.selectedNodeId || null,
        groupId: resolvedTarget.groupId || null,
        leaseOwnerId: leaseAcquired ? ownerId : null,
        sidecarAction: endpoint.action || null,
        sidecar: endpoint.sidecar || null
      };
    }

    lastProbeFailure = {
      ok: false,
      proxyServer: '',
      source: '',
      error: 'proxy_unreachable',
      reason: String(probe?.reason || probe?.error || 'proxy_probe_failed')
    };
    const failedNodeId = String(resolvedTarget.selectedNodeId || '');
    if (binding.mode !== EGRESS_MODE_GROUP || !failedNodeId) {
      await releasePendingSelection({
        accountRef,
        aiHomeDir,
        deps,
        ownerId,
        preserveAccountEndpointOnFailure: input.preserveAccountEndpointOnFailure
      });
      return lastProbeFailure;
    }
    failedNodeIds.add(failedNodeId);
    try { leaseStore?.release?.(ownerId); } catch {}
  }
}

// Gateway 在选定账号后调用本适配器，把全局网络选项转换成 attempt-local 选项。
// 活跃 sidecar 走 O(1) 内存状态快路径；只有 endpoint 缺失或重启恢复时才进入完整
// 解析/探测链。绑定失败时不返回 options，调用方因此无法回落到全局代理或直连。
async function resolveAccountEgressRequestOptions(input = {}) {
  const provider = String(input.provider || '').trim().toLowerCase();
  const accountRef = String(input.accountRef || '').trim();
  const options = input.options && typeof input.options === 'object'
    ? { ...input.options }
    : {};
  if (!provider || !accountRef || !isEgressSupportedProvider(provider)) {
    return { ok: true, bound: false, options };
  }

  const deps = input.deps || {};
  const fsImpl = input.fs || deps.fs || nodeFs;
  const aiHomeDir = String(input.aiHomeDir || deps.aiHomeDir || options.aiHomeDir || '').trim();
  if (!fsImpl || !aiHomeDir) {
    // 旧嵌入调用和纯协议测试可能没有账号存储上下文；此时没有证据表明账号
    // 存在绑定，必须保持既有 Gateway 网络策略。只有读到真实绑定后才 fail closed。
    return { ok: true, bound: false, options };
  }

  const injectedResolver = typeof deps.resolveAccountEgress === 'function'
    ? deps.resolveAccountEgress
    : null;
  let egress;
  if (injectedResolver) {
    try {
      egress = await injectedResolver({
        ...input,
        fs: fsImpl,
        aiHomeDir,
        provider,
        accountRef
      });
    } catch (error) {
      egress = runtimeErrorResult('egress_resolve_failed', error);
    }
  } else {
    let binding;
    try {
      binding = readStoredBinding({ ...input, fs: fsImpl, aiHomeDir, accountRef }, deps);
    } catch (error) {
      return {
        ok: false,
        bound: true,
        error: ACCOUNT_EGRESS_UNAVAILABLE,
        egressError: 'egress_binding_read_failed',
        reason: String(error?.message || error || 'unknown')
      };
    }
    if (!binding) return { ok: true, bound: false, options };

    // 请求热路径只读取单例 runtime 的内存状态，不改配置、不启动进程、不做网络探测。
    try {
      const runtime = resolveRuntime(deps, aiHomeDir);
      const status = runtime.getStatus?.() || {};
      const account = (Array.isArray(status.accounts) ? status.accounts : [])
        .find((candidate) => candidate?.accountRef === accountRef) || null;
      const proxyServer = account
        ? normalizeLoopbackProxyServer(`127.0.0.1:${Number(account.port)}`)
        : '';
      let leaseReady = true;
      if (binding.mode === EGRESS_MODE_NODE || binding.mode === EGRESS_MODE_GROUP) {
        leaseReady = Boolean(
          resolveLeaseStore(deps, aiHomeDir).getByOwner?.(buildZcodeEgressOwnerId(accountRef))
        );
      }
      if (
        status.running === true
        && status.dataPlaneReady === true
        && proxyServer
        && leaseReady
      ) {
        return resolvedRequestOptions(options, {
          ok: true,
          proxyServer,
          source: String(account.source || binding.mode || '').trim(),
          selectedNodeId: account.selectedNodeId || null
        });
      }
    } catch {
      // 状态缺失进入恢复慢路径；慢路径仍 fail-closed。
    }

    try {
      egress = await resolveAccountEgress({
        ...input,
        fs: fsImpl,
        aiHomeDir,
        provider,
        accountRef,
        deps
      });
    } catch (error) {
      egress = runtimeErrorResult('egress_resolve_failed', error);
    }
  }

  if (!egress) return { ok: true, bound: false, options };
  if (!egress.ok) {
    return {
      ok: false,
      bound: true,
      error: ACCOUNT_EGRESS_UNAVAILABLE,
      egressError: String(egress.error || 'egress_resolve_failed'),
      ...(egress.reason ? { reason: String(egress.reason) } : {})
    };
  }
  return resolvedRequestOptions(options, egress);
}

async function applyStoredAccountEgressOnce(input = {}) {
  const accountRef = String(input.accountRef || '').trim();
  const provider = String(input.provider || '').trim().toLowerCase();
  if (!isEgressSupportedProvider(provider)) {
    return runtimeErrorResult('egress_unsupported_provider');
  }
  if (!input.fs || !input.aiHomeDir || !accountRef) {
    return runtimeErrorResult('egress_context_missing');
  }
  const deps = input.deps || {};
  const runtime = resolveRuntime(deps, input.aiHomeDir);
  let status;
  try {
    status = runtime.getStatus?.() || { accounts: [] };
  } catch (error) {
    return runtimeErrorResult('sidecar_status_unavailable', error);
  }
  const active = Array.isArray(status.accounts)
    && status.accounts.some((account) => account?.accountRef === accountRef);
  let persisted = null;
  if (!active && typeof runtime.getAccountState === 'function') {
    try {
      persisted = runtime.getAccountState(accountRef);
    } catch {
      persisted = null;
    }
  }

  const readBinding = typeof deps.readAccountEgressBinding === 'function'
    ? deps.readAccountEgressBinding
    : readAccountEgressBinding;
  let binding;
  try {
    binding = readBinding(input.fs, input.aiHomeDir, accountRef);
  } catch (error) {
    return runtimeErrorResult('egress_binding_read_failed', error);
  }

  // 首次绑定时，已经运行的 Desktop 必须重启后才能读取新 env / Chromium 参数；
  // 这不是 ZCode 特例。没有 Desktop 实例时，ZCode 等下次 fresh launch 再准备
  // 原生 setting.json；其它 provider 仍立即启动 sidecar，供 CLI/Gateway 使用。
  if (
    !active
    && !persisted
    && getProviderClientSupport(provider).desktop
    && input.launcher
    && typeof input.launcher.launchAccountApp === 'function'
  ) {
    const takeover = await takeoverRunningDesktopWithStoredEgress(input);
    if (!takeover?.ok || takeover.status === 'restarted' || provider === 'zcode') {
      return takeover;
    }
  }
  if (!active && !persisted && provider === 'zcode') {
    untrackAccountHealth(input);
    return { ok: true, applied: false, status: 'pending_launch' };
  }
  if (!active && !persisted && !binding) {
    untrackAccountHealth(input);
    return { ok: true, applied: false, status: 'pending_launch' };
  }
  if (binding) {
    const resolved = await resolveAccountEgress(input);
    const egress = resolved?.ok && provider === 'zcode'
      ? attachRunningZcodeLease(input, resolved)
      : resolved;
    if (!egress?.ok) return { ...(egress || runtimeErrorResult('egress_resolve_failed')), applied: false };
    const applied = {
      ...egress,
      applied: true,
      status: egress.sidecarAction || 'applied'
    };
    trackAccountHealth(input, applied);
    return applied;
  }

  let leaseStore;
  try {
    leaseStore = resolveLeaseStore(deps, input.aiHomeDir);
    if (typeof leaseStore?.releaseByAccount === 'function') leaseStore.releaseByAccount(accountRef);
    else leaseStore?.release?.(buildZcodeEgressOwnerId(accountRef));
  } catch {}
  let endpoint;
  try {
    endpoint = await runtime.ensureAccountEndpoint({
      accountRef,
      resolvedTarget: {
        ok: true,
        source: 'direct',
        target: { kind: 'direct' }
      }
    });
  } catch (error) {
    endpoint = runtimeErrorResult('sing_box_apply_failed', error);
  }
  if (!endpoint?.ok || !endpoint.proxyServer) {
    return {
      ...(endpoint || runtimeErrorResult('sing_box_apply_failed')),
      applied: false
    };
  }
  let probe;
  try {
    probe = await resolveProbe(deps)(endpoint.proxyServer);
  } catch (error) {
    probe = { ok: false, reason: String(error?.message || error || 'unknown') };
  }
  if (!probe?.ok) {
    return {
      ok: false,
      applied: false,
      error: 'proxy_unreachable',
      reason: String(probe?.reason || probe?.error || 'proxy_probe_failed')
    };
  }
  const applied = {
    ok: true,
    applied: true,
    status: endpoint.action || 'applied',
    source: 'direct',
    proxyServer: endpoint.proxyServer,
    selectedNodeId: null,
    groupId: null,
    sidecar: endpoint.sidecar || null
  };
  untrackAccountHealth(input);
  return applied;
}

function applyStoredAccountEgress(input = {}) {
  return enqueueAccountEgressMutation(
    input.accountRef,
    () => applyStoredAccountEgressOnce(input)
  );
}

async function restorePersistedZcodeEgress(input = {}) {
  const deps = input.deps || {};
  let runtime;
  let state;
  try {
    runtime = resolveRuntime(deps, input.aiHomeDir);
    state = runtime?.readState?.() || { accounts: {} };
  } catch (error) {
    return {
      ok: false,
      discovered: 0,
      restored: 0,
      failed: 1,
      error: 'zcode_egress_restore_state_unavailable',
      reason: String(error?.message || error || 'unknown'),
      results: []
    };
  }

  const accountRefs = Object.keys(state?.accounts || {}).filter(Boolean);
  const results = [];
  for (const accountRef of accountRefs) {
    let result;
    let provider = '';
    try {
      const resolveStoredAccount = typeof deps.resolveAccountRef === 'function'
        ? deps.resolveAccountRef
        : resolveAccountRef;
      const account = resolveStoredAccount(input.fs, input.aiHomeDir, accountRef, {
        bestEffort: true
      });
      provider = String(account?.provider || '').trim().toLowerCase();
    } catch {}
    if (!isEgressSupportedProvider(provider)) {
      results.push({
        accountRef,
        ok: false,
        applied: false,
        status: '',
        error: 'egress_account_not_found'
      });
      continue;
    }
    try {
      result = await applyStoredAccountEgress({
        ...input,
        provider,
        accountRef,
        deps: {
          ...deps,
          zcodeSingBoxRuntime: runtime
        }
      });
    } catch (error) {
      result = {
        ok: false,
        applied: false,
        error: 'zcode_egress_restore_failed',
        reason: String(error?.message || error || 'unknown')
      };
    }
    results.push({
      accountRef,
      provider,
      ok: result?.ok === true,
      applied: result?.applied === true,
      status: String(result?.status || ''),
      ...(result?.error ? { error: String(result.error) } : {}),
      ...(result?.reason ? { reason: String(result.reason) } : {})
    });
  }

  const restored = results.filter((result) => result.ok && result.applied).length;
  const failed = results.filter((result) => !result.ok).length;
  return {
    ok: failed === 0,
    discovered: accountRefs.length,
    restored,
    failed,
    results
  };
}

function desktopTakeoverFailure(result, fallbackError) {
  return {
    ok: false,
    applied: false,
    error: String(result?.error || fallbackError),
    ...(result?.reason ? { reason: String(result.reason) } : {}),
    ...(Array.isArray(result?.pids) ? { pids: result.pids } : {})
  };
}

async function cleanupTakeoverEgress(input, egress) {
  await cleanupPreparedEgress({
    launchInput: { accountRef: input.accountRef },
    egressInput: {
      aiHomeDir: input.aiHomeDir,
      deps: input.deps || {}
    }
  }, egress);
}

async function takeoverRunningDesktopWithStoredEgressOnce(input = {}) {
  const launcher = input.launcher;
  const provider = String(input.provider || '').trim().toLowerCase();
  const accountRef = String(input.accountRef || '').trim();
  const probeFailedError = providerEgressError(
    provider,
    'account_desktop_egress_probe_failed',
    'zcode_desktop_probe_failed'
  );
  const closeFailedError = providerEgressError(
    provider,
    'account_desktop_egress_close_failed',
    'zcode_desktop_close_failed'
  );
  const launchInput = {
    provider,
    accountRef,
    kind: 'desktop',
    action: 'open'
  };

  let preflight;
  try {
    preflight = await Promise.resolve(launcher.launchAccountApp({
      ...launchInput,
      // 保留 deferDesktopSpawn 兼容旧 launcher 注入；真实启动器优先使用新的
      // 只读运行态探针，Kimi 不会因此触发 token 仓准备。
      deferDesktopSpawn: true,
      inspectDesktopRunning: true
    }));
  } catch (error) {
    return desktopTakeoverFailure({ reason: error?.message }, probeFailedError);
  }
  if (preflight?.ok && [APP_STATUS_LAUNCH_READY, 'not_running'].includes(preflight.status)) {
    return { ok: true, applied: false, status: 'pending_launch' };
  }
  if (!preflight?.ok || preflight.status !== 'already_running') {
    return desktopTakeoverFailure(preflight, probeFailedError);
  }

  const preparation = await prepareAccountAppEgress({
    ...input,
    action: 'open',
    kind: 'desktop',
    provider,
    accountRef
  });
  if (!preparation.ok) {
    return {
      ok: false,
      applied: false,
      error: String(preparation.error || providerEgressError(
        provider,
        ACCOUNT_EGRESS_UNAVAILABLE,
        ZCODE_EGRESS_UNAVAILABLE
      )),
      ...(preparation.egressError ? { egressError: String(preparation.egressError) } : {}),
      ...(preparation.reason ? { reason: String(preparation.reason) } : {})
    };
  }

  const egress = preparation.egress;
  let closed;
  try {
    closed = await Promise.resolve(launcher.launchAccountApp({
      ...launchInput,
      action: 'close'
    }));
  } catch (error) {
    closed = { ok: false, error: closeFailedError, reason: error?.message };
  }
  if (!closed?.ok || !['closed', 'not_running'].includes(String(closed.status || ''))) {
    await cleanupTakeoverEgress(input, egress);
    return desktopTakeoverFailure(closed, closeFailedError);
  }

  let launched;
  try {
    launched = await Promise.resolve(launcher.launchAccountApp({
      ...launchInput,
      ...(preparation.egressPrepared ? { egress } : {})
    }));
  } catch (error) {
    launched = { ok: false, error: 'launch_failed', reason: error?.message };
  }
  if (!launched?.ok || launched.status !== 'launched') {
    await cleanupTakeoverEgress(input, egress);
    return desktopTakeoverFailure(launched, 'launch_failed');
  }

  const finalized = await finalizeLaunchedLease({
    launchInput,
    egressInput: {
      aiHomeDir: input.aiHomeDir,
      deps: input.deps || {}
    }
  }, egress, launched);
  if (!finalized.ok) {
    try {
      await Promise.resolve(launcher.launchAccountApp({ ...launchInput, action: 'close' }));
    } catch {}
    await cleanupTakeoverEgress(input, egress);
    return desktopTakeoverFailure(finalized, finalized.error || 'zcode_egress_process_missing');
  }

  trackAccountHealth(input, egress || {});
  return {
    ok: true,
    applied: true,
    status: 'restarted',
    restarted: true,
    pid: Number(launched.pid) || null,
    previousPids: Array.isArray(preflight.pids) ? preflight.pids : [],
    source: String(egress?.source || 'direct'),
    proxyServer: String(egress?.proxyServer || ''),
    selectedNodeId: egress?.selectedNodeId || null,
    groupId: egress?.groupId || null,
    sidecar: egress?.sidecar || null
  };
}

function takeoverRunningDesktopWithStoredEgress(input = {}) {
  return enqueueDesktopAccountOperation(
    input.provider,
    input.accountRef,
    'replace',
    () => takeoverRunningDesktopWithStoredEgressOnce(input)
  );
}

function resolvedTargetFromRuntimeSnapshot(snapshot, lease) {
  const selectedTarget = cloneJsonValue(snapshot?.selectedTarget);
  if (!selectedTarget) return null;
  const candidateNodes = (Array.isArray(snapshot?.candidateTargets) ? snapshot.candidateTargets : [])
    .filter((target) => target?.kind === 'node' && target.node)
    .map((target) => cloneJsonValue(target.node));
  return {
    ok: true,
    source: String(snapshot?.source || EGRESS_MODE_GROUP),
    target: selectedTarget,
    candidateNodes,
    selectedNodeId: String(snapshot?.selectedNodeId || lease?.nodeId || '').trim(),
    groupId: String(snapshot?.groupId || lease?.groupId || '').trim()
  };
}

async function failClosedAfterRollbackError({ runtime, leaseStore, accountRef, ownerId }) {
  try { leaseStore?.release?.(ownerId); } catch {}
  try { await runtime?.releaseAccount?.(accountRef); } catch {}
}

async function restoreRotatedAccount(input = {}) {
  const {
    accountRef,
    deps,
    leaseStore,
    originalLease,
    originalResolvedTarget,
    runtime
  } = input;
  let endpoint;
  try {
    endpoint = await runtime.ensureAccountEndpoint({
      accountRef,
      resolvedTarget: originalResolvedTarget
    });
  } catch (error) {
    endpoint = runtimeErrorResult('sing_box_apply_failed', error);
  }
  if (!endpoint?.ok || !String(endpoint.proxyServer || '').trim()) {
    await failClosedAfterRollbackError({
      runtime,
      leaseStore,
      accountRef,
      ownerId: originalLease.ownerId
    });
    return {
      ok: false,
      error: 'zcode_egress_rotate_rollback_failed',
      reason: String(endpoint?.reason || endpoint?.error || 'sing_box_apply_failed')
    };
  }

  try {
    leaseStore.acquire({
      ownerId: originalLease.ownerId,
      accountRef,
      instanceKind: originalLease.instanceKind || 'desktop',
      groupId: originalLease.groupId,
      nodeId: originalLease.nodeId,
      pid: originalLease.pid
    });
  } catch (error) {
    await failClosedAfterRollbackError({
      runtime,
      leaseStore,
      accountRef,
      ownerId: originalLease.ownerId
    });
    return runtimeErrorResult('zcode_egress_rotate_rollback_failed', error);
  }

  trackAccountHealth({ ...input, deps }, {
    source: EGRESS_MODE_GROUP,
    selectedNodeId: originalLease.nodeId,
    groupId: originalLease.groupId,
    proxyServer: String(endpoint.proxyServer)
  });
  return {
    ok: true,
    proxyServer: String(endpoint.proxyServer),
    selectedNodeId: originalLease.nodeId,
    groupId: originalLease.groupId
  };
}

async function rotateStoredAccountEgressOnce(input = {}) {
  const accountRef = String(input.accountRef || '').trim();
  const provider = String(input.provider || '').trim().toLowerCase();
  if (!isEgressSupportedProvider(provider)) {
    return runtimeErrorResult('egress_unsupported_provider');
  }
  if (!input.fs || !input.aiHomeDir || !accountRef) {
    return runtimeErrorResult('egress_context_missing');
  }
  const deps = input.deps || {};
  let binding;
  try {
    binding = readStoredBinding({ ...input, accountRef }, deps);
  } catch (error) {
    return runtimeErrorResult('egress_binding_read_failed', error);
  }
  if (!binding || binding.mode !== EGRESS_MODE_GROUP) {
    return runtimeErrorResult('zcode_egress_rotate_requires_group');
  }

  const runtime = resolveRuntime(deps, input.aiHomeDir);
  let sidecar;
  try {
    sidecar = runtime.getStatus?.() || {};
  } catch (error) {
    return runtimeErrorResult('sidecar_status_unavailable', error);
  }
  const accountStatus = (Array.isArray(sidecar.accounts) ? sidecar.accounts : [])
    .find((candidate) => candidate?.accountRef === accountRef) || null;
  if (sidecar.running !== true || sidecar.dataPlaneReady !== true || !accountStatus) {
    return runtimeErrorResult('zcode_egress_not_running');
  }

  const ownerId = buildZcodeEgressOwnerId(accountRef);
  const leaseStore = resolveLeaseStore(deps, input.aiHomeDir);
  const originalLease = leaseStore.getByOwner?.(ownerId) || null;
  const originalPid = Number(originalLease?.pid);
  if (
    !originalLease?.nodeId
    || !originalLease?.groupId
    || !Number.isInteger(originalPid)
    || originalPid <= 0
  ) {
    return runtimeErrorResult('zcode_egress_not_running');
  }

  let snapshot;
  try {
    snapshot = runtime.getAccountState?.(accountRef) || null;
  } catch (error) {
    return runtimeErrorResult('sidecar_state_unavailable', error);
  }
  const originalResolvedTarget = resolvedTargetFromRuntimeSnapshot(snapshot, originalLease);
  if (!originalResolvedTarget || originalResolvedTarget.selectedNodeId !== originalLease.nodeId) {
    return runtimeErrorResult('zcode_egress_state_mismatch');
  }

  const nodeStore = resolveNodeStore(deps);
  let group = null;
  let groupNodes = [];
  try {
    group = nodeStore.getGroup?.(binding.groupId) || null;
    groupNodes = nodeStore.listNodes?.({ group: binding.groupId }) || [];
  } catch {}
  if (group?.failoverStrategy === STRATEGY_LOWEST_LATENCY) {
    await refreshAccountCandidateLatencies({
      accountRef,
      runtime,
      nodeStore,
      candidateNodes: groupNodes,
      failedNodeIds: [originalLease.nodeId],
      deps
    });
  }
  const failedNodeIds = new Set([originalLease.nodeId]);
  const attemptedNodeIds = [];
  let lastFailure = null;

  for (;;) {
    const resolvedTarget = await resolveZcodeEgressTarget({
      binding,
      processObj: input.processObj || process,
      nodeStore,
      leaseStore,
      ownerId,
      currentNodeId: originalLease.nodeId,
      failedNodeIds: [...failedNodeIds],
      random: deps.random,
      detectSystemProxy: deps.detectSystemProxy,
      detectTun: deps.detectTun
    });
    if (!resolvedTarget.ok) {
      if (resolvedTarget.error !== 'no_available_proxy_node') return resolvedTarget;
      if (attemptedNodeIds.length === 0) {
        return {
          ok: false,
          applied: false,
          error: 'zcode_egress_rotate_no_candidate',
          previousNodeId: originalLease.nodeId,
          rolledBack: true
        };
      }
      const rollback = await restoreRotatedAccount({
        ...input,
        accountRef,
        deps,
        leaseStore,
        originalLease,
        originalResolvedTarget,
        runtime
      });
      if (!rollback.ok) {
        return {
          ...rollback,
          applied: false,
          previousNodeId: originalLease.nodeId,
          attemptedNodeCount: attemptedNodeIds.length,
          rotateError: String(lastFailure?.error || 'proxy_unreachable')
        };
      }
      return {
        ok: false,
        applied: false,
        error: 'zcode_egress_rotate_no_healthy_candidate',
        reason: String(lastFailure?.reason || lastFailure?.error || 'proxy_probe_failed'),
        previousNodeId: originalLease.nodeId,
        selectedNodeId: originalLease.nodeId,
        groupId: originalLease.groupId,
        proxyServer: rollback.proxyServer,
        attemptedNodeCount: attemptedNodeIds.length,
        rolledBack: true
      };
    }

    const selectedNodeId = String(resolvedTarget.selectedNodeId || '').trim();
    if (!selectedNodeId || failedNodeIds.has(selectedNodeId)) {
      return runtimeErrorResult('zcode_egress_rotate_selection_invalid');
    }
    attemptedNodeIds.push(selectedNodeId);
    try {
      leaseStore.acquire({
        ownerId,
        accountRef,
        instanceKind: originalLease.instanceKind || 'desktop',
        groupId: String(resolvedTarget.groupId || originalLease.groupId),
        nodeId: selectedNodeId,
        pid: originalPid
      });
    } catch (error) {
      lastFailure = runtimeErrorResult('zcode_egress_lease_failed', error);
      const rollback = await restoreRotatedAccount({
        ...input,
        accountRef,
        deps,
        leaseStore,
        originalLease,
        originalResolvedTarget,
        runtime
      });
      return rollback.ok
        ? { ...lastFailure, applied: false, previousNodeId: originalLease.nodeId, rolledBack: true }
        : { ...rollback, applied: false, rotateError: lastFailure.error };
    }

    let endpoint;
    try {
      endpoint = await runtime.ensureAccountEndpoint({ accountRef, resolvedTarget });
    } catch (error) {
      endpoint = runtimeErrorResult('sing_box_apply_failed', error);
    }
    if (!endpoint?.ok || !String(endpoint.proxyServer || '').trim()) {
      lastFailure = {
        ok: false,
        error: String(endpoint?.error || 'sing_box_apply_failed'),
        ...(endpoint?.reason ? { reason: String(endpoint.reason) } : {})
      };
      const rollback = await restoreRotatedAccount({
        ...input,
        accountRef,
        deps,
        leaseStore,
        originalLease,
        originalResolvedTarget,
        runtime
      });
      return rollback.ok
        ? { ...lastFailure, applied: false, previousNodeId: originalLease.nodeId, rolledBack: true }
        : { ...rollback, applied: false, rotateError: lastFailure.error };
    }

    const proxyServer = String(endpoint.proxyServer).trim();
    let probe;
    try {
      probe = await resolveProbe(deps)(proxyServer);
    } catch (error) {
      probe = { ok: false, reason: String(error?.message || error || 'unknown') };
    }
    if (probe?.ok) {
      const applied = {
        ok: true,
        applied: true,
        rotated: true,
        status: endpoint.action || 'selected',
        proxyServer,
        source: EGRESS_MODE_GROUP,
        previousNodeId: originalLease.nodeId,
        selectedNodeId,
        groupId: String(resolvedTarget.groupId || originalLease.groupId),
        sidecar: endpoint.sidecar || null
      };
      trackAccountHealth({ ...input, accountRef, deps }, applied);
      return applied;
    }

    lastFailure = {
      ok: false,
      error: 'proxy_unreachable',
      reason: String(probe?.reason || probe?.error || 'proxy_probe_failed')
    };
    failedNodeIds.add(selectedNodeId);
  }
}

function rotateStoredAccountEgress(input = {}) {
  return enqueueAccountEgressMutation(
    input.accountRef,
    () => rotateStoredAccountEgressOnce(input)
  );
}

function runtimeErrorResult(error, cause) {
  return {
    ok: false,
    error,
    ...(cause ? { reason: String(cause?.message || cause || 'unknown') } : {})
  };
}

async function prepareAccountAppEgress(input = {}) {
  const action = String(input.action || 'open').trim().toLowerCase();
  const kind = String(input.kind || '').trim().toLowerCase();
  const provider = String(input.provider || '').trim().toLowerCase();
  if (action !== 'open' || kind !== 'desktop') {
    return { ok: true, egress: null, egressPrepared: false };
  }

  let egress;
  try {
    egress = await resolveAccountEgress(input);
  } catch (error) {
    const failure = {
      ok: false,
      error: 'egress_resolve_failed',
      reason: String(error?.message || error || 'unknown'),
      preserveExisting: true
    };
    return {
      ok: false,
      error: providerEgressError(
        provider,
        ACCOUNT_EGRESS_BINDING_UNAVAILABLE,
        ZCODE_EGRESS_BINDING_UNAVAILABLE
      ),
      egress: null,
      egressPrepared: false,
      egressError: failure.error,
      reason: failure.reason,
      warning: describeEgressWarning({ ...failure, provider })
    };
  }
  if (!egress) {
    return {
      ok: true,
      egress: null,
      egressPrepared: isEgressSupportedProvider(input.provider),
      warning: ''
    };
  }
  if (egress.ok) return { ok: true, egress, egressPrepared: true, warning: '' };
  return {
    ok: false,
    error: providerEgressError(provider, ACCOUNT_EGRESS_UNAVAILABLE, ZCODE_EGRESS_UNAVAILABLE),
    egress: null,
    egressPrepared: false,
    egressError: String(egress.error || 'unknown'),
    ...(egress.reason ? { reason: String(egress.reason) } : {}),
    warning: describeEgressWarning({ ...egress, provider })
  };
}

async function finalizeLaunchedLease(input, egress, result) {
  if (!egress?.leaseOwnerId) return { ok: true };
  if (String(input.launchInput?.provider || '').trim().toLowerCase() !== 'zcode') {
    // 通用 provider 的租约绑定 sidecar PID，覆盖 CLI/Gateway/Desktop 的共同寿命；
    // 不能换成某一个 Desktop PID，否则关闭窗口会让仍在使用的 endpoint 失租。
    return { ok: true };
  }
  const pid = Number(result?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, error: 'zcode_egress_process_missing' };
  }
  const deps = input.egressInput?.deps || {};
  try {
    const leaseStore = resolveLeaseStore(deps, input.egressInput?.aiHomeDir);
    const attached = leaseStore.attachProcess(egress.leaseOwnerId, pid);
    return attached
      ? { ok: true }
      : { ok: false, error: 'zcode_egress_lease_missing' };
  } catch (error) {
    return {
      ok: false,
      error: 'zcode_egress_lease_attach_failed',
      reason: String(error?.message || error || 'unknown')
    };
  }
}

async function cleanupPreparedEgress(input, egress) {
  if (!egress) return;
  await releasePendingSelection({
    accountRef: input.launchInput?.accountRef,
    aiHomeDir: input.egressInput?.aiHomeDir,
    deps: input.egressInput?.deps || {},
    ownerId: egress.leaseOwnerId
  });
}

async function launchAccountAppWithEgressOnce(input = {}) {
  const launcher = input.launcher;
  if (!launcher || typeof launcher.launchAccountApp !== 'function') {
    throw new Error('account_app_launcher_missing');
  }
  const launchInput = input.launchInput && typeof input.launchInput === 'object'
    ? { ...input.launchInput }
    : {};
  const provider = String(launchInput.provider || '').trim().toLowerCase();
  const action = String(launchInput.action || 'open').trim().toLowerCase();
  const kind = String(launchInput.kind || '').trim().toLowerCase();
  const accountRef = String(launchInput.accountRef || '').trim();

  if (!isEgressSupportedProvider(provider) || kind !== 'desktop') {
    return { result: launcher.launchAccountApp(launchInput), egressWarning: '' };
  }
  if (action === 'close') {
    const result = launcher.launchAccountApp(launchInput);
    if (result?.ok && (result.status === 'closed' || result.status === 'not_running')) {
      const resourceInput = {
        accountRef,
        fs: input.egressInput?.fs,
        aiHomeDir: input.egressInput?.aiHomeDir,
        deps: input.egressInput?.deps || {}
      };
      if (!hasStoredAccountEgressBinding(resourceInput)) {
        await releaseAccountResources(resourceInput);
      }
    }
    return { result, egressWarning: '' };
  }
  if (action !== 'open') return { result: launcher.launchAccountApp(launchInput), egressWarning: '' };

  const preflight = launcher.launchAccountApp({ ...launchInput, deferDesktopSpawn: true });
  if (!preflight || !preflight.ok || preflight.status !== APP_STATUS_LAUNCH_READY) {
    return {
      result: preflight,
      egressWarning: preflight?.ok && preflight.status === 'already_running'
        ? describeAlreadyRunningWarning({ provider })
        : ''
    };
  }

  const egressPreparation = await prepareAccountAppEgress({
    ...(input.egressInput || {}),
    action,
    kind,
    provider,
    accountRef
  });
  let egressWarning = String(egressPreparation.warning || '');
  if (!egressPreparation.ok) {
    return {
      result: {
        ok: false,
        error: String(egressPreparation.error || providerEgressError(
          provider,
          ACCOUNT_EGRESS_UNAVAILABLE,
          ZCODE_EGRESS_UNAVAILABLE
        )),
        ...(egressPreparation.egressError ? { egressError: String(egressPreparation.egressError) } : {}),
        ...(egressPreparation.reason ? { reason: String(egressPreparation.reason) } : {})
      },
      egressWarning
    };
  }

  const result = launcher.launchAccountApp({
    ...launchInput,
    ...(egressPreparation.egressPrepared ? { egress: egressPreparation.egress } : {})
  });
  egressWarning = mergeWarnings(egressWarning, result?.egressWarning);
  if (result?.ok && result.status === 'launched') {
    const finalized = await finalizeLaunchedLease(input, egressPreparation.egress, result);
    if (!finalized.ok) {
      try { launcher.launchAccountApp({ ...launchInput, action: 'close' }); } catch {}
      await cleanupPreparedEgress(input, egressPreparation.egress);
      return {
        result: {
          ok: false,
          error: finalized.error,
          ...(finalized.reason ? { reason: finalized.reason } : {})
        },
        egressWarning: mergeWarnings(egressWarning, 'ZCode 已关闭：出口租约未能绑定到真实进程')
      };
    }
    trackAccountHealth({
      ...(input.egressInput || {}),
      provider,
      accountRef
    }, egressPreparation.egress);
    return { result, egressWarning };
  }

  await cleanupPreparedEgress(input, egressPreparation.egress);
  if (result?.ok && result.status === 'already_running') {
    egressWarning = mergeWarnings(egressWarning, describeAlreadyRunningWarning({ raced: true, provider }));
  }
  return { result, egressWarning };
}

async function launchAccountAppWithEgress(input = {}) {
  const launchInput = input.launchInput && typeof input.launchInput === 'object'
    ? input.launchInput
    : {};
  const provider = String(launchInput.provider || '').trim().toLowerCase();
  const accountRef = String(launchInput.accountRef || '').trim();
  const action = String(launchInput.action || 'open').trim().toLowerCase();
  const kind = String(launchInput.kind || '').trim().toLowerCase();
  if (
    !accountRef
    || !isEgressSupportedProvider(provider)
    || kind !== 'desktop'
    || (action !== 'open' && action !== 'close')
  ) {
    return launchAccountAppWithEgressOnce(input);
  }

  return enqueueDesktopAccountOperation(
    provider,
    accountRef,
    action,
    () => launchAccountAppWithEgressOnce(input)
  );
}

function describeEgressWarning(egress) {
  if (!egress || egress.ok) return '';
  const reason = egress.reason ? `（${egress.reason}）` : '';
  if (egress.error === 'not_supported') {
    return `当前仅支持 macOS，当前平台为 ${egress.platform || 'unknown'}；为避免绕过账号绑定，本次阻止启动`;
  }
  const messageByError = {
    invalid_proxy_url: '代理地址无效',
    system_proxy_unavailable: '未检测到可用的系统代理',
    tun_inactive: '未检测到已激活的外部 TUN',
    tun_state_unknown: '无法确认外部 TUN 状态',
    missing_node_id: '未选择代理节点',
    missing_group_id: '未选择代理分组',
    proxy_node_not_found: '代理节点不存在',
    proxy_group_not_found: '代理分组不存在',
    no_available_proxy_node: '分组内没有可用节点',
    sing_box_unavailable: 'sing-box 不可用',
    sing_box_config_invalid: 'sing-box 配置校验失败',
    sing_box_start_failed: 'sing-box 启动失败',
    sing_box_readiness_failed: 'sing-box 本地监听未就绪',
    sing_box_connection_close_failed: '账号旧连接清理失败',
    sing_box_selector_rollback_failed: '代理节点切换回滚失败',
    zcode_sidecar_port_conflict: '账号固定代理端口被占用',
    proxy_unreachable: '代理出口连通性探测失败',
    unknown_egress_mode: '出口绑定模式无效',
    egress_resolve_failed: '出口解析异常'
  };
  const message = messageByError[egress.error] || String(egress.error || '未知错误');
  if (egress.preserveExisting) {
    const settingsLabel = String(egress.provider || '').trim().toLowerCase() === 'zcode'
      ? '现有 ZCode 原生设置'
      : '现有客户端设置';
    return `${message}${reason}；为避免绕过账号绑定，本次保留${settingsLabel}并阻止启动`;
  }
  return `${message}${reason}；为避免绕过账号绑定，本次阻止启动`;
}

module.exports = {
  ACCOUNT_EGRESS_BINDING_UNAVAILABLE,
  ACCOUNT_EGRESS_UNAVAILABLE,
  EGRESS_SUPPORTED_PROVIDERS,
  ZCODE_EGRESS_BINDING_UNAVAILABLE,
  ZCODE_EGRESS_UNAVAILABLE,
  applyStoredAccountEgress,
  buildZcodeEgressOwnerId,
  describeEgressWarning,
  getAccountEgressRuntimeStatus,
  isEgressSupportedProvider,
  launchAccountAppWithEgress,
  pickZcodeEgressDependencies,
  prepareAccountAppEgress,
  releaseAccountResources,
  restorePersistedZcodeEgress,
  resolveAccountEgress,
  resolveAccountEgressRequestOptions,
  rotateStoredAccountEgress
};
