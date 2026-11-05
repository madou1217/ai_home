import { useCallback, useMemo, useState } from 'react';
import { Empty, Segmented } from 'antd';

import EChartCanvas, {
  buildChartTooltipStyle,
  type UsageChartPalette
} from '@/features/model-usage/EChartCanvas';
import { formatCost, formatTokens } from '@/features/model-usage/model-usage-presentation';
import type { QuotaStatsGranularity, QuotaUsageBucket } from '@/types';
import {
  USAGE_METRIC_OPTIONS,
  formatUsageBucketAxis,
  formatUsageBucketRange,
  getQuotaEmptyDescription,
  getQuotaEmptyHint,
  getUsageBucketMetricValue,
  getUsageBucketPeriodLabel,
  type UsageBucketMetric
} from './quota-stats-model';

interface UsageBucketChartProps {
  buckets: QuotaUsageBucket[];
  granularity: QuotaStatsGranularity;
  emptyReason: string | null;
}

function getMetricLabel(metric: UsageBucketMetric) {
  if (metric === 'tokens') return 'Tokens';
  if (metric === 'requests') return '请求数';
  return '估算成本';
}

function formatMetricValue(metric: UsageBucketMetric, value: number | null) {
  if (value == null) return '—';
  if (metric === 'tokens') return formatTokens(value);
  if (metric === 'requests') return String(value);
  return formatCost(value);
}

/**
 * 日/周用量柱状图：每个柱子 = 一个自然日/自然周。
 * 与窗口图不同，这里不表达额度消耗，只表达 tokens / 成本 / 请求数。
 */
export default function UsageBucketChart({ buckets, granularity, emptyReason }: UsageBucketChartProps) {
  const [metric, setMetric] = useState<UsageBucketMetric>('tokens');
  const labels = useMemo(() => buckets.map((bucket) => (
    formatUsageBucketAxis(bucket.bucketStartMs, granularity)
  )), [buckets, granularity]);

  const buildOption = useCallback((palette: UsageChartPalette) => {
    const data = buckets.map((bucket) => {
      const value = getUsageBucketMetricValue(bucket, metric);
      const color = metric === 'cost' ? palette.success : palette.brand;
      return {
        value: value == null ? null : Number(value),
        itemStyle: { color }
      };
    });

    const isCost = metric === 'cost';
    return {
      animationDuration: 240,
      animationDurationUpdate: 180,
      aria: { enabled: true, description: '按自然日或自然周统计的用量柱状图' },
      grid: { left: 10, right: 16, top: 42, bottom: 8, containLabel: true },
      tooltip: {
        trigger: 'axis',
        ...buildChartTooltipStyle(palette),
        axisPointer: { lineStyle: { color: palette.brand, opacity: 0.6 } },
        formatter: (params: unknown) => {
          const point = Array.isArray(params) ? params[0] : params;
          const index = Number((point as { dataIndex?: number } | null)?.dataIndex);
          const bucket = buckets[index];
          if (!bucket) return '';
          return [
            formatUsageBucketRange(bucket, granularity),
            `${getMetricLabel(metric)}：${formatMetricValue(metric, getUsageBucketMetricValue(bucket, metric))}`,
            `Tokens：${formatTokens(bucket.tokens)} · 请求 ${bucket.requestCount}`,
            `成本：${bucket.costKnown ? formatCost(bucket.costUsd ?? 0) : '成本未知（部分模型缺定价）'}`
          ].join('<br/>');
        }
      },
      xAxis: {
        type: 'category',
        data: labels,
        axisLine: { lineStyle: { color: palette.border } },
        axisTick: { show: false },
        axisLabel: { color: palette.faint, hideOverlap: true, fontSize: 11, fontFamily: palette.fontMono }
      },
      yAxis: {
        type: 'value',
        min: 0,
        axisLabel: {
          color: palette.faint,
          fontSize: 11,
          fontFamily: palette.fontMono,
          formatter: isCost
            ? (value: number) => formatCost(value)
            : metric === 'tokens'
              ? (value: number) => formatTokens(value)
              : '{value}'
        },
        splitLine: { lineStyle: { color: palette.border, type: 'dashed' } }
      },
      series: [{
        name: getMetricLabel(metric),
        type: 'bar',
        data,
        barMaxWidth: 28,
        emphasis: {
          itemStyle: { shadowBlur: palette.glow, shadowColor: palette.brand }
        }
      }]
    };
  }, [buckets, granularity, labels, metric]);

  const hasData = buckets.some((bucket) => (getUsageBucketMetricValue(bucket, metric) ?? 0) > 0);

  return (
    <div className="usage-chart-shell">
      <div className="usage-chart-heading">
        <div>
          <strong>{getUsageBucketPeriodLabel(granularity)}用量</strong>
          <span>每个柱子是一个自然{getUsageBucketPeriodLabel(granularity)}，按网关调用记录聚合</span>
        </div>
        <Segmented
          size="small"
          value={metric}
          options={USAGE_METRIC_OPTIONS}
          onChange={(value) => setMetric(value as UsageBucketMetric)}
        />
      </div>
      {!hasData ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={(
            <span className="quota-empty-copy">
              <strong>{getQuotaEmptyDescription(emptyReason)}</strong>
              <small>{getQuotaEmptyHint(emptyReason)}</small>
            </span>
          )}
        />
      ) : (
        <EChartCanvas ariaLabel="日周用量" buildOption={buildOption} />
      )}
    </div>
  );
}
