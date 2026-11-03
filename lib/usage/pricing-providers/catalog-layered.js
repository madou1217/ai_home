'use strict';

// 把官方/社区价格源的快照叠加到 models.dev 基础目录上。
//
// 这里只做记录级覆盖（同一 `<provider>/<model>` 的每个维度独立取非空值），
// 来源权威序、维度级合并与复核已经由 catalog-source-store / merge-quotes 完成。
// 基础 provider 仍负责模型 ID 解析（别名、版本分隔符、provider 前缀），
// 因此外部来源不需要复制这些匹配逻辑。

const { fingerprintPricingCatalog } = require('../model-usage-pricing');

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeRecord(base, extra) {
  const record = { ...base };
  for (const key of ['inputCostPerToken', 'outputCostPerToken', 'cacheReadInputTokenCost',
    'cacheCreationInputTokenCost', 'reasoningOutputTokenCost']) {
    if (extra[key] !== null && extra[key] !== undefined) record[key] = extra[key];
  }
  if (Array.isArray(extra.contextCostTiers) && extra.contextCostTiers.length > 0) {
    record.contextCostTiers = extra.contextCostTiers;
  }
  return record;
}

function mergePricingRecords(baseRecords, extraRecords) {
  const byModel = new Map();
  for (const record of Array.isArray(baseRecords) ? baseRecords : []) {
    if (!isRecord(record) || !record.model) continue;
    byModel.set(String(record.model).toLowerCase(), record);
  }
  for (const record of Array.isArray(extraRecords) ? extraRecords : []) {
    if (!isRecord(record) || !record.model) continue;
    const key = String(record.model).toLowerCase();
    byModel.set(key, byModel.has(key) ? mergeRecord(byModel.get(key), record) : record);
  }
  return [...byModel.values()].sort((left, right) => String(left.model).localeCompare(String(right.model)));
}

function createLayeredPricingProvider(base, options = {}) {
  if (!base || typeof base.loadSnapshot !== 'function' || typeof base.resolve !== 'function') {
    throw new Error('model_pricing_provider_invalid');
  }
  const store = options.store || null;
  const id = String(options.id || base.id || 'models.dev');
  let snapshot = null;

  function loadSnapshot(loadOptions = {}) {
    const baseSnapshot = base.loadSnapshot(loadOptions);
    let records = Array.isArray(baseSnapshot.records) ? baseSnapshot.records : [];
    let external = [];
    if (store && typeof store.buildPricingRecords === 'function') {
      external = store.buildPricingRecords();
      records = mergePricingRecords(records, external);
    }
    const fingerprint = fingerprintPricingCatalog(records);
    snapshot = {
      ...baseSnapshot,
      providerId: id,
      fingerprint,
      revision: fingerprint,
      records,
      externalRecords: external.length
    };
    return snapshot;
  }

  function resolve(input = {}, context = {}) {
    return base.resolve(input, context);
  }

  return {
    id,
    loadSnapshot,
    resolve,
    getSnapshot: () => snapshot,
    base
  };
}

module.exports = { createLayeredPricingProvider, mergePricingRecords };
