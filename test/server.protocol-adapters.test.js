const test = require('node:test');
const assert = require('node:assert/strict');

const {
  convertAnthropicMessagesToOpenAIChat,
  convertOpenAIChatToAnthropicMessages,
  convertGeminiGenerateContentToOpenAIChat,
  convertOpenAIResponsesToOpenAIChat,
  convertOpenAIChatCompletionToGeminiGenerateContent,
  convertOpenAIChatCompletionToOpenAIResponse,
  convertOpenAIChatSseToAnthropicSse,
  convertAnthropicSseToOpenAIChatSse,
  convertOpenAIChatSseToGeminiSse,
  convertOpenAIChatSseToOpenAIResponseSse
} = require('../lib/server/protocol-adapters');
const {
  detectClientProtocol,
  listClientProtocols
} = require('../lib/server/protocol-registry');
const {
  createSseTransformStream,
  listStreamPipelines
} = require('../lib/server/protocol-stream-pipeline');

test('protocol registry detects supported client protocols declaratively', () => {
  assert.equal(detectClientProtocol('POST', '/v1/messages'), 'anthropic_messages');
  assert.equal(detectClientProtocol('POST', '/v1/v1/messages'), 'anthropic_messages');
  assert.equal(detectClientProtocol('POST', '/v1beta/models/gemini-2.5-pro:generateContent'), 'gemini_generate_content');
  assert.equal(detectClientProtocol('POST', '/v1/models/gemini-2.5-pro:streamGenerateContent'), 'gemini_stream_generate_content');
  assert.equal(detectClientProtocol('POST', '/v1/chat/completions'), 'openai_chat');
  assert.equal(detectClientProtocol('POST', '/v1/v1/chat/completions'), 'openai_chat');
  assert.equal(detectClientProtocol('POST', '/v1/responses'), 'openai_responses');
  assert.equal(detectClientProtocol('GET', '/v1/responses'), '');
  assert.deepEqual(
    listClientProtocols().map((item) => item.canonical),
    ['openai_chat', 'openai_chat', 'openai_chat', 'openai_chat', 'openai_chat']
  );
});

test('stream pipeline registry declares canonical protocol transforms', () => {
  assert.deepEqual(
    listStreamPipelines().filter((item) => item.source === 'openai_chat').map((item) => item.target).sort(),
    ['anthropic_messages', 'gemini_generate_content', 'gemini_stream_generate_content', 'openai_responses'].sort()
  );
  assert.deepEqual(
    listStreamPipelines().filter((item) => item.source === 'anthropic_messages').map((item) => item.target).sort(),
    ['gemini_generate_content', 'gemini_stream_generate_content', 'openai_chat', 'openai_responses'].sort()
  );
});

test('stream transform can incrementally convert Anthropic SSE to OpenAI Chat SSE', () => {
  const chunks = [];
  const transform = createSseTransformStream('anthropic_messages', 'openai_chat', {
    fallbackModel: 'claude-sonnet-4',
    onChunk: (chunk) => chunks.push(chunk)
  });

  transform.write(`${[
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_tool","type":"message","role":"assistant","model":"claude-sonnet-4","content":[],"usage":{"input_tokens":2,"output_tokens":0}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup","input":{}}}',
    ''
  ].join('\n')}\n`);
  transform.write(`${[
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":":\\"x\\"}"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":3}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    ''
  ].join('\n')}\n`);
  transform.end();

  const output = chunks.join('');
  assert.match(output, /"delta":\{"role":"assistant"\}/);
  assert.match(output, /"tool_calls":\[\{"index":0,"id":"toolu_1","type":"function","function":\{"name":"lookup","arguments":""\}\}\]/);
  assert.match(output, /"tool_calls":\[\{"index":0,"function":\{"arguments":"\{\\"q\\""\}\}\]/);
  assert.match(output, /"finish_reason":"tool_calls"/);
});

test('protocol adapters preserve image parts between Anthropic Messages and OpenAI Chat', () => {
  const openAI = convertAnthropicMessagesToOpenAIChat({
    model: 'gpt-image-test',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'describe this' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'aW1n'
          }
        }
      ]
    }]
  });

  assert.equal(openAI.messages[0].role, 'user');
  assert.equal(Array.isArray(openAI.messages[0].content), true);
  assert.deepEqual(openAI.messages[0].content[0], { type: 'text', text: 'describe this' });
  assert.deepEqual(openAI.messages[0].content[1], {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,aW1n' }
  });

  const anthropic = convertOpenAIChatToAnthropicMessages({
    model: 'claude-sonnet-4',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'describe this' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,anBn' } }
      ]
    }]
  });

  assert.equal(anthropic.messages[0].role, 'user');
  assert.deepEqual(anthropic.messages[0].content[0], { type: 'text', text: 'describe this' });
  assert.deepEqual(anthropic.messages[0].content[1], {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/jpeg',
      data: 'anBn'
    }
  });
});

test('protocol adapters normalize OpenAI Responses function tools to Chat tools', () => {
  const chat = convertOpenAIResponsesToOpenAIChat({
    model: 'gpt-tool',
    input: 'lookup codex',
    tools: [{
      type: 'function',
      name: 'lookup',
      description: 'Lookup data',
      parameters: { type: 'object', properties: { q: { type: 'string' } } }
    }],
    tool_choice: { type: 'function', name: 'lookup' }
  });

  assert.deepEqual(chat.messages, [{ role: 'user', content: 'lookup codex' }]);
  assert.deepEqual(chat.tools, [{
    type: 'function',
    function: {
      name: 'lookup',
      description: 'Lookup data',
      parameters: { type: 'object', properties: { q: { type: 'string' } } }
    }
  }]);
  assert.deepEqual(chat.tool_choice, { type: 'function', function: { name: 'lookup' } });
});

test('protocol adapters preserve OpenAI tool calls and tool results for Anthropic Messages', () => {
  const anthropic = convertOpenAIChatToAnthropicMessages({
    model: 'claude-sonnet-4',
    messages: [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: {
            name: 'lookup',
            arguments: '{"q":"codex"}'
          }
        }]
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: '{"ok":true}'
      }
    ]
  });

  assert.deepEqual(anthropic.messages[0].content, [{
    type: 'tool_use',
    id: 'call_1',
    name: 'lookup',
    input: { q: 'codex' }
  }]);
  assert.deepEqual(anthropic.messages[1].content, [{
    type: 'tool_result',
    tool_use_id: 'call_1',
    content: '{"ok":true}'
  }]);
});

test('canonical stream pipeline renders OpenAI tool-call SSE to Anthropic and Gemini streams', () => {
  const sse = [
    'data: {"id":"chatcmpl_stream_tool","object":"chat.completion.chunk","created":1700000000,"model":"gpt-tool","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\"q\\""}}]},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl_stream_tool","object":"chat.completion.chunk","created":1700000000,"model":"gpt-tool","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"x\\"}"}}]},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl_stream_tool","object":"chat.completion.chunk","created":1700000000,"model":"gpt-tool","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
    '',
    'data: [DONE]',
    ''
  ].join('\n');

  const anthropic = convertOpenAIChatSseToAnthropicSse(sse, 'gpt-tool');
  assert.match(anthropic, /event: content_block_start/);
  assert.match(anthropic, /"type":"tool_use"/);
  assert.match(anthropic, /"partial_json":"\{\\"q\\""/);
  assert.match(anthropic, /"partial_json":":\\"x\\"}"/);
  assert.match(anthropic, /"stop_reason":"tool_use"/);

  const gemini = convertOpenAIChatSseToGeminiSse(sse, 'gpt-tool');
  assert.match(gemini, /"functionCall":\{"name":"lookup","args":\{"q":"x"\}\}/);
  assert.match(gemini, /"finishReason":"STOP"/);
});

test('canonical stream pipeline renders Anthropic tool_use SSE to OpenAI Chat chunks', () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_tool","type":"message","role":"assistant","model":"claude-sonnet-4","content":[],"usage":{"input_tokens":2,"output_tokens":0}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup","input":{}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":":\\"x\\"}"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":3}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    ''
  ].join('\n');

  const openAI = convertAnthropicSseToOpenAIChatSse(sse, 'claude-sonnet-4');
  assert.match(openAI, /"delta":\{"role":"assistant"\}/);
  assert.match(openAI, /"tool_calls":\[\{"index":0,"id":"toolu_1","type":"function","function":\{"name":"lookup","arguments":""\}\}\]/);
  assert.match(openAI, /"tool_calls":\[\{"index":0,"function":\{"arguments":"\{\\"q\\""\}\}\]/);
  assert.match(openAI, /"finish_reason":"tool_calls"/);
  assert.match(openAI, /"usage":\{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5\}/);
});

test('protocol adapters convert Gemini multimodal and function declarations to OpenAI Chat', () => {
  const openAI = convertGeminiGenerateContentToOpenAIChat({
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'look' },
          { inlineData: { mimeType: 'image/png', data: 'aW1n' } }
        ]
      },
      {
        role: 'model',
        parts: [{ functionCall: { name: 'lookup', args: { q: 'x' } } }]
      },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'lookup', response: { ok: true } } }]
      }
    ],
    tools: [{
      functionDeclarations: [{
        name: 'lookup',
        description: 'Lookup data',
        parameters: { type: 'object', properties: { q: { type: 'string' } } }
      }]
    }],
    toolConfig: {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: ['lookup']
      }
    }
  }, '/v1beta/models/gemini-2.5-pro:generateContent');

  assert.equal(openAI.model, 'gemini-2.5-pro');
  assert.equal(Array.isArray(openAI.messages[0].content), true);
  assert.deepEqual(openAI.messages[0].content[1], {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,aW1n' }
  });
  assert.equal(openAI.messages[1].role, 'assistant');
  assert.equal(openAI.messages[1].tool_calls[0].function.name, 'lookup');
  assert.equal(openAI.messages[2].role, 'tool');
  assert.equal(openAI.tools[0].function.name, 'lookup');
  assert.deepEqual(openAI.tool_choice, { type: 'function', function: { name: 'lookup' } });
});

test('protocol adapters render tool calls into Gemini and OpenAI Responses outputs', () => {
  const completion = {
    id: 'chatcmpl_tool',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-tool',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'lookup', arguments: '{"q":"x"}' }
        }]
      },
      finish_reason: 'tool_calls'
    }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
  };

  const gemini = convertOpenAIChatCompletionToGeminiGenerateContent(completion, 'gpt-tool');
  assert.deepEqual(gemini.candidates[0].content.parts, [{
    functionCall: { name: 'lookup', args: { q: 'x' } }
  }]);

  const response = convertOpenAIChatCompletionToOpenAIResponse(completion, 'gpt-tool');
  assert.equal(response.output[0].type, 'function_call');
  assert.equal(response.output[0].call_id, 'call_1');
  assert.equal(response.output[0].name, 'lookup');
  assert.equal(response.output[0].arguments, '{"q":"x"}');
});

test('protocol adapters route OpenAI reasoning wrapper to Gemini thought parts', () => {
  const completion = {
    id: 'chatcmpl_reasoning',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gemini-3.1-pro-preview',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        reasoning_content: '先分析',
        content: '最终回复'
      },
      finish_reason: 'stop'
    }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
  };

  const gemini = convertOpenAIChatCompletionToGeminiGenerateContent(completion, 'gemini-3.1-pro-preview');
  assert.deepEqual(gemini.candidates[0].content.parts, [
    { thought: true, text: '先分析' },
    { text: '最终回复' }
  ]);
});

test('protocol adapters route OpenAI reasoning SSE to Gemini thought parts', () => {
  const sse = [
    'data: {"id":"chatcmpl_reasoning","object":"chat.completion.chunk","created":1700000000,"model":"gemini-3.1-pro-preview","choices":[{"index":0,"delta":{"reasoning_content":"先分析"},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl_reasoning","object":"chat.completion.chunk","created":1700000000,"model":"gemini-3.1-pro-preview","choices":[{"index":0,"delta":{"content":"最终回复"},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl_reasoning","object":"chat.completion.chunk","created":1700000000,"model":"gemini-3.1-pro-preview","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    ''
  ].join('\n');

  const gemini = convertOpenAIChatSseToGeminiSse(sse, 'gemini-3.1-pro-preview');
  assert.match(gemini, /"parts":\[\{"thought":true,"text":"先分析"\}\]/);
  assert.match(gemini, /"parts":\[\{"text":"最终回复"\}\]/);
});

test('protocol adapters render OpenAI Chat tool-call SSE through canonical Responses events', () => {
  const sse = [
    'data: {"id":"chatcmpl_stream_tool","object":"chat.completion.chunk","created":1700000000,"model":"gpt-tool","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\"q\\""}}]},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl_stream_tool","object":"chat.completion.chunk","created":1700000000,"model":"gpt-tool","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"x\\"}"}}]},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl_stream_tool","object":"chat.completion.chunk","created":1700000000,"model":"gpt-tool","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}',
    '',
    'data: [DONE]',
    ''
  ].join('\n');

  const out = convertOpenAIChatSseToOpenAIResponseSse(sse, 'gpt-tool');
  assert.match(out, /event: response\.output_item\.added/);
  assert.match(out, /"type":"function_call"/);
  assert.match(out, /event: response\.function_call_arguments\.delta/);
  assert.match(out, /event: response\.function_call_arguments\.done/);
  assert.match(out, /"arguments":"\{\\"q\\":\\"x\\"\}"/);
  assert.match(out, /event: response\.completed/);
});
