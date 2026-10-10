'use strict';

// 账号出口编排：读取绑定 → 解析成外部代理或 TUN 直连 → 探测外部代理 → Desktop 启动 /
// 重启收敛。AIH 不运行代理内核、不开本地端口；任何失败都 fail-closed，不回退到全局
// 代理或直连，也不改写宿主网络。

const { readAccountEgressBinding } = require('../account/zcode-egress-binding-store');
const nodeFs = require('node:fs');
const { getProviderClientSupport, listProviderIds } = require('../provider-catalog');
const { APP_STATUS_LAUNCH_READY } = require('./account-app-launcher');
const { probeZcodeProxy } = require('./zcode-egress-probe');
const { normalizeProxyUrl, resolveEgressTarget } = require('./zcode-egress-resolver');

const EGRESS_SUPPORTED_PROVIDERS = Object.freeze(listProviderIds());
const ACCOUNT_EGRESS_NO_PROXY = 'localhost,127.0.0.1,::1';
const ACCOUNT_EGRESS_BINDING_UNAVAILABLE = 'account_egress_binding_unavailable';
const ACCOUNT_EGRESS_UNAVAILABLE = 'account_egress_unavailable';
const ZCODE_EGRESS_BINDING_UNAVAILABLE = 'zcode_egress_binding_unavailable';
const ZCODE_EGRESS_UNAVAILABLE = 'zcode_egress_unavailable';
const desktopAccountOperations = new Map();
const accountEgressMutations = new Map();
const ZCODE_EGRESS_DEPENDENCY_KEYS = Object.freeze([
  'readAccountEgressBinding',
  'probeProxyServer',
  'execFile',
  'curlPath',
  'proxyProbeUrl',
  'proxyProbeTimeoutMs',
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

function mergeWarnings(...warnings) {
  return [...new Set(warnings.map((warning) => String(warning || '').trim()).filter(Boolean))]
    .join('；');
}

function describeAlreadyRunningWarning({ raced = false, provider = '' } = {}) {
  const clientLabel = String(provider || '').trim().toLowerCase() === 'zcode'
    ? 'ZCode '
    : '客户端';
  return raced
    ? '启动期间已有实例抢先运行，本次出口设置未被该实例加载；请在出口设置中重新应用'
    : `${clientLabel}当前实例已运行；出口变更请在出口设置中应用（会重启该实例）`;
}

function runtimeErrorResult(error, cause) {
  return {
    ok: false,
    error,
    ...(cause ? { reason: String(cause?.message || cause || 'unknown') } : {})
  };
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

/**
 * 解析账号出口。返回 null 表示未绑定；否则：
 * - { ok: true, source, proxyServer: 'http(s)://host:port' }：外部代理（已探测可用，skipProbe 时跳过）
 * - { ok: true, source: 'tun', proxyServer: '', direct: true }：外部 TUN 接管，客户端直连
 * - { ok: false, error, reason? }：调用方必须 fail-closed
 */
async function resolveAccountEgress(input = {}) {
  const { fs, aiHomeDir, provider } = input;
  const accountRef = String(input.accountRef || '').trim();
  if (!isEgressSupportedProvider(provider)) return null;
  if (!fs || !aiHomeDir || !accountRef) throw new Error('egress_context_missing');

  const deps = input.deps || {};
  const binding = readStoredBinding({ ...input, accountRef }, deps);
  if (!binding) return null;

  const resolved = resolveEgressTarget({
    binding,
    processObj: input.processObj || process,
    detectSystemProxy: deps.detectSystemProxy,
    detectTun: deps.detectTun,
    useDetectionCache: input.useDetectionCache === true
  });
  if (!resolved.ok) {
    const { target: _target, source: _source, ...failure } = resolved;
    return { ...failure, proxyServer: '', source: '' };
  }
  if (resolved.target.kind === 'direct') {
    return { ok: true, source: resolved.source, proxyServer: '', direct: true };
  }
  const proxyServer = resolved.target.proxyUrl;
  if (input.skipProbe === true) return { ok: true, source: resolved.source, proxyServer };

  let probe;
  try {
    probe = await resolveProbe(deps)(proxyServer);
  } catch (error) {
    probe = { ok: false, reason: String(error?.message || error || 'unknown') };
  }
  if (!probe?.ok) {
    return {
      ok: false,
      proxyServer: '',
      source: '',
      error: 'proxy_unreachable',
      reason: String(probe?.reason || probe?.error || 'proxy_probe_failed')
    };
  }
  return { ok: true, source: resolved.source, proxyServer };
}

// Gateway 在选定账号后调用本适配器，把全局网络选项转换成 attempt-local 选项。
// 热路径不做连通性探测（系统代理 / TUN 的探测结果短期缓存）；绑定失败时不返回
// options，调用方因此无法回落到全局代理或直连。
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

  let egress;
  try {
    egress = typeof deps.resolveAccountEgress === 'function'
      ? await deps.resolveAccountEgress({ ...input, fs: fsImpl, aiHomeDir, provider, accountRef })
      : await resolveAccountEgress({
        ...input,
        fs: fsImpl,
        aiHomeDir,
        provider,
        accountRef,
        deps,
        skipProbe: true,
        useDetectionCache: true
      });
  } catch (error) {
    return {
      ok: false,
      bound: true,
      error: ACCOUNT_EGRESS_UNAVAILABLE,
      egressError: 'egress_binding_read_failed',
      reason: String(error?.message || error || 'unknown')
    };
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
  if (egress.direct) {
    // TUN：空代理 + 全量 no-proxy，确保不会落到服务端全局上游代理上。
    return { ok: true, bound: true, options: { ...options, proxyUrl: '', noProxy: '*' }, egress };
  }
  const proxyUrl = normalizeProxyUrl(egress.proxyServer);
  if (!proxyUrl) {
    return {
      ok: false,
      bound: true,
      error: ACCOUNT_EGRESS_UNAVAILABLE,
      egressError: 'account_egress_endpoint_invalid'
    };
  }
  return {
    ok: true,
    bound: true,
    options: { ...options, proxyUrl, noProxy: ACCOUNT_EGRESS_NO_PROXY },
    egress
  };
}

function describeEgressSummary(egress) {
  if (!egress) return {};
  return {
    source: String(egress.source || ''),
    proxyServer: String(egress.proxyServer || ''),
    ...(egress.direct ? { direct: true } : {})
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
    egress = await resolveAccountEgress({ ...input, useDetectionCache: false });
  } catch (error) {
    const failure = {
      ok: false,
      error: 'egress_resolve_failed',
      reason: String(error?.message || error || 'unknown'),
      preserveExisting: true
    };
    return {
      ok: false,
      error: providerEgressError(provider, ACCOUNT_EGRESS_BINDING_UNAVAILABLE, ZCODE_EGRESS_BINDING_UNAVAILABLE),
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

function inspectRunningDesktop(launcher, provider, accountRef) {
  return Promise.resolve(launcher.launchAccountApp({
    provider,
    accountRef,
    kind: 'desktop',
    action: 'open',
    // 保留 deferDesktopSpawn 兼容旧 launcher 注入；真实启动器优先使用只读运行态探针。
    deferDesktopSpawn: true,
    inspectDesktopRunning: true
  }));
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

/**
 * 出口变更后让已运行的 Desktop 生效：env、Chromium 参数与 ZCode 原生设置都只在启动时
 * 读取，因此关闭后用新出口重新启动。没有实例在运行时下一次启动自然生效。
 */
async function restartRunningDesktopOnce(input, egress) {
  const launcher = input.launcher;
  const provider = String(input.provider || '').trim().toLowerCase();
  const accountRef = String(input.accountRef || '').trim();
  const probeFailedError = providerEgressError(provider, 'account_desktop_egress_probe_failed', 'zcode_desktop_probe_failed');
  const closeFailedError = providerEgressError(provider, 'account_desktop_egress_close_failed', 'zcode_desktop_close_failed');
  const launchInput = { provider, accountRef, kind: 'desktop', action: 'open' };

  let preflight;
  try {
    preflight = await inspectRunningDesktop(launcher, provider, accountRef);
  } catch (error) {
    return desktopTakeoverFailure({ reason: error?.message }, probeFailedError);
  }
  if (preflight?.ok && [APP_STATUS_LAUNCH_READY, 'not_running'].includes(preflight.status)) {
    return { ok: true, status: 'not_running' };
  }
  if (!preflight?.ok || preflight.status !== 'already_running') {
    return desktopTakeoverFailure(preflight, probeFailedError);
  }

  let closed;
  try {
    closed = await Promise.resolve(launcher.launchAccountApp({ ...launchInput, action: 'close' }));
  } catch (error) {
    closed = { ok: false, error: closeFailedError, reason: error?.message };
  }
  if (!closed?.ok || !['closed', 'not_running'].includes(String(closed.status || ''))) {
    return desktopTakeoverFailure(closed, closeFailedError);
  }

  let launched;
  try {
    launched = await Promise.resolve(launcher.launchAccountApp({ ...launchInput, egress: egress || null }));
  } catch (error) {
    launched = { ok: false, error: 'launch_failed', reason: error?.message };
  }
  if (!launched?.ok || launched.status !== 'launched') {
    return desktopTakeoverFailure(launched, 'launch_failed');
  }
  return {
    ok: true,
    applied: true,
    status: 'restarted',
    restarted: true,
    pid: Number(launched.pid) || null,
    previousPids: Array.isArray(preflight.pids) ? preflight.pids : []
  };
}

async function applyStoredAccountEgressOnce(input = {}) {
  const accountRef = String(input.accountRef || '').trim();
  const provider = String(input.provider || '').trim().toLowerCase();
  if (!isEgressSupportedProvider(provider)) return runtimeErrorResult('egress_unsupported_provider');
  if (!input.fs || !input.aiHomeDir || !accountRef) return runtimeErrorResult('egress_context_missing');

  // 先按当前绑定解析并探测一次：保存即可知道这条出口能不能用。
  let egress;
  try {
    egress = await resolveAccountEgress({ ...input, accountRef, provider, useDetectionCache: false });
  } catch (error) {
    return { ...runtimeErrorResult('egress_binding_read_failed', error), applied: false };
  }
  if (egress && !egress.ok) return { ...egress, applied: false };

  const launcher = input.launcher;
  if (getProviderClientSupport(provider).desktop && launcher && typeof launcher.launchAccountApp === 'function') {
    const restart = await enqueueDesktopAccountOperation(
      provider,
      accountRef,
      'replace',
      () => restartRunningDesktopOnce({ ...input, provider, accountRef }, egress)
    );
    if (!restart.ok) return restart;
    if (restart.status === 'restarted') return { ...restart, ...describeEgressSummary(egress) };
  }
  // 没有运行中的 Desktop：Gateway 请求立即按新绑定走，Desktop / CLI 下次启动生效。
  return {
    ok: true,
    applied: true,
    status: egress ? 'applied' : 'cleared',
    ...describeEgressSummary(egress)
  };
}

function applyStoredAccountEgress(input = {}) {
  return enqueueAccountEgressMutation(
    input.accountRef,
    () => applyStoredAccountEgressOnce(input)
  );
}

function resolveRunningDesktopPid(input, provider, accountRef) {
  const launcher = input.launcher;
  if (!launcher || typeof launcher.launchAccountApp !== 'function') return null;
  let result;
  try {
    result = launcher.launchAccountApp({
      provider,
      accountRef,
      kind: 'desktop',
      action: 'open',
      deferDesktopSpawn: true,
      inspectDesktopRunning: true
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

// WebUI 展示用：当前绑定实际会解析成什么（不探测连通性），以及 Desktop 是否在运行。
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

  let resolved = null;
  if (binding) {
    const target = resolveEgressTarget({
      binding,
      processObj: input.processObj || process,
      detectSystemProxy: deps.detectSystemProxy,
      detectTun: deps.detectTun
    });
    resolved = target.ok
      ? {
        ok: true,
        source: target.source,
        proxyServer: target.target.kind === 'proxy-url' ? target.target.proxyUrl : '',
        direct: target.target.kind === 'direct'
      }
      : { ok: false, error: target.error };
  }

  const desktopPid = getProviderClientSupport(provider).desktop
    ? resolveRunningDesktopPid(input, provider, accountRef)
    : null;
  return {
    ok: true,
    binding: binding || null,
    runtime: {
      resolved,
      desktopRunning: Boolean(desktopPid),
      desktopPid
    }
  };
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

  if (!isEgressSupportedProvider(provider) || kind !== 'desktop' || action !== 'open') {
    return { result: launcher.launchAccountApp(launchInput), egressWarning: '' };
  }

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

const EGRESS_ERROR_MESSAGES = Object.freeze({
  invalid_proxy_url: '代理地址无效',
  proxy_scheme_unsupported: '只支持 HTTP(S) 代理地址',
  system_proxy_unavailable: '未检测到可用的系统代理',
  system_proxy_http_unavailable: '系统代理只配置了 SOCKS，账号出口只支持 HTTP(S) 代理',
  tun_inactive: '未检测到已激活的外部 TUN',
  tun_state_unknown: '无法确认外部 TUN 状态',
  account_egress_mode_retired: '该账号的出口模式（节点/分组）已下线，请在出口设置里改为代理地址、系统代理或外部 TUN',
  proxy_unreachable: '代理出口连通性探测失败',
  unknown_egress_mode: '出口绑定模式无效',
  egress_resolve_failed: '出口解析异常'
});

function describeEgressWarning(egress) {
  if (!egress || egress.ok) return '';
  const reason = egress.reason ? `（${egress.reason}）` : '';
  if (egress.error === 'not_supported') {
    return `当前仅支持 macOS，当前平台为 ${egress.platform || 'unknown'}；为避免绕过账号绑定，本次阻止启动`;
  }
  const message = EGRESS_ERROR_MESSAGES[egress.error] || String(egress.error || '未知错误');
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
  describeEgressWarning,
  getAccountEgressRuntimeStatus,
  isEgressSupportedProvider,
  launchAccountAppWithEgress,
  pickZcodeEgressDependencies,
  prepareAccountAppEgress,
  resolveAccountEgress,
  resolveAccountEgressRequestOptions
};
