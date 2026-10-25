'use strict';

const { applyPersistedAccountRuntimeState, deriveAccountRuntimeStatus } = require('./account-runtime-state');
const { invalidateWebUiModelsCacheKeepingAccountCatalogs } = require('./webui-model-cache');
const {
  ACCOUNT_RUNTIME_CHANGED,
  isBlockingRuntimeStatus,
  isCatalogInvalidatingRuntimeStatus
} = require('./account-runtime-event-types');
const { withAccountQueryListFns } = require('./account-load-args');
const { notifyGoCoreProjection } = require('./go-core-projection-sync');

// 重建账号池的重入标记（见 reloadServerRuntimePool）。Symbol 键：不与装配进来的依赖字段冲突。
const POOL_RELOAD_IN_PROGRESS = Symbol('aih.serverPoolReloadInProgress');

// 需求：账号被标记不可用后，同 session affinity 不能继续粘到坏账号。
function removeSessionAffinityForAccount(state, provider, accountRef) {
  const sessionAffinity = state && state.sessionAffinity;
  const map = sessionAffinity && sessionAffinity[provider] instanceof Map ? sessionAffinity[provider] : null;
  if (!map) return 0;
  let removed = 0;
  map.forEach((entry, key) => {
    if (String(entry && entry.accountRef || '') === String(accountRef)) {
      map.delete(key);
      removed += 1;
    }
  });
  return removed;
}

// 需求：listener 需要按 provider/accountRef 找到当前内存账号，但不能知道调用方上下文。
function findRuntimeAccount(state, provider, accountRef) {
  const accounts = Array.isArray(state && state.accounts && state.accounts[provider])
    ? state.accounts[provider]
    : [];
  return accounts.find((account) => String(account && account.accountRef || '') === String(accountRef)) || null;
}

function buildRuntimeAccountLoadArgs(deps) {
  return withAccountQueryListFns({
    fs: deps.fs,
    aiHomeDir: deps.aiHomeDir,
    accountStateIndex: deps.accountStateIndex,
    getProfileDir: deps.getProfileDir,
    checkStatus: deps.checkStatus,
    serverPort: deps.options && deps.options.port
  }, deps);
}

// 需求：账号恢复、新增或重新登录时，通过统一 listener 重建 server 运行池。
//
// 不可重入（2026-10-19 事故）：重建池时 loadServerRuntimeAccounts 会按额度快照对 codex 账号做
// 「已验证恢复」（mergePersistedRuntimeFields → observeRecovery），恢复事件 runtimeState:null
// 又进到这里再次重建 —— 同步无限递归，栈溢出后被吞掉、进程 100% CPU、网关拒绝所有连接。
// 嵌套触发直接跳过：外层这次重建本来就在读最新状态（恢复后会重读 accountStateService），
// 结果已经包含嵌套那次想要的变化。
function reloadServerRuntimePool(deps) {
  const { state, loadServerRuntimeAccounts, applyReloadState } = deps;
  if (typeof loadServerRuntimeAccounts !== 'function' || typeof applyReloadState !== 'function') return false;
  if (deps[POOL_RELOAD_IN_PROGRESS]) return false;
  deps[POOL_RELOAD_IN_PROGRESS] = true;
  try {
    const runtimeAccounts = loadServerRuntimeAccounts(buildRuntimeAccountLoadArgs(deps));
    applyReloadState(state, runtimeAccounts);
  } finally {
    deps[POOL_RELOAD_IN_PROGRESS] = false;
  }
  // 池变即推送（见 go-core-projection-sync）：账号恢复/新增/重新登录会改变规则投影，
  // 不推送则 go-core-route-deferral 继续按旧规则表决定请求交给谁。
  notifyGoCoreProjection(deps, 'upstreamErrorRules');
  return true;
}

function createRuntimeStateIndexListener(deps = {}) {
  const { accountStateService } = deps;

  // 需求：账号状态变化必须先成为事件，再由监听器负责持久化，避免 producer 直接写 DB。
  return function runtimeStateIndexListener(event) {
    if (accountStateService && typeof accountStateService.clearRuntimeBlock === 'function' && event.runtimeState === null) {
      return accountStateService.clearRuntimeBlock(event.accountRef, event.provider, {
        ...(event.baseState || {}),
        evidence: event.reason || 'upstream_success',
        // 恢复事件的语义参数随事件走：scope='routing_block' 只清 routingBlock，
        // usageSnapshot 供 codex 的额度恢复判定（见 account-runtime-gate 的 observeRecovery）。
        ...(event.scope ? { scope: event.scope } : {}),
        ...(event.usageSnapshot ? { usageSnapshot: event.usageSnapshot } : {})
      });
    }
    if (accountStateService && typeof accountStateService.recordRuntimeFailure === 'function') {
      return accountStateService.recordRuntimeFailure(
        event.accountRef,
        event.provider,
        event.runtimeState,
        event.baseState
      );
    }
    return false;
  };
}

function resolveEventRuntimeStatus(event) {
  if (event.runtimeState && typeof event.runtimeState === 'object') {
    return deriveAccountRuntimeStatus(event.runtimeState).status;
  }
  return event.nextStatus;
}

function applyRuntimeStateToMemoryAccount(state, event) {
  const account = findRuntimeAccount(state, event.provider, event.accountRef);
  if (!account || !event.runtimeState || typeof event.runtimeState !== 'object') return null;
  return applyPersistedAccountRuntimeState(account, event.runtimeState);
}

function createServerPoolSyncListener(deps = {}) {
  const { state } = deps;

  // 需求：认证失效/限流等状态进入事件后，server 可调度池立刻失效对应账号的会话绑定。
  return function serverPoolSyncListener(event) {
    if (!state || typeof state !== 'object') return false;
    applyRuntimeStateToMemoryAccount(state, event);
    const runtimeStatus = resolveEventRuntimeStatus(event);
    if (isBlockingRuntimeStatus(runtimeStatus)) {
      removeSessionAffinityForAccount(state, event.provider, event.accountRef);
      // 只有认证失效才作废模型目录；限流/过载等临时冷却不动目录，
      // 否则一次 429 就会把全量目录清空，别名预检随后无据可依。
      //
      // 作废必须是**收窄**而不是清空：整池清空会让 byProvider 变成空集，路由随即失去
      // 「哪个 provider 有哪个模型」这唯一证据，请求落到按协议的兜底路由上（实测
      // 2026-10-25：裸名 deepseek-v4.1-flash 被交给 opencode 池并 503，而真正持有它的
      // workbuddy/codebuddy 账号从未被考虑）。这里只丢掉那个认证失效账号的目录。
      // deps 透传是为了让收窄后的目录落盘 —— 磁盘上留着一份好目录，进程重启后立即可用。
      if (isCatalogInvalidatingRuntimeStatus(runtimeStatus)) {
        invalidateWebUiModelsCacheKeepingAccountCatalogs(state, {
          fs: deps.fs,
          aiHomeDir: deps.aiHomeDir
        }, [event.accountRef]);
      }
      return true;
    }
    if (event.runtimeState === null || event.reloadPool === true) {
      return reloadServerRuntimePool(deps);
    }
    return false;
  };
}

function registerAccountRuntimeEventListeners(hub, deps = {}) {
  if (!hub || typeof hub.on !== 'function') return [];
  return [
    hub.on(ACCOUNT_RUNTIME_CHANGED, createRuntimeStateIndexListener(deps)),
    hub.on(ACCOUNT_RUNTIME_CHANGED, createServerPoolSyncListener(deps))
  ];
}

module.exports = {
  createRuntimeStateIndexListener,
  createServerPoolSyncListener,
  registerAccountRuntimeEventListeners
};
