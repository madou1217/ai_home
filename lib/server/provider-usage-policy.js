'use strict';

const USAGE_STATUSES = Object.freeze({
  AVAILABLE: 'available',
  EXHAUSTED: 'exhausted',
  UNKNOWN: 'unknown',
  NOT_APPLICABLE: 'not_applicable'
});

const USAGE_SCOPES = Object.freeze({
  ACCOUNT: 'account',
  MODEL: 'model',
  MODEL_FAMILY: 'model_family',
  UNKNOWN: 'unknown'
});

const FALLBACK_USAGE_POLICY = Object.freeze({
  evaluate() {
    return {
      status: USAGE_STATUSES.NOT_APPLICABLE,
      scope: USAGE_SCOPES.UNKNOWN,
      scopeKey: 'unknown',
      remainingPct: null,
      resetAtMs: null,
      reason: 'provider_usage_policy_not_registered'
    };
  },
  listCatalogModels() {
    return [];
  }
});

function normalizeText(value, fallback = '') {
  const text = String(value == null ? '' : value).trim();
  return text || fallback;
}

function normalizeProvider(provider) {
  return normalizeText(provider).toLowerCase();
}

function normalizeRemainingPct(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(100, numeric));
}

function normalizeResetAtMs(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric;
}

function normalizeUsageDecision(input = {}) {
  const status = Object.values(USAGE_STATUSES).includes(input.status)
    ? input.status
    : USAGE_STATUSES.UNKNOWN;
  const scope = Object.values(USAGE_SCOPES).includes(input.scope)
    ? input.scope
    : USAGE_SCOPES.UNKNOWN;
  return {
    status,
    scope,
    scopeKey: normalizeText(input.scopeKey, 'unknown'),
    remainingPct: normalizeRemainingPct(input.remainingPct),
    resetAtMs: normalizeResetAtMs(input.resetAtMs),
    reason: normalizeText(input.reason)
  };
}

function createUnknownUsageDecision(scope = USAGE_SCOPES.UNKNOWN, scopeKey = 'unknown', reason = 'usage_unknown') {
  return normalizeUsageDecision({
    status: USAGE_STATUSES.UNKNOWN,
    scope,
    scopeKey,
    reason
  });
}

function createUsageDecisionForRemaining({
  remainingPct,
  resetAtMs = null,
  scope,
  scopeKey,
  availableReason = '',
  exhaustedReason = 'quota_exhausted'
}) {
  const normalizedRemaining = normalizeRemainingPct(remainingPct);
  if (normalizedRemaining == null) {
    return createUnknownUsageDecision(scope, scopeKey, 'usage_remaining_unknown');
  }
  return normalizeUsageDecision({
    status: normalizedRemaining <= 0 ? USAGE_STATUSES.EXHAUSTED : USAGE_STATUSES.AVAILABLE,
    scope,
    scopeKey,
    remainingPct: normalizedRemaining,
    resetAtMs,
    reason: normalizedRemaining <= 0 ? exhaustedReason : availableReason
  });
}

class ProviderUsagePolicyRegistry {
  constructor(strategies = []) {
    this.strategies = new Map();
    if (Array.isArray(strategies)) {
      strategies.forEach((entry) => {
        if (Array.isArray(entry)) this.register(entry[0], entry[1]);
        else if (entry && typeof entry === 'object') this.register(entry.provider, entry.policy || entry.strategy);
      });
    }
  }

  register(providerRaw, policy) {
    const provider = normalizeProvider(providerRaw);
    if (!provider) throw new TypeError('provider usage policy requires a provider');
    if (!policy || typeof policy.evaluate !== 'function') {
      throw new TypeError(`provider usage policy for ${provider} requires evaluate(account, model)`);
    }
    this.strategies.set(provider, policy);
    return this;
  }

  resolve(providerRaw) {
    return this.strategies.get(normalizeProvider(providerRaw)) || FALLBACK_USAGE_POLICY;
  }

  evaluate(provider, account, modelId, context = {}) {
    const policy = this.resolve(provider);
    try {
      return normalizeUsageDecision(policy.evaluate(account, modelId, context));
    } catch (_error) {
      return createUnknownUsageDecision(
        USAGE_SCOPES.UNKNOWN,
        normalizeText(modelId, 'unknown'),
        'usage_policy_error'
      );
    }
  }

  listCatalogModels(provider, account, context = {}) {
    const policy = this.resolve(provider);
    if (typeof policy.listCatalogModels !== 'function') return [];
    try {
      return Array.from(new Set(
        (policy.listCatalogModels(account, context) || [])
          .map((modelId) => normalizeText(modelId))
          .filter(Boolean)
      ));
    } catch (_error) {
      return [];
    }
  }
}

let defaultRegistry;

function getDefaultProviderUsagePolicyRegistry() {
  if (!defaultRegistry) {
    ({ defaultProviderUsagePolicyRegistry: defaultRegistry } = require('./provider-usage-policies'));
  }
  return defaultRegistry;
}

function resolveRegistry(registry) {
  return registry && typeof registry.evaluate === 'function'
    ? registry
    : getDefaultProviderUsagePolicyRegistry();
}

function evaluateProviderModelUsage(provider, account, modelId, registry) {
  return resolveRegistry(registry).evaluate(provider, account, modelId);
}

function listProviderUsageModels(provider, account, registry) {
  return resolveRegistry(registry).listCatalogModels(provider, account);
}

function registerProviderUsagePolicy(provider, policy) {
  return getDefaultProviderUsagePolicyRegistry().register(provider, policy);
}

function isUsageDecisionSchedulable(decision) {
  return !decision || decision.status !== USAGE_STATUSES.EXHAUSTED;
}

module.exports = {
  ProviderUsagePolicyRegistry,
  USAGE_SCOPES,
  USAGE_STATUSES,
  createUnknownUsageDecision,
  createUsageDecisionForRemaining,
  evaluateProviderModelUsage,
  getDefaultProviderUsagePolicyRegistry,
  isUsageDecisionSchedulable,
  listProviderUsageModels,
  normalizeUsageDecision,
  registerProviderUsagePolicy
};
