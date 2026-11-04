'use strict';

// 把 Node 的 runtime_state 失败观察上报给 Go（Go 是账号级阻塞的存储真相）。
//
// 只映射 Go 认识的 FailureKind；Node 的 runtime_state 形状保持不变，上报是旁路：
// Go 不可用时静默跳过，不影响 Node 本地状态与选号。

const KINDS = new Set([
  'reauthentication_required',
  'credential_rejected',
  'rate_limited',
  'permission_denied',
  'billing_blocked',
  'quota_exhausted',
  'workspace_deactivated',
  'region_unsupported'
]);

const NODE_KIND_MAP = {
  auth_invalid: 'reauthentication_required',
  credential_rejected: 'credential_rejected',
  rate_limited: 'rate_limited',
  permission_denied: 'permission_denied',
  billing_blocked: 'billing_blocked',
  quota_exhausted: 'quota_exhausted',
  workspace_deactivated: 'workspace_deactivated',
  region_unsupported: 'region_unsupported'
};

function deriveRuntimeBlockReport(accountRef, runtimeState) {
  const ref = String(accountRef || '').trim();
  if (!ref || !runtimeState || typeof runtimeState !== 'object') return null;
  let kind = '';
  let until = 0;
  const routing = runtimeState.routingBlock && typeof runtimeState.routingBlock === 'object'
    ? runtimeState.routingBlock
    : null;
  if (routing) {
    kind = NODE_KIND_MAP[String(routing.kind || '').trim()] || '';
    until = Number(routing.until) || 0;
  }
  if (!kind) {
    const failureKind = String(runtimeState.lastFailureKind || '').trim();
    kind = NODE_KIND_MAP[failureKind] || '';
    if (failureKind === 'auth_invalid') {
      until = Number(runtimeState.authInvalidUntil || runtimeState.cooldownUntil) || 0;
    } else {
      until = Number(runtimeState.rateLimitUntil || runtimeState.cooldownUntil) || 0;
    }
  }
  if (!kind || !KINDS.has(kind)) return null;
  const observedAt = Number(runtimeState.lastFailureAt) || 0;
  if (!observedAt || until <= observedAt) return null;
  return {
    accountRef: ref,
    kind,
    scope: 'account',
    reason: String(runtimeState.lastFailureReason || runtimeState.lastError || '').slice(0, 500),
    observed_at: String(observedAt),
    until: String(until)
  };
}

let reporter = null;

function setRuntimeBlockReporter(fn) {
  reporter = typeof fn === 'function' ? fn : null;
}

function reportRuntimeBlock(accountRef, runtimeState) {
  if (!reporter) return;
  let report = null;
  try {
    report = deriveRuntimeBlockReport(accountRef, runtimeState);
  } catch (_error) {
    report = null;
  }
  if (!report) return;
  try {
    reporter(report);
  } catch (_error) {
    // 旁路上报失败不影响本地状态。
  }
}

module.exports = {
  deriveRuntimeBlockReport,
  reportRuntimeBlock,
  setRuntimeBlockReporter
};
