'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  convertGeminiGenerateContentResponseToAnthropicMessage,
  convertGeminiGenerateContentResponseToOpenAIChatCompletion,
  convertGeminiGenerateContentResponseToOpenAIResponse,
  readGeminiResponseModel,
  readGeminiResponseParts
} = require('../lib/server/protocol-gemini-response-adapters');

test('Gemini response adapters preserve arbitrary tool calls across target protocols', () => {
  const gemini = {
    id: 'gemini_resp_1',
    model_version: 'agy-claude',
    candidates: [{
      index: 2,
      finishReason: 'STOP',
      content: {
        role: 'model',
        parts: [
          { text: 'checking' },
          { functionCall: { id: 'call_custom_1', name: 'CustomLookup', args: { query: 'x' } } }
        ]
      }
    }],
    usageMetadata: {
      promptTokenCount: 3,
      candidatesTokenCount: 5,
      totalTokenCount: 8
    }
  };

  assert.equal(readGeminiResponseModel(gemini, 'fallback'), 'agy-claude');
  assert.deepEqual(readGeminiResponseParts(gemini).map((part) => part.type), ['text', 'tool_call']);

  const anthropic = convertGeminiGenerateContentResponseToAnthropicMessage(gemini, 'fallback');
  assert.equal(anthropic.stop_reason, 'tool_use');
  assert.deepEqual(anthropic.content[1], {
    type: 'tool_use',
    id: 'call_custom_1',
    name: 'CustomLookup',
    input: { query: 'x' }
  });
  assert.deepEqual(anthropic.usage, { input_tokens: 3, output_tokens: 5 });

  const chat = convertGeminiGenerateContentResponseToOpenAIChatCompletion(gemini, 'fallback');
  assert.equal(chat.choices[0].index, 2);
  assert.equal(chat.choices[0].finish_reason, 'tool_calls');
  assert.equal(chat.choices[0].message.tool_calls[0].function.name, 'CustomLookup');
  assert.equal(chat.choices[0].message.tool_calls[0].function.arguments, '{"query":"x"}');

  const response = convertGeminiGenerateContentResponseToOpenAIResponse(gemini, 'fallback');
  assert.equal(response.finish_reason, 'tool_calls');
  assert.deepEqual(response.output.map((item) => item.type), ['message', 'function_call']);
  assert.equal(response.output[1].call_id, 'call_custom_1');
  assert.equal(response.output[1].name, 'CustomLookup');
});

test('Gemini response adapter normalizes Agent tool input for Anthropic messages', () => {
  const gemini = {
    id: 'gemini_agent_1',
    modelVersion: 'gemini-3-flash-a',
    candidates: [{
      content: {
        role: 'model',
        parts: [{
          functionCall: {
            id: 'call_agent_1',
            name: 'Agent',
            args: {
              subagent_type: 'Explore',
              args: [],
              message: 'Please search the web/src folder for chat session persistence issues.'
            }
          }
        }]
      },
      finishReason: 'STOP'
    }]
  };

  const anthropic = convertGeminiGenerateContentResponseToAnthropicMessage(gemini, 'fallback');
  assert.equal(anthropic.stop_reason, 'tool_use');
  assert.deepEqual(anthropic.content[0], {
    type: 'tool_use',
    id: 'call_agent_1',
    name: 'Agent',
    input: {
      subagent_type: 'Explore',
      prompt: 'Please search the web/src folder for chat session persistence issues.',
      description: 'Please search the web/src folder for chat session persistence issues.'
    }
  });

  const chat = convertGeminiGenerateContentResponseToOpenAIChatCompletion(gemini, 'fallback');
  assert.equal(
    chat.choices[0].message.tool_calls[0].function.arguments,
    '{"subagent_type":"Explore","args":[],"message":"Please search the web/src folder for chat session persistence issues."}'
  );
});

test('Gemini response adapters fall back to empty assistant text for empty candidates', () => {
  const anthropic = convertGeminiGenerateContentResponseToAnthropicMessage({ id: 'empty' }, 'fallback-model');
  assert.equal(anthropic.model, 'fallback-model');
  assert.deepEqual(anthropic.content, [{ type: 'text', text: '' }]);

  const chat = convertGeminiGenerateContentResponseToOpenAIChatCompletion({ id: 'empty' }, 'fallback-model');
  assert.equal(chat.model, 'fallback-model');
  assert.equal(chat.choices[0].message.content, '');

  const response = convertGeminiGenerateContentResponseToOpenAIResponse({ id: 'empty' }, 'fallback-model');
  assert.equal(response.model, 'fallback-model');
  assert.equal(response.output[0].content[0].text, '');
});
