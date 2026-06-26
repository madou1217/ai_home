'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
