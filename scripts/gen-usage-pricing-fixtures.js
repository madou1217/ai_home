'use strict';

// 生成「定价归属」的对照夹具：Node 实现算一遍，Go 实现必须逐条一致。
//
// 为什么用夹具而不是各写一套期望值：两边的匹配规则（前缀优先级、版本分隔符折叠、
// 别名展开、上下文分档）互相纠缠，手写期望值只能证明「我以为是这个结果」；
// 由 Node 产出真值、Go 复算，才能证明两边真的同口径。
//
// 用法：node scripts/gen-usage-pricing-fixtures.js [输出路径]

const fs = require('node:fs');
const path = require('node:path');

const {
  calculateCostUsd,
  createModelPricingMatcher
} = require('../lib/usage/model-usage-pricing');
const { resolveBillingIdentity } = require('../lib/usage/model-usage-identity');
const { listProviderIds } = require('../lib/provider-catalog');

const CATALOG = {
  'openai/gpt-5.1': { inputCostPerToken: 1.25e-6, outputCostPerToken: 1e-5 },
  'anthropic/claude-sonnet-4-5': {
    inputCostPerToken: 3e-6,
    outputCostPerToken: 1.5e-5,
    cacheReadInputTokenCost: 3e-7,
    cacheCreationInputTokenCost: 3.75e-6
  },
  'anthropic/claude-opus-4-6': {
    inputCostPerToken: 1.5e-5,
    outputCostPerToken: 7.5e-5,
    reasoningOutputTokenCost: 9e-5
  },
  'google/gemini-3.5-flash': { inputCostPerToken: 3e-7, outputCostPerToken: 2.5e-6 },
  'opencode-go/glm-5': { inputCostPerToken: 6e-7, outputCostPerToken: 2.2e-6 },
  'opencode/glm-5': { inputCostPerToken: 9e-7, outputCostPerToken: 3.3e-6 },
  'cline-pass/deepseek-v4-flash': { inputCostPerToken: 2.8e-7, outputCostPerToken: 4.2e-7 },
  'tiered/model-a': {
    inputCostPerToken: 1e-6,
    outputCostPerToken: 2e-6,
    contextCostTiers: [
      { size: 200000, inputCostPerToken: 2e-6, outputCostPerToken: 4e-6 },
      { size: 100000, inputCostPerToken: 1.5e-6 }
    ]
  },
  'zero/free-model': { inputCostPerToken: 0, outputCostPerToken: 0 },
  'tier-only/model-b': {
    contextCostTiers: [{ size: 1000, inputCostPerToken: 5e-6 }]
  }
};

const MATCH_CASES = [
  ['openai/gpt-5.1', 'codex'],
  ['gpt-5.1', 'codex'],
  ['GPT-5.1', 'opencode'],
  ['codex.gpt-5.1', ''],
  ['claude-sonnet-4.5', 'claude'],
  ['claude-sonnet-4-5', 'claude'],
  ['claude-opus-4-6-thinking', 'claude'],
  ['gemini-3-flash-agent', 'gemini'],
  ['gemini-default', 'agy'],
  ['gemini-3.5-flash', 'agy'],
  ['cline-pass/deepseek-v4.1-flash', 'cline'],
  ['glm-5', 'opencode'],
  ['opencode.glm-5', 'codex'],
  ['tiered/model-a', ''],
  ['zero/free-model', ''],
  ['tier-only/model-b', ''],
  ['unknown/not-in-catalog', 'claude'],
  ['', 'claude']
];

const USAGE_CASES = [
  { inputTokens: 1000, outputTokens: 500 },
  { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 2000 },
  { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 2000, cacheCreationInputTokens: 300 },
  { inputTokens: 90000, outputTokens: 1000, reasoningOutputTokens: 4000 },
  { inputTokens: 150000, outputTokens: 1000 },
  { inputTokens: 250000, outputTokens: 1000 },
  { inputTokens: 0, outputTokens: 0 }
];

function round(value) {
  // 浮点乘法在 JS 与 Go 上的中间结果可能差最后一位；对齐到 12 位有效数字。
  return Number(Number(value).toPrecision(12));
}

// Node 的定价记录不保证带 model 字段，回填目录键后才能对比「命中了哪条」。
const pricingByModelKey = {};
Object.entries(CATALOG).forEach(([model, value]) => {
  pricingByModelKey[model] = { ...value, model };
});
const matcher = createModelPricingMatcher(pricingByModelKey);

const matches = MATCH_CASES.map(([model, provider]) => {
  const identity = resolveBillingIdentity(model, provider);
  const pricing = matcher(model, provider);
  return {
    model,
    provider,
    attributed: identity.attributed,
    executionProvider: identity.executionProvider,
    modelId: identity.modelId,
    modelIds: identity.modelIds,
    providerPrefixes: identity.providerPrefixes,
    matchedModel: pricing ? pricing.model : null
  };
});

const costs = [];
MATCH_CASES.forEach(([model, provider]) => {
  USAGE_CASES.forEach((usage) => {
    const pricing = matcher(model, provider);
    costs.push({
      model,
      provider,
      usage,
      matchedModel: pricing ? pricing.model : null,
      costUsd: round(calculateCostUsd(usage, pricing))
    });
  });
});

const fixture = {
  generatedFrom: 'lib/usage/model-usage-pricing.js + lib/usage/model-usage-identity.js',
  providerIds: listProviderIds(),
  catalog: CATALOG,
  matches,
  costs
};

const target = process.argv[2] || path.join(__dirname, '..', 'internal', 'adapters', 'usagepricing', 'testdata', 'parity.json');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(fixture, null, 2) + '\n');
process.stdout.write('wrote ' + target + ' (' + matches.length + ' matches, ' + costs.length + ' costs)\n');

