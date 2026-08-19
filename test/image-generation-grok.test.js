'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createGrokImageGenerationStrategy,
  __private: { buildGrokImageUrl, readGrokErrorBody, resolveGrokImageUpstreamModel }
} = require('../lib/server/image-generation-grok');
const { ImageGenerationError } = require('../lib/server/image-generation-strategy');

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function okResponse(json) {
  return {
    ok: true,
    status: 200,
    async text() {
      return typeof json === 'string' ? json : JSON.stringify(json);
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

function makeFetch(handler) {
  return async (url, init, timeoutMs, extra) => handler(url, init, timeoutMs, extra);
}

function grokAccount(overrides = {}) {
  return {
    accountRef: 'acct_g',
    provider: 'grok',
    authType: 'oauth',
    apiKeyMode: false,
    accessToken: 'xai-tok-1',
    openaiBaseUrl: 'https://api.x.ai/v1',
    email: 'grok@example.com',
    ...overrides
  };
}

test('grok strategy posts an OpenAI-compatible generations request with the oauth token', async () => {
  let captured;
  const strategy = createGrokImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async (url, init, timeoutMs, extra) => {
      captured = { url, init, timeoutMs, extra };
      return okResponse({
        model: 'grok-imagine-image-2.0',
        data: [{ b64_json: PNG_BASE64 }],
        usage: { input_tokens: 10, output_tokens: 12, total_tokens: 22 }
      });
    }),
    refreshGrokAccessToken: async () => {}
  });

  const out = await strategy.generate({
    mode: 'generation',
    model: 'grok-image-2',
    prompt: 'a cat',
    account: grokAccount(),
    options: {}
  });

  assert.equal(captured.url, 'https://api.x.ai/v1/images/generations');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.authorization, 'Bearer xai-tok-1');
  assert.equal(captured.init.headers['content-type'], 'application/json');
  const payload = JSON.parse(captured.init.body);
  // image model names are intent markers; the upstream model must be grok-imagine-*
  assert.equal(payload.model, 'grok-imagine-image-2.0');
  assert.equal(payload.prompt, 'a cat');
  assert.equal(payload.response_format, 'b64_json');

  assert.equal(out.images.length, 1);
  assert.equal(out.images[0].b64_json, PNG_BASE64);
  assert.equal(out.usageInput.usage.total_tokens, 22);
  assert.equal(out.usageInput.model, 'grok-imagine-image-2.0');
});

test('grok strategy forwards n, quality and url response format when requested', async () => {
  let captured;
  const strategy = createGrokImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async (url, init) => {
      captured = init;
      return okResponse({
        data: [{ url: 'https://media.x.ai/img.png' }]
      });
    }),
    refreshGrokAccessToken: async () => {}
  });

  const out = await strategy.generate({
    mode: 'generation',
    model: 'grok-imagine-image-2.0',
    prompt: 'two dogs',
    n: 2,
    quality: 'low',
    responseFormat: 'url',
    account: grokAccount(),
    options: {}
  });

  const payload = JSON.parse(captured.body);
  assert.equal(payload.n, 2);
  assert.equal(payload.quality, 'low');
  assert.equal(payload.response_format, 'url');
  assert.equal(out.images[0].url, 'https://media.x.ai/img.png');
});

test('grok strategy embeds the source image as a data URL for edits', async () => {
  let captured;
  const strategy = createGrokImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async (url, init) => {
      captured = init;
      return okResponse({
        data: [{ b64_json: PNG_BASE64 }]
      });
    }),
    refreshGrokAccessToken: async () => {}
  });

  await strategy.generate({
    mode: 'edit',
    model: 'grok-image-2',
    prompt: 'make it sunset',
    image: { mimeType: 'image/png', data: PNG_BASE64 },
    account: grokAccount(),
    options: {}
  });

  const payload = JSON.parse(captured.body);
  assert.equal(payload.image, `data:image/png;base64,${PNG_BASE64}`);
});

test('grok strategy honors an explicit grokImageUpstreamModel override', async () => {
  let captured;
  const strategy = createGrokImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async (url, init) => {
      captured = init;
      return okResponse({ data: [{ b64_json: PNG_BASE64 }] });
    }),
    refreshGrokAccessToken: async () => {}
  });

  await strategy.generate({
    mode: 'generation',
    model: 'grok-image-2',
    prompt: 'x',
    account: grokAccount(),
    options: { grokImageUpstreamModel: 'grok-imagine-image' }
  });

  const payload = JSON.parse(captured.body);
  assert.equal(payload.model, 'grok-imagine-image');
});

test('grok strategy refreshes the oauth token before the call', async () => {
  let refreshed = 0;
  const strategy = createGrokImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async () => okResponse({ data: [{ b64_json: PNG_BASE64 }] })),
    refreshGrokAccessToken: async (account, options, deps) => {
      refreshed += 1;
      assert.equal(account.accessToken, 'xai-tok-1');
    }
  });

  await strategy.generate({
    mode: 'generation',
    model: 'grok-image-2',
    prompt: 'x',
    account: grokAccount(),
    options: {}
  });

  assert.equal(refreshed, 1);
});

test('grok strategy rejects accounts without a usable token', async () => {
  const strategy = createGrokImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async () => okResponse({ data: [] }))
  });

  await assert.rejects(
    strategy.generate({
      mode: 'generation',
      model: 'grok-image-2',
      prompt: 'x',
      account: grokAccount({ accessToken: '' }),
      options: {}
    }),
    (error) => {
      assert.ok(error instanceof ImageGenerationError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'invalid_access_token');
      return true;
    }
  );
});

test('grok strategy surfaces upstream errors with the body attached', async () => {
  let captured;
  const strategy = createGrokImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async (url, init) => {
      captured = init;
      return errResponse(403, {
        code: 'personal-team-blocked:spending-limit',
        error: { message: 'You have run out of credits' }
      });
    }),
    refreshGrokAccessToken: async () => {}
  });

  await assert.rejects(
    strategy.generate({
      mode: 'generation',
      model: 'grok-image-2',
      prompt: 'x',
      account: grokAccount(),
      options: {}
    }),
    (error) => {
      assert.ok(error instanceof ImageGenerationError);
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'upstream_failed');
      assert.match(error.detail, /run out of credits/);
      assert.match(error.upstreamBody, /spending-limit/);
      return true;
    }
  );
});

test('grok strategy surfaces string-form upstream errors with the body attached', async () => {
  const strategy = createGrokImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async () => errResponse(403, {
      code: 'personal-team-blocked:spending-limit',
      error: 'You have run out of credits or need a Grok subscription'
    })),
    refreshGrokAccessToken: async () => {}
  });

  await assert.rejects(
    strategy.generate({
      mode: 'generation',
      model: 'grok-image-2',
      prompt: 'x',
      account: grokAccount(),
      options: {}
    }),
    (error) => {
      assert.equal(error.statusCode, 403);
      assert.match(error.detail, /run out of credits/);
      return true;
    }
  );
});

test('grok strategy rejects empty upstream image data', async () => {
  const strategy = createGrokImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async () => okResponse({ data: [] }))
  });

  await assert.rejects(
    strategy.generate({
      mode: 'generation',
      model: 'grok-image-2',
      prompt: 'x',
      account: grokAccount(),
      options: {}
    }),
    (error) => {
      assert.equal(error.statusCode, 502);
      assert.equal(error.code, 'upstream_failed');
      return true;
    }
  );
});

test('grok strategy wraps transport failures as 502', async () => {
  const strategy = createGrokImageGenerationStrategy({
    fetchWithTimeout: makeFetch(async () => {
      throw new Error('ECONNREFUSED');
    })
  });

  await assert.rejects(
    strategy.generate({
      mode: 'generation',
      model: 'grok-image-2',
      prompt: 'x',
      account: grokAccount(),
      options: {}
    }),
    (error) => {
      assert.equal(error.statusCode, 502);
      assert.match(error.detail, /ECONNREFUSED/);
      return true;
    }
  );
});

test('grok strategy fails fast when no transport is configured', async () => {
  const strategy = createGrokImageGenerationStrategy({});
  await assert.rejects(
    strategy.generate({
      mode: 'generation',
      model: 'grok-image-2',
      prompt: 'x',
      account: grokAccount(),
      options: {}
    }),
    (error) => {
      assert.equal(error.statusCode, 500);
      assert.equal(error.code, 'grok_transport_unavailable');
      return true;
    }
  );
});

test('grok strategy only serves image-generation model names', () => {
  const strategy = createGrokImageGenerationStrategy({});
  assert.equal(strategy.supportsModel('grok-image-2'), true);
  assert.equal(strategy.supportsModel('grok-imagine-image-2.0'), true);
  assert.equal(strategy.supportsModel('grok-4.6'), false);
  assert.equal(strategy.supportsModel('gpt-4o'), false);
});

test('resolveGrokImageUpstreamModel picks the default candidate or explicit override', () => {
  assert.equal(resolveGrokImageUpstreamModel('grok-image-2', {}), 'grok-imagine-image-2.0');
  assert.equal(resolveGrokImageUpstreamModel('grok-image-2', { grokImageUpstreamModel: 'grok-imagine-image' }), 'grok-imagine-image');
});

test('buildGrokImageUrl trims trailing slashes', () => {
  assert.equal(buildGrokImageUrl('https://api.x.ai/v1/'), 'https://api.x.ai/v1/images/generations');
  assert.equal(buildGrokImageUrl('https://api.x.ai'), 'https://api.x.ai/images/generations');
});

test('readGrokErrorBody falls back to a status message', () => {
  assert.equal(readGrokErrorBody(500, { error: { message: 'boom' } }), 'boom');
  assert.equal(readGrokErrorBody(500, { error: { detail: 'detail' } }), 'detail');
  assert.equal(readGrokErrorBody(500, { error: 'string error' }), 'string error');
  assert.equal(readGrokErrorBody(500, {}), 'upstream returned HTTP 500');
});