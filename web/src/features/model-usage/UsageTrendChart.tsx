import { useCallback, useMemo, useState } from 'react';
import { Empty, Segmented } from 'antd';
import dayjs from 'dayjs';

import type { ModelUsageTrend, ModelUsageTrendPoint } from '@/types';
import EChartCanvas, { buildChartTooltipStyle, type UsageChartPalette } from './EChartCanvas';
import { formatCost, formatTokens } from './model-usage-presentation';

type TrendMode = 'tokens' | 'cost' | 'cache';

interface UsageTrendChartProps {
  trend: ModelUsageTrend;
}

function buildSlots(trend: ModelUsageTrend) {
  if (!trend.bucketMs || trend.toMs < trend.fromMs) return [];
  const points = new Map(trend.points.map((point) => [point.bucketStartMs, point]));
  const slots: Array<ModelUsageTrendPoint | null> = [];
  for (let timestamp = trend.fromMs; timestamp <= trend.toMs; timestamp += trend.bucketMs) {
    slots.push(points.get(timestamp) || null);
    if (slots.length >= 120) break;
  }
  return slots;
}

function formatAxisTime(timestamp: number, bucketMs: number) {
  if (bucketMs < 24 * 60 * 60 * 1000) return dayjs(timestamp).format('MM-DD HH:mm');
  return dayjs(timestamp).format('MM-DD');
}

function createBaseOption(
  palette: UsageChartPalette,
  labels: string[],
  ariaDescription: string
) {
  return {
    animationDuration: 240,
    animationDurationUpdate: 180,
    aria: { enabled: true, description: ariaDescription },
    grid: { left: 10, right: 16, top: 42, bottom: 8, containLabel: true },
    legend: {
      top: 0,
      left: 0,
      itemWidth: 12,
      itemHeight: 6,
      textStyle: { color: palette.muted, fontSize: 11, fontFamily: palette.fontMono }
    },
    tooltip: {
      trigger: 'axis',
      ...buildChartTooltipStyle(palette),
      axisPointer: { lineStyle: { color: palette.brand, opacity: 0.6 } }
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: labels,
      axisLine: { lineStyle: { color: palette.border } },
      axisTick: { show: false },
      axisLabel: { color: palette.faint, hideOverlap: true, fontSize: 11, fontFamily: palette.fontMono }
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: palette.faint, fontSize: 11, fontFamily: palette.fontMono },
      splitLine: { lineStyle: { color: palette.border, type: 'dashed' } }
    }
  };
}

export default function UsageTrendChart({ trend }: UsageTrendChartProps) {
  const [mode, setMode] = useState<TrendMode>('tokens');
  const slots = useMemo(() => buildSlots(trend), [trend]);
  const labels = useMemo(() => slots.map((point, index) => (
    formatAxisTime(point?.bucketStartMs || trend.fromMs + index * trend.bucketMs, trend.bucketMs)
  )), [slots, trend.bucketMs, trend.fromMs]);

  const buildOption = useCallback((palette: UsageChartPalette) => {
    const base = createBaseOption(palette, labels, '模型用量随时间变化图');
    if (mode === 'cost') {
      return {
        ...base,
        tooltip: { ...base.tooltip, valueFormatter: (value: unknown) => formatCost(Number(value) || 0) },
        yAxis: { ...base.yAxis, axisLabel: { ...base.yAxis.axisLabel, formatter: (value: number) => formatCost(value) } },
        series: [{
          name: '估算成本',
          type: 'line',
          data: slots.map((point) => point?.costUsd ?? null),
          showSymbol: false,
          smooth: 0.18,
          lineStyle: { width: 2.2, color: palette.success, shadowBlur: palette.glow, shadowColor: palette.success },
          areaStyle: { color: palette.success, opacity: 0.14 },
          connectNulls: false
        }]
      };
    }
    if (mode === 'cache') {
      return {
        ...base,
        tooltip: { ...base.tooltip, valueFormatter: (value: unknown) => `${Number(value || 0).toFixed(1)}%` },
        yAxis: {
          ...base.yAxis,
          min: 0,
          max: 100,
          axisLabel: { ...base.yAxis.axisLabel, formatter: '{value}%' }
        },
        series: [{
          name: '缓存命中率',
          type: 'line',
          data: slots.map((point) => point?.cacheHitRate == null ? null : point.cacheHitRate * 100),
          showSymbol: false,
          smooth: 0.18,
          lineStyle: { width: 2.4, color: palette.amber, shadowBlur: palette.glow, shadowColor: palette.amber },
          areaStyle: { color: palette.amber, opacity: 0.12 },
          connectNulls: false
        }]
      };
    }
    // HUD 系列色全部来自语义 token：青（输入）/ 绿（缓存读取）/ 琥珀（缓存写入）/ 玫红（输出）/ 思考紫（推理）
    const tokenSeries = [
      ['输入', 'inputTokens', palette.brand],
      ['缓存读取', 'cacheReadInputTokens', palette.success],
      ['缓存写入', 'cacheCreationInputTokens', palette.amber],
      ['输出', 'outputTokens', palette.danger],
      ['推理', 'reasoningOutputTokens', palette.violet]
    ] as const;
    return {
      ...base,
      tooltip: { ...base.tooltip, valueFormatter: (value: unknown) => formatTokens(Number(value) || 0) },
      yAxis: { ...base.yAxis, axisLabel: { ...base.yAxis.axisLabel, formatter: (value: number) => formatTokens(value) } },
      series: tokenSeries.map(([name, field, color]) => ({
        name,
        type: 'line',
        stack: 'tokens',
        data: slots.map((point) => point?.[field] ?? null),
        showSymbol: false,
        smooth: 0.16,
        lineStyle: { width: 1.6, color, shadowBlur: palette.glow, shadowColor: color },
        areaStyle: { color, opacity: 0.12 },
        connectNulls: false
      }))
    };
  }, [labels, mode, slots]);

  return (
    <div className="usage-chart-shell">
      <div className="usage-chart-heading">
        <div>
          <strong>时间趋势</strong>
          <span>同一时间轴切换 Tokens、成本与缓存率</span>
        </div>
        <Segmented
          size="small"
          value={mode}
          options={[
            { label: 'Tokens', value: 'tokens' },
            { label: '成本', value: 'cost' },
            { label: '缓存率', value: 'cache' }
          ]}
          onChange={(value) => setMode(value as TrendMode)}
        />
      </div>
      {slots.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无趋势数据" />
      ) : (
        <EChartCanvas ariaLabel="模型用量时间趋势" buildOption={buildOption} />
      )}
    </div>
  );
}
