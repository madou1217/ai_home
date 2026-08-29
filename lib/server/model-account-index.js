'use strict';

const {
  getAccountRef,
  listAccountModelCacheRefs
} = require('./provider-model-discovery');
const {
  deriveAccountRuntimeStatus,
  getAccountModelCooldownUntil
} = require('./account-runtime-state');
const {
  listModelIdLookupKeys
} = require('./model-id');
const {
  evaluateProviderModelUsage,
  isUsageDecisionSchedulable,
  listProviderUsageModels
} = require('./provider-usage-policy');
const { listNativeImageModelSpecs } = require('./image-generation-model-specs');
const { __private: { isApiKeyAccount } } = require('./image-generation-strategy-registry');

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
    usagePolicyRegistry: null,
    builtAt: 0
  };
}

function normalizeModelId(value) {
  return String(value || '').trim();
}

function isSchedulableAccount(account, modelId, usagePolicyRegistry = null) {
  if (!account || !String(account.accessToken || '').trim()) return false;
  const now = Date.now();
  var s = String(account.schedulableStatus || '').trim();
  if (s && s !== 'schedulable') return false;
  if (deriveAccountRuntimeStatus(account, now).status !== 'healthy') return false;
  if (getAccountModelCooldownUntil(account, modelId, now) > now) return false;
  return isUsageDecisionSchedulable(evaluateProviderModelUsage(
    account.provider,
    account,
    modelId,
    usagePolicyRegistry
  ));
}

function buildIndexedAccount(provider, account, accountRef) {
  const indexedAccount = Object.create(account || null);
  indexedAccount.provider = provider;
  indexedAccount.accountRef = accountRef;
  // Runtime-state readers normalize their input in place. Keep the provider
  // and stable ref on the index view, but forward all mutable runtime fields
  // to the live account so cooldown/failure updates remain visible after the
  // index was built.
  return new Proxy(indexedAccount, {
    set(target, property, value, receiver) {
      if (property === 'provider' || property === 'accountRef') {
        return Reflect.set(target, property, value, receiver);
      }
      if (account && typeof account === 'object') {
        return Reflect.set(account, property, value);
      }
      return Reflect.set(target, property, value, receiver);
    }
  });
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
  index.usagePolicyRegistry = options && options.usagePolicyRegistry || null;
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
      listProviderUsageModels(provider, account, index.usagePolicyRegistry).forEach(function (m) {
        var id = normalizeModelId(m);
        if (id) modelSet.add(id);
      });
      if (!isApiKeyAccount(account)) {
        listNativeImageModelSpecs(provider).forEach(function (spec) {
          var id = normalizeModelId(spec && spec.id);
          if (id) modelSet.add(id);
        });
      }

      if (modelSet.size > 0) {
        index.accountToModels.set(accountRef, modelSet);

        // modelToAccounts 倒排索引构建：
        // 针对每个模型 ID，同时为其所有 lookup keys（如点号与中划线分隔符变体 gpt-5.6 与 gpt-5-6）
        // 注册到倒排表中，确保版本变体及别名查询均能 O(1) 命中。
        modelSet.forEach(function (modelId) {
          listModelIdLookupKeys(modelId).forEach(function (key) {
            var refs = index.modelToAccounts.get(key);
            if (!refs) {
              refs = [];
              index.modelToAccounts.set(key, refs);
            }
            if (refs.indexOf(accountRef) < 0) refs.push(accountRef);
          });
        });
      }
    });
  });

  return index;
}

/**
 * 查哪些账号有这个模型。支持别名/版本归一 key 模糊匹配。
 * @returns {string[]} accountRef 数组
 */
function findAccountsForModel(index, modelId) {
  if (!index || !index.modelToAccounts) return [];
  var raw = index.modelToAccounts.get(normalizeModelId(modelId));
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.slice();
  }
  // Lookup keys fallback for version separators (e.g. gpt-5.6 vs gpt-5-6)
  var keys = listModelIdLookupKeys(modelId);
  var seen = new Set();
  var result = [];
  for (var i = 0; i < keys.length; i++) {
    var match = index.modelToAccounts.get(keys[i]);
    if (Array.isArray(match)) {
      for (var j = 0; j < match.length; j++) {
        var ref = match[j];
        if (!seen.has(ref)) {
          seen.add(ref);
          result.push(ref);
        }
      }
    }
  }
  return result;
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
      return isSchedulableAccount(account, modelId, index.usagePolicyRegistry);
    })
    .sort(function (left, right) {
      // 更多模型的账号排前面（中转账号通常模型更全）
      var leftModels = (index.accountToModels.get(left) || new Set()).size;
      var rightModels = (index.accountToModels.get(right) || new Set()).size;
      return rightModels - leftModels;
    });
}

function findExhaustedAccountsForModel(index, modelId, provider = '') {
  var targetProvider = String(provider || '').trim().toLowerCase();
  return findAccountsForModel(index, modelId).filter(function (accountRef) {
    var account = index.accountByRef.get(accountRef);
    if (!account) return false;
    if (targetProvider && account.provider !== targetProvider) return false;
    return evaluateProviderModelUsage(
      account.provider,
      account,
      modelId,
      index.usagePolicyRegistry
    ).status === 'exhausted';
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
          listModelIdLookupKeys(modelId).forEach(function (key) {
            var refs = index.modelToAccounts.get(key);
            if (Array.isArray(refs)) {
              var pos = refs.indexOf(accountRef);
              if (pos >= 0) refs.splice(pos, 1);
              if (refs.length === 0) index.modelToAccounts.delete(key);
            }
          });
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
    newModels = newModels.concat(listProviderUsageModels(
      runtimeEntry.provider,
      runtimeEntry.account,
      index.usagePolicyRegistry
    ));
    if (!isApiKeyAccount(runtimeEntry.account)) {
      listNativeImageModelSpecs(runtimeEntry.provider).forEach(function (spec) {
        if (spec && spec.id) newModels.push(spec.id);
      });
    }

    var modelSet = new Set();
    newModels.forEach(function (m) {
      var id = normalizeModelId(m);
      if (id) modelSet.add(id);
    });

    if (modelSet.size > 0) {
      index.accountToModels.set(accountRef, modelSet);
      modelSet.forEach(function (modelId) {
        listModelIdLookupKeys(modelId).forEach(function (key) {
          var refs = index.modelToAccounts.get(key);
          if (!refs) {
            refs = [];
            index.modelToAccounts.set(key, refs);
          }
          if (refs.indexOf(accountRef) < 0) refs.push(accountRef);
        });
      });
    }
  });

  index.builtAt = Date.now();
  return index;
}

/**
 * 账号重载后的重绑：把索引里的账号快照换成 state.accounts 里的新对象。
 *
 * 索引里有两类数据，生命周期完全不同：
 * - 模型目录（modelToAccounts / accountToModels）来自持久化模型缓存，账号重载不改变它；
 * - 账号快照（accountByRef）是 Object.create(account) 包装，绑定在具体对象身份上。
 *
 * applyReloadState 会整体替换 state.accounts，旧对象随即被孤立，索引会一直读到重载前的
 * 冷却/健康状态（例如 429 之后仍认为目标模型可调度），别名预检因此走进「有账号可路由」
 * 的快路径、放弃 lastResort，最终被下游按新对象过滤成 503。
 *
 * 这里只换账号快照，不碰模型目录：重载会同时失效模型缓存，全量重建会让目录变窄。
 */
function rebindModelAccountIndexAccounts(index, state) {
  if (!index || !(index.accountByRef instanceof Map) || !state) return index;
  var runtimeAccountsByRef = buildRuntimeAccountMap(state.accounts);
  index.accountByRef.forEach(function (indexedAccount, accountRef) {
    var runtimeEntry = runtimeAccountsByRef.get(accountRef);
    if (!runtimeEntry) {
      // 账号已被移除：删掉快照即可，模型目录里残留的 ref 在查询时会被过滤掉。
      index.accountByRef.delete(accountRef);
      return;
    }
    index.accountByRef.set(
      accountRef,
      buildIndexedAccount(runtimeEntry.provider, runtimeEntry.account, accountRef)
    );
  });
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
  findExhaustedAccountsForModel,
  findModelsForAccount,
  findRoutableAccountsForModel,
  hasModelInIndex,
  patchModelAccountIndex,
  rebindModelAccountIndexAccounts,
  refreshOnCacheUpdate
};
