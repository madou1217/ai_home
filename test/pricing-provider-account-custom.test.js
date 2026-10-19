'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createAccountCustomPricingProvider,
  __private
} = require('../lib/usage/pricing-providers/account-custom');
const {
  normalizeModelCatalogSettings,
  saveModelCatalogSettings
} = require('../lib/server/model-catalog-settings-store');
const {
  PRICING_RESOLUTION_STATUS,
  createModelPricingResolver
} = require('../lib/usage/model-pricing-resolver');

function createBaseProvider(overrides = {}) {
  return {
    id: 'models.dev',
    resolve(input = {}) {
      if (overrides.resolve) return overrides.resolve(input);
      const matched = String(input.model || '').toLowerCase();
      if (!matched) return { status: PRICING_RESOLUTION_STATUS.UNKNOWN };
      return {
        status: PRICING_RESOLUTION_STATUS.PRICED,
        matchedModel: matched,
        matchType: 'exact',
        pricing: {
          model: matched,
          inputCostPerToken: 3e-6 / 1_000_000 * 1_000_000, // 3 per million → per token shape below
          outputCostPerToken: 15 / 1_000_000,
          cacheReadInputTokenCost: 0.3 / 1_000_000,
          cacheCreationInputTokenCost: 3.75 / 1_000_000,
          reasoningOutputTokenCost: null
        }
      };
    },
    loadSnapshot: () => ({ items: [] }),
    getSnapshot: () => ({ items: [] })
  };
}

function createSettingsSource(settingsById = {}) {
  const loads = { count: 0 };
  const reload = () => {
    loads.count += 1;
    const settings = settingsById[loads.count] === undefined
      ? settingsById.default
      : settingsById[loads.count];
    return settings || null;
  };
  return { reload, loads };
}

const SETTINGS_ONE = {
  updatedAt: 1000,
  accountModels: [{
    accountRef: 'acct:alpha',
    id: 'gpt-x',
    customPricing: { input: 1, output: 2 }
  }]
};

test('account custom pricing provider hits per account+model and merges with base', () => {
  const settings = createSettingsSource({ default: SETTINGS_ONE });
  const base = createBaseProvider();
  const provider = createAccountCustomPricingProvider(base, {
    reloadSettings: settings.reload
  });

  const hit = provider.resolve({ model: 'GPT-X', provider: 'codex', accountRef: 'acct:alpha' });
  assert.equal(hit.status, PRICING_RESOLUTION_STATUS.PRICED);
  assert.equal(hit.matchType, 'account_custom');
  assert.equal(hit.pricing.inputCostPerToken, 1 / 1_000_000);
  assert.equal(hit.pricing.outputCostPerToken, 2 / 1_000_000);
  // 未覆盖维度继承 base
  assert.equal(hit.pricing.cacheReadInputTokenCost, 0.3 / 1_000_000);
  assert.equal(hit.pricing.cacheCreationInputTokenCost, 3.75 / 1_000_000);
  assert.equal(hit.matchedModel, 'gpt-x');
});

test('account custom pricing provider falls back to base on miss', () => {
  const settings = createSettingsSource({ default: SETTINGS_ONE });
  const provider = createAccountCustomPricingProvider(createBaseProvider(), { reloadSettings: settings.reload });

  const miss = provider.resolve({ model: 'gpt-x', provider: 'codex', accountRef: 'acct:other' });
  assert.equal(miss.status, PRICING_RESOLUTION_STATUS.PRICED);
  assert.equal(miss.matchType, 'exact');
  assert.equal(miss.pricing.inputCostPerToken, 3e-6 / 1_000_000 * 1_000_000);

  const noRef = provider.resolve({ model: 'gpt-x', provider: 'codex' });
  assert.equal(noRef.status, PRICING_RESOLUTION_STATUS.PRICED);
  assert.equal(noRef.matchType, 'exact');
});

test('account custom pricing provider keeps zero value custom pricing (free) and inherits base for unset keys', () => {
  const settings = createSettingsSource({
    default: {
      updatedAt: 1,
      accountModels: [{
        accountRef: 'acct:free',
        id: 'model-free',
        customPricing: { input: 0, output: 0 }
      }]
    }
  });
  const provider = createAccountCustomPricingProvider(createBaseProvider(), {
    reloadSettings: settings.reload
  });
  const hit = provider.resolve({ model: 'model-free', provider: 'codex', accountRef: 'acct:free' });
  // input/output 被自定义成 0，但 cacheRead/cacheWrite 继承 base 非零 → 整价不是 known_zero。
  assert.equal(hit.status, PRICING_RESOLUTION_STATUS.PRICED);
  assert.equal(hit.pricing.inputCostPerToken, 0);
  assert.equal(hit.pricing.outputCostPerToken, 0);
  assert.equal(hit.pricing.cacheReadInputTokenCost, 0.3 / 1_000_000);
});

test('account custom pricing provider preserves base reasoning cost in merge', () => {
  const base = createBaseProvider();
  const originalResolve = base.resolve;
  base.resolve = (input) => {
    const result = originalResolve(input);
    result.pricing.reasoningOutputTokenCost = 9 / 1_000_000;
    return result;
  };
  const settings = createSettingsSource({ default: SETTINGS_ONE });
  const provider = createAccountCustomPricingProvider(base, { reloadSettings: settings.reload });
  const hit = provider.resolve({ model: 'gpt-x', provider: 'codex', accountRef: 'acct:alpha' });
  assert.equal(hit.pricing.reasoningOutputTokenCost, 9 / 1_000_000);
});

test('account custom pricing provider caches settings and refreshes on demand', () => {
  const settings = createSettingsSource({
    1: SETTINGS_ONE,
    2: { updatedAt: 2000, accountModels: [] }
  });
  let nowMs = 0;
  const provider = createAccountCustomPricingProvider(createBaseProvider(), {
    reloadSettings: settings.reload,
    now: () => nowMs
  });

  const first = provider.resolve({ model: 'gpt-x', provider: 'codex', accountRef: 'acct:alpha' });
  assert.equal(first.matchType, 'account_custom');
  assert.equal(settings.loads.count, 1);

  nowMs = 1; // TTL 内不重新读
  provider.resolve({ model: 'gpt-x', provider: 'casd', accountRef: 'acct:alpha' });
  assert.equal(settings.loads.count, 1);

  nowMs = 10_000; // TTL 过期重新读
  const second = provider.resolve({ model: 'gpt-x', provider: 'codex', accountRef: 'acct:alpha' });
  assert.equal(settings.loads.count, 2);
  assert.equal(second.matchType, 'exact'); // 新 settings 清空了 customPricing

  provider.refresh(); // 强制清缓存
  provider.resolve({ model: 'gpt-x', provider: 'codex', accountRef: 'acct:alpha' });
  assert.equal(settings.loads.count, 3);
});

test('account custom pricing provider survives settings read failure', () => {
  let shouldFail = true;
  const provider = createAccountCustomPricingProvider(createBaseProvider(), {
    reloadSettings: () => {
      if (shouldFail) throw new Error('db locked');
      return SETTINGS_ONE;
    }
  });
  // 读失败：零行为差异走 base
  const fallback = provider.resolve({ model: 'gpt-x', provider: 'codex', accountRef: 'acct:alpha' });
  assert.equal(fallback.matchType, 'exact');

  shouldFail = false;
  provider.refresh();
  const hit = provider.resolve({ model: 'gpt-x', provider: 'codex', acctRef: undefined, accountRef: 'acct:alpha' });
  assert.equal(hit.matchType, 'account_custom');
});

test('account custom pricing helpers convert per-million to per-token', () => {
  assert.equal(__private.perTokenFromPerMillion(3), 3e-6);
  assert.equal(__private.perTokenFromPerMillion(0), 0);
  assert.equal(__private.perTokenFromPerMillion(Number.NaN), 0);
  assert.deepEqual(__private.buildMergedPricing({
    model: 'm',
    inputCostPerToken: 3e-6,
    outputCostPerToken: 1.5e-5,
    cacheReadInputTokenCost: 3e-7,
    cacheCreationInputTokenCost: 3.75e-6,
    reasoningOutputTokenCost: 9e-6
  }, { input: 1 }, 'm'), {
    model: 'm',
    inputCostPerToken: 1e-6,
    outputCostPerToken: 1.5e-5,
    cacheReadInputTokenCost: 3e-7,
    cacheCreationInputTokenCost: 3.75e-6,
    reasoningOutputTokenCost: 9e-6
  });
});

test('account custom pricing provider tolerates invalid settings shapes', () => {
  const provider = createAccountCustomPricingProvider(createBaseProvider(), {
    reloadSettings: () => ({ accountModels: 'nope' })
  });
  const result = provider.resolve({ model: 'gpt-x', provider: 'codex', accountRef: 'acct:alpha' });
  assert.equal(result.matchType, 'exact');
  assert.equal(__private.buildCustomPricingIndex(null).size, 0);
});

test('model pricing resolver forwards accountRef to the custom pricing decorator', () => {
  const settings = createSettingsSource({ default: SETTINGS_ONE });
  const resolver = createModelPricingResolver({
    providers: [createAccountCustomPricingProvider(createBaseProvider(), { reloadSettings: settings.reload })]
  });

  const hit = resolver.resolve({ model: 'gpt-x', provider: 'codex', accountRef: 'acct:alpha' });
  assert.equal(hit.matchType, 'account_custom');
  assert.equal(hit.pricing.inputCostPerToken, 1 / 1_000_000);

  const miss = resolver.resolve({ model: 'gpt-x', provider: 'codex', accountRef: 'acct:other' });
  assert.equal(miss.matchType, 'exact');
});

test('account custom pricing provider reads the real persisted settings synchronously', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-custom-pricing-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = 'acct_0123456789abcdefabcd';
  await saveModelCatalogSettings(fs, aiHomeDir, normalizeModelCatalogSettings({
    version: 5,
    accountModels: [{
      id: 'gpt-x',
      provider: 'codex',
      accountRef,
      customPricing: { input: 7, output: 11 }
    }]
  }));

  const provider = createAccountCustomPricingProvider(createBaseProvider(), { fs, aiHomeDir });
  const hit = provider.resolve({ model: 'gpt-x', provider: 'codex', accountRef });
  assert.equal(hit.matchType, 'account_custom');
  assert.equal(hit.pricing.inputCostPerToken, 7 / 1_000_000);
  assert.equal(hit.pricing.outputCostPerToken, 11 / 1_000_000);
  // 未覆盖维度仍继承 models.dev 原价
  assert.equal(hit.pricing.cacheReadInputTokenCost, 0.3 / 1_000_000);
});
