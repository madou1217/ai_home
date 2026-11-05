import { useCallback, useMemo, useState } from 'react';
import { Empty, Segmented } from 'antd';

import EChartCanvas, {
  buildChartTooltipStyle,
  type UsageChartPalette
} from '@/features/model-usage/EChartCanvas';
import { formatCost, formatTokens } from '@/features/model-usage/model-usage-presentation';
import type { QuotaStatsWindowRow, QuotaWindowMetric } from '@/types';
import {
  QUOTA_METRIC_OPTIONS,
  formatQuotaAxisTime,
  formatQuotaPct,
  formatQuotaWindowRange,
  getQuotaEmptyDescription,
  getQuotaEmptyHint,
  getResetKindLabel,
  getWindowMetricValue,
  getWindowSourceMeta
} from './quota-stats-model';

interface QuotaWindowChartProps {
  windows: QuotaStatsWindowRow[];
  windowMinutes: number;
  emptyReason: string | null;
}

function getMetricLabel(metric: QuotaWindowMetric) {
  if (metric === 'percent') return '消耗额度';
  if (metric === 'tokens') return 'Tokens';
  return '估算成本';
}

function buildTooltipLines(window: QuotaStatsWindowRow, metric: QuotaWindowMetric) {
  const source = getWindowSourceMeta(window);
  const lines = [
    formatQuotaWindowRange(window),
    `${getMetricLabel(metric)}：${
      metric === 'percent'
        ? formatQuotaPct(window.consumedPct)
        : metric === 'tokens'
          ? formatTokens(window.tokens)
          : (window.costKnown ? formatCost(window.costUsd ?? 0) : '成本未知（部分模型缺定价）')
    }`,
    `峰值消耗：${formatQuotaPct(window.peakConsumedPct)}`,
    `Tokens：${formatTokens(window.tokens)} · 请求 ${window.requestCount}`,
    `来源：${source.label} · 样本 ${window.sampleCount}`
  ];
  if (window.truncated) lines.push('提前重置：窗口在计划关窗前被截断');
  const resetLabel = getResetKindLabel(window);
  if (resetLabel) lines.push(`重置：${resetLabel}`);
  return lines;
}

/**
 * 每个柱子 = 一个真实窗口（不是日历桶）。柱色表达证据强度：
 * 实时=绿、采样充分=青、重建=琥珀、仅事件=灰 —— 低置信不能画得像实测。
 */
export default function QuotaWindowChart({ windows, windowMinutes, emptyReason }: QuotaWindowChartProps) {
  const [metric, setMetric] = useState<QuotaWindowMetric>('percent');
  const labels = useMemo(() => windows.map((window) => (
    formatQuotaAxisTime(window.anchorAtMs, windowMinutes)
  )), [windows, windowMinutes]);

  const buildOption = useCallback((palette: UsageChartPalette) => {
    const data = windows.map((window) => {
      const value = getWindowMetricValue(window, metric);
      const source = getWindowSourceMeta(window);
      const color = source.tone === 'live'
        ? palette.success
        : source.tone === 'high'
          ? palette.brand
          : source.tone === 'medium'
            ? palette.amber
            : palette.neutral;
      return {
        value: value == null ? null : Number(value),
        itemStyle: { color }
      };
    });

    const isPercent = metric === 'percent';
    const isCost = metric === 'cost';
    return {
      animationDuration: 240,
      animationDurationUpdate: 180,
      aria: { enabled: true, description: '按额度窗口统计的消耗柱状图' },
      grid: { left: 10, right: 16, top: 42, bottom: 8, containLabel: true },
      tooltip: {
        trigger: 'axis',
        ...buildChartTooltipStyle(palette),
        axisPointer: { lineStyle: { color: palette.brand, opacity: 0.6 } },
        formatter: (params: unknown) => {
          const point = Array.isArray(params) ? params[0] : params;
          const index = Number((point as { dataIndex?: number } | null)?.dataIndex);
          const window = windows[index];
          if (!window) return '';
          return buildTooltipLines(window, metric).join('<br/>');
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
        ...(isPercent ? { max: 100 } : {}),
        axisLabel: {
          color: palette.faint,
          fontSize: 11,
          fontFamily: palette.fontMono,
          formatter: isPercent
            ? '{value}%'
            : isCost
              ? (value: number) => formatCost(value)
              : (value: number) => formatTokens(value)
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
  }, [labels, metric, windows]);

  return (
    <div className="usage-chart-shell">
      <div className="usage-chart-heading">
        <div>
          <strong>窗口消耗</strong>
          <span>每个柱子是一个真实窗口（由关闭后的第一个请求锚定）</span>
        </div>
        <Segmented
          size="small"
          value={metric}
          options={QUOTA_METRIC_OPTIONS}
          onChange={(value) => setMetric(value as QuotaWindowMetric)}
        />
      </div>
      {windows.length === 0 ? (
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
        <>
          <EChartCanvas ariaLabel="额度窗口消耗" buildOption={buildOption} />
          <div className="quota-chart-legend" aria-hidden="true">
            <span><i className="quota-legend-dot quota-legend-dot--live" />实时</span>
            <span><i className="quota-legend-dot quota-legend-dot--high" />采样充分</span>
            <span><i className="quota-legend-dot quota-legend-dot--medium" />重建</span>
            <span><i className="quota-legend-dot quota-legend-dot--low" />仅重置事件</span>
          </div>
        </>
      )}
    </div>
  );
}
