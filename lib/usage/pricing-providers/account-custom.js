'use strict';

// 账号自定义价格 provider：decorator，包住被注入的价格 provider（生产上是 models.dev）。
// 数据源 = model-catalog settings 的 customPricing（app-state DB `model-catalog-settings`，
// 单位＝每百万 token 美元），用量计价口径是 per-token（÷1e6）。
// 只有 input.accountRef 命中 `accountRef\0modelId(小写)` 键时接管：自定义值覆盖 base 的
// 对应维度；未覆盖的维度保留 base（第三方中转通常只改输入/输出单价），merge 语义在
// display 侧表现为「原价划线、覆盖价生效」的同构口径。未命中时零行为差异，原样走 base。

const {
  readModelCatalogSettings
} = require('../../server/model-catalog-settings-store');
const {
  PRICING_RESOLUTION_STATUS,
  isKnownZeroPricing
} = require('../model-pricing-resolver');

const ACCOUNT_CUSTOM_PRICING_KEY_SEPARATOR = '\u0000';
const PRICING_PER_MILLION = 1_000_000;
// 设置在本机 app-state DB 里：编辑价后立刻重算必须马上可见，但每行 resolve 都打开一次
// DB 会拖垮批量重算（1000 行/批）。TTL 把同批内的读取折叠成常数次。
const SETTINGS_REFRESH_MS = 3_000;

function perTokenFromPerMillion(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return number / PRICING_PER_MILLION;
}

// custom 值优先；未设置（settings 只存用户改过的维度）回落 base；均无效时 0。
function mergePrice(customValue, baseValue) {
  if (customValue !== undefined && customValue !== null && customValue !== '') {
    return perTokenFromPerMillion(customValue);
  }
  const base = Number(baseValue);
  return Number.isFinite(base) && base >= 0 ? base : 0;
}

// merge 保留 base 的 reasoning 价（customPricing 没有 reasoning 维度），算成本时
// reasoning 缺省口径按 calculateCostUsd 里「声明 null → 用 output 单价」的既有规则。
function buildMergedPricing(base, customPricing, modelId) {
  const pricing = {
    model: String(base && base.model || modelId || '').trim(),
    inputCostPerToken: mergePrice(customPricing.input, base && base.inputCostPerToken),
    outputCostPerToken: mergePrice(customPricing.output, base && base.outputCostPerToken),
    cacheReadInputTokenCost: mergePrice(customPricing.cacheRead, base && base.cacheReadInputTokenCost),
    cacheCreationInputTokenCost: mergePrice(customPricing.cacheWrite, base && base.cacheCreationInputTokenCost)
  };
  const reasoningOutputTokenCost = base && base.reasoningOutputTokenCost;
  if (reasoningOutputTokenCost !== null && reasoningOutputTokenCost !== undefined) {
    pricing.reasoningOutputTokenCost = reasoningOutputTokenCost;
  }
  return pricing;
}

function buildCustomPricingIndex(settings) {
  const index = new Map();
  const records = Array.isArray(settings && settings.accountModels) ? settings.accountModels : [];
  records.forEach((record) => {
    const accountRef = String(record && record.accountRef || '').trim();
    const modelId = String(record && record.id || '').trim();
    const customPricing = record && record.customPricing;
    if (!accountRef || !modelId || !customPricing || typeof customPricing !== 'object') return;
    index.set(`${accountRef}${ACCOUNT_CUSTOM_PRICING_KEY_SEPARATOR}${modelId.toLowerCase()}`, customPricing);
  });
  return index;
}

function readSettingsFingerprint(settings) {
  return JSON.stringify([
    Number(settings && settings.updatedAt) || 0,
    Array.isArray(settings && settings.accountModels) ? settings.accountModels.length : 0
  ]);
}

/**
 * createAccountCustomPricingProvider(baseProvider, options)
 * baseProvider: 既有价格 provider（production: models.dev）。缺省时不装饰，返回 null 由调用方直用 base。
 * options: { fs, aiHomeDir, now, reloadSettings }
 */
function createAccountCustomPricingProvider(baseProvider, options = {}) {
  if (!baseProvider || typeof baseProvider.resolve !== 'function') {
    throw new Error('account_custom_pricing_base_provider_invalid');
  }
  const fs = options.fs || null;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const reloadSettings = typeof options.reloadSettings === 'function'
    ? options.reloadSettings
    : () => (fs && aiHomeDir ? readModelCatalogSettings(fs, aiHomeDir) : null);
  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now();
  let cache = null;

  function readSettings() {
    try {
      return reloadSettings();
    } catch (_error) {
      // 读取失败退到上一个索引，绝不打断计价链
      return null;
    }
  }

  function ensureIndex() {
    const now = nowFn();
    if (cache && now - cache.loadedAtMs <= SETTINGS_REFRESH_MS) return cache.index;
    const settings = readSettings();
    const fingerprint = readSettingsFingerprint(settings);
    if (!cache || cache.fingerprint !== fingerprint) {
      cache = {
        loadedAtMs: now,
        fingerprint,
        index: buildCustomPricingIndex(settings)
      };
      return cache.index;
    }
    // 内容未变：只推进时间戳，避免常驻 O(文件大小) 的重复重建
    cache.loadedAtMs = now;
    return cache.index;
  }

  function safeResolveBase(input, context) {
    try {
      return baseProvider.resolve(input, context) || null;
    } catch (_error) {
      return null;
    }
  }

  function resolve(input = {}, context = {}) {
    const base = safeResolveBase(input, context);
    const accountRef = String(input && input.accountRef || '').trim();
    if (!accountRef) return base || { status: PRICING_RESOLUTION_STATUS.UNKNOWN };
    const modelId = String(input && input.model || '').trim();
    if (!modelId) return base || { status: PRICING_RESOLUTION_STATUS.UNKNOWN };
    const customPricing = ensureIndex().get(
      `${accountRef}${ACCOUNT_CUSTOM_PRICING_KEY_SEPARATOR}${modelId.toLowerCase()}`
    );
    if (!customPricing) return base || { status: PRICING_RESOLUTION_STATUS.UNKNOWN };
    const pricing = buildMergedPricing(base && base.pricing, customPricing, modelId);
    return {
      status: isKnownZeroPricing(pricing)
        ? PRICING_RESOLUTION_STATUS.KNOWN_ZERO
        : PRICING_RESOLUTION_STATUS.PRICED,
      matchedModel: pricing.model,
      matchType: 'account_custom',
      pricing
    };
  }

  return {
    // id 沿用 base：pricingSource / active catalog 机制、resolver 的 sourceProviderId
    // 钉选都按 base 语义工作；装饰只发生在 resolve 入口。
    id: baseProvider.id,
    resolve,
    loadSnapshot: (...args) => baseProvider.loadSnapshot(...args),
    getSnapshot: () => baseProvider.getSnapshot(),
    refresh: () => {
      cache = null;
    },
    __private: {
      ensureIndex,
      resolveBase: safeResolveBase
    }
  };
}

module.exports = {
  createAccountCustomPricingProvider,
  __private: {
    ACCOUNT_CUSTOM_PRICING_KEY_SEPARATOR,
    PRICING_PER_MILLION,
    SETTINGS_REFRESH_MS,
    buildCustomPricingIndex,
    buildMergedPricing,
    mergePrice,
    perTokenFromPerMillion
  }
};
