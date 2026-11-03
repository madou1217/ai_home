'use strict';

// x-account-ref 账号钉选的共享判定：v1 路由与 Go Core 转发决策用同一套「钉选是否可用」规则。

const { isAccountRef } = require('./account-ref-store');
const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');
const { deriveEffectiveRuntimeStatus, isBlockingRuntimeStatus } = require('../account/runtime-view');

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

module.exports = {
  findPinnedAccount,
  isPinUsable,
  readPersistedPin,
  readPinnedAccountRef,
  resolvePinnedAccount
};
