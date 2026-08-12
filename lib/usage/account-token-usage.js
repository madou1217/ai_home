'use strict';

const ACCOUNT_TOKEN_USAGE_DIMENSIONS = Object.freeze(['day', 'week', 'month']);

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
    const number = Number(value[dimension]);
    normalized[dimension] = Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
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
