import assert from 'node:assert/strict';
import test from 'node:test';

import { formatRuntimeModelLine, getActiveRuntimeModels, getRuntimeModelLines } from './runtime-models.ts';

const NOW = 1_790_000_000_000;

test('active runtime models drop expired cooldowns but keep hard blocks', () => {
  const record = {
    runtimeModels: [
      { model: 'gpt-5.4', blocks: [], cooldownKind: 'rate_limited', cooldownUntil: NOW - 1 },
      { model: 'gpt-5.5', blocks: [], cooldownKind: 'rate_limited', cooldownUntil: NOW + 60_000 },
      { model: 'gpt-6-astra', blocks: ['model_catalog'] }
    ]
  };
  assert.deepEqual(getActiveRuntimeModels(record, NOW).map((entry) => entry.model), ['gpt-5.5', 'gpt-6-astra']);
  assert.equal(getRuntimeModelLines(record, NOW).length, 2);
  assert.deepEqual(getActiveRuntimeModels({}, NOW), []);
});

test('runtime model line names the model and the reason', () => {
  const cooling = formatRuntimeModelLine({ model: 'gpt-5.5', blocks: [], cooldownKind: 'rate_limited', cooldownUntil: NOW + 60_000 }, NOW);
  assert.match(cooling, /^gpt-5\.5：限流冷却至 /);
  const blocked = formatRuntimeModelLine({ model: 'gpt-6-astra', blocks: ['model_catalog'] }, NOW);
  assert.equal(blocked, 'gpt-6-astra：不在模型目录（刷新模型目录后恢复）');
});
