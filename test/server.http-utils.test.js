const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const {
  fetchWithTimeout,
  fetchModelsForAccount,
  fetchGeminiCodeAssistChatCompletion,
  fetchGeminiCodeAssistChatCompletionStream,
  fetchGeminiCodeAssistGenerateContent,
  __private
} = require('../lib/server/http-utils');
const {
  convertAnthropicMessagesToOpenAIChat
} = require('../lib/server/protocol-adapters');

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

test('fetchWithTimeout propagates a caller abort into the active fetch', async (t) => {
  let seenSignal = null;
  t.mock.method(global, 'fetch', async (_url, init) => {
    seenSignal = init.signal;
    return new Promise((resolve) => {
      seenSignal.addEventListener('abort', () => resolve({ aborted: true }), { once: true });
    });
  });
  const caller = new AbortController();

  const pending = fetchWithTimeout(
    'https://api.anthropic.com/v1/messages',
    { method: 'POST', signal: caller.signal },
    5000,
    { noProxy: 'api.anthropic.com' }
  );
  caller.abort('downstream_disconnected');
  const result = await pending;

  assert.equal(result.aborted, true);
  assert.equal(seenSignal.aborted, true);
  assert.equal(seenSignal.reason, 'downstream_disconnected');
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

test('fetchModelsForAccount sends anthropic-version (+ oauth beta) for claude', async (t) => {
  let seenUrl = '';
  let seenHeaders = null;
  t.mock.method(global, 'fetch', async (url, init) => {
    seenUrl = String(url || '');
    seenHeaders = (init && init.headers) || {};
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'claude-opus-4-8' }, { id: 'claude-fable-5' }] })
    };
  });

  const models = await fetchModelsForAccount({
    claudeBaseUrl: 'https://api.anthropic.com/v1'
  }, {
    provider: 'claude',
    id: '4',
    accessToken: 'sk-ant-oat01-live',
    apiKeyMode: false,
    authType: 'oauth'
  }, 500);

  assert.equal(seenUrl, 'https://api.anthropic.com/v1/models');
  assert.equal(seenHeaders.authorization, 'Bearer sk-ant-oat01-live');
  assert.equal(seenHeaders['anthropic-version'], '2023-06-01');
  assert.equal(seenHeaders['anthropic-beta'], 'oauth-2025-04-20');
  assert.deepEqual(models, ['claude-opus-4-8', 'claude-fable-5']);
});

test('fetchModelsForAccount decodes compressed provider error bodies', async (t) => {
  const body = zlib.gzipSync(Buffer.from(JSON.stringify({
    error: { message: 'oauth token expired' }
  })));
  t.mock.method(global, 'fetch', async () => ({
    ok: false,
    status: 401,
    headers: new Map(),
    arrayBuffer: async () => body
  }));

  await assert.rejects(
    () => fetchModelsForAccount({
      claudeBaseUrl: 'https://api.anthropic.com/v1'
    }, {
      provider: 'claude',
      id: '4',
      accessToken: 'sk-ant-oat01-live',
      apiKeyMode: false,
      authType: 'oauth'
    }, 500),
    /HTTP 401 .*oauth token expired/
  );
});

test('fetchModelsForAccount uses x-api-key (not Bearer) for claude api-key accounts', async (t) => {
  let seenHeaders = null;
  t.mock.method(global, 'fetch', async (_url, init) => {
    seenHeaders = (init && init.headers) || {};
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  });

  await fetchModelsForAccount({
    claudeBaseUrl: 'https://open.bigmodel.cn/api/anthropic'
  }, {
    provider: 'claude',
    id: '5',
    accessToken: 'sk-ant-api-key',
    apiKeyMode: true,
    authType: 'api-key'
  }, 500);

  // Mirror the real request path: claude API-key accounts authenticate via
  // x-api-key, never Authorization: Bearer (which yields a spurious 401).
  assert.equal(seenHeaders['x-api-key'], 'sk-ant-api-key');
  assert.equal(seenHeaders.authorization, undefined);
  assert.equal(seenHeaders['anthropic-version'], '2023-06-01');
  assert.equal(seenHeaders['anthropic-beta'], undefined);
});

test('fetchModelsForAccount probes remotely for claude auth-token accounts (third-party Anthropic proxies)', async (t) => {
  // claude auth-token(GLM/DeepSeek/JD 等第三方 Anthropic 协议代理)现【参与远程探测】拿真实模型,
  // 不再一律 return []。支持 /v1/models 的代理返回真实目录;不支持的抛错被上层捕获退回手动注册。
  let fetchCalled = false;
  let seenHeaders = null;
  t.mock.method(global, 'fetch', async (_url, init) => {
    fetchCalled = true;
    seenHeaders = init && init.headers;
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'claude-sonnet-4-6' }] }) };
  });

  const models = await fetchModelsForAccount({
    claudeBaseUrl: 'https://anyrouter.top'
  }, {
    provider: 'claude',
    id: '6',
    accessToken: 'sk-auth-token',
    apiKeyMode: true,
    authType: 'auth-token'
  }, 500);

  assert.equal(fetchCalled, true);
  assert.equal(seenHeaders['x-api-key'], 'sk-auth-token');
  assert.equal(seenHeaders.authorization, undefined);
  assert.equal(seenHeaders['anthropic-beta'], undefined);
  assert.deepEqual(models, ['claude-sonnet-4-6']);
});

test('fetchModelsForAccount reads OpenCode models from official Go catalog', async (t) => {
  const calls = [];
  t.mock.method(global, 'fetch', async (url, init) => {
    calls.push({ url: String(url || ''), init });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: [{ id: 'glm-5.2' }]
      })
    };
  });

  const models = await fetchModelsForAccount({
    opencodeGoBaseUrl: 'https://opencode.test/zen/go/v1',
    opencodeGoApiKey: 'sk-test'
  }, {
    provider: 'opencode',
    id: '1'
  }, 500);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://opencode.test/zen/go/v1/models');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test');
  assert.deepEqual(models, ['opencode-go/glm-5.2']);
});

test('fetchModelsForAccount reads Codex OAuth models from native Codex catalog', async (t) => {
  let seenUrl = '';
  let seenHeaders = null;
  t.mock.method(global, 'fetch', async (url, init) => {
    seenUrl = String(url || '');
    seenHeaders = init && init.headers;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        models: [
          { slug: 'gpt-5.3-codex', visibility: 'public' },
          { id: 'gpt-5.4', visibility: 'default' },
          { slug: 'internal-hidden', visibility: 'private' },
          { slug: 'disabled-model', supported_in_api: false }
        ]
      })
    };
  });

  const models = await fetchModelsForAccount({
    codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
    codexClientVersion: '0.140.0'
  }, {
    provider: 'codex',
    accountRef: 'acct_01000000000000000000',
    accessToken: 'oauth-access-token',
    authType: 'oauth',
    apiKeyMode: false,
    upstreamAccountId: 'chatgpt-account-1'
  }, 500);

  assert.equal(seenUrl, 'https://chatgpt.com/backend-api/codex/models?client_version=0.140.0');
  assert.equal(seenHeaders.authorization, 'Bearer oauth-access-token');
  assert.equal(seenHeaders.originator, 'codex_cli_rs');
  assert.equal(seenHeaders.version, '0.140.0');
  assert.equal(seenHeaders['chatgpt-account-id'], 'chatgpt-account-1');
  assert.deepEqual(models, ['gpt-5.3-codex', 'gpt-5.4']);
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
    if (safeUrl.includes(':fetchAvailableModels')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            { model: 'gemini-3.1-pro-preview', vertexModelId: 'wire-gemini-pro' },
            { model: 'gemini-2.5-flash' }
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
  assert.equal(seenUrls.some((url) => url.includes(':fetchAvailableModels')), true);
  assert.equal(seenUrls.some((url) => url.includes(':retrieveUserQuota')), false);
});

test('fetchModelsForAccount falls back to Gemini quota models when catalog is permission denied', async (t) => {
  const seenCalls = [];
  t.mock.method(global, 'fetch', async (url, init = {}) => {
    const safeUrl = String(url || '');
    seenCalls.push({
      url: safeUrl,
      body: String(init.body || '')
    });
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: false,
        status: 403,
        text: async () => 'PERMISSION_DENIED'
      };
    }
    if (safeUrl.includes(':fetchAvailableModels')) {
      return {
        ok: false,
        status: 403,
        text: async () => JSON.stringify({
          error: {
            code: 403,
            message: 'The caller does not have permission',
            status: 'PERMISSION_DENIED'
          }
        })
      };
    }
    if (safeUrl.includes(':retrieveUserQuota')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          buckets: [
            { modelId: 'gemini-2.5-pro', remainingFraction: 0.75, resetTime: '2026-06-08T12:00:00Z' },
            { modelId: 'gemini-3.1-pro-preview_vertex', remainingFraction: 0.6, resetTime: '2026-06-08T12:00:00Z' },
            { modelId: 'MODEL_INTERNAL_ALPHA', remainingFraction: 1, resetTime: '2026-06-08T12:00:00Z' }
          ]
        })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const account = {
    provider: 'gemini',
    id: '1',
    authType: 'oauth-personal',
    accessToken: 'gemini-token'
  };

  const models = await fetchModelsForAccount({
    geminiBaseUrl: 'https://cloudcode-pa.googleapis.com/v1internal',
    ignoreAvailableModelsSnapshot: true
  }, account, 500);

  assert.deepEqual(models, ['gemini-2.5-pro', 'gemini-3.1-pro-preview']);
  assert.deepEqual(account.availableModels, ['gemini-2.5-pro', 'gemini-3.1-pro-preview']);
  assert.equal(seenCalls.some((call) => call.url.includes(':fetchAvailableModels')), true);
  assert.equal(seenCalls.some((call) => call.url.includes(':retrieveUserQuota')), true);
  const quotaCall = seenCalls.find((call) => call.url.includes(':retrieveUserQuota'));
  assert.deepEqual(JSON.parse(quotaCall.body), { project: '{{projectId}}' });
});

test('fetchModelsForAccount does not use AGY quota buckets as model catalog', async (t) => {
  const seenCalls = [];
  t.mock.method(global, 'fetch', async (url, init = {}) => {
    const safeUrl = String(url || '');
    seenCalls.push({
      url: safeUrl,
      headers: init.headers || {},
      body: String(init.body || '')
    });
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/agy-test' })
      };
    }
    if (safeUrl.includes(':fetchAvailableModels')) {
      return {
        ok: false,
        status: 403,
        text: async () => 'PERMISSION_DENIED'
      };
    }
    if (safeUrl.includes(':retrieveUserQuota')) {
      throw new Error('quota_must_not_be_used_as_catalog');
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const account = {
    provider: 'agy',
    id: 'agy-1',
    authType: 'oauth-personal',
    accessToken: 'agy-token',
    availableModels: ['gemini-3.1-pro-preview']
  };

  await assert.rejects(
    fetchModelsForAccount({
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
      ignoreAvailableModelsSnapshot: true
    }, account, 500),
    /HTTP 403 PERMISSION_DENIED/
  );

  const loadCall = seenCalls.find((call) => call.url.includes(':loadCodeAssist'));
  assert.ok(loadCall);
  assert.deepEqual(JSON.parse(loadCall.body).metadata, {
    ideType: 'ANTIGRAVITY',
    platform: 'PLATFORM_UNSPECIFIED',
    pluginType: 'GEMINI'
  });
  const availableCall = seenCalls.find((call) => call.url.includes(':fetchAvailableModels'));
  assert.ok(availableCall);
  assert.match(String(availableCall.headers['user-agent'] || ''), /^Antigravity\//);
  assert.equal(availableCall.headers['x-client-name'], 'antigravity');
  assert.equal(availableCall.headers['x-goog-user-project'], undefined);
  assert.equal(seenCalls.some((call) => call.url.includes(':retrieveUserQuota')), false);
  assert.deepEqual(account.availableModels, ['gemini-3.1-pro-preview']);
});

test('fetchModelsForAccount refreshes stale AGY Code Assist project before catalog fetch', async (t) => {
  const seenCalls = [];
  let loadCount = 0;
  t.mock.method(global, 'fetch', async (url, init = {}) => {
    const safeUrl = String(url || '');
    seenCalls.push({
      url: safeUrl,
      headers: init.headers || {},
      body: String(init.body || '')
    });
    if (safeUrl.includes(':loadCodeAssist')) {
      loadCount += 1;
      if (loadCount === 1) {
        return {
          ok: false,
          status: 403,
          text: async () => 'Cloud Code Private API has not been used in project stale before'
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/fresh-project' })
      };
    }
    if (safeUrl.includes(':fetchAvailableModels')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            { model: 'gemini-3.5-flash-high' }
          ]
        })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const account = {
    provider: 'agy',
    id: 'agy-1',
    authType: 'oauth-personal',
    accessToken: 'agy-token',
    codeAssistProject: 'projects/stale-project'
  };

  const models = await fetchModelsForAccount({
    agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
    ignoreAvailableModelsSnapshot: true
  }, account, 500);

  const loadCalls = seenCalls.filter((call) => call.url.includes(':loadCodeAssist'));
  assert.equal(loadCalls.length, 2);

  const staleLoadBody = JSON.parse(loadCalls[0].body);
  assert.equal(staleLoadBody.cloudaicompanionProject, 'projects/stale-project');
  assert.equal(staleLoadBody.metadata.duetProject, 'projects/stale-project');
  assert.equal(staleLoadBody.mode, 'HEALTH_CHECK');
  assert.equal(loadCalls[0].headers['x-goog-user-project'], undefined);

  const freshLoadBody = JSON.parse(loadCalls[1].body);
  assert.equal(freshLoadBody.cloudaicompanionProject, undefined);
  assert.equal(freshLoadBody.metadata.duetProject, undefined);
  assert.equal(freshLoadBody.mode, undefined);
  assert.equal(loadCalls[1].headers['x-goog-user-project'], undefined);

  const catalogCall = seenCalls.find((call) => call.url.includes(':fetchAvailableModels'));
  assert.ok(catalogCall);
  assert.equal(catalogCall.headers['x-goog-user-project'], undefined);
  assert.deepEqual(models, ['gemini-3.5-flash-high']);
  assert.equal(account.codeAssistProject, 'projects/fresh-project');
  assert.deepEqual(account.availableModels, ['gemini-3.5-flash-high']);
});

test('fetchModelsForAccount does not expose Code Assist internal enum ids as catalog models', async (t) => {
  t.mock.method(global, 'fetch', async (url) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/agy-test' })
      };
    }
    if (safeUrl.includes(':fetchAvailableModels')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            { model: 'MODEL_INTERNAL_ALPHA' },
            { model: 'MODEL_INTERNAL_BETA', displayName: 'Catalog Public Model' },
            'MODEL_INTERNAL_GAMMA',
            'provider-public-agent'
          ]
        })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const account = {
    provider: 'agy',
    id: 'agy-1',
    authType: 'oauth-personal',
    accessToken: 'agy-token'
  };

  const models = await fetchModelsForAccount({
    agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
    ignoreAvailableModelsSnapshot: true
  }, account, 500);

  assert.deepEqual(models, ['provider-public-agent']);
  assert.deepEqual(account.availableModels, ['provider-public-agent']);
});

test('fetchGeminiCodeAssistChatCompletion resolves missing model from live descriptor catalog', async (t) => {
  let generateBody = null;
  const seenUrls = [];
  t.mock.method(global, 'fetch', async (url, init = {}) => {
    const safeUrl = String(url || '');
    seenUrls.push(safeUrl);
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/agy-default' })
      };
    }
    if (safeUrl.includes(':fetchAvailableModels')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            { model: 'catalog-default', wireModelId: 'wire-default' }
          ]
        })
      };
    }
    if (safeUrl.includes(':generateContent')) {
      generateBody = JSON.parse(String(init.body || '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          traceId: 'trace-default',
          modelVersion: 'wire-default',
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

  const account = {
    provider: 'agy',
    id: 'agy-1',
    authType: 'oauth-personal',
    accessToken: 'agy-token'
  };

  const result = await fetchGeminiCodeAssistChatCompletion(
    { agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal' },
    account,
    { messages: [{ role: 'user', content: 'hi' }] },
    500
  );

  assert.equal(seenUrls.some((url) => url.includes(':fetchAvailableModels')), true);
  assert.equal(generateBody.model, 'wire-default');
  assert.equal(result.model, 'catalog-default');
  assert.deepEqual(account.availableModels, ['catalog-default']);
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
                  id: 'agy_tool_call_1',
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

  assert.equal(fetchCalls.length, 3);
  assert.match(fetchCalls[0].url, /cloudcode-pa\.googleapis\.com\/v1internal:loadCodeAssist/);
  assert.match(fetchCalls[1].url, /cloudcode-pa\.googleapis\.com\/v1internal:fetchAvailableModels/);
  assert.match(fetchCalls[2].url, /cloudcode-pa\.googleapis\.com\/v1internal:generateContent/);
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
  assert.equal(result.choices[0].message.content, null);
  assert.equal(result.choices[0].message.tool_calls[0].id, 'agy_tool_call_1');
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'mcp__CherryHub__list');
  assert.equal(result.usage.total_tokens, 3);
});

test('fetchGeminiCodeAssistChatCompletion opts image models into IMAGE modality and renders inlineData as markdown', async (t) => {
  let generateBody = null;
  t.mock.method(global, 'fetch', async (url, init) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/test-project' })
      };
    }
    if (safeUrl.includes(':fetchAvailableModels')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: [{ name: 'gemini-3.1-flash-image', displayName: 'Gemini 3.1 Flash Image' }]
        })
      };
    }
    if (safeUrl.includes(':generateContent')) {
      generateBody = JSON.parse(String(init && init.body || '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          traceId: 'trace-img',
          modelVersion: 'gemini-3.1-flash-image',
          candidates: [{
            finishReason: 'STOP',
            content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } }] }
          }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 6, totalTokenCount: 11 }
        })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const result = await fetchGeminiCodeAssistChatCompletion(
    { geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
    { provider: 'agy', authType: 'oauth-personal', accessToken: 'token-1' },
    {
      model: 'gemini-3.1-flash-image',
      messages: [{ role: 'user', content: 'draw a red circle' }]
    },
    800
  );

  // request side: IMAGE modality on, thinking stripped
  assert.deepEqual(generateBody.request.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
  assert.equal('thinkingConfig' in generateBody.request.generationConfig, false);
  // response side: inlineData -> markdown data URL image
  assert.equal(result.choices[0].message.content, '![生成的图片](data:image/jpeg;base64,QUJD)');
  assert.equal(result.choices[0].finish_reason, 'stop');
});

test('fetchGeminiCodeAssistChatCompletion preserves OpenAI tool call and result history for Gemini Code Assist', async (t) => {
  let generateBody = null;
  const diagnostics = [];
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
      generateBody = JSON.parse(String(init && init.body || '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          traceId: 'trace-1',
          modelVersion: 'gemini-2.5-pro',
          candidates: [{
            finishReason: 'STOP',
            content: { parts: [{ text: 'OK' }] }
          }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 }
        })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  await fetchGeminiCodeAssistChatCompletion(
    {
      geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      appendGeminiCodeAssistDiagnostic: (entry) => diagnostics.push(entry)
    },
    {
      provider: 'gemini',
      authType: 'oauth-personal',
      accessToken: 'token-1'
    },
    {
      model: 'gemini-2.5-pro',
      messages: [
        { role: 'system', content: 'You are a coding assistant.' },
        { role: 'user', content: 'Read the file.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_read_1',
            type: 'function',
            function: {
              name: 'Read',
              arguments: '{"file_path":"/tmp/demo.txt"}'
            }
          }]
        },
        {
          role: 'tool',
          tool_call_id: 'call_read_1',
          content: '{"content":"demo"}'
        },
        { role: 'user', content: 'Continue.' }
      ]
    },
    800
  );

  assert.ok(generateBody);
  assert.deepEqual(generateBody.request.systemInstruction, {
    role: 'user',
    parts: [{ text: 'You are a coding assistant.' }]
  });
  assert.deepEqual(generateBody.request.contents.map((item) => item.role), [
    'user',
    'model',
    'user',
    'user'
  ]);
  assert.deepEqual(generateBody.request.contents[1].parts, [{
    functionCall: {
      name: 'Read',
      args: { file_path: '/tmp/demo.txt' }
    }
  }]);
  assert.equal(generateBody.request.contents[1].parts[0].thoughtSignature, undefined);
  assert.equal(generateBody.request.contents[1].parts[0].functionCall.id, undefined);
  assert.deepEqual(generateBody.request.contents[2].parts, [{
    functionResponse: {
      name: 'Read',
      response: { content: 'demo' }
    }
  }]);
  assert.equal(generateBody.request.contents[2].parts[0].functionResponse.id, undefined);
  assert.equal(diagnostics[0].requestSummary.assistantToolCallCount, 1);
  assert.equal(diagnostics[0].requestSummary.toolResultCount, 1);
  assert.equal(diagnostics[0].requestSummary.toolResultWithResolvedNameCount, 1);
});

test('fetchGeminiCodeAssistChatCompletion uses Antigravity-compatible tool history only for agy provider', async (t) => {
  let generateBody = null;
  const diagnostics = [];
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
      generateBody = JSON.parse(String(init && init.body || '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          traceId: 'trace-1',
          modelVersion: 'claude-sonnet-4.6-thinking',
          candidates: [{
            finishReason: 'STOP',
            content: { parts: [{ text: 'OK' }] }
          }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 }
        })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const openAIRequest = convertAnthropicMessagesToOpenAIChat({
    model: 'claude-sonnet-4.6-thinking',
    max_tokens: 512,
    system: 'You are a coding assistant.',
    messages: [
      { role: 'user', content: 'Inspect the project.' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_read_1',
            name: 'Read',
            input: { file_path: '/tmp/demo.txt' }
          },
          {
            type: 'tool_use',
            id: 'toolu_bash_1',
            name: 'Bash',
            input: { command: 'pwd' }
          }
        ]
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_read_1', content: 'demo file' },
          { type: 'tool_result', tool_use_id: 'toolu_bash_1', content: 'cwd output' }
        ]
      },
      { role: 'user', content: 'Continue.' }
    ],
    tools: [
      {
        name: 'Read',
        description: 'Read a file',
        input_schema: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path']
        }
      },
      {
        name: 'Bash',
        description: 'Run a shell command',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command']
        }
      }
    ]
  });

  await fetchGeminiCodeAssistChatCompletion(
    {
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
      agySessionIdMap: new Map(),
      appendGeminiCodeAssistDiagnostic: (entry) => diagnostics.push(entry)
    },
    {
      provider: 'agy',
      authType: 'oauth-personal',
      accessToken: 'token-1'
    },
    openAIRequest,
    800
  );

  assert.ok(generateBody);
  const declarations = generateBody.request.tools[0].functionDeclarations;
  assert.equal(declarations.length, 2);
  assert.equal(declarations[0].parameters, undefined);
  assert.equal(declarations[0].parametersJsonSchema.properties.file_path.type, 'string');
  assert.deepEqual(declarations[0].parametersJsonSchema.required, ['file_path']);

  const modelParts = generateBody.request.contents[1].parts;
  assert.equal(modelParts[0].thoughtSignature, 'skip_thought_signature_validator');
  assert.equal(modelParts[0].functionCall.id, 'toolu_read_1');
  assert.deepEqual(modelParts[0].functionCall.args, { file_path: '/tmp/demo.txt' });
  assert.equal(modelParts[1].thoughtSignature, 'skip_thought_signature_validator');
  assert.equal(modelParts[1].functionCall.id, 'toolu_bash_1');
  assert.deepEqual(modelParts[1].functionCall.args, { command: 'pwd' });

  assert.deepEqual(generateBody.request.contents[2].parts, [{
    functionResponse: {
      name: 'Read',
      id: 'toolu_read_1',
      response: { result: 'demo file' }
    }
  }]);
  assert.deepEqual(generateBody.request.contents[3].parts, [{
    functionResponse: {
      name: 'Bash',
      id: 'toolu_bash_1',
      response: { result: 'cwd output' }
    }
  }]);
  assert.equal(diagnostics[0].requestSummary.toolDeclarationSchemaKey, 'parametersJsonSchema');
  assert.deepEqual(
    diagnostics[0].requestSummary.toolDeclarations.map((item) => [item.name, item.schemaKey, item.required]),
    [
      ['Read', 'parametersJsonSchema', ['file_path']],
      ['Bash', 'parametersJsonSchema', ['command']]
    ]
  );
});

test('fetchGeminiCodeAssistChatCompletion reports empty response tool arguments in diagnostics', async (t) => {
  const diagnostics = [];
  t.mock.method(global, 'fetch', async (url) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/test-project' })
      };
    }
    if (safeUrl.includes(':generateContent')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          traceId: 'trace-1',
          modelVersion: 'gemini-2.5-pro',
          candidates: [{
            finishReason: 'UNEXPECTED_TOOL_CALL',
            content: {
              parts: [{ functionCall: { name: 'Read', args: {} } }]
            }
          }]
        })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  await fetchGeminiCodeAssistChatCompletion(
    {
      geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      appendGeminiCodeAssistDiagnostic: (entry) => diagnostics.push(entry)
    },
    {
      provider: 'gemini',
      authType: 'oauth-personal',
      accessToken: 'token-1'
    },
    {
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'Read the file.' }]
    },
    800
  );

  assert.deepEqual(diagnostics[diagnostics.length - 1].responseToolCalls, [{
    name: 'Read',
    argumentLength: 2,
    argKeys: [],
    emptyArgs: true
  }]);
});

test('fetchGeminiCodeAssistChatCompletionStream applies Gemini provider strategy defaults', async (t) => {
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
  assert.equal(generateBody.request.generationConfig.thinkingConfig.thinkingLevel, 'high');
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
      geminiCodeAssistOverageEligibleModels: ['gemini-3.1-pro-preview'],
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
    },
    codeAssistOverageEligibleModels: ['eligible-model']
  };
  assert.equal(
    __private.shouldEnableGeminiCodeAssistCredits('other-model', paidAccount, {}).enabled,
    false
  );
  assert.equal(
    __private.shouldEnableGeminiCodeAssistCredits('eligible-model', {
      codeAssistPaidTier: {
        availableCredits: [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '49' }]
      },
      codeAssistOverageEligibleModels: ['eligible-model']
    }, {}).enabled,
    false
  );
  assert.equal(
    __private.shouldEnableGeminiCodeAssistCredits('eligible-model', {
      ...paidAccount,
      geminiCodeAssistOverageStrategy: 'never'
    }, {}).enabled,
    false
  );
  assert.equal(
    __private.shouldEnableGeminiCodeAssistCredits('eligible-model', paidAccount, {}).enabled,
    true
  );
});

test('fetchGeminiCodeAssistGenerateContent repairs native Gemini tool history generically', async (t) => {
  let generateBody = null;
  const diagnostics = [];
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
      generateBody = JSON.parse(String(init && init.body || '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          traceId: 'trace-native-tool-repair',
          modelVersion: 'gemini-2.5-pro',
          candidates: [{
            finishReason: 'STOP',
            content: { parts: [{ text: 'OK' }] }
          }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 }
        })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  await fetchGeminiCodeAssistGenerateContent(
    {
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
      agySessionIdMap: new Map(),
      clientProtocol: 'gemini_generate_content',
      appendGeminiCodeAssistDiagnostic: (entry) => diagnostics.push(entry)
    },
    {
      provider: 'agy',
      authType: 'oauth-personal',
      accessToken: 'token-1'
    },
    {
      model: 'claude-4-6-thinking',
      contents: [
        { role: 'user', parts: [{ text: 'fetch status' }] },
        {
          role: 'model',
          parts: [{
            functionCall: {
              id: 'call_fetch_1',
              name: 'CustomFetch',
              args: { url: 'https://example.test' }
            }
          }]
        },
        {
          role: 'user',
          parts: [{
            functionResponse: {
              id: 'call_fetch_1',
              name: '',
              response: { result: '{"ok":true}' }
            }
          }]
        },
        {
          role: 'model',
          parts: [
            { text: 'I may inspect the shell next.' },
            {
              functionCall: {
                id: 'call_shell_1',
                name: 'ShellExec',
                args: { command: 'pwd' }
              }
            }
          ]
        }
      ],
      tools: [{
        functionDeclarations: [
          {
            name: 'CustomFetch',
            parametersJsonSchema: {
              type: 'object',
              properties: { url: { type: 'string' } },
              required: ['url']
            }
          },
          {
            name: 'ShellExec',
            parametersJsonSchema: {
              type: 'object',
              properties: { command: { type: 'string' } },
              required: ['command']
            }
          }
        ]
      }]
    },
    800
  );

  assert.ok(generateBody);
  assert.equal(generateBody.model, 'claude-4-6-thinking');
  assert.deepEqual(generateBody.request.contents.map((item) => item.role), [
    'user',
    'model',
    'user',
    'model'
  ]);
  assert.equal(
    generateBody.request.contents[1].parts[0].thoughtSignature,
    'skip_thought_signature_validator'
  );
  assert.equal(generateBody.request.contents[2].parts[0].functionResponse.name, 'CustomFetch');
  assert.deepEqual(generateBody.request.contents[3].parts, [{
    text: 'I may inspect the shell next.'
  }]);
  assert.equal(
    JSON.stringify(generateBody.request.contents).includes('call_shell_1'),
    false
  );
  assert.match(generateBody.request.sessionId, GEMINI_SESSION_ID_RE);
  assert.equal(generateBody.request.session_id, undefined);
  assert.equal(diagnostics[0].requestProtocol, 'gemini_generate_content');
  assert.equal(diagnostics[0].upstreamProtocol, 'gemini_code_assist_generate_content');
  assert.equal(diagnostics[0].requestSummary.backfilledFunctionResponseNameCount, 1);
  assert.equal(diagnostics[0].requestSummary.addedToolCallThoughtSignatureCount, 1);
  assert.equal(diagnostics[0].requestSummary.droppedTrailingUnansweredFunctionCallTurn, 1);
});

test('native Gemini tool repair only backfills adjacent function responses', () => {
  const repaired = __private.repairNativeGeminiCodeAssistContents([
    {
      role: 'model',
      parts: [{
        functionCall: {
          id: 'call_lookup_1',
          name: 'Lookup',
          args: { query: 'x' }
        }
      }]
    },
    {
      role: 'user',
      parts: [{ text: 'non-tool interjection' }]
    },
    {
      role: 'user',
      parts: [{
        functionResponse: {
          id: 'call_lookup_1',
          name: '',
          response: { result: 'late result' }
        }
      }]
    }
  ], { addToolCallThoughtSignature: false });

  assert.equal(repaired.summary.backfilledFunctionResponseNameCount, 0);
  assert.equal(repaired.contents[2].parts[0].functionResponse.name, '');
});

test('native AGY Code Assist repair wraps non-object function response payloads', () => {
  const repaired = __private.repairNativeGeminiCodeAssistContents([
    {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'Read',
            response: 'plain output'
          }
        },
        {
          functionResponse: {
            name: 'List',
            response: ['a', 'b']
          }
        },
        {
          function_response: {
            name: 'Nullable',
            response: null
          }
        },
        {
          functionResponse: {
            name: 'ObjectResult',
            response: { ok: true }
          }
        }
      ]
    }
  ], { provider: 'agy', addToolCallThoughtSignature: false });

  assert.deepEqual(repaired.contents[0].parts[0].functionResponse.response, { result: 'plain output' });
  assert.deepEqual(repaired.contents[0].parts[1].functionResponse.response, { result: ['a', 'b'] });
  assert.deepEqual(repaired.contents[0].parts[2].function_response.response, { result: null });
  assert.deepEqual(repaired.contents[0].parts[3].functionResponse.response, { ok: true });
  assert.equal(repaired.summary.wrappedAgyFunctionResponseCount, 3);

  const nonAgy = __private.repairNativeGeminiCodeAssistContents([
    {
      role: 'user',
      parts: [{
        functionResponse: {
          name: 'Read',
          response: 'plain output'
        }
      }]
    }
  ], { provider: 'gemini', addToolCallThoughtSignature: false });

  assert.equal(nonAgy.contents[0].parts[0].functionResponse.response, 'plain output');
  assert.equal(nonAgy.summary.wrappedAgyFunctionResponseCount, 0);
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
          modelVersion: 'claude-opus-4.6-thinking',
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

test('fetchGeminiCodeAssistChatCompletion keeps external session stable across AGY accounts', async (t) => {
  const sessionIds = [];
  const requestIds = [];
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
      sessionIds.push(requestBody.request.sessionId);
      requestIds.push(requestBody.requestId);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          traceId: `trace-agy-${sessionIds.length}`,
          modelVersion: 'claude-opus-4.6-thinking',
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
  const options = {
    geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    geminiSessionIdMap,
    sessionKey: 'claude-thread-1'
  };
  const accountOne = {
    provider: 'agy',
    id: '1',
    authType: 'oauth-personal',
    accessToken: 'token-1'
  };
  const accountTwo = {
    provider: 'agy',
    id: '2',
    authType: 'oauth-personal',
    accessToken: 'token-2'
  };

  await fetchGeminiCodeAssistChatCompletion(
    options,
    accountOne,
    {
      model: 'gemini-3.1-pro-preview',
      messages: [{ role: 'user', content: 'hi' }]
    },
    800
  );
  await fetchGeminiCodeAssistChatCompletion(
    options,
    accountTwo,
    {
      model: 'gemini-3.1-pro-preview',
      messages: [{ role: 'user', content: 'continue' }]
    },
    800
  );

  assert.equal(sessionIds.length, 2);
  assert.equal(sessionIds[0], sessionIds[1]);
  assert.match(sessionIds[0], GEMINI_SESSION_ID_RE);
  assert.equal(requestIds.length, 2);
  assert.match(requestIds[0], /^agent\/[0-9]+\/[0-9a-f]{8}$/);
  assert.match(requestIds[1], /^agent\/[0-9]+\/[0-9a-f]{8}$/);
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

test('fetchGeminiCodeAssistChatCompletion resolves AGY wire ids from provider model descriptors', async (t) => {
  const seenModels = [];
  t.mock.method(global, 'fetch', async (url, init) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/test-project' })
      };
    }
    if (safeUrl.includes(':fetchAvailableModels')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: {
            public_high: {
              model: 'public-high',
              displayName: 'Public High',
              wireModelId: 'wire-high'
            },
            public_reasoning: {
              model: 'public-reasoning',
              displayName: 'Public Reasoning',
              wireModelId: 'wire-reasoning'
            }
          }
        })
      };
    }
    if (safeUrl.includes(':generateContent')) {
      const requestBody = JSON.parse(String(init && init.body || '{}'));
      seenModels.push(requestBody.model);
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

  const highFlashResult = await fetchGeminiCodeAssistChatCompletion(
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
      model: 'Public High',
      messages: [{ role: 'user', content: 'hi' }]
    },
    800
  );

  assert.equal(seenModels[0], 'wire-high');
  // Response returned to the client should preserve the original requested model name
  assert.equal(highFlashResult.model, 'Public High');

  const claudeAliasResult = await fetchGeminiCodeAssistChatCompletion(
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
      model: 'public-reasoning',
      messages: [{ role: 'user', content: 'hi' }]
    },
    800
  );

  assert.equal(seenModels[1], 'wire-reasoning');
  assert.equal(claudeAliasResult.model, 'public-reasoning');
});

test('fetchGeminiCodeAssistChatCompletion omits unsupported temperature for AGY Claude Opus thinking', async (t) => {
  let generateBody = null;
  const diagnostics = [];
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
      generateBody = JSON.parse(String(init && init.body || '{}'));
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

  const result = await fetchGeminiCodeAssistChatCompletion(
    {
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
      appendGeminiCodeAssistDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    },
    {
      provider: 'agy',
      id: 'agy-3',
      authType: 'oauth-personal',
      accessToken: 'token-3'
    },
    {
      model: 'claude-opus-4.6-thinking',
      max_tokens: 300,
      temperature: 0.2,
      top_p: 0.8,
      messages: [{ role: 'user', content: 'search' }]
    },
    800
  );

  const generationConfig = generateBody.request.generationConfig;
  assert.equal(generateBody.model, 'claude-opus-4.6-thinking');
  assert.equal(Object.hasOwn(generationConfig, 'temperature'), false);
  // 注入思考(thinkingBudget:-1)后给答案预留预算:maxOutputTokens 抬到 客户端 max_tokens + 思考余量,
  // 否则思考会吃光预算 → 只有思考没有回答。余量 = clamp(max_tokens, 8192, 32768) = 8192。
  assert.equal(generationConfig.maxOutputTokens, 300 + 8192);
  assert.equal(generationConfig.topP, 0.8);
  assert.equal(result.model, 'claude-opus-4.6-thinking');
  assert.deepEqual(diagnostics[0].omittedGenerationConfigKeys, ['temperature']);
  assert.deepEqual(diagnostics[0].generationConfigCapabilityRules.map((rule) => [rule.id, rule.reason]), [[
    'agy:code_assist:claude_opus_thinking:omit-temperature',
    'agy_claude_opus_thinking_code_assist_does_not_accept_generation_temperature'
  ]]);
  assert.deepEqual(diagnostics[0].requestSummary.omittedGenerationConfigKeys, ['temperature']);
  assert.equal(diagnostics[0].requestSummary.generationConfigKeys.includes('temperature'), false);
});

test('fetchGeminiCodeAssistChatCompletion strips $schema, $id and normalizes array types in tool parameters for Gemini', async (t) => {
  let generateBody = null;
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
      generateBody = JSON.parse(String(init && init.body || '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          traceId: 'trace-1',
          modelVersion: 'gemini-2.5-pro',
          candidates: [{
            finishReason: 'STOP',
            content: { parts: [{ text: 'OK' }] }
          }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 }
        })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  await fetchGeminiCodeAssistChatCompletion(
    {
      geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      geminiSessionIdMap: new Map()
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
          name: 'get_weather',
          description: 'get weather info',
          parameters: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            $id: 'weather-schema-id',
            type: 'object',
            properties: {
              location: {
                type: ['string', 'null'],
                description: 'city name'
              }
            }
          }
        }
      }]
    },
    800
  );

  assert.ok(generateBody);
  const declaration = generateBody.request.tools[0].functionDeclarations[0];
  assert.equal(declaration.parametersJsonSchema, undefined);
  const schema = declaration.parameters;
  assert.equal(schema.$schema, undefined);
  assert.equal(schema.$id, undefined);
  assert.equal(schema.type, 'object');
  assert.equal(schema.properties.location.type, 'string');
});

test('fetchGeminiCodeAssistChatCompletion sanitizes Anthropic JSON Schema keywords for agy tools', async (t) => {
  let generateBody = null;
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
      generateBody = JSON.parse(String(init && init.body || '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          traceId: 'trace-1',
          modelVersion: 'gemini-2.5-pro',
          candidates: [{
            finishReason: 'STOP',
            content: { parts: [{ text: 'OK' }] }
          }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 }
        })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const openAIRequest = convertAnthropicMessagesToOpenAIChat({
    model: 'claude-sonnet-4.6-thinking',
    max_tokens: 512,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{
      name: 'lookup',
      description: 'Lookup with dynamic filters',
      input_schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          filters: {
            type: 'object',
            propertyNames: { pattern: '^[a-z_]+$' },
            patternProperties: {
              '^x_': { type: 'string' }
            },
            properties: {
              limit: {
                type: ['number', 'null'],
                minimum: 1
              }
            },
            additionalProperties: {
              type: ['string', 'null'],
              description: 'Filter value'
            }
          }
        },
        required: ['filters'],
        additionalProperties: false,
        unevaluatedProperties: false
      }
    }]
  });

  await fetchGeminiCodeAssistChatCompletion(
    {
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
      agySessionIdMap: new Map()
    },
    {
      provider: 'agy',
      authType: 'oauth-personal',
      accessToken: 'token-1'
    },
    openAIRequest,
    800
  );

  assert.ok(generateBody);
  const declaration = generateBody.request.tools[0].functionDeclarations[0];
  assert.equal(declaration.parameters, undefined);
  const schema = declaration.parametersJsonSchema;
  assert.equal(schema.$schema, undefined);
  assert.equal(schema.unevaluatedProperties, undefined);
  assert.equal(schema.propertyNames, undefined);
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['filters']);
  assert.equal(schema.additionalProperties, false);

  const filters = schema.properties.filters;
  assert.equal(filters.propertyNames, undefined);
  assert.equal(filters.patternProperties, undefined);
  assert.equal(filters.properties.limit.type, 'number');
  assert.equal(filters.properties.limit.minimum, 1);
  assert.equal(filters.additionalProperties.type, 'string');
  assert.equal(filters.additionalProperties.description, 'Filter value');
});

test('fetchModelsForAccount promotes tieredModelIds into the account model catalog', async (t) => {
  t.mock.method(global, 'fetch', async (url) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/tiered-project' })
      };
    }
    if (safeUrl.includes(':fetchAvailableModels')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: {
            'gemini-3.5-flash': {
              displayName: 'Gemini 3.5 Flash',
              tieredModelIds: {
                low: 'gemini-3.5-flash-low',
                high: 'gemini-3.5-flash-high'
              }
            }
          }
        })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const account = {
    provider: 'agy',
    id: 'agy-tiered',
    authType: 'oauth-personal',
    accessToken: 'agy-token'
  };

  const models = await fetchModelsForAccount({
    agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
    ignoreAvailableModelsSnapshot: true
  }, account, 500);

  // high/low 档位必须作为独立模型进入账号目录
  assert.deepEqual(models, ['gemini-3.5-flash', 'gemini-3.5-flash-high', 'gemini-3.5-flash-low']);
  assert.deepEqual(account.availableModels, ['gemini-3.5-flash', 'gemini-3.5-flash-high', 'gemini-3.5-flash-low']);
});
