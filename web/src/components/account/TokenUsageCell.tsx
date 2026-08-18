import type { CSSProperties } from 'react';
import { useMemo } from 'react';
import { Tooltip } from 'antd';
import type { AccountTokenUsage, AccountTokenUsageModel } from '@/types';
import {
  TOKEN_CHART_BAR_OFFSET,
  TOKEN_CHART_BAR_WIDTH,
  TOKEN_CHART_BASELINE,
  TOKEN_CHART_EDGE,
  TOKEN_CHART_MAX_HEIGHT,
  TOKEN_CHART_SLOT_WIDTH,
  buildTokenUsageMetrics,
  getModelCostValue,
  getModelUsageValue,
  getUsedModels
} from './token-usage-periods';
import type {
  TokenUsageDimension,
  TokenUsageMetric,
  TokenUsageValue
} from './token-usage-periods';
import { useTokenUsageTransitions } from './useTokenUsageTransitions';
import './TokenUsageCell.css';

const TOKEN_MODEL_COLOR_TOKENS = [
  'var(--c-info-600)',
  'var(--c-teal-500)',
  'var(--c-purple-600)',
  'var(--c-warning-600)',
  'var(--c-danger-500)',
  'var(--c-success-600)',
  'var(--c-grok)',
  'var(--c-claude)'
];

// 与 CSS 里的吸附/脱离动画时长保持一致：动画放完才真正把 ghost 丢掉。
const TOKEN_USAGE_TRANSITION_MS = 420;

function formatTokenUnit(value: number) {
  if (value >= 100) return String(Math.round(value));
  if (value >= 10) return value.toFixed(1).replace(/\.0$/, '');
  return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function formatTokenAmount(value: TokenUsageValue) {
  if (value === null) return '-';
  if (value >= 999_500_000) return `${formatTokenUnit(value / 1_000_000_000)}B`;
  if (value >= 999_500) return `${formatTokenUnit(value / 1_000_000)}M`;
  if (value >= 1_000) return `${formatTokenUnit(value / 1_000)}K`;
  return String(Math.round(value));
}

function formatCostUsd(value: TokenUsageValue) {
  if (value === null) return '-';
  if (value === 0) return '$0';
  if (value < 0.000001) return `$${value.toExponential(2)}`;
  const minimumFractionDigits = value >= 0.01 ? 2 : 0;
  const maximumFractionDigits = value >= 100
    ? 2
    : value >= 1
      ? 3
      : value >= 0.01
        ? 4
        : 6;
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits,
    maximumFractionDigits
  })}`;
}

function getModelColor(modelIndex: number) {
  return TOKEN_MODEL_COLOR_TOKENS[modelIndex % TOKEN_MODEL_COLOR_TOKENS.length];
}

function getModelTooltipEntries(dimension: TokenUsageDimension, models: AccountTokenUsageModel[]) {
  return models
    .map((model, modelIndex) => ({
      model,
      modelIndex,
      value: getModelUsageValue(model, dimension),
      costUsd: getModelCostValue(model, dimension)
    }))
    .filter(({ value }) => value > 0);
}

// 被藏起来的窗口不能凭空消失：说清楚它们是"和这格同一个数"还是"根本没有量"。
function formatWindowNotes(metric: TokenUsageMetric) {
  const notes: string[] = [];
  if (metric.idle.length > 0) {
    notes.push(`${metric.idle.map(({ label }) => label).join('、')}无用量`);
  }
  if (metric.absorbed.length > 0) {
    notes.push(`${metric.absorbed.map(({ label }) => label).join('、')}与${metric.label}相同`);
  }
  return notes;
}

function formatModelTooltip(
  metric: TokenUsageMetric,
  models: AccountTokenUsageModel[]
) {
  const lines = getModelTooltipEntries(metric.key, models)
    .map(({ model, value, costUsd }) => (
      `${model.model} ${formatTokenAmount(value)} ${formatCostUsd(costUsd)}`
    ));
  if (lines.length === 0) {
    lines.push(models.length > 0 ? '暂无用量' : `总计 ${formatTokenAmount(metric.value)}`);
  }
  return [...lines, ...formatWindowNotes(metric)];
}

function allocateLayerHeights(
  models: AccountTokenUsageModel[],
  dimension: TokenUsageDimension,
  total: number,
  height: number
) {
  const used = models
    .map((model, index) => ({
      model,
      index,
      value: getModelUsageValue(model, dimension)
    }))
    .filter(({ value }) => value > 0);
  if (used.length === 0 || total <= 0 || height <= 0) return [];

  // 所有层都贴同一条基线，小用量层最后绘制，形成二维前后叠放而不是上下拼接。
  const ordered = [...used].sort((left, right) => right.value - left.value || left.index - right.index);
  const largestValue = ordered[0]?.value || 0;
  const minimumHeight = Math.min(5, height);

  return ordered.map((entry, layerIndex) => ({
    ...entry,
    height: Math.max(
      minimumHeight,
      layerIndex === 0 ? height : Math.round((entry.value / largestValue) * height)
    )
  }));
}

function getBarPath(x: number, y: number, width: number, height: number) {
  const radius = Math.min(3.5, height / 2, width / 2);
  const right = x + width;

  // 底部保持水平且无间隙，保证每一层都从统一基线起步。
  return [
    `M ${x} ${TOKEN_CHART_BASELINE}`,
    `L ${x} ${y + radius}`,
    `Q ${x} ${y} ${x + radius} ${y}`,
    `L ${right - radius} ${y}`,
    `Q ${right} ${y} ${right} ${y + radius}`,
    `L ${right} ${TOKEN_CHART_BASELINE}`,
    'Z'
  ].join(' ');
}

function getBarHeight(value: TokenUsageValue, maximum: number) {
  if (value === null || value <= 0 || maximum <= 0) return 2;

  // 对数高度只负责表达量级，精确值仍由文字和 Tooltip 负责。
  const normalized = Math.log1p(value) / Math.log1p(maximum);
  return Math.max(6, Math.round(normalized * TOKEN_CHART_MAX_HEIGHT));
}

function TokenUsageBar({
  dimension,
  value,
  index,
  maximum,
  models,
  className,
  style
}: {
  dimension: TokenUsageDimension;
  value: TokenUsageValue;
  index: number;
  maximum: number;
  models: AccountTokenUsageModel[];
  className: string;
  style?: CSSProperties;
}) {
  const height = getBarHeight(value, maximum);
  const x = TOKEN_CHART_BAR_OFFSET + index * TOKEN_CHART_SLOT_WIDTH;
  const isPeak = value !== null && value === maximum && maximum > 0;
  const layers = allocateLayerHeights(models, dimension, value || 0, height);

  return (
    <g className={className} style={style}>
      {layers.length > 0 ? layers.map(({ model, index: modelIndex, height: layerHeight }, layerIndex) => (
        <path
          key={`${model.model}-${modelIndex}`}
          className={[
            'token-usage-bar',
            'token-usage-bar--layer',
            layerIndex === 0 ? 'token-usage-bar--layer-back' : '',
            layerIndex > 0 && layerIndex < layers.length - 1 ? 'token-usage-bar--layer-middle' : '',
            layerIndex === layers.length - 1 ? 'token-usage-bar--layer-front' : ''
          ].filter(Boolean).join(' ')}
          d={getBarPath(x, TOKEN_CHART_BASELINE - layerHeight, TOKEN_CHART_BAR_WIDTH, layerHeight)}
          fill={getModelColor(modelIndex)}
        />
      )) : (
        <path
          className={[
            'token-usage-bar',
            isPeak ? 'token-usage-bar--peak' : '',
            value === null ? 'token-usage-bar--unknown' : '',
            value === 0 ? 'token-usage-bar--zero' : ''
          ].filter(Boolean).join(' ')}
          d={getBarPath(x, TOKEN_CHART_BASELINE - height, TOKEN_CHART_BAR_WIDTH, height)}
          fill={value === null ? undefined : 'var(--color-info)'}
        />
      )}
    </g>
  );
}

// 入场（脱离）和滑位互斥：刚出现的格子没有旧槽位可滑。
function buildTransitionClassName(
  base: string,
  key: TokenUsageDimension,
  entering: ReadonlySet<TokenUsageDimension>,
  shifts: ReadonlyMap<TokenUsageDimension, number>
) {
  if (entering.has(key)) return `${base} ${base}--detaching`;
  if (shifts.has(key)) return `${base} ${base}--sliding`;
  return base;
}

function buildTransitionStyle(
  key: TokenUsageDimension,
  index: number,
  entering: ReadonlySet<TokenUsageDimension>,
  shifts: ReadonlyMap<TokenUsageDimension, number>
): CSSProperties | undefined {
  if (entering.has(key)) {
    // 新格子从"它原先藏身的那一格"里吐出来：排在最前面的（日重新有量了）来自右边更宽的
    // 窗口，其余的（周/月/总重新拉开差距）来自左边更窄的窗口。
    return { '--token-usage-detach-dir': index === 0 ? 1 : -1 } as CSSProperties;
  }
  const shift = shifts.get(key);
  return shift === undefined ? undefined : ({ '--token-usage-shift': shift } as CSSProperties);
}

function TokenUsageChart({ usage }: { usage: AccountTokenUsage }) {
  const metrics = useMemo(() => buildTokenUsageMetrics(usage), [usage]);
  const { entering, ghosts, shifts } = useTokenUsageTransitions(metrics, TOKEN_USAGE_TRANSITION_MS);
  const usedModels = useMemo(() => getUsedModels(usage), [usage]);

  const validValues = metrics.flatMap(({ value }) => (value === null ? [] : [value]));
  const maximum = Math.max(0, ...validValues);
  const chartWidth = metrics.length * TOKEN_CHART_SLOT_WIDTH;
  const accessibleSummary = metrics
    .map((metric) => `${metric.label} ${formatModelTooltip(metric, usedModels).join('，')}`)
    .join('，');

  return (
    <div
      className="token-usage-cell"
      role="group"
      style={{ '--token-usage-columns': metrics.length } as CSSProperties}
      aria-label={`Token 用量（${metrics.map(({ label }) => label).join('、')}）：${accessibleSummary}`}
    >
      <div className="token-usage-chart">
        <svg
          className="token-usage-chart-svg"
          viewBox={`0 0 ${chartWidth} 38`}
          role="presentation"
          focusable="false"
        >
          <line
            className="token-usage-baseline"
            x1={TOKEN_CHART_EDGE}
            y1={TOKEN_CHART_BASELINE}
            x2={chartWidth - TOKEN_CHART_EDGE}
            y2={TOKEN_CHART_BASELINE}
          />
          {metrics.map((metric, index) => (
            <g key={metric.key} className="token-usage-bar-slot">
              <TokenUsageBar
                dimension={metric.key}
                value={metric.value}
                index={index}
                maximum={maximum}
                models={usedModels}
                className={buildTransitionClassName('token-usage-bar-group', metric.key, entering, shifts)}
                style={buildTransitionStyle(metric.key, index, entering, shifts)}
              />
              <title>{formatModelTooltip(metric, usedModels).join('\n')}</title>
            </g>
          ))}
          {ghosts.map((ghost) => (
            <TokenUsageBar
              key={`ghost-${ghost.key}`}
              dimension={ghost.key}
              value={ghost.value}
              index={ghost.index}
              maximum={maximum}
              models={usedModels}
              className="token-usage-bar-group token-usage-bar-group--snapping"
            />
          ))}
        </svg>
        <div className="token-usage-chart-hit-targets">
          {metrics.map((metric) => (
            <Tooltip
              key={metric.key}
              overlayClassName="token-usage-tooltip-overlay"
              title={(
                <div className="token-usage-tooltip">
                  {getModelTooltipEntries(metric.key, usedModels).length > 0 ? (
                    <>
                      <div className="token-usage-tooltip-row token-usage-tooltip-header" aria-hidden="true">
                        <span>模型</span>
                        <span>用量</span>
                        <span>费用</span>
                      </div>
                      {getModelTooltipEntries(metric.key, usedModels).map(({
                        model,
                        modelIndex,
                        value: modelValue,
                        costUsd
                      }) => (
                        <div key={model.model} className="token-usage-tooltip-row">
                          <span className="token-usage-tooltip-model">
                            <span
                              className="token-usage-tooltip-dot"
                              style={{ background: getModelColor(modelIndex) }}
                              aria-hidden="true"
                            />
                            <span title={model.model}>{model.model}</span>
                          </span>
                          <span className="token-usage-tooltip-number">{formatTokenAmount(modelValue)}</span>
                          <span className="token-usage-tooltip-number">{formatCostUsd(costUsd)}</span>
                        </div>
                      ))}
                    </>
                  ) : <div>{formatModelTooltip(metric, usedModels)[0]}</div>}
                  {formatWindowNotes(metric).map((note) => (
                    <div key={note} className="token-usage-tooltip-note">{note}</div>
                  ))}
                </div>
              )}
            >
              <button
                type="button"
                className="token-usage-chart-hit-target"
                aria-label={`${metric.hint}用量：${formatModelTooltip(metric, usedModels).join('，')}`}
              />
            </Tooltip>
          ))}
        </div>
      </div>
      <div className="token-usage-values" aria-hidden="true">
        {metrics.map((metric, index) => (
          <span
            key={metric.key}
            className={[
              buildTransitionClassName('token-usage-value', metric.key, entering, shifts),
              metric.value !== null && metric.value === maximum && maximum > 0
                ? 'token-usage-value--peak'
                : ''
            ].filter(Boolean).join(' ')}
            style={buildTransitionStyle(metric.key, index, entering, shifts)}
          >
            {formatTokenAmount(metric.value)}
          </span>
        ))}
      </div>
      <div className="token-usage-labels" aria-hidden="true">
        {metrics.map((metric, index) => (
          <span
            key={metric.key}
            className={buildTransitionClassName('token-usage-label', metric.key, entering, shifts)}
            style={buildTransitionStyle(metric.key, index, entering, shifts)}
          >
            {metric.label}
          </span>
        ))}
      </div>
      {ghosts.map((ghost) => (
        // 文字层脱离栅格单独定位，才能在单元格已经收窄之后继续把旧数字吸回前一格。
        <div
          key={`ghost-text-${ghost.key}`}
          className="token-usage-ghost"
          style={{ '--token-usage-ghost-index': ghost.index } as CSSProperties}
          aria-hidden="true"
        >
          <span className="token-usage-value">{formatTokenAmount(ghost.value)}</span>
          <span className="token-usage-label">{ghost.label}</span>
        </div>
      ))}
    </div>
  );
}

export default function TokenUsageCell({ usage }: { usage?: AccountTokenUsage | null }) {
  if (!usage) {
    return <span className="token-usage-cell token-usage-cell--empty">暂无统计</span>;
  }
  return <TokenUsageChart usage={usage} />;
}
