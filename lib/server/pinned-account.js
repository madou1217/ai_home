'use strict';

// x-account-ref 账号钉选的共享判定：v1 路由与 Go Core 转发决策用同一套「钉选是否可用」规则。

const { isAccountRef } = require('./account-ref-store');
const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');
const { deriveEffectiveRuntimeStatus, isBlockingRuntimeStatus, isSoftRuntimeStatus } = require('../account/runtime-view');

function readPinnedAccountRef(headers = {}) {
  return String(headers['x-account-ref'] || headers['X-Account-Ref'] || '').trim();
}

function findPinnedAccount(state, accountRef) {
  for (const provider of SUPPORTED_SERVER_PROVIDERS) {
    const pool = state && state.accounts && state.accounts[provider];
    if (!Array.isArray(pool)) continue;
    const account = pool.find((item) => String(item && item.accountRef || '') === accountRef);
    if (account) return { account, provider };
  }
  return null;
}

function readPersistedPin(accountStateIndex, accountRef) {
  return accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
    ? accountStateIndex.getAccountState(accountRef)
    : null;
}

/**
 * 钉选可用 = 在运行池中、持久化生命周期为 up，且没有持久化运行态阻塞。
 * 运行池只装可调度账号，持久化层再兜一次（CLI delete/down 或上游余额/权限
 * 阻塞后，内存里可能还留着旧凭据）。
 */
function isPinUsable(resolvedPin, accountStateIndex, persistedPin) {
  if (!resolvedPin) return false;
  if (accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
    && (!persistedPin || String(persistedPin.status || '') !== 'up')) {
    return false;
  }
  const account = resolvedPin.account || resolvedPin;
  return !isBlockingRuntimeStatus(deriveEffectiveRuntimeStatus(account, persistedPin));
}

/** 一次解析钉选：{ valid, resolvedPin, persistedPin, usable }。 */
function resolvePinnedAccount(state, accountStateIndex, accountRef) {
  if (!isAccountRef(accountRef)) return { valid: false, resolvedPin: null, persistedPin: null, usable: false };
  const resolvedPin = findPinnedAccount(state, accountRef);
  const persistedPin = readPersistedPin(accountStateIndex, accountRef);
  return { valid: true, resolvedPin, persistedPin, usable: isPinUsable(resolvedPin, accountStateIndex, persistedPin) };
}


// isSoftPinProbe 判断「钉住的账号只是软冷却、且同 provider 没有健康替代」。
//
// 这是钉选作为 best-effort 亲和的唯一例外：会话绑定的账号处于 rate_limited /
// upstream_error 这类猜测冷却时，如果全池没有更健康的账号，继续用它做一次探测请求，
// 而不是直接 403 把会话钉死。调用方（v1-router）据此保留钉头，选择器再按
// allowRuntimeCooledAccountRef 放行这一个账号；请求失败会照常重新冷却它。
//
// 硬阻断（auth_invalid / quota_exhausted / billing_blocked / permission_denied）
// 永远不探测：那是账号事实，试也不会成功。
function isSoftPinProbe(state, accountStateIndex, accountRef) {
  const pin = resolvePinnedAccount(state, accountStateIndex, accountRef);
  if (!pin.resolvedPin || pin.usable) return false;
  const runtime = deriveEffectiveRuntimeStatus(pin.resolvedPin.account, pin.persistedPin);
  if (!isSoftRuntimeStatus(runtime.status)) return false;
  const provider = String(pin.resolvedPin.provider || '').trim();
  const pool = provider && state && state.accounts && Array.isArray(state.accounts[provider])
    ? state.accounts[provider]
    : [];
  const hasHealthyAlternative = pool.some((account) => {
    const ref = String(account && account.accountRef || '').trim();
    if (!ref || ref === accountRef) return false;
    const row = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
      ? accountStateIndex.getAccountState(ref) : null;
    return isPinUsable(account, accountStateIndex, row);
  });
  return !hasHealthyAlternative;
}

module.exports = {
  findPinnedAccount,
  isSoftPinProbe,
  isPinUsable,
  readPersistedPin,
  readPinnedAccountRef,
  resolvePinnedAccount
};
