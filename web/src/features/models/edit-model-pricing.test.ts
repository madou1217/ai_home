import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCustomPricingPayload,
  formatModelPrice,
  hasCustomModelPricing
} from './edit-model-pricing.ts';

test('formatModelPrice includes all four dimensions and lets custom values win', () => {
  const text = formatModelPrice({
    metadata: { cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
    customPricing: { input: 1 }
  });
  assert.equal(text, '入 $1.00 · 出 $15.0 · 缓读 $0.30 · 缓写 $3.75');
});

test('formatModelPrice falls back to -- without any price', () => {
  assert.equal(formatModelPrice({}), '--');
});

test('hasCustomModelPricing ignores empty and invalid values', () => {
  assert.equal(hasCustomModelPricing({}), false);
  assert.equal(hasCustomModelPricing({ customPricing: {} }), false);
  assert.equal(hasCustomModelPricing({ customPricing: { cacheWrite: 0 } }), true);
});

test('buildCustomPricingPayload keeps explicit zero and maps empty form to null', () => {
  assert.deepEqual(buildCustomPricingPayload({
    input: 0,
    output: 2,
    cacheRead: null,
    cacheWrite: undefined
  }), { input: 0, output: 2 });
  assert.equal(buildCustomPricingPayload({}), null);
  assert.equal(buildCustomPricingPayload({ input: null, output: null }), null);
});
