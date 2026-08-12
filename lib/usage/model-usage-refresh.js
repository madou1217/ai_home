'use strict';

const { ACCOUNT_TOKEN_USAGE_DIMENSIONS } = require('./account-token-usage');

async function collectAccountTokenUsage(modelUsageService, options = {}) {
  if (!modelUsageService) return null;
  const read = typeof modelUsageService.getAccountTokenUsageAsync === 'function'
    ? modelUsageService.getAccountTokenUsageAsync
    : modelUsageService.getAccountTokenUsage;
  if (typeof read !== 'function') return null;
  return await Promise.resolve(read.call(modelUsageService, {
    dimensions: [...ACCOUNT_TOKEN_USAGE_DIMENSIONS],
    nowMs: Number(options.nowMs) || Date.now()
  }));
}

async function refreshAccountTokenUsage(modelUsageService, onUpdated, options = {}) {
  const usage = await collectAccountTokenUsage(modelUsageService, options);
  if (usage !== null && typeof onUpdated === 'function') {
    await onUpdated(usage, {
      dimensions: [...ACCOUNT_TOKEN_USAGE_DIMENSIONS],
      generatedAt: Number(options.generatedAt) || Date.now()
    });
  }
  return usage;
}

module.exports = {
  collectAccountTokenUsage,
  refreshAccountTokenUsage
};
