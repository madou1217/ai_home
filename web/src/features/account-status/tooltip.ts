// 状态条 / 立方体单元格的悬浮提示文案（纯函数，UI 组件负责渲染）。

import dayjs from 'dayjs';
import { countBucket } from './health';
import { getFailureKindLabel, isNeutralFailureKind } from './types';
import type { BucketGranularity, OutcomeBucket } from './types';

export interface BucketTooltip {
  /** 日期（YYYY-MM-DD）或小时（MM-DD HH:00） */
  title: string;
  /** 请求数 / 成功率一行；无数据时为 '无数据' */
  summaryLine: string;
  /** 失败原因（中文标签 + 次数）：可计数失败 Top 3 在前，中立失败 Top 3 在后（带「不计入可用率」），无失败或无数据时为空数组 */
  failureLines: string[];
}

/** 中立失败（请求级，见 types.ts）不进可用率，但仍列出来，并标出「不计入」。 */
const NEUTRAL_LINE_SUFFIX = '（不计入可用率）';
const MAX_FAILURE_LINES = 3;

export function formatBucketTitle(startMs: number, granularity: BucketGranularity): string {
  return granularity === 'day' ? dayjs(startMs).format('YYYY-MM-DD') : dayjs(startMs).format('MM-DD HH:00');
}

function topFailureLines(bucket: OutcomeBucket | null | undefined, neutral: boolean): string[] {
  return Object.entries(bucket?.failures || {})
    .filter(([kind, count]) => isNeutralFailureKind(kind) === neutral && Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, MAX_FAILURE_LINES)
    .map(([kind, count]) => `${getFailureKindLabel(kind)} ${count}${neutral ? NEUTRAL_LINE_SUFFIX : ''}`);
}

export function buildBucketTooltip(
  startMs: number,
  bucket: OutcomeBucket | null | undefined,
  granularity: BucketGranularity
): BucketTooltip {
  const title = formatBucketTitle(startMs, granularity);
  const { success, total } = countBucket(bucket);
  if (!(total > 0)) {
    return { title, summaryLine: '无数据', failureLines: [] };
  }
  const rate = Math.round((success / total) * 10000) / 100;
  return {
    title,
    summaryLine: `请求 ${total} 次 · 成功率 ${rate.toFixed(2)}%`,
    // 可计数失败在前（它们解释了成功率），中立失败在后（解释了为什么没被计入）。
    failureLines: [...topFailureLines(bucket, false), ...topFailureLines(bucket, true)]
  };
}
