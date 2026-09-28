// 状态条 / 立方体单元格的悬浮提示文案（纯函数，UI 组件负责渲染）。

import dayjs from 'dayjs';
import { countBucket } from './health';
import { getFailureKindLabel, NEUTRAL_FAILURE_KIND } from './types';
import type { BucketGranularity, OutcomeBucket } from './types';

export interface BucketTooltip {
  /** 日期（YYYY-MM-DD）或小时（MM-DD HH:00） */
  title: string;
  /** 请求数 / 成功率一行；无数据时为 '无数据' */
  summaryLine: string;
  /** Top 3 失败原因（中文标签 + 次数），无失败或无数据时为空数组 */
  failureLines: string[];
}

export function formatBucketTitle(startMs: number, granularity: BucketGranularity): string {
  return granularity === 'day' ? dayjs(startMs).format('YYYY-MM-DD') : dayjs(startMs).format('MM-DD HH:00');
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
  const failureLines = Object.entries(bucket?.failures || {})
    .filter(([kind, count]) => kind !== NEUTRAL_FAILURE_KIND && Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 3)
    .map(([kind, count]) => `${getFailureKindLabel(kind)} ${count}`);
  return {
    title,
    summaryLine: `请求 ${total} 次 · 成功率 ${rate.toFixed(2)}%`,
    failureLines
  };
}
