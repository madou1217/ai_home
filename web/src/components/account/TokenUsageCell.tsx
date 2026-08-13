import { Tooltip } from 'antd';
import type { AccountTokenUsage, AccountTokenUsageModel } from '@/types';
import './TokenUsageCell.css';

type TokenUsageValue = number | null;
type TokenUsageDimension = 'day' | 'week' | 'month';
type TokenUsageCostKey = 'dayCostUsd' | 'weekCostUsd' | 'monthCostUsd';

const TOKEN_USAGE_PERIODS: readonly {
  key: TokenUsageDimension;
  label: string;
  hint: string;
}[] = [
  { key: 'day', label: '日', hint: '当天' },
  { key: 'week', label: '周', hint: '本周' },
  { key: 'month', label: '月', hint: '本月' }
];

const TOKEN_CHART_BASELINE = 33;
const TOKEN_CHART_MAX_HEIGHT = 28;
const TOKEN_CHART_BAR_WIDTH = 14;
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
const TOKEN_USAGE_COST_KEYS: Record<TokenUsageDimension, TokenUsageCostKey> = {
  day: 'dayCostUsd',
  week: 'weekCostUsd',
  month: 'monthCostUsd'
};

function toTokenValue(value: unknown): TokenUsageValue {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

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

function getModelUsageValue(model: AccountTokenUsageModel, dimension: TokenUsageDimension) {
  return toTokenValue(model[dimension]) || 0;
}

function getModelCostValue(model: AccountTokenUsageModel, dimension: TokenUsageDimension) {
  return toTokenValue(model[TOKEN_USAGE_COST_KEYS[dimension]]);
}

function getModelColor(modelIndex: number) {
  return TOKEN_MODEL_COLOR_TOKENS[modelIndex % TOKEN_MODEL_COLOR_TOKENS.length];
}

function getUsedModels(usage: AccountTokenUsage) {
  const models = Array.isArray(usage.models) ? usage.models : [];
  return models
    .filter((model) => TOKEN_USAGE_PERIODS.some(({ key }) => getModelUsageValue(model, key) > 0));
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

function formatModelTooltip(
  dimension: TokenUsageDimension,
  models: AccountTokenUsageModel[],
  total: TokenUsageValue
) {
  const lines = getModelTooltipEntries(dimension, models)
    .map(({ model, value, costUsd }) => (
      `${model.model} ${formatTokenAmount(value)} ${formatCostUsd(costUsd)}`
    ));
  if (lines.length > 0) return lines;
  return models.length > 0 ? ['暂无用量'] : [`总计 ${formatTokenAmount(total)}`];
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

export default function TokenUsageCell({ usage }: { usage?: AccountTokenUsage | null }) {
  if (!usage) {
    return <span className="token-usage-cell token-usage-cell--empty">暂无统计</span>;
  }

  const metrics = TOKEN_USAGE_PERIODS.map((period) => ({
    ...period,
    value: toTokenValue(usage[period.key])
  }));
  const validValues = metrics.flatMap(({ value }) => (value === null ? [] : [value]));
  const maximum = Math.max(0, ...validValues);
  const usedModels = getUsedModels(usage);
  const accessibleSummary = metrics
    .map(({ key, label, value }) => `${label} ${formatModelTooltip(key, usedModels, value).join('，')}`)
    .join('，');

  return (
    <div
      className="token-usage-cell"
      role="group"
      aria-label={`Token 用量（日、周、月）：${accessibleSummary}`}
    >
      <div className="token-usage-chart">
        <svg
          className="token-usage-chart-svg"
          viewBox="0 0 156 38"
          role="presentation"
          focusable="false"
        >
          <line
            className="token-usage-baseline"
            x1="8"
            y1={TOKEN_CHART_BASELINE}
            x2="148"
            y2={TOKEN_CHART_BASELINE}
          />
          {metrics.map(({ key, value }, index) => {
            const height = getBarHeight(value, maximum);
            const x = 19 + index * 52;
            const isPeak = value !== null && value === maximum && maximum > 0;
            const dimension = key;
            const tooltipLines = formatModelTooltip(dimension, usedModels, value);
            const layers = allocateLayerHeights(usedModels, dimension, value || 0, height);

            return (
              <g key={key} className="token-usage-bar-group">
                {layers.length > 0 ? layers.map(({ model, index: modelIndex, height: layerHeight }, layerIndex) => {
                  const layerY = TOKEN_CHART_BASELINE - layerHeight;
                  return (
                    <path
                      key={`${model.model}-${modelIndex}`}
                      className={[
                        'token-usage-bar',
                        'token-usage-bar--layer',
                        layerIndex === 0 ? 'token-usage-bar--layer-back' : '',
                        layerIndex > 0 && layerIndex < layers.length - 1 ? 'token-usage-bar--layer-middle' : '',
                        layerIndex === layers.length - 1 ? 'token-usage-bar--layer-front' : ''
                      ].filter(Boolean).join(' ')}
                      d={getBarPath(x, layerY, TOKEN_CHART_BAR_WIDTH, layerHeight)}
                      fill={getModelColor(modelIndex)}
                    />
                  );
                }) : (
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
                <title>{tooltipLines.join('\n')}</title>
              </g>
            );
          })}
        </svg>
        <div className="token-usage-chart-hit-targets">
          {metrics.map(({ key, hint, value }) => (
            <Tooltip
              key={key}
              overlayClassName="token-usage-tooltip-overlay"
              title={(
                <div className="token-usage-tooltip">
                  {getModelTooltipEntries(key, usedModels).length > 0 ? (
                    <>
                      <div className="token-usage-tooltip-row token-usage-tooltip-header" aria-hidden="true">
                        <span>模型</span>
                        <span>用量</span>
                        <span>费用</span>
                      </div>
                      {getModelTooltipEntries(key, usedModels).map(({
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
                  ) : <div>{formatModelTooltip(key, usedModels, value)[0]}</div>}
                </div>
              )}
            >
              <button
                type="button"
                className="token-usage-chart-hit-target"
                aria-label={`${hint}用量：${formatModelTooltip(key, usedModels, value).join('，')}`}
              />
            </Tooltip>
          ))}
        </div>
      </div>
      <div className="token-usage-values" aria-hidden="true">
        {metrics.map(({ key, value }) => (
          <span
            key={key}
            className={value !== null && value === maximum && maximum > 0
              ? 'token-usage-value token-usage-value--peak'
              : 'token-usage-value'}
          >
            {formatTokenAmount(value)}
          </span>
        ))}
      </div>
      <div className="token-usage-labels" aria-hidden="true">
        {metrics.map(({ key, label }) => <span key={key}>{label}</span>)}
      </div>
    </div>
  );
}
