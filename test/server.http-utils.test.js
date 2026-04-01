const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchWithTimeout,
  fetchGeminiCodeAssistChatCompletion,
  __private
} = require('../lib/server/http-utils');

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
