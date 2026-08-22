'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_ALWAYS_THINKING_MODELS,
  DEFAULT_THINKING_BUDGET_TOKENS,
  ensureZcodeThinkingBuffer,
  injectZcodeThinking,
  isAlwaysThinkingModel,
  resolveAlwaysThinkingModels,
  resolveThinkingBudgetTokens
} = require('../lib/server/zcode-anthropic-thinking');

test('isAlwaysThinkingModel matches bare and prefixed always-thinking model ids', () => {
  assert.equal(isAlwaysThinkingModel('glm-5.3'), true);
  assert.equal(isAlwaysThinkingModel('GLM-5.3'), true, '大小写不敏感');
  assert.equal(isAlwaysThinkingModel('opencode-go/glm-5.3'), true, '路由前缀剥掉后按裸 ID 判定');
  assert.equal(isAlwaysThinkingModel('glm-5.2'), false, 'glm-5.2 实测免参，不得误伤');
  assert.equal(isAlwaysThinkingModel('glm-4.7'), false);
  assert.equal(isAlwaysThinkingModel(''), false);
  assert.equal(isAlwaysThinkingModel(undefined), false);
});

test('resolveAlwaysThinkingModels honours the env override and falls back to the default', () => {
  assert.deepEqual(
    resolveAlwaysThinkingModels({ AIH_ZCODE_ALWAYS_THINKING_MODELS: ' glm-5.4 , glm-6 ' }),
    ['glm-5.4', 'glm-6']
  );
  assert.deepEqual(resolveAlwaysThinkingModels({}), DEFAULT_ALWAYS_THINKING_MODELS);
  assert.deepEqual(
    resolveAlwaysThinkingModels({ AIH_ZCODE_ALWAYS_THINKING_MODELS: ' , ' }),
    DEFAULT_ALWAYS_THINKING_MODELS,
    '全空条目回退默认清单'
  );
});

test('injectZcodeThinking injects a bounded thinking config for always-thinking models', () => {
  const injected = injectZcodeThinking({
    model: 'glm-5.3',
    max_tokens: 4096,
    messages: [{ role: 'user', content: 'hi' }]
  });
  assert.deepEqual(injected.thinking, { type: 'enabled', budget_tokens: DEFAULT_THINKING_BUDGET_TOKENS });
  assert.equal(injected.model, 'glm-5.3');
  assert.equal(injected.messages.length, 1, '其余字段原样保留');
});

test('injectZcodeThinking clamps the budget inside small max_tokens requests', () => {
  const injected = injectZcodeThinking({ model: 'glm-5.3', max_tokens: 200, messages: [] });
  assert.equal(injected.thinking.budget_tokens, 200, 'budget 夹在 max_tokens 内（实测 budget==max 可行）');
  const noMax = injectZcodeThinking({ model: 'glm-5.3', messages: [] });
  assert.equal(noMax.thinking.budget_tokens, DEFAULT_THINKING_BUDGET_TOKENS);
});

test('injectZcodeThinking never touches explicit client thinking or unrelated models', () => {
  const explicit = { model: 'glm-5.3', max_tokens: 4096, thinking: { type: 'enabled', budget_tokens: 2048 }, messages: [] };
  assert.equal(injectZcodeThinking(explicit), explicit, '客户端显式 thinking 原对象返回');

  const hybrid = { model: 'glm-5.2', max_tokens: 4096, messages: [] };
  assert.equal(injectZcodeThinking(hybrid), hybrid, '非清单模型不改写');

  const disabled = { model: 'glm-5.3', max_tokens: 4096, thinking: { type: 'disabled' }, messages: [] };
  assert.equal(injectZcodeThinking(disabled), disabled, '显式关闭思考也尊重');
});

test('resolveThinkingBudgetTokens keeps the budget within validated bounds', () => {
  assert.equal(resolveThinkingBudgetTokens(4096), 1024);
  assert.equal(resolveThinkingBudgetTokens(200), 200);
  assert.equal(resolveThinkingBudgetTokens(undefined), DEFAULT_THINKING_BUDGET_TOKENS);
  assert.equal(resolveThinkingBudgetTokens(-1), DEFAULT_THINKING_BUDGET_TOKENS);
});

test('ensureZcodeThinkingBuffer rewrites only eligible JSON bodies and passes the rest through', () => {
  const eligible = Buffer.from(JSON.stringify({ model: 'opencode-go/glm-5.3', max_tokens: 1024, messages: [] }));
  const rewritten = ensureZcodeThinkingBuffer(eligible);
  const parsed = JSON.parse(rewritten.toString('utf8'));
  assert.deepEqual(parsed.thinking, { type: 'enabled', budget_tokens: 1024 });

  const untouched = Buffer.from(JSON.stringify({ model: 'glm-5.2', max_tokens: 1024, messages: [] }));
  assert.equal(ensureZcodeThinkingBuffer(untouched), untouched, '未命中清单返回同一 Buffer');

  const explicit = Buffer.from(JSON.stringify({ model: 'glm-5.3', thinking: { type: 'enabled', budget_tokens: 64 }, messages: [] }));
  assert.equal(ensureZcodeThinkingBuffer(explicit), explicit, '已有 thinking 返回同一 Buffer');

  const notJson = Buffer.from('not-json');
  assert.equal(ensureZcodeThinkingBuffer(notJson), notJson, '非 JSON body 原样放行');

  // 空缓冲不是 Buffer 语义下的 JSON，直接原样返回
  const empty = Buffer.alloc(0);
  assert.equal(ensureZcodeThinkingBuffer(empty), empty);
});
