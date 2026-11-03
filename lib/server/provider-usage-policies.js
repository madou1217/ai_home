'use strict';

const { modelIdsMatch } = require('./model-id');
const {
  ProviderUsagePolicyRegistry,
  USAGE_SCOPES,
  USAGE_STATUSES,
  createUnknownUsageDecision,
  normalizeRemainingPct,
  createUsageDecisionForRemaining
} = require('./provider-usage-policy');

function normalizeModelId(value) {
  return String(value == null ? '' : value).trim();
}

function isApiKeyAccount(account) {
  return Boolean(account && account.apiKeyMode);
}

function readSnapshot(account, kind, collectionKey) {
  const snapshot = account && account.usageSnapshot;
  if (!snapshot || typeof snapshot !== 'object') return null;
  if (snapshot.kind !== kind || !Array.isArray(snapshot[collectionKey])) return null;
  return snapshot;
}

function readRemainingBucket(bucket) {
  const remainingPct = normalizeRemainingPct(bucket && bucket.remainingPct);
  if (remainingPct == null) return null;
  return {
    remainingPct,
    resetAtMs: Number(bucket && bucket.resetAtMs) > 0 ? Number(bucket.resetAtMs) : null
  };
}

function selectLimitingBucket(buckets) {
  return (Array.isArray(buckets) ? buckets : [])
    .map(readRemainingBucket)
    .filter(Boolean)
    .sort((left, right) => {
      if (left.remainingPct !== right.remainingPct) return left.remainingPct - right.remainingPct;
      return (left.resetAtMs || Number.MAX_SAFE_INTEGER) - (right.resetAtMs || Number.MAX_SAFE_INTEGER);
    })[0] || null;
}

function createAccountQuotaPolicy(snapshotKind) {
  return {
    evaluate(account) {
      const scopeKey = normalizeModelId(account && account.accountRef) || 'account';
      if (isApiKeyAccount(account)) {
        return {
          status: USAGE_STATUSES.NOT_APPLICABLE,
          scope: USAGE_SCOPES.ACCOUNT,
          scopeKey,
          reason: 'api_key_account'
        };
      }

      const snapshot = readSnapshot(account, snapshotKind, 'entries');
      const bucket = selectLimitingBucket(snapshot && snapshot.entries.filter((entry) => entry
        && entry.category !== 'gift' && entry.category !== 'detail'));
      if (bucket) {
        return createUsageDecisionForRemaining({
          ...bucket,
          scope: USAGE_SCOPES.ACCOUNT,
          scopeKey
        });
      }

      const fallback = normalizeRemainingPct(account && account.remainingPct);
      if (fallback != null) {
        return createUsageDecisionForRemaining({
          remainingPct: fallback,
          scope: USAGE_SCOPES.ACCOUNT,
          scopeKey
        });
      }

      return createUnknownUsageDecision(
        USAGE_SCOPES.ACCOUNT,
        scopeKey,
        snapshot ? 'quota_bucket_missing' : 'quota_snapshot_missing'
      );
    }
  };
}

function createModelQuotaPolicy(snapshotKind) {
  return {
    listCatalogModels(account) {
      const snapshot = readSnapshot(account, snapshotKind, 'models');
      return snapshot
        ? snapshot.models.map((item) => normalizeModelId(item && item.model)).filter(Boolean)
        : [];
    },
    evaluate(account, modelId) {
      const requestedModel = normalizeModelId(modelId);
      const scope = USAGE_SCOPES.MODEL;
      const scopeKey = requestedModel || 'unknown';
      if (isApiKeyAccount(account)) {
        return {
          status: USAGE_STATUSES.NOT_APPLICABLE,
          scope,
          scopeKey,
          reason: 'api_key_account'
        };
      }

      const snapshot = readSnapshot(account, snapshotKind, 'models');
      const buckets = snapshot
        ? snapshot.models.filter((item) => modelIdsMatch(item && item.model, requestedModel))
        : [];
      const bucket = selectLimitingBucket(buckets);
      if (!bucket) {
        return createUnknownUsageDecision(
          scope,
          scopeKey,
          snapshot ? 'quota_bucket_missing' : 'quota_snapshot_missing'
        );
      }

      const matchedModel = normalizeModelId(buckets[0] && buckets[0].model) || scopeKey;
      return createUsageDecisionForRemaining({
        ...bucket,
        scope,
        scopeKey: matchedModel
      });
    }
  };
}

function createClaudeFamilyQuotaPolicy() {
  return {
    evaluate(account) {
      const scopeKey = 'claude';
      if (isApiKeyAccount(account)) {
        return {
          status: USAGE_STATUSES.NOT_APPLICABLE,
          scope: USAGE_SCOPES.MODEL_FAMILY,
          scopeKey,
          reason: 'api_key_account'
        };
      }

      const snapshot = readSnapshot(account, 'claude_oauth_usage', 'entries');
      const bucket = selectLimitingBucket(snapshot && snapshot.entries);
      if (!bucket) {
        return createUnknownUsageDecision(
          USAGE_SCOPES.MODEL_FAMILY,
          scopeKey,
          snapshot ? 'quota_bucket_missing' : 'quota_snapshot_missing'
        );
      }
      return createUsageDecisionForRemaining({
        ...bucket,
        scope: USAGE_SCOPES.MODEL_FAMILY,
        scopeKey
      });
    }
  };
}

const defaultProviderUsagePolicyRegistry = new ProviderUsagePolicyRegistry([
  ['codex', createAccountQuotaPolicy('codex_oauth_status')],
  ['gemini', createModelQuotaPolicy('gemini_oauth_stats')],
  ['agy', createModelQuotaPolicy('agy_code_assist_quota')],
  ['claude', createClaudeFamilyQuotaPolicy()],
  ['kimi', createAccountQuotaPolicy('kimi_oauth_usage')],
  ['grok', createAccountQuotaPolicy('grok_credit_usage')],
  ['kiro', createAccountQuotaPolicy('kiro_credit_usage')]
]);

// 其余声明了额度的 provider（qoder / zcode / CodeBuddy 家族 / Cline Pass …）按描述符的
// quota 声明派生：shape=entries → 账号级、shape=models → 按模型。新增 provider 只写描述符就进入
// 额度门禁，不在这里补表；上面显式登记的（含 claude 的模型家族口径）优先。
const QUOTA_SHAPE_POLICY_FACTORIES = Object.freeze({
  entries: createAccountQuotaPolicy,
  models: createModelQuotaPolicy
});

function registerDescriptorQuotaPolicies(registry) {
  const { describeQuotaProvider, listQuotaProviders } = require('../usage/quota');
  listQuotaProviders().forEach((provider) => {
    if (registry.strategies.has(provider)) return;
    const quota = describeQuotaProvider(provider);
    const factory = quota && quota.kind ? QUOTA_SHAPE_POLICY_FACTORIES[quota.shape] : null;
    if (factory) registry.register(provider, factory(quota.kind));
  });
  return registry;
}

try {
  registerDescriptorQuotaPolicies(defaultProviderUsagePolicyRegistry);
} catch (_error) {
  // 描述符注册表不可用（极简装配 / 单测）时只保留上面的显式策略。
}

module.exports = {
  defaultProviderUsagePolicyRegistry,
  __private: {
    createAccountQuotaPolicy,
    createClaudeFamilyQuotaPolicy,
    createModelQuotaPolicy,
    readSnapshot,
    registerDescriptorQuotaPolicies,
    selectLimitingBucket
  }
};
