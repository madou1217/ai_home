import { protocolFailure, record } from './dto-guards';
import type { TimelineMessageMetrics } from './timeline-details';

export function parseMessageMetrics(value: unknown): TimelineMessageMetrics {
  const source = record(value, 'chat_runtime_metrics_invalid');
  const metrics: TimelineMessageMetrics = {};
  for (const field of ['durationMs', 'ttftMs', 'inputTokens', 'outputTokens', 'tokensPerSec', 'contextTokens', 'contextWindow'] as const) {
    const number = source[field];
    if (number === undefined) continue;
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) protocolFailure('chat_runtime_metrics_invalid');
    metrics[field] = number;
  }
  if (metrics.ttftMs !== undefined && metrics.durationMs !== undefined && metrics.ttftMs > metrics.durationMs) {
    protocolFailure('chat_runtime_metrics_invalid');
  }
  return metrics;
}
