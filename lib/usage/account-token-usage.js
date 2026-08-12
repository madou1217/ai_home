'use strict';

const ACCOUNT_TOKEN_USAGE_DIMENSIONS = Object.freeze(['day', 'week', 'month']);

function normalizeTokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
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
    const current = models.get(model) || { model };
    normalizedDimensions.forEach((dimension) => {
      current[dimension] = normalizeTokenCount(current[dimension])
        + normalizeTokenCount(modelValue[dimension]);
    });
    models.set(model, current);
  });

  normalized.models = Array.from(models.values())
    .filter((modelValue) => normalizedDimensions.some((dimension) => modelValue[dimension] > 0))
    .sort((left, right) => {
      const leftTotal = normalizedDimensions.reduce((sum, dimension) => sum + left[dimension], 0);
      const rightTotal = normalizedDimensions.reduce((sum, dimension) => sum + right[dimension], 0);
      return rightTotal - leftTotal || left.model.localeCompare(right.model);
    });
  return normalized;
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
    monthStartMs: monthStart.getTime()
  };
}

module.exports = {
  ACCOUNT_TOKEN_USAGE_DIMENSIONS,
  normalizeAccountTokenUsageDimensions,
  normalizeAccountTokenUsageValue,
  resolveLocalAccountTokenUsageWindows
};
