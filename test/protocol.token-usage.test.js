'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  anthropicTotalInputTokens,
  mergeAnthropicStreamUsage,
  mapAnthropicUsageToOpenAIChat,
  mapGeminiResponseUsageToAnthropic,
  mapGeminiResponseUsageToOpenAIChat,
  mapGeminiResponseUsageToOpenAIResponse,
  mapOpenAIChatUsageToAnthropic,
  mapOpenAIResponseUsageToAnthropic,
  mapOpenAIResponseUsageToGemini
} = require('../lib/protocol/token-usage');

test('token usage helpers map OpenAI Chat and Anthropic usage symmetrically', () => {
  assert.deepEqual(mapOpenAIChatUsageToAnthropic({ prompt_tokens: 7, completion_tokens: 3 }), {
    input_tokens: 7,
    output_tokens: 3
  });
  assert.deepEqual(mapAnthropicUsageToOpenAIChat({ input_tokens: 7, output_tokens: 3 }), {
    prompt_tokens: 7,
    completion_tokens: 3,
    total_tokens: 10
  });
});

test('token usage helpers map OpenAI Responses usage to target protocols', () => {
  const usage = { input_tokens: 7, output_tokens: 3, total_tokens: 10 };

  assert.deepEqual(mapOpenAIResponseUsageToAnthropic(usage), {
    input_tokens: 7,
    output_tokens: 3
  });
  assert.deepEqual(mapOpenAIResponseUsageToGemini(usage), {
    promptTokenCount: 7,
    candidatesTokenCount: 3,
    totalTokenCount: 10
  });
});

test('Anthropic input usage counts prompt-cache reads and writes as context', () => {
  const usage = { input_tokens: 5, cache_read_input_tokens: 9000, cache_creation_input_tokens: 40, output_tokens: 7 };

  assert.equal(anthropicTotalInputTokens(usage), 9045);
  assert.equal(anthropicTotalInputTokens({ output_tokens: 7 }), null);
  assert.deepEqual(mapAnthropicUsageToOpenAIChat(usage), {
    prompt_tokens: 9045,
    completion_tokens: 7,
    total_tokens: 9052
  });
});

test('Anthropic stream usage keeps input reported late in message_delta', () => {
  // MTPLX and similar servers send zero input in message_start and the real count in message_delta.
  const started = mergeAnthropicStreamUsage(null, { input_tokens: 0, output_tokens: 0 });
  assert.deepEqual(mergeAnthropicStreamUsage(started, { input_tokens: 15, output_tokens: 60 }), {
    input_tokens: 15,
    output_tokens: 60
  });
});

test('Anthropic stream usage keeps message_start input when message_delta only reports output', () => {
  const started = mergeAnthropicStreamUsage(null, { input_tokens: 12, cache_read_input_tokens: 300, output_tokens: 1 });
  assert.deepEqual(mergeAnthropicStreamUsage(started, { output_tokens: 42 }), {
    input_tokens: 312,
    output_tokens: 42
  });
  assert.deepEqual(mergeAnthropicStreamUsage(started, { input_tokens: 0, output_tokens: 0 }), {
    input_tokens: 312,
    output_tokens: 1
  });
});

test('token usage helpers map Gemini usage to target protocols', () => {
  const usage = { prompt_token_count: 7, candidates_token_count: 3, total_token_count: 10 };

  assert.deepEqual(mapGeminiResponseUsageToAnthropic(usage), {
    input_tokens: 7,
    output_tokens: 3
  });
  assert.deepEqual(mapGeminiResponseUsageToOpenAIChat(usage), {
    prompt_tokens: 7,
    completion_tokens: 3,
    total_tokens: 10
  });
  assert.deepEqual(mapGeminiResponseUsageToOpenAIResponse(usage), {
    input_tokens: 7,
    output_tokens: 3,
    total_tokens: 10
  });
});
