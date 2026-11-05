import dayjs from 'dayjs';

import type {
  QuotaStatsWindowRow,
  QuotaWindowMetric
} from '@/types';

// 额度统计页的纯展示逻辑：标签、时间格式、指标取值、空态文案。
// 窗口语义全部由服务端算好，这里不重新推导边界。

export interface QuotaDimensionOption {
  label: string;
  value: number;
}

export const QUOTA_DIMENSION_OPTIONS: QuotaDimensionOption[] = [
  { label: '5h', value: 300 },
  { label: '7天', value: 10080 },
  { label: '30天', value: 43200 }
];

export const QUOTA_RANGE_OPTIONS = [
  { label: '7 天', value: 7 },
  { label: '30 天', value: 30 },
  { label: '90 天', value: 90 }
];

export const QUOTA_METRIC_OPTIONS = [
  { label: '额度', value: 'percent' },
  { label: 'Tokens', value: 'tokens' },
  { label: '成本', value: 'cost' }
];

export function formatQuotaClock(ms: number | null | undefined) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '—';
  return dayjs(value).format('MM-DD HH:mm');
}

export function formatQuotaAxisTime(ms: number, windowMinutes: number) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '';
  return windowMinutes >= 1440
    ? dayjs(value).format('MM-DD')
    : dayjs(value).format('MM-DD HH:mm');
}

export function formatQuotaPct(value: number | null | undefined, digits = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `${number.toFixed(digits)}%`;
}

export function formatQuotaWindowRange(window: QuotaStatsWindowRow) {
  return `${formatQuotaClock(window.anchorAtMs)} → ${formatQuotaClock(window.closeAtMs)}`;
}

/** 消耗百分比：起点是估算时前缀 ~，提醒用户这是下界。 */
export function formatWindowConsumed(window: QuotaStatsWindowRow) {
  if (window.consumedPct == null) return '—';
  return `${window.startEstimated ? '~' : ''}${formatQuotaPct(window.consumedPct)}`;
}

export function getWindowMetricValue(
  window: QuotaStatsWindowRow,
  metric: QuotaWindowMetric
): number | null {
  if (metric === 'percent') return window.consumedPct;
  if (metric === 'tokens') return window.tokens;
  return window.costKnown ? window.costUsd : null;
}

export interface QuotaWindowSourceMeta {
  label: string;
  tone: 'live' | 'high' | 'medium' | 'low';
}

/**
 * 来源标签必须诚实：低置信窗口（只有重置事件 / 覆盖不全）不能和真实采样
 * 长得一样，否则用户会把估算当实测。
 */
export function getWindowSourceMeta(window: QuotaStatsWindowRow): QuotaWindowSourceMeta {
  if (window.live) return { label: '实时', tone: 'live' };
  if (window.source === 'reset') return { label: '仅重置事件', tone: 'low' };
  if (window.source === 'reconstructed') return { label: '重建', tone: 'medium' };
  return { label: '采样', tone: window.confidence };
}

export function getResetKindLabel(window: QuotaStatsWindowRow) {
  if (window.resetKind === 'cycle_rollover') return '自然重置';
  if (window.resetKind === 'replenishment') {
    if (window.classification === 'early_inferred') return '提前回血';
    if (window.classification === 'plan_upgrade') return '套餐升级';
    return '回血重置';
  }
  return '';
}

export function getQuotaEmptyDescription(reason: string | null | undefined) {
  if (reason === 'dimension_unavailable') return '该账号没有这个窗口期';
  if (reason === 'no_samples') return '还没有窗口数据';
  if (reason === 'no_windows_in_range') return '所选范围内没有窗口';
  return '暂无窗口数据';
}

export function getQuotaEmptyHint(reason: string | null | undefined) {
  if (reason === 'dimension_unavailable') {
    return '额度窗口只对订阅制账号存在；API Key 账号没有上游窗口。';
  }
  return '历史窗口由重置事件与用量记录尽力重建；采样从本版本起连续记录。';
}
