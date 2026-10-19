import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatPricePerM,
  hasCustomPricingValues,
  resolveModelPriceCells
} from './model-price.ts';

test('formatPricePerM keeps meaningful precision without long tails', () => {
  assert.equal(formatPricePerM(0), '0');
  assert.equal(formatPricePerM(15), '15.0');
  assert.equal(formatPricePerM(1.234), '1.23');
  assert.equal(formatPricePerM(0.003), '0.003');
  assert.equal(formatPricePerM(Number.NaN), '--');
});

test('resolveModelPriceCells prefers custom values and keeps the base for strike-through', () => {
  const cells = resolveModelPriceCells(
    { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    { input: 1, cacheWrite: 0 }
  );
  assert.deepEqual(cells.map((cell) => cell.key), ['input', 'output', 'cacheRead', 'cacheWrite']);
  assert.deepEqual(cells[0], { key: 'input', label: '入', value: 1, base: 3, overridden: true });
  assert.deepEqual(cells[1], { key: 'output', label: '出', value: 15, overridden: false });
  assert.deepEqual(cells[3], { key: 'cacheWrite', label: '缓写', value: 0, base: 3.75, overridden: true });
});

test('resolveModelPriceCells drops dimensions without any price and custom-only models still show', () => {
  assert.deepEqual(resolveModelPriceCells({ input: 2 }, { output: 5 }), [
    { key: 'input', label: '入', value: 2, overridden: false },
    { key: 'output', label: '出', value: 5, overridden: true }
  ]);
  assert.deepEqual(resolveModelPriceCells(undefined, { input: 1 }), [
    { key: 'input', label: '入', value: 1, overridden: true }
  ]);
});

test('hasCustomPricingValues ignores empty and invalid custom pricing', () => {
  assert.equal(hasCustomPricingValues(undefined), false);
  assert.equal(hasCustomPricingValues({}), false);
  assert.equal(hasCustomPricingValues({ input: Number.NaN }), false);
  assert.equal(hasCustomPricingValues({ input: 0 }), true);
});
