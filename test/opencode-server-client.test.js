const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const {
  fetchOpenCodeChatCompletion,
  fetchOpenCodeModels,
  resolveModelPair,
  buildOpenCodePrompt,
  __private
} = require('../lib/server/opencode-server-client');

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload)
  };
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

test('resolveModelPair strips the OpenCode Go public model prefix', () => {
  assert.deepEqual(resolveModelPair('opencode-go/glm-5.2'), {
    providerID: 'opencode-go',
    modelID: 'glm-5.2'
  });
});

test('buildOpenCodePrompt keeps system text separate from conversation text', () => {
  const prompt = buildOpenCodePrompt({
    messages: [
      { role: 'system', content: 'Use concise answers.' },
      { role: 'developer', content: 'Never expose secrets.' },
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', content: 'Hi' },
      { role: 'tool', content: 'tool result' }
    ]
  });

  assert.equal(prompt.system, 'Use concise answers.\n\nNever expose secrets.');
  assert.equal(prompt.text, 'User: Hello\n\nAssistant: Hi\n\nTool: tool result');
});

test('fetchOpenCodeModels reads the official OpenCode Go model catalog', async () => {
  const calls = [];
  const models = await fetchOpenCodeModels({
    opencodeGoBaseUrl: 'https://opencode.test/zen/go/v1',
    opencodeGoApiKey: 'sk-test'
  }, { provider: 'opencode' }, 500, {
    fetchWithTimeout: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        object: 'list',
        data: [
          { id: 'glm-5.2', object: 'model' },
          { id: 'kimi-k2.7-code', object: 'model' }
        ]
      });
    }
  });

  assert.deepEqual(models, ['opencode-go/glm-5.2', 'opencode-go/kimi-k2.7-code']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://opencode.test/zen/go/v1/models');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test');
});

test('fetchOpenCodeModels reads opencode-go api key from account auth.json', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opencode-go-auth-'));
  try {
    const authPath = path.join(root, 'auth.json');
    writeJson(authPath, {
      'opencode-go': { type: 'api', key: 'sk-from-auth' }
    });
    let seenHeaders = null;
    const models = await fetchOpenCodeModels({
      opencodeGoBaseUrl: 'https://opencode.test/zen/go/v1'
    }, {
      provider: 'opencode',
      authPath,
      accessToken: 'opencode-local'
    }, 500, {
      fetchWithTimeout: async (_url, init) => {
        seenHeaders = init.headers;
        return jsonResponse({ data: [{ id: 'glm-5.2' }] });
      }
    });

    assert.equal(seenHeaders.authorization, 'Bearer sk-from-auth');
    assert.deepEqual(models, ['opencode-go/glm-5.2']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fetchOpenCodeModels decodes compressed model catalog without content-encoding header', async () => {
  const compressed = zlib.brotliCompressSync(Buffer.from(JSON.stringify({
    object: 'list',
    data: [
      { id: 'glm-5.2', object: 'model' },
      { id: 'minimax-m3', object: 'model' }
    ]
  })));

  const models = await fetchOpenCodeModels({
    opencodeGoBaseUrl: 'https://opencode.test/zen/go/v1',
    opencodeGoApiKey: 'sk-test'
  }, { provider: 'opencode' }, 500, {
    fetchWithTimeout: async () => ({
      ok: true,
      status: 200,
      headers: new Map(),
      arrayBuffer: async () => compressed
    })
  });

  assert.deepEqual(models, ['opencode-go/glm-5.2', 'opencode-go/minimax-m3']);
});

test('fetchOpenCodeChatCompletion posts OpenAI chat to the official OpenCode Go endpoint', async () => {
  const calls = [];
  const result = await fetchOpenCodeChatCompletion({
    opencodeGoBaseUrl: 'https://opencode.test/zen/go/v1',
    opencodeGoApiKey: 'sk-test'
  }, {
    provider: 'opencode'
  }, {
    model: 'opencode-go/glm-5.2',
    session_id: 'ui-session-from-request',
    messages: [
      { role: 'system', content: 'System policy' },
      { role: 'user', content: 'Write a test.' }
    ],
    tools: [{
      type: 'function',
      function: {
        name: 'Read',
        description: 'Read a file.',
        parameters: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path']
        }
      }
    }],
    tool_choice: { type: 'function', function: { name: 'Read' } }
  }, 500, {
    fetchWithTimeout: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        id: 'chatcmpl_1',
        object: 'chat.completion',
        model: 'glm-5.2',
        choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
      });
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://opencode.test/zen/go/v1/chat/completions');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: 'glm-5.2',
    messages: [
      { role: 'system', content: 'System policy' },
      { role: 'user', content: 'Write a test.' }
    ],
    tools: [{
      type: 'function',
      function: {
        name: 'Read',
        description: 'Read a file.',
        parameters: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path']
        }
      }
    }],
    tool_choice: { type: 'function', function: { name: 'Read' } },
    stream: false
  });
  assert.equal(result.model, 'opencode-go/glm-5.2');
  assert.equal(result.sessionId, 'ui-session-from-request');
  assert.equal(result.choices[0].message.content, 'done');
});

test('fetchOpenCodeChatCompletion only trusts request session_id', async () => {
  const withSession = await fetchOpenCodeChatCompletion({
    opencodeGoBaseUrl: 'https://opencode.test/zen/go/v1',
    opencodeGoApiKey: 'sk-test'
  }, {
    provider: 'opencode'
  }, {
    model: 'opencode-go/glm-5.2',
    session_id: 'ses_from_request',
    messages: [{ role: 'user', content: 'hi' }]
  }, 500, {
    fetchWithTimeout: async () => jsonResponse({
      id: 'chatcmpl_should_not_win',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }]
    })
  });

  assert.equal(withSession.sessionId, 'ses_from_request');

  const withoutSession = await fetchOpenCodeChatCompletion({
    opencodeGoBaseUrl: 'https://opencode.test/zen/go/v1',
    opencodeGoApiKey: 'sk-test'
  }, {
    provider: 'opencode'
  }, {
    model: 'opencode-go/glm-5.2',
    messages: [{ role: 'user', content: 'hi' }]
  }, 500, {
    fetchWithTimeout: async () => jsonResponse({
      id: 'chatcmpl_not_a_session',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }]
    })
  });

  assert.equal(Object.prototype.hasOwnProperty.call(withoutSession, 'sessionId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(withoutSession, 'session_id'), false);
});

test('fetchOpenCodeChatCompletion adapts Anthropic-message OpenCode Go models', async () => {
  const calls = [];
  const result = await fetchOpenCodeChatCompletion({
    opencodeGoBaseUrl: 'https://opencode.test/zen/go/v1',
    opencodeGoApiKey: 'sk-test'
  }, {
    provider: 'opencode'
  }, {
    model: 'opencode-go/qwen3.7-plus',
    messages: [
      { role: 'system', content: 'System policy' },
      { role: 'user', content: 'Reply OK.' }
    ],
    max_tokens: 128,
    session_id: 'anthropic-session-from-request'
  }, 500, {
    fetchWithTimeout: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'qwen3.7-plus',
        content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 4, output_tokens: 1 }
      });
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://opencode.test/zen/go/v1/messages');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: 'qwen3.7-plus',
    max_tokens: 128,
    messages: [{ role: 'user', content: 'Reply OK.' }],
    system: 'System policy'
  });
  assert.equal(result.model, 'opencode-go/qwen3.7-plus');
  assert.equal(result.sessionId, 'anthropic-session-from-request');
  assert.equal(result.choices[0].message.content, 'OK');
  assert.deepEqual(result.usage, {
    prompt_tokens: 4,
    completion_tokens: 1,
    total_tokens: 5
  });
});

test('fetchOpenCodeChatCompletion does not derive session id from upstream payload', async () => {
  const result = await fetchOpenCodeChatCompletion({
    opencodeGoBaseUrl: 'https://opencode.test/zen/go/v1',
    opencodeGoApiKey: 'sk-test'
  }, {
    provider: 'opencode'
  }, {
    model: 'opencode-go/glm-5.2',
    messages: [{ role: 'user', content: 'No local session.' }]
  }, 500, {
    fetchWithTimeout: async () => jsonResponse({
      id: 'chatcmpl-upstream',
      session_id: 'upstream-session',
      object: 'chat.completion',
      model: 'glm-5.2',
      choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    })
  });

  assert.equal(Object.prototype.hasOwnProperty.call(result, 'session_id'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'sessionId'), false);
  assert.equal(result.id, 'chatcmpl-upstream');
});

test('fetchOpenCodeChatCompletion requires an OpenCode Go api key', async () => {
  await assert.rejects(
    () => fetchOpenCodeChatCompletion({}, { provider: 'opencode', accessToken: 'opencode-local' }, {
      model: 'opencode-go/glm-5.2',
      messages: [{ role: 'user', content: 'hi' }]
    }),
    /invalid_opencode_go_api_key/
  );
});

test('private model helpers classify OpenCode Go endpoints', () => {
  assert.equal(__private.isAnthropicMessagesModel('opencode-go/qwen3.7-plus'), true);
  assert.equal(__private.isAnthropicMessagesModel('opencode-go/glm-5.2'), false);
  assert.equal(__private.prefixOpenCodeGoModel('glm-5.2'), 'opencode-go/glm-5.2');
  assert.equal(__private.stripOpenCodeGoModelPrefix('opencode-go/glm-5.2'), 'glm-5.2');
});
