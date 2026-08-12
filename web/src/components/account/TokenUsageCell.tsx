import { Tooltip } from 'antd';
import type { AccountTokenUsage } from '@/types';
import './TokenUsageCell.css';

type TokenUsagePeriod = keyof AccountTokenUsage;
type TokenUsageValue = number | null;

const TOKEN_USAGE_PERIODS: readonly {
  key: TokenUsagePeriod;
  label: string;
  hint: string;
}[] = [
  { key: 'day', label: '日', hint: '当天' },
  { key: 'week', label: '周', hint: '本周' },
  { key: 'month', label: '月', hint: '本月' }
];

const TOKEN_NUMBER_FORMATTER = new Intl.NumberFormat('zh-CN');
const TOKEN_CHART_MAX_HEIGHT = 28;

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

function formatExactTokenAmount(value: TokenUsageValue) {
  if (value === null) return '暂无数据';
  return `${TOKEN_NUMBER_FORMATTER.format(Math.round(value))} tokens`;
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
  const accessibleSummary = metrics
    .map(({ label, value }) => `${label} ${formatExactTokenAmount(value)}`)
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
            const barClassName = [
              'token-usage-bar',
              isPeak ? 'token-usage-bar--peak' : '',
              value === null ? 'token-usage-bar--unknown' : '',
              value === 0 ? 'token-usage-bar--zero' : ''
            ].filter(Boolean).join(' ');

            return (
              <g key={key} className="token-usage-bar-group">
                <rect
                  className={barClassName}
                  x={x}
                  y={33 - height}
                  width="14"
                  height={height}
                  rx="5"
                >
                  <title>{`${TOKEN_USAGE_PERIODS[index].hint}用量：${formatExactTokenAmount(value)}`}</title>
                </rect>
              </g>
            );
          })}
        </svg>
        <div className="token-usage-chart-hit-targets">
          {metrics.map(({ key, hint, value }) => (
            <Tooltip key={key} title={`${hint}用量：${formatExactTokenAmount(value)}`}>
              <button
                type="button"
                className="token-usage-chart-hit-target"
                aria-label={`${hint}用量：${formatExactTokenAmount(value)}`}
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
