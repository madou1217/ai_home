'use strict';

const { applyPersistedAccountRuntimeState, deriveAccountRuntimeStatus } = require('./account-runtime-state');
const { invalidateWebUiModelsCache } = require('./webui-model-cache');
const { ACCOUNT_RUNTIME_CHANGED, isBlockingRuntimeStatus } = require('./account-runtime-event-types');
const { withAccountQueryListFns } = require('./account-load-args');

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
function reloadServerRuntimePool(deps) {
  const { state, loadServerRuntimeAccounts, applyReloadState } = deps;
  if (typeof loadServerRuntimeAccounts !== 'function' || typeof applyReloadState !== 'function') return false;
  const runtimeAccounts = loadServerRuntimeAccounts(buildRuntimeAccountLoadArgs(deps));
  applyReloadState(state, runtimeAccounts);
  return true;
}

function createRuntimeStateIndexListener(deps = {}) {
  const { accountStateService } = deps;

  // 需求：账号状态变化必须先成为事件，再由监听器负责持久化，避免 producer 直接写 DB。
  return function runtimeStateIndexListener(event) {
    if (accountStateService && typeof accountStateService.clearRuntimeBlock === 'function' && event.runtimeState === null) {
      return accountStateService.clearRuntimeBlock(event.accountRef, event.provider, {
        ...(event.baseState || {}),
        evidence: event.reason || 'upstream_success'
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
    if (isBlockingRuntimeStatus(resolveEventRuntimeStatus(event))) {
      removeSessionAffinityForAccount(state, event.provider, event.accountRef);
      invalidateWebUiModelsCache(state);
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
