'use strict';

// 探测结果的账号运行态适配器 —— 唯一职责：把「模型目录探测」的结果翻译成统一门禁调用
// （account-runtime-gate），自己不维护任何状态语义、不直接写 DB。
//
//   · 成功 → gate.observeProbeSuccess：只清成功探测能推翻的阻塞（auth_invalid 与瞬时类
//     冷却）。限流/过载/额度类刻意保留：/models 常年 200，限流只在聊天路径出现，清掉
//     等于把被限流的账号每次刷新都扔回上游（实测 opencode failCount=48 反复归零）。
//   · 失败 → **只提示、不记账**（gate.describeFailure）：探测失败要在界面上说清是什么错，
//     但一次 2.5s 超时的探测不该把账号摘出池子——后台每轮都在探测，误判代价由全池承担。
//     真正的异常记账由推理请求路径负责（同一分类器，见 gate.observeFailure）。
//   · 空目录（端点可达、凭据通过）不是上游错误，也不提示。

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
 * 返回 { recovered, failed }：recovered = 成功探测清掉的阻塞账号，
 * failed = 本次探测失败并已在界面提示的账号（**不改运行态**，kind/scope 只用于提示文案）。
 *
 * 遍历范围只用「本次探测真正涉及到的账号」（discovery.touchedAccounts），不再扫全池：
 * 10k 账号时后者每次探测都是 O(n)，而探测本身只影响一个账号（单账号探测）或探测预算内的
 * 几十个账号。没被探测的账号在下面两个判定里都是 no-op，跳过它们不改变语义。
 */
function observeProbedAccounts(state, discovery, deps = {}) {
  const listCacheRefs = deps.listAccountModelCacheRefs;
  const recovered = [];
  const failed = [];
  if (typeof listCacheRefs !== 'function') return { recovered, failed };
  const gate = deps.gate || getAccountRuntimeGate(state, deps);
  const touched = Array.isArray(discovery && discovery.touchedAccounts) ? discovery.touchedAccounts : null;
  const seen = new Set();
  const visit = (provider, account) => {
    const accountRefs = listCacheRefs(provider, account);
    if (!Array.isArray(accountRefs) || accountRefs.length < 1) return;
    const accountRef = String(account && account.accountRef || '').trim();
    if (!accountRef || seen.has(accountRef)) return;
    seen.add(accountRef);
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
    // 只分类给提示用：探测失败不写账号运行态（见文件头注释）。
    const policy = typeof gate.describeFailure === 'function'
      ? gate.describeFailure({
          account,
          provider,
          statusCode: failure.statusCode,
          detail: failure.detail,
          error: failure.error
        })
      : null;
    failed.push({
      provider,
      accountRef,
      kind: String(policy && policy.kind || 'unknown_error'),
      scope: String(policy && policy.scope || 'account'),
      detail: failure.detail
    });
  };

  if (touched) {
    touched.forEach((item) => visit(item && item.provider, item && item.account));
    return { recovered, failed };
  }
  // 旧调用方/测试构造的 discovery 没有 touchedAccounts：退回全池遍历。
  const accountsByProvider = state && state.accounts && typeof state.accounts === 'object'
    ? state.accounts
    : {};
  Object.keys(accountsByProvider).forEach((provider) => {
    (Array.isArray(accountsByProvider[provider]) ? accountsByProvider[provider] : []).forEach((account) => {
      visit(provider, account);
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
