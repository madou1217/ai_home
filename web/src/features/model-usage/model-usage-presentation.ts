import type { ModelUsageModelRow } from '@/types';

export type ModelMixMetric = 'tokens' | 'cost';

export interface ModelMixDatum {
  key: string;
  label: string;
  provider: ModelUsageModelRow['provider'] | '';
  model: string;
  value: number;
  isOther: boolean;
}

export function formatTokens(value: number) {
  const number = Number(value) || 0;
  if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(2)}B`;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(2)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}K`;
  return String(number);
}

export function formatCost(value: number) {
  const number = Number(value) || 0;
  if (number <= 0) return '$0.0000';
  if (number < 0.01) return `$${number.toFixed(4)}`;
  return `$${number.toFixed(2)}`;
}

function formatCompactAxisNumber(value: number) {
  const number = Math.max(0, Number(value) || 0);
  if (number >= 1_000_000_000) return `${Number((number / 1_000_000_000).toFixed(1))}B`;
  if (number >= 1_000_000) return `${Number((number / 1_000_000).toFixed(1))}M`;
  if (number >= 1_000) return `${Number((number / 1_000).toFixed(1))}K`;
  if (number >= 10) return String(Math.round(number));
  if (number >= 0.01) return String(Number(number.toFixed(2)));
  return String(Number(number.toFixed(4)));
}

export function formatModelMixAxisValue(value: number, metric: ModelMixMetric) {
  const compact = formatCompactAxisNumber(value);
  return metric === 'cost' ? `$${compact}` : compact;
}

export function formatCacheRate(value: number | null | undefined) {
  if (value == null) return '-';
  const number = Number(value);
  if (!Number.isFinite(number)) return '-';
  return `${(Math.max(0, Math.min(1, number)) * 100).toFixed(1)}%`;
}

export function getCacheTokens(row: {
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}) {
  return (Number(row.cacheReadInputTokens) || 0) + (Number(row.cacheCreationInputTokens) || 0);
}

export function calculateCacheHitRate(row: {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}) {
  const inputTokens = Number(row.inputTokens) || 0;
  const cacheReadInputTokens = Number(row.cacheReadInputTokens) || 0;
  const cacheCreationInputTokens = Number(row.cacheCreationInputTokens) || 0;
  const inputSideTokens = inputTokens + cacheReadInputTokens + cacheCreationInputTokens;
  return inputSideTokens > 0 ? cacheReadInputTokens / inputSideTokens : null;
}

export function formatAccountScope(accountCount: number, unattributedCalls: number) {
  const known = Math.max(0, Number(accountCount) || 0);
  const hasUnattributed = Math.max(0, Number(unattributedCalls) || 0) > 0;
  if (known === 0) return hasUnattributed ? '仅未归属' : '0 个账号';
  return hasUnattributed ? `${known} 个 + 未归属` : `${known} 个`;
}

export function buildModelMixData(
  models: ModelUsageModelRow[],
  metric: ModelMixMetric,
  limit = 8
): ModelMixDatum[] {
  const valueOf = (row: ModelUsageModelRow) => (
    metric === 'cost' ? Number(row.costUsd) || 0 : Number(row.totalTokens) || 0
  );
  const ranked = [...models]
    .filter((row) => valueOf(row) > 0)
    .sort((left, right) => valueOf(right) - valueOf(left));
  const modelNameCounts = ranked.reduce((counts, row) => {
    const model = row.model || '未知模型';
    counts.set(model, (counts.get(model) || 0) + 1);
    return counts;
  }, new Map<string, number>());
  const head = ranked.slice(0, Math.max(1, limit)).map((row) => ({
    key: `${row.provider}:${row.model}`,
    label: (modelNameCounts.get(row.model || '未知模型') || 0) > 1
      ? `${row.provider} · ${row.model || '未知模型'}`
      : row.model || '未知模型',
    provider: row.provider,
    model: row.model,
    value: valueOf(row),
    isOther: false
  }));
  const tail = ranked.slice(Math.max(1, limit));
  if (tail.length === 0) return head;
  head.push({
    key: '__other__',
    label: `其他 ${tail.length} 个模型`,
    provider: '',
    model: '',
    value: tail.reduce((total, row) => total + valueOf(row), 0),
    isOther: true
  });
  return head;
}
