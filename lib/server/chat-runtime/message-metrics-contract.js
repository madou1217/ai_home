'use strict';

const { ChatRuntimeError } = require('./contract-values');
const METRIC_FIELDS = ['durationMs', 'ttftMs', 'inputTokens', 'outputTokens', 'tokensPerSec', 'contextTokens', 'contextWindow'];

function normalizeMessageMetrics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ChatRuntimeError('chat_metrics_invalid', 422);
  const metrics = {};
  for (const field of METRIC_FIELDS) {
    if (value[field] === undefined) continue;
    if (typeof value[field] !== 'number' || !Number.isFinite(value[field]) || value[field] < 0) {
      throw new ChatRuntimeError('chat_metrics_invalid', 422, { field });
    }
    metrics[field] = value[field];
  }
  if (metrics.ttftMs !== undefined && metrics.durationMs !== undefined && metrics.ttftMs > metrics.durationMs) {
    throw new ChatRuntimeError('chat_metrics_invalid', 422, { field: 'ttftMs' });
  }
  return metrics;
}

module.exports = { normalizeMessageMetrics };
