'use strict';

function mapCodexTokenUsage(params = {}) {
  const usage = params.tokenUsage;
  const last = usage && usage.last;
  if (!params.turnId || !last || typeof last !== 'object') {
    return { classification: 'known_noop', method: 'thread/tokenUsage/updated', payload: {} };
  }
  const metrics = {};
  for (const field of ['inputTokens', 'outputTokens']) {
    if (Number.isSafeInteger(last[field]) && last[field] >= 0) metrics[field] = last[field];
  }
  if (Number.isSafeInteger(last.totalTokens) && last.totalTokens >= 0) metrics.contextTokens = last.totalTokens;
  if (Number.isSafeInteger(usage.modelContextWindow) && usage.modelContextWindow > 0) metrics.contextWindow = usage.modelContextWindow;
  const totals = {};
  for (const field of ['inputTokens', 'outputTokens']) {
    if (Number.isSafeInteger(usage.total?.[field]) && usage.total[field] >= 0) totals[field] = usage.total[field];
  }
  return { type: 'turn.metrics.updated', turnId: String(params.turnId), payload: { metrics, totals } };
}

module.exports = { mapCodexTokenUsage };
