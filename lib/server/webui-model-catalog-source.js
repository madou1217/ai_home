'use strict';

// WebUI 模型目录的读取源：Node 缓存 + Go account_models 的合并。
//
// 为什么需要这一层：WebUI 的模型页与会话模型选择器读的是 getWebUiModelsCache，而
// account_models 的权威存储已经迁到 Go。直接把读路径切过去会丢两类信息：
//   * Node 的「上次探测时刻」与错误快照（Go 侧还没存 probe facts）；
//   * 显式刷新刚刚探测完、Go 还没收到写回的窗口。
// 因此这里做**有界合并**：Go 有数据的账号覆盖 byAccount，其余字段继续用 Node 的；
// Go 读不到（503/网络/未装配）时原样返回 Node 结果。

const { getWebUiModelsCache } = require('./webui-model-cache');
const { createGoModelCatalogReader } = require('./go-model-catalog-reader');
const { isGoOwnedModels } = require('../providers/model-ownership');

function scopeAccountRef(accountScope) {
  if (!accountScope || typeof accountScope !== 'object') return '';
  return String(accountScope.accountRef || accountScope.account_ref || '').trim();
}

/**
 * 合并 Go 的账号目录到 Node 的 catalogResult。
 *
 * 只覆盖 byAccount：models（byProvider）是 Node 路由的既有证据，Phase 1 不动它，
 * 避免一次读切换改变路由结果。
 */
function mergeGoCatalogResult(local, remote, accountScope, resolveNodeRef = null) {
  if (!local || !remote || !remote.byAccount) return local;
  const refs = Object.keys(remote.byAccount);
  if (refs.length === 0) return local;
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
  if (adopted === 0) return local;
  // firstError 只是「第一条账号错误的摘要」：errorsByAccount 被 Go 覆盖后必须重算，
  // 否则旧摘要会留到账号恢复之后（实测重启后 kiro 目录已正常，页面仍显示旧探测错误）。
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
