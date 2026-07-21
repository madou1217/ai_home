'use strict';

const {
  normalizeAliasRecord
} = require('./model-alias-store');
const {
  buildModelCapabilityIndex,
  isAccountRoutable,
  listAccountRefsForModelProvider,
  listProviderModelIds,
  modelHasAvailableAccount,
  modelHasAvailableProvider
} = require('./model-capability-index');
const { isSupportedProvider, listEnabledProviders } = require('./providers');

function validateAliasPattern(aliasRaw) {
  const alias = String(aliasRaw || '').trim();
  if (!alias) return { ok: false, error: 'alias_required', detail: 'alias is required' };
  const starCount = (alias.match(/\*/g) || []).length;
  if (starCount === 0) return { ok: true };
  if (starCount > 1 || !alias.endsWith('*')) {
    return {
      ok: false,
      error: 'invalid_alias_wildcard',
      detail: 'wildcard alias may contain one * and it must be the last character'
    };
  }
  const prefix = alias.slice(0, -1);
  if (prefix.length < 2) {
    return {
      ok: false,
      error: 'invalid_alias_wildcard',
      detail: 'wildcard alias prefix must contain at least 2 characters'
    };
  }
  return { ok: true };
}

function aliasTargetIsAlias(aliases, target, excludeAliasId = '') {
  const wanted = String(target || '').trim();
  if (!wanted) return false;
  return (Array.isArray(aliases) ? aliases : [])
    .map((item) => normalizeAliasRecord(item))
    .some((alias) => (
      alias.enabled !== false
      && alias.id !== excludeAliasId
      && alias.alias === wanted
    ));
}

function getTargetProviders(alias, options = {}) {
  const targetProvider = String(alias && alias.targetProvider || '').trim().toLowerCase();
  if (isSupportedProvider(targetProvider)) return [targetProvider];
  return listEnabledProviders(options && options.provider);
}

// Explain WHY a target model failed the catalog check: per provider, whether
// the model is in the provider catalog at all, which accounts back it, and how
// each backing account fails the routable check. Without this the flat
// "not_in_catalog" error hides real causes like "probed models never reached
// the per-account cache" or "the only backing account is cooling down".
function buildAliasTargetDiagnostics(index, target, providers, context = {}) {
  const state = context.state || {};
  return providers.map((provider) => {
    const providerModels = listProviderModelIds(index, provider);
    const accountRefs = listAccountRefsForModelProvider(index, target, provider);
    const stateAccounts = Array.isArray(state.accounts && state.accounts[provider])
      ? state.accounts[provider]
      : [];
    return {
      provider,
      inProviderCatalog: providerModels.includes(target),
      providerCatalogSize: providerModels.length,
      accountRefsForModel: accountRefs,
      accounts: stateAccounts.map((account) => ({
        accountRef: String(account && account.accountRef || ''),
        routable: isAccountRoutable(account)
      }))
    };
  });
}

function validateAliasTarget(aliasRaw, context = {}) {
  const alias = normalizeAliasRecord(aliasRaw);
  const aliases = Array.isArray(context.aliases) ? context.aliases : [];
  const target = String(alias.target || '').trim();
  if (!target) {
    return { ok: false, error: 'alias_target_required', detail: 'alias target is required' };
  }
  if (target.includes('*')) {
    return {
      ok: false,
      error: 'alias_target_must_be_real_model',
      detail: `alias target model ${target} must be a real provider account model, not a wildcard`
    };
  }
  if (String(alias.alias || '').trim() === target) {
    return {
      ok: false,
      error: 'alias_target_must_be_real_model',
      detail: `alias target model ${target} resolves to the same alias`
    };
  }
  if (aliasTargetIsAlias(aliases, target, alias.id)) {
    return {
      ok: false,
      error: 'alias_target_must_be_real_model',
      detail: `alias target model ${target} resolves to another alias`
    };
  }

  const index = context.modelCapabilityIndex || buildModelCapabilityIndex(context.state || {}, context.options || {});
  const providers = getTargetProviders(alias, context.options || {});
  const available = providers.some((provider) => modelHasAvailableProvider(index, target, provider));
  if (!available) {
    return {
      ok: false,
      error: 'alias_target_model_not_in_catalog',
      detail: `alias target model ${target} is not present in the real provider account model catalog`,
      model: target,
      providers,
      diagnostics: buildAliasTargetDiagnostics(index, target, providers, context)
    };
  }
  return { ok: true, model: target, providers };
}

function validateAliasRecordForSave(aliasRaw, context = {}) {
  const alias = normalizeAliasRecord(aliasRaw);
  if (!alias.alias || !alias.target) {
    return { ok: false, error: 'missing_fields', detail: 'alias and target are required' };
  }
  const pattern = validateAliasPattern(alias.alias);
  if (!pattern.ok) return pattern;
  return validateAliasTarget(alias, context);
}

function aliasIsVisible(aliasRaw, context = {}) {
  const alias = normalizeAliasRecord(aliasRaw);
  if (alias.enabled === false || !alias.alias || !alias.target) return false;
  const pattern = validateAliasPattern(alias.alias);
  if (!pattern.ok) return false;
  const target = validateAliasTarget(alias, context);
  if (!target.ok) return false;
  if (modelHasAvailableAccount(
    context.modelCapabilityIndex || buildModelCapabilityIndex(context.state || {}, context.options || {}),
    alias.alias,
    context.options && context.options.provider || 'auto'
  )) {
    return false;
  }
  return true;
}

module.exports = {
  aliasIsVisible,
  aliasTargetIsAlias,
  validateAliasPattern,
  validateAliasRecordForSave,
  validateAliasTarget
};
