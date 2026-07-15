const test = require('node:test');
const assert = require('node:assert/strict');

const {
  convertOpenAIChatToAnthropicMessages,
  convertOpenAIChatToGeminiGenerateContent
} = require('../lib/server/protocol-openai-chat-request-adapters');

test('OpenAI Chat request adapters preserve arbitrary tool calls and results', () => {
  const payload = {
    model: 'claude-4-6-thinking',
    messages: [
      {
        role: 'assistant',
        content: 'Checking now.'
      },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_custom_lookup_1',
          type: 'function',
          function: {
            name: 'CustomLookup',
            arguments: '{"q":"adapter"}'
          }
        }]
      },
      {
        role: 'tool',
        tool_call_id: 'call_custom_lookup_1',
        content: '{"ok":true}'
      }
    ],
    tools: [{
      type: 'function',
      function: {
        name: 'CustomLookup',
        description: 'Lookup a custom value',
        parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }
      }
    }],
    tool_choice: { type: 'function', function: { name: 'CustomLookup' } }
  };

  const anthropic = convertOpenAIChatToAnthropicMessages(payload);
  assert.deepEqual(anthropic.tool_choice, { type: 'tool', name: 'CustomLookup' });
  assert.equal(anthropic.tools[0].name, 'CustomLookup');
  assert.deepEqual(anthropic.messages[1].content, [{
    type: 'tool_use',
    id: 'call_custom_lookup_1',
    name: 'CustomLookup',
    input: { q: 'adapter' }
  }]);
  assert.deepEqual(anthropic.messages[2].content, [{
    type: 'tool_result',
    tool_use_id: 'call_custom_lookup_1',
    content: '{"ok":true}'
  }]);

  const gemini = convertOpenAIChatToGeminiGenerateContent(payload);
  assert.equal(gemini.contents[0].parts[1].functionCall.name, 'CustomLookup');
  assert.equal(gemini.contents[1].parts[0].functionResponse.name, 'CustomLookup');
  assert.equal(gemini.tools[0].functionDeclarations[0].name, 'CustomLookup');
  assert.deepEqual(
    gemini.toolConfig.functionCallingConfig.allowedFunctionNames,
    ['CustomLookup']
  );
});
