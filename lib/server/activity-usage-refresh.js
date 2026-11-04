'use strict';

// 领取成功后的额度快照刷新（WebUI 手动 / 批量 / 计划任务共用）。
//
// 余额快照是缓存（usage-probe 有自己的 TTL），claim 成功只改了上游状态，本地快照
// 仍是「没有套餐」。不主动刷新的话，WebUI 会在接下来一个探测周期里继续显示
// 「额度不适用 / 无套餐」——用户刚点完领取却看不到 coding plan 额度
// （2026-11-03 真机）。
//
// 这里只做「是否该刷 + 排一次」的判定，不关心调用方是 HTTP 还是调度器；
// fire-and-forget：刷新要打上游（秒级），不能拖住领取结果。

// 领取成功的状态词（与 outcomes 的 normal 结论一致）：失败/无可领不该打上游。
const POST_CLAIM_USAGE_REFRESH_STATUSES = new Set(['claimed', 'already_claimed']);

/**
 * 领取成功后立刻强制刷新该账号的额度快照。
 *
 * forceRefresh 必须为 true：缓存 TTL 内 probe 会直接返回旧快照，等于没刷。
 *
 * @param {{ensureUsageSnapshotAsync?: Function}} deps 服务装配注入的依赖
 * @param {string} provider
 * @param {string} accountRef
 * @param {{status?: string}} result 领取结果
 * @returns {boolean} 是否排入了刷新
 */
function refreshUsageAfterClaim(deps, provider, accountRef, result) {
  const status = String(result && result.status || '').trim().toLowerCase();
  if (!POST_CLAIM_USAGE_REFRESH_STATUSES.has(status)) return false;
  const refresh = deps && deps.ensureUsageSnapshotAsync;
  if (typeof refresh !== 'function') return false;
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const normalizedAccountRef = String(accountRef || '').trim();
  if (!normalizedProvider || !normalizedAccountRef) return false;
  Promise.resolve()
    .then(() => refresh(normalizedProvider, normalizedAccountRef, null, { forceRefresh: true }))
    .catch(() => null);
  return true;
}

module.exports = {
  POST_CLAIM_USAGE_REFRESH_STATUSES,
  refreshUsageAfterClaim
};

