'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CANONICAL_RESPONSE_PROTOCOL,
  convertProtocolResponseViaCanonical,
  parseProtocolResponseToCanonical,
  renderCanonicalResponse
} = require('../lib/server/protocol-canonical-response');

const TOOL_ID = 'call_lookup_1';
const MODEL = 'shared-model';

const sourceFixtures = {
  anthropic_messages: {
    id: 'message-1',
    model: MODEL,
    content: [
      { type: 'text', text: 'answer' },
      {
        type: 'tool_use',
        id: TOOL_ID,
        name: 'lookup',
        input: { query: 'x' }
      }
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 3, output_tokens: 5 }
  },
  openai_chat: {
    id: 'message-1',
    model: MODEL,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: 'answer',
        tool_calls: [{
          id: TOOL_ID,
          type: 'function',
          function: { name: 'lookup', arguments: '{"query":"x"}' }
        }]
      },
      finish_reason: 'tool_calls'
    }],
    usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 }
  },
  openai_responses: {
    id: 'message-1',
    model: MODEL,
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'answer' }]
      },
      {
        type: 'function_call',
        call_id: TOOL_ID,
        name: 'lookup',
        arguments: '{"query":"x"}'
      }
    ],
    usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 }
  },
  gemini_generate_content: {
    id: 'message-1',
    modelVersion: MODEL,
    candidates: [{
      index: 0,
      content: {
        role: 'model',
        parts: [
          { text: 'answer' },
          { functionCall: { id: TOOL_ID, name: 'lookup', args: { query: 'x' } } }
        ]
      },
      finishReason: 'STOP'
    }],
    usageMetadata: {
      promptTokenCount: 3,
      candidatesTokenCount: 5,
      totalTokenCount: 8
    }
  }
};

test('all non-stream response protocols normalize to one canonical result shape', () => {
  Object.entries(sourceFixtures).forEach(([protocol, payload]) => {
    const canonical = parseProtocolResponseToCanonical(protocol, payload);
    assert.equal(canonical.model, MODEL);
    assert.equal(canonical.finishReason, 'tool_calls');
    assert.deepEqual(canonical.usage, {
      inputTokens: 3,
      outputTokens: 5,
      totalTokens: 8
    });
    assert.equal(canonical.parts.find((part) => part.type === 'text').text, 'answer');
    assert.deepEqual(
      canonical.parts.find((part) => part.type === 'tool_call'),
      {
        type: 'tool_call',
        id: TOOL_ID,
        name: 'lookup',
        arguments: '{"query":"x"}'
      }
    );
  });
});

test('canonical result renderers preserve text, tools, finish reason, and usage', () => {
  const canonical = parseProtocolResponseToCanonical(
    'anthropic_messages',
    sourceFixtures.anthropic_messages
  );

  const chat = renderCanonicalResponse('openai_chat', canonical, { clock: () => 1000 });
  assert.equal(chat.choices[0].finish_reason, 'tool_calls');
  assert.equal(chat.choices[0].message.content, 'answer');
  assert.equal(chat.choices[0].message.tool_calls[0].function.name, 'lookup');
  assert.deepEqual(chat.usage, {
    prompt_tokens: 3,
    completion_tokens: 5,
    total_tokens: 8
  });

  const gemini = renderCanonicalResponse('gemini_generate_content', canonical);
  assert.equal(gemini.candidates[0].content.parts[1].functionCall.name, 'lookup');

  const responses = renderCanonicalResponse('openai_responses', canonical, {
    clock: () => 1000
  });
  assert.deepEqual(responses.output.map((item) => item.type), [
    'message',
    'function_call'
  ]);
});

test('cross-protocol non-stream conversion declares the canonical response pipeline', () => {
  const converted = convertProtocolResponseViaCanonical({
    sourceProtocol: 'anthropic_messages',
    targetProtocol: 'openai_responses',
    payload: sourceFixtures.anthropic_messages,
    context: { clock: () => 1000 }
  });

  assert.equal(converted.canonicalProtocol, CANONICAL_RESPONSE_PROTOCOL);
  assert.deepEqual(converted.adapters, [
    'anthropic_messages->aih_canonical_response',
    'aih_canonical_response->openai_responses'
  ]);
  assert.equal(converted.payload.output[1].call_id, TOOL_ID);
});
