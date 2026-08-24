'use strict';

function toNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function calculateCacheHitRate(metrics = {}) {
  const inputTokens = toNonNegativeNumber(metrics.inputTokens ?? metrics.input_tokens);
  const cacheReadInputTokens = toNonNegativeNumber(
    metrics.cacheReadInputTokens ?? metrics.cache_read_input_tokens
  );
  const cacheCreationInputTokens = toNonNegativeNumber(
    metrics.cacheCreationInputTokens ?? metrics.cache_creation_input_tokens
  );
  const totalInputTokens = inputTokens + cacheReadInputTokens + cacheCreationInputTokens;
  if (totalInputTokens <= 0) return null;
  return cacheReadInputTokens / totalInputTokens;
}

module.exports = {
  calculateCacheHitRate
};
