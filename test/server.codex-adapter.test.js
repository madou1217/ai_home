const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { handleCodexChatCompletions, __private } = require('../lib/server/codex-adapter');
const { getAccountModelCooldownUntil } = require('../lib/server/account-runtime-state');
const { chooseServerAccount, markProxyAccountFailure } = require('../lib/server/router');

const accountRef = (value) => `acct_${String(value).padStart(20, '0')}`;

function createResCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    write(chunk = '') { this.body += String(chunk); },
    end(chunk = '') { this.body += String(chunk); }
  };
}

test('codex adapter converts openai chat payload to codex responses payload', () => {
  const payload = __private.convertOpenAIChatToCodexPayload({
    model: 'gpt-any-model',
    stream: true,
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hello' }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Lookup info',
          parameters: { type: 'object', properties: { q: { type: 'string' } } }
        }
      }
    ]
  });
  assert.equal(payload.model, 'gpt-any-model');
  assert.equal(payload.stream, true);
  assert.equal(Array.isArray(payload.input), true);
  assert.equal(payload.input[0].role, 'developer');
  assert.equal(payload.input[1].role, 'user');
  assert.equal(payload.tools[0].name, 'lookup');
});

test('codex adapter applies provider protocol parameter policy to native responses payloads', () => {
  const payload = __private.convertOpenAIResponsesToCodexPayload({
    model: 'gpt-any-model',
    provider: 'codex',
    stream: false,
    temperature: 0.7,
    max_output_tokens: 128,
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hello' }]
    }]
  }, 'gpt-target-model', { forceStream: true });

  assert.equal(payload.model, 'gpt-target-model');
  assert.equal(payload.stream, true);
  assert.equal(payload.max_output_tokens, 128);
  assert.equal(Object.hasOwn(payload, 'provider'), false);
  assert.equal(Object.hasOwn(payload, 'temperature'), false);
});

test('codex adapter rebuilds native non-stream output from output_item.done events', () => {
  const sse = [
    'data: {"type":"response.created","response":{"id":"resp_native","created_at":1700000000,"model":"gpt-5.5","output":[]}}',
    '',
    'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"rs_1","type":"reasoning","content":[],"summary":[]}}',
    '',
    'data: {"type":"response.output_item.done","output_index":1,"item":{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"AIH_REAL_TEXT"}]}}',
    '',
    'data: {"type":"response.completed","response":{"id":"resp_native","object":"response","created_at":1700000000,"status":"completed","model":"gpt-5.5","output":[],"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}',
    ''
  ].join('\n');

  const response = __private.extractNativeCompletedResponse(sse);
  assert.equal(response.id, 'resp_native');
  assert.equal(response.output.length, 2);
  assert.equal(response.output[1].content[0].text, 'AIH_REAL_TEXT');
  assert.equal(response.output_text, 'AIH_REAL_TEXT');
});

test('codex adapter resolves model from request/cache/config without hardcoded aliases', () => {
  assert.equal(__private.resolveCodexModel('direct-model', {}, {}), 'direct-model');
  assert.equal(__private.resolveCodexModel('', {}, {
    modelsCache: { ids: ['cached-model'] }
  }), 'cached-model');
  assert.equal(__private.resolveCodexModel('', { codexModels: 'cfg-model-a,cfg-model-b' }, {
    modelsCache: { ids: [] }
  }), 'cfg-model-a');
  assert.equal(__private.resolveCodexModel('', {}, { modelsCache: { ids: [] } }), '');
});

test('codex adapter parses models list returned by codex upstream', () => {
  const ids = __private.parseCodexModelsResponse({
    models: [
      { slug: 'gpt-5.3-codex', supported_in_api: true, visibility: 'list' },
      { slug: 'gpt-hidden', supported_in_api: true, visibility: 'private' },
      { slug: 'gpt-disabled', supported_in_api: false, visibility: 'list' }
    ]
  });
  assert.deepEqual(ids, ['gpt-5.3-codex']);
});

test('codex adapter parses OpenAI-compatible model list payloads', () => {
  const ids = __private.parseCodexModelsResponse({
    data: [
      { id: 'gpt-5.5' },
      { id: 'gpt-5.4-mini', supported_in_api: true, visibility: 'public' },
      { id: 'gpt-hidden', supported_in_api: true, visibility: 'private' }
    ]
  });
  assert.deepEqual(ids, ['gpt-5.5', 'gpt-5.4-mini']);
});

test('codex adapter fetches upstream models with client_version query', async () => {
  const seen = { url: '', headers: {} };
  const ids = await __private.fetchCodexModelsForAccount({
    options: {
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      codexClientVersion: 'codex-cli 0.130.0',
      proxyUrl: '',
      noProxy: ''
    },
    account: {
      accessToken: 'token',
      upstreamAccountId: 'acct_1'
    },
    fetchWithTimeout: async (url, init) => {
      seen.url = url;
      seen.headers = init.headers || {};
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          models: [{ slug: 'gpt-5.3-codex', supported_in_api: true, visibility: 'list' }]
        })
      };
    },
    timeoutMs: 1234
  });
  assert.equal(seen.url.includes('client_version=0.130.0'), true);
  assert.equal(seen.headers.version, '0.130.0');
  assert.equal(seen.headers['user-agent'], 'codex_cli_rs/0.130.0');
  assert.equal(seen.headers['chatgpt-account-id'], 'acct_1');
  assert.deepEqual(ids, ['gpt-5.3-codex']);
});

test('codex adapter decodes compressed model error bodies', async () => {
  const body = zlib.gzipSync(Buffer.from(JSON.stringify({
    error: { message: 'auth expired for models' }
  })));

  await assert.rejects(
    () => __private.fetchCodexModelsForAccount({
      options: {
        codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
        proxyUrl: '',
        noProxy: ''
      },
      account: {
        accessToken: 'token'
      },
      fetchWithTimeout: async () => ({
        ok: false,
        status: 401,
        headers: new Map(),
        arrayBuffer: async () => body
      }),
      timeoutMs: 1234
    }),
    /upstream_401: .*auth expired for models/
  );
});

test('codex adapter omits client_version when startup detection is unavailable', async () => {
  const seen = { url: '', headers: {} };
  await __private.fetchCodexModelsForAccount({
    options: {
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      proxyUrl: '',
      noProxy: ''
    },
    account: {
      accessToken: 'token'
    },
    fetchWithTimeout: async (url, init) => {
      seen.url = url;
      seen.headers = init.headers || {};
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          models: [{ slug: 'gpt-5.3-codex', supported_in_api: true, visibility: 'list' }]
        })
      };
    },
    timeoutMs: 1234
  });
  assert.equal(seen.url, 'https://chatgpt.com/backend-api/codex/models');
  assert.equal(seen.headers.version, undefined);
  assert.equal(seen.headers['user-agent'], undefined);
});

test('codex adapter fetches api key account models from account openai base url', async () => {
  const seen = { url: '', headers: {} };
  const ids = await __private.fetchCodexModelsForAccount({
    options: {
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      proxyUrl: '',
      noProxy: ''
    },
    account: {
      accessToken: 'sk-live',
      apiKeyMode: true,
      authType: 'api-key',
      openaiBaseUrl: 'https://proxy.example.com/v1'
    },
    fetchWithTimeout: async (url, init) => {
      seen.url = url;
      seen.headers = init.headers || {};
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          models: [{ slug: 'gpt-api-key', supported_in_api: true, visibility: 'list' }]
        })
      };
    },
    timeoutMs: 1234
  });
  assert.equal(seen.url.startsWith('https://proxy.example.com/v1/models'), true);
  assert.equal(seen.headers.authorization, 'Bearer sk-live');
  assert.deepEqual(ids, ['gpt-api-key']);
});

test('codex adapter posts chat completions to account openai base url for api key accounts', async () => {
  const res = createResCapture();
  const state = {
    accounts: {
      codex: [{
        accountRef: accountRef('10014'),
        email: 'api@example.com',
        accessToken: 'sk-live',
        apiKeyMode: true,
        authType: 'api-key',
        openaiBaseUrl: 'https://proxy.example.com/v1'
      }]
    },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  let seenUrl = '';
  let seenHeaders = {};

  await handleCodexChatCompletions({
    options: {
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      codexClientVersion: '0.130.0',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { headers: { 'content-type': 'application/json' } },
    res,
    requestJson: {
      model: 'gpt-5.3-codex',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }]
    },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { sessionKey: 's' },
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      refreshCodexAccessToken: async () => ({ ok: true, refreshed: false, reason: 'api_key_mode' }),
      fetchWithTimeout: async (url, init) => {
        seenUrl = String(url || '');
        seenHeaders = init && init.headers || {};
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_api',
              created_at: 1700000000,
              model: 'gpt-5.3-codex',
              output: [{
                type: 'message',
                content: [{ type: 'output_text', text: 'api key ok' }]
              }],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
            }
          })
        };
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(seenUrl, 'https://proxy.example.com/v1/responses');
  assert.equal(seenHeaders.version, '0.130.0');
  assert.equal(seenHeaders['user-agent'], 'codex_cli_rs/0.130.0');
  assert.equal(res.statusCode, 200);
  assert.match(String(res.body), /api key ok/);
});

test('codex adapter preserves native responses tool outputs for codex responses clients', async () => {
  const res = createResCapture();
  const state = {
    accounts: {
      codex: [{
        accountRef: accountRef('10014'),
        email: 'api@example.com',
        accessToken: 'sk-live',
        apiKeyMode: true,
        authType: 'api-key',
        openaiBaseUrl: 'https://proxy.example.com/v1'
      }]
    },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  let seenBody = null;

  await handleCodexChatCompletions({
    options: {
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      codexClientVersion: '0.130.0',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { headers: { 'content-type': 'application/json' } },
    res,
    requestJson: {
      model: 'gpt-5.4',
      stream: true,
      previous_response_id: 'resp_previous',
      input: [{
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'tool result'
      }]
    },
    routeKey: 'POST /v1/responses',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { sessionKey: 's', clientProtocol: 'openai_responses' },
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      refreshCodexAccessToken: async () => ({ ok: true, refreshed: false, reason: 'api_key_mode' }),
      fetchWithTimeout: async (_url, init) => {
        seenBody = JSON.parse(String(init && init.body || '{}'));
        return {
          ok: true,
          status: 200,
          text: async () => [
            'data: {"type":"response.created","response":{"id":"resp_next","model":"gpt-5.4"}}',
            '',
            'data: {"type":"response.completed","response":{"id":"resp_next","object":"response","status":"completed","model":"gpt-5.4","output":[]}}',
            '',
            'data: [DONE]',
            ''
          ].join('\n')
        };
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(seenBody.previous_response_id, 'resp_previous');
  assert.deepEqual(seenBody.input, [{
    type: 'function_call_output',
    call_id: 'call_1',
    output: 'tool result'
  }]);
  assert.equal(Object.hasOwn(seenBody, 'messages'), false);
  assert.equal(Object.hasOwn(seenBody, 'store'), false);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.match(String(res.body), /response\.completed/);
});

test('codex adapter omits unsupported native responses parameters before upstream fetch', async () => {
  const res = createResCapture();
  const state = {
    accounts: {
      codex: [{
        accountRef: accountRef('10014'),
        email: 'api@example.com',
        accessToken: 'sk-live',
        apiKeyMode: true,
        authType: 'api-key',
        openaiBaseUrl: 'https://proxy.example.com/v1'
      }]
    },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  let seenBody = null;

  await handleCodexChatCompletions({
    options: {
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { headers: { 'content-type': 'application/json' } },
    res,
    requestJson: {
      model: 'gpt-arbitrary-target',
      stream: true,
      temperature: 0.3,
      max_output_tokens: 128,
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'ping' }]
      }]
    },
    routeKey: 'POST /v1/responses',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { sessionKey: 's', clientProtocol: 'openai_responses' },
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      refreshCodexAccessToken: async () => ({ ok: true, refreshed: false, reason: 'api_key_mode' }),
      fetchWithTimeout: async (_url, init) => {
        seenBody = JSON.parse(String(init && init.body || '{}'));
        return {
          ok: true,
          status: 200,
          text: async () => [
            'data: {"type":"response.created","response":{"id":"resp_next","model":"gpt-arbitrary-target"}}',
            '',
            'data: {"type":"response.completed","response":{"id":"resp_next","object":"response","status":"completed","model":"gpt-arbitrary-target","output":[]}}',
            '',
            'data: [DONE]',
            ''
          ].join('\n')
        };
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(Object.hasOwn(seenBody, 'temperature'), false);
  assert.equal(seenBody.max_output_tokens, 128);
  assert.equal(seenBody.model, 'gpt-arbitrary-target');
  assert.equal(res.statusCode, 200);
});

test('codex adapter returns openai error shape for native responses upstream errors', async () => {
  const res = createResCapture();
  const state = {
    accounts: {
      codex: [{
        accountRef: accountRef('10014'),
        accessToken: 'sk-live',
        apiKeyMode: true,
        authType: 'api-key',
        openaiBaseUrl: 'https://proxy.example.com/v1'
      }]
    },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };

  await handleCodexChatCompletions({
    options: {
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { headers: { 'content-type': 'application/json' } },
    res,
    requestJson: {
      model: 'gpt-5.4',
      stream: true,
      input: [{ type: 'function_call_output', call_id: 'missing', output: 'x' }]
    },
    routeKey: 'POST /v1/responses',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { sessionKey: 's', clientProtocol: 'openai_responses' },
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      refreshCodexAccessToken: async () => ({ ok: true, refreshed: false, reason: 'api_key_mode' }),
      fetchWithTimeout: async () => ({
        ok: false,
        status: 400,
        headers: new Map(),
        text: async () => JSON.stringify({
          error: {
            message: 'No tool call found for function call output with call_id missing.',
            type: 'invalid_request_error',
            param: 'input',
            code: null
          }
        })
      }),
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(res.statusCode, 400);
  const body = JSON.parse(String(res.body));
  assert.equal(body.error.type, 'invalid_request_error');
  assert.match(body.error.message, /No tool call found/);
  assert.equal(body.ok, undefined);
});

test('codex adapter forces stream=true for upstream protocol', () => {
  const payload = __private.convertOpenAIChatToCodexPayload({
    model: 'stream-model',
    stream: false,
    messages: [{ role: 'user', content: 'hello' }]
  });
  assert.equal(payload.stream, true);
});

test('codex adapter converts codex SSE events to openai chunks', () => {
  const sse = [
    'data: {"type":"response.created","response":{"id":"resp_1","created_at":1700000000,"model":"dynamic-codex-model"}}',
    '',
    'data: {"type":"response.output_text.delta","delta":"he"}',
    '',
    'data: {"type":"response.output_text.delta","delta":"llo"}',
    '',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}',
    ''
  ].join('\n');
  const chunks = __private.convertCodexSseToOpenAIChunks(sse, 'dynamic-codex-model');
  assert.equal(chunks.length >= 3, true);
  assert.equal(chunks[0].object, 'chat.completion.chunk');
  assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'stop');
});

test('codex adapter preserves function arguments from codex output item done event', () => {
  const sse = [
    'data: {"type":"response.created","response":{"id":"resp_tool","created_at":1700000000,"model":"dynamic-codex-model"}}',
    '',
    'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"TodoWrite","arguments":""}}',
    '',
    'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"TodoWrite","arguments":"{\\"todos\\":[{\\"content\\":\\"fix adapter\\",\\"status\\":\\"in_progress\\",\\"activeForm\\":\\"fixing adapter\\"}]}"}}',
    '',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}',
    ''
  ].join('\n');

  const chunks = __private.convertCodexSseToOpenAIChunks(sse, 'dynamic-codex-model');
  const argumentText = chunks
    .flatMap((chunk) => chunk.choices[0].delta.tool_calls || [])
    .map((toolCall) => toolCall.function && toolCall.function.arguments || '')
    .join('');

  assert.match(argumentText, /"todos":\[/);
  assert.equal(JSON.parse(argumentText).todos[0].content, 'fix adapter');
  assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'tool_calls');
});

test('codex adapter recovers function arguments from completed response output', () => {
  const sse = [
    'data: {"type":"response.created","response":{"id":"resp_tool_done","created_at":1700000000,"model":"dynamic-codex-model"}}',
    '',
    'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_2","type":"function_call","call_id":"call_2","name":"Task","arguments":""}}',
    '',
    'data: {"type":"response.completed","response":{"output":[{"id":"fc_2","type":"function_call","call_id":"call_2","name":"Task","arguments":"{\\"description\\":\\"Explore\\",\\"prompt\\":\\"Read files\\",\\"subagent_type\\":\\"Explore\\"}"}],"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}',
    ''
  ].join('\n');

  const chunks = __private.convertCodexSseToOpenAIChunks(sse, 'dynamic-codex-model');
  const argumentText = chunks
    .flatMap((chunk) => chunk.choices[0].delta.tool_calls || [])
    .map((toolCall) => toolCall.function && toolCall.function.arguments || '')
    .join('');

  assert.equal(JSON.parse(argumentText).subagent_type, 'Explore');
  assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'tool_calls');
});

test('codex adapter can match final function arguments by call id', () => {
  const sse = [
    'data: {"type":"response.created","response":{"id":"resp_tool_call_id","created_at":1700000000,"model":"dynamic-codex-model"}}',
    '',
    'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_3","type":"function_call","call_id":"call_3","name":"TodoWrite","arguments":""}}',
    '',
    'data: {"type":"response.function_call_arguments.done","call_id":"call_3","arguments":"{\\"todos\\":[{\\"content\\":\\"match by call id\\",\\"status\\":\\"pending\\",\\"activeForm\\":\\"matching\\"}]}"}',
    '',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}',
    ''
  ].join('\n');

  const chunks = __private.convertCodexSseToOpenAIChunks(sse, 'dynamic-codex-model');
  const argumentText = chunks
    .flatMap((chunk) => chunk.choices[0].delta.tool_calls || [])
    .map((toolCall) => toolCall.function && toolCall.function.arguments || '')
    .join('');

  assert.equal(JSON.parse(argumentText).todos[0].content, 'match by call id');
  assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'tool_calls');
});

test('codex adapter converts completed codex response to openai completion', () => {
  const completion = __private.convertCodexResponseToOpenAICompletion({
    type: 'response.completed',
    response: {
      id: 'resp_2',
      created_at: 1700000001,
      model: 'dynamic-codex-model',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'hello world' }]
        }
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        total_tokens: 3
      }
    }
  }, 'dynamic-codex-model');
  assert.ok(completion);
  assert.equal(completion.object, 'chat.completion');
  assert.equal(completion.choices[0].message.content, 'hello world');
  assert.equal(completion.usage.total_tokens, 3);
});

test('codex adapter refreshes token on 401 and retries once', async () => {
  const res = createResCapture();
  const state = {
    accounts: {
      codex: [{ accountRef: accountRef('1'), email: 'a@example.com', upstreamAccountId: 'acc_1', accessToken: 'expired-token', refreshToken: 'rt_1' }]
    },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  let upstreamCalls = 0;
  let forcedRefreshCalls = 0;

  await handleCodexChatCompletions({
    options: {
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { headers: { 'content-type': 'application/json' } },
    res,
    requestJson: {
      model: 'gpt-5.3-codex',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }]
    },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { sessionKey: 's' },
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      refreshCodexAccessToken: async (account, opts) => {
        if (opts && opts.force) {
          forcedRefreshCalls += 1;
          account.accessToken = 'fresh-token';
          return { ok: true, refreshed: true };
        }
        return { ok: true, refreshed: false, reason: 'not_due' };
      },
      fetchWithTimeout: async (_url, init) => {
        upstreamCalls += 1;
        if (String(init && init.headers && init.headers.authorization || '').includes('expired-token')) {
          return {
            ok: false,
            status: 401,
            text: async () => '{"error":"expired"}'
          };
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_123',
              created_at: 1700000000,
              model: 'gpt-5.3-codex',
              output: [{
                type: 'message',
                content: [{ type: 'output_text', text: 'done' }]
              }],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
            }
          })
        };
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(forcedRefreshCalls, 1);
  assert.equal(upstreamCalls, 2);
  assert.equal(res.statusCode, 200);
  assert.match(String(res.body), /"chat\.completion"/);
  assert.match(String(res.body), /"done"/);
  assert.equal(state.metrics.totalSuccess, 1);
});

test('codex adapter returns pool unavailable when 401 remains after refresh', async () => {
  const res = createResCapture();
  const account = { accountRef: accountRef('10025'), email: 'code3@example.com', upstreamAccountId: 'acc_10025', accessToken: 'bad-token', refreshToken: 'bad-rt' };
  const state = {
    accounts: { codex: [account] },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  const failures = [];

  await handleCodexChatCompletions({
    options: {
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { headers: { 'content-type': 'application/json' } },
    res,
    requestJson: {
      model: 'gpt-5.3-codex',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }]
    },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { sessionKey: 's' },
    deps: {
      chooseServerAccount: (pool, _state, _cursor, options = {}) => {
        const excludedRefs = options.excludeAccountRefs instanceof Set ? options.excludeAccountRefs : new Set();
        return pool.find((item) => !excludedRefs.has(String(item.accountRef || '')) && Date.now() >= Number(item.cooldownUntil || 0)) || null;
      },
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      refreshCodexAccessToken: async () => ({ ok: false, refreshed: false, reason: 'refresh_http_401' }),
      fetchWithTimeout: async () => ({
        ok: false,
        status: 401,
        headers: new Map(),
        text: async () => '{"error":"unauthorized"}'
      }),
      markProxyAccountFailure: (target, reason, cooldownMs, threshold) => {
        failures.push({ accountRef: target.accountRef, reason });
        target.consecutiveFailures = Number(target.consecutiveFailures || 0) + 1;
        target.lastError = String(reason || '');
        if (target.consecutiveFailures >= threshold) {
          target.cooldownUntil = Date.now() + Math.max(1000, Number(cooldownMs) || 0);
        }
      },
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.deepEqual(failures, [{ accountRef: accountRef('10025'), reason: 'auth_invalid_reauth_required' }]);
  assert.equal(res.statusCode, 401);
  const body = JSON.parse(String(res.body));
  assert.equal(body.error, 'auth_invalid_reauth_required');
  assert.match(String(body.detail || ''), /runtime:auth_invalid:auth_invalid_reauth_required=1/);
});

test('codex adapter retries another account on deactivated workspace 402', async () => {
  const res = createResCapture();
  const state = {
    accounts: {
      codex: [
        { accountRef: accountRef('8'), email: 'code8@example.com', upstreamAccountId: 'acc_8', accessToken: 'deactivated-token' },
        { accountRef: accountRef('9'), email: 'code9@example.com', upstreamAccountId: 'acc_9', accessToken: 'ok-token' }
      ]
    },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  const failures = [];
  const chosen = [];

  await handleCodexChatCompletions({
    options: {
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      upstreamTimeoutMs: 3000,
      maxAttempts: 2,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { headers: { 'content-type': 'application/json' } },
    res,
    requestJson: {
      model: 'gpt-5.3-codex',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }]
    },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { sessionKey: 's' },
    deps: {
      chooseServerAccount: (pool, ctx) => {
        const account = pool[chosen.length] || pool[0];
        chosen.push(account.accountRef);
        return account;
      },
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      refreshCodexAccessToken: async () => ({ ok: true, refreshed: false, reason: 'not_due' }),
      fetchWithTimeout: async (_url, init) => {
        const auth = String(init && init.headers && init.headers.authorization || '');
        if (auth.includes('deactivated-token')) {
          return {
            ok: false,
            status: 402,
            text: async () => '{"detail":{"code":"deactivated_workspace"}}'
          };
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_9',
              created_at: 1700000000,
              model: 'gpt-5.3-codex',
              output: [{
                type: 'message',
                content: [{ type: 'output_text', text: 'recovered' }]
              }],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
            }
          })
        };
      },
      markProxyAccountFailure: (account, reason) => failures.push({ accountRef: account.accountRef, reason }),
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.deepEqual(chosen, [accountRef('8'), accountRef('9')]);
  assert.deepEqual(failures, [{ accountRef: accountRef('8'), reason: 'deactivated_workspace' }]);
  assert.equal(res.statusCode, 200);
  assert.match(String(res.body), /recovered/);
});

test('codex adapter retries another account when 200 SSE reports model capacity failure', async () => {
  const res = createResCapture();
  const state = {
    accounts: {
      codex: [
        { accountRef: accountRef('1'), email: 'a@example.com', upstreamAccountId: 'acc_1', accessToken: 'capacity-token' },
        { accountRef: accountRef('2'), email: 'b@example.com', upstreamAccountId: 'acc_2', accessToken: 'ok-token' }
      ]
    },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  const failures = [];
  const chosen = [];

  await handleCodexChatCompletions({
    options: {
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      upstreamTimeoutMs: 3000,
      maxAttempts: 2,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { headers: { 'content-type': 'application/json' } },
    res,
    requestJson: {
      model: 'gpt-5.3-codex',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }]
    },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { sessionKey: 's' },
    deps: {
      chooseServerAccount: (pool) => {
        const account = pool[chosen.length] || pool[0];
        chosen.push(account.accountRef);
        return account;
      },
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      refreshCodexAccessToken: async () => ({ ok: true, refreshed: false, reason: 'not_due' }),
      fetchWithTimeout: async (_url, init) => {
        const auth = String(init && init.headers && init.headers.authorization || '');
        if (auth.includes('capacity-token')) {
          return {
            ok: true,
            status: 200,
            text: async () => [
              'data: {"type":"response.failed","response":{"error":{"message":"Selected model is at capacity. Please try a different model."}}}',
              ''
            ].join('\n')
          };
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_2',
              created_at: 1700000000,
              model: 'gpt-5.3-codex',
              output: [{
                type: 'message',
                content: [{ type: 'output_text', text: 'recovered' }]
              }],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
            }
          })
        };
      },
      markProxyAccountFailure: (account, reason, cooldownMs, threshold, opts) => {
        failures.push({ accountRef: account.accountRef, reason, opts });
        markProxyAccountFailure(account, reason, cooldownMs, threshold, opts);
      },
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.deepEqual(chosen, [accountRef('1'), accountRef('2')]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].accountRef, accountRef('1'));
  assert.match(failures[0].reason, /Selected model is at capacity/);
  assert.equal(failures[0].opts.scope, 'model');
  assert.equal(failures[0].opts.model, 'gpt-5.3-codex');
  assert.equal(Number(state.accounts.codex[0].cooldownUntil || 0), 0);
  assert.equal(Number(state.accounts.codex[0].overloadUntil || 0), 0);
  assert.equal(getAccountModelCooldownUntil(state.accounts.codex[0], 'gpt-5.3-codex') > Date.now(), true);
  assert.equal(res.statusCode, 200);
  assert.match(String(res.body), /recovered/);
});

test('codex adapter skips an account only for the requested cooled model', async () => {
  const res = createResCapture();
  const cooledUntil = Date.now() + 60_000;
  const state = {
    accounts: {
      codex: [
        {
          accountRef: accountRef('1'),
          email: 'a@example.com',
          upstreamAccountId: 'acc_1',
          accessToken: 'cooled-token',
          modelCooldowns: { 'gpt-5.5': cooledUntil }
        },
        {
          accountRef: accountRef('2'),
          email: 'b@example.com',
          upstreamAccountId: 'acc_2',
          accessToken: 'ok-token'
        }
      ]
    },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  const chosen = [];

  await handleCodexChatCompletions({
    options: {
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      upstreamTimeoutMs: 3000,
      maxAttempts: 2,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { headers: { 'content-type': 'application/json' } },
    res,
    requestJson: {
      model: 'gpt-5.5',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }]
    },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { sessionKey: 's' },
    deps: {
      chooseServerAccount: (pool, selectionState, cursorKey, options) => {
        const account = chooseServerAccount(pool, selectionState, cursorKey, options);
        if (account) chosen.push(account.accountRef);
        return account;
      },
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      refreshCodexAccessToken: async () => ({ ok: true, refreshed: false, reason: 'not_due' }),
      fetchWithTimeout: async (_url, init) => {
        assert.equal(String(init && init.headers && init.headers.authorization || '').includes('cooled-token'), false);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_model_cooldown_skip',
              created_at: 1700000000,
              model: 'gpt-5.5',
              output: [{
                type: 'message',
                content: [{ type: 'output_text', text: 'ok' }]
              }],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
            }
          })
        };
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.deepEqual(chosen, [accountRef('2')]);
  assert.equal(Number(state.accounts.codex[0].cooldownUntil || 0), 0);
  assert.equal(getAccountModelCooldownUntil(state.accounts.codex[0], 'gpt-5.3-codex'), 0);
  assert.equal(res.statusCode, 200);
  assert.match(String(res.body), /ok/);
});

test('codex adapter reports model cooldown when no account can serve the requested model', async () => {
  const res = createResCapture();
  const state = {
    accounts: {
      codex: [{
        accountRef: accountRef('1'),
        email: 'a@example.com',
        upstreamAccountId: 'acc_1',
        accessToken: 'cooled-token',
        modelCooldowns: { 'gpt-5.5': Date.now() + 60_000 },
        lastError: 'quota exhausted for gpt-5.5'
      }]
    },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };

  await handleCodexChatCompletions({
    options: {
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { headers: { 'content-type': 'application/json' } },
    res,
    requestJson: {
      model: 'gpt-5.5',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }]
    },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { sessionKey: 's' },
    deps: {
      chooseServerAccount,
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      refreshCodexAccessToken: async () => ({ ok: true, refreshed: false, reason: 'not_due' }),
      fetchWithTimeout: async () => {
        throw new Error('cooled model should not call upstream');
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(res.statusCode, 503);
  const body = JSON.parse(String(res.body));
  assert.equal(body.error, 'no_available_account');
  assert.equal(body.availability.available, 0);
  assert.match(body.detail, /model_cooldown:gpt-5\.5:quota exhausted for gpt-5\.5=1/);
});

test('codex adapter logs stream disconnect account failure and retries another account', async () => {
  const res = createResCapture();
  const disconnectDetail = 'stream disconnected before completion: An error occurred while processing your request. '
    + 'You can retry your request, or contact us through our help center at help.openai.com if the error persists. '
    + 'Please include the request ID 4d251fd0-862a-4b1f-90a3-fb3ed9629f18 in your message.';
  const state = {
    accounts: {
      codex: [
        { accountRef: accountRef('1'), email: 'a@example.com', upstreamAccountId: 'acc_1', accessToken: 'disconnect-token' },
        { accountRef: accountRef('2'), email: 'b@example.com', upstreamAccountId: 'acc_2', accessToken: 'ok-token' }
      ]
    },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  const requestLogs = [];
  const chosen = [];

  await handleCodexChatCompletions({
    options: {
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      upstreamTimeoutMs: 3000,
      maxAttempts: 2,
      failureThreshold: 1,
      logRequests: true
    },
    state,
    req: { headers: { 'content-type': 'application/json' } },
    res,
    requestJson: {
      model: 'gpt-5.3-codex',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }]
    },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { requestId: 'local-req-1', sessionKey: 's' },
    deps: {
      chooseServerAccount: (pool) => {
        const account = pool[chosen.length] || pool[0];
        chosen.push(account.accountRef);
        return account;
      },
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      refreshCodexAccessToken: async () => ({ ok: true, refreshed: false, reason: 'not_due' }),
      fetchWithTimeout: async (_url, init) => {
        const auth = String(init && init.headers && init.headers.authorization || '');
        if (auth.includes('disconnect-token')) {
          return {
            ok: true,
            status: 200,
            headers: new Map([
              ['x-request-id', 'resp-header-id'],
              ['set-cookie', 'secret-cookie=1']
            ]),
            text: async () => [
              `data: ${JSON.stringify({ type: 'response.failed', response: { error: { message: disconnectDetail } } })}`,
              ''
            ].join('\n')
          };
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_2',
              created_at: 1700000000,
              model: 'gpt-5.3-codex',
              output: [{
                type: 'message',
                content: [{ type: 'output_text', text: 'recovered' }]
              }],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
            }
          })
        };
      },
      markProxyAccountFailure: (account, reason, cooldownMs, threshold) => {
        account.consecutiveFailures = Number(account.consecutiveFailures || 0) + 1;
        account.lastError = String(reason || '');
        if (account.consecutiveFailures >= threshold) {
          account.cooldownUntil = Date.now() + Math.max(1000, Number(cooldownMs) || 0);
        }
      },
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: (entry) => requestLogs.push(entry)
    }
  });

  assert.deepEqual(chosen, [accountRef('1'), accountRef('2')]);
  assert.equal(res.statusCode, 200);
  assert.match(String(res.body), /recovered/);
  const retryLog = requestLogs.find((entry) => entry.kind === 'account_retry_failure');
  assert.ok(retryLog);
  assert.equal(retryLog.requestId, 'local-req-1');
  assert.equal(retryLog.upstreamRequestId, '4d251fd0-862a-4b1f-90a3-fb3ed9629f18');
  assert.equal(retryLog.accountRef, accountRef('1'));
  assert.equal(retryLog.accountEmail, 'a@example.com');
  assert.equal(retryLog.error, 'stream_disconnected_before_completion');
  assert.equal(retryLog.provider, 'codex');
  assert.equal(retryLog.attempt, 1);
  assert.equal(retryLog.maxAttempts, 3);
  assert.equal(retryLog.requestedModel, 'gpt-5.3-codex');
  assert.equal(retryLog.effectiveModel, 'gpt-5.3-codex');
  assert.equal(retryLog.upstreamStatus, 200);
  assert.equal(retryLog.upstreamHeaders['x-request-id'], 'resp-header-id');
  assert.equal(Object.hasOwn(retryLog.upstreamHeaders, 'set-cookie'), false);
  assert.match(retryLog.upstreamBody, /stream disconnected before completion/);
  assert.match(retryLog.upstreamError, /stream disconnected before completion/);
});

test('codex adapter hides stream disconnect detail when all account attempts are exhausted', async () => {
  const res = createResCapture();
  const disconnectDetail = 'stream disconnected before completion: An error occurred while processing your request. '
    + 'Please include the request ID 4d251fd0-862a-4b1f-90a3-fb3ed9629f18 in your message.';
  const account = { accountRef: accountRef('1'), email: 'a@example.com', upstreamAccountId: 'acc_1', accessToken: 'disconnect-token' };
  const state = {
    accounts: { codex: [account] },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };

  await handleCodexChatCompletions({
    options: {
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: true
    },
    state,
    req: { headers: { 'content-type': 'application/json' } },
    res,
    requestJson: {
      model: 'gpt-5.3-codex',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }]
    },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { requestId: 'local-req-2', sessionKey: 's' },
    deps: {
      chooseServerAccount: (pool) => pool.find((item) => Date.now() >= Number(item.cooldownUntil || 0)) || null,
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      refreshCodexAccessToken: async () => ({ ok: true, refreshed: false, reason: 'not_due' }),
      fetchWithTimeout: async () => ({
        ok: true,
        status: 200,
        text: async () => [
          `data: ${JSON.stringify({ type: 'response.failed', response: { error: { message: disconnectDetail } } })}`,
          ''
        ].join('\n')
      }),
      markProxyAccountFailure: (target, reason, cooldownMs, threshold) => {
        target.consecutiveFailures = Number(target.consecutiveFailures || 0) + 1;
        target.lastError = String(reason || '');
        if (target.consecutiveFailures >= threshold) {
          target.cooldownUntil = Date.now() + Math.max(1000, Number(cooldownMs) || 0);
        }
      },
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(res.statusCode, 503);
  const body = JSON.parse(String(res.body));
  assert.equal(body.error, 'no_available_account');
  assert.match(String(body.detail || ''), /stream_disconnected_before_completion/);
  assert.doesNotMatch(String(body.detail || ''), /help\.openai\.com/);
  assert.doesNotMatch(String(body.detail || ''), /4d251fd0-862a-4b1f-90a3-fb3ed9629f18/);
});
