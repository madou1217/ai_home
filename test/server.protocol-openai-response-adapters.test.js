'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  convertOpenAIResponseToAnthropicMessage,
  convertOpenAIResponseToGeminiGenerateContent,
  readOpenAIResponseOutputItems,
  resolveOpenAIResponseFinishReason
} = require('../lib/server/protocol-openai-response-adapters');

test('OpenAI Responses adapters preserve arbitrary tool calls across target protocols', () => {
  const response = {
    id: 'resp_custom_tool',
    status: 'completed',
    model: 'gpt-5.3-codex',
    output: [{
      type: 'function_call',
      call_id: 'call_custom_1',
      name: 'CustomLookup',
      arguments: '{"query":"x"}'
    }],
    usage: {
      input_tokens: 3,
      output_tokens: 5,
      total_tokens: 8
    }
  };

  const anthropic = convertOpenAIResponseToAnthropicMessage(response, 'fallback');
  assert.equal(anthropic.stop_reason, 'tool_use');
  assert.deepEqual(anthropic.content, [{
    type: 'tool_use',
    id: 'call_custom_1',
    name: 'CustomLookup',
    input: { query: 'x' }
  }]);
  assert.deepEqual(anthropic.usage, { input_tokens: 3, output_tokens: 5 });

  const gemini = convertOpenAIResponseToGeminiGenerateContent(response, 'fallback');
  assert.deepEqual(gemini.candidates[0].content.parts, [{
    functionCall: {
      id: 'call_custom_1',
      name: 'CustomLookup',
      args: { query: 'x' }
    }
  }]);
  assert.equal(gemini.candidates[0].finishReason, 'STOP');
});

test('OpenAI Responses adapters read output_text fallback and incomplete reason', () => {
  const response = {
    id: 'resp_text',
    status: 'incomplete',
    incomplete_details: { reason: 'max_tokens' },
    output_text: 'partial answer'
  };

  assert.equal(resolveOpenAIResponseFinishReason(response), 'max_tokens');
  assert.deepEqual(readOpenAIResponseOutputItems(response), [{
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'partial answer' }]
  }]);

  const anthropic = convertOpenAIResponseToAnthropicMessage(response, 'fallback-model');
  assert.equal(anthropic.stop_reason, 'max_tokens');
  assert.deepEqual(anthropic.content, [{ type: 'text', text: 'partial answer' }]);
});

test('OpenAI Responses adapters fall back to empty assistant content', () => {
  const anthropic = convertOpenAIResponseToAnthropicMessage({ id: 'empty' }, 'fallback-model');
  assert.equal(anthropic.model, 'fallback-model');
  assert.deepEqual(anthropic.content, [{ type: 'text', text: '' }]);

  const gemini = convertOpenAIResponseToGeminiGenerateContent({ id: 'empty' }, 'fallback-model');
  assert.equal(gemini.modelVersion, 'fallback-model');
  assert.deepEqual(gemini.candidates[0].content.parts, [{ text: '' }]);
});
