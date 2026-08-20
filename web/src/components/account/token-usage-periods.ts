import type { AccountTokenUsage, AccountTokenUsageModel } from '@/types';

export type TokenUsageValue = number | null;
export type TokenUsageDimension = 'day' | 'week' | 'month' | 'total';
export type TokenUsageCostKey = 'dayCostUsd' | 'weekCostUsd' | 'monthCostUsd' | 'totalCostUsd';

export interface TokenUsagePeriod {
  key: TokenUsageDimension;
  label: string;
  hint: string;
}

export interface TokenUsageMetric extends TokenUsagePeriod {
  value: TokenUsageValue;
  /** 被这根柱子吸收掉的更宽窗口（数值与它完全相同），Tooltip 用来说明"到此为止"。 */
  absorbed: TokenUsagePeriod[];
  /** 因为完全没有用量而被藏掉的更窄窗口（例如今天还没跑过）。 */
  idle: TokenUsagePeriod[];
}

// 顺序必须是「由窄到宽」：折叠规则依赖后一项是前一项的超集。
export const TOKEN_USAGE_PERIODS: readonly TokenUsagePeriod[] = [
  { key: 'day', label: '日', hint: '当天' },
  { key: 'week', label: '周', hint: '本周' },
  { key: 'month', label: '月', hint: '本月' },
  { key: 'total', label: '总', hint: '累计' }
];

export const TOKEN_USAGE_COST_KEYS: Record<TokenUsageDimension, TokenUsageCostKey> = {
  day: 'dayCostUsd',
  week: 'weekCostUsd',
  month: 'monthCostUsd',
  total: 'totalCostUsd'
};

// 图表几何由周期数量推导，增减维度不用改坐标。
export const TOKEN_CHART_BASELINE = 33;
export const TOKEN_CHART_MAX_HEIGHT = 28;
export const TOKEN_CHART_BAR_WIDTH = 14;
export const TOKEN_CHART_SLOT_WIDTH = 52;
export const TOKEN_CHART_EDGE = 8;
export const TOKEN_CHART_BAR_OFFSET = (TOKEN_CHART_SLOT_WIDTH - TOKEN_CHART_BAR_WIDTH) / 2;

export function toTokenValue(value: unknown): TokenUsageValue {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function getModelUsageValue(model: AccountTokenUsageModel, dimension: TokenUsageDimension) {
  return toTokenValue(model[dimension]) || 0;
}

export function getModelCostValue(model: AccountTokenUsageModel, dimension: TokenUsageDimension) {
  return toTokenValue(model[TOKEN_USAGE_COST_KEYS[dimension]]);
}

/**
 * 累计窗口天然单调不减：月 === 总 只意味着"这个月之前没有记录"，多画一根等高柱子
 * 只是重复信息。所以从窄到宽扫一遍，任何一格与前一格数值相同就折进前一格（保留更窄的
 * 那个标签：总并进月、周并进日），留下的都是"确实比上一格多出了东西"的窗口。
 * 折叠不限于尾部——日 === 周但月更大时，中间那格同样是重复信息。
 * 数值未知（null）时不折叠：那是"没统计到"，不是"没有增量"，两者不能混为一谈。
 */
export function collapseTokenUsageMetrics(metrics: TokenUsageMetric[]): TokenUsageMetric[] {
  const collapsed: TokenUsageMetric[] = [];
  metrics.forEach((metric) => {
    const previous = collapsed[collapsed.length - 1];
    const isRedundant = previous
      && previous.value !== null
      && metric.value !== null
      && previous.value === metric.value;
    if (isRedundant) {
      previous.absorbed = [
        ...previous.absorbed,
        { key: metric.key, label: metric.label, hint: metric.hint },
        ...metric.absorbed
      ];
      return;
    }
    collapsed.push({ ...metric, absorbed: [...metric.absorbed], idle: [...metric.idle] });
  });
  return collapsed;
}

/**
 * 开头的空窗口不占位：今天还没跑过时，"日 0"只是一根贴地的柱子，
 * 真正有信息的是它右边那几格。所以只要还有别的窗口有量，就把开头的 0 藏掉，
 * 让最窄的"确实有量"的窗口顶到最前面。全都是 0 时保留一格，否则整格没有东西可看。
 */
export function dropIdleLeadingMetrics(metrics: TokenUsageMetric[]): TokenUsageMetric[] {
  if (metrics.length <= 1) return metrics;
  if (!metrics.some((metric) => (metric.value || 0) > 0)) return metrics;

  const kept = [...metrics];
  const idle: TokenUsagePeriod[] = [];
  while (kept.length > 1 && kept[0].value === 0) {
    const dropped = kept.shift() as TokenUsageMetric;
    idle.push({ key: dropped.key, label: dropped.label, hint: dropped.hint }, ...dropped.absorbed);
  }
  if (idle.length === 0) return metrics;

  kept[0] = { ...kept[0], idle: [...idle, ...kept[0].idle] };
  return kept;
}

export function buildTokenUsageMetrics(usage: AccountTokenUsage): TokenUsageMetric[] {
  return dropIdleLeadingMetrics(collapseTokenUsageMetrics(TOKEN_USAGE_PERIODS.map((period) => ({
    ...period,
    value: toTokenValue(usage[period.key]),
    absorbed: [],
    idle: []
  }))));
}

export function getUsedModels(usage: AccountTokenUsage) {
  const models = Array.isArray(usage.models) ? usage.models : [];
  return models.filter(
    (model) => TOKEN_USAGE_PERIODS.some(({ key }) => getModelUsageValue(model, key) > 0)
  );
}

/**
 * Token 柱的唯一高度算法。图表与柱顶效果必须共享它，否则对数缩放后视觉锚点会漂移。
 */
export function getTokenUsageBarHeight(value: TokenUsageValue, maximum: number) {
  if (value === null || value <= 0 || maximum <= 0) return 2;

  // 对数高度只负责表达量级，精确值仍由文字和 Tooltip 负责。
  const normalized = Math.log1p(value) / Math.log1p(maximum);
  return Math.max(6, Math.round(normalized * TOKEN_CHART_MAX_HEIGHT));
}
