'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  collectGeminiFunctionDeclarations,
  mapAnthropicToolChoiceToGemini,
  mapAnthropicToolsToGemini,
  mapGeminiToolConfigToAnthropic,
  mapGeminiToolConfigToOpenAI,
  mapGeminiToolConfigToOpenAIResponses,
  mapGeminiToolsToAnthropic,
  mapGeminiToolsToOpenAI,
  mapGeminiToolsToOpenAIResponses,
  mapOpenAIToolChoiceToGemini,
  mapOpenAIToolsToGemini
} = require('../lib/protocol/gemini-tools');

test('Gemini tool helpers preserve arbitrary tool declarations without Read-specific assumptions', () => {
  const tools = [{
    function_declarations: [{
      name: 'CustomLookup',
      description: 'Lookup custom data',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' }
        },
        required: ['query']
      }
    }]
  }];

  assert.deepEqual(collectGeminiFunctionDeclarations(tools), [{
    name: 'CustomLookup',
    description: 'Lookup custom data',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string' }
      },
      required: ['query']
    }
  }]);
  assert.equal(mapGeminiToolsToOpenAI(tools)[0].function.name, 'CustomLookup');
  assert.equal(mapGeminiToolsToAnthropic(tools)[0].name, 'CustomLookup');
  assert.equal(mapGeminiToolsToOpenAIResponses(tools)[0].name, 'CustomLookup');
});

test('Gemini tool config maps function calling choices across target protocols', () => {
  const toolConfig = {
    function_calling_config: {
      mode: 'ANY',
      allowed_function_names: ['CustomLookup']
    }
  };

  assert.deepEqual(mapGeminiToolConfigToOpenAI(toolConfig), {
    type: 'function',
    function: { name: 'CustomLookup' }
  });
  assert.deepEqual(mapGeminiToolConfigToAnthropic(toolConfig), {
    type: 'tool',
    name: 'CustomLookup'
  });
  assert.deepEqual(mapGeminiToolConfigToOpenAIResponses(toolConfig), {
    type: 'function',
    name: 'CustomLookup'
  });
});

test('Gemini tool helpers map source protocol tool choices into Gemini config', () => {
  assert.deepEqual(
    mapAnthropicToolChoiceToGemini('none'),
    { functionCallingConfig: { mode: 'NONE' } }
  );
  assert.deepEqual(
    mapAnthropicToolChoiceToGemini({ type: 'tool', name: 'mcp/server/read' }, {
      mapName: (name) => name.replace(/\W/g, '_')
    }),
    { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['mcp_server_read'] } }
  );
  assert.deepEqual(
    mapAnthropicToolChoiceToGemini({ type: 'tool', name: 'CustomLookup' }),
    { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['CustomLookup'] } }
  );
  assert.deepEqual(
    mapOpenAIToolChoiceToGemini({ type: 'function', function: { name: 'CustomLookup' } }),
    { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['CustomLookup'] } }
  );
  assert.equal(mapAnthropicToolsToGemini([{ name: 'CustomLookup' }])[0].functionDeclarations[0].name, 'CustomLookup');
  assert.equal(
    mapOpenAIToolsToGemini([{ type: 'function', function: { name: 'CustomLookup' } }])[0].functionDeclarations[0].name,
    'CustomLookup'
  );
});
