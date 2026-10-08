'use strict';

function normalizeAccountUsageSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const capturedAt = Number(snapshot.capturedAt) || 0;
  const toNullableNumber = (value) => {
    if (value == null) return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };
  const normalizeResetCreditSummary = (value) => {
    if (!value || typeof value !== 'object') return null;
    const availableCount = Number(value.availableCount);
    if (!Number.isInteger(availableCount) || availableCount < 0) return null;
    return { availableCount };
  };

  if (snapshot.kind === 'codex_oauth_status' && Array.isArray(snapshot.entries)) {
    const resetCredits = normalizeResetCreditSummary(snapshot.rateLimitResetCredits);
    return {
      kind: 'codex_oauth_status',
      capturedAt,
      fallbackSource: String(snapshot.fallbackSource || ''),
      ...(resetCredits ? { resetCreditsAvailableCount: resetCredits.availableCount } : {}),
      account: snapshot.account && typeof snapshot.account === 'object'
        ? {
            planType: String(snapshot.account.planType || ''),
            email: String(snapshot.account.email || ''),
            upstreamAccountId: String(snapshot.account.upstreamAccountId || ''),
            organizationId: String(snapshot.account.organizationId || ''),
            // ChatGPT 订阅到期（id_token 声明快照）与该快照的校验时间，供账号列表显示到期时间。
            subscriptionActiveUntilMs: Number(snapshot.account.subscriptionActiveUntilMs) || 0,
            subscriptionLastCheckedMs: Number(snapshot.account.subscriptionLastCheckedMs) || 0,
            // 额度接口实时确认该套餐的时间；用于判断到期日之后是否已续费。
            planConfirmedAtMs: Number(snapshot.account.planConfirmedAtMs) || 0
          }
        : null,
      entries: snapshot.entries.map((entry) => ({
        bucket: String(entry && entry.bucket || ''),
        windowMinutes: Number(entry && entry.windowMinutes) || 0,
        window: String(entry && entry.window || ''),
        remainingPct: toNullableNumber(entry && entry.remainingPct),
        resetIn: String(entry && entry.resetIn || ''),
        resetAtMs: Number(entry && entry.resetAtMs) || 0
      }))
    };
  }

  if (snapshot.kind === 'claude_oauth_usage' && Array.isArray(snapshot.entries)) {
    return {
      kind: 'claude_oauth_usage',
      capturedAt,
      account: snapshot.account && typeof snapshot.account === 'object'
        ? {
            email: String(snapshot.account.email || ''),
            fullName: String(snapshot.account.fullName || ''),
            planType: String(snapshot.account.planType || '')
          }
        : null,
      entries: snapshot.entries.map((entry) => ({
        bucket: String(entry && entry.bucket || ''),
        windowMinutes: Number(entry && entry.windowMinutes) || 0,
        window: String(entry && entry.window || ''),
        remainingPct: toNullableNumber(entry && entry.remainingPct),
        resetIn: String(entry && entry.resetIn || ''),
        resetAtMs: Number(entry && entry.resetAtMs) || 0
      }))
    };
  }

  if (snapshot.kind === 'grok_credit_usage' && Array.isArray(snapshot.entries)) {
    return {
      kind: 'grok_credit_usage',
      capturedAt,
      account: snapshot.account && typeof snapshot.account === 'object'
        ? { email: String(snapshot.account.email || ''), planType: String(snapshot.account.planType || ''),
            planName: String(snapshot.account.planName || '') } : null,
      entries: snapshot.entries.map((entry) => ({
        bucket: String(entry && entry.bucket || ''),
        windowMinutes: Number(entry && entry.windowMinutes) || 0,
        window: String(entry && entry.window || ''),
        remainingPct: toNullableNumber(entry && entry.remainingPct),
        resetIn: String(entry && entry.resetIn || ''),
        resetAtMs: Number(entry && entry.resetAtMs) || 0
      }))
    };
  }

  if (snapshot.kind === 'kiro_credit_usage' && Array.isArray(snapshot.entries)) {
    return {
      kind: snapshot.kind, capturedAt,
      account: snapshot.account && typeof snapshot.account === 'object'
        ? { email: String(snapshot.account.email || ''), planType: String(snapshot.account.planType || ''),
            planName: String(snapshot.account.planName || '') } : null,
      entries: snapshot.entries.map(entry => ({
        bucket: String(entry?.bucket || ''), windowMinutes: Number(entry?.windowMinutes) || 0,
        window: String(entry?.window || ''), remainingPct: toNullableNumber(entry?.remainingPct),
        resetIn: String(entry?.resetIn || ''), resetAtMs: Number(entry?.resetAtMs) || 0,
        totalUnits: toNullableNumber(entry?.totalUnits), usedUnits: toNullableNumber(entry?.usedUnits),
        remainingUnits: toNullableNumber(entry?.remainingUnits), unitType: String(entry?.unitType || '')
      }))
    };
  }

  if (snapshot.kind === 'gemini_oauth_stats' && Array.isArray(snapshot.models)) {
    return {
      kind: 'gemini_oauth_stats',
      capturedAt,
      models: snapshot.models.map((model) => ({
        model: String(model && model.model || ''),
        remainingPct: toNullableNumber(model && model.remainingPct),
        resetIn: String(model && model.resetIn || ''),
        resetAtMs: Number(model && model.resetAtMs) || 0
      }))
    };
  }

  if (snapshot.kind === 'agy_code_assist_quota' && Array.isArray(snapshot.models)) {
    return {
      kind: 'agy_code_assist_quota',
      capturedAt,
      account: snapshot.account && typeof snapshot.account === 'object'
        ? {
            planType: String(snapshot.account.planType || ''),
            email: String(snapshot.account.email || ''),
            subscriptionTier: String(snapshot.account.subscriptionTier || ''),
            project: String(snapshot.account.project || '')
          }
        : null,
      models: snapshot.models.map((model) => ({
        model: String(model && model.model || ''),
        remainingPct: toNullableNumber(model && model.remainingPct),
        resetIn: String(model && model.resetIn || ''),
        resetAtMs: Number(model && model.resetAtMs) || 0,
        displayName: String(model && model.displayName || ''),
        supportsThinking: Boolean(model && model.supportsThinking),
        supportsImages: Boolean(model && model.supportsImages),
        maxTokens: toNullableNumber(model && model.maxTokens),
        maxOutputTokens: toNullableNumber(model && model.maxOutputTokens)
      })),
      modelForwardingRules: snapshot.modelForwardingRules && typeof snapshot.modelForwardingRules === 'object'
        ? { ...snapshot.modelForwardingRules }
        : {}
    };
  }

  if (snapshot.kind === 'kimi_oauth_usage' && Array.isArray(snapshot.entries)) {
    const planSubscription = snapshot.account && snapshot.account.planSubscription && typeof snapshot.account.planSubscription === 'object'
      ? {
          name: String(snapshot.account.planSubscription.name || ''),
          status: String(snapshot.account.planSubscription.status || ''),
          validUntilMs: Number(snapshot.account.planSubscription.validUntilMs) || 0,
          resetAtMs: Number(snapshot.account.planSubscription.resetAtMs) || 0
        }
      : null;
    return {
      kind: 'kimi_oauth_usage',
      capturedAt,
      account: snapshot.account && typeof snapshot.account === 'object'
        ? {
            displayName: String(snapshot.account.displayName || ''),
            userId: String(snapshot.account.userId || ''),
            phone: String(snapshot.account.phone || ''),
            planType: String(snapshot.account.planType || ''),
            planName: String(snapshot.account.planName || ''),
            planSubscription
          }
        : null,
      entries: snapshot.entries.map((entry) => ({
        bucket: String(entry && entry.bucket || ''),
        windowMinutes: Number(entry && entry.windowMinutes) || 0,
        window: String(entry && entry.window || ''),
        remainingPct: toNullableNumber(entry && entry.remainingPct),
        resetIn: String(entry && entry.resetIn || ''),
        resetAtMs: Number(entry && entry.resetAtMs) || 0,
        ...(entry && entry.category ? { category: String(entry.category) } : {})
      }))
    };
  }

  if (snapshot.kind === 'zcode_plan_balance' && Array.isArray(snapshot.entries)) {
    return {
      kind: 'zcode_plan_balance',
      capturedAt,
      account: snapshot.account && typeof snapshot.account === 'object'
        ? {
            planType: String(snapshot.account.planType || '')
          }
        : null,
      entries: snapshot.entries.map((entry) => ({
        bucket: String(entry && entry.bucket || ''),
        windowMinutes: Number(entry && entry.windowMinutes) || 0,
        window: String(entry && entry.window || ''),
        remainingPct: toNullableNumber(entry && entry.remainingPct),
        totalUnits: toNullableNumber(entry && entry.totalUnits),
        usedUnits: toNullableNumber(entry && entry.usedUnits),
        remainingUnits: toNullableNumber(entry && entry.remainingUnits),
        unitType: String(entry && entry.unitType || ''),
        resetIn: String(entry && entry.resetIn || ''),
        resetAtMs: Number(entry && entry.resetAtMs) || 0
      }))
    };
  }

  // CodeBuddy / WorkBuddy 家族共用的积分快照：entries[0] 是账户级聚合，其余 category='detail'
  // 为每包明细。此前没有这一支，快照被规范化成空，账号页把额度当成 0 → 已耗尽。
  if (snapshot.kind === 'codebuddy_credit_balance' && Array.isArray(snapshot.entries)) {
    return {
      kind: 'codebuddy_credit_balance',
      capturedAt,
      account: snapshot.account && typeof snapshot.account === 'object'
        ? { planType: String(snapshot.account.planType || '') }
        : null,
      entries: snapshot.entries.map((entry) => ({
        bucket: String(entry && entry.bucket || ''),
        windowMinutes: Number(entry && entry.windowMinutes) || 0,
        window: String(entry && entry.window || ''),
        remainingPct: toNullableNumber(entry && entry.remainingPct),
        totalUnits: toNullableNumber(entry && entry.totalUnits),
        usedUnits: toNullableNumber(entry && entry.usedUnits),
        remainingUnits: toNullableNumber(entry && entry.remainingUnits),
        unitType: String(entry && entry.unitType || ''),
        resetIn: String(entry && entry.resetIn || ''),
        resetAtMs: Number(entry && entry.resetAtMs) || 0,
        ...(entry && entry.category ? { category: String(entry.category) } : {})
      }))
    };
  }

  return null;
}

module.exports = {
  normalizeAccountUsageSnapshot
};
