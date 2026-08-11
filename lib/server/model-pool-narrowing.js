'use strict';

const { modelIdsMatch } = require('./model-id');

/**
 * 按「模型 → 账号」目录把 provider 池收窄到能服务该模型的账号。
 *
 * 这里唯一要守住的语义是：**目录未知 ≠ 账号不能服务这个模型**。
 * 账号级目录来自后台探测缓存，它天然是残缺的——探测预算有限（--models-probe-accounts）、
 * 账号重载会整体失效缓存、单次探测返回空列表也会把已知目录清掉。把「查不到绑定」
 * 当成「没有可用账号」，就会在账号健康、模型也确实存在的情况下合成一个 503
 * no_available_account，让客户端以为网关没账号可用。真相应该由上游响应给出。
 *
 * 因此只有在「池内每个账号的目录都已知、provider 目录也不认识这个模型」时，
 * 才允许判定「没有账号能服务」；其余情况一律放行整池，让正常的逐账号尝试链路跑，
 * 由真实上游错误说话。
 */

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function toModelSet(value) {
  return value instanceof Set ? value : null;
}

function catalogHasModel(models, model) {
  const set = toModelSet(models);
  if (!set || set.size < 1) return false;
  for (const modelId of set) {
    if (modelIdsMatch(modelId, model)) return true;
  }
  return false;
}

function listPoolAccountRefs(pool, provider, getAccountRef) {
  return (Array.isArray(pool) ? pool : []).map((account) => normalizeText(getAccountRef(provider, account)));
}

/**
 * 池内每个账号都有已知（非空）的模型目录时才算「目录完整」。
 * 只要有一个账号还没被探测过，就不能用目录否定它。
 */
function isPoolCatalogComplete(accountCatalogs, poolAccountRefs) {
  if (poolAccountRefs.length < 1) return false;
  return poolAccountRefs.every((accountRef) => {
    if (!accountRef) return false;
    const models = toModelSet(accountCatalogs.get(accountRef));
    return Boolean(models && models.size > 0);
  });
}

/**
 * 共享判定：拿到「该模型的可用账号 ref」之后怎么收窄池子。
 *
 * @param {object} input
 * @param {Array} input.pool                    provider 的候选账号池
 * @param {string} input.provider               provider 名
 * @param {string} input.model                  请求模型
 * @param {string[]} input.accountRefs          目录里能服务该模型、且当前可调度的账号 ref
 * @param {Map} input.accountCatalogs           accountRef → Set<modelId>
 * @param {Set|null} input.providerCatalog      provider 级模型目录（可为 null）
 * @param {function} input.getAccountRef        (provider, account) => accountRef
 * @param {boolean} [input.orderByAccountRefs]  收窄后按 accountRefs 的顺序排列（倒排索引已排好优先级）
 */
function narrowPoolByModelCatalog(input) {
  const {
    pool,
    provider,
    model,
    accountRefs,
    accountCatalogs,
    providerCatalog,
    getAccountRef,
    orderByAccountRefs = false
  } = input;

  const refs = Array.isArray(accountRefs) ? accountRefs.map(normalizeText).filter(Boolean) : [];
  const catalogs = accountCatalogs instanceof Map ? accountCatalogs : new Map();
  const poolAccountRefs = listPoolAccountRefs(pool, provider, getAccountRef);

  if (refs.length > 0) {
    const allowed = new Set(refs);
    const narrowed = orderByAccountRefs
      // 倒排索引把「模型更全」的账号排在前面，收窄后要保留这个优先级。
      ? refs
        .map((accountRef) => {
          const position = poolAccountRefs.indexOf(accountRef);
          return position >= 0 ? pool[position] : null;
        })
        .filter(Boolean)
      : (Array.isArray(pool) ? pool : [])
        .filter((account, position) => allowed.has(poolAccountRefs[position]));
    if (narrowed.length > 0) {
      return { pool: narrowed, filtered: true, accountRefs: refs };
    }
    // 目录给出的账号一个都不在本池里（跨 provider 的同名模型、账号已下线、
    // 或本次请求已指定账号）——这同样只能说明「目录说不准」，不能合成 503。
    return { pool, filtered: false, accountRefs: [], unchecked: true };
  }

  // provider 目录认识这个模型，只是还不知道落在哪个账号上 → 放行整池。
  if (catalogHasModel(providerCatalog, model)) {
    return { pool, filtered: false, accountRefs: [], providerCatalogOnly: true };
  }

  if (!isPoolCatalogComplete(catalogs, poolAccountRefs)) {
    return { pool, filtered: false, accountRefs: [], unchecked: true };
  }

  // 池内账号目录全部已知且都不含该模型 —— 这才是真的「没有账号能服务」。
  return { pool: [], filtered: true, accountRefs: [] };
}

module.exports = {
  narrowPoolByModelCatalog,
  __private: {
    catalogHasModel,
    isPoolCatalogComplete
  }
};
