'use strict';

const {
  getAccountRef,
  listAccountModelCacheRefs
} = require('./provider-model-discovery');
const {
  deriveAccountRuntimeStatus,
  getAccountModelCooldownUntil
} = require('./account-runtime-state');

/**
 * 模型/账号倒排索引 — 纯内存、O(1) 查询。
 * 从持久化缓存 (state.webUiModelsCache) + state.accounts 构建，
 * 重启后立即可用，不依赖后台探测。
 */

function createEmptyIndex() {
  return {
    // model → accountRef[]  哪个账号有这个模型
    modelToAccounts: new Map(),
    // accountRef → Set<modelId>  这个账号有哪些模型
    accountToModels: new Map(),
    // accountRef → {provider, schedulableStatus, ...}
    accountByRef: new Map(),
    builtAt: 0
  };
}

function normalizeModelId(value) {
  return String(value || '').trim();
}

function isSchedulableAccount(account, modelId) {
  if (!account || !String(account.accessToken || '').trim()) return false;
  const now = Date.now();
  var s = String(account.schedulableStatus || '').trim();
  if (s && s !== 'schedulable') return false;
  if (deriveAccountRuntimeStatus(account, now).status !== 'healthy') return false;
  if (getAccountModelCooldownUntil(account, modelId, now) > now) return false;
  if (!account.apiKeyMode) {
    var remainingPct = account.remainingPct;
    if (
      remainingPct != null
      && remainingPct !== ''
      && Number.isFinite(Number(remainingPct))
      && Number(remainingPct) <= 0
    ) return false;
  }
  return true;
}

function buildIndexedAccount(provider, account, accountRef) {
  const indexedAccount = Object.create(account || null);
  indexedAccount.provider = provider;
  indexedAccount.accountRef = accountRef;
  return indexedAccount;
}

function buildRuntimeAccountMap(accountsByProvider) {
  const byRef = new Map();
  Object.entries(accountsByProvider || {}).forEach(([provider, accounts]) => {
    (Array.isArray(accounts) ? accounts : []).forEach((account) => {
      listAccountModelCacheRefs(provider, account).forEach((accountRef) => {
        byRef.set(accountRef, { provider, account });
      });
    });
  });
  return byRef;
}

/**
 * 从持久化缓存 + state.accounts 全量构建倒排索引。
 * 纯同步、纯内存，无 I/O。
 */
function buildModelAccountIndex(state, options) {
  var index = createEmptyIndex();
  index.builtAt = Date.now();

  var accountsByProvider = state && state.accounts;
  if (!accountsByProvider || typeof accountsByProvider !== 'object') return index;

  var cache = state && state.webUiModelsCache;
  var byAccount = cache && cache.byAccount || {};

  Object.keys(accountsByProvider).forEach(function (provider) {
    var accounts = Array.isArray(accountsByProvider[provider])
      ? accountsByProvider[provider]
      : [];

    accounts.forEach(function (account) {
      var refs = listAccountModelCacheRefs(provider, account);
      if (refs.length === 0) return;

      var accountRef = refs[0];

      // accountByRef
      index.accountByRef.set(accountRef, buildIndexedAccount(provider, account, accountRef));

      // accountToModels: 从 byAccount 缓存读模型列表
      var models = Array.isArray(byAccount[accountRef]) ? byAccount[accountRef] : [];
      var modelSet = new Set();
      models.forEach(function (m) {
        var id = normalizeModelId(m);
        if (id) modelSet.add(id);
      });
      // 也加入 account.availableModels
      var localModels = Array.isArray(account && account.availableModels)
        ? account.availableModels : [];
      localModels.forEach(function (m) {
        var id = normalizeModelId(m);
        if (id) modelSet.add(id);
      });

      if (modelSet.size > 0) {
        index.accountToModels.set(accountRef, modelSet);

        // modelToAccounts 倒排
        modelSet.forEach(function (modelId) {
          var refs = index.modelToAccounts.get(modelId);
          if (!refs) {
            refs = [];
            index.modelToAccounts.set(modelId, refs);
          }
          if (refs.indexOf(accountRef) < 0) refs.push(accountRef);
        });
      }
    });
  });

  return index;
}

/**
 * 查哪些账号有这个模型。O(1)。
 * @returns {string[]} accountRef 数组
 */
function findAccountsForModel(index, modelId) {
  var raw = index && index.modelToAccounts ? index.modelToAccounts.get(normalizeModelId(modelId)) : undefined;
  return Array.isArray(raw) ? raw.slice() : [];
}

/**
 * 查哪些可调度账号有这个模型。
 * @returns {string[]} 按模型列表大小降序排列的 accountRef 数组
 */
function findRoutableAccountsForModel(index, modelId, provider = '') {
  var targetProvider = String(provider || '').trim().toLowerCase();
  var raw = findAccountsForModel(index, modelId);
  return raw
    .filter(function (accountRef) {
      var account = index.accountByRef.get(accountRef);
      if (!account) return false;
      if (targetProvider && account.provider !== targetProvider) return false;
      return isSchedulableAccount(account, modelId);
    })
    .sort(function (left, right) {
      // 更多模型的账号排前面（中转账号通常模型更全）
      var leftModels = (index.accountToModels.get(left) || new Set()).size;
      var rightModels = (index.accountToModels.get(right) || new Set()).size;
      return rightModels - leftModels;
    });
}

/**
 * 查某个账号有哪些模型。O(1)。
 */
function findModelsForAccount(index, accountRef) {
  var set = index && index.accountToModels ? index.accountToModels.get(accountRef) : undefined;
  return set instanceof Set ? new Set(set) : new Set();
}

/**
 * 查是否有账号支持这个模型。O(1)。
 */
function hasModelInIndex(index, modelId) {
  return findAccountsForModel(index, modelId).length > 0;
}

/**
 * 增量更新：后台探测后只刷新变化的 accountRef。
 * @param {string[]} changedAccountRefs — 需要刷新的 accountRef 列表
 */
function patchModelAccountIndex(index, state, changedAccountRefs) {
  if (!index || !state) return index;
  var cache = state.webUiModelsCache;
  if (!cache || !cache.byAccount) return index;

  var accountsByProvider = state.accounts || {};
  var runtimeAccountsByRef = buildRuntimeAccountMap(accountsByProvider);

  (Array.isArray(changedAccountRefs) ? changedAccountRefs : []).forEach(function (accountRef) {
    // 清理该 accountRef 的所有旧模型
    if (index.accountToModels.has(accountRef)) {
      var oldModels = index.accountToModels.get(accountRef);
      if (oldModels instanceof Set) {
        oldModels.forEach(function (modelId) {
          var refs = index.modelToAccounts.get(modelId);
          if (Array.isArray(refs)) {
            var pos = refs.indexOf(accountRef);
            if (pos >= 0) refs.splice(pos, 1);
            if (refs.length === 0) index.modelToAccounts.delete(modelId);
          }
        });
      }
      index.accountToModels.delete(accountRef);
    }

    var runtimeEntry = runtimeAccountsByRef.get(accountRef);
    if (!runtimeEntry) {
      index.accountByRef.delete(accountRef);
      return;
    }
    index.accountByRef.set(
      accountRef,
      buildIndexedAccount(runtimeEntry.provider, runtimeEntry.account, accountRef)
    );

    // 从缓存重建
    var newModels = Array.isArray(cache.byAccount[accountRef])
      ? cache.byAccount[accountRef] : [];

    // 也加入 runtime account 自带的模型列表。
    var localModels = Array.isArray(runtimeEntry.account.availableModels)
      ? runtimeEntry.account.availableModels
      : [];
    newModels = newModels.concat(localModels);

    var modelSet = new Set();
    newModels.forEach(function (m) {
      var id = normalizeModelId(m);
      if (id) modelSet.add(id);
    });

    if (modelSet.size > 0) {
      index.accountToModels.set(accountRef, modelSet);
      modelSet.forEach(function (modelId) {
        var refs = index.modelToAccounts.get(modelId);
        if (!refs) {
          refs = [];
          index.modelToAccounts.set(modelId, refs);
        }
        if (refs.indexOf(accountRef) < 0) refs.push(accountRef);
      });
    }
  });

  index.builtAt = Date.now();
  return index;
}

/**
 * 缓存更新后的刷新入口——找出探测到的 accountRef 并增量更新。
 */
function refreshOnCacheUpdate(state, options, discoveryResult) {
  if (!state) return;
  var index = state.modelAccountIndex;
  if (!index || !(index.builtAt > 0)) {
    // 索引不存在或已过期 → 全量重建
    state.modelAccountIndex = buildModelAccountIndex(state, options);
    return state.modelAccountIndex;
  }

  var changedRefs = [];
  if (discoveryResult && discoveryResult.byAccount && typeof discoveryResult.byAccount === 'object') {
    changedRefs = Object.keys(discoveryResult.byAccount);
  }

  if (changedRefs.length > 0) {
    state.modelAccountIndex = patchModelAccountIndex(index, state, changedRefs);
  }
  return state.modelAccountIndex;
}

module.exports = {
  buildModelAccountIndex,
  createEmptyIndex,
  findAccountsForModel,
  findModelsForAccount,
  findRoutableAccountsForModel,
  hasModelInIndex,
  patchModelAccountIndex,
  refreshOnCacheUpdate
};
