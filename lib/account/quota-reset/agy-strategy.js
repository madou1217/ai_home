'use strict';

const { BaseQuotaResetStrategy, normalizePlanValue } = require('./base-strategy');

// Google Antigravity / Code Assist 官方套餐等级：Starter / Free (0) < Pro (1) < Ultra (2)
// 这张表只用于「是否升级」的比较，不作为识别门槛：未知档位原样通过。
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
    const normalized = normalizePlanValue(rawPlan);
    if (!normalized) return null;
    // 上游档位名带前后缀（gemini-pro-tier 等）：按关键字归类，其余原样通过。
    if (normalized.includes('ultra')) return 'ultra';
    if (normalized.includes('pro')) return 'pro';
    if (normalized.includes('starter') || normalized.includes('free') || normalized.includes('default')) {
      return 'free';
    }
    return normalized;
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

        // 判定重置窗口类型：
        // 1. 如果有剩余时间 resetIn 字符串且包含 day/d，或者重置时间差 > 6 小时 (360m)，归为周度窗口
        // 2. 否则归为 5 小时滚动窗口
        let isWeekly = false;
        let windowMinutes = 300;
        if (expectedResetAtMs && expectedResetAtMs > capturedAt) {
          const diffMinutes = Math.ceil((expectedResetAtMs - capturedAt) / 60000);
          isWeekly = diffMinutes > 360;
          windowMinutes = isWeekly ? 10080 : 300;
        } else if (typeof model.resetIn === 'string' && /days?|\bd\b/i.test(model.resetIn)) {
          isWeekly = true;
          windowMinutes = 10080;
        }

        const windowKey = isWeekly ? 'week' : '5h';
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
      return this.extractStandardEntriesObservations(snapshot, capturedAt);
    }

    return observations;
  }
}

module.exports = {
  AgyQuotaResetStrategy,
  AGY_PLAN_TIERS
};
