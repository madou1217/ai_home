'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  reserveAnswerBudgetForCodeAssistThinking
} = require('../lib/server/code-assist-provider-strategy');

// agy/antigravity 把网关注入的思考 token 计入 maxOutputTokens；客户端 max_tokens 只为答案预算。
// 不预留就会出现"只有 Thought process、没有任何回答"。这里覆盖各 thinking 形状的预留行为。

test('unlimited thinking budget (-1) reserves answer room on top of client max_tokens', () => {
  const cfg = { maxOutputTokens: 300, thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } };
  reserveAnswerBudgetForCodeAssistThinking(cfg);
  // reserve = clamp(300, 8192, 32768) = 8192 → 答案仍保留 300 的预算
  assert.equal(cfg.maxOutputTokens, 300 + 8192);
});

test('large client max_tokens uses proportional reserve capped at 32768', () => {
  const cfg = { maxOutputTokens: 40000, thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } };
  reserveAnswerBudgetForCodeAssistThinking(cfg);
  assert.equal(cfg.maxOutputTokens, 40000 + 32768);
});

test('positive thinking budget reserves exactly that budget', () => {
  const cfg = { maxOutputTokens: 1000, thinkingConfig: { includeThoughts: true, thinkingBudget: 2048 } };
  reserveAnswerBudgetForCodeAssistThinking(cfg);
  assert.equal(cfg.maxOutputTokens, 1000 + 2048);
});

test('thinkingLevel (level mode) also reserves answer room', () => {
  const cfg = { maxOutputTokens: 4096, thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' } };
  reserveAnswerBudgetForCodeAssistThinking(cfg);
  assert.equal(cfg.maxOutputTokens, 4096 + 8192);
});

test('no thinking config => maxOutputTokens untouched', () => {
  const cfg = { maxOutputTokens: 300 };
  reserveAnswerBudgetForCodeAssistThinking(cfg);
  assert.equal(cfg.maxOutputTokens, 300);
});

test('thinking present but no maxOutputTokens => untouched (no client cap to starve)', () => {
  const cfg = { thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } };
  reserveAnswerBudgetForCodeAssistThinking(cfg);
  assert.equal(Object.hasOwn(cfg, 'maxOutputTokens'), false);
});

test('disabled thinking (budget 0) => untouched', () => {
  const cfg = { maxOutputTokens: 300, thinkingConfig: { includeThoughts: false, thinkingBudget: 0 } };
  reserveAnswerBudgetForCodeAssistThinking(cfg);
  assert.equal(cfg.maxOutputTokens, 300);
});
