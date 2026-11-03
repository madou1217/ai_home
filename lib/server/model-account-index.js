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
const { createAccountInstanceRegistry } = require('./account-instance-registry');
const { listManualModelSettings } = require('./model-catalog-settings-store');

/**
 * 模型/账号倒排索引 — 纯内存、O(1) 查询。
 * 从持久化缓存 (state.webUiModelsCache) + state.accounts 构建，
 * 重启后立即可用，不依赖后台探测。
 */

function createEmptyIndex() {
  const index = {
    // model → accountRef[]  哪个账号有这个模型
    modelToAccounts: new Map(),
    // accountRef → Set<modelId>  这个账号有哪些模型
    accountToModels: new Map(),
    // 账号实例注册表：生命周期内一个 accountRef 只有一个对象，全局一份。
    //
    // 刻意**不再**在本索引里另建一张 accountByRef Map：两张 Map 各持账号状态时，谁写谁
    // 不写没有合同约束，只能靠 Proxy 写穿透维持一致。现在唯一的容器在注册表里，本索引
    // 通过 accountByRef 读取的是对那张 Map 的**引用**（见 defineAccountByRef）。
    instances: createAccountInstanceRegistry(),
    usagePolicyRegistry: null,
    builtAt: 0
  };
  // 空索引也要有可用的 accountByRef：本工厂是导出面，单独使用时不能缺这个字段。
  return defineAccountByRef(index);
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

// 索引里的账号一律是**注册表持有的那个实例本身**（见 account-instance-registry）。
//
// 这里曾经用 `Object.create(account)` + Proxy 造一份「账号视图」，靠 set 穿透把写入转回
// 真身。那是补丁：索引重建会换掉整批视图对象，实例身份在重建时刻断裂，而读取侧必须记得
// 「索引里的账号不是 state.accounts 里的账号」才不会读到冻结状态。
//
// 现在账号对象自带 accountRef 与 provider（lib/server/accounts.js 的每个 loader 都写），
// 所以注册表可以直接持有它，索引不需要任何包装。
function accountInstanceFor(index, provider, account, accountRef) {
  if (!account || typeof account !== 'object') return null;
  // 补写 provider：旧实现把 provider 记在索引视图上，而消费方（provider-routing 的绑定分、
  // model-catalog-knowledge 的 providerHasAccounts、go-core-route-deferral 的承载者判定）
  // 读的是 `account.provider`。索引返回真身后，这个字段必须真的在对象上，否则这些判定会
  // 静默失效。池的 provider 键就是权威值，所以这里按声明写入。
  const declared = String(provider || '').trim().toLowerCase();
  if (declared && String(account.provider || '').trim().toLowerCase() !== declared) {
    try {
      account.provider = declared;
    } catch (_error) {
      // 冻结对象：字段写不进去时保持原样，不因为补字段而让整个索引构建失败。
    }
  }
  const registry = index && index.instances;
  if (!registry) return account;
  return registry.register(accountRef, account, declared || provider);
}

/**
 * 取 state 上的账号实例注册表；没有就建一个挂上去。
 *
 * 两个索引（model-account-index / model-capability-index）必须共用**同一个**注册表，
 * 否则「一个 accountRef 一个实例」的保证会在索引边界处失效。注册表挂在 state 上而不是
 * 各索引内部，正是为了让它们指向同一份。
 */
function resolveAccountInstances(state) {
  if (!state || typeof state !== 'object') return createAccountInstanceRegistry();
  if (!state.accountInstances) state.accountInstances = createAccountInstanceRegistry();
  return state.accountInstances;
}

/**
 * 把索引的 `accountByRef` 定义为注册表那张 Map 的**只读引用**。
 *
 * 用 getter 而非在 createEmptyIndex 里复制一份，是收敛的关键：索引不再持有账号状态，
 * 只持有「去哪里找」。所有既有读取点（`index.accountByRef.get(ref)` / `.entries()`）
 * 因此无需改动，却自动共享同一份真相。
 */
function defineAccountByRef(index) {
  Object.defineProperty(index, 'accountByRef', {
    enumerable: true,
    configurable: true,
    get() { return this.instances.byRef; }
  });
  return index;
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

function registerModelToAccounts(index, accountRef, modelIds) {
  // 针对每个模型 ID，同时为其所有 lookup keys（如点号与中划线分隔符变体 gpt-5.6 与 gpt-5-6）
  // 注册到倒排表中，确保版本变体及别名查询均能 O(1) 命中。
  modelIds.forEach(function (modelId) {
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

function unregisterModelToAccounts(index, accountRef, modelIds) {
  modelIds.forEach(function (modelId) {
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

function listSynthesizedImageModelIds(provider, account) {
  if (isApiKeyAccount(account)) return [];
  return listNativeImageModelSpecs(provider)
    .map(function (spec) { return normalizeModelId(spec && spec.id); })
    .filter(Boolean);
}

/**
 * 从持久化缓存 + state.accounts 全量构建倒排索引。
 * 纯同步、纯内存，无 I/O。
 */
function buildModelAccountIndex(state, options) {
  var index = createEmptyIndex();
  // 共用 state 上的注册表：本索引与 model-capability-index 必须指向同一份实例容器，
  // 否则「一个 accountRef 一个实例」的保证会在索引边界处失效。
  index.instances = resolveAccountInstances(state);
  index.usagePolicyRegistry = options && options.usagePolicyRegistry || null;
  index.builtAt = Date.now();

  var accountsByProvider = state && state.accounts;
  if (!accountsByProvider || typeof accountsByProvider !== 'object') return index;

  var cache = state && state.webUiModelsCache;
  var byAccount = cache && cache.byAccount || {};
  var settings = state && state.modelCatalogSettings || null;

  Object.keys(accountsByProvider).forEach(function (provider) {
    var accounts = Array.isArray(accountsByProvider[provider])
      ? accountsByProvider[provider]
      : [];

    accounts.forEach(function (account) {
      var refs = listAccountModelCacheRefs(provider, account);
      if (refs.length === 0) return;

      var accountRef = refs[0];

      // accountByRef
      index.accountByRef.set(accountRef, accountInstanceFor(index, provider, account, accountRef));

      // accountToModels 只放目录证据（探测缓存 + 账号声明 + 用量快照）。
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
      // 手动补充的模型也是该账号真实可用的模型：调度选号必须认识它，否则「模型目录页
      // 能看到、一发消息就 no_available_account」——展示层与调度层的池子必须同源
      // （2026-10-23 用户反馈：手动添加的模型在 chat 里用不了）。
      // 只认 enabled 的：用户停用的手动模型不该参与路由。
      listManualModelSettings(settings, { enabledOnly: true }).forEach(function (record) {
        if (record.accountRef !== accountRef) return;
        var id = normalizeModelId(record.id);
        if (id) modelSet.add(id);
      });

      if (modelSet.size > 0) {
        index.accountToModels.set(accountRef, modelSet);
      }

      // modelToAccounts 正向路由注册：目录证据之外再补上合成的原生图像能力。
      // 合成能力不进 accountToModels —— 它被当作「目录已知」的否定证据，
      // 只含图像合成项的账号会在排除/收窄时被误判为「不支持该文本模型」。
      var routeSet = new Set(modelSet);
      listSynthesizedImageModelIds(provider, account).forEach(function (id) {
        routeSet.add(id);
      });
      registerModelToAccounts(index, accountRef, routeSet);
    });
  });

  // 注册表跨重建存活（挂在 state 上），所以全量重建后必须清掉已不在池里的账号，
  // 否则按 accountByRef 遍历的读取方会看到陈旧条目。
  //
  // 判据是**池里的全部 ref**，不是 accountToModels 的键：目录尚未探测出来的账号
  // （modelSet 为空 → 不进 accountToModels）仍然是真实账号，v1-router 的
  // `accountCatalogIsUnknown` 正是靠「存在没有目录的账号」判定目录未知。用
  // accountToModels 当判据会把这类账号删掉，让该判定永远返回 false —— 静默改变语义。
  var liveRefs = new Set();
  Object.keys(accountsByProvider).forEach(function (provider) {
    (Array.isArray(accountsByProvider[provider]) ? accountsByProvider[provider] : [])
      .forEach(function (account) {
        listAccountModelCacheRefs(provider, account).forEach(function (accountRef) {
          liveRefs.add(accountRef);
        });
      });
  });
  index.instances.retain(liveRefs);

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
function patchModelAccountIndex(index, state, changedAccountRefs, runtimeAccountsByRef = null) {
  if (!index || !state) return index;
  var cache = state.webUiModelsCache;
  if (!cache || !cache.byAccount) return index;

  // 单账号探测只传这一个账号的运行时映射：10k 账号下不再每次重建整池 Map。
  var accountMap = runtimeAccountsByRef instanceof Map
    ? runtimeAccountsByRef
    : buildRuntimeAccountMap(state.accounts || {});

  (Array.isArray(changedAccountRefs) ? changedAccountRefs : []).forEach(function (accountRef) {
    // 清理该 accountRef 的所有旧模型（目录证据 + 合成的原生图像路由项；
    // 后者不进 accountToModels，必须按 provider 规格单独反注册，否则会残留）。
    var staleModelIds = new Set();
    if (index.accountToModels.has(accountRef)) {
      var oldModels = index.accountToModels.get(accountRef);
      if (oldModels instanceof Set) {
        oldModels.forEach(function (modelId) {
          staleModelIds.add(modelId);
        });
      }
      index.accountToModels.delete(accountRef);
    }
    var previousEntry = index.accountByRef.get(accountRef);
    if (previousEntry) {
      listSynthesizedImageModelIds(previousEntry.provider, previousEntry).forEach(function (id) {
        staleModelIds.add(id);
      });
    }
    unregisterModelToAccounts(index, accountRef, staleModelIds);

    var runtimeEntry = accountMap.get(accountRef);
    if (!runtimeEntry) {
      // 走注册表删除，顺带清掉 provider 绑定；直接 delete 会留下悬空绑定。
      if (index.instances) index.instances.unregister(accountRef);
      else index.accountByRef.delete(accountRef);
      return;
    }
    index.accountByRef.set(
      accountRef,
      accountInstanceFor(index, runtimeEntry.provider, runtimeEntry.account, accountRef)
    );

    // 从缓存重建（只含目录证据：探测缓存 + 账号声明 + 用量快照）
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

    var modelSet = new Set();
    newModels.forEach(function (m) {
      var id = normalizeModelId(m);
      if (id) modelSet.add(id);
    });

    if (modelSet.size > 0) {
      index.accountToModels.set(accountRef, modelSet);
    }

    // 正向路由注册 = 目录证据 + 合成的原生图像能力（语义同 buildModelAccountIndex）。
    var routeSet = new Set(modelSet);
    listSynthesizedImageModelIds(runtimeEntry.provider, runtimeEntry.account).forEach(function (id) {
      routeSet.add(id);
    });
    registerModelToAccounts(index, accountRef, routeSet);
  });

  index.builtAt = Date.now();
  return index;
}

/**
 * 账号重载后的重绑：把索引里的账号快照换成 state.accounts 里的新对象。
 *
 * 索引里有两类数据，生命周期完全不同：
 * - 模型目录（modelToAccounts / accountToModels）来自持久化模型缓存，账号重载不改变它；
 * - 账号实例（accountByRef）由注册表按 accountRef 持有，重载时**换实例**。
 *
 * applyReloadState 会整体替换 state.accounts，旧对象随即被孤立。注册表把「实例身份」
 * 收敛到一处，所以重载只需重新登记：`accountByRef` 指向注册表当前持有的那个对象。
 * 这消除了此前靠 Proxy 写穿透维持一致性的需要——读取方永远拿同一个引用，不需要知道
 * 「索引里的账号和 state.accounts 里的账号是不是同一个」。
 *
 * 这里只换账号实例，不碰模型目录：重载会同时失效模型缓存，全量重建会让目录变窄。
 */
function rebindModelAccountIndexAccounts(index, state) {
  if (!index || !(index.accountByRef instanceof Map) || !state) return index;
  var runtimeAccountsByRef = buildRuntimeAccountMap(state.accounts);
  // 先取快照再遍历：accountByRef 现在是注册表那张**共享** Map，边遍历边删除会改变
  // 其他索引正在看到的容器（而它们可能也在遍历）。快照让删除只影响本函数。
  var refs = Array.from(index.accountByRef.keys());
  refs.forEach(function (accountRef) {
    var runtimeEntry = runtimeAccountsByRef.get(accountRef);
    if (!runtimeEntry) {
      // 账号已被移除：走注册表删除，顺带清掉 provider 绑定。
      if (index.instances) index.instances.unregister(accountRef);
      else index.accountByRef.delete(accountRef);
      return;
    }
    index.accountByRef.set(
      accountRef,
      accountInstanceFor(index, runtimeEntry.provider, runtimeEntry.account, accountRef)
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
    // 单账号探测路径：调用方已经知道变化的账号对象，别再扫一遍全池建 ref→account。
    var runtimeAccountsByRef = null;
    if (discoveryResult && Array.isArray(discoveryResult.scopedAccounts)) {
      runtimeAccountsByRef = new Map();
      discoveryResult.scopedAccounts.forEach(function (scope) {
        if (!scope || !scope.account) return;
        var ref = listAccountModelCacheRefs(scope.provider, scope.account)[0] || '';
        if (ref) runtimeAccountsByRef.set(ref, { provider: scope.provider, account: scope.account });
      });
    }
    state.modelAccountIndex = patchModelAccountIndex(index, state, changedRefs, runtimeAccountsByRef);
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
