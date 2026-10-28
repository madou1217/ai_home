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

const {
  SCOPES,
  buildAccountUpstreamEvidenceKey,
  buildProviderExitEvidenceKey
} = require('./egress-evidence-scope');

/** server 启动时注入；传 null 注销。 */
function configureEgressTrafficEvidence(next) {
  observer = next && typeof next === 'object' ? next : null;
}

/** 地区拒绝：返回 true = 已由出口池处理（调用方不再给账号挂冷却）。永不抛。 */
function notifyEgressRegionDenied(input, policy) {
  if (!observer || typeof observer.onRegionDenied !== 'function') return false;
  try {
    const payload = input && input.account ? input : { account: input, policy };
    return observer.onRegionDenied(payload.account, payload.policy, payload) === true;
  } catch (_error) {
    return false;
  }
}

/** 请求成功。永不抛。 */
function notifyEgressSuccess(input) {
  if (!observer || typeof observer.onSuccess !== 'function') return;
  try {
    const payload = input && input.account ? input : { account: input };
    observer.onSuccess(payload.account, payload);
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

  function laneContext(account, details = {}) {
    const accountRef = String(account && account.accountRef || '').trim();
    const service = deps.getService && deps.getService();
    const runtime = service && service.ready ? service.runtime : null;
    if (!accountRef) return null;
    if (runtime && (typeof runtime.laneOf !== 'function' || !runtime.laneOf(accountRef))) return null;
    const node = details.node || (runtime && typeof runtime.laneActiveNode === 'function' ? runtime.laneActiveNode(accountRef) : null);
    const identity = String(details.nodeId
      || node && (node.nodeId || node.identity || node.exitIdentity)
      || (node && runtime && runtime.health ? runtime.health.identityOf(node) : '')).trim();
    const upstream = details.upstream || deps.resolveUpstream(account);
    if (!node || !identity || !upstream) return null;
    const provider = String(details.provider || account && account.provider || upstream.provider || '').trim().toLowerCase();
    const exitIp = String(details.exitIp || (node && (node.exitIp || node.ip)) || '').trim();
    const modelFamily = String(details.modelFamily || account && (account.modelFamily || account.model) || '').trim().toLowerCase();
    const credentialGeneration = details.credentialGeneration === undefined
      ? account && account.credentialGeneration : details.credentialGeneration;
    return { accountRef, runtime, node, identity, upstream, provider, exitIp, modelFamily, credentialGeneration };
  }

  function writeEvidence(context, record) {
    const scoped = {
      ...record,
      scope: SCOPES.ACCOUNT_UPSTREAM,
      provider: context.provider,
      upstreamId: context.upstream.id,
      nodeId: context.identity,
      exitIp: context.exitIp,
      modelFamily: context.modelFamily,
      accountRef: context.accountRef,
      ...(context.credentialGeneration === undefined || context.credentialGeneration === null
        ? {} : { credentialGeneration: String(context.credentialGeneration).trim() }),
      at: now()
    };
    if (typeof deps.recordScopedEvidence === 'function') return deps.recordScopedEvidence(scoped);
    // Compatibility recorder: preserve the old call shape while making the
    // persisted key account-scoped and carrying the scope in the value.
    if (typeof deps.recordEvidence === 'function') {
      return deps.recordEvidence(
        context.upstream.id,
        buildAccountUpstreamEvidenceKey(scoped),
        { ...scoped, scope: SCOPES.ACCOUNT_UPSTREAM }
      );
    }
    return null;
  }

  function recentKey(context) {
    return [
      context.accountRef,
      context.provider,
      context.upstream.id,
      context.identity,
      context.exitIp,
      context.modelFamily,
      context.credentialGeneration === undefined || context.credentialGeneration === null
        ? '' : String(context.credentialGeneration)
    ].join('|');
  }

  return {
    onRegionDenied(account, policy, payload = {}) {
      const context = laneContext(account, payload);
      if (!context) return false;
      const reason = payload.reason || (policy && policy.reason);
      writeEvidence(context, {
        status: 'blocked',
        reason: reason || `traffic:${String(policy && policy.regionSignature || 'region_denied')}`,
        source: 'traffic',
        confidence: 1
      });
      recentOk.delete(recentKey(context));
      // Account/upstream evidence is intentionally sufficient to rotate this
      // lane. Promotion to provider-wide evidence is an explicit injected
      // policy, never an implicit side effect of one account's denial.
      if (deps.promoteProviderEvidence === true && typeof deps.recordScopedEvidence === 'function') {
        deps.recordScopedEvidence({
          provider: context.provider,
          upstreamId: context.upstream.id,
          nodeId: context.identity,
          exitIp: context.exitIp,
          modelFamily: context.modelFamily,
          status: 'blocked',
          reason: reason || 'traffic:region_denied',
          source: 'traffic',
          confidence: 1,
          scope: SCOPES.PROVIDER_EXIT,
          at: now()
        });
      } else if (deps.promoteProviderEvidence === true && typeof deps.recordEvidence === 'function') {
        const providerRecord = {
          provider: context.provider,
          upstreamId: context.upstream.id,
          nodeId: context.identity,
          exitIp: context.exitIp,
          modelFamily: context.modelFamily,
          status: 'blocked',
          reason: reason || 'traffic:region_denied',
          source: 'traffic',
          confidence: 1,
          scope: SCOPES.PROVIDER_EXIT,
          at: now()
        };
        deps.recordEvidence(context.upstream.id, buildProviderExitEvidenceKey(providerRecord), providerRecord);
      }
      if (deps.planner && typeof deps.planner.reconcile === 'function') deps.planner.reconcile({ force: true });
      return true;
    },
    onSuccess(account, payload = {}) {
      const context = laneContext(account, payload);
      if (!context) return;
      const key = recentKey(context);
      const ttl = Number(deps.ttlMs && deps.ttlMs(context.upstream)) || 7 * 24 * 60 * 60 * 1000;
      const last = recentOk.get(key) || 0;
      if (last && now() - last < ttl / 2) return;
      recentOk.set(key, now());
      writeEvidence(context, {
        status: 'ok',
        reason: 'traffic_ok',
        source: 'traffic',
        confidence: 1
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
