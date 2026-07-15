'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  convertOpenAIChatCompletionToAnthropicMessage,
  convertOpenAIChatCompletionToGeminiGenerateContent,
  convertOpenAIChatCompletionToOpenAIResponse,
  readOpenAIChatCompletionModel,
  readOpenAIChatChoiceMessage
} = require('../lib/server/protocol-openai-chat-response-adapters');

test('OpenAI Chat response adapters preserve arbitrary tool calls across target protocols', () => {
  const completion = {
    id: 'chatcmpl_custom_tool',
    created: 1700000000,
    model: 'agy-claude',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_custom_1',
          type: 'function',
          function: {
            name: 'CustomLookup',
            arguments: '{"query":"x"}'
          }
        }]
      }
    }],
    usage: {
      prompt_tokens: 3,
      completion_tokens: 5,
      total_tokens: 8
    }
  };

  assert.equal(readOpenAIChatCompletionModel(completion, 'fallback'), 'agy-claude');
  assert.equal(readOpenAIChatChoiceMessage(completion.choices[0]).tool_calls[0].function.name, 'CustomLookup');

  const anthropic = convertOpenAIChatCompletionToAnthropicMessage(completion, 'fallback');
  assert.equal(anthropic.stop_reason, 'tool_use');
  assert.deepEqual(anthropic.content, [{
    type: 'tool_use',
    id: 'call_custom_1',
    name: 'CustomLookup',
    input: { query: 'x' }
  }]);
  assert.deepEqual(anthropic.usage, { input_tokens: 3, output_tokens: 5 });

  const gemini = convertOpenAIChatCompletionToGeminiGenerateContent(completion, 'fallback');
  assert.deepEqual(gemini.candidates[0].content.parts, [{
    functionCall: {
      id: 'call_custom_1',
      name: 'CustomLookup',
      args: { query: 'x' }
    }
  }]);

  const response = convertOpenAIChatCompletionToOpenAIResponse(completion, 'fallback');
  assert.deepEqual(response.output, [{
    id: 'fc_call_custom_1',
    type: 'function_call',
    status: 'completed',
    call_id: 'call_custom_1',
    name: 'CustomLookup',
    arguments: '{"query":"x"}'
  }]);
});

test('OpenAI Chat response adapters preserve reasoning text for Gemini target', () => {
  const completion = {
    model: 'gemini-3.1-pro-preview',
    choices: [{
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        reasoning_content: 'thinking',
        content: 'answer'
      }
    }]
  };

  const gemini = convertOpenAIChatCompletionToGeminiGenerateContent(completion, 'fallback');
  assert.deepEqual(gemini.candidates[0].content.parts, [
    { thought: true, text: 'thinking' },
    { text: 'answer' }
  ]);
});

test('OpenAI Chat response adapters fall back to empty assistant content', () => {
  const anthropic = convertOpenAIChatCompletionToAnthropicMessage({ id: 'empty' }, 'fallback-model');
  assert.equal(anthropic.model, 'fallback-model');
  assert.deepEqual(anthropic.content, [{ type: 'text', text: '' }]);

  const gemini = convertOpenAIChatCompletionToGeminiGenerateContent({ id: 'empty' }, 'fallback-model');
  assert.equal(gemini.modelVersion, 'fallback-model');
  assert.deepEqual(gemini.candidates[0].content.parts, [{ text: '' }]);

  const response = convertOpenAIChatCompletionToOpenAIResponse({ id: 'empty' }, 'fallback-model');
  assert.equal(response.model, 'fallback-model');
  assert.equal(response.output[0].content[0].text, '');
});
