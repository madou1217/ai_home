'use strict';

function normalizeAccountUsageSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const capturedAt = Number(snapshot.capturedAt) || 0;
  const toNullableNumber = (value) => {
    if (value == null) return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };

  if (snapshot.kind === 'codex_oauth_status' && Array.isArray(snapshot.entries)) {
    return {
      kind: 'codex_oauth_status',
      capturedAt,
      fallbackSource: String(snapshot.fallbackSource || ''),
      account: snapshot.account && typeof snapshot.account === 'object'
        ? {
            planType: String(snapshot.account.planType || ''),
            email: String(snapshot.account.email || ''),
            accountId: String(snapshot.account.accountId || ''),
            organizationId: String(snapshot.account.organizationId || '')
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

  return null;
}

module.exports = {
  normalizeAccountUsageSnapshot
};
