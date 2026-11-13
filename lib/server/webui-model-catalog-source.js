'use strict';

// WebUI 模型目录的读取源（Go-first）：优先读 Go account_models，Node 快照仅做兜底与非 Go 插件补充。
//
// 为什么保留有界合并：
//   * 非 Go 接管（插件）Provider 继续留在 Node 缓存；
//   * 保留既有 Node 探测时间戳/错误快照字段，兼容既有读取方；
//   * Go 不可用（503/网络/未装配）或独立测试/CLI harness 未注入 Go 读取器时平滑回退到 Node 缓存。

const { getWebUiModelsCache } = require('./webui-model-cache');
const { createGoModelCatalogReader } = require('./go-model-catalog-reader');
const { isGoOwnedModels } = require('../providers/model-ownership');

function scopeAccountRef(accountScope) {
  if (!accountScope || typeof accountScope !== 'object') return '';
  return String(accountScope.accountRef || '').trim();
}

/**
 * 把 Go 目录合并进 Node 结果；Go 读不到（remote == null）时原样返回 local。
 *
 * 注意：merged 的账号模型列表需要按当前运行池的口径处理，不改写 Node 未覆盖的字段。
 */
function mergeGoCatalogResult(local, remote, accountScope, resolveNodeRef = null) {
  if (!remote || !remote.byAccount) return local;
  const scopeRef = scopeAccountRef(accountScope);
  const byAccount = { ...(local.byAccount || {}) };
  const errorsByAccount = { ...(local.errorsByAccount || {}) };
  const accountProbedAt = { ...(local.accountProbedAt || {}) };

  for (const [goRef, models] of Object.entries(remote.byAccount)) {
    const nodeRef = typeof resolveNodeRef === 'function' ? resolveNodeRef(goRef) : goRef;
    if (!nodeRef) continue;
    if (scopeRef && nodeRef !== scopeRef) continue;
    if (Array.isArray(models) && models.length > 0) {
      byAccount[nodeRef] = models.slice();
      delete errorsByAccount[nodeRef];
    } else if (remote.errorsByAccount && remote.errorsByAccount[goRef]) {
      errorsByAccount[nodeRef] = remote.errorsByAccount[goRef];
    }
    const probedAt = Number(remote.accountProbedAt && remote.accountProbedAt[goRef]) || 0;
    if (probedAt > 0) {
      accountProbedAt[nodeRef] = Math.max(Number(accountProbedAt[nodeRef]) || 0, probedAt);
    }
  }

  const firstError = Object.values(errorsByAccount)
    .map((value) => String(value || '').trim())
    .find(Boolean) || '';
  return {
    ...local,
    byAccount,
    errorsByAccount,
    firstError,
    accountProbedAt,
    updatedAt: Math.max(Number(local.updatedAt) || 0, Number(remote.updatedAt) || 0),
    // 「有目录」才升级成 remote；Go 的空目录不改变 Node 对来源的判断。
    source: Object.values(remote.byAccount).some((ids) => Array.isArray(ids) && ids.length > 0)
      ? 'remote'
      : local.source
  };
}

function providerByAccountRef(state) {
  const map = new Map();
  const accounts = state && state.accounts;
  if (!accounts || typeof accounts !== 'object') return map;
  for (const [provider, list] of Object.entries(accounts)) {
    for (const account of Array.isArray(list) ? list : []) {
      const ref = String(account && account.accountRef || '').trim();
      if (ref) map.set(ref, String(provider || '').trim().toLowerCase());
    }
  }
  return map;
}

/**
 * Go 接管的 Provider：Go 是**唯一**来源，本地缓存里没有对应 Go 条目的账号必须丢弃。
 *
 * 否则停用/尚未同步的账号会一直显示上一次 Node 探测的历史目录（实测停用的 cline
 * 账号残留 2 条旧模型）。Go 完全读不到（remote=null）时保持原样——那时不能把
 * 所有账号都清空，页面需要上一份快照兜底。
 */
function dropGoOwnedLocalEntries(state, local, remote, resolveNodeRef) {
  if (!local || !local.byAccount || !remote || !remote.byAccount) return local;
  // remote 非空 = Go 明确答复过（失败/不可达已被 reader 转成 null）。此时「Go 没有这个账号」
  // 就是权威结论：不能再用本地历史目录续命。
  const goRefs = Object.keys(remote.byAccount);
  const nodeRefsWithGo = new Set();
  for (const goRef of goRefs) {
    const nodeRef = typeof resolveNodeRef === 'function' ? resolveNodeRef(goRef) : goRef;
    if (nodeRef) nodeRefsWithGo.add(nodeRef);
  }
  const providers = providerByAccountRef(state);
  const byAccount = {};
  let dropped = 0;
  for (const [ref, models] of Object.entries(local.byAccount)) {
    const provider = providers.get(ref) || '';
    if (provider && isGoOwnedModels(provider) && !nodeRefsWithGo.has(ref)) {
      dropped += 1;
      continue;
    }
    byAccount[ref] = models;
  }
  return dropped > 0 ? { ...local, byAccount } : local;
}

/**
 * 读取 WebUI 模型目录（Go-first）：有 Go 读取器时优先读 Go account_models，
 * 不触发冗余的 Node 侧多账号 HTTP 探测；仅在 Go 未装配且调用方显式注入
 * 探测函数时才回退 Node 缓存刷新路径。
 *
 * @param {object} state
 * @param {object} options
 * @param {object} cacheDeps getWebUiModelsCache 的参数（accountScope/forceRefresh/...）
 * @param {object} ctx 路由上下文（从中取 deps.goAccountModels）
 */
async function getWebUiCatalogResult(state, options, cacheDeps = {}, ctx = null) {
  const deps = ctx && ctx.deps && typeof ctx.deps === 'object' ? ctx.deps : {};
  const opts = options && typeof options === 'object' ? options : {};
  const read = deps.goAccountModels
    || deps.readAccountModels
    || cacheDeps.readAccountModels
    || cacheDeps.goAccountModels
    || opts.goAccountModels
    || opts.readAccountModels;
  if (typeof read !== 'function') {
    return getWebUiModelsCache(state, options, cacheDeps);
  }

  const scopeRef = scopeAccountRef(cacheDeps.accountScope);
  const resolveGoRef = typeof deps.goAccountRefFor === 'function'
    ? deps.goAccountRefFor
    : (typeof opts.goAccountRefFor === 'function' ? opts.goAccountRefFor : null);
  const resolveNodeRef = typeof deps.nodeAccountRefFor === 'function'
    ? deps.nodeAccountRefFor
    : (typeof opts.nodeAccountRefFor === 'function' ? opts.nodeAccountRefFor : null);
  const refreshAccountModels = typeof deps.refreshAccountModels === 'function'
    ? deps.refreshAccountModels
    : (typeof cacheDeps.refreshAccountModels === 'function' ? cacheDeps.refreshAccountModels : null);
  const refreshWebUiModelCatalog = typeof deps.refreshWebUiModelCatalog === 'function'
    ? deps.refreshWebUiModelCatalog
    : (typeof cacheDeps.refreshWebUiModelCatalog === 'function' ? cacheDeps.refreshWebUiModelCatalog : null);

  if (cacheDeps.forceRefresh) {
    if (scopeRef && refreshAccountModels) {
      await Promise.resolve().then(() => refreshAccountModels(scopeRef)).catch(() => null);
    } else if (!scopeRef && refreshWebUiModelCatalog) {
      await Promise.resolve().then(() => refreshWebUiModelCatalog()).catch(() => null);
    }
  }

  const reader = createGoModelCatalogReader({
    call: (_method, path) => read(path)
  });
  const goScopeRef = scopeRef && resolveGoRef ? (resolveGoRef(scopeRef) || '') : '';
  const remote = await reader
    .read(goScopeRef ? { account_ref: [goScopeRef] } : {})
    .catch(() => null);

  if (!remote && cacheDeps.forceRefresh && typeof cacheDeps.fetchModelsForAccount === 'function') {
    return getWebUiModelsCache(state, options, cacheDeps);
  }

  const baselineDeps = {
    ...cacheDeps,
    forceRefresh: false,
    allowGoColdSync: false
  };
  const local = await getWebUiModelsCache(state, options, baselineDeps);
  const cleaned = dropGoOwnedLocalEntries(state, local, remote, resolveNodeRef);
  return mergeGoCatalogResult(cleaned, remote, cacheDeps.accountScope, resolveNodeRef);
}

module.exports = {
  getWebUiCatalogResult,
  mergeGoCatalogResult,
  __private: { dropGoOwnedLocalEntries }
};
