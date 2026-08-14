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
 * @param {boolean} [input.allowNoAccountVerdict] 是否允许给出「没有账号能服务」的终判。
 *        倒排索引没有 provider 级目录可佐证，缺少绑定只能说明索引不完整，必须传 false。
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
    orderByAccountRefs = false,
    allowNoAccountVerdict = true
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

  if (!allowNoAccountVerdict || !isPoolCatalogComplete(catalogs, poolAccountRefs)) {
    return { pool, filtered: false, accountRefs: [], unchecked: true };
  }

  // 池内账号目录全部已知且都不含该模型 —— 这才是真的「没有账号能服务」。
  return { pool: [], filtered: true, accountRefs: [] };
}

/**
 * 反向排除：把「目录已知且明确不含该模型」的账号剔除出池。
 *
 * narrowPoolByModelCatalog 只做正向收窄——查到绑定就收窄，查不到就整池放行。
 * 那几条放行分支（providerCatalogOnly / unchecked）会把**已知不支持**该模型的账号
 * 一起放回去，轮询于是可能拨到一个我们早就知道服务不了的上游：ollama 中转的目录里
 * 只有 18 个开源模型，却被拨去跑 gpt-5.6-luna，上游只能回 400。
 *
 * 两种证据的强度并不对称，必须分开对待：
 * - 「查不到绑定」是弱证据——探测预算有限、缓存会失效，不能据此否定账号；
 * - 「目录已知且不含」是强证据——这个账号刚被探测过，它自己说了没有这个模型。
 *
 * 因此这里只用强证据：目录缺失或为空一律放行，继续维持「目录未知 ≠ 不能服务」。
 * 匹配复用 catalogHasModel（modelIdsMatch），与正向收窄同一套版本变体归一规则，
 * 避免 gpt-5.6-luna / gpt-5-6-luna 这类分隔符差异把有能力的账号误剔除。
 *
 * @returns {{pool: Array, excludedAccountRefs: string[]}}
 *   池被排空只可能发生在「每个账号目录都已知且都不含该模型」时，
 *   这正是调用方该给出 no_available_account 终判的场景。
 */
function excludeAccountsWithoutModel(input) {
  const {
    pool,
    provider,
    model,
    accountCatalogs,
    getAccountRef
  } = input || {};

  const accounts = Array.isArray(pool) ? pool : [];
  const catalogs = accountCatalogs instanceof Map ? accountCatalogs : new Map();
  const modelId = normalizeText(model);
  if (accounts.length < 1 || !modelId || catalogs.size < 1 || typeof getAccountRef !== 'function') {
    return { pool: accounts, excludedAccountRefs: [] };
  }

  const excludedAccountRefs = [];
  const kept = accounts.filter((account) => {
    const accountRef = normalizeText(getAccountRef(provider, account));
    if (!accountRef) return true;
    const models = toModelSet(catalogs.get(accountRef));
    if (!models || models.size < 1) return true;
    if (catalogHasModel(models, modelId)) return true;
    excludedAccountRefs.push(accountRef);
    return false;
  });

  return { pool: kept, excludedAccountRefs };
}

module.exports = {
  excludeAccountsWithoutModel,
  narrowPoolByModelCatalog,
  __private: {
    catalogHasModel,
    isPoolCatalogComplete
  }
};
