'use strict';

// `total` 是「有记录以来的累计」，窗口起点为 0，与前三个滚动窗口共用同一套聚合契约。
const ACCOUNT_TOKEN_USAGE_DIMENSIONS = Object.freeze(['day', 'week', 'month', 'total']);

function normalizeTokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

function normalizeCostUsd(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeAccountTokenUsageDimensions(values) {
  const requested = Array.isArray(values) ? values : [];
  const dimensions = ACCOUNT_TOKEN_USAGE_DIMENSIONS.filter((dimension) => requested.includes(dimension));
  return dimensions.length > 0 ? dimensions : [...ACCOUNT_TOKEN_USAGE_DIMENSIONS];
}

function normalizeAccountTokenUsageValue(value, dimensions = ACCOUNT_TOKEN_USAGE_DIMENSIONS) {
  if (!value || typeof value !== 'object') return null;
  const normalizedDimensions = normalizeAccountTokenUsageDimensions(dimensions);
  const normalized = {};
  normalizedDimensions.forEach((dimension) => {
    normalized[dimension] = normalizeTokenCount(value[dimension]);
  });

  const models = new Map();
  (Array.isArray(value.models) ? value.models : []).forEach((modelValue) => {
    const model = String(modelValue && modelValue.model || '').trim();
    if (!model) return;
    const current = models.get(model) || {
      model,
      ...Object.fromEntries(normalizedDimensions.flatMap((dimension) => ([
        [dimension, 0],
        [`${dimension}CostUsd`, null]
      ])))
    };
    normalizedDimensions.forEach((dimension) => {
      const tokens = normalizeTokenCount(modelValue[dimension]);
      const costKey = `${dimension}CostUsd`;
      const costUsd = normalizeCostUsd(modelValue[costKey]);
      const currentTokens = current[dimension];
      current[dimension] += tokens;
      if (tokens > 0) {
        current[costKey] = currentTokens === 0
          ? costUsd
          : current[costKey] === null || costUsd === null
            ? null
            : current[costKey] + costUsd;
      }
    });
    models.set(model, current);
  });

  normalized.models = Array.from(models.values())
    .filter((modelValue) => normalizedDimensions.some((dimension) => modelValue[dimension] > 0))
    .sort(compareAccountTokenUsageModels(normalizedDimensions));
  return normalized;
}

// 模型顺序既决定 Tooltip 行序，也决定柱子的配色下标，所以排序必须在前后端共用一份。
// 权重只看滚动窗口（日/周/月）：加进 total 会让一个只在历史上用过的模型抢占第一个色位，
// 把「最近谁在跑」这条既有信息挤掉；total 只作为同权重时的次级比较。
function compareAccountTokenUsageModels(dimensions = ACCOUNT_TOKEN_USAGE_DIMENSIONS) {
  const normalizedDimensions = normalizeAccountTokenUsageDimensions(dimensions);
  const rollingDimensions = normalizedDimensions.filter((dimension) => dimension !== 'total');
  const weighted = rollingDimensions.length > 0 ? rollingDimensions : normalizedDimensions;
  const weightOf = (modelValue) => weighted.reduce(
    (sum, dimension) => sum + (Number(modelValue[dimension]) || 0),
    0
  );
  return (left, right) => (
    weightOf(right) - weightOf(left)
    || (Number(right.total) || 0) - (Number(left.total) || 0)
    || left.model.localeCompare(right.model)
  );
}

function resolveLocalAccountTokenUsageWindows(nowMs = Date.now()) {
  const now = new Date(Number(nowMs) || Date.now());
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysSinceMonday = (dayStart.getDay() + 6) % 7;
  const weekStart = new Date(dayStart);
  weekStart.setDate(weekStart.getDate() - daysSinceMonday);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    nowMs: now.getTime(),
    dayStartMs: dayStart.getTime(),
    weekStartMs: weekStart.getTime(),
    monthStartMs: monthStart.getTime(),
    totalStartMs: 0
  };
}

function applyAccountTokenUsageDelta(usage, event, nowMs = Date.now()) {
  const total = Math.max(0, Number(event && event.total) || 0);
  if (!total || !Number.isFinite(event && event.occurredAt) || event.occurredAt > nowMs) return usage;
  const windows = resolveLocalAccountTokenUsageWindows(nowMs);
  const model = String(event.model || '').trim();
  const models = Array.isArray(usage && usage.models) ? usage.models.map((item) => ({ ...item })) : [];
  let modelUsage = models.find((item) => item.model === model);
  if (model && !modelUsage) {
    modelUsage = { model, ...Object.fromEntries(ACCOUNT_TOKEN_USAGE_DIMENSIONS.flatMap((dimension) => (
      [[dimension, 0], [`${dimension}CostUsd`, null]]
    ))) };
    models.push(modelUsage);
  }
  const next = { ...(usage || {}), models };
  for (const dimension of ACCOUNT_TOKEN_USAGE_DIMENSIONS) {
    const start = dimension === 'total' ? 0 : windows[`${dimension}StartMs`];
    if (event.occurredAt < start || event.occurredAt > windows.nowMs) continue;
    next[dimension] = (Number(next[dimension]) || 0) + total;
    if (modelUsage) {
      modelUsage[dimension] = (Number(modelUsage[dimension]) || 0) + total;
      modelUsage[`${dimension}CostUsd`] = null;
    }
  }
  return next;
}

module.exports = {
  ACCOUNT_TOKEN_USAGE_DIMENSIONS,
  applyAccountTokenUsageDelta,
  compareAccountTokenUsageModels,
  normalizeAccountTokenUsageDimensions,
  normalizeAccountTokenUsageValue,
  resolveLocalAccountTokenUsageWindows
};
