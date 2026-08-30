'use strict';

const { BaseQuotaResetStrategy } = require('./base-strategy');

// Google Antigravity / Code Assist 官方套餐等级：Starter / Free (0) < Pro (1) < Ultra (2)
const AGY_PLAN_TIERS = Object.freeze({
  free: 0,
  starter: 0,
  pro: 1,
  ultra: 2
});

class AgyQuotaResetStrategy extends BaseQuotaResetStrategy {
  constructor() {
    super('agy');
  }

  normalizePlanType(rawPlan) {
    if (!rawPlan) return null;
    const lower = String(rawPlan).trim().toLowerCase();
    if (!lower || lower === 'oauth' || lower === 'api-key' || lower === 'apikey' || lower === 'pending' || lower === 'unknown') {
      return null;
    }
    if (lower.includes('ultra')) return 'ultra';
    if (lower.includes('pro')) return 'pro';
    if (lower.includes('starter') || lower.includes('free') || lower.includes('default')) return 'free';
    return Object.prototype.hasOwnProperty.call(AGY_PLAN_TIERS, lower) ? lower : null;
  }

  getPlanTierRank(normalizedPlan) {
    return AGY_PLAN_TIERS[normalizedPlan];
  }

  extractObservations(snapshot, capturedAt) {
    if (!snapshot || typeof snapshot !== 'object') return [];
    const rawTier = (snapshot.account && (snapshot.account.subscriptionTier || snapshot.account.planType))
      || snapshot.subscriptionTier
      || snapshot.planType;
    const planType = this.normalizePlanType(rawTier);
    const observations = [];

    if (Array.isArray(snapshot.models)) {
      // AGY Code Assist 配额机制：上游将数十个模型聚合成 2 个共享池：
      // 1. Gemini 系列共享池 (Gemini 2.5/3/3.5/3.6/3.7) -> rate_limit:gemini_models
      // 2. Claude & GPT 系列共享池 (Claude Opus/Sonnet, GPT-OSS) -> rate_limit:claude_gpt_models
      const agyBuckets = new Map();

      snapshot.models.forEach((model) => {
        if (!model || typeof model !== 'object') return;
        const modelId = String(model.model || '').trim().toLowerCase();
        if (!modelId) return;

        const isClaudeOrGpt = modelId.startsWith('claude') || modelId.startsWith('gpt');
        const groupKey = isClaudeOrGpt ? 'rate_limit:claude_gpt_models' : 'rate_limit:gemini_models';
        const groupLabel = isClaudeOrGpt ? 'Claude & GPT 模型池' : 'Gemini 模型池';

        const remainingPct = typeof model.remainingPct === 'number' && Number.isFinite(model.remainingPct)
          ? Math.max(0, Math.min(100, model.remainingPct))
          : null;
        const expectedResetAtMs = Number(model.resetAtMs) > 0 ? Number(model.resetAtMs) : null;

        if (!agyBuckets.has(groupKey)) {
          agyBuckets.set(groupKey, {
            quotaKey: groupKey,
            windowLabel: groupLabel,
            windowMinutes: 300,
            remainingPct,
            expectedResetAtMs,
            planType,
            capturedAt
          });
        }
      });

      agyBuckets.forEach((obs) => {
        if (obs.remainingPct !== null || obs.expectedResetAtMs !== null) {
          observations.push(obs);
        }
      });
    } else if (Array.isArray(snapshot.entries)) {
      snapshot.entries.forEach((entry) => {
        if (!entry || typeof entry !== 'object') return;
        const bucket = String(entry.bucket || '').trim();
        const windowMinutes = Number(entry.windowMinutes) || null;
        const windowLabel = String(entry.window || bucket || '').trim();
        const quotaKey = `rate_limit:${bucket || windowLabel || 'default'}`;
        const remainingPct = typeof entry.remainingPct === 'number' && Number.isFinite(entry.remainingPct)
          ? Math.max(0, Math.min(100, entry.remainingPct))
          : null;
        const expectedResetAtMs = Number(entry.resetAtMs) > 0 ? Number(entry.resetAtMs) : null;

        if (remainingPct !== null || expectedResetAtMs !== null) {
          observations.push({
            quotaKey,
            windowLabel,
            windowMinutes,
            remainingPct,
            expectedResetAtMs,
            planType,
            capturedAt
          });
        }
      });
    }

    return observations;
  }
}

module.exports = {
  AgyQuotaResetStrategy,
  AGY_PLAN_TIERS
};
