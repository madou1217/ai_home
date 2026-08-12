import { Tooltip } from 'antd';
import type { AccountTokenUsage, AccountTokenUsageModel } from '@/types';
import './TokenUsageCell.css';

type TokenUsageValue = number | null;
type TokenUsageDimension = 'day' | 'week' | 'month';

const TOKEN_USAGE_PERIODS: readonly {
  key: TokenUsageDimension;
  label: string;
  hint: string;
}[] = [
  { key: 'day', label: '日', hint: '当天' },
  { key: 'week', label: '周', hint: '本周' },
  { key: 'month', label: '月', hint: '本月' }
];

const TOKEN_CHART_MAX_HEIGHT = 28;
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

function getModelUsageValue(model: AccountTokenUsageModel, dimension: TokenUsageDimension) {
  return toTokenValue(model[dimension]) || 0;
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
      value: getModelUsageValue(model, dimension)
    }))
    .filter(({ value }) => value > 0);
}

function formatModelTooltip(
  dimension: TokenUsageDimension,
  models: AccountTokenUsageModel[],
  total: TokenUsageValue
) {
  const lines = getModelTooltipEntries(dimension, models)
    .map(({ model, value }) => `${model.model} ${formatTokenAmount(value)}`);
  if (lines.length > 0) return lines;
  return models.length > 0 ? ['暂无用量'] : [`总计 ${formatTokenAmount(total)}`];
}

function allocateSegmentHeights(
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

  const rawHeights = used.map(({ value }) => (value / total) * height);
  const heights = rawHeights.map((rawHeight) => Math.floor(rawHeight));
  let remaining = height - heights.reduce((sum, segmentHeight) => sum + segmentHeight, 0);
  const order = rawHeights
    .map((rawHeight, index) => ({ index, fraction: rawHeight - heights[index] }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (let index = 0; index < order.length && remaining > 0; index += 1, remaining -= 1) {
    heights[order[index].index] += 1;
  }

  return used.map((entry, index) => ({
    ...entry,
    height: heights[index]
  }));
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
          <line className="token-usage-baseline" x1="8" y1="33" x2="148" y2="33" />
          {metrics.map(({ key, value }, index) => {
            const height = getBarHeight(value, maximum);
            const x = 19 + index * 52;
            const isPeak = value !== null && value === maximum && maximum > 0;
            const dimension = key;
            const tooltipLines = formatModelTooltip(dimension, usedModels, value);
            const segments = allocateSegmentHeights(usedModels, dimension, value || 0, height);
            let segmentOffset = 0;

            return (
              <g key={key} className="token-usage-bar-group">
                {segments.length > 0 ? segments.map(({ model, index: modelIndex, height: segmentHeight }, segmentIndex) => {
                  const segmentY = 33 - segmentOffset - segmentHeight;
                  segmentOffset += segmentHeight;
                  return (
                    <rect
                      key={model.model}
                      className="token-usage-bar"
                      x={x}
                      y={segmentY}
                      width="14"
                      height={segmentHeight}
                      rx={segmentIndex === segments.length - 1 ? 5 : 0}
                      fill={getModelColor(modelIndex)}
                    />
                  );
                }) : (
                  <rect
                    className={[
                      'token-usage-bar',
                      isPeak ? 'token-usage-bar--peak' : '',
                      value === null ? 'token-usage-bar--unknown' : '',
                      value === 0 ? 'token-usage-bar--zero' : ''
                    ].filter(Boolean).join(' ')}
                    x={x}
                    y={33 - height}
                    width="14"
                    height={height}
                    rx="5"
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
              title={(
                <div className="token-usage-tooltip">
                  {getModelTooltipEntries(key, usedModels).length > 0 ? (
                    getModelTooltipEntries(key, usedModels).map(({ model, modelIndex, value: modelValue }) => (
                      <div key={model.model} className="token-usage-tooltip-row">
                        <span
                          className="token-usage-tooltip-dot"
                          style={{ background: getModelColor(modelIndex) }}
                          aria-hidden="true"
                        />
                        <span>{model.model} {formatTokenAmount(modelValue)}</span>
                      </div>
                    ))
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
