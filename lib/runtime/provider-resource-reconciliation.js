'use strict';

function createReconciliationError(code, provider, accountRef, unresolved = []) {
  const suffix = unresolved.length > 0 ? `:${unresolved.join(',')}` : '';
  const error = new Error(`${code}${suffix}`);
  error.code = code;
  error.provider = String(provider || '').trim().toLowerCase();
  error.accountRef = String(accountRef || '').trim();
  if (unresolved.length > 0) error.unresolved = unresolved;
  return error;
}

function assertProviderResourcesReconciled(reconciliation, context = {}) {
  const unresolved = Array.isArray(reconciliation && reconciliation.unresolved)
    ? Array.from(new Set(reconciliation.unresolved.map((entry) => String(entry || '').trim()).filter(Boolean)))
    : [];
  if (unresolved.length > 0) {
    throw createReconciliationError(
      'provider_resource_reconcile_incomplete',
      context.provider,
      context.accountRef,
      unresolved
    );
  }
  return reconciliation || { migrated: 0, linked: 0 };
}

function reconcileProviderResources(reconcile, provider, accountRef, options = {}) {
  if (typeof reconcile !== 'function') {
    if (options.required === false) return { migrated: 0, linked: 0 };
    throw createReconciliationError(
      'provider_resource_reconcile_unavailable',
      provider,
      accountRef
    );
  }
  const reconcileOptions = { ...options };
  delete reconcileOptions.required;
  return assertProviderResourcesReconciled(reconcile(provider, accountRef, reconcileOptions), {
    provider,
    accountRef
  });
}

module.exports = {
  assertProviderResourcesReconciled,
  reconcileProviderResources
};
