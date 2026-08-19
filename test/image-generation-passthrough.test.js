'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createPassthroughImageGenerationStrategy,
  __private: { buildUpstreamUrl, readUpstreamErrorBody }
} = require('../lib/server/image-generation-passthrough');
const { ImageGenerationError } = require('../lib/server/image-generation-strategy');

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function makeFetch(handler) {
  return async (url, init, timeoutMs, extra) => {
    return handler(url, init, timeoutMs, extra);
  };
}

function okResponse(json) {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(json);
    }
  };
}

function errResponse(status, json) {
  return {
    ok: false,
    status,
    async text() {
      return JSON.stringify(json);
    }
  };
}

function apiKeyAccount(overrides = {}) {
  return {
    accountRef: 'acct_k',
    provider: 'codex',
    apiKeyMode: true,
    apiKey: 'sk-test',
    openaiBaseUrl: 'https://api.example.com/v1',
    email: 'key@example.com',
    ...overrides
  };
}

test('passthrough strategy posts JSON to /v1/images/generations and maps b64_json', async () => {
  const calls = [];
  const strategy = createPassthroughImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async (url, init) => {
      calls.push({ url, init });
      return okResponse({
        created: 1,
        data: [{ b64_json: 'YWJj' }],
        usage: { total_tokens: 12, prompt_tokens: 3, completion_tokens: 9 },
        model: 'gpt-image-1'
      });
    })
  });

  const out = await strategy.generate({
    mode: 'generation',
    model: 'gpt-image-1',
    prompt: 'a cat',
    n: 1,
    responseFormat: 'b64_json',
    account: apiKeyAccount(),
    options: {}
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/images\/generations$/);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test');
  assert.equal(calls[0].init.headers['x-aih-account-ref'], 'acct_k');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, { model: 'gpt-image-1', prompt: 'a cat', n: 1, response_format: 'b64_json' });
  assert.deepEqual(out.images, [{ b64_json: 'YWJj' }]);
  assert.equal(out.usageInput.usage.total_tokens, 12);
  assert.equal(out.usageInput.model, 'gpt-image-1');
});

test('passthrough strategy sends multipart FormData for edits', async () => {
  let capturedBody;
  const strategy = createPassthroughImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async (_url, init) => {
      capturedBody = init.body;
      assert.ok(capturedBody instanceof FormData, 'body must be FormData');
      assert.equal(init.headers.authorization, 'Bearer sk-test');
      return okResponse({ data: [{ url: 'https://upstream/x.png' }] });
    })
  });

  const out = await strategy.generate({
    mode: 'edit',
    model: 'gpt-image-1',
    prompt: 'add a hat',
    n: 1,
    responseFormat: 'url',
    image: { mimeType: 'image/png', data: 'aGVsbG8=' },
    account: apiKeyAccount(),
    options: {}
  });

  assert.ok(capturedBody.has('image'));
  assert.equal(capturedBody.get('model'), 'gpt-image-1');
  assert.equal(capturedBody.get('response_format'), 'url');
  assert.deepEqual(out.images, [{ url: 'https://upstream/x.png' }]);
});

test('passthrough strategy forwards size/quality and masks upstream errors', async () => {
  const strategy = createPassthroughImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async () => errResponse(429, { error: { message: 'rate limited' } }))
  });

  await assert.rejects(
    strategy.generate({
      mode: 'generation',
      model: 'm',
      prompt: 'p',
      size: '1024x1024',
      quality: 'high',
      account: apiKeyAccount(),
      options: {}
    }),
    (error) => {
      assert.ok(error instanceof ImageGenerationError);
      assert.equal(error.statusCode, 429);
      assert.equal(error.code, 'upstream_failed');
      assert.equal(error.message, 'rate limited');
      return true;
    }
  );
});

test('passthrough strategy fails closed without transport or key', async () => {
  const noTransport = createPassthroughImageGenerationStrategy({});
  await assert.rejects(
    noTransport.generate({ mode: 'generation', model: 'm', prompt: 'p', account: apiKeyAccount(), options: {} }),
    (error) => error.code === 'passthrough_transport_unavailable'
  );

  const noKey = createPassthroughImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async () => okResponse({ data: [{ url: 'x' }] }))
  });
  await assert.rejects(
    noKey.generate({
      mode: 'generation',
      model: 'm',
      prompt: 'p',
      account: apiKeyAccount({ apiKey: undefined }),
      options: {}
    }),
    (error) => error.code === 'invalid_access_token'
  );
});

test('passthrough strategy rejects empty upstream data and transport failures', async () => {
  const empty = createPassthroughImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async () => okResponse({ data: [] }))
  });
  await assert.rejects(
    empty.generate({ mode: 'generation', model: 'm', prompt: 'p', account: apiKeyAccount(), options: {} }),
    (error) => error.code === 'upstream_failed'
  );

  const network = createPassthroughImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async () => {
      throw new Error('ECONNREFUSED');
    })
  });
  await assert.rejects(
    network.generate({ mode: 'generation', model: 'm', prompt: 'p', account: apiKeyAccount(), options: {} }),
    (error) => error.code === 'upstream_failed' && error.statusCode === 502
  );
});

test('buildUpstreamUrl joins base and provider path', () => {
  assert.equal(buildUpstreamUrl('https://api.example.com/v1', 'codex', 'generations'), 'https://api.example.com/v1/images/generations');
  assert.equal(buildUpstreamUrl('https://api.example.com/v1/', 'codex', 'edits'), 'https://api.example.com/v1/images/edits');
});

test('readUpstreamErrorBody prefers upstream error message', () => {
  assert.equal(readUpstreamErrorBody(502, { error: { message: 'boom' } }), 'boom');
  assert.equal(readUpstreamErrorBody(502, { error: { detail: 'd' } }), 'd');
  assert.equal(readUpstreamErrorBody(500, {}), 'upstream returned HTTP 500');
});