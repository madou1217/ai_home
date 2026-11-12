'use strict';

// WebUI 模型目录的读取源：Go account_models 为主源，Node 缓存只做兜底与显示层。
//
// 为什么需要这一层：WebUI 的模型页与会话模型选择器读的是 getWebUiModelsCache，而
// account_models 的权威存储已经迁到 Go。切换后 Go 回答过就以 Go 为准：
//   * 账号目录（byAccount）、Provider 并集（models）、错误、探测时刻都来自 Go；
//   * Node 缓存只在 Go 不可用、或非 Go 接管 Provider 上补缺；
//   * 显式刷新（forceRefresh）刚探测完、Go 还没收到结果的窗口仍用 Node 的新结果。
// Go 读不到（503/网络/未装配）时原样返回 Node 结果。

const { getWebUiModelsCache } = require('./webui-model-cache');
const { createGoModelCatalogReader } = require('./go-model-catalog-reader');
const { isGoOwnedModels } = require('../providers/model-ownership');

function scopeAccountRef(accountScope) {
  if (!accountScope || typeof accountScope !== 'object') return '';
  return String(accountScope.accountRef || accountScope.account_ref || '').trim();
}

function cloneProviderModels(models) {
  const out = {};
  if (!models || typeof models !== 'object') return out;
  Object.entries(models).forEach(([provider, ids]) => {
    if (!Array.isArray(ids)) return;
    out[provider] = ids.map((id) => String(id || '').trim()).filter(Boolean).sort();
  });
  return out;
}

/**
 * 合并 Provider 并集：Go 有该 Provider 的模型时以 Go 为准。
 *
 * Go 接管的 Provider 在 Go 没有模型时必须丢弃本地历史并集（fail-closed），否则上游
 * 已下架/账号已停用的模型会继续出现在模型页与选号器里；非 Go 接管的 Provider 保留
 * 本地并集，因为 Go 不负责它们的发现。
 */
function mergeGoProviderModels(localModels, remoteModels) {
  const local = cloneProviderModels(localModels);
  // 旧端点/旧 reader 没有 models 字段时不能按「Go 全空」处理，否则会把所有 Go 接管
  // Provider 的并集清空。只有 Go 明确给出对象时才执行 fail-closed。
  if (!remoteModels || typeof remoteModels !== 'object') return local;
  const remote = cloneProviderModels(remoteModels);
  const providers = new Set([...Object.keys(local), ...Object.keys(remote)]);
  const merged = {};
  providers.forEach((provider) => {
    const goList = remote[provider] || [];
    if (goList.length > 0) {
      merged[provider] = goList;
      return;
    }
    if (isGoOwnedModels(provider)) return;
    const localList = local[provider] || [];
    if (localList.length > 0) merged[provider] = localList;
  });
  return merged;
}

/**
 * 合并 Go 的账号目录到 Node 的 catalogResult。
 *
 * Go 回答过就以 Go 为主源：byAccount、Provider 并集、错误、探测时刻、来源与指纹都
 * 按 Go 重算；Node 只保留 Go 不认识的账号（新导入/尚未探测）与非 Go 接管 Provider。
 */
function mergeGoCatalogResult(local, remote, accountScope, resolveNodeRef = null) {
  if (!local || !remote || !remote.byAccount) return local;
  const refs = Object.keys(remote.byAccount);
  const generation = Number(remote.generation) || 0;
  // Go 库尚未恢复（generation=0 且没有任何账号行）时不能把页面清空：那不代表目录为空。
  if (generation === 0 && refs.length === 0) return local;
  const scopeRef = scopeAccountRef(accountScope);
  const byAccount = { ...local.byAccount };
  const errorsByAccount = { ...(local.errorsByAccount || {}) };
  const accountProbedAt = { ...(local.accountProbedAt || {}) };
  let adopted = 0;
  for (const goRef of refs) {
    // 两侧 accountRef 可能不同：同步 rekey/身份合并后 Go 用 Go 的 ref，页面用 Node 的 ref。
    // 不翻译就会把目录挂到一个页面上不存在的 key 上（实测 opencode 账号因此看不到模型）。
    const ref = typeof resolveNodeRef === 'function' ? resolveNodeRef(goRef) : goRef;
    if (!ref) continue;
    if (scopeRef && ref !== scopeRef) continue;
    byAccount[ref] = remote.byAccount[goRef];
    adopted += 1;
    const error = remote.errorsByAccount && remote.errorsByAccount[goRef];
    if (error) errorsByAccount[ref] = error;
    else delete errorsByAccount[ref];
    // 探测时刻以 Go 为准（Node 的缓存可能是上一轮的旧时间）：两取大，避免时钟回退时显示倒退。
    const probedAt = Number(remote.accountProbedAt && remote.accountProbedAt[goRef]) || 0;
    if (probedAt > 0) {
      accountProbedAt[ref] = Math.max(Number(accountProbedAt[ref]) || 0, probedAt);
    }
  }
  // 作用域读且 Go 没有该账号：保持 Node 结果，避免拿全局 Go 数据覆盖别的账号。
  if (adopted === 0 && refs.length > 0) return local;
  // 作用域读只关心该账号的目录本体，Provider 并集保持全局视图，避免一次单账号读取
  // 把其它 Provider 的并集收窄。
  const models = scopeRef ? local.models : mergeGoProviderModels(local.models, remote.models);
  // firstError 只是「第一条账号错误的摘要」：errorsByAccount 被 Go 覆盖后必须重算，
  // 否则旧摘要会留到账号恢复之后（实测重启后 kiro 目录已正常，页面仍显示旧探测错误）。
  const firstError = Object.values(errorsByAccount)
    .map((value) => String(value || '').trim())
    .find(Boolean) || '';
  const hasGoModels = Object.values(remote.byAccount)
    .some((ids) => Array.isArray(ids) && ids.length > 0);
  return {
    ...local,
    byAccount,
    models,
    errorsByAccount,
    firstError,
    accountProbedAt,
    sourceCount: Object.values(models).filter((ids) => ids.length > 0).length,
    // Go 明确答复过账号行时，扫描数按 Go；否则保留 Node 的（Go 还没恢复）。
    scannedAccounts: refs.length > 0
      ? Number(remote.scannedAccounts) || 0
      : Number(local.scannedAccounts) || 0,
    updatedAt: Math.max(Number(local.updatedAt) || 0, Number(remote.updatedAt) || 0),
    // 「有目录」才升级成 remote；Go 的空目录不改变 Node 对来源的判断。
    source: hasGoModels ? 'remote' : local.source,
    generation
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
  // Go 库尚未恢复（generation=0 且没有任何账号行）：这不是「所有账号都没有目录」，
  // 保持上一份快照，避免启动早期把整页清空。
  if ((Number(remote.generation) || 0) === 0 && Object.keys(remote.byAccount).length === 0) return local;
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
 * 读取 WebUI 模型目录：Node 缓存打底，Go 有数据时合并。
 *
 * @param {object} state
 * @param {object} options
 * @param {object} cacheDeps getWebUiModelsCache 的参数（accountScope/forceRefresh/...）
 * @param {object} ctx 路由上下文（从中取 deps.goAccountModels）
 */
async function getWebUiCatalogResult(state, options, cacheDeps = {}, ctx = null) {
  const local = await getWebUiModelsCache(state, options, cacheDeps);
  // 显式刷新：Node 刚探测完，Go 还没收到写回；这次读必须用 Node 的新结果。
  if (cacheDeps.forceRefresh) return local;
  const read = ctx && ctx.deps && ctx.deps.goAccountModels;
  if (typeof read !== 'function') return local;
  const reader = createGoModelCatalogReader({
    call: (_method, path) => read(path)
  });
  const scopeRef = scopeAccountRef(cacheDeps.accountScope);
  // 用 Node ref 反查 Go ref 再查询：页面只认 Node ref，Go 端点只认自己的 ref。
  const resolveGoRef = ctx && ctx.deps && typeof ctx.deps.goAccountRefFor === 'function'
    ? ctx.deps.goAccountRefFor
    : null;
  const resolveNodeRef = ctx && ctx.deps && typeof ctx.deps.nodeAccountRefFor === 'function'
    ? ctx.deps.nodeAccountRefFor
    : null;
  const goScopeRef = scopeRef && resolveGoRef ? (resolveGoRef(scopeRef) || '') : '';
  const remote = await reader
    .read(goScopeRef ? { account_ref: [goScopeRef] } : {})
    .catch(() => null);
  const cleaned = dropGoOwnedLocalEntries(state, local, remote, resolveNodeRef);
  return mergeGoCatalogResult(cleaned, remote, cacheDeps.accountScope, resolveNodeRef);
}

module.exports = {
  getWebUiCatalogResult,
  mergeGoCatalogResult,
  __private: { dropGoOwnedLocalEntries }
};
