'use strict';

const { modelIdsMatch } = require('./model-id');
const {
  ProviderUsagePolicyRegistry,
  USAGE_SCOPES,
  USAGE_STATUSES,
  createUnknownUsageDecision,
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
  const remainingPct = Number(bucket && bucket.remainingPct);
  if (!Number.isFinite(remainingPct)) return null;
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
      const bucket = selectLimitingBucket(snapshot && snapshot.entries);
      if (bucket) {
        return createUsageDecisionForRemaining({
          ...bucket,
          scope: USAGE_SCOPES.ACCOUNT,
          scopeKey
        });
      }

      const fallback = Number(account && account.remainingPct);
      if (Number.isFinite(fallback)) {
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
  ['kimi', createAccountQuotaPolicy('kimi_oauth_usage')]
]);

module.exports = {
  defaultProviderUsagePolicyRegistry,
  __private: {
    createAccountQuotaPolicy,
    createClaudeFamilyQuotaPolicy,
    createModelQuotaPolicy,
    readSnapshot,
    selectLimitingBucket
  }
};
