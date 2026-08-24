import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildModelMixData,
  calculateCacheHitRate,
  formatAccountScope,
  formatCacheRate,
  formatCost,
  formatModelMixAxisValue,
  formatTokens
} from './model-usage-presentation.ts';

function model(
  model: string,
  totalTokens: number,
  costUsd: number,
  provider: 'codex' | 'claude' = 'codex'
) {
  return {
    provider,
    model,
    calls: 1,
    inputTokens: totalTokens,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens,
    costUsd,
    cacheHitRate: 0,
    accountCount: 1,
    unattributedCalls: 0
  };
}

test('model usage presentation keeps compact values and explicit unknown attribution', () => {
  assert.equal(formatTokens(1_250_000_000), '1.25B');
  assert.equal(formatCost(0.0042), '$0.0042');
  assert.equal(formatCacheRate(0.625), '62.5%');
  assert.equal(formatCacheRate(null), '-');
  assert.equal(formatAccountScope(2, 3), '2 个 + 未归属');
  assert.equal(formatAccountScope(0, 3), '仅未归属');
  assert.equal(formatModelMixAxisValue(200_000_000, 'tokens'), '200M');
  assert.equal(formatModelMixAxisValue(1_250_000_000, 'tokens'), '1.3B');
  assert.equal(formatModelMixAxisValue(200, 'cost'), '$200');
  assert.equal(formatModelMixAxisValue(0.0042, 'cost'), '$0.0042');
  assert.equal(calculateCacheHitRate({
    inputTokens: 100,
    cacheReadInputTokens: 300,
    cacheCreationInputTokens: 100
  }), 0.6);
  assert.equal(calculateCacheHitRate({
    inputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0
  }), null);
});

test('model mix keeps the leading models and aggregates the tail without losing totals', () => {
  const rows = [
    model('a', 100, 1),
    model('b', 80, 4),
    model('c', 60, 2),
    model('d', 40, 3)
  ];
  const tokenMix = buildModelMixData(rows, 'tokens', 2);
  assert.deepEqual(tokenMix.map((row) => [row.label, row.value]), [
    ['a', 100],
    ['b', 80],
    ['其他 2 个模型', 100]
  ]);
  const costMix = buildModelMixData(rows, 'cost', 2);
  assert.deepEqual(costMix.map((row) => [row.label, row.value]), [
    ['b', 4],
    ['d', 3],
    ['其他 2 个模型', 3]
  ]);
});

test('model mix disambiguates the same model exposed by different providers', () => {
  const rows = [
    model('shared-model', 100, 1, 'codex'),
    model('shared-model', 80, 2, 'claude')
  ];

  assert.deepEqual(buildModelMixData(rows, 'tokens').map((row) => row.label), [
    'codex · shared-model',
    'claude · shared-model'
  ]);
});
