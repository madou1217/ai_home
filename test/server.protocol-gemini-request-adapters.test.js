'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractGeminiModelFromPath,
  convertGeminiGenerateContentToAnthropicMessages,
  convertGeminiGenerateContentToOpenAIChat,
  convertGeminiGenerateContentToOpenAIResponses
} = require('../lib/server/protocol-gemini-request-adapters');

test('Gemini request adapters preserve generic tool call pairing without Read-specific names', () => {
  const payload = {
    contents: [
      { role: 'user', parts: [{ text: 'lookup codex' }] },
      {
        role: 'model',
        parts: [{
          functionCall: {
            name: 'CustomLookup',
            args: { query: 'codex' }
          }
        }]
      },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            name: 'CustomLookup',
            response: { result: 'found' }
          }
        }]
      }
    ],
    generationConfig: { maxOutputTokens: 123 }
  };

  const pathname = '/v1beta/models/gemini-test-model:generateContent';
  const anthropic = convertGeminiGenerateContentToAnthropicMessages(payload, pathname, true);
  assert.equal(anthropic.model, 'gemini-test-model');
  assert.equal(anthropic.stream, true);
  assert.deepEqual(anthropic.messages[1], {
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'toolu_1',
      name: 'CustomLookup',
      input: { query: 'codex' }
    }]
  });
  assert.deepEqual(anthropic.messages[2], {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: 'found'
    }]
  });

  const openai = convertGeminiGenerateContentToOpenAIChat(payload, pathname, false);
  assert.equal(openai.model, 'gemini-test-model');
  assert.deepEqual(openai.messages[1].tool_calls[0], {
    id: 'call_1',
    type: 'function',
    function: {
      name: 'CustomLookup',
      arguments: '{"query":"codex"}'
    }
  });
  assert.equal(openai.messages[2].tool_call_id, 'call_1');

  const responses = convertGeminiGenerateContentToOpenAIResponses(payload, pathname, true);
  assert.equal(responses.model, 'gemini-test-model');
  assert.equal(responses.stream, true);
  assert.deepEqual(responses.input.filter((item) => item.type === 'function_call'), [{
    type: 'function_call',
    call_id: 'call_1',
    name: 'CustomLookup',
    arguments: '{"query":"codex"}'
  }]);
  assert.deepEqual(responses.input.filter((item) => item.type === 'function_call_output'), [{
    type: 'function_call_output',
    call_id: 'call_1',
    output: 'found'
  }]);
});

test('Gemini request adapter model parser handles encoded model path', () => {
  assert.equal(
    extractGeminiModelFromPath('/v1/models/gemini%2Fcustom:streamGenerateContent'),
    'gemini/custom'
  );
});
