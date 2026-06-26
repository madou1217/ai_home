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

function buildModelAccountRefProjection(ctx, state, catalogResult, accountScope = null) {
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

  return {
    byAccountRef,
    errorsByAccountRef
  };
}

module.exports = {
  buildModelAccountRefProjection,
  getAccountRef
};
