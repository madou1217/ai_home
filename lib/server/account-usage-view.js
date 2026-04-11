'use strict';

function normalizeAccountUsageSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const capturedAt = Number(snapshot.capturedAt) || 0;

  if (snapshot.kind === 'codex_oauth_status' && Array.isArray(snapshot.entries)) {
    return {
      kind: 'codex_oauth_status',
      capturedAt,
      entries: snapshot.entries.map((entry) => ({
        bucket: String(entry && entry.bucket || ''),
        windowMinutes: Number(entry && entry.windowMinutes) || 0,
        window: String(entry && entry.window || ''),
        remainingPct: Number.isFinite(Number(entry && entry.remainingPct)) ? Number(entry.remainingPct) : null,
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
        remainingPct: Number.isFinite(Number(model && model.remainingPct)) ? Number(model.remainingPct) : null,
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
