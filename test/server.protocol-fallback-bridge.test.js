const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createFallbackProtocolRequest,
  createMemoryResponse,
  resolveProviderProtocolRouteForBridge,
  runClientProtocolViaProviderProtocolRoute,
  runFallbackProtocolBridge,
  __private
} = require('../lib/server/protocol-fallback-bridge');
const { handleUpstreamPassthrough } = require('../lib/server/upstream-endpoints');

function createResCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[String(key || '').toLowerCase()] = value;
    },
    end(chunk = '') {
      this.body += String(chunk || '');
    }
  };
}

function parseDataSsePayloads(rawText) {
  return String(rawText || '')
    .split(/\n\n+/)
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => frame.split(/\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim())
    .filter((data) => data && data !== '[DONE]')
    .map((data) => JSON.parse(data));
}

test('protocol fallback bridge creates descriptor-driven fallback requests', () => {
  const res = createResCapture();
  const bridgeRequest = createFallbackProtocolRequest(res, {
    clientProtocol: 'anthropic_messages',
    payload: {
      model: 'claude-sonnet-4',
      max_tokens: 128,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'ping' }]
      }]
    },
    context: { pathname: '/v1/messages' }
  });

  assert.equal(res.body, '');
  assert.equal(bridgeRequest.fallbackProtocol, 'openai_chat');
  assert.equal(bridgeRequest.requestJson.model, 'claude-sonnet-4');
  assert.equal(bridgeRequest.requestJson.max_tokens, 128);
  assert.deepEqual(bridgeRequest.requestJson.messages, [{ role: 'user', content: 'ping' }]);
});

test('protocol fallback bridge prefers provider-native fallback protocols when reachable', () => {
  const res = createResCapture();
  const bridgeRequest = createFallbackProtocolRequest(res, {
    clientProtocol: 'anthropic_messages',
    provider: 'codex',
    payload: {
      model: 'gpt-5.3-codex',
      max_tokens: 128,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'ping' }]
      }]
    },
    context: { pathname: '/v1/messages' }
  });

  assert.equal(res.body, '');
  assert.equal(bridgeRequest.fallbackProtocol, 'openai_responses');
  assert.equal(bridgeRequest.requestJson.model, 'gpt-5.3-codex');
  assert.equal(bridgeRequest.requestJson.max_output_tokens, 128);
  assert.deepEqual(bridgeRequest.requestJson.input, [{
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'ping' }]
  }]);

  const streamRes = createResCapture();
  const streamBridgeRequest = createFallbackProtocolRequest(streamRes, {
    clientProtocol: 'anthropic_messages',
    provider: 'gemini',
    payload: {
      model: 'gemini-2.5-pro',
      stream: true,
      max_tokens: 128,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'ping' }]
      }]
    },
    context: { pathname: '/v1/messages', stream: true }
  });
  assert.equal(streamRes.body, '');
  assert.equal(streamBridgeRequest.fallbackProtocol, 'gemini_stream_generate_content');
  assert.equal(streamBridgeRequest.requestJson.model, 'gemini-2.5-pro');
  assert.deepEqual(streamBridgeRequest.requestJson.contents, [{ role: 'user', parts: [{ text: 'ping' }] }]);

  const opencodeRes = createResCapture();
  const opencodeBridgeRequest = createFallbackProtocolRequest(opencodeRes, {
    clientProtocol: 'anthropic_messages',
    provider: 'opencode',
    payload: {
      model: 'opencode-go/glm-5.2',
      stream: true,
      max_tokens: 128,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'ping' }]
      }]
    },
    context: { pathname: '/v1/messages', stream: true }
  });
  assert.equal(opencodeRes.body, '');
  assert.equal(opencodeBridgeRequest.fallbackProtocol, 'openai_chat');
  assert.equal(opencodeBridgeRequest.requestJson.model, 'opencode-go/glm-5.2');
  assert.equal(opencodeBridgeRequest.requestJson.stream, true);
  assert.deepEqual(opencodeBridgeRequest.requestJson.messages, [{ role: 'user', content: 'ping' }]);
});

test('protocol fallback bridge writes unavailable adapter errors declaratively', () => {
  const res = createResCapture();
  const bridgeRequest = createFallbackProtocolRequest(res, {
    clientProtocol: 'unsupported_protocol',
    payload: { model: 'x' }
  });

  assert.equal(bridgeRequest, null);
  assert.equal(res.statusCode, 500);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(res.body), {
    ok: false,
    error: 'protocol_adapter_request_unavailable',
    sourceProtocol: 'unsupported_protocol',
    targetProtocol: ''
  });
});

test('protocol fallback bridge adapts buffered OpenAI Chat responses back to client protocol', () => {
  const res = createResCapture();
  const upstreamRes = createMemoryResponse();
  upstreamRes.setHeader('content-type', 'application/json');
  upstreamRes.setHeader('content-length', '999');
  upstreamRes.setHeader('x-aih-server-account-id', 'a1');
  upstreamRes.end(JSON.stringify({
    id: 'chatcmpl_1',
    object: 'chat.completion',
    created: 1770000000,
    model: 'claude-sonnet-4',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'pong' },
      finish_reason: 'stop'
    }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
  }));

  __private.writeProtocolResponseFromBuffered(res, upstreamRes, {
    sourceProtocol: 'anthropic_messages',
    targetProtocol: 'openai_chat',
    context: { fallbackModel: 'claude-sonnet-4' }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['content-length'], undefined);
  assert.equal(res.headers['x-aih-server-account-id'], 'a1');
  const payload = JSON.parse(res.body);
  assert.equal(payload.type, 'message');
  assert.equal(payload.model, 'claude-sonnet-4');
  assert.deepEqual(payload.content, [{ type: 'text', text: 'pong' }]);
  assert.deepEqual(payload.usage, { input_tokens: 3, output_tokens: 4 });
});

test('protocol fallback bridge resolves gateway runners by fallback protocol', () => {
  const gateway = __private.resolveFallbackProtocolGateway('openai_chat');
  assert.equal(gateway.id, 'openai_chat_gateway');
  assert.equal(gateway.protocol, 'openai_chat');
  assert.equal(typeof gateway.run, 'function');
  const responsesGateway = __private.resolveFallbackProtocolGateway('openai_responses');
  assert.equal(responsesGateway.id, 'openai_responses_gateway');
  assert.equal(responsesGateway.protocol, 'openai_responses');
  assert.equal(typeof responsesGateway.run, 'function');
  const geminiGateway = __private.resolveFallbackProtocolGateway('gemini_generate_content');
  assert.equal(geminiGateway.id, 'gemini_generate_content_gateway');
  assert.equal(geminiGateway.protocol, 'gemini_generate_content');
  assert.equal(typeof geminiGateway.run, 'function');
  const geminiStreamGateway = __private.resolveFallbackProtocolGateway('gemini_stream_generate_content');
  assert.equal(geminiStreamGateway.id, 'gemini_stream_generate_content_gateway');
  assert.equal(geminiStreamGateway.protocol, 'gemini_stream_generate_content');
  assert.equal(typeof geminiStreamGateway.run, 'function');
  assert.equal(__private.resolveFallbackProtocolGateway('anthropic_messages'), null);
  assert.equal(__private.resolveFallbackRequestProtocol('anthropic_messages', 'codex'), 'openai_responses');
  assert.equal(__private.resolveFallbackRequestProtocol('anthropic_messages', 'gemini'), 'gemini_generate_content');
  assert.equal(__private.resolveFallbackRequestProtocol('anthropic_messages', 'gemini', { stream: true }), 'gemini_stream_generate_content');
  assert.equal(__private.resolveFallbackRequestProtocol('anthropic_messages', 'agy'), 'gemini_generate_content');
  assert.deepEqual(__private.resolveProviderFallbackRequestProtocol('anthropic_messages', 'codex'), 'openai_responses');
  assert.deepEqual(__private.resolveProviderFallbackRequestProtocol('anthropic_messages', 'gemini'), 'gemini_generate_content');
  assert.deepEqual(__private.resolveProviderFallbackRequestProtocol('anthropic_messages', 'unknown'), '');
});

test('protocol fallback bridge only composes reachable provider protocol routes when model matches', () => {
  assert.equal(resolveProviderProtocolRouteForBridge('anthropic_messages', 'claude', { model: 'qwen3.6-plus' }).transport, 'provider_passthrough');
  assert.equal(resolveProviderProtocolRouteForBridge('anthropic_messages', 'agy', { model: 'gemini-3.1-pro-high' }), null);
  assert.equal(__private.resolveProviderProtocolRouteForBridge('openai_chat', 'claude', { model: 'claude-sonnet-4' }).transport, 'provider_passthrough');
  assert.equal(__private.resolveProviderProtocolRouteForBridge('openai_chat', 'agy', { model: 'claude-4-6-thinking' }).transport, 'code_assist_anthropic_direct');
  assert.equal(__private.resolveProviderProtocolRouteForBridge('openai_chat', 'agy', { model: 'gemini-3.1-pro-high' }), null);
});

test('protocol fallback bridge can run a client protocol directly through a reachable provider route', async () => {
  const res = createResCapture();
  const route = resolveProviderProtocolRouteForBridge('openai_responses', 'agy', { model: 'claude-4-6-thinking' });
  let seenRequest = null;
  let seenRouteTransport = '';
  let seenRequestMeta = null;

  await runClientProtocolViaProviderProtocolRoute({
    clientProtocol: 'openai_responses',
    provider: 'agy',
    options: {},
    state: {},
    req: { url: '/v1/responses' },
    res,
    method: 'POST',
    routeKey: 'POST /v1/responses',
    requestStartedAt: 1,
    cooldownMs: 1000,
    requestJson: {
      model: 'claude-4-6-thinking',
      input: 'fetch',
      tools: [{
        type: 'function',
        name: 'CustomFetch',
        parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
      }],
      tool_choice: { type: 'function', name: 'CustomFetch' }
    },
    requestMeta: {},
    route,
    context: { pathname: '/v1/responses' },
    deps: {
      chooseServerAccount: () => null,
      resolveRequestProvider: () => 'agy',
      pushMetricError: () => {},
      writeJson: () => {},
      fetchWithTimeout: async () => ({}),
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {},
      fetchCodeAssistAnthropicMessage: async () => ({}),
      fetchCodeAssistAnthropicMessageStream: async function* () {},
      handleUpstreamPassthrough: async (ctx) => {
        seenRequest = ctx.requestJson;
        seenRequestMeta = ctx.requestMeta;
        seenRouteTransport = String(
          ctx.requestMeta
          && ctx.requestMeta.providerProtocolRoute
          && ctx.requestMeta.providerProtocolRoute.transport
          || ''
        );
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({
          id: 'msg_direct_response_bridge',
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
          usage: { input_tokens: 2, output_tokens: 3 }
        }));
      }
    }
  });

  assert.equal(seenRouteTransport, 'code_assist_anthropic_direct');
  assert.equal(seenRequestMeta.sourceClientProtocol, 'openai_responses');
  assert.deepEqual(seenRequestMeta.protocolAdapterPath, ['codex2claudeAdapter']);
  assert.deepEqual(seenRequest.tool_choice, { type: 'tool', name: 'CustomFetch' });
  assert.deepEqual(seenRequest.messages, [{ role: 'user', content: [{ type: 'text', text: 'fetch' }] }]);
  const body = JSON.parse(res.body);
  assert.equal(body.object, 'response');
  assert.equal(body.output[0].type, 'function_call');
  assert.equal(body.output[0].name, 'CustomFetch');
});

test('protocol fallback bridge keeps OpenAI clients on official Claude passthrough route', async () => {
  const res = createResCapture();
  const route = resolveProviderProtocolRouteForBridge('openai_chat', 'claude', { model: 'claude-sonnet-4' });
  let seenRequest = null;
  let seenRouteTransport = '';
  let seenRequestMeta = null;

  await runClientProtocolViaProviderProtocolRoute({
    clientProtocol: 'openai_chat',
    provider: 'claude',
    options: {},
    state: {},
    req: { url: '/v1/chat/completions' },
    res,
    method: 'POST',
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: 1,
    cooldownMs: 1000,
    requestJson: {
      model: 'claude-sonnet-4',
      messages: [{ role: 'user', content: 'ping' }],
      tools: [{
        type: 'function',
        function: {
          name: 'Read',
          parameters: {
            type: 'object',
            properties: { file_path: { type: 'string' } },
            required: ['file_path']
          }
        }
      }]
    },
    requestMeta: {},
    route,
    context: { pathname: '/v1/chat/completions' },
    deps: {
      chooseServerAccount: () => null,
      resolveRequestProvider: () => 'claude',
      pushMetricError: () => {},
      writeJson: () => {},
      fetchWithTimeout: async () => ({}),
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {},
      fetchCodeAssistAnthropicMessage: () => {
        throw new Error('agy_direct_adapter_should_not_run_for_official_claude');
      },
      fetchCodeAssistAnthropicMessageStream: async function* () {},
      handleUpstreamPassthrough: async (ctx) => {
        seenRequest = ctx.requestJson;
        seenRequestMeta = ctx.requestMeta;
        seenRouteTransport = String(
          ctx.requestMeta
          && ctx.requestMeta.providerProtocolRoute
          && ctx.requestMeta.providerProtocolRoute.transport
          || ''
        );
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({
          id: 'msg_official_claude_bridge',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4',
          content: [{
            type: 'tool_use',
            id: 'toolu_read_1',
            name: 'Read',
            input: { file_path: 'package.json' }
          }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 2, output_tokens: 3 }
        }));
      }
    }
  });

  assert.equal(seenRouteTransport, 'provider_passthrough');
  assert.equal(seenRequestMeta.effectiveProvider, 'claude');
  assert.equal(seenRequestMeta.sourceClientProtocol, 'openai_chat');
  assert.deepEqual(seenRequestMeta.protocolAdapterPath, ['openaiChat2claudeAdapter']);
  assert.deepEqual(seenRequest.messages, [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]);
  assert.equal(seenRequest.tools[0].name, 'Read');

  const body = JSON.parse(res.body);
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.choices[0].message.tool_calls[0].function.name, 'Read');
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
});

test('protocol fallback bridge keeps native Claude responses on the passthrough path', async () => {
  const res = createResCapture();
  const route = resolveProviderProtocolRouteForBridge('anthropic_messages', 'claude', {
    model: 'claude-opus-4-8'
  });
  let dispatchedResponse = null;

  await runClientProtocolViaProviderProtocolRoute({
    clientProtocol: 'anthropic_messages',
    provider: 'claude',
    options: {},
    state: {},
    req: { url: '/v1/messages' },
    res,
    method: 'POST',
    routeKey: 'POST /v1/messages',
    requestStartedAt: 1,
    cooldownMs: 1000,
    requestJson: {
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }]
    },
    requestMeta: {},
    route,
    context: { pathname: '/v1/messages' },
    deps: {
      chooseServerAccount: () => null,
      resolveRequestProvider: () => 'claude',
      pushMetricError: () => {},
      writeJson: () => {},
      fetchWithTimeout: async () => ({}),
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {},
      handleUpstreamPassthrough: async (ctx) => {
        dispatchedResponse = ctx.res;
        ctx.res.statusCode = 200;
        ctx.res.setHeader('content-type', 'application/octet-stream');
        ctx.res.end('opaque-native-response');
      }
    }
  });

  assert.equal(dispatchedResponse, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/octet-stream');
  assert.equal(res.body, 'opaque-native-response');
});

test('protocol fallback bridge preserves OpenAI Chat tool calls from OpenCode transport for Claude clients', async () => {
  const res = createResCapture();
  const model = 'opencode-go/glm-5.2';
  const route = resolveProviderProtocolRouteForBridge('anthropic_messages', 'opencode', { model });
  let seenRequest = null;
  let selectedAccount = null;

  await runClientProtocolViaProviderProtocolRoute({
    clientProtocol: 'anthropic_messages',
    provider: 'opencode',
    options: { provider: 'opencode', maxAttempts: 1, upstreamTimeoutMs: 1000 },
    state: {
      accounts: {
        opencode: [{ id: 'oc1', provider: 'opencode', accessToken: 'opencode-local' }]
      },
      cursors: { opencode: 0 },
      metrics: {
        totalFailures: 0,
        totalSuccess: 0,
        totalTimeouts: 0,
        providerCounts: {},
        providerSuccess: {},
        providerFailures: {}
      }
    },
    req: { url: '/v1/messages', headers: { 'content-type': 'application/json' } },
    res,
    method: 'POST',
    routeKey: 'POST /v1/messages',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestJson: {
      model,
      stream: true,
      max_tokens: 128,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'read package metadata' }]
      }],
      tools: [{
        name: 'Read',
        description: 'Read a file',
        input_schema: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path']
        }
      }],
      tool_choice: { type: 'tool', name: 'Read' }
    },
    requestMeta: {},
    route,
    context: { pathname: '/v1/messages', stream: true },
    deps: {
      chooseServerAccount: (pool) => {
        selectedAccount = pool[0];
        return pool[0];
      },
      resolveRequestProvider: () => 'opencode',
      pushMetricError: () => {},
      writeJson: (response, code, payload) => {
        response.statusCode = code;
        response.end(JSON.stringify(payload));
      },
      fetchWithTimeout: async () => {
        throw new Error('opencode transport should use fetchOpenCodeChatCompletion');
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {},
      fetchOpenCodeChatCompletion: async (_options, account, requestJson) => {
        selectedAccount = account;
        seenRequest = requestJson;
        return {
          id: 'chatcmpl_glm_tool',
          object: 'chat.completion',
          created: 1770000000,
          model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'call_read_package',
                type: 'function',
                function: {
                  name: 'Read',
                  arguments: '{"file_path":"package.json"}'
                }
              }]
            },
            finish_reason: 'tool_calls'
          }],
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }
        };
      },
      fetchOpenCodeChatCompletionStream: async (_options, account, requestJson) => {
        selectedAccount = account;
        seenRequest = requestJson;
        async function* makeStream() {
          const chunk1 = {
            id: 'chatcmpl_glm_tool',
            object: 'chat.completion.chunk',
            created: 1770000000,
            model,
            choices: [{
              index: 0,
              delta: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  index: 0,
                  id: 'call_read_package',
                  type: 'function',
                  function: {
                    name: 'Read',
                    arguments: JSON.stringify({ file_path: 'package.json' })
                  }
                }]
              }
            }]
          };
          const chunk2 = {
            id: 'chatcmpl_glm_tool',
            object: 'chat.completion.chunk',
            created: 1770000000,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }
          };
          const chunks = [
            `data: ${JSON.stringify(chunk1)}\n\n`,
            `data: ${JSON.stringify(chunk2)}\n\n`,
            'data: [DONE]\n\n'
          ];
          for (const chunk of chunks) {
            yield chunk;
          }
        }
        return {
          body: makeStream()
        };
      },
      handleUpstreamPassthrough
    }
  });

  assert.equal(selectedAccount.id, 'oc1');
  assert.equal(seenRequest.model, model);
  assert.equal(seenRequest.stream, true);
  assert.equal(seenRequest.tools[0].function.name, 'Read');
  assert.deepEqual(seenRequest.tool_choice, { type: 'function', function: { name: 'Read' } });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
  const events = parseDataSsePayloads(res.body);
  const toolStart = events.find((event) => (
    event.type === 'content_block_start'
    && event.content_block
    && event.content_block.type === 'tool_use'
  ));
  assert.ok(toolStart, res.body);
  assert.equal(toolStart.content_block.id, 'call_read_package');
  assert.equal(toolStart.content_block.name, 'Read');
  assert.equal(
    events.some((event) => (
      event.type === 'content_block_delta'
      && event.delta
      && event.delta.partial_json === '{"file_path":"package.json"}'
    )),
    true
  );
  const messageDelta = events.find((event) => event.type === 'message_delta');
  assert.equal(messageDelta.delta.stop_reason, 'tool_use');
  assert.deepEqual(messageDelta.usage, { input_tokens: 7, output_tokens: 3 });
});

test('protocol fallback bridge routes Gemini clients to AGY Claude without OpenAI wrapping', async () => {
  const res = createResCapture();
  const route = resolveProviderProtocolRouteForBridge('gemini_generate_content', 'agy', {
    model: 'claude-4-6-thinking'
  });
  let seenRequest = null;
  let seenRequestMeta = null;
  let openAIHandlerCalled = false;

  await runClientProtocolViaProviderProtocolRoute({
    clientProtocol: 'gemini_generate_content',
    provider: 'agy',
    options: {},
    state: {},
    req: { url: '/v1beta/models/claude-4-6-thinking:generateContent' },
    res,
    method: 'POST',
    routeKey: 'POST /v1beta/models/claude-4-6-thinking:generateContent',
    requestStartedAt: 1,
    cooldownMs: 1000,
    requestJson: {
      model: 'claude-4-6-thinking',
      contents: [{ role: 'user', parts: [{ text: 'read package metadata' }] }],
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
      }],
      toolConfig: {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: ['Read']
        }
      }
    },
    requestMeta: {},
    route,
    context: { pathname: '/v1beta/models/claude-4-6-thinking:generateContent' },
    deps: {
      chooseServerAccount: () => null,
      resolveRequestProvider: () => 'agy',
      pushMetricError: () => {},
      writeJson: () => {},
      fetchWithTimeout: async () => ({}),
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {},
      fetchCodeAssistAnthropicMessage: async () => ({}),
      fetchCodeAssistAnthropicMessageStream: async function* () {},
      handleCodexChatCompletions: async () => {
        openAIHandlerCalled = true;
      },
      handleUpstreamPassthrough: async (ctx) => {
        seenRequest = ctx.requestJson;
        seenRequestMeta = ctx.requestMeta;
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({
          id: 'msg_gemini_to_agy_claude',
          type: 'message',
          role: 'assistant',
          model: 'claude-4-6-thinking',
          content: [{
            type: 'tool_use',
            id: 'toolu_read_1',
            name: 'Read',
            input: { file_path: 'package.json' }
          }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 2, output_tokens: 3 }
        }));
      }
    }
  });

  assert.equal(openAIHandlerCalled, false);
  assert.equal(seenRequestMeta.effectiveProvider, 'agy');
  assert.equal(seenRequestMeta.sourceClientProtocol, 'gemini_generate_content');
  assert.deepEqual(seenRequestMeta.protocolAdapterPath, ['gemini2claudeAdapter']);
  assert.equal(seenRequestMeta.providerProtocolRoute.transport, 'code_assist_anthropic_direct');
  assert.deepEqual(seenRequest.messages, [{
    role: 'user',
    content: [{ type: 'text', text: 'read package metadata' }]
  }]);
  assert.equal(seenRequest.tools[0].name, 'Read');
  assert.deepEqual(seenRequest.tool_choice, { type: 'tool', name: 'Read' });

  const body = JSON.parse(res.body);
  assert.equal(body.candidates[0].finishReason, 'STOP');
  assert.deepEqual(body.candidates[0].content.parts, [{
    functionCall: {
      id: 'toolu_read_1',
      name: 'Read',
      args: { file_path: 'package.json' }
    }
  }]);
});

test('protocol fallback bridge streams Gemini clients to AGY Claude without OpenAI wrapping', async () => {
  const res = createResCapture();
  const route = resolveProviderProtocolRouteForBridge('gemini_stream_generate_content', 'agy', {
    model: 'claude-4-6-thinking'
  });
  let seenRequest = null;
  let seenRequestMeta = null;
  let seenRouteUrl = '';
  let openAIHandlerCalled = false;

  await runClientProtocolViaProviderProtocolRoute({
    clientProtocol: 'gemini_stream_generate_content',
    provider: 'agy',
    options: {},
    state: {},
    req: { url: '/v1beta/models/claude-4-6-thinking:streamGenerateContent' },
    res,
    method: 'POST',
    routeKey: 'POST /v1beta/models/claude-4-6-thinking:streamGenerateContent',
    requestStartedAt: 1,
    cooldownMs: 1000,
    requestJson: {
      model: 'claude-4-6-thinking',
      contents: [{ role: 'user', parts: [{ text: 'lookup account state' }] }],
      tools: [{
        functionDeclarations: [{
          name: 'CustomLookup',
          description: 'Lookup test data',
          parametersJsonSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query']
          }
        }]
      }],
      toolConfig: {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: ['CustomLookup']
        }
      }
    },
    requestMeta: {},
    route,
    context: {
      pathname: '/v1beta/models/claude-4-6-thinking:streamGenerateContent',
      stream: true
    },
    deps: {
      chooseServerAccount: () => null,
      resolveRequestProvider: () => 'agy',
      pushMetricError: () => {},
      writeJson: () => {},
      fetchWithTimeout: async () => ({}),
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {},
      fetchCodeAssistAnthropicMessage: async () => ({}),
      fetchCodeAssistAnthropicMessageStream: async function* () {},
      handleCodexChatCompletions: async () => {
        openAIHandlerCalled = true;
      },
      handleUpstreamPassthrough: async (ctx) => {
        seenRequest = ctx.requestJson;
        seenRequestMeta = ctx.requestMeta;
        seenRouteUrl = ctx.req.url;
        ctx.res.statusCode = 200;
        ctx.res.setHeader('content-type', 'text/event-stream; charset=utf-8');
        ctx.res.flushHeaders();
        ctx.res.write('data: {"type":"message_start","message":{"id":"msg_gemini_stream_to_agy_claude","type":"message","role":"assistant","model":"claude-4-6-thinking","content":[],"usage":{"input_tokens":3,"output_tokens":0}}}\n\n');
        ctx.res.write('data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_custom_lookup","name":"CustomLookup","input":{}}}\n\n');
        ctx.res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"account state\\"}"}}\n\n');
        ctx.res.write('data: {"type":"content_block_stop","index":0}\n\n');
        ctx.res.write('data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":5}}\n\n');
        ctx.res.write('data: {"type":"message_stop"}\n\n');
        ctx.res.end();
      }
    }
  });

  assert.equal(openAIHandlerCalled, false);
  assert.equal(seenRouteUrl, '/v1/messages');
  assert.equal(seenRequestMeta.effectiveProvider, 'agy');
  assert.equal(seenRequestMeta.sourceClientProtocol, 'gemini_stream_generate_content');
  assert.deepEqual(seenRequestMeta.protocolAdapterPath, ['geminiStream2claudeAdapter']);
  assert.equal(seenRequestMeta.providerProtocolRoute.transport, 'code_assist_anthropic_direct');
  assert.equal(seenRequest.stream, true);
  assert.deepEqual(seenRequest.messages, [{
    role: 'user',
    content: [{ type: 'text', text: 'lookup account state' }]
  }]);
  assert.equal(seenRequest.tools[0].name, 'CustomLookup');
  assert.deepEqual(seenRequest.tool_choice, { type: 'tool', name: 'CustomLookup' });

  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.match(res.body, /^data: /m);
  assert.doesNotMatch(res.body, /chat\.completion/);
  assert.doesNotMatch(res.body, /response\.created/);

  const payloads = parseDataSsePayloads(res.body);
  const functionCallPayload = payloads.find((payload) => {
    const parts = payload && payload.candidates && payload.candidates[0]
      && payload.candidates[0].content && payload.candidates[0].content.parts;
    return Array.isArray(parts) && parts.some((part) => part && part.functionCall);
  });
  assert.deepEqual(functionCallPayload.candidates[0].content.parts, [{
    functionCall: {
      id: 'toolu_custom_lookup',
      name: 'CustomLookup',
      args: { query: 'account state' }
    }
  }]);
  const finalPayload = payloads.find((payload) => (
    payload && payload.candidates && payload.candidates[0] && payload.candidates[0].finishReason
  ));
  assert.equal(finalPayload.candidates[0].finishReason, 'STOP');
  assert.deepEqual(finalPayload.usageMetadata, {
    promptTokenCount: 3,
    candidatesTokenCount: 5,
    totalTokenCount: 8
  });
});

test('protocol fallback bridge derives provider route path from route protocol', async () => {
  const res = createResCapture();
  const route = {
    id: 'openai_chat:gemini:passthrough',
    clientProtocol: 'gemini_generate_content',
    provider: 'gemini',
    transport: 'provider_passthrough',
    upstreamProtocol: 'gemini_generate_content',
    requestAdapter: null,
    responseAdapter: null
  };
  let seenUrl = '';
  let seenRouteKey = '';
  let seenRequest = null;

  await runClientProtocolViaProviderProtocolRoute({
    clientProtocol: 'openai_chat',
    provider: 'gemini',
    options: {},
    state: {},
    req: { url: '/v1/chat/completions' },
    res,
    method: 'POST',
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: 1,
    cooldownMs: 1000,
    requestJson: {
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'ping' }]
    },
    requestMeta: {},
    route,
    context: { pathname: '/v1/chat/completions' },
    deps: {
      chooseServerAccount: () => null,
      resolveRequestProvider: () => 'gemini',
      pushMetricError: () => {},
      writeJson: () => {},
      fetchWithTimeout: async () => ({}),
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {},
      handleUpstreamPassthrough: async (ctx) => {
        seenUrl = ctx.req.url;
        seenRouteKey = ctx.routeKey;
        seenRequest = ctx.requestJson;
        ctx.res.statusCode = 200;
        ctx.res.end(JSON.stringify({
          candidates: [{
            content: { role: 'model', parts: [{ text: 'pong' }] },
            finishReason: 'STOP'
          }],
          modelVersion: 'gemini-2.5-pro',
          usageMetadata: {
            promptTokenCount: 2,
            candidatesTokenCount: 3,
            totalTokenCount: 5
          }
        }));
      }
    }
  });

  assert.equal(seenUrl, '/v1beta/models/gemini-2.5-pro:generateContent');
  assert.equal(seenRouteKey, 'POST /v1beta/models/gemini-2.5-pro:generateContent');
  assert.deepEqual(seenRequest.contents, [{ role: 'user', parts: [{ text: 'ping' }] }]);
  const body = JSON.parse(res.body);
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.choices[0].message.content, 'pong');
});

test('protocol fallback bridge runs codex fallback through native OpenAI Responses gateway', async () => {
  const res = createResCapture();
  let seenRequest = null;
  let seenRequestMeta = null;

  await runFallbackProtocolBridge({
    clientProtocol: 'anthropic_messages',
    provider: 'codex',
    options: {},
    state: {},
    req: { url: '/v1/messages' },
    res,
    method: 'POST',
    routeKey: 'POST /v1/messages',
    requestStartedAt: 1,
    cooldownMs: 1000,
    requestMeta: {},
    bridgeRequest: {
      fallbackProtocol: 'openai_responses',
      requestJson: {
        model: 'gpt-5.3-codex',
        input: [{
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'ping' }]
        }]
      }
    },
    deps: {
      chooseServerAccount: () => null,
      pushMetricError: () => {},
      writeJson: () => {},
      fetchWithTimeout: async () => ({}),
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {},
      refreshCodexAccessToken: async () => null,
      handleCodexChatCompletions: async (ctx) => {
        seenRequest = ctx.requestJson;
        seenRequestMeta = ctx.requestMeta;
        ctx.res.statusCode = 200;
        ctx.res.setHeader('x-aih-server-account-id', 'c1');
        ctx.res.end(JSON.stringify({
          id: 'resp_codex_native',
          object: 'response',
          status: 'completed',
          model: 'gpt-5.3-codex',
          output: [{
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'pong' }]
          }],
          usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 }
        }));
      }
    }
  });

  assert.deepEqual(seenRequest.input[0].content, [{ type: 'input_text', text: 'ping' }]);
  assert.equal(seenRequestMeta.effectiveProvider, 'codex');
  assert.equal(seenRequestMeta.clientProtocol, 'openai_responses');
  assert.equal(res.headers['x-aih-server-account-id'], 'c1');
  const body = JSON.parse(res.body);
  assert.equal(body.type, 'message');
  assert.equal(body.model, 'gpt-5.3-codex');
  assert.deepEqual(body.content, [{ type: 'text', text: 'pong' }]);
  assert.deepEqual(body.usage, { input_tokens: 2, output_tokens: 3 });
});

test('protocol fallback bridge rejects unsupported fallback gateways without calling provider handlers', async () => {
  const res = createResCapture();
  let providerHandlerCalled = false;

  await runFallbackProtocolBridge({
    clientProtocol: 'openai_chat',
    provider: 'claude',
    options: {},
    state: {},
    req: { url: '/v1/chat/completions' },
    res,
    method: 'POST',
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: 1,
    cooldownMs: 1000,
    requestMeta: {},
    bridgeRequest: {
      fallbackProtocol: 'anthropic_messages',
      requestJson: { model: 'claude-sonnet-4', messages: [] }
    },
    deps: {
      handleUpstreamPassthrough: async () => {
        providerHandlerCalled = true;
      },
      handleCodexChatCompletions: async () => {
        providerHandlerCalled = true;
      }
    }
  });

  assert.equal(providerHandlerCalled, false);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(JSON.parse(res.body), {
    ok: false,
    error: 'protocol_gateway_unavailable',
    fallbackProtocol: 'anthropic_messages'
  });
});
