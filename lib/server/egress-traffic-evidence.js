'use strict';

// 真实流量 → 地区实测（出口 × 上游）。
//
// 账号的真实请求才是最可靠的证据：
//   - 失败且被分类为「地区拒绝」（upstream-failure-policy 的 egressRegionDenied）：
//     账号走出口池车道时，记「该车道当前节点 × 该上游 = blocked」、重排车道（节点立即被剔除），
//     并告诉调用方「已由出口处理」—— 账号本身不挂冷却（它没问题，换个出口就能用）；
//   - 成功：记「该节点 × 该上游 = ok」（带凭据的实测，能推翻预置提示）。同一组合在有效期一半内只记一次。
//
// 观察者模式：account-runtime-state（失败）与 router（成功）只调用这里的 notify*，
// 具体实现由 server 组合根 configure() 注入 —— 账号状态模块因此不依赖出口池 / 规划器。

let observer = null;

/** server 启动时注入；传 null 注销。 */
function configureEgressTrafficEvidence(next) {
  observer = next && typeof next === 'object' ? next : null;
}

/** 地区拒绝：返回 true = 已由出口池处理（调用方不再给账号挂冷却）。永不抛。 */
function notifyEgressRegionDenied(account, policy) {
  if (!observer || typeof observer.onRegionDenied !== 'function') return false;
  try {
    return observer.onRegionDenied(account, policy) === true;
  } catch (_error) {
    return false;
  }
}

/** 请求成功。永不抛。 */
function notifyEgressSuccess(account) {
  if (!observer || typeof observer.onSuccess !== 'function') return;
  try {
    observer.onSuccess(account);
  } catch (_error) {
    /* 统计失败不影响请求 */
  }
}

/**
 * 默认观察者实现（server 组合根用）：依赖都通过参数注入。
 * deps: { fs, aiHomeDir, getService, planner, resolveUpstream(account), recordEvidence, now, ttlMs() }
 */
function createEgressTrafficEvidenceObserver(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const recentOk = new Map();

  function laneContext(account) {
    const accountRef = String(account && account.accountRef || '').trim();
    const service = deps.getService && deps.getService();
    const runtime = service && service.ready ? service.runtime : null;
    if (!accountRef || !runtime || typeof runtime.laneOf !== 'function' || !runtime.laneOf(accountRef)) return null;
    const node = runtime.laneActiveNode(accountRef);
    const identity = node && runtime.health ? runtime.health.identityOf(node) : '';
    const upstream = deps.resolveUpstream(account);
    if (!node || !identity || !upstream) return null;
    return { accountRef, runtime, node, identity, upstream };
  }

  return {
    onRegionDenied(account, policy) {
      const context = laneContext(account);
      if (!context) return false;
      deps.recordEvidence(context.upstream.id, `node:${context.identity}`, {
        status: 'blocked',
        reason: `traffic:${String(policy && policy.regionSignature || 'region_denied')}`,
        source: 'traffic',
        accountRef: context.accountRef
      });
      recentOk.delete(`${context.upstream.id}|${context.identity}`);
      if (deps.planner && typeof deps.planner.reconcile === 'function') deps.planner.reconcile({ force: true });
      return true;
    },
    onSuccess(account) {
      const context = laneContext(account);
      if (!context) return;
      const key = `${context.upstream.id}|${context.identity}`;
      const ttl = Number(deps.ttlMs && deps.ttlMs(context.upstream)) || 7 * 24 * 60 * 60 * 1000;
      const last = recentOk.get(key) || 0;
      if (now() - last < ttl / 2) return;
      recentOk.set(key, now());
      deps.recordEvidence(context.upstream.id, `node:${context.identity}`, {
        status: 'ok',
        reason: 'traffic_ok',
        source: 'traffic',
        accountRef: context.accountRef
      });
    }
  };
}

module.exports = {
  configureEgressTrafficEvidence,
  createEgressTrafficEvidenceObserver,
  notifyEgressRegionDenied,
  notifyEgressSuccess
};
