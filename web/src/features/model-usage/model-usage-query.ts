import dayjs, { type Dayjs } from 'dayjs';
import type {
  ModelUsageDashboardQueryJob,
  ModelUsageQuery,
  ModelUsageScanJob,
  ModelUsageStats,
  ModelUsageTrend,
  ModelUsageTrendPoint,
  Provider
} from '@/types';

/**
 * 模型用量查询的纯工具（范围预设、查询参数、任务状态、趋势时间槽）。
 * 桌面 ModelUsage 与移动端 MobileUsage 共用，保证两端请求参数与口径一致。
 */

export type UsageProviderFilter = Provider | '';
export type UsageRangeMode = 'hour' | 'today' | '7d' | 'month' | 'custom';

export const USAGE_REQUEST_DETAIL_LIMIT = 80;

export const USAGE_RANGE_OPTIONS: Array<{ label: string; value: UsageRangeMode }> = [
  { label: '1 小时', value: 'hour' },
  { label: '今天', value: 'today' },
  { label: '近 7 天', value: '7d' },
  { label: '一个月', value: 'month' },
  { label: '自定义', value: 'custom' }
];

export const EMPTY_USAGE_STATS: ModelUsageStats = {
  totalCalls: 0,
  totalSessions: 0,
  totalPrompts: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
  totalCostUsd: 0
};

export const EMPTY_USAGE_TREND: ModelUsageTrend = {
  fromMs: 0,
  toMs: 0,
  bucketMs: 0,
  points: []
};

export function formatUsageDate(value: Dayjs) {
  return value.format('YYYY-MM-DD');
}

export function formatUsageDateTime(value: Dayjs) {
  return value.format('YYYY-MM-DDTHH:mm:ssZ');
}

export function buildUsageRangeByMode(mode: UsageRangeMode): [Dayjs, Dayjs] {
  const now = dayjs();
  if (mode === 'hour') return [now.subtract(1, 'hour'), now];
  if (mode === '7d') return [now.subtract(6, 'day').startOf('day'), now];
  if (mode === 'month') return [now.subtract(1, 'month').startOf('day'), now];
  return [now.startOf('day'), now];
}

/** 与桌面 ModelUsage.buildQuery 同一口径：1 小时 / 自定义带起始时刻，其余按自然日起点；终点始终为快照时刻。 */
export function buildUsageQuery(
  range: [Dayjs, Dayjs],
  rangeMode: UsageRangeMode,
  provider: UsageProviderFilter,
  model: string,
  limit = 50,
  scan = false
): ModelUsageQuery {
  const includeStartTime = rangeMode === 'hour' || rangeMode === 'custom';
  return {
    from: includeStartTime ? formatUsageDateTime(range[0]) : formatUsageDate(range[0]),
    to: formatUsageDateTime(range[1]),
    provider,
    model: model.trim(),
    limit,
    scan
  };
}

export function isUsageScanJobActive(job: ModelUsageScanJob | null) {
  return Boolean(job && (job.status === 'queued' || job.status === 'running'));
}

export function isUsageDashboardQueryActive(job: ModelUsageDashboardQueryJob | null) {
  return Boolean(job && ['queued', 'preparing', 'running'].includes(job.status));
}

export function formatUsageTime(value: number) {
  if (!value) return '-';
  return dayjs(value).format('MM-DD HH:mm');
}

/** 把稀疏趋势点铺到完整时间槽上（缺失桶为 null），最多 120 槽。 */
export function buildTrendSlots(trend: ModelUsageTrend) {
  if (!trend.bucketMs || trend.toMs < trend.fromMs) return [];
  const points = new Map(trend.points.map((point) => [point.bucketStartMs, point]));
  const slots: Array<ModelUsageTrendPoint | null> = [];
  for (let timestamp = trend.fromMs; timestamp <= trend.toMs; timestamp += trend.bucketMs) {
    slots.push(points.get(timestamp) || null);
    if (slots.length >= 120) break;
  }
  return slots;
}

export function formatTrendAxisTime(timestamp: number, bucketMs: number) {
  if (bucketMs < 24 * 60 * 60 * 1000) return dayjs(timestamp).format('MM-DD HH:mm');
  return dayjs(timestamp).format('MM-DD');
}
