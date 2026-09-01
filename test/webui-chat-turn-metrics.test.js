'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildChatTurnMetrics } = require('../lib/server/webui-chat-routes');

test('OpenAI 形态 usage 映射为前端口径 outputTokens/inputTokens/tokensPerSec', () => {
  const metrics = buildChatTurnMetrics({
    durationMs: 2000,
    ttftMs: 300,
    usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 }
  });

  assert.equal(metrics.durationMs, 2000);
  assert.equal(metrics.ttftMs, 300);
  assert.equal(metrics.outputTokens, 60);
  assert.equal(metrics.inputTokens, 120);
  assert.equal(metrics.tokensPerSec, 30);
});

test('Anthropic 形态 usage(output_tokens/input_tokens)同样映射', () => {
  const metrics = buildChatTurnMetrics({
    durationMs: 4000,
    ttftMs: undefined,
    usage: { input_tokens: 10, output_tokens: 40 }
  });

  assert.equal(metrics.outputTokens, 40);
  assert.equal(metrics.inputTokens, 10);
  assert.equal(metrics.tokensPerSec, 10);
});

test('上游未提供 usage 时不编造 token 指标，只保留计时', () => {
  const metrics = buildChatTurnMetrics({ durationMs: 1500, ttftMs: 200, usage: null });

  assert.deepEqual(metrics, { durationMs: 1500, ttftMs: 200 });
});

test('usage 字段全为 0 时视为不可用，不落 token 指标', () => {
  const metrics = buildChatTurnMetrics({
    durationMs: 1000,
    ttftMs: 100,
    usage: { prompt_tokens: 0, completion_tokens: 0 }
  });

  assert.equal('outputTokens' in metrics, false);
  assert.equal('inputTokens' in metrics, false);
  assert.equal('tokensPerSec' in metrics, false);
});
