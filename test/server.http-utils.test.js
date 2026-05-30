const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchWithTimeout,
  fetchModelsForAccount,
  fetchGeminiCodeAssistChatCompletion,
  fetchGeminiCodeAssistChatCompletionStream,
  __private
} = require('../lib/server/http-utils');

const GEMINI_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function withEnv(patch, fn) {
  const keys = Object.keys(patch);
  const previous = {};
  keys.forEach((key) => {
    previous[key] = process.env[key];
    const value = patch[key];
    if (value === undefined) {
      delete process.env[key];
      return;
    }
    process.env[key] = String(value);
  });
  try {
    return await fn();
  } finally {
    keys.forEach((key) => {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  }
}

test('fetchWithTimeout attaches proxy dispatcher when proxy is configured', async (t) => {
  let seenInit = null;
  t.mock.method(global, 'fetch', async (_url, init) => {
    seenInit = init;
    return { ok: true };
  });

  await fetchWithTimeout(
    'https://api.openai.com/v1/models',
    { method: 'GET' },
    500,
    { proxyUrl: 'http://127.0.0.1:7890' }
  );

  assert.ok(seenInit);
  assert.ok(seenInit.dispatcher);
  assert.equal(typeof seenInit.dispatcher.dispatch, 'function');
});

test('fetchWithTimeout bypasses proxy when no_proxy matches host', async (t) => {
  let seenInit = null;
  t.mock.method(global, 'fetch', async (_url, init) => {
    seenInit = init;
    return { ok: true };
  });

  await fetchWithTimeout(
    'https://api.openai.com/v1/chat/completions',
    { method: 'POST' },
    500,
    {
      proxyUrl: 'http://127.0.0.1:7890',
      noProxy: 'api.openai.com,localhost'
    }
  );

  assert.ok(seenInit);
  assert.equal(seenInit.dispatcher, undefined);
});

test('resolveProxyConfig bypasses loopback hosts by default', () => {
  const result = __private.resolveProxyConfig('http://127.0.0.1:8317/v1/models', {
    proxyUrl: 'http://127.0.0.1:7890'
  });
  assert.equal(result.url, '');
});

test('fetchModelsForAccount uses codex api-key account base url without double v1 path', async (t) => {
  let seenUrl = '';
  let seenAuthorization = '';
  t.mock.method(global, 'fetch', async (url, init) => {
    seenUrl = String(url || '');
    seenAuthorization = String(init && init.headers && init.headers.authorization || '');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'qwen3.6-plus' },
          { id: 'gpt-5.4' }
        ]
      })
    };
  });

  const models = await fetchModelsForAccount({
    codexBaseUrl: 'https://codex.example.com/backend-api/codex'
  }, {
    provider: 'codex',
    id: '10014',
    accessToken: 'sk-live',
    apiKeyMode: true,
    authType: 'api-key',
    openaiBaseUrl: 'https://relay.example.com/v1'
  }, 500);

  assert.equal(seenUrl, 'https://relay.example.com/v1/models');
  assert.equal(seenAuthorization, 'Bearer sk-live');
  assert.deepEqual(models, ['qwen3.6-plus', 'gpt-5.4']);
});

test('fetchModelsForAccount can ignore stale Gemini Code Assist model snapshots', async (t) => {
  const seenUrls = [];
  t.mock.method(global, 'fetch', async (url) => {
    const safeUrl = String(url || '');
    seenUrls.push(safeUrl);
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/test-project' })
      };
    }
    if (safeUrl.includes(':retrieveUserQuota')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          buckets: [
            { modelId: 'gemini-3.1-pro-preview_vertex' },
            { modelId: 'gemini-2.5-flash' }
          ]
        })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const models = await fetchModelsForAccount({
    geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    ignoreAvailableModelsSnapshot: true
  }, {
    provider: 'gemini',
    id: '1',
    authType: 'oauth-personal',
    accessToken: 'gemini-token',
    availableModels: ['gemini-2.5-pro']
  }, 500);

  assert.deepEqual(models, ['gemini-2.5-flash', 'gemini-3.1-pro-preview']);
  assert.equal(seenUrls.some((url) => url.includes(':retrieveUserQuota')), true);
});

test('getProxyDispatcher tries to install undici once, then gracefully falls back on failure', () => {
  let requireCalls = 0;
  let installCalls = 0;
  __private.setUndiciHooksForTest({
    requireFn: () => {
      requireCalls += 1;
      throw new Error('module_not_found');
    },
    installFn: () => {
      installCalls += 1;
      return false;
    }
  });

  const first = __private.getProxyDispatcher('http://127.0.0.1:7890');
  const second = __private.getProxyDispatcher('http://127.0.0.1:7890');
  assert.equal(first, null);
  assert.equal(second, null);
  assert.equal(requireCalls, 1);
  assert.equal(installCalls, 1);

  __private.setUndiciHooksForTest({});
});

test('fetchWithTimeout retries direct when env proxy is unreachable', async (t) => {
  const calls = [];
  t.mock.method(global, 'fetch', async (_url, init) => {
    calls.push(Boolean(init && init.dispatcher));
    if (init && init.dispatcher) {
      const err = new Error('fetch failed');
      err.cause = { code: 'ECONNREFUSED' };
      throw err;
    }
    return { ok: true, recovered: true };
  });

  await withEnv({
    AIH_SERVER_PROXY_URL: undefined,
    HTTPS_PROXY: 'http://127.0.0.1:7999',
    https_proxy: undefined,
    HTTP_PROXY: undefined,
    http_proxy: undefined,
    NO_PROXY: undefined,
    no_proxy: undefined,
    AIH_SERVER_NO_PROXY: undefined
  }, async () => {
    const res = await fetchWithTimeout('https://api.openai.com/v1/models', { method: 'GET' }, 500);
    assert.equal(res.recovered, true);
  });

  assert.deepEqual(calls, [true, false]);
});

test('fetchGeminiCodeAssistChatCompletion maps OpenAI tools/tool_choice to Gemini and returns tool_calls', async (t) => {
  const fetchCalls = [];
  t.mock.method(global, 'fetch', async (url, init) => {
    const safeUrl = String(url || '');
    fetchCalls.push({ url: safeUrl, body: String(init && init.body || '') });
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/test-project' })
      };
    }
    if (safeUrl.includes(':generateContent')) {
      const requestBody = JSON.parse(String(init && init.body || '{}'));
      assert.equal(requestBody.request.tools[0].functionDeclarations[0].name, 'mcp__CherryHub__list');
      assert.equal(
        requestBody.request.toolConfig.functionCallingConfig.allowedFunctionNames[0],
        'mcp__CherryHub__list'
      );
      return {
        ok: true,
        status: 200,
        json: async () => ({
          traceId: 'trace-1',
          modelVersion: 'gemini-2.5-pro',
          candidates: [{
            finishReason: 'UNEXPECTED_TOOL_CALL',
            content: {
              parts: [{
                functionCall: {
                  name: 'mcp__CherryHub__list',
                  args: { limit: 10 }
                }
              }]
            }
          }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 }
        })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const result = await fetchGeminiCodeAssistChatCompletion(
    {
      geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai'
    },
    {
      provider: 'gemini',
      authType: 'oauth-personal',
      accessToken: 'token-1'
    },
    {
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{
        type: 'function',
        function: {
          name: 'mcp__CherryHub__list',
          description: 'list tools',
          parameters: { type: 'object', properties: { limit: { type: 'number' } } }
        }
      }],
      tool_choice: {
        type: 'function',
        function: { name: 'mcp__CherryHub__list' }
      }
    },
    800
  );

  assert.equal(fetchCalls.length, 2);
  assert.match(fetchCalls[0].url, /cloudcode-pa\.googleapis\.com\/v1internal:loadCodeAssist/);
  assert.match(fetchCalls[1].url, /cloudcode-pa\.googleapis\.com\/v1internal:generateContent/);
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
  assert.equal(result.choices[0].message.content, null);
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'mcp__CherryHub__list');
  assert.equal(result.usage.total_tokens, 3);
});

test('fetchGeminiCodeAssistChatCompletionStream applies Gemini CLI defaults for Gemini 3 Pro', async (t) => {
  let generateBody = null;
  let generateHeaders = null;
  t.mock.method(global, 'fetch', async (url, init) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/test-project' })
      };
    }
    if (safeUrl.includes(':streamGenerateContent')) {
      generateBody = JSON.parse(String(init && init.body || '{}'));
      generateHeaders = init && init.headers;
      return {
        ok: true,
        status: 200,
        body: (async function* () {
          yield Buffer.from(
            'data: {"response":{"modelVersion":"gemini-3.1-pro-preview","candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"OK"}]}}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}}\n\n'
          );
        })()
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const stream = await fetchGeminiCodeAssistChatCompletionStream(
    {
      geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai'
    },
    {
      provider: 'gemini',
      authType: 'oauth-personal',
      accessToken: 'token-1'
    },
    {
      model: 'gemini-3.1-pro-preview',
      messages: [{ role: 'user', content: 'hi' }]
    },
    800
  );

  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }

  assert.ok(generateBody);
  assert.equal(generateBody.model, 'gemini-3.1-pro-preview');
  assert.equal(generateBody.request.generationConfig.thinkingConfig.thinkingLevel, 'HIGH');
  assert.equal(generateBody.request.generationConfig.thinkingConfig.includeThoughts, true);
  assert.equal(generateBody.request.generationConfig.temperature, 1);
  assert.equal(generateBody.request.generationConfig.topP, 0.95);
  assert.equal(generateBody.request.generationConfig.topK, 64);
  assert.match(generateBody.request.session_id, GEMINI_SESSION_ID_RE);
  assert.match(
    String(generateHeaders && generateHeaders['user-agent'] || ''),
    /^GeminiCLI-cli-command\/0\.42\.0\/gemini-3\.1-pro-preview \(.+; .+; terminal\)$/
  );
  assert.equal(chunks[0].model, 'gemini-3.1-pro-preview');
});

test('fetchGeminiCodeAssistChatCompletionStream enables Google One credits for eligible paid Gemini 3 models', async (t) => {
  let generateBody = null;
  const diagnostics = [];
  t.mock.method(global, 'fetch', async (url, init) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          cloudaicompanionProject: 'projects/test-project',
          paidTier: {
            id: 'google-one-ai-premium',
            availableCredits: [
              { creditType: 'GOOGLE_ONE_AI', creditAmount: '90' }
            ]
          }
        })
      };
    }
    if (safeUrl.includes(':streamGenerateContent')) {
      generateBody = JSON.parse(String(init && init.body || '{}'));
      return {
        ok: true,
        status: 200,
        body: (async function* () {
          yield Buffer.from(
            'data: {"response":{"modelVersion":"gemini-3.1-pro-preview","candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"OK"}]}}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}}\n\n'
          );
        })()
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const stream = await fetchGeminiCodeAssistChatCompletionStream(
    {
      geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      appendGeminiCodeAssistDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    },
    {
      provider: 'gemini',
      authType: 'oauth-personal',
      accessToken: 'token-1'
    },
    {
      model: 'gemini-3.1-pro-preview',
      messages: [{ role: 'user', content: 'hi' }]
    },
    800
  );

  for await (const _chunk of stream) {}

  assert.ok(generateBody);
  assert.deepEqual(generateBody.enabled_credit_types, ['GOOGLE_ONE_AI']);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].creditsEnabled, true);
  assert.equal(diagnostics[0].creditBalance, 90);
  assert.equal(diagnostics[0].userPromptId, `${generateBody.request.session_id}########0`);
});

test('Gemini Code Assist credit decision respects unsupported models, low balance, and explicit never strategy', () => {
  const paidAccount = {
    codeAssistPaidTier: {
      availableCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '90' }]
    }
  };
  assert.equal(
    __private.shouldEnableGeminiCodeAssistCredits('gemini-2.5-pro', paidAccount, {}).enabled,
    false
  );
  assert.equal(
    __private.shouldEnableGeminiCodeAssistCredits('gemini-3.1-pro-preview', {
      codeAssistPaidTier: {
        availableCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '49' }]
      }
    }, {}).enabled,
    false
  );
  assert.equal(
    __private.shouldEnableGeminiCodeAssistCredits('gemini-3.1-pro-preview', {
      ...paidAccount,
      geminiCodeAssistOverageStrategy: 'never'
    }, {}).enabled,
    false
  );
  assert.equal(
    __private.shouldEnableGeminiCodeAssistCredits('gemini-3.1-pro-preview', paidAccount, {}).enabled,
    true
  );
});

test('fetchGeminiCodeAssistChatCompletion maps external session keys to stable Gemini session ids', async (t) => {
  const sessionIds = [];
  const userPromptIds = [];
  t.mock.method(global, 'fetch', async (url, init) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/test-project' })
      };
    }
    if (safeUrl.includes(':generateContent')) {
      const requestBody = JSON.parse(String(init && init.body || '{}'));
      sessionIds.push(requestBody.request.session_id);
      userPromptIds.push(requestBody.user_prompt_id);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          traceId: `trace-${sessionIds.length}`,
          modelVersion: 'gemini-3.1-pro-preview',
          candidates: [{
            finishReason: 'STOP',
            content: { parts: [{ text: 'OK' }] }
          }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
        })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const options = {
    geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    geminiSessionIdMap: new Map(),
    sessionKey: 'cherry-thread-1'
  };
  const account = {
    provider: 'gemini',
    id: '1',
    authType: 'oauth-personal',
    accessToken: 'token-1'
  };

  await fetchGeminiCodeAssistChatCompletion(
    options,
    account,
    {
      model: 'gemini-3.1-pro-preview',
      messages: [{ role: 'user', content: 'hi' }]
    },
    800
  );
  await fetchGeminiCodeAssistChatCompletion(
    options,
    account,
    {
      model: 'gemini-3.1-pro-preview',
      messages: [{ role: 'user', content: 'continue' }]
    },
    800
  );

  assert.equal(sessionIds.length, 2);
  assert.equal(sessionIds[0], sessionIds[1]);
  assert.match(sessionIds[0], GEMINI_SESSION_ID_RE);
  assert.deepEqual(userPromptIds, [
    `${sessionIds[0]}########0`,
    `${sessionIds[0]}########1`
  ]);
});

test('fetchGeminiCodeAssistChatCompletion keeps distinct external session keys isolated', async (t) => {
  const sessionIds = [];
  t.mock.method(global, 'fetch', async (url, init) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/test-project' })
      };
    }
    if (safeUrl.includes(':generateContent')) {
      const requestBody = JSON.parse(String(init && init.body || '{}'));
      sessionIds.push(requestBody.request.session_id);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          traceId: `trace-${sessionIds.length}`,
          modelVersion: 'gemini-3.1-pro-preview',
          candidates: [{
            finishReason: 'STOP',
            content: { parts: [{ text: 'OK' }] }
          }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
        })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const geminiSessionIdMap = new Map();
  const account = {
    provider: 'gemini',
    id: '1',
    authType: 'oauth-personal',
    accessToken: 'token-1'
  };

  await fetchGeminiCodeAssistChatCompletion(
    {
      geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      geminiSessionIdMap,
      sessionKey: 'thread-a'
    },
    account,
    {
      model: 'gemini-3.1-pro-preview',
      messages: [{ role: 'user', content: 'hi' }]
    },
    800
  );
  await fetchGeminiCodeAssistChatCompletion(
    {
      geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      geminiSessionIdMap,
      sessionKey: 'thread-b'
    },
    account,
    {
      model: 'gemini-3.1-pro-preview',
      messages: [{ role: 'user', content: 'hi' }]
    },
    800
  );

  assert.equal(sessionIds.length, 2);
  assert.notEqual(sessionIds[0], sessionIds[1]);
  assert.match(sessionIds[0], GEMINI_SESSION_ID_RE);
  assert.match(sessionIds[1], GEMINI_SESSION_ID_RE);
});

test('fetchGeminiCodeAssistChatCompletion does not treat OpenAI user as a session key', async (t) => {
  const sessionIds = [];
  t.mock.method(global, 'fetch', async (url, init) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/test-project' })
      };
    }
    if (safeUrl.includes(':generateContent')) {
      const requestBody = JSON.parse(String(init && init.body || '{}'));
      sessionIds.push(requestBody.request.session_id);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          traceId: `trace-${sessionIds.length}`,
          modelVersion: 'gemini-3.1-pro-preview',
          candidates: [{
            finishReason: 'STOP',
            content: { parts: [{ text: 'OK' }] }
          }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
        })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const options = {
    geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    geminiSessionIdMap: new Map()
  };
  const account = {
    provider: 'gemini',
    id: '1',
    authType: 'oauth-personal',
    accessToken: 'token-1'
  };

  await fetchGeminiCodeAssistChatCompletion(
    options,
    account,
    {
      model: 'gemini-3.1-pro-preview',
      user: 'same-user',
      messages: [{ role: 'user', content: 'first chat' }]
    },
    800
  );
  await fetchGeminiCodeAssistChatCompletion(
    options,
    account,
    {
      model: 'gemini-3.1-pro-preview',
      user: 'same-user',
      messages: [{ role: 'user', content: 'second chat' }]
    },
    800
  );

  assert.equal(sessionIds.length, 2);
  assert.notEqual(sessionIds[0], sessionIds[1]);
});

test('fetchGeminiCodeAssistChatCompletion passes through Gemini UUID session ids', async (t) => {
  let seenSessionId = '';
  t.mock.method(global, 'fetch', async (url, init) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/test-project' })
      };
    }
    if (safeUrl.includes(':generateContent')) {
      const requestBody = JSON.parse(String(init && init.body || '{}'));
      seenSessionId = requestBody.request.session_id;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          traceId: 'trace-uuid',
          modelVersion: 'gemini-3.1-pro-preview',
          candidates: [{
            finishReason: 'STOP',
            content: { parts: [{ text: 'OK' }] }
          }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
        })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const sessionId = '12345678-1234-4123-8123-123456789abc';
  await fetchGeminiCodeAssistChatCompletion(
    {
      geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      geminiSessionIdMap: new Map()
    },
    {
      provider: 'gemini',
      id: '1',
      authType: 'oauth-personal',
      accessToken: 'token-1'
    },
    {
      model: 'gemini-3.1-pro-preview',
      session_id: sessionId,
      messages: [{ role: 'user', content: 'hi' }]
    },
    800
  );

  assert.equal(seenSessionId, sessionId);
});

test('fetchGeminiCodeAssistChatCompletion maps custom agy models upstream and preserves original requested model in response', async (t) => {
  let seenModel = '';
  t.mock.method(global, 'fetch', async (url, init) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/test-project' })
      };
    }
    if (safeUrl.includes(':generateContent')) {
      const requestBody = JSON.parse(String(init && init.body || '{}'));
      seenModel = requestBody.model;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          traceId: 'trace-uuid',
          modelVersion: 'gemini-3-1-pro-preview',
          candidates: [{
            finishReason: 'STOP',
            content: { parts: [{ text: 'OK' }] }
          }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
        })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const result = await fetchGeminiCodeAssistChatCompletion(
    {
      geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      geminiSessionIdMap: new Map()
    },
    {
      provider: 'agy',
      id: '3',
      authType: 'oauth-personal',
      accessToken: 'token-3'
    },
    {
      model: 'Gemini 3.5 Flash (High)',
      messages: [{ role: 'user', content: 'hi' }]
    },
    800
  );

  // Upstream request should be mapped to the target pro/preview model
  assert.equal(seenModel, 'gemini-3-flash-preview');
  // Response returned to the client should preserve the original requested model name
  assert.equal(result.model, 'Gemini 3.5 Flash (High)');
});
