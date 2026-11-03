import { useCallback, useMemo, useState } from 'react';
import { Empty, Segmented } from 'antd';

import { providerNames } from '@/components/chat/provider-registry';
import type { ModelUsageModelRow } from '@/types';
import EChartCanvas, { buildChartTooltipStyle, type UsageChartPalette } from './EChartCanvas';
import {
  buildModelMixData,
  formatCost,
  formatModelMixAxisValue,
  formatTokens,
  type ModelMixDatum,
  type ModelMixMetric
} from './model-usage-presentation';

interface UsageModelMixChartProps {
  models: ModelUsageModelRow[];
  onSelectModel: (row: ModelUsageModelRow) => void;
}

interface ModelMixTooltipParam {
  dataIndex?: number;
}

function buildModelMixTooltipFormatter(data: ModelMixDatum[], metric: ModelMixMetric) {
  return (params: unknown) => {
    const entries = Array.isArray(params) ? params : [params];
    return entries
      .map((entry) => {
        const param = entry && typeof entry === 'object' ? entry as ModelMixTooltipParam : {};
        const datum = typeof param.dataIndex === 'number' ? data[param.dataIndex] : undefined;
        if (!datum) return '';
        const provider = datum.provider ? providerNames[datum.provider] || datum.provider : '';
        const title = datum.isOther
          ? datum.label
          : [provider, datum.model].filter(Boolean).join(' · ');
        const value = metric === 'cost' ? formatCost(datum.value) : formatTokens(datum.value);
        return `${title}<br/>${value}`;
      })
      .filter(Boolean)
      .join('<br/>');
  };
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
      axisPointer: { type: 'shadow', shadowStyle: { color: palette.brand, opacity: 0.08 } },
      ...buildChartTooltipStyle(palette),
      // 坐标轴标签用短名，悬停时给出完整的 provider + model ID（含目录前缀）。
      formatter: buildModelMixTooltipFormatter(data, metric)
    },
    xAxis: {
      type: 'value',
      splitNumber: 3,
      axisLabel: {
        color: palette.faint,
        fontSize: 11,
        fontFamily: palette.fontMono,
        hideOverlap: true,
        formatter: (value: number) => formatModelMixAxisValue(value, metric)
      },
      splitLine: { lineStyle: { color: palette.border, type: 'dashed' } }
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
        fontSize: 11,
        fontFamily: palette.fontMono
      }
    },
    series: [{
      name: metric === 'cost' ? '成本' : 'Tokens',
      type: 'bar',
      data: data.map((item) => ({
        value: item.value,
        itemStyle: {
          color: item.isOther ? palette.neutral : metric === 'cost' ? palette.success : palette.brand,
          borderRadius: 0,
          shadowBlur: item.isOther ? 0 : palette.glow,
          shadowColor: metric === 'cost' ? palette.success : palette.brand
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
