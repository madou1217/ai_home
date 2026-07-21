'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  convertAnthropicMessageToGeminiGenerateContent,
  convertAnthropicMessageToOpenAIChatCompletion,
  convertAnthropicMessageToOpenAIResponse,
  readAnthropicMessageModel,
  readAnthropicTextContent
} = require('../lib/server/protocol-anthropic-response-adapters');

test('Anthropic response adapters preserve arbitrary tool calls across target protocols', () => {
  const message = {
    id: 'msg_custom_tool',
    model: 'agy-claude',
    stop_reason: 'tool_use',
    content: [{
      type: 'tool_use',
      id: 'toolu_custom_1',
      name: 'CustomLookup',
      input: { query: 'x' }
    }],
    usage: {
      input_tokens: 3,
      output_tokens: 5
    }
  };

  assert.equal(readAnthropicMessageModel(message, 'fallback'), 'agy-claude');

  const chat = convertAnthropicMessageToOpenAIChatCompletion(message, 'fallback');
  assert.equal(chat.choices[0].finish_reason, 'tool_calls');
  assert.equal(chat.choices[0].message.tool_calls[0].function.name, 'CustomLookup');
  assert.equal(chat.choices[0].message.tool_calls[0].function.arguments, '{"query":"x"}');
  assert.deepEqual(chat.usage, { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 });

  const response = convertAnthropicMessageToOpenAIResponse(message, 'fallback');
  assert.deepEqual(response.output, [{
    id: 'fc_toolu_custom_1',
    type: 'function_call',
    status: 'completed',
    call_id: 'toolu_custom_1',
    name: 'CustomLookup',
    arguments: '{"query":"x"}'
  }]);

  const gemini = convertAnthropicMessageToGeminiGenerateContent(message, 'fallback');
  assert.deepEqual(gemini.candidates[0].content.parts, [{
    functionCall: {
      id: 'toolu_custom_1',
      name: 'CustomLookup',
      args: { query: 'x' }
    }
  }]);
});

test('Anthropic response adapters preserve thinking blocks for Gemini target', () => {
  const message = {
    model: 'claude-sonnet-4',
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking', thinking: 'thinking', signature: 'sig_1' },
      { type: 'text', text: 'answer' }
    ]
  };

  assert.equal(readAnthropicTextContent(message.content), 'answer');

  const gemini = convertAnthropicMessageToGeminiGenerateContent(message, 'fallback');
  assert.deepEqual(gemini.candidates[0].content.parts, [
    { thought: true, text: 'thinking', thoughtSignature: 'sig_1' },
    { text: 'answer' }
  ]);
});

test('Anthropic response adapters fall back to empty assistant content', () => {
  const chat = convertAnthropicMessageToOpenAIChatCompletion({ id: 'empty' }, 'fallback-model');
  assert.equal(chat.model, 'fallback-model');
  assert.equal(chat.choices[0].message.content, '');

  const response = convertAnthropicMessageToOpenAIResponse({ id: 'empty' }, 'fallback-model');
  assert.equal(response.model, 'fallback-model');
  assert.equal(response.output[0].content[0].text, '');

  const gemini = convertAnthropicMessageToGeminiGenerateContent({ id: 'empty' }, 'fallback-model');
  assert.equal(gemini.modelVersion, 'fallback-model');
  assert.deepEqual(gemini.candidates[0].content.parts, [{ text: '' }]);
});
