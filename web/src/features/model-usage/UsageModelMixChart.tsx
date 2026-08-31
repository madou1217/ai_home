import { useCallback, useMemo, useState } from 'react';
import { Empty, Segmented } from 'antd';

import type { ModelUsageModelRow } from '@/types';
import EChartCanvas, { type UsageChartPalette } from './EChartCanvas';
import {
  buildModelMixData,
  formatCost,
  formatModelMixAxisValue,
  formatTokens,
  type ModelMixMetric
} from './model-usage-presentation';

interface UsageModelMixChartProps {
  models: ModelUsageModelRow[];
  onSelectModel: (row: ModelUsageModelRow) => void;
}

export default function UsageModelMixChart({ models, onSelectModel }: UsageModelMixChartProps) {
  const [metric, setMetric] = useState<ModelMixMetric>('tokens');
  const data = useMemo(() => buildModelMixData(models, metric), [metric, models]);

  const buildOption = useCallback((palette: UsageChartPalette) => ({
    animationDuration: 240,
    animationDurationUpdate: 180,
    aria: { enabled: true, description: '模型用量排名图，可点击具体模型查看账号分量' },
    grid: { left: 8, right: 16, top: 8, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      backgroundColor: palette.heading,
      borderWidth: 0,
      textStyle: { color: '#fff', fontSize: 12 },
      valueFormatter: (value: unknown) => (
        metric === 'cost' ? formatCost(Number(value) || 0) : formatTokens(Number(value) || 0)
      )
    },
    xAxis: {
      type: 'value',
      splitNumber: 3,
      axisLabel: {
        color: palette.muted,
        fontSize: 11,
        hideOverlap: true,
        formatter: (value: number) => formatModelMixAxisValue(value, metric)
      },
      splitLine: { lineStyle: { color: palette.border, opacity: 0.55, type: 'dashed' } }
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: data.map((item) => item.label),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: palette.text,
        width: 148,
        overflow: 'truncate',
        fontSize: 11
      }
    },
    series: [{
      name: metric === 'cost' ? '成本' : 'Tokens',
      type: 'bar',
      data: data.map((item) => ({
        value: item.value,
        itemStyle: {
          color: item.isOther ? 'rgba(148, 163, 184, 0.3)' : metric === 'cost' ? '#10b981' : '#0a59f7',
          borderRadius: [0, 8, 8, 0]
        }
      })),
      barMaxWidth: 18
    }]
  }), [data, metric]);

  const handleDataClick = useCallback((dataIndex: number) => {
    const datum = data[dataIndex];
    if (!datum || datum.isOther) return;
    const row = models.find((item) => item.provider === datum.provider && item.model === datum.model);
    if (row) onSelectModel(row);
  }, [data, models, onSelectModel]);

  return (
    <div className="usage-chart-shell usage-chart-shell--mix">
      <div className="usage-chart-heading">
        <div>
          <strong>模型分量</strong>
          <span>点击条形可查看该模型由哪些账号贡献</span>
        </div>
        <Segmented
          size="small"
          value={metric}
          options={[
            { label: 'Tokens', value: 'tokens' },
            { label: '成本', value: 'cost' }
          ]}
          onChange={(value) => setMetric(value as ModelMixMetric)}
        />
      </div>
      {data.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无模型分量" />
      ) : (
        <EChartCanvas
          ariaLabel="模型用量排名"
          buildOption={buildOption}
          onDataClick={handleDataClick}
        />
      )}
    </div>
  );
}
