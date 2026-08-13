'use strict';

const {
  accountMatchesScope,
  listAccountModelCacheRefs
} = require('./provider-model-discovery');

function getAccountRef(ctx, provider, account) {
  return listAccountModelCacheRefs(provider, account)[0] || '';
}

function copyModels(models) {
  return Array.isArray(models) ? models.slice() : [];
}

function mergeAccountRefModels(target, accountRef, models) {
  if (!accountRef || !Array.isArray(models)) return;
  target[accountRef] = Array.from(new Set([...(target[accountRef] || []), ...models])).sort();
}

/**
 * 账号页会列出运行池之外的账号（只在手动模型设置里出现的那些）。这类账号的目录
 * 早就探到并落了盘，但投影只遍历 state.accounts，于是它们永远拿不到条目，页面把
 * 「有上次结果」显示成「待探测」——刷新也回不来，因为运行池里根本没有它。
 *
 * 这里按账号页实际会渲染的 ref 兜一遍已持久化的目录：只读缓存、不触发探测，
 * 也不会凭空造出账号（没有缓存条目的 ref 依旧是「待探测」，那是事实）。
 */
function mergePersistedAccountRefs(target, errorsTarget, byAccount, errorsByAccount, accountRefs) {
  (Array.isArray(accountRefs) ? accountRefs : []).forEach((value) => {
    const accountRef = String(value || '').trim();
    if (!accountRef) return;
    if (!Object.prototype.hasOwnProperty.call(target, accountRef)
      && Object.prototype.hasOwnProperty.call(byAccount, accountRef)) {
      mergeAccountRefModels(target, accountRef, copyModels(byAccount[accountRef]));
    }
    if (!Object.prototype.hasOwnProperty.call(errorsTarget, accountRef)
      && Object.prototype.hasOwnProperty.call(errorsByAccount, accountRef)) {
      errorsTarget[accountRef] = String(errorsByAccount[accountRef] || '');
    }
  });
}

/**
 * @param {string[]} [extraAccountRefs] 页面会渲染、但可能不在运行池里的账号 ref
 */
function buildModelAccountRefProjection(ctx, state, catalogResult, accountScope = null, extraAccountRefs = null) {
  const byAccount = catalogResult && catalogResult.byAccount && typeof catalogResult.byAccount === 'object'
    ? catalogResult.byAccount
    : {};
  const errorsByAccount = catalogResult && catalogResult.errorsByAccount && typeof catalogResult.errorsByAccount === 'object'
    ? catalogResult.errorsByAccount
    : {};
  const byAccountRef = {};
  const errorsByAccountRef = {};
  const accountsByProvider = state && state.accounts && typeof state.accounts === 'object'
    ? state.accounts
    : {};

  Object.entries(accountsByProvider).forEach(([provider, accounts]) => {
    (Array.isArray(accounts) ? accounts : []).forEach((account) => {
      if (!accountMatchesScope(provider, account, accountScope)) return;
      const accountRef = getAccountRef(ctx, provider, account);
      if (!accountRef) return;
      listAccountModelCacheRefs(provider, account).forEach((cacheAccountRef) => {
        if (Object.prototype.hasOwnProperty.call(byAccount, cacheAccountRef)) {
          mergeAccountRefModels(byAccountRef, accountRef, copyModels(byAccount[cacheAccountRef]));
        }
        if (Object.prototype.hasOwnProperty.call(errorsByAccount, cacheAccountRef)) {
          errorsByAccountRef[accountRef] = String(errorsByAccount[cacheAccountRef] || '');
        }
      });
    });
  });

  mergePersistedAccountRefs(byAccountRef, errorsByAccountRef, byAccount, errorsByAccount, extraAccountRefs);

  return {
    byAccountRef,
    errorsByAccountRef
  };
}

module.exports = {
  buildModelAccountRefProjection,
  getAccountRef
};
