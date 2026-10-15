'use strict';

// 探测结果的账号运行态适配器 —— 唯一职责：把「模型目录探测」的结果翻译成统一门禁调用
// （account-runtime-gate），自己不维护任何状态语义、不直接写 DB。
//
//   · 成功 → gate.observeProbeSuccess：只清成功探测能推翻的阻塞（auth_invalid 与瞬时类
//     冷却）。限流/过载/额度类刻意保留：/models 常年 200，限流只在聊天路径出现，清掉
//     等于把被限流的账号每次刷新都扔回上游（实测 opencode failCount=48 反复归零）。
//   · 失败 → gate.observeFailure：与推理请求共用同一个 classifier / applier / 持久化
//     链路。探测失败必须记账，否则「探测一直失败、账号却显示健康」只能靠人肉排查。
//   · 空目录（端点可达、凭据通过）不是上游错误，不参与记账。

const { getAccountRuntimeGate } = require('./account-runtime-gate');

function clearAccountRuntimeBlock(account) {
  if (!account || typeof account !== 'object') return;
  account.cooldownUntil = 0;
  account.consecutiveFailures = 0;
  account.lastError = '';
  account.lastFailureKind = '';
  account.lastFailureReason = '';
  account.lastFailureAt = 0;
  account.rateLimitUntil = 0;
  account.authInvalidUntil = 0;
  account.overloadUntil = 0;
  account.networkUntil = 0;
  account.serviceUnavailableUntil = 0;
  account.upstreamErrorUntil = 0;
}

// AUTH-blocked only. A successful models probe proves the CREDENTIALS work —
// it says nothing about usage limits: /models often stays 200 while chat is
// 429-limited. Recovering rate-limit/overload cooldowns here would wipe them
// on every scheduler pass, throw the account straight back into rotation and
// hammer the limited upstream in a loop (observed live: opencode failCount 48
// with rateLimitUntil repeatedly reset to 0).
function isAccountAuthBlocked(account, now = Date.now()) {
  if (!account || typeof account !== 'object') return false;
  return Number(account.authInvalidUntil || 0) > now
    || String(account.lastFailureKind || '').trim() === 'auth_invalid';
}

function accountProbeSucceeded(discovery, accountRefs) {
  const sources = discovery && discovery.sourcesByAccount || {};
  const byAccount = discovery && discovery.byAccount || {};
  return (Array.isArray(accountRefs) ? accountRefs : []).some((accountRef) => (
    String(sources[accountRef] || '') === 'remote'
    && Array.isArray(byAccount[accountRef])
    && byAccount[accountRef].length > 0
  ));
}

// 只认「请求失败」：空目录是可探测到的正常结果，不是上游错误。
function readProbeFailure(discovery, accountRefs) {
  const failures = discovery && discovery.failuresByAccount || {};
  for (const accountRef of accountRefs) {
    const failure = failures[accountRef];
    if (failure && failure.reason === 'request_failed') return failure;
  }
  return null;
}

/**
 * 把一次模型目录探测的结果交给统一门禁。
 * 返回 { recovered, failed }：recovered = 成功探测清掉的阻塞账号，failed = 本次被记为异常的账号。
 */
function observeProbedAccounts(state, discovery, deps = {}) {
  const accountsByProvider = state && state.accounts && typeof state.accounts === 'object'
    ? state.accounts
    : {};
  const listCacheRefs = deps.listAccountModelCacheRefs;
  const recovered = [];
  const failed = [];
  if (typeof listCacheRefs !== 'function') return { recovered, failed };
  const gate = deps.gate || getAccountRuntimeGate(state, deps);
  Object.keys(accountsByProvider).forEach((provider) => {
    const accounts = Array.isArray(accountsByProvider[provider]) ? accountsByProvider[provider] : [];
    accounts.forEach((account) => {
      const accountRefs = listCacheRefs(provider, account);
      if (!Array.isArray(accountRefs) || accountRefs.length < 1) return;
      const accountRef = String(account && account.accountRef || '').trim();
      if (accountProbeSucceeded(discovery, accountRefs)) {
        const result = gate.observeProbeSuccess({
          account,
          provider,
          source: 'server.probe.models',
          evidence: 'models_probe_success'
        });
        if (result.cleared) recovered.push({ provider, accountRef, kind: result.kind });
        return;
      }
      const failure = readProbeFailure(discovery, accountRefs);
      if (!failure) return;
      const observed = gate.observeFailure({
        account,
        provider,
        source: 'server.probe.models',
        statusCode: failure.statusCode,
        detail: failure.detail,
        error: failure.error
      });
      if (observed.applied) {
        failed.push({ provider, accountRef, kind: observed.policy.kind, scope: observed.policy.scope });
      }
    });
  });
  return { recovered, failed };
}

module.exports = {
  accountProbeSucceeded,
  clearAccountRuntimeBlock,
  isAccountAuthBlocked,
  observeProbedAccounts
};
