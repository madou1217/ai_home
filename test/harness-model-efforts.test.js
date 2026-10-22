'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  opencodeReasoningOptions,
  piThinkingLevelMap,
  resolveModelEfforts
} = require('../lib/cli/services/ai-cli/launch-profile/harness-model-efforts');
const { resolveModelEfforts: gatewayEfforts } = require('../lib/server/model-effort-index');
const { buildOpenAIModelsList } = require('../lib/server/models');

// 2026-10-22 用户反馈：注入给 opencode / pi 的模型条目只写了名字，没有档位声明，
// harness 只能��自己的默认上限 —— 现象是「最大只能选 high」，而网关支持到 xhigh / max。
// 这组用例锁住「档位必须如实转达」这条契约。

test('effort lookups come from the catalog, ordered by canonical strength', () => {
  assert.deepEqual(resolveModelEfforts({ provider: 'opencode', model: 'gpt-6-luna' }),
    ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(resolveModelEfforts({ provider: 'claude', model: 'claude-sonnet-4-6' }),
    ['low', 'medium', 'high', 'max']);
  // 模型目录里确实存在只有两档的组合，顺序必须仍是强度升序而不是字典序。
  assert.deepEqual(resolveModelEfforts({ provider: 'opencode', model: 'deepseek-v4-pro' }),
    ['high', 'max']);
});

test('an unknown model reports no tiers instead of guessing a family ladder', () => {
  // 猜错模态只是多剥一张图；猜错强度会把用户明确要求的 high 静默降档。
  assert.deepEqual(resolveModelEfforts({ provider: 'claude', model: 'not-a-real-model-xyz' }), []);
  assert.deepEqual(resolveModelEfforts({ provider: 'claude', model: '' }), []);
});

test('opencode gets reasoning_options in its own catalog shape', () => {
  assert.deepEqual(opencodeReasoningOptions(['low', 'high', 'max']),
    [{ type: 'effort', values: ['low', 'high', 'max'] }]);
  // 没有档位时不写该字段（省略 = 未知，让 opencode 退回自己的默认）。
  assert.equal(opencodeReasoningOptions([]), null);
  assert.equal(opencodeReasoningOptions(undefined), null);
});

test('pi gets a thinkingLevelMap covering its fixed seven levels', () => {
  const map = piThinkingLevelMap(['low', 'high', 'max']);
  assert.deepEqual(Object.keys(map), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(map.low, 'low');
  assert.equal(map.high, 'high');
  assert.equal(map.max, 'max');
  // 不支持的档位显式写 null（pi 的 schema 用 null 表达不可用）。
  assert.equal(map.minimal, null);
  assert.equal(map.xhigh, null);
  // `none` 在 pi 的词汇里是 `off`：同一语义两个名字，必须映射而不是漏掉。
  assert.equal(piThinkingLevelMap(['none', 'high']).off, 'off');
  assert.equal(piThinkingLevelMap([]), null);
});

test('the gateway publishes the tiers so harnesses do not have to guess', () => {
  const list = buildOpenAIModelsList([
    { id: 'gpt-6-luna', provider: 'opencode' },
    { id: 'claude-sonnet-4-6', provider: 'claude' },
    { id: 'not-a-real-model-xyz', provider: 'claude' }
  ]);
  const byId = new Map(list.data.map((entry) => [entry.id, entry]));
  assert.deepEqual(byId.get('gpt-6-luna').aih_reasoning_efforts,
    ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(byId.get('claude-sonnet-4-6').aih_reasoning_efforts,
    ['low', 'medium', 'high', 'max']);
  // 未知模型省略该字段：省略表达「未知」，而不是「没有档位」。
  assert.equal(Object.hasOwn(byId.get('not-a-real-model-xyz'), 'aih_reasoning_efforts'), false);
});

test('the gateway index and the harness projection agree on the same model', () => {
  for (const [provider, model] of [['opencode', 'gpt-6-luna'], ['claude', 'claude-sonnet-4-6']]) {
    assert.deepEqual(resolveModelEfforts({ provider, model }),
      gatewayEfforts({ provider, model }), `${provider}/${model} must resolve identically`);
  }
});
