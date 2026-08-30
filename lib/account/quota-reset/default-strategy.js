'use strict';

const { BaseQuotaResetStrategy } = require('./base-strategy');

class DefaultQuotaResetStrategy extends BaseQuotaResetStrategy {
  constructor(providerName = 'default') {
    super(providerName);
  }

  normalizePlanType(rawPlan) {
    if (!rawPlan) return null;
    const lower = String(rawPlan).trim().toLowerCase();
    if (!lower || lower === 'oauth' || lower === 'api-key' || lower === 'apikey' || lower === 'pending' || lower === 'unknown') {
      return null;
    }
    return lower;
  }

  getPlanTierRank(_normalizedPlan) {
    return undefined; // 通用默认策略不盲目比较未知 provider 的套餐等级
  }

  extractObservations(snapshot, capturedAt) {
    if (!snapshot || typeof snapshot !== 'object') return [];
    const planType = this.normalizePlanType(
      (snapshot.account && snapshot.account.planType) || snapshot.planType
    );
    const observations = [];

    if (Array.isArray(snapshot.entries)) {
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
  DefaultQuotaResetStrategy
};
