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
      // AGY Code Assist 配额机制：
      // 上游模型划分为 2 个模型组（Gemini Models 与 Claude & GPT Models），
      // 每个模型组具有 2 个独立的滑动窗口：Five Hour Limit (5h) 与 Weekly Limit (Weekly / 7days)。
      // 聚合为 4 个独立配额桶进行监控：
      // 1. rate_limit:gemini_5h -> Gemini 模型池 (5h)
      // 2. rate_limit:gemini_week -> Gemini 模型池 (Weekly)
      // 3. rate_limit:claude_gpt_5h -> Claude & GPT 模型池 (5h)
      // 4. rate_limit:claude_gpt_week -> Claude & GPT 模型池 (Weekly)
      const agyBuckets = new Map();

      snapshot.models.forEach((model) => {
        if (!model || typeof model !== 'object') return;
        const modelId = String(model.model || '').trim().toLowerCase();
        if (!modelId) return;

        const isClaudeOrGpt = modelId.startsWith('claude') || modelId.startsWith('gpt');
        const groupBase = isClaudeOrGpt ? 'claude_gpt' : 'gemini';
        const groupTitle = isClaudeOrGpt ? 'Claude & GPT 模型池' : 'Gemini 模型池';

        const remainingPct = typeof model.remainingPct === 'number' && Number.isFinite(model.remainingPct)
          ? Math.max(0, Math.min(100, model.remainingPct))
          : null;
        const expectedResetAtMs = Number(model.resetAtMs) > 0 ? Number(model.resetAtMs) : null;

        let durationMinutes = 300;
        if (expectedResetAtMs && expectedResetAtMs > capturedAt) {
          durationMinutes = Math.ceil((expectedResetAtMs - capturedAt) / 60000);
        }
        const isWeekly = durationMinutes > 360;
        const windowKey = isWeekly ? 'week' : '5h';
        const windowMinutes = isWeekly ? 10080 : 300;
        const windowLabel = `${groupTitle} (${isWeekly ? 'Weekly' : '5h'})`;
        const groupKey = `rate_limit:${groupBase}_${windowKey}`;

        const existing = agyBuckets.get(groupKey);
        if (!existing) {
          agyBuckets.set(groupKey, {
            quotaKey: groupKey,
            windowLabel,
            windowMinutes,
            remainingPct,
            expectedResetAtMs,
            planType,
            capturedAt
          });
        } else {
          // Keep the lowest remainingPct and latest expectedResetAtMs within the same pool & window
          if (remainingPct !== null && (existing.remainingPct === null || remainingPct < existing.remainingPct)) {
            existing.remainingPct = remainingPct;
          }
          if (expectedResetAtMs !== null && (existing.expectedResetAtMs === null || expectedResetAtMs > existing.expectedResetAtMs)) {
            existing.expectedResetAtMs = expectedResetAtMs;
          }
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
