const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { handleCodexModels, handleCodexChatCompletions, __private } = require('../lib/server/codex-adapter');
const { buildModelAccountIndex } = require('../lib/server/model-account-index');
const { getAccountModelCooldownUntil } = require('../lib/server/account-runtime-state');
const { chooseServerAccount, markProxyAccountFailure, markProxyAccountSuccess } = require('../lib/server/router');

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

function createCompletedUpstreamResponse(text = 'recovered') {
  return {
    ok: true,
    status: 200,
    headers: new Map(),
    text: async () => JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp_recovered',
        created_at: 1700000000,
        model: 'gpt-5.6-sol',
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text }]
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      }
    })
  };
}

function createCodexModelMetadata(slug = 'gpt-5.6-sol') {
  return {
    slug,
    display_name: 'GPT-5.6-Sol',
    description: 'Codex model metadata',
    supported_in_api: true,
    visibility: 'list',
    supported_reasoning_levels: [{ effort: 'high', description: 'High' }],
    service_tiers: [{ id: 'priority', name: 'Fast', description: 'Faster' }],
    base_instructions: 'You are Codex.'
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

test('codex adapter removes response item ids with prefixes that do not match their types', () => {
  const request = {
    model: 'gpt-5.6-sol',
    input: [
      {
        type: 'reasoning',
        id: 'item_dab9d262cf10a9470f013136',
        summary: [{ type: 'summary_text', text: 'previous reasoning' }],
        encrypted_content: null
      },
      {
        type: 'reasoning',
        id: 'rs_valid_reasoning_id',
        summary: [],
        encrypted_content: 'opaque'
      },
      {
        type: 'message',
        id: 'item_invalid_message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'previous response' }]
      },
      {
        type: 'message',
        id: 'msg_previous',
        role: 'user',
        content: [{ type: 'input_text', text: 'continue' }]
      },
      {
        type: 'function_call',
        id: 'item_invalid_function_call',
        call_id: 'call_invalid',
        name: 'lookup',
        arguments: '{}'
      },
      {
        type: 'function_call',
        id: 'fc_valid_function_call',
        call_id: 'call_valid',
        name: 'lookup',
        arguments: '{}'
      },
      {
        type: 'function_call_output',
        id: 'item_invalid_function_call_output',
        call_id: 'call_valid',
        output: 'ok'
      },
      {
        type: 'function_call_output',
        id: 'fco_valid_function_call_output',
        call_id: 'call_valid',
        output: 'ok'
      },
      {
        type: 'custom_tool_call',
        id: 'item_invalid_custom_tool_call',
        call_id: 'call_custom',
        name: 'exec',
        input: '{}'
      },
      {
        type: 'custom_tool_call',
        id: 'ctc_valid_custom_tool_call',
        call_id: 'call_custom',
        name: 'exec',
        input: '{}'
      },
      {
        type: 'custom_tool_call_output',
        id: 'item_invalid_custom_tool_call_output',
        call_id: 'call_custom',
        output: 'ok'
      },
      {
        type: 'custom_tool_call_output',
        id: 'ctco_valid_custom_tool_call_output',
        call_id: 'call_custom',
        output: 'ok'
      }
    ]
  };

  const payload = __private.convertOpenAIResponsesToCodexPayload(request, 'gpt-5.6-sol');

  assert.equal(Object.hasOwn(payload.input[0], 'id'), false);
  assert.equal(payload.input[1].id, 'rs_valid_reasoning_id');
  assert.equal(Object.hasOwn(payload.input[2], 'id'), false);
  assert.equal(payload.input[3].id, 'msg_previous');
  assert.equal(Object.hasOwn(payload.input[4], 'id'), false);
  assert.equal(payload.input[5].id, 'fc_valid_function_call');
  assert.equal(Object.hasOwn(payload.input[6], 'id'), false);
  assert.equal(payload.input[7].id, 'fco_valid_function_call_output');
  assert.equal(Object.hasOwn(payload.input[8], 'id'), false);
  assert.equal(payload.input[9].id, 'ctc_valid_custom_tool_call');
  assert.equal(Object.hasOwn(payload.input[10], 'id'), false);
  assert.equal(payload.input[11].id, 'ctco_valid_custom_tool_call_output');
  assert.equal(request.input[0].id, 'item_dab9d262cf10a9470f013136');
  assert.equal(request.input[2].id, 'item_invalid_message');
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

test('codex adapter preserves native model metadata separately from OpenAI ids', () => {
  const metadata = createCodexModelMetadata();
  assert.deepEqual(__private.parseCodexModelCatalog({ models: [metadata] }), [metadata]);
  assert.deepEqual(__private.parseCodexModelCatalog({
    data: [{ id: metadata.slug }]
  }), []);
});

test('codex adapter projects a missing gateway alias from same-family native metadata', () => {
  const terra = createCodexModelMetadata('gpt-5.6-terra');
  const models = __private.buildCodexNativeModelCatalog(
    ['gpt-5.6-terra', 'gpt-5.6-sol'],
    { [accountRef('projection')]: [terra] }
  );
  assert.deepEqual(models.map((model) => model.slug), [
    'gpt-5.6-terra',
    'gpt-5.6-sol'
  ]);
  assert.equal(models[1].base_instructions, terra.base_instructions);
  assert.equal(models[1].availability_nux, null);
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

test('codex adapter serves the native ModelInfo contract to Codex clients', async () => {
  const metadata = createCodexModelMetadata();
  const res = createResCapture();
  const state = {
    accounts: {
      codex: [{
        accountRef: accountRef('catalog'),
        accessToken: 'token'
      }]
    },
    modelsCache: {
      updatedAt: 0,
      ids: [],
      byAccount: {},
      catalogByAccount: {},
      sourceCount: 0
    }
  };

  await handleCodexModels({
    options: {
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      codexClientVersion: 'codex-cli 0.145.0',
      modelsProbeAccounts: 1,
      modelsCacheTtlMs: 300000
    },
    state,
    res,
    responseFormat: 'codex',
    deps: {
      buildOpenAIModelsList() {
        throw new Error('native catalog must not be flattened');
      },
      fetchWithTimeout: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ models: [metadata] })
      })
    }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-aih-models-format'], 'codex');
  assert.deepEqual(JSON.parse(res.body), { models: [metadata] });
  assert.deepEqual(state.modelsCache.catalogByAccount[accountRef('catalog')], [metadata]);
});

test('codex adapter never returns an OpenAI data list to a native catalog request', async () => {
  const res = createResCapture();
  await handleCodexModels({
    options: {
      codexBaseUrl: 'https://proxy.example.test/v1',
      modelsProbeAccounts: 1,
      modelsCacheTtlMs: 300000
    },
    state: {
      accounts: {
        codex: [{
          accountRef: accountRef('openai-list'),
          accessToken: 'token',
          apiKeyMode: true,
          openaiBaseUrl: 'https://proxy.example.test/v1'
        }]
      },
      modelsCache: { updatedAt: 0, ids: [], byAccount: {}, catalogByAccount: {} }
    },
    res,
    responseFormat: 'codex',
    deps: {
      buildOpenAIModelsList() {
        throw new Error('native catalog must not be flattened');
      },
      fetchWithTimeout: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          object: 'list',
          data: [{ id: 'gpt-5.6-sol' }]
        })
      })
    }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['x-aih-models-format'], 'codex');
  assert.equal(res.headers['x-aih-models-fallback'], 'metadata-unavailable');
  assert.deepEqual(JSON.parse(res.body), { models: [] });
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

test('codex adapter preserves a structured safety rejection without rotating accounts', async () => {
  const res = createResCapture();
  const accounts = [
    {
      accountRef: accountRef('safety-1'),
      accessToken: 'sk-live-1',
      apiKeyMode: true,
      authType: 'api-key',
      openaiBaseUrl: 'https://relay-one.example.com/v1'
    },
    {
      accountRef: accountRef('safety-2'),
      accessToken: 'sk-live-2',
      apiKeyMode: true,
      authType: 'api-key',
      openaiBaseUrl: 'https://relay-two.example.com/v1'
    }
  ];
  const state = {
    accounts: { codex: accounts },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  let upstreamCalls = 0;
  let failureMarks = 0;
  const diagnosticLogs = [];

  await handleCodexChatCompletions({
    options: {
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      upstreamTimeoutMs: 3000,
      maxAttempts: 3,
      failureThreshold: 1,
      logRequests: true
    },
    state,
    req: { headers: { 'content-type': 'application/json' } },
    res,
    requestJson: {
      model: 'gpt-5.6-sol',
      stream: false,
      input: 'ordinary product debugging request'
    },
    routeKey: 'POST /v1/responses',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { sessionKey: 'safety', clientProtocol: 'openai_responses' },
    deps: {
      chooseServerAccount: (pool, _state, _key, selection = {}) => pool.find(
        (account) => !selection.excludeAccountRefs.has(account.accountRef)
      ) || null,
      pushMetricError: () => {},
      writeJson: (response, code, payload) => {
        response.statusCode = code;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(payload));
      },
      refreshCodexAccessToken: async () => ({ ok: true, refreshed: false, reason: 'api_key_mode' }),
      fetchWithTimeout: async () => {
        upstreamCalls += 1;
        return {
          ok: false,
          status: 500,
          headers: new Map([['content-type', 'application/json']]),
          text: async () => JSON.stringify({
            error: {
              message: 'sensitive words detected',
              type: 'new_api_error',
              code: 'sensitive_words_detected'
            }
          })
        };
      },
      markProxyAccountFailure: () => { failureMarks += 1; },
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: (entry) => diagnosticLogs.push(entry)
    }
  });

  assert.equal(upstreamCalls, 1);
  assert.equal(failureMarks, 0);
  assert.equal(res.statusCode, 403);
  const body = JSON.parse(String(res.body));
  assert.deepEqual(body, {
    error: {
      message: 'The configured upstream rejected this request under its safety policy',
      type: 'permission_error',
      param: null,
      code: 'upstream_safety_rejected'
    }
  });
  assert.equal(String(res.body).includes('sensitive_words_detected'), false);
  assert.equal(diagnosticLogs.length, 1);
  assert.equal(diagnosticLogs[0].kind, 'request_safety_rejected');
  assert.equal(diagnosticLogs[0].error, 'upstream_safety_rejected');
  assert.equal(Object.hasOwn(diagnosticLogs[0], 'upstreamBody'), false);
  assert.equal(Object.hasOwn(diagnosticLogs[0], 'upstreamError'), false);
});

test('codex adapter stops on a structured SSE safety rejection without rotating accounts', async () => {
  const res = createResCapture();
  const accounts = [
    {
      accountRef: accountRef('sse-safety-1'),
      accessToken: 'sk-live-1',
      apiKeyMode: true,
      authType: 'api-key',
      openaiBaseUrl: 'https://relay-one.example.com/v1'
    },
    {
      accountRef: accountRef('sse-safety-2'),
      accessToken: 'sk-live-2',
      apiKeyMode: true,
      authType: 'api-key',
      openaiBaseUrl: 'https://relay-two.example.com/v1'
    }
  ];
  const state = {
    accounts: { codex: accounts },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  let upstreamCalls = 0;
  let failureMarks = 0;

  await handleCodexChatCompletions({
    options: {
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      upstreamTimeoutMs: 3000,
      maxAttempts: 3,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { headers: { 'content-type': 'application/json' } },
    res,
    requestJson: {
      model: 'gpt-5.6-sol',
      stream: false,
      input: 'ordinary product debugging request'
    },
    routeKey: 'POST /v1/responses',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { sessionKey: 'sse-safety', clientProtocol: 'openai_responses' },
    deps: {
      chooseServerAccount: (pool, _state, _key, selection = {}) => pool.find(
        (account) => !selection.excludeAccountRefs.has(account.accountRef)
      ) || null,
      pushMetricError: () => {},
      writeJson: (response, code, payload) => {
        response.statusCode = code;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(payload));
      },
      refreshCodexAccessToken: async () => ({ ok: true, refreshed: false, reason: 'api_key_mode' }),
      fetchWithTimeout: async () => {
        upstreamCalls += 1;
        return {
          ok: true,
          status: 200,
          headers: new Map([['content-type', 'text/event-stream']]),
          text: async () => [
            'data: {"type":"response.failed","response":{"error":{"message":"sensitive words detected","code":"sensitive_words_detected"}}}',
            '',
            'data: [DONE]',
            ''
          ].join('\n')
        };
      },
      markProxyAccountFailure: () => { failureMarks += 1; },
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(upstreamCalls, 1);
  assert.equal(failureMarks, 0);
  assert.equal(res.statusCode, 403);
  const body = JSON.parse(String(res.body));
  assert.equal(body.error.code, 'upstream_safety_rejected');
  assert.equal(String(res.body).includes('sensitive_words_detected'), false);
});

test('codex adapter returns SSE invalid_request_error without retrying or cooling the account', async () => {
  const res = createResCapture();
  const account = {
    accountRef: accountRef('invalid-sse'),
    accessToken: 'sk-live',
    apiKeyMode: true,
    authType: 'api-key',
    openaiBaseUrl: 'https://proxy.example.com/v1'
  };
  const state = {
    accounts: { codex: [account] },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  const failures = [];
  const requestLogs = [];
  let upstreamCalls = 0;

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
      model: 'gpt-5.6-sol',
      stream: true,
      input: [{ type: 'reasoning', id: 'item_invalid', summary: [] }]
    },
    routeKey: 'POST /v1/responses',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { sessionKey: 'invalid-sse', clientProtocol: 'openai_responses' },
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      refreshCodexAccessToken: async () => ({ ok: true, refreshed: false, reason: 'api_key_mode' }),
      fetchWithTimeout: async () => {
        upstreamCalls += 1;
        return {
          ok: true,
          status: 200,
          headers: new Map(),
          text: async () => [
            'event: error',
            'data: {"type":"error","code":"invalid_request_error","message":"[ApiIdParam] invalid reasoning id","sequence_number":0}',
            ''
          ].join('\n')
        };
      },
      markProxyAccountFailure: (failedAccount) => failures.push(failedAccount.accountRef),
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: (entry) => {
        failures.push(entry.kind || 'request');
        if (!entry.kind) requestLogs.push(entry);
      }
    }
  });

  assert.equal(upstreamCalls, 1);
  assert.deepEqual(failures, ['request']);
  assert.equal(res.statusCode, 400);
  const body = JSON.parse(String(res.body));
  assert.equal(body.error.type, 'invalid_request_error');
  assert.equal(body.error.message, '[ApiIdParam] invalid reasoning id');
  assert.equal(Number(account.cooldownUntil || 0), 0);
  assert.equal(Number(account.consecutiveFailures || 0), 0);
  assert.equal(requestLogs[0].accountRef, account.accountRef);
  assert.equal(requestLogs[0].accountAuthType, 'api-key');
  assert.equal(requestLogs[0].apiKeyMode, true);
  assert.equal(requestLogs[0].openaiBaseUrl, 'https://proxy.example.com/v1');
  assert.equal(requestLogs[0].upstreamUrl, 'https://proxy.example.com/v1/responses');
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
  assert.equal(retryLog.maxAttempts, 4);
  assert.equal(retryLog.requestedModel, 'gpt-5.3-codex');
  assert.equal(retryLog.effectiveModel, 'gpt-5.3-codex');
  assert.equal(retryLog.upstreamStatus, 200);
  assert.equal(retryLog.upstreamHeaders['x-request-id'], 'resp-header-id');
  assert.equal(Object.hasOwn(retryLog.upstreamHeaders, 'set-cookie'), false);
  assert.match(retryLog.upstreamBody, /stream disconnected before completion/);
  assert.match(retryLog.upstreamError, /stream disconnected before completion/);
});

test('codex adapter retries another account after ECONNRESET', async () => {
  const res = createResCapture();
  const firstAccount = {
    accountRef: accountRef('1'),
    email: 'a@example.com',
    accessToken: 'reset-token',
    apiKeyMode: true,
    schedulableStatus: 'schedulable'
  };
  const secondAccount = {
    accountRef: accountRef('2'),
    email: 'b@example.com',
    accessToken: 'ok-token',
    apiKeyMode: true,
    schedulableStatus: 'schedulable'
  };
  const state = {
    accounts: { codex: [firstAccount, secondAccount] },
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
      model: 'gpt-5.6-sol',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }]
    },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 60_000,
    requestMeta: { requestId: 'network-switch', sessionKey: 's' },
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
      fetchWithTimeout: async (_url, init) => {
        const auth = String(init && init.headers && init.headers.authorization || '');
        if (auth.includes('reset-token')) {
          const error = new Error('fetch failed');
          error.cause = { code: 'ECONNRESET' };
          throw error;
        }
        return createCompletedUpstreamResponse('switched');
      },
      markProxyAccountFailure,
      markProxyAccountSuccess,
      appendProxyRequestLog: () => {}
    }
  });

  assert.deepEqual(chosen, [firstAccount.accountRef, secondAccount.accountRef]);
  assert.equal(res.statusCode, 200);
  assert.match(String(res.body), /switched/);
  assert.equal(getAccountModelCooldownUntil(firstAccount, 'gpt-5.6-sol'), 0);
});

test('codex adapter retries the only account once after a stream disconnect', async () => {
  const res = createResCapture();
  const account = {
    accountRef: accountRef('1'),
    email: 'a@example.com',
    accessToken: 'single-token',
    apiKeyMode: true,
    schedulableStatus: 'schedulable'
  };
  const state = {
    accounts: { codex: [account] },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  let fetchCalls = 0;

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
      model: 'gpt-5.6-sol',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }]
    },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 60_000,
    requestMeta: { requestId: 'single-retry', sessionKey: 's' },
    deps: {
      chooseServerAccount,
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      fetchWithTimeout: async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          return {
            ok: true,
            status: 200,
            headers: new Map(),
            text: async () => [
              'data: {"type":"response.failed","response":{"error":{"message":"stream disconnected before completion"}}}',
              ''
            ].join('\n')
          };
        }
        return createCompletedUpstreamResponse('retried');
      },
      markProxyAccountFailure,
      markProxyAccountSuccess,
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(fetchCalls, 2);
  assert.equal(res.statusCode, 200);
  assert.match(String(res.body), /retried/);
  assert.equal(getAccountModelCooldownUntil(account, 'gpt-5.6-sol'), 0);
  assert.equal(account.modelFailureStreaks && account.modelFailureStreaks['gpt-5.6-sol'], undefined);
});

test('codex adapter backs off and preserves upstream semantics after repeated ECONNREFUSED', async () => {
  const res = createResCapture();
  const account = {
    accountRef: accountRef('1'),
    email: 'a@example.com',
    accessToken: 'single-token',
    apiKeyMode: true,
    schedulableStatus: 'schedulable'
  };
  const state = {
    accounts: { codex: [account] },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  const retryDelays = [];
  let fetchCalls = 0;

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
      model: 'gpt-5.6-sol',
      stream: true,
      input: 'hello'
    },
    routeKey: 'POST /v1/responses',
    requestStartedAt: Date.now(),
    cooldownMs: 60_000,
    requestMeta: {
      requestId: 'network-refused',
      sessionKey: 's',
      clientProtocol: 'openai_responses'
    },
    deps: {
      chooseServerAccount,
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      fetchWithTimeout: async () => {
        fetchCalls += 1;
        const error = new Error('fetch failed');
        error.cause = { code: 'ECONNREFUSED' };
        throw error;
      },
      waitForTransientRetry: async (delayMs) => {
        retryDelays.push(delayMs);
      },
      markProxyAccountFailure,
      markProxyAccountSuccess,
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(fetchCalls, 2);
  assert.deepEqual(retryDelays, [250]);
  assert.equal(res.statusCode, 502);
  const body = JSON.parse(String(res.body));
  assert.equal(body.error, 'upstream_temporarily_unavailable');
  assert.equal(getAccountModelCooldownUntil(account, 'gpt-5.6-sol'), 0);
  assert.equal(account.modelFailureStreaks && account.modelFailureStreaks['gpt-5.6-sol'], undefined);
});

test('codex adapter does not turn the attachment ECONNREFUSED pool into no_available_account', async () => {
  const res = createResCapture();
  const transportAccounts = [
    {
      accountRef: 'acct_4c8fc2a7052fbb33d50d',
      accessToken: 'first-token',
      apiKeyMode: true,
      schedulableStatus: 'schedulable'
    },
    {
      accountRef: 'acct_6576e98b2b025cc545cb',
      accessToken: 'second-token',
      apiKeyMode: true,
      schedulableStatus: 'schedulable'
    }
  ];
  const quotaExhaustedAccount = {
    accountRef: 'acct_a336311cae816e12b741',
    accessToken: 'exhausted-token',
    apiKeyMode: false,
    remainingPct: 0,
    schedulableStatus: 'schedulable'
  };
  const state = {
    accounts: { codex: [...transportAccounts, quotaExhaustedAccount] },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  const attemptedAccountRefs = [];

  await handleCodexChatCompletions({
    options: {
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      upstreamTimeoutMs: 3000,
      maxAttempts: 3,
      failureThreshold: 2,
      logRequests: false
    },
    state,
    req: { headers: { 'content-type': 'application/json' } },
    res,
    requestJson: {
      model: 'gpt-5.6-sol',
      stream: true,
      input: 'hello'
    },
    routeKey: 'POST /v1/responses',
    requestStartedAt: Date.now(),
    cooldownMs: 60_000,
    requestMeta: {
      requestId: 'attachment-network-refused-pool',
      sessionKey: 'attachment-session',
      clientProtocol: 'openai_responses'
    },
    deps: {
      chooseServerAccount,
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      fetchWithTimeout: async (_url, init) => {
        const authorization = String(init && init.headers && init.headers.authorization || '');
        const account = transportAccounts.find((item) => authorization.includes(item.accessToken));
        attemptedAccountRefs.push(account && account.accountRef || 'unexpected-account');
        const error = new Error('fetch failed');
        error.cause = { code: 'ECONNREFUSED' };
        throw error;
      },
      waitForTransientRetry: async () => {},
      markProxyAccountFailure,
      markProxyAccountSuccess,
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(res.statusCode, 502);
  const body = JSON.parse(String(res.body));
  assert.equal(body.error, 'upstream_temporarily_unavailable');
  assert.equal(String(res.body).includes('no_available_account'), false);
  assert.equal(attemptedAccountRefs.includes(quotaExhaustedAccount.accountRef), false);
  assert.deepEqual(new Set(attemptedAccountRefs), new Set(transportAccounts.map((item) => item.accountRef)));
  for (const account of transportAccounts) {
    assert.equal(getAccountModelCooldownUntil(account, 'gpt-5.6-sol'), 0);
    assert.equal(account.modelFailureStreaks && account.modelFailureStreaks['gpt-5.6-sol'], undefined);
  }
});

test('codex adapter counts same-request timeout retries as one failure streak event', async () => {
  const res = createResCapture();
  const account = {
    accountRef: accountRef('1'),
    email: 'a@example.com',
    accessToken: 'single-token',
    apiKeyMode: true,
    schedulableStatus: 'schedulable'
  };
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
      logRequests: false
    },
    state,
    req: { headers: { 'content-type': 'application/json' } },
    res,
    requestJson: {
      model: 'gpt-5.6-sol',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }]
    },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 60_000,
    requestMeta: { requestId: 'same-request-timeout', sessionKey: 's' },
    deps: {
      chooseServerAccount,
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      fetchWithTimeout: async () => {
        const error = new Error('request timeout');
        error.code = 'ETIMEDOUT';
        throw error;
      },
      waitForTransientRetry: async () => {},
      markProxyAccountFailure,
      markProxyAccountSuccess,
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(res.statusCode, 504);
  const body = JSON.parse(String(res.body));
  assert.equal(body.error, 'upstream_temporarily_unavailable');
  assert.equal(getAccountModelCooldownUntil(account, 'gpt-5.6-sol'), 0);
  assert.equal(account.modelFailureStreaks['gpt-5.6-sol'].kind, 'timeout');
  assert.equal(account.modelFailureStreaks['gpt-5.6-sol'].count, 1);
});

test('codex adapter reports temporary upstream failure when mixed transient retries exhaust without cooldown', async () => {
  const res = createResCapture();
  const account = {
    accountRef: accountRef('1'),
    email: 'a@example.com',
    accessToken: 'single-token',
    apiKeyMode: true,
    schedulableStatus: 'schedulable'
  };
  const state = {
    accounts: { codex: [account] },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  let fetchCalls = 0;

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
      model: 'gpt-5.6-sol',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }]
    },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 60_000,
    requestMeta: { requestId: 'mixed-transient', sessionKey: 's' },
    deps: {
      chooseServerAccount,
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      fetchWithTimeout: async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          return {
            ok: true,
            status: 200,
            headers: new Map(),
            text: async () => [
              'data: {"type":"response.failed","response":{"error":{"message":"stream disconnected before completion"}}}',
              ''
            ].join('\n')
          };
        }
        const error = new Error('fetch failed');
        error.cause = { code: 'ECONNRESET' };
        throw error;
      },
      refreshCodexAccessToken: async () => ({ ok: true, refreshed: false }),
      markProxyAccountFailure,
      markProxyAccountSuccess,
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(fetchCalls, 2);
  assert.equal(res.statusCode, 502);
  const body = JSON.parse(String(res.body));
  assert.equal(body.error, 'upstream_temporarily_unavailable');
  assert.equal(getAccountModelCooldownUntil(account, 'gpt-5.6-sol'), 0);
  assert.equal(account.modelFailureStreaks['gpt-5.6-sol'].kind, 'service_unavailable');
  assert.equal(account.modelFailureStreaks['gpt-5.6-sol'].count, 1);
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

// 线上 503 回归：账号级模型目录只探测到一部分账号（探测预算有限、账号重载还会整体
// 失效缓存），健康的 OAuth 账号因此在目录里查不到该模型。以前会被判成
// "no available codex account can serve model ..." 直接合成 503，
// 现在必须放行整池，让请求真的打到账号上。
test('codex adapter does not synthesize 503 when the account model catalog is only partially probed', async () => {
  const res = createResCapture();
  const oauthRef = accountRef('a11');
  const relayRef = accountRef('b22');
  const state = {
    accounts: {
      codex: [
        {
          accountRef: oauthRef,
          email: 'oauth@example.com',
          upstreamAccountId: 'acc_oauth',
          accessToken: 'oauth-token',
          schedulableStatus: 'schedulable',
          remainingPct: 92
        },
        {
          accountRef: relayRef,
          email: '',
          accessToken: 'relay-key',
          apiKeyMode: true,
          openaiBaseUrl: 'https://relay.example.com/v1',
          schedulableStatus: 'schedulable'
        }
      ]
    },
    // 只有中转账号被探测过，OAuth 账号的目录还是空白。
    webUiModelsCache: {
      updatedAt: Date.now(),
      byAccount: { [relayRef]: ['gpt-5.5'] },
      byProvider: {}
    },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };

  const attempted = [];
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
      model: 'gpt-5.6-luna',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }]
    },
    routeKey: 'POST /v1/responses',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { requestId: 'partial-catalog', sessionKey: 's' },
    deps: {
      chooseServerAccount: (pool) => pool[0] || null,
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      refreshCodexAccessToken: async () => ({ ok: true, refreshed: false, reason: 'not_due' }),
      fetchWithTimeout: async (url, init) => {
        attempted.push(String(url));
        return createCompletedUpstreamResponse('luna ok');
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(attempted.length > 0, true, 'request must reach upstream instead of being refused locally');
  assert.notEqual(res.statusCode, 503);
  assert.doesNotMatch(String(res.body), /no_available_account/);
});

// 回归：中转账号回 400「Invalid model name」时，必须换到真正能服务该模型的账号，
// 而不是把这条 400 甩给客户端；同时给 (中转账号, 模型) 打冷却，后续请求不再空跑它。
test('codex adapter fails over when an account reports the model is not available', async () => {
  const res = createResCapture();
  const relayRef = accountRef('c33');
  const oauthRef = accountRef('d44');
  const state = {
    accounts: {
      codex: [
        {
          accountRef: relayRef,
          accessToken: 'relay-key',
          apiKeyMode: true,
          openaiBaseUrl: 'https://relay.example.com/v1',
          schedulableStatus: 'schedulable'
        },
        {
          accountRef: oauthRef,
          email: 'oauth@example.com',
          upstreamAccountId: 'acc_oauth',
          accessToken: 'oauth-token',
          schedulableStatus: 'schedulable',
          remainingPct: 92
        }
      ]
    },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };

  const tried = [];
  await handleCodexChatCompletions({
    options: {
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      upstreamTimeoutMs: 3000,
      maxAttempts: 3,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { headers: { 'content-type': 'application/json' } },
    res,
    requestJson: {
      model: 'gpt-5.6-luna',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }]
    },
    routeKey: 'POST /v1/responses',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { requestId: 'model-failover', sessionKey: 's' },
    deps: {
      chooseServerAccount: (pool) => pool.find((item) => !tried.includes(item.accountRef)) || null,
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      refreshCodexAccessToken: async () => ({ ok: true, refreshed: false, reason: 'not_due' }),
      fetchWithTimeout: async (url) => {
        const isRelay = String(url).includes('relay.example.com');
        tried.push(isRelay ? relayRef : oauthRef);
        if (isRelay) {
          return {
            ok: false,
            status: 400,
            headers: new Map(),
            text: async () => JSON.stringify({
              error: {
                message: '/responses: Invalid model name passed in model=gpt-5.6-luna. Call `/v1/models` to view available models for your key.',
                type: 'None',
                code: '400'
              }
            })
          };
        }
        return createCompletedUpstreamResponse('luna ok');
      },
      markProxyAccountFailure,
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.deepEqual(tried, [relayRef, oauthRef], 'must move on to the next account');
  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(String(res.body), /Invalid model name/);
  assert.match(String(res.body), /luna ok/);
  // 中转账号只对这个模型冷却，账号本身仍可服务它支持的模型
  const relay = state.accounts.codex[0];
  assert.equal(getAccountModelCooldownUntil(relay, 'gpt-5.6-luna') > Date.now(), true);
  assert.equal(Number(relay.cooldownUntil || 0), 0);
});

test('codex adapter selects only compatible accounts when model inverted index is available', async () => {
  const res = createResCapture();
  const ollamaRef = accountRef('011a011a');
  const oauthRef = accountRef('0a020a02');
  const relayRef = accountRef('0e1a0e1a');
  const state = {
    accounts: {
      codex: [
        {
          accountRef: ollamaRef,
          accessToken: 'ollama-key',
          apiKeyMode: true,
          openaiBaseUrl: 'https://ollama.com/v1',
          schedulableStatus: 'schedulable'
        },
        {
          accountRef: oauthRef,
          email: 'oauth@example.com',
          accessToken: 'oauth-token',
          schedulableStatus: 'schedulable'
        },
        {
          accountRef: relayRef,
          accessToken: 'relay-key',
          apiKeyMode: true,
          openaiBaseUrl: 'https://relay.example.com/v1',
          schedulableStatus: 'schedulable'
        }
      ]
    },
    webUiModelsCache: {
      updatedAt: Date.now(),
      byAccount: {
        [ollamaRef]: ['deepseek-v4-pro', 'gemma-3-27b', 'kimi-k2.5'],
        [oauthRef]: ['gpt-5.6-luna', 'gpt-5.5', 'gpt-5.3-codex'],
        [relayRef]: ['gpt-5.6-luna', 'gpt-5.5']
      },
      byProvider: {}
    },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  state.modelAccountIndex = buildModelAccountIndex(state, {});

  const attemptedAccountRefs = [];
  await handleCodexChatCompletions({
    options: {
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      upstreamTimeoutMs: 3000,
      maxAttempts: 3,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { headers: { 'content-type': 'application/json' } },
    res,
    requestJson: {
      model: 'gpt-5.6-luna',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }]
    },
    routeKey: 'POST /v1/responses',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { requestId: 'model-inverted-index-check', sessionKey: 's', clientProtocol: 'openai_responses' },
    deps: {
      chooseServerAccount: (pool) => {
        return pool.find((a) => !attemptedAccountRefs.includes(a.accountRef)) || null;
      },
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      refreshCodexAccessToken: async () => ({ ok: true, refreshed: false, reason: 'not_due' }),
      fetchWithTimeout: async (url, init) => {
        const auth = String(init && init.headers && init.headers.authorization || '');
        if (auth.includes('ollama-key')) {
          attemptedAccountRefs.push(ollamaRef);
          return {
            ok: false,
            status: 400,
            headers: new Map(),
            text: async () => JSON.stringify({
              error: {
                message: 'input[0]: unknown input item type: "additional_tools"',
                type: 'invalid_request_error'
              }
            })
          };
        }
        if (auth.includes('relay-key')) {
          attemptedAccountRefs.push(relayRef);
          return createCompletedUpstreamResponse('relay luna ok');
        }
        if (auth.includes('oauth-token')) {
          attemptedAccountRefs.push(oauthRef);
          return createCompletedUpstreamResponse('oauth luna ok');
        }
        return createCompletedUpstreamResponse('fallback ok');
      },
      markProxyAccountFailure,
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(attemptedAccountRefs.includes(ollamaRef), false, 'Ollama account must NEVER be selected for gpt-5.6-luna');
  assert.equal(attemptedAccountRefs.length > 0, true);
});


// 回归：2026-08-14 11:57 的真实事故。codex CLI 请求 gpt-5.6-luna，网关却拨到了 ollama
// 中转账号（acct_52facbdf93d7161b990d，目录里只有 18 个开源模型），上游回
// 400 unknown input item type: "custom_tool_call"。
//
// 触发条件是「正向查不到绑定」：所有支持 luna 的账号当时都不可调度，倒排/正排索引
// 都返回空 ref，收窄逻辑于是整池放行（探测残缺不能当否定证据），把明知不支持 luna 的
// ollama 也放了回去，轮询正好拨中它。
//
// 目录已知且明确不含该模型，是强证据，任何放行分支都不得再把这种账号放回池子。
test('codex adapter never dials an account whose catalog is known to lack the requested model', async () => {
  const res = createResCapture();
  const ollamaRef = accountRef('011a011a');
  const lunaCooledRef = accountRef('0c010c01');
  const lunaUnhealthyRef = accountRef('0c020c02');
  const state = {
    accounts: {
      codex: [
        {
          accountRef: ollamaRef,
          accessToken: 'ollama-key',
          apiKeyMode: true,
          openaiBaseUrl: 'https://ollama.com/v1',
          schedulableStatus: 'schedulable'
        },
        {
          accountRef: lunaCooledRef,
          accessToken: 'luna-cooled-token',
          schedulableStatus: 'cooling_down'
        },
        {
          accountRef: lunaUnhealthyRef,
          accessToken: 'luna-unhealthy-token',
          schedulableStatus: 'cooling_down'
        }
      ]
    },
    webUiModelsCache: {
      updatedAt: Date.now(),
      byAccount: {
        [ollamaRef]: [
          'deepseek-v4-pro:preview', 'gemma4:31b', 'glm-5.2', 'gpt-oss:120b',
          'kimi-k3', 'minimax-m3', 'nemotron-3-ultra', 'qwen3.5:397b'
        ],
        [lunaCooledRef]: ['gpt-5.6-luna', 'gpt-5.5'],
        [lunaUnhealthyRef]: ['gpt-5.6-luna', 'gpt-5.3-codex']
      },
      byProvider: {}
    },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0, lastErrors: [] }
  };
  state.modelAccountIndex = buildModelAccountIndex(state, {});

  const attemptedAccountRefs = [];
  await handleCodexChatCompletions({
    options: {
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      upstreamTimeoutMs: 3000,
      maxAttempts: 3,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { headers: { 'content-type': 'application/json' } },
    res,
    requestJson: {
      model: 'gpt-5.6-luna',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }]
    },
    routeKey: 'POST /v1/responses',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { requestId: 'known-negative-catalog', sessionKey: 's', clientProtocol: 'openai_responses' },
    deps: {
      chooseServerAccount,
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      refreshCodexAccessToken: async () => ({ ok: true, refreshed: false, reason: 'not_due' }),
      fetchWithTimeout: async (url, init) => {
        const auth = String(init && init.headers && init.headers.authorization || '');
        if (auth.includes('ollama-key')) {
          attemptedAccountRefs.push(ollamaRef);
          return {
            ok: false,
            status: 400,
            headers: new Map(),
            text: async () => JSON.stringify({
              error: {
                message: 'input[20]: unknown input item type: "custom_tool_call"',
                type: 'invalid_request_error'
              }
            })
          };
        }
        attemptedAccountRefs.push('unexpected');
        return createCompletedUpstreamResponse('unexpected');
      },
      markProxyAccountFailure,
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.deepEqual(
    attemptedAccountRefs,
    [],
    'an account whose catalog is known to lack gpt-5.6-luna must never be dialed'
  );
  assert.equal(res.statusCode, 503);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'no_available_account');
});

// 反向不变量：目录未知（从未探测到）不等于不支持。排除只认「已知且不含」这一种强证据，
// 否则探测残缺就会被读成否定证据，合成一堆假 503——这正是收窄模块开头警告的那种回归。
test('codex adapter still dials an account whose catalog is unknown', async () => {
  const res = createResCapture();
  const ollamaRef = accountRef('011a011a');
  const unprobedRef = accountRef('0u010u01');
  const state = {
    accounts: {
      codex: [
        {
          accountRef: ollamaRef,
          accessToken: 'ollama-key',
          apiKeyMode: true,
          openaiBaseUrl: 'https://ollama.com/v1',
          schedulableStatus: 'schedulable'
        },
        {
          accountRef: unprobedRef,
          accessToken: 'unprobed-token',
          schedulableStatus: 'schedulable'
        }
      ]
    },
    webUiModelsCache: {
      updatedAt: Date.now(),
      byAccount: {
        [ollamaRef]: ['glm-5.2', 'kimi-k3', 'qwen3.5:397b']
      },
      byProvider: {}
    },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0, lastErrors: [] }
  };
  state.modelAccountIndex = buildModelAccountIndex(state, {});

  const attemptedAccountRefs = [];
  await handleCodexChatCompletions({
    options: {
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      upstreamTimeoutMs: 3000,
      maxAttempts: 3,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { headers: { 'content-type': 'application/json' } },
    res,
    requestJson: {
      model: 'gpt-5.6-luna',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }]
    },
    routeKey: 'POST /v1/responses',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { requestId: 'unknown-catalog-passthrough', sessionKey: 's', clientProtocol: 'openai_responses' },
    deps: {
      chooseServerAccount,
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      refreshCodexAccessToken: async () => ({ ok: true, refreshed: false, reason: 'not_due' }),
      fetchWithTimeout: async (url, init) => {
        const auth = String(init && init.headers && init.headers.authorization || '');
        if (auth.includes('ollama-key')) {
          attemptedAccountRefs.push(ollamaRef);
          return {
            ok: false,
            status: 400,
            headers: new Map(),
            text: async () => JSON.stringify({ error: { message: 'unknown input item type' } })
          };
        }
        attemptedAccountRefs.push(unprobedRef);
        return createCompletedUpstreamResponse('unprobed luna ok');
      },
      markProxyAccountFailure,
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(attemptedAccountRefs, [unprobedRef], 'unknown catalog must stay routable');
});

// 回归：WebUI 里把 (账号, 模型) 停用后，网关仍然把请求打到该账号。
// 现场是 meadeodeo@gmail.com 上 gpt-5.6-sol 已停用，用量却还在涨。
//
// 停用只被 buildModelCapabilityIndex 认（addAccountModel 里查 isAccountModelEnabled），
// 而倒排索引 buildModelAccountIndex 只读模型缓存、根本不看 modelCatalogSettings。
// 选账号走倒排索引这一路时，停用开关等于不存在。
//
// 「用户明确停用」是最强的否定证据——比目录还硬，任何分支都不得再选中它。
test('codex adapter never dials an account whose (account, model) pair is disabled', async () => {
  const res = createResCapture();
  const disabledRef = accountRef('0d150d15');
  const enabledRef = accountRef('0e150e15');
  const state = {
    accounts: {
      codex: [
        {
          accountRef: disabledRef,
          accessToken: 'disabled-key',
          apiKeyMode: true,
          openaiBaseUrl: 'https://relay.example.com/v1',
          schedulableStatus: 'schedulable'
        },
        {
          accountRef: enabledRef,
          accessToken: 'enabled-key',
          apiKeyMode: true,
          openaiBaseUrl: 'https://relay2.example.com/v1',
          schedulableStatus: 'schedulable'
        }
      ]
    },
    // 两个账号的探测目录都有 gpt-5.6-sol —— 目录层面无从区分，
    // 唯一的区别就是用户在 WebUI 上把其中一个停用了。
    webUiModelsCache: {
      updatedAt: Date.now(),
      byAccount: {
        [disabledRef]: ['gpt-5.6-sol', 'gpt-5.6-luna'],
        [enabledRef]: ['gpt-5.6-sol', 'gpt-5.6-luna']
      },
      byProvider: {}
    },
    modelCatalogSettings: {
      accountModels: [
        {
          id: 'gpt-5.6-sol',
          provider: 'codex',
          accountRef: disabledRef,
          enabled: false
        }
      ]
    },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0, lastErrors: [] }
  };
  state.modelAccountIndex = buildModelAccountIndex(state, {});

  const attemptedAccountRefs = [];
  await handleCodexChatCompletions({
    options: {
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      upstreamTimeoutMs: 3000,
      maxAttempts: 3,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { headers: { 'content-type': 'application/json' } },
    res,
    requestJson: {
      model: 'gpt-5.6-sol',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }]
    },
    routeKey: 'POST /v1/responses',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { requestId: 'account-model-disabled', sessionKey: 's', clientProtocol: 'openai_responses' },
    deps: {
      chooseServerAccount,
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      refreshCodexAccessToken: async () => ({ ok: true, refreshed: false, reason: 'not_due' }),
      fetchWithTimeout: async (url, init) => {
        const auth = String(init && init.headers && init.headers.authorization || '');
        if (auth.includes('disabled-key')) {
          attemptedAccountRefs.push(disabledRef);
          return createCompletedUpstreamResponse('should never happen');
        }
        attemptedAccountRefs.push(enabledRef);
        return createCompletedUpstreamResponse('enabled account ok');
      },
      markProxyAccountFailure,
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(
    attemptedAccountRefs.includes(disabledRef),
    false,
    'a disabled (account, model) pair must never be dialed'
  );
  assert.deepEqual(attemptedAccountRefs, [enabledRef]);
  assert.equal(res.statusCode, 200);
});
