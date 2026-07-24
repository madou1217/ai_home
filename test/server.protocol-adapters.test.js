const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyProtocolRequestAdapterPath,
  applyProtocolResponseAdapterPath,
  listProtocolRequestAdapters,
  resolveProtocolRequestAdapter,
  resolveProtocolRequestAdapterPath,
  convertAnthropicMessagesToOpenAIChat,
  convertAnthropicMessagesToOpenAIResponses,
  convertAnthropicMessagesToGeminiGenerateContent,
  convertOpenAIChatToAnthropicMessages,
  convertOpenAIChatToGeminiGenerateContent,
  convertGeminiGenerateContentToOpenAIChat,
  convertGeminiGenerateContentToOpenAIResponses,
  convertGeminiGenerateContentToAnthropicMessages,
  convertOpenAIResponsesToOpenAIChat,
  convertOpenAIResponsesToGeminiGenerateContent,
  convertOpenAIResponsesToAnthropicMessages,
  convertOpenAIChatCompletionToAnthropicMessage,
  convertOpenAIResponseToAnthropicMessage,
  convertAnthropicMessageToOpenAIResponse,
  convertOpenAIChatCompletionToGeminiGenerateContent,
  convertOpenAIResponseToGeminiGenerateContent,
  convertAnthropicMessageToGeminiGenerateContent,
  convertGeminiGenerateContentResponseToAnthropicMessage,
  convertGeminiGenerateContentResponseToOpenAIChatCompletion,
  convertGeminiGenerateContentResponseToOpenAIResponse,
  convertOpenAIChatCompletionToOpenAIResponse,
  convertOpenAIChatSseToAnthropicSse,
  convertAnthropicSseToOpenAIChatSse,
  convertOpenAIChatSseToGeminiSse,
  convertOpenAIChatSseToOpenAIResponseSse
} = require('../lib/server/protocol-adapters');
const {
  buildProtocolRequestPath,
  detectClientProtocol,
  getClientProtocol,
  listFallbackRequestProtocols,
  listClientProtocols
} = require('../lib/server/protocol-registry');
const {
  createSseTransformStream,
  listStreamPipelines,
  resolveStreamPipeline
} = require('../lib/server/protocol-stream-pipeline');

test('protocol registry detects supported client protocols declaratively', () => {
  assert.equal(detectClientProtocol('POST', '/v1/messages'), 'anthropic_messages');
  assert.equal(detectClientProtocol('POST', '/v1/v1/messages'), 'anthropic_messages');
  assert.equal(detectClientProtocol('POST', '/v1/messages/count_tokens'), 'anthropic_count_tokens');
  assert.equal(detectClientProtocol('POST', '/v1beta/models/gemini-2.5-pro:generateContent'), 'gemini_generate_content');
  assert.equal(detectClientProtocol('POST', '/v1beta/models/:generateContent'), 'gemini_generate_content');
  assert.equal(detectClientProtocol('POST', '/v1/models/gemini-2.5-pro:streamGenerateContent'), 'gemini_stream_generate_content');
  assert.equal(detectClientProtocol('POST', '/v1/models/:streamGenerateContent'), 'gemini_stream_generate_content');
  assert.equal(detectClientProtocol('POST', '/v1/chat/completions'), 'openai_chat');
  assert.equal(detectClientProtocol('POST', '/v1/v1/chat/completions'), 'openai_chat');
  assert.equal(detectClientProtocol('POST', '/v1/responses'), 'openai_responses');
  assert.equal(detectClientProtocol('GET', '/v1/responses'), '');
  assert.equal(buildProtocolRequestPath('anthropic_messages'), '/v1/messages');
  assert.equal(buildProtocolRequestPath('anthropic_count_tokens'), '/v1/messages/count_tokens');
  assert.equal(buildProtocolRequestPath('openai_chat'), '/v1/chat/completions');
  assert.equal(buildProtocolRequestPath('openai_responses'), '/v1/responses');
  assert.equal(
    buildProtocolRequestPath('gemini_generate_content', { requestJson: { model: 'gemini-2.5-pro' } }),
    '/v1beta/models/gemini-2.5-pro:generateContent'
  );
  assert.equal(
    buildProtocolRequestPath('gemini_stream_generate_content', { model: 'publishers/google/models/gemini-2.5-pro' }),
    '/v1beta/models/publishers/google/models/gemini-2.5-pro:streamGenerateContent'
  );
  assert.deepEqual(
    listClientProtocols().map((item) => item.canonicalEventProtocol),
    [
      'aih_canonical_events',
      '',
      'aih_canonical_events',
      'aih_canonical_events',
      'aih_canonical_events',
      'aih_canonical_events'
    ]
  );
  assert.deepEqual(
    listClientProtocols().map((item) => item.fallbackRequestProtocol),
    ['openai_chat', '', 'openai_chat', 'openai_chat', 'openai_chat', 'openai_chat']
  );
  assert.deepEqual(listFallbackRequestProtocols('anthropic_messages'), ['openai_chat', 'openai_responses']);
  assert.deepEqual(listFallbackRequestProtocols('anthropic_count_tokens'), []);
  assert.deepEqual(listFallbackRequestProtocols('unsupported_protocol'), []);
});

test('request adapter registry models fallback protocol bridges without redefining direct provider routes', () => {
  assert.deepEqual(resolveProtocolRequestAdapter('anthropic_messages', 'openai_chat'), {
    id: 'claude2openaiChatAdapter',
    sourceProtocol: 'anthropic_messages',
    targetProtocol: 'openai_chat',
    requestAdapter: 'claude2openaiChatAdapter',
    responseAdapter: 'openaiChat2claudeAdapter'
  });
  assert.equal(resolveProtocolRequestAdapter('anthropic_messages', 'agy'), null);
  assert.deepEqual(
    resolveProtocolRequestAdapterPath('openai_responses', 'anthropic_messages').map((adapter) => adapter.id),
    ['codex2claudeAdapter']
  );
  assert.deepEqual(
    resolveProtocolRequestAdapterPath('gemini_generate_content', 'anthropic_messages').map((adapter) => adapter.id),
    ['gemini2claudeAdapter']
  );
  assert.deepEqual(
    resolveProtocolRequestAdapterPath('anthropic_messages', 'gemini_generate_content').map((adapter) => adapter.id),
    ['claude2geminiAdapter']
  );
  assert.deepEqual(
    resolveProtocolRequestAdapterPath('openai_chat', 'gemini_generate_content').map((adapter) => adapter.id),
    ['openaiChat2geminiAdapter']
  );
  assert.deepEqual(
    resolveProtocolRequestAdapterPath('openai_responses', 'gemini_generate_content').map((adapter) => adapter.id),
    ['codex2geminiAdapter']
  );
  assert.deepEqual(
    resolveProtocolRequestAdapterPath('gemini_generate_content', 'gemini_stream_generate_content').map((adapter) => adapter.id),
    ['gemini2geminiStreamAdapter']
  );
  assert.equal(resolveProtocolRequestAdapterPath('anthropic_messages', 'anthropic_messages').length, 0);
  const adapters = listProtocolRequestAdapters();
  assert.ok(adapters.every((adapter) => adapter.sourceProtocol && adapter.targetProtocol));
  assert.ok(adapters.every((adapter) => adapter.id.endsWith('Adapter')));
  assert.ok(adapters.every((adapter) => adapter.requestAdapter === adapter.id));
  assert.ok(adapters.every((adapter) => adapter.responseAdapter.endsWith('Adapter')));
  assert.ok(adapters.every((adapter) => !adapter.id.includes('->')));
});

test('client protocol fallback descriptors resolve through the adapter graph', () => {
  listClientProtocols().forEach((protocol) => {
    const descriptor = getClientProtocol(protocol.id);
    assert.equal(descriptor.id, protocol.id);
    assert.equal(descriptor.fallbackRequestProtocol, protocol.fallbackRequestProtocol);
    assert.deepEqual(descriptor.fallbackRequestProtocols, protocol.fallbackRequestProtocols);
    protocol.fallbackRequestProtocols.forEach((fallbackProtocol) => {
      assert.ok(
        Array.isArray(resolveProtocolRequestAdapterPath(protocol.id, fallbackProtocol)),
        `${protocol.id} fallback must resolve to ${fallbackProtocol}`
      );
    });
  });
});

test('request adapter chain executes direct and multi-hop protocol transforms', () => {
  const direct = applyProtocolRequestAdapterPath({
    sourceProtocol: 'anthropic_messages',
    targetProtocol: 'openai_chat',
    payload: {
      model: 'claude-sonnet-4',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]
    }
  });
  assert.deepEqual(direct.adapters, ['claude2openaiChatAdapter']);
  assert.equal(direct.protocol, 'openai_chat');
  assert.deepEqual(direct.payload.messages, [{ role: 'user', content: 'ping' }]);

  const chained = applyProtocolRequestAdapterPath({
    sourceProtocol: 'openai_responses',
    targetProtocol: 'anthropic_messages',
    payload: {
      model: 'claude-sonnet-4',
      input: 'lookup codex',
      max_output_tokens: 128,
      tools: [{
        type: 'function',
        name: 'lookup',
        parameters: { type: 'object', properties: { q: { type: 'string' } } }
      }]
    }
  });
  assert.deepEqual(chained.adapters, ['codex2claudeAdapter']);
  assert.equal(chained.protocol, 'anthropic_messages');
  assert.equal(chained.payload.max_tokens, 128);
  assert.deepEqual(chained.payload.messages, [{ role: 'user', content: [{ type: 'text', text: 'lookup codex' }] }]);
  assert.deepEqual(chained.payload.tools, [{
    name: 'lookup',
    description: '',
    input_schema: { type: 'object', properties: { q: { type: 'string' } } }
  }]);
  assert.deepEqual(chained.payload.tool_choice, undefined);
});

test('response adapter chain applies inverse adapters without provider coupling', () => {
  const result = applyProtocolResponseAdapterPath({
    sourceProtocol: 'openai_responses',
    targetProtocol: 'anthropic_messages',
    payload: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4',
      content: [{ type: 'text', text: 'pong' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2 }
    },
    context: { fallbackModel: 'claude-sonnet-4' }
  });

  assert.equal(result.protocol, 'openai_responses');
  assert.deepEqual(result.adapters, ['codex2claudeAdapter']);
  assert.equal(result.payload.object, 'response');
  assert.equal(result.payload.model, 'claude-sonnet-4');
  assert.equal(result.payload.output[0].content[0].text, 'pong');
  assert.deepEqual(result.payload.usage, {
    input_tokens: 1,
    output_tokens: 2,
    total_tokens: 3
  });
});

test('adapter chain returns null for unsupported provider targets and identity for same protocol', () => {
  assert.equal(applyProtocolRequestAdapterPath({
    sourceProtocol: 'anthropic_messages',
    targetProtocol: 'agy',
    payload: {}
  }), null);

  const identity = applyProtocolRequestAdapterPath({
    sourceProtocol: 'openai_chat',
    targetProtocol: 'openai_chat',
    payload: { model: 'gpt-5.3-codex', messages: [] }
  });
  assert.deepEqual(identity, {
    sourceProtocol: 'openai_chat',
    targetProtocol: 'openai_chat',
    protocol: 'openai_chat',
    payload: { model: 'gpt-5.3-codex', messages: [] },
    adapters: []
  });
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
  assert.deepEqual(
    listStreamPipelines().filter((item) => item.source === 'openai_responses').map((item) => item.target).sort(),
    ['anthropic_messages', 'gemini_generate_content', 'gemini_stream_generate_content', 'openai_chat'].sort()
  );
  assert.deepEqual(
    listStreamPipelines().filter((item) => item.source === 'gemini_stream_generate_content').map((item) => item.target).sort(),
    ['anthropic_messages', 'gemini_generate_content', 'openai_chat', 'openai_responses'].sort()
  );
  assert.ok(listStreamPipelines().every((item) => item.eventProtocol === 'aih_canonical_events'));
  assert.equal(
    resolveStreamPipeline('anthropic_messages', 'openai_responses').id,
    'anthropic_messages->aih_canonical_events->openai_responses'
  );
  assert.equal(
    resolveStreamPipeline('gemini_stream_generate_content', 'openai_chat').id,
    'gemini_stream_generate_content->aih_canonical_events->openai_chat'
  );
  assert.deepEqual(resolveStreamPipeline('openai_chat', 'openai_chat'), {
    id: 'openai_chat->openai_chat',
    source: 'openai_chat',
    target: 'openai_chat',
    sourceProtocol: 'openai_chat',
    targetProtocol: 'openai_chat',
    eventProtocol: 'aih_canonical_events',
    identity: true
  });
});

test('Gemini generateContent adapter preserves parametersJsonSchema tool declarations', () => {
  const openai = convertGeminiGenerateContentToOpenAIChat({
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    tools: [{
      functionDeclarations: [{
        name: 'Read',
        description: 'Read a file',
        parametersJsonSchema: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path']
        }
      }]
    }]
  }, '/v1/models/claude-4-6-thinking:generateContent', false);

  assert.equal(openai.tools[0].function.name, 'Read');
  assert.deepEqual(openai.tools[0].function.parameters, {
    type: 'object',
    properties: { file_path: { type: 'string' } },
    required: ['file_path']
  });
});

test('Gemini function responses recover tool call ids from prior function calls', () => {
  const geminiRequest = {
    contents: [
      {
        role: 'model',
        parts: [{
          functionCall: {
            id: 'call_lookup_1',
            name: 'Lookup',
            args: { query: 'codex' }
          }
        }]
      },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            name: 'Lookup',
            response: { ok: true }
          }
        }]
      }
    ]
  };

  const anthropic = convertGeminiGenerateContentToAnthropicMessages(
    geminiRequest,
    '/v1beta/models/claude-4-6-thinking:generateContent',
    false
  );
  assert.equal(anthropic.messages[1].content[0].tool_use_id, 'call_lookup_1');
  assert.equal(anthropic.messages[1].content[0].content, '{"ok":true}');

  const openai = convertGeminiGenerateContentToOpenAIChat(
    geminiRequest,
    '/v1beta/models/gemini-2.5-pro:generateContent',
    false
  );
  assert.equal(openai.messages[1].tool_call_id, 'call_lookup_1');
  assert.equal(openai.messages[1].content, '{"ok":true}');
});

test('Gemini function responses unwrap response.result for Claude and OpenAI tool results', () => {
  const geminiRequest = {
    contents: [
      {
        role: 'model',
        parts: [{
          functionCall: {
            id: 'call_read_1',
            name: 'Read',
            args: { file_path: 'package.json' }
          }
        }]
      },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            id: 'call_read_1',
            name: 'Read',
            response: { result: 'package content' }
          }
        }]
      }
    ]
  };

  const anthropic = convertGeminiGenerateContentToAnthropicMessages(
    geminiRequest,
    '/v1beta/models/claude-4-6-thinking:generateContent',
    false
  );
  assert.equal(anthropic.messages[1].content[0].tool_use_id, 'call_read_1');
  assert.equal(anthropic.messages[1].content[0].content, 'package content');

  const openai = convertGeminiGenerateContentToOpenAIChat(
    geminiRequest,
    '/v1beta/models/gemini-2.5-pro:generateContent',
    false
  );
  assert.equal(openai.messages[1].tool_call_id, 'call_read_1');
  assert.equal(openai.messages[1].content, 'package content');
});

test('Gemini function responses recover duplicate tool call ids in call order', () => {
  const geminiRequest = {
    contents: [
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call_lookup_1',
              name: 'Lookup',
              args: { query: 'first' }
            }
          },
          {
            functionCall: {
              id: 'call_lookup_2',
              name: 'Lookup',
              args: { query: 'second' }
            }
          }
        ]
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'Lookup',
              response: { ok: 1 }
            }
          },
          {
            functionResponse: {
              name: 'Lookup',
              response: { ok: 2 }
            }
          }
        ]
      }
    ]
  };

  const anthropic = convertGeminiGenerateContentToAnthropicMessages(
    geminiRequest,
    '/v1beta/models/claude-4-6-thinking:generateContent',
    false
  );
  assert.equal(anthropic.messages[1].content[0].tool_use_id, 'call_lookup_1');
  assert.equal(anthropic.messages[1].content[1].tool_use_id, 'call_lookup_2');

  const openai = convertGeminiGenerateContentToOpenAIChat(
    geminiRequest,
    '/v1beta/models/gemini-2.5-pro:generateContent',
    false
  );
  assert.equal(openai.messages[1].tool_call_id, 'call_lookup_1');
  assert.equal(openai.messages[2].tool_call_id, 'call_lookup_2');
});

test('Gemini function responses match generated tool call ids when upstream omits ids', () => {
  const geminiRequest = {
    contents: [
      {
        role: 'model',
        parts: [{
          functionCall: {
            name: 'Lookup',
            args: { query: 'codex' }
          }
        }]
      },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            name: 'Lookup',
            response: { ok: true }
          }
        }]
      }
    ]
  };

  const anthropic = convertGeminiGenerateContentToAnthropicMessages(
    geminiRequest,
    '/v1beta/models/claude-4-6-thinking:generateContent',
    false
  );
  assert.equal(anthropic.messages[0].content[0].id, 'toolu_1');
  assert.equal(anthropic.messages[1].content[0].tool_use_id, 'toolu_1');

  const openai = convertGeminiGenerateContentToOpenAIChat(
    geminiRequest,
    '/v1beta/models/gemini-2.5-pro:generateContent',
    false
  );
  assert.equal(openai.messages[0].tool_calls[0].id, 'call_1');
  assert.equal(openai.messages[1].tool_call_id, 'call_1');
});

test('Gemini to OpenAI Responses keeps generated tool call ids sequential across turns', () => {
  const responses = convertGeminiGenerateContentToOpenAIResponses({
    contents: [
      {
        role: 'model',
        parts: [{
          functionCall: {
            name: 'CustomLookup',
            args: { query: 'first' }
          }
        }]
      },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            name: 'CustomLookup',
            response: { ok: 1 }
          }
        }]
      },
      {
        role: 'model',
        parts: [{
          functionCall: {
            name: 'CustomLookup',
            args: { query: 'second' }
          }
        }]
      },
      {
        role: 'user',
        parts: [{
          functionResponse: {
            name: 'CustomLookup',
            response: { ok: 2 }
          }
        }]
      }
    ]
  }, '/v1beta/models/gpt-5.3-codex:generateContent', false);

  assert.deepEqual(
    responses.input.filter((item) => item.type === 'function_call').map((item) => item.call_id),
    ['call_1', 'call_2']
  );
  assert.deepEqual(
    responses.input.filter((item) => item.type === 'function_call_output').map((item) => item.call_id),
    ['call_1', 'call_2']
  );
});

test('Gemini to OpenAI Responses consumes explicit tool result ids before FIFO fallback', () => {
  const responses = convertGeminiGenerateContentToOpenAIResponses({
    contents: [
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'manual_call_1',
              name: 'CustomLookup',
              args: { query: 'first' }
            }
          },
          {
            functionCall: {
              name: 'CustomLookup',
              args: { query: 'second' }
            }
          }
        ]
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'manual_call_1',
              name: 'CustomLookup',
              response: { ok: 1 }
            }
          },
          {
            functionResponse: {
              name: 'CustomLookup',
              response: { ok: 2 }
            }
          }
        ]
      }
    ]
  }, '/v1beta/models/gpt-5.3-codex:generateContent', false);

  assert.deepEqual(
    responses.input.filter((item) => item.type === 'function_call').map((item) => item.call_id),
    ['manual_call_1', 'call_1']
  );
  assert.deepEqual(
    responses.input.filter((item) => item.type === 'function_call_output').map((item) => item.call_id),
    ['manual_call_1', 'call_1']
  );
});

test('Anthropic to Gemini request adapter keeps model function calls after text parts', () => {
  const gemini = convertAnthropicMessagesToGeminiGenerateContent({
    model: 'claude-4-6-thinking',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '先读取文件。' },
          { type: 'tool_use', id: 'Read-123-456', name: 'Read', input: { file_path: 'package.json' } },
          { type: 'text', text: '读取后继续分析。' },
          { type: 'tool_use', id: 'Bash-123-456', name: 'Bash', input: { command: 'pwd' } }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'Read-123-456',
            content: 'package content'
          },
          {
            type: 'tool_result',
            tool_use_id: 'Bash-123-456',
            content: 'cwd output'
          }
        ]
      }
    ]
  });

  const parts = gemini.contents[0].parts;
  assert.equal(parts[0].text, '先读取文件。');
  assert.equal(parts[1].text, '读取后继续分析。');
  assert.equal(parts[2].functionCall.id, 'Read-123-456');
  assert.equal(parts[2].functionCall.name, 'Read');
  assert.equal(parts[3].functionCall.id, 'Bash-123-456');
  assert.equal(parts[3].functionCall.name, 'Bash');
  assert.equal(gemini.contents[1].parts[0].functionResponse.name, 'Read');
});

test('Anthropic source request adapters sanitize non-adjacent tool history generically', () => {
  const anthropicRequest = {
    model: 'claude-4-6-thinking',
    messages: [
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_custom_fetch',
          name: 'CustomFetch',
          input: { url: 'https://example.test' }
        }]
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'continue before the tool result' }]
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_custom_fetch',
          content: 'late fetch result'
        }]
      }
    ]
  };

  const gemini = convertAnthropicMessagesToGeminiGenerateContent(anthropicRequest);
  assert.deepEqual(gemini.contents.map((content) => content.role), ['user', 'user']);
  assert.equal(
    gemini.contents.flatMap((content) => content.parts).some((part) => part.functionCall || part.functionResponse),
    false
  );
  assert.equal(gemini.contents[0].parts[0].text, 'continue before the tool result');
  assert.equal(gemini.contents[1].parts[0].text, 'Tool result (toolu_custom_fetch):\nlate fetch result');

  const chat = convertAnthropicMessagesToOpenAIChat(anthropicRequest);
  assert.deepEqual(chat.messages.map((message) => message.role), ['user', 'user']);
  assert.equal(chat.messages.some((message) => message.tool_calls || message.role === 'tool'), false);
  assert.equal(chat.messages[0].content, 'continue before the tool result');
  assert.equal(chat.messages[1].content, 'Tool result (toolu_custom_fetch):\nlate fetch result');

  const responses = convertAnthropicMessagesToOpenAIResponses(anthropicRequest);
  assert.deepEqual(responses.input.map((item) => item.type), ['message', 'message']);
  assert.equal(
    responses.input.some((item) => item.type === 'function_call' || item.type === 'function_call_output'),
    false
  );
  assert.equal(responses.input[0].content[0].text, 'continue before the tool result');
  assert.equal(responses.input[1].content[0].text, 'Tool result (toolu_custom_fetch):\nlate fetch result');
});

test('OpenAI tool adapters keep assistant calls and tool results in adjacent turns', () => {
  const chat = convertOpenAIChatToGeminiGenerateContent({
    model: 'gemini-3.1-pro-preview',
    messages: [
      { role: 'assistant', content: 'I will call two tools.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_fetch_1',
            type: 'function',
            function: {
              name: 'CustomFetch',
              arguments: '{"url":"https://example.test"}'
            }
          },
          {
            id: 'call_shell_1',
            type: 'function',
            function: {
              name: 'ShellExec',
              arguments: '{"command":"pwd"}'
            }
          }
        ]
      },
      { role: 'tool', tool_call_id: 'call_fetch_1', content: '{"ok":true}' },
      { role: 'tool', tool_call_id: 'call_shell_1', content: 'done' }
    ]
  });
  assert.equal(chat.contents.length, 2);
  assert.equal(chat.contents[0].role, 'model');
  assert.equal(chat.contents[0].parts[0].text, 'I will call two tools.');
  assert.equal(chat.contents[0].parts[1].functionCall.name, 'CustomFetch');
  assert.equal(chat.contents[0].parts[2].functionCall.name, 'ShellExec');
  assert.equal(chat.contents[1].role, 'user');
  assert.equal(chat.contents[1].parts[0].functionResponse.name, 'CustomFetch');
  assert.equal(chat.contents[1].parts[1].functionResponse.name, 'ShellExec');

  const responsesInput = [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'I will call two tools.' }]
    },
    {
      type: 'function_call',
      call_id: 'call_fetch_1',
      name: 'CustomFetch',
      arguments: '{"url":"https://example.test"}'
    },
    {
      type: 'function_call',
      call_id: 'call_shell_1',
      name: 'ShellExec',
      arguments: '{"command":"pwd"}'
    },
    {
      type: 'function_call_output',
      call_id: 'call_fetch_1',
      output: '{"ok":true}'
    },
    {
      type: 'function_call_output',
      call_id: 'call_shell_1',
      output: 'done'
    }
  ];
  const gemini = convertOpenAIResponsesToGeminiGenerateContent({
    model: 'gemini-3.1-pro-preview',
    input: responsesInput
  });
  assert.equal(gemini.contents.length, 2);
  assert.equal(gemini.contents[0].role, 'model');
  assert.equal(gemini.contents[0].parts[0].text, 'I will call two tools.');
  assert.equal(gemini.contents[0].parts[1].functionCall.name, 'CustomFetch');
  assert.equal(gemini.contents[0].parts[2].functionCall.name, 'ShellExec');
  assert.equal(gemini.contents[1].role, 'user');
  assert.equal(gemini.contents[1].parts[0].functionResponse.name, 'CustomFetch');
  assert.equal(gemini.contents[1].parts[1].functionResponse.name, 'ShellExec');

  const anthropic = convertOpenAIResponsesToAnthropicMessages({
    model: 'claude-4-6-thinking',
    instructions: 'global instructions',
    input: responsesInput
  });
  assert.equal(anthropic.messages.length, 2);
  assert.equal(anthropic.system, 'global instructions');
  assert.deepEqual(anthropic.messages[0].content.map((part) => part.type), ['text', 'tool_use', 'tool_use']);
  assert.deepEqual(anthropic.messages[0].content.map((part) => part.name).filter(Boolean), ['CustomFetch', 'ShellExec']);
  assert.deepEqual(anthropic.messages[1].content.map((part) => part.type), ['tool_result', 'tool_result']);
  assert.deepEqual(anthropic.messages[1].content.map((part) => part.tool_use_id), ['call_fetch_1', 'call_shell_1']);

  const openaiChat = convertOpenAIResponsesToOpenAIChat({
    model: 'gpt-5.3-codex',
    input: responsesInput
  });
  assert.equal(openaiChat.messages[1].tool_calls[0].id, 'call_fetch_1');
  assert.equal(openaiChat.messages[1].tool_calls[0].function.name, 'CustomFetch');
  assert.equal(openaiChat.messages[2].tool_calls[0].id, 'call_shell_1');
  assert.equal(openaiChat.messages[3].tool_call_id, 'call_fetch_1');
  assert.equal(openaiChat.messages[4].tool_call_id, 'call_shell_1');
});

test('OpenAI Responses to Anthropic keeps system role items and stable generated tool ids', () => {
  const anthropic = convertOpenAIResponsesToAnthropicMessages({
    model: 'claude-4-6-thinking',
    instructions: 'root system',
    input: [
      {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: 'session system' }]
      },
      {
        type: 'function_call',
        name: 'CustomFetch',
        arguments: '{"url":"https://example.test"}'
      },
      {
        type: 'function_call_output',
        output: '{"ok":true}'
      }
    ],
    tool_choice: { type: 'required' }
  });

  assert.equal(anthropic.system, 'root system\n\nsession system');
  assert.equal(anthropic.messages[0].role, 'assistant');
  assert.deepEqual(anthropic.messages[0].content[0], {
    type: 'tool_use',
    id: 'call_2',
    name: 'CustomFetch',
    input: { url: 'https://example.test' }
  });
  assert.equal(anthropic.messages[1].role, 'user');
  assert.deepEqual(anthropic.messages[1].content[0], {
    type: 'tool_result',
    tool_use_id: 'call_2',
    content: '{"ok":true}'
  });
  assert.deepEqual(anthropic.tool_choice, { type: 'any' });
});

test('Anthropic request adapters sanitize non-adjacent tool history generically', () => {
  const chat = convertOpenAIChatToAnthropicMessages({
    model: 'claude-4-6-thinking',
    messages: [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_lookup_1',
          type: 'function',
          function: {
            name: 'Lookup',
            arguments: '{"query":"codex"}'
          }
        }]
      },
      { role: 'user', content: 'non-tool interjection' },
      { role: 'tool', tool_call_id: 'call_lookup_1', content: 'late result' }
    ]
  });
  assert.deepEqual(chat.messages.map((message) => message.role), ['user', 'user']);
  assert.equal(
    chat.messages.flatMap((message) => message.content).some((part) => part.type === 'tool_use' || part.type === 'tool_result'),
    false
  );
  assert.deepEqual(chat.messages[0].content, [{ type: 'text', text: 'non-tool interjection' }]);
  assert.deepEqual(chat.messages[1].content, [{
    type: 'text',
    text: 'Tool result (call_lookup_1):\nlate result'
  }]);

  const responses = convertOpenAIResponsesToAnthropicMessages({
    model: 'claude-4-6-thinking',
    input: [
      {
        type: 'function_call',
        call_id: 'call_fetch_1',
        name: 'CustomFetch',
        arguments: '{"url":"https://example.test"}'
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'continue after the tool result' }]
      },
      {
        type: 'function_call_output',
        call_id: 'call_fetch_1',
        output: '{"ok":true}'
      }
    ]
  });
  assert.deepEqual(responses.messages[0].content.map((part) => part.type), ['tool_use']);
  assert.deepEqual(responses.messages[1].content.map((part) => part.type), ['tool_result', 'text']);
  assert.equal(responses.messages[1].content[0].tool_use_id, 'call_fetch_1');
  assert.equal(responses.messages[1].content[1].text, 'continue after the tool result');

  const gemini = convertGeminiGenerateContentToAnthropicMessages({
    contents: [
      {
        role: 'model',
        parts: [{
          functionCall: {
            id: 'call_shell_1',
            name: 'ShellExec',
            args: { command: 'pwd' }
          }
        }]
      },
      {
        role: 'user',
        parts: [
          { text: 'continue after shell' },
          {
            functionResponse: {
              id: 'call_shell_1',
              name: 'ShellExec',
              response: { result: 'done' }
            }
          }
        ]
      }
    ]
  }, '/v1beta/models/claude-4-6-thinking:generateContent', false);
  assert.deepEqual(gemini.messages[1].content.map((part) => part.type), ['tool_result', 'text']);
  assert.equal(gemini.messages[1].content[0].tool_use_id, 'call_shell_1');
  assert.equal(gemini.messages[1].content[1].text, 'continue after shell');
});

test('Gemini request adapters drop trailing unanswered tool calls generically', () => {
  const anthropic = convertAnthropicMessagesToGeminiGenerateContent({
    model: 'gemini-3.1-pro-preview',
    messages: [
      { role: 'user', content: 'fetch status' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will call the tool.' },
          {
            type: 'tool_use',
            id: 'toolu_custom_fetch',
            name: 'CustomFetch',
            input: { url: 'https://example.test' }
          }
        ]
      }
    ]
  });
  assert.equal(anthropic.contents.length, 2);
  assert.equal(anthropic.contents[0].role, 'user');
  assert.equal(anthropic.contents[1].role, 'model');
  assert.deepEqual(anthropic.contents[1].parts, [{ text: 'I will call the tool.' }]);
  assert.equal(
    anthropic.contents.flatMap((content) => content.parts).some((part) => part.functionCall),
    false
  );

  const chat = convertOpenAIChatToGeminiGenerateContent({
    model: 'gemini-3.1-pro-preview',
    messages: [
      { role: 'user', content: 'fetch status' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_fetch_1',
          type: 'function',
          function: {
            name: 'CustomFetch',
            arguments: '{"url":"https://example.test"}'
          }
        }]
      }
    ]
  });
  assert.equal(chat.contents.length, 1);
  assert.equal(chat.contents[0].role, 'user');
  assert.equal(
    chat.contents.flatMap((content) => content.parts).some((part) => part.functionCall),
    false
  );

  const responses = convertOpenAIResponsesToGeminiGenerateContent({
    model: 'gemini-3.1-pro-preview',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'fetch status' }]
      },
      {
        type: 'function_call',
        call_id: 'call_fetch_1',
        name: 'CustomFetch',
        arguments: '{"url":"https://example.test"}'
      }
    ]
  });
  assert.equal(responses.contents.length, 1);
  assert.equal(responses.contents[0].role, 'user');
  assert.equal(
    responses.contents.flatMap((content) => content.parts).some((part) => part.functionCall),
    false
  );
});

test('direct protocol adapters preserve tool choice without OpenAI fallback wrapping', () => {
  const anthropicFromChat = convertOpenAIChatToAnthropicMessages({
    model: 'claude-4-6-thinking',
    messages: [{ role: 'user', content: 'read package' }],
    tools: [{
      type: 'function',
      function: {
        name: 'CustomFetch',
        description: 'Fetch a URL',
        parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
      }
    }],
    tool_choice: { type: 'function', function: { name: 'CustomFetch' } }
  });
  assert.deepEqual(anthropicFromChat.tool_choice, { type: 'tool', name: 'CustomFetch' });

  const anthropicFromResponses = convertOpenAIResponsesToAnthropicMessages({
    model: 'claude-4-6-thinking',
    input: 'fetch',
    tools: [{
      type: 'function',
      name: 'CustomFetch',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
    }],
    tool_choice: { type: 'function', name: 'CustomFetch' }
  });
  assert.deepEqual(anthropicFromResponses.tool_choice, { type: 'tool', name: 'CustomFetch' });

  const anthropicFromGemini = convertGeminiGenerateContentToAnthropicMessages({
    contents: [{ role: 'user', parts: [{ text: 'fetch' }] }],
    tools: [{
      functionDeclarations: [{
        name: 'CustomFetch',
        parametersJsonSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
      }]
    }],
    toolConfig: {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: ['CustomFetch']
      }
    }
  }, '/v1beta/models/claude-4-6-thinking:generateContent', false);
  assert.equal(anthropicFromGemini.model, 'claude-4-6-thinking');
  assert.deepEqual(anthropicFromGemini.tool_choice, { type: 'tool', name: 'CustomFetch' });
  assert.deepEqual(anthropicFromGemini.tools[0].input_schema.required, ['url']);
});

test('direct protocol adapters convert client requests to OpenAI Responses without Chat wrapping', () => {
  assert.deepEqual(
    resolveProtocolRequestAdapterPath('anthropic_messages', 'openai_responses').map((adapter) => adapter.id),
    ['claude2codexAdapter']
  );
  assert.deepEqual(
    resolveProtocolRequestAdapterPath('gemini_generate_content', 'openai_responses').map((adapter) => adapter.id),
    ['gemini2codexAdapter']
  );

  const responseFromAnthropic = convertAnthropicMessagesToOpenAIResponses({
    model: 'gpt-5.3-codex',
    system: 'system hint',
    max_tokens: 64,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: 'fetch' }]
    }],
    tools: [{
      name: 'CustomFetch',
      input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
    }],
    tool_choice: { type: 'tool', name: 'CustomFetch' }
  });
  assert.equal(responseFromAnthropic.instructions, 'system hint');
  assert.equal(responseFromAnthropic.max_output_tokens, 64);
  assert.deepEqual(responseFromAnthropic.input, [{
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'fetch' }]
  }]);
  assert.deepEqual(responseFromAnthropic.tools[0], {
    type: 'function',
    name: 'CustomFetch',
    description: '',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
  });
  assert.deepEqual(responseFromAnthropic.tool_choice, { type: 'function', name: 'CustomFetch' });

  const responseFromGemini = convertGeminiGenerateContentToOpenAIResponses({
    systemInstruction: { parts: [{ text: 'system hint' }] },
    contents: [
      { role: 'model', parts: [{ functionCall: { name: 'CustomFetch', args: { url: 'https://example.test' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'CustomFetch', response: { ok: true } } }] }
    ],
    generationConfig: { maxOutputTokens: 32, temperature: 0.2 },
    tools: [{
      functionDeclarations: [{
        name: 'CustomFetch',
        parametersJsonSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
      }]
    }],
    toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['CustomFetch'] } }
  }, '/v1beta/models/gpt-5.3-codex:generateContent', false);
  assert.equal(responseFromGemini.model, 'gpt-5.3-codex');
  assert.equal(responseFromGemini.instructions, 'system hint');
  assert.equal(responseFromGemini.max_output_tokens, 32);
  assert.equal(responseFromGemini.temperature, 0.2);
  assert.deepEqual(responseFromGemini.input[0], {
    type: 'function_call',
    call_id: 'call_1',
    name: 'CustomFetch',
    arguments: '{"url":"https://example.test"}'
  });
  assert.deepEqual(responseFromGemini.input[1], {
    type: 'function_call_output',
    call_id: 'call_1',
    output: '{"ok":true}'
  });
  assert.deepEqual(responseFromGemini.tool_choice, { type: 'function', name: 'CustomFetch' });
});

test('Anthropic stop sequences are omitted for Responses and preserved for Chat Completions', () => {
  const anthropicRequest = {
    model: 'gpt-5.6-sol',
    max_tokens: 64,
    temperature: 0,
    stop_sequences: ['</block>'],
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: 'Classify with <block>yes</block> or <block>no</block>.' }]
    }]
  };

  const responses = convertAnthropicMessagesToOpenAIResponses(anthropicRequest);
  assert.equal(Object.hasOwn(responses, 'stop'), false);
  assert.equal(Object.hasOwn(responses, 'stop_sequences'), false);
  assert.equal(responses.max_output_tokens, 64);
  assert.equal(responses.temperature, 0);

  const chat = convertAnthropicMessagesToOpenAIChat(anthropicRequest);
  assert.deepEqual(chat.stop, ['</block>']);
});

test('direct protocol adapters convert client requests to Gemini without OpenAI wrapping', () => {
  assert.deepEqual(
    resolveProtocolRequestAdapterPath('anthropic_messages', 'gemini_stream_generate_content').map((adapter) => adapter.id),
    ['claude2geminiStreamAdapter']
  );
  assert.deepEqual(
    resolveProtocolRequestAdapterPath('openai_chat', 'gemini_stream_generate_content').map((adapter) => adapter.id),
    ['openaiChat2geminiStreamAdapter']
  );
  assert.deepEqual(
    resolveProtocolRequestAdapterPath('openai_responses', 'gemini_stream_generate_content').map((adapter) => adapter.id),
    ['codex2geminiStreamAdapter']
  );

  const geminiFromAnthropic = convertAnthropicMessagesToGeminiGenerateContent({
    model: 'gemini-3.1-pro-preview',
    system: 'system hint',
    max_tokens: 64,
    messages: [
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_fetch_1',
          name: 'CustomFetch',
          input: { url: 'https://example.test' }
        }]
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_fetch_1',
          content: '{"ok":true}'
        }]
      }
    ],
    tools: [{
      name: 'CustomFetch',
      input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
    }],
    tool_choice: { type: 'tool', name: 'CustomFetch' }
  });
  assert.deepEqual(geminiFromAnthropic.systemInstruction, { parts: [{ text: 'system hint' }] });
  assert.equal(geminiFromAnthropic.generationConfig.maxOutputTokens, 64);
  assert.deepEqual(geminiFromAnthropic.contents[0].parts[0], {
    functionCall: {
      id: 'toolu_fetch_1',
      name: 'CustomFetch',
      args: { url: 'https://example.test' }
    }
  });
  assert.deepEqual(geminiFromAnthropic.contents[1].parts[0], {
    functionResponse: {
      id: 'toolu_fetch_1',
      name: 'CustomFetch',
      response: { ok: true }
    }
  });
  assert.deepEqual(geminiFromAnthropic.tools[0].functionDeclarations[0].parametersJsonSchema.required, ['url']);
  assert.deepEqual(geminiFromAnthropic.toolConfig, {
    functionCallingConfig: {
      mode: 'ANY',
      allowedFunctionNames: ['CustomFetch']
    }
  });

  const geminiFromChat = convertOpenAIChatToGeminiGenerateContent({
    model: 'gemini-3.1-pro-preview',
    messages: [
      { role: 'system', content: 'chat system' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_fetch_1',
          type: 'function',
          function: {
            name: 'CustomFetch',
            arguments: '{"url":"https://example.test"}'
          }
        }]
      },
      {
        role: 'tool',
        tool_call_id: 'call_fetch_1',
        content: '{"ok":true}'
      }
    ],
    tools: [{
      type: 'function',
      function: {
        name: 'CustomFetch',
        parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
      }
    }],
    tool_choice: { type: 'function', function: { name: 'CustomFetch' } }
  });
  assert.equal(geminiFromChat.systemInstruction.parts[0].text, 'chat system');
  assert.equal(geminiFromChat.contents[0].role, 'model');
  assert.equal(geminiFromChat.contents[1].parts[0].functionResponse.name, 'CustomFetch');
  assert.deepEqual(geminiFromChat.toolConfig.functionCallingConfig.allowedFunctionNames, ['CustomFetch']);

  const geminiFromResponses = convertOpenAIResponsesToGeminiGenerateContent({
    model: 'gemini-3.1-pro-preview',
    instructions: 'response system',
    input: [
      {
        type: 'function_call',
        call_id: 'call_fetch_1',
        name: 'CustomFetch',
        arguments: '{"url":"https://example.test"}'
      },
      {
        type: 'function_call_output',
        call_id: 'call_fetch_1',
        output: '{"ok":true}'
      }
    ],
    max_output_tokens: 32,
    tools: [{
      type: 'function',
      name: 'CustomFetch',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
    }],
    tool_choice: { type: 'function', name: 'CustomFetch' }
  });
  assert.equal(geminiFromResponses.systemInstruction.parts[0].text, 'response system');
  assert.equal(geminiFromResponses.generationConfig.maxOutputTokens, 32);
  assert.equal(geminiFromResponses.contents[0].parts[0].functionCall.name, 'CustomFetch');
  assert.equal(geminiFromResponses.contents[1].parts[0].functionResponse.name, 'CustomFetch');
  assert.deepEqual(geminiFromResponses.toolConfig.functionCallingConfig.allowedFunctionNames, ['CustomFetch']);
});

test('direct protocol response adapters render Anthropic tool calls to target protocols', () => {
  const message = {
    id: 'msg_tool_direct',
    type: 'message',
    role: 'assistant',
    model: 'claude-4-6-thinking',
    content: [{
      type: 'tool_use',
      id: 'toolu_custom_fetch',
      name: 'CustomFetch',
      input: { url: 'https://example.test' }
    }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 7, output_tokens: 3 }
  };

  const response = convertAnthropicMessageToOpenAIResponse(message, 'claude-4-6-thinking');
  assert.equal(response.output[0].type, 'function_call');
  assert.equal(response.output[0].name, 'CustomFetch');
  assert.equal(response.output[0].arguments, '{"url":"https://example.test"}');

  const gemini = convertAnthropicMessageToGeminiGenerateContent(message, 'claude-4-6-thinking');
  assert.deepEqual(gemini.candidates[0].content.parts[0], {
    functionCall: {
      id: 'toolu_custom_fetch',
      name: 'CustomFetch',
      args: { url: 'https://example.test' }
    }
  });
  assert.equal(gemini.candidates[0].finishReason, 'STOP');
});

test('direct protocol response adapters render OpenAI Responses outputs to client protocols', () => {
  const response = {
    id: 'resp_tool_direct',
    object: 'response',
    status: 'completed',
    model: 'gpt-5.3-codex',
    output: [{
      id: 'fc_call_1',
      type: 'function_call',
      call_id: 'call_1',
      name: 'CustomFetch',
      arguments: '{"url":"https://example.test"}'
    }],
    usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 }
  };

  const anthropic = convertOpenAIResponseToAnthropicMessage(response, 'gpt-5.3-codex');
  assert.equal(anthropic.stop_reason, 'tool_use');
  assert.deepEqual(anthropic.content[0], {
    type: 'tool_use',
    id: 'call_1',
    name: 'CustomFetch',
    input: { url: 'https://example.test' }
  });
  assert.deepEqual(anthropic.usage, { input_tokens: 7, output_tokens: 3 });

  const gemini = convertOpenAIResponseToGeminiGenerateContent(response, 'gpt-5.3-codex');
  assert.deepEqual(gemini.candidates[0].content.parts[0], {
    functionCall: {
      id: 'call_1',
      name: 'CustomFetch',
      args: { url: 'https://example.test' }
    }
  });
  assert.deepEqual(gemini.usageMetadata, {
    promptTokenCount: 7,
    candidatesTokenCount: 3,
    totalTokenCount: 10
  });
});

test('direct protocol response adapters render Gemini outputs to source protocols', () => {
  const geminiResponse = {
    candidates: [{
      content: {
        role: 'model',
        parts: [{
          functionCall: {
            id: 'call_1',
            name: 'CustomFetch',
            args: { url: 'https://example.test' }
          }
        }]
      },
      finishReason: 'STOP',
      index: 0
    }],
    usageMetadata: {
      promptTokenCount: 7,
      candidatesTokenCount: 3,
      totalTokenCount: 10
    },
    modelVersion: 'gemini-3.1-pro-preview'
  };

  const anthropic = convertGeminiGenerateContentResponseToAnthropicMessage(geminiResponse, 'fallback');
  assert.equal(anthropic.model, 'gemini-3.1-pro-preview');
  assert.equal(anthropic.stop_reason, 'tool_use');
  assert.deepEqual(anthropic.content[0], {
    type: 'tool_use',
    id: 'call_1',
    name: 'CustomFetch',
    input: { url: 'https://example.test' }
  });
  assert.deepEqual(anthropic.usage, { input_tokens: 7, output_tokens: 3 });

  const chat = convertGeminiGenerateContentResponseToOpenAIChatCompletion(geminiResponse, 'fallback');
  assert.equal(chat.choices[0].finish_reason, 'tool_calls');
  assert.equal(chat.choices[0].message.tool_calls[0].function.name, 'CustomFetch');
  assert.deepEqual(chat.usage, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });

  const response = convertGeminiGenerateContentResponseToOpenAIResponse(geminiResponse, 'fallback');
  assert.equal(response.output[0].type, 'function_call');
  assert.equal(response.output[0].name, 'CustomFetch');
  assert.deepEqual(response.usage, { input_tokens: 7, output_tokens: 3, total_tokens: 10 });
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

test('stream transform can incrementally convert OpenAI Responses SSE to Anthropic SSE', () => {
  const chunks = [];
  const transform = createSseTransformStream('openai_responses', 'anthropic_messages', {
    fallbackModel: 'gpt-5.3-codex',
    onChunk: (chunk) => chunks.push(chunk)
  });

  transform.write(`${[
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_tool","model":"gpt-5.3-codex","created_at":1770000000}}',
    '',
    'event: response.output_item.added',
    'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"lookup","arguments":""}}',
    ''
  ].join('\n')}\n`);
  transform.write(`${[
    'event: response.function_call_arguments.done',
    'data: {"type":"response.function_call_arguments.done","item_id":"call_1","output_index":0,"arguments":"{\\"q\\":\\"x\\"}"}',
    '',
    'event: response.output_item.done',
    'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\\"q\\":\\"x\\"}"}}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"id":"resp_tool","status":"completed","model":"gpt-5.3-codex","output":[{"id":"fc_1","type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\\"q\\":\\"x\\"}"}],"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}',
    ''
  ].join('\n')}\n`);
  transform.end();

  const output = chunks.join('');
  assert.match(output, /event: content_block_start/);
  assert.match(output, /"type":"tool_use","id":"call_1","name":"lookup"/);
  assert.match(output, /"partial_json":"\{\\"q\\":\\"x\\"}"/);
  assert.match(output, /"stop_reason":"tool_use"/);
  assert.match(output, /"input_tokens":2/);
  assert.match(output, /"output_tokens":3/);
});

test('stream transform preserves Anthropic thinking deltas as OpenAI reasoning content', () => {
  const chunks = [];
  const transform = createSseTransformStream('anthropic_messages', 'openai_chat', {
    fallbackModel: 'claude-sonnet-4',
    onChunk: (chunk) => chunks.push(chunk)
  });

  transform.write(`${[
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_thinking","type":"message","role":"assistant","model":"claude-sonnet-4","content":[],"usage":{"input_tokens":2,"output_tokens":0}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"先分析"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_1"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"结论"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    ''
  ].join('\n')}\n`);
  transform.end();

  const output = chunks.join('');
  assert.match(output, /"reasoning_content":"先分析"/);
  assert.match(output, /"content":"结论"/);
  assert.match(output, /"finish_reason":"stop"/);
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

test('OpenAI Chat completion with tool calls forces Anthropic tool_use stop reason', () => {
  const anthropic = convertOpenAIChatCompletionToAnthropicMessage({
    id: 'chatcmpl_tool_stop',
    object: 'chat.completion',
    created: 1700000000,
    model: 'agy-claude',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_read',
          type: 'function',
          function: {
            name: 'Read',
            arguments: '{"file_path":"/tmp/example.txt"}'
          }
        }]
      },
      finish_reason: 'stop'
    }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
  }, 'agy-claude');

  assert.equal(anthropic.stop_reason, 'tool_use');
  assert.deepEqual(anthropic.content, [{
    type: 'tool_use',
    id: 'call_read',
    name: 'Read',
    input: { file_path: '/tmp/example.txt' }
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
  assert.match(gemini, /"functionCall":\{"id":"call_1","name":"lookup","args":\{"q":"x"\}\}/);
  assert.match(gemini, /"finishReason":"STOP"/);
});

test('canonical stream pipeline renders Gemini SSE to Anthropic and OpenAI streams', () => {
  const sse = [
    'data: {"modelVersion":"gemini-2.5-pro","candidates":[{"content":{"role":"model","parts":[{"text":"hello"}]},"index":0}]}',
    '',
    'data: {"modelVersion":"gemini-2.5-pro","candidates":[{"content":{"role":"model","parts":[{"functionCall":{"id":"call_1","name":"lookup","args":{"q":"x"}}}]},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":3,"totalTokenCount":5}}',
    ''
  ].join('\n');

  const anthropic = createSseTransformStream('gemini_stream_generate_content', 'anthropic_messages', {
    fallbackModel: 'gemini-2.5-pro'
  });
  anthropic.write(sse);
  const anthropicOut = anthropic.end();
  assert.match(anthropicOut, /event: content_block_delta/);
  assert.match(anthropicOut, /"text":"hello"/);
  assert.match(anthropicOut, /"type":"tool_use"/);
  assert.match(anthropicOut, /"name":"lookup"/);
  assert.match(anthropicOut, /"stop_reason":"tool_use"/);

  const openai = createSseTransformStream('gemini_stream_generate_content', 'openai_chat', {
    fallbackModel: 'gemini-2.5-pro'
  });
  openai.write(sse);
  const openaiOut = openai.end();
  assert.match(openaiOut, /"content":"hello"/);
  assert.match(openaiOut, /"tool_calls"/);
  assert.match(openaiOut, /"finish_reason":"tool_calls"/);
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

test('OpenAI tool-call SSE with stop finish reason renders Anthropic tool_use stop reason', () => {
  const sse = [
    'data: {"id":"chatcmpl_stream_tool_stop","object":"chat.completion.chunk","created":1700000000,"model":"agy-claude","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_read","type":"function","function":{"name":"Read","arguments":"{\\"file_path\\":\\"/tmp"}}]},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl_stream_tool_stop","object":"chat.completion.chunk","created":1700000000,"model":"agy-claude","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"/example.txt\\"}"}}]},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl_stream_tool_stop","object":"chat.completion.chunk","created":1700000000,"model":"agy-claude","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    ''
  ].join('\n');

  const anthropic = convertOpenAIChatSseToAnthropicSse(sse, 'agy-claude');
  assert.match(anthropic, /"type":"tool_use"/);
  assert.match(anthropic, /"name":"Read"/);
  assert.match(anthropic, /"partial_json":"\{\\"file_path\\":\\"\/tmp"/);
  assert.match(anthropic, /"stop_reason":"tool_use"/);

  const chunks = [];
  const transform = createSseTransformStream('openai_chat', 'anthropic_messages', {
    fallbackModel: 'agy-claude',
    onChunk: (chunk) => chunks.push(chunk)
  });
  transform.write(sse.slice(0, Math.floor(sse.length / 2)));
  transform.write(sse.slice(Math.floor(sse.length / 2)));
  transform.end();

  assert.match(chunks.join(''), /"stop_reason":"tool_use"/);
});

test('OpenAI tool-call SSE waits for tool name before rendering Anthropic tool block', () => {
  const sse = [
    'data: {"id":"chatcmpl_stream_tool_late_name","object":"chat.completion.chunk","created":1700000000,"model":"agy-claude","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_read","type":"function","function":{"arguments":"{\\"file_path\\""}}]},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl_stream_tool_late_name","object":"chat.completion.chunk","created":1700000000,"model":"agy-claude","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"Read","arguments":":\\"/tmp/example.txt\\"}"}}]},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl_stream_tool_late_name","object":"chat.completion.chunk","created":1700000000,"model":"agy-claude","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    ''
  ].join('\n');

  const anthropic = convertOpenAIChatSseToAnthropicSse(sse, 'agy-claude');
  assert.doesNotMatch(anthropic, /"name":""/);
  assert.match(anthropic, /"id":"call_read"/);
  assert.match(anthropic, /"name":"Read"/);
  assert.match(anthropic, /"partial_json":"\{\\"file_path\\":\\"\/tmp\/example\.txt\\"\}"/);
  assert.match(anthropic, /"stop_reason":"tool_use"/);

  const chunks = [];
  const transform = createSseTransformStream('openai_chat', 'anthropic_messages', {
    fallbackModel: 'agy-claude',
    onChunk: (chunk) => chunks.push(chunk)
  });
  sse.split('\n').forEach((line) => transform.write(`${line}\n`));
  transform.end();

  const streamed = chunks.join('');
  assert.doesNotMatch(streamed, /"name":""/);
  assert.match(streamed, /"name":"Read"/);
  assert.match(streamed, /"partial_json":"\{\\"file_path\\":\\"\/tmp\/example\.txt\\"\}"/);
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
        parts: [{ functionCall: { id: 'call_lookup_1', name: 'lookup', args: { q: 'x' } } }]
      },
      {
        role: 'user',
        parts: [{ functionResponse: { id: 'call_lookup_1', name: 'lookup', response: { ok: true } } }]
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
  assert.equal(openAI.messages[1].tool_calls[0].id, 'call_lookup_1');
  assert.equal(openAI.messages[1].tool_calls[0].function.name, 'lookup');
  assert.equal(openAI.messages[2].role, 'tool');
  assert.equal(openAI.messages[2].tool_call_id, 'call_lookup_1');
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
    functionCall: { id: 'call_1', name: 'lookup', args: { q: 'x' } }
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
