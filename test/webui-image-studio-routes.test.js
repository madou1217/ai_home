'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createImageStudioStore } = require('../lib/server/image-studio-store');
const { handleWebUiImageStudioRoutes } = require('../lib/server/webui-image-studio-routes');

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function createRes() {
  return {
    statusCode: 0,
    headers: { 'x-aih-request-id': 'req_studio_1' },
    body: null,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    getHeader(name) {
      return this.headers[String(name).toLowerCase()];
    },
    writeHead(status, headers) {
      this.statusCode = status;
      Object.entries(headers || {}).forEach(([name, value]) => this.setHeader(name, value));
    },
    end(body) {
      this.body = body;
    }
  };
}

function responseHeaders(values = {}) {
  return {
    get(name) {
      return values[String(name || '').toLowerCase()] || null;
    }
  };
}

function createHarness(t, config = {}) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-image-studio-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const account = config.account || {
    provider: 'codex',
    accountRef: 'acct_codex_studio',
    accessToken: 'codex-token'
  };
  const store = createImageStudioStore({ fs, aiHomeDir });
  const state = config.state || {
    accounts: { [account.provider]: [account] },
    metrics: { totalSuccess: 0, totalFailures: 0 }
  };
  const calls = { successes: [], failures: [] };

  async function invoke(method, pathname, body) {
    const res = createRes();
    const payload = Buffer.from(body == null ? '' : JSON.stringify(body));
    const handled = await handleWebUiImageStudioRoutes({
      method,
      pathname,
      req: { headers: { host: '127.0.0.1:9527' } },
      res,
      options: {
        codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
        logRequests: false,
        ...(config.options || {})
      },
      state,
      cooldownMs: 5000,
      readRequestBody: async () => payload,
      writeJson: (target, status, value) => {
        target.statusCode = status;
        target.body = value;
      },
      deps: {
        imageStudioStore: store,
        resolveGatewayProvider: () => ({ provider: 'codex' }),
        chooseServerAccount: (pool, _state, _routeKey, selection = {}) => {
          const excluded = selection.excludeAccountRefs || new Set();
          return pool.find((candidate) => !excluded.has(candidate.accountRef)) || null;
        },
        fetchWithTimeout: config.fetchWithTimeout || (async () => ({
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              data: [{ b64_json: PNG_BASE64 }],
              usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 }
            });
          }
        })),
        markProxyAccountSuccess: (selected) => calls.successes.push(selected.accountRef),
        markProxyAccountFailure: (selected) => calls.failures.push(selected.accountRef),
        recordModelUsage: () => {},
        ...(config.deps || {})
      }
    });
    return { handled, res };
  }

  return { account, calls, invoke, state, store };
}

test('webui image Studio model catalog exposes gpt-image-2 as the default Codex model', async (t) => {
  const { invoke } = createHarness(t);
  const { handled, res } = await invoke('GET', '/v0/webui/studio/image/models');
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.defaultModelKey, 'codex:gpt-image-2');
  assert.equal(res.body.models[0].id, 'gpt-image-2');
  assert.equal(res.body.models[0].capabilities.edit, true);
  assert.equal(res.body.models[0].capabilities.maxInputImages, 5);
  assert.equal(res.body.models[0].capabilities.multiple, true);
  assert.equal(res.body.models[0].capabilities.size, true);
  assert.equal(res.body.models[0].capabilities.quality, true);
  assert.equal(res.body.models[0].capabilities.outputFormat, false);
});

test('webui image Studio defaults to the first schedulable model while keeping unavailable models visible', async (t) => {
  const { invoke } = createHarness(t, {
    state: {
      accounts: {
        codex: [{
          provider: 'codex',
          accountRef: 'acct_codex_unavailable',
          accessToken: 'codex-token',
          schedulableStatus: 'blocked_by_quota',
          schedulableReason: 'usage_exhausted'
        }],
        agy: [{
          provider: 'agy',
          accountRef: 'acct_agy_available',
          accessToken: 'agy-token'
        }]
      },
      metrics: { totalSuccess: 0, totalFailures: 0 }
    }
  });

  const { res } = await invoke('GET', '/v0/webui/studio/image/models');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.defaultModelKey, 'agy:gemini-3.1-flash-image');
  const codex = res.body.models.find((model) => model.key === 'codex:gpt-image-2');
  assert.ok(codex);
  assert.equal(codex.availableAccountCount, 0);
  assert.deepEqual(codex.unavailableReasons, [
    { reason: 'blocked_by_quota:usage_exhausted', count: 1 }
  ]);
});

test('webui image Studio persists session create, list, detail and rename flows', async (t) => {
  const { invoke } = createHarness(t);
  const created = await invoke('POST', '/v0/webui/studio/image/sessions', { title: '包装探索' });
  assert.equal(created.res.statusCode, 201);
  const sessionId = created.res.body.session.id;

  const listed = await invoke('GET', '/v0/webui/studio/image/sessions');
  assert.equal(listed.res.body.sessions.length, 1);
  assert.equal(listed.res.body.sessions[0].title, '包装探索');

  const renamed = await invoke('PATCH', `/v0/webui/studio/image/sessions/${sessionId}`, { title: '包装探索 02' });
  assert.equal(renamed.res.body.session.title, '包装探索 02');

  const detail = await invoke('GET', `/v0/webui/studio/image/sessions/${sessionId}`);
  assert.equal(detail.res.body.session.id, sessionId);
  assert.equal(detail.res.body.session.revisions.length, 0);
});

test('webui image Studio deletes a settled session through the durable store', async (t) => {
  const { invoke } = createHarness(t);
  const created = await invoke('POST', '/v0/webui/studio/image/sessions', { title: '临时会话' });
  const sessionId = created.res.body.session.id;

  const deleted = await invoke('DELETE', `/v0/webui/studio/image/sessions/${sessionId}`);
  assert.equal(deleted.handled, true);
  assert.equal(deleted.res.statusCode, 200);
  assert.equal(deleted.res.body.deletedSessionId, sessionId);

  const listed = await invoke('GET', '/v0/webui/studio/image/sessions');
  assert.deepEqual(listed.res.body.sessions, []);
  const detail = await invoke('GET', `/v0/webui/studio/image/sessions/${sessionId}`);
  assert.equal(detail.res.statusCode, 404);
  assert.equal(detail.res.body.error, 'image_session_not_found');
});

test('webui image Studio runs durable generation and edit revisions through the shared executor', async (t) => {
  const { calls, invoke } = createHarness(t);
  const created = await invoke('POST', '/v0/webui/studio/image/sessions', {});
  const sessionId = created.res.body.session.id;

  const generated = await invoke('POST', `/v0/webui/studio/image/sessions/${sessionId}/runs`, {
    mode: 'generation',
    modelKey: 'codex:gpt-image-2',
    prompt: 'A restrained product portrait'
  });
  assert.equal(generated.res.statusCode, 200);
  assert.equal(generated.res.body.session.revisions.length, 1);
  assert.equal(generated.res.body.session.revisions[0].status, 'succeeded');
  assert.equal(generated.res.body.revisionId, generated.res.body.session.revisions[0].id);
  assert.equal(generated.res.body.session.assets.length, 1);
  assert.equal(calls.successes.length, 1);

  const firstRevision = generated.res.body.session.revisions[0];
  const sourceAssetId = firstRevision.outputAssetIds[0];
  const edited = await invoke('POST', `/v0/webui/studio/image/sessions/${sessionId}/runs`, {
    mode: 'edit',
    modelKey: 'codex:gpt-image-2',
    prompt: 'Keep the form and add warm side light',
    parentRevisionId: firstRevision.id,
    sources: [{ assetId: sourceAssetId }]
  });
  assert.equal(edited.res.statusCode, 200);
  assert.equal(edited.res.body.session.revisions.length, 2);
  assert.deepEqual(edited.res.body.session.revisions[1].sourceAssetIds, [sourceAssetId]);
  assert.equal(edited.res.body.session.revisions[1].parentRevisionId, firstRevision.id);
  assert.equal(edited.res.body.session.assets.length, 2);

  const asset = await invoke(
    'GET',
    `/v0/webui/studio/image/sessions/${sessionId}/assets/${edited.res.body.session.revisions[1].outputAssetIds[0]}`
  );
  assert.equal(asset.res.statusCode, 200);
  assert.equal(asset.res.headers['content-type'], 'image/png');
  assert.equal(asset.res.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(asset.res.body, Buffer.from(PNG_BASE64, 'base64'));
});

test('webui image Studio can continue editing a persisted output larger than the public upload limit', async (t) => {
  const { invoke, store } = createHarness(t);
  const session = store.createSession({ title: 'large persisted asset' });
  const started = store.beginRevision(session.id, {
    mode: 'generation',
    provider: 'codex',
    model: 'gpt-image-2',
    prompt: 'large output'
  });
  const bytes = Buffer.alloc((4 * 1024 * 1024) + 1);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  const completed = store.completeRevision(session.id, started.revision.id, {
    accountRef: 'acct_codex_studio',
    images: [{ bytes, mimeType: 'image/png' }]
  });
  const sourceAssetId = completed.revision.outputAssetIds[0];

  const edited = await invoke('POST', `/v0/webui/studio/image/sessions/${session.id}/runs`, {
    mode: 'edit',
    modelKey: 'codex:gpt-image-2',
    prompt: 'continue from large output',
    parentRevisionId: completed.revision.id,
    sources: [{ assetId: sourceAssetId }]
  });

  assert.equal(edited.res.statusCode, 200);
  assert.equal(edited.res.body.session.revisions.at(-1).status, 'succeeded');
  assert.deepEqual(edited.res.body.session.revisions.at(-1).sourceAssetIds, [sourceAssetId]);
});

test('webui image Studio preserves mixed reference order and supported Codex controls', async (t) => {
  let upstreamRequest = null;
  const { invoke, store } = createHarness(t, {
    fetchWithTimeout: async (url, init) => {
      upstreamRequest = { url, body: JSON.parse(init.body) };
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ data: [{ b64_json: PNG_BASE64 }] });
        }
      };
    }
  });
  const session = store.createSession({ title: 'mixed references' });
  const generated = store.beginRevision(session.id, {
    mode: 'generation',
    provider: 'codex',
    model: 'gpt-image-2',
    prompt: 'base'
  });
  const completed = store.completeRevision(session.id, generated.revision.id, {
    images: [{ mimeType: 'image/png', bytes: Buffer.from(PNG_BASE64, 'base64') }]
  });
  const storedAssetId = completed.revision.outputAssetIds[0];

  const edited = await invoke('POST', `/v0/webui/studio/image/sessions/${session.id}/runs`, {
    mode: 'edit',
    modelKey: 'codex:gpt-image-2',
    prompt: 'combine both references',
    sources: [
      { assetId: storedAssetId },
      { image: `data:image/png;base64,${PNG_BASE64}` }
    ],
    background: 'transparent',
    n: 2,
    size: '1536x1024',
    quality: 'high'
  });

  assert.equal(edited.res.statusCode, 200);
  const revision = edited.res.body.session.revisions.at(-1);
  assert.equal(revision.sourceAssetIds[0], storedAssetId);
  assert.equal(revision.sourceAssetIds.length, 2);
  assert.deepEqual(revision.parameters, {
    n: 2,
    size: '1536x1024',
    quality: 'high',
    background: 'transparent',
    outputFormat: '',
    outputCompression: null,
    moderation: ''
  });
  assert.equal(upstreamRequest.url, 'https://chatgpt.com/backend-api/codex/images/edits');
  assert.deepEqual(upstreamRequest.body, {
    images: [
      { image_url: `data:image/png;base64,${PNG_BASE64}` },
      { image_url: `data:image/png;base64,${PNG_BASE64}` }
    ],
    prompt: 'combine both references',
    background: 'transparent',
    model: 'gpt-image-2',
    n: 2,
    quality: 'high',
    size: '1536x1024'
  });
});

test('webui image Studio persists revised prompts with generated assets', async (t) => {
  const { invoke } = createHarness(t, {
    fetchWithTimeout: async () => ({
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            data: [{
              b64_json: PNG_BASE64,
              revised_prompt: 'A refined product portrait'
            }]
          });
        }
    })
  });
  const created = await invoke('POST', '/v0/webui/studio/image/sessions', {});
  const sessionId = created.res.body.session.id;

  const generated = await invoke('POST', `/v0/webui/studio/image/sessions/${sessionId}/runs`, {
    mode: 'generation',
    modelKey: 'codex:gpt-image-2',
    prompt: 'A product portrait'
  });

  assert.equal(generated.res.statusCode, 200);
  assert.equal(generated.res.body.session.assets[0].revisedPrompt, 'A refined product portrait');
});

test('webui image Studio keeps successful revisions successful when observability hooks throw', async (t) => {
  const { invoke } = createHarness(t, {
    options: { logRequests: true },
    deps: {
      appendProxyRequestLog() {
        throw new Error('request log unavailable');
      }
    }
  });
  const created = await invoke('POST', '/v0/webui/studio/image/sessions', {});
  const sessionId = created.res.body.session.id;

  const run = await invoke('POST', `/v0/webui/studio/image/sessions/${sessionId}/runs`, {
    mode: 'generation',
    modelKey: 'codex:gpt-image-2',
    prompt: 'observer isolation'
  });

  assert.equal(run.res.statusCode, 200);
  assert.equal(run.res.body.session.revisions[0].status, 'succeeded');
  assert.equal(run.res.body.revisionId, run.res.body.session.revisions[0].id);
});

test('webui image Studio preserves the original failure when failure observers throw', async (t) => {
  const { invoke } = createHarness(t, {
    options: { logRequests: true },
    fetchWithTimeout: async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] });
      }
    }),
    deps: {
      pushMetricError() {
        throw new Error('metrics unavailable');
      },
      markProxyAccountFailure() {
        throw new Error('account failure store unavailable');
      },
      appendProxyRequestLog() {
        throw new Error('request log unavailable');
      }
    }
  });
  const created = await invoke('POST', '/v0/webui/studio/image/sessions', {});
  const sessionId = created.res.body.session.id;

  const run = await invoke('POST', `/v0/webui/studio/image/sessions/${sessionId}/runs`, {
    mode: 'generation',
    modelKey: 'codex:gpt-image-2',
    prompt: 'invalid image output'
  });

  assert.equal(run.res.statusCode, 502);
  assert.equal(run.res.body.error, 'invalid_image_output');
  const detail = await invoke('GET', `/v0/webui/studio/image/sessions/${sessionId}`);
  assert.equal(detail.res.body.session.revisions[0].status, 'failed');
});

test('webui image Studio keeps independent sessions isolated', async (t) => {
  const { invoke } = createHarness(t);
  const first = await invoke('POST', '/v0/webui/studio/image/sessions', { title: '窗口 A' });
  const second = await invoke('POST', '/v0/webui/studio/image/sessions', { title: '窗口 B' });
  const firstId = first.res.body.session.id;
  const secondId = second.res.body.session.id;

  await invoke('POST', `/v0/webui/studio/image/sessions/${firstId}/runs`, {
    mode: 'generation',
    modelKey: 'codex:gpt-image-2',
    prompt: 'only in A'
  });
  const secondDetail = await invoke('GET', `/v0/webui/studio/image/sessions/${secondId}`);
  assert.equal(secondDetail.res.body.session.revisions.length, 0);
  assert.equal(secondDetail.res.body.session.assets.length, 0);
});

test('webui image Studio rejects non-image provider output and persists a failed revision', async (t) => {
  const { calls, invoke } = createHarness(t, {
    fetchWithTimeout: async () => ({
      ok: true,
      status: 200,
        async text() {
          return JSON.stringify({
            data: [{ b64_json: 'aGVsbG8=' }]
          });
        }
    })
  });
  const created = await invoke('POST', '/v0/webui/studio/image/sessions', {});
  const sessionId = created.res.body.session.id;

  const run = await invoke('POST', `/v0/webui/studio/image/sessions/${sessionId}/runs`, {
    mode: 'generation',
    modelKey: 'codex:gpt-image-2',
    prompt: 'return invalid bytes'
  });

  assert.equal(run.res.statusCode, 502);
  assert.equal(run.res.body.error, 'invalid_image_output');
  assert.equal(calls.failures.length, 1);
  assert.equal(calls.successes.length, 0);
  const detail = await invoke('GET', `/v0/webui/studio/image/sessions/${sessionId}`);
  assert.equal(detail.res.body.session.revisions[0].status, 'failed');
});

test('webui image Studio blocks private output urls before a second transport request', async (t) => {
  const account = {
    provider: 'codex',
    accountRef: 'acct_codex_key',
    authType: 'api-key',
    apiKey: 'key',
    openaiBaseUrl: 'https://api.example/v1',
    availableModels: ['gpt-image-2']
  };
  let transportCalls = 0;
  const { calls, invoke } = createHarness(t, {
    account,
    fetchWithTimeout: async () => {
      transportCalls += 1;
      if (transportCalls > 1) throw new Error('blocked image url must not be fetched');
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ data: [{ url: 'http://127.0.0.1:9527/readyz' }] });
        }
      };
    }
  });
  const created = await invoke('POST', '/v0/webui/studio/image/sessions', {});
  const sessionId = created.res.body.session.id;

  const run = await invoke('POST', `/v0/webui/studio/image/sessions/${sessionId}/runs`, {
    mode: 'generation',
    modelKey: 'codex:gpt-image-2',
    prompt: 'return a private url'
  });

  assert.equal(run.res.statusCode, 502);
  assert.equal(run.res.body.error, 'image_asset_url_blocked');
  assert.equal(transportCalls, 1);
  assert.equal(calls.failures.length, 1);
  assert.equal(calls.successes.length, 0);
});

test('webui image Studio allows the exact passthrough origin but stops oversized streams', async (t) => {
  const account = {
    provider: 'codex',
    accountRef: 'acct_codex_local',
    authType: 'api-key',
    apiKey: 'key',
    openaiBaseUrl: 'http://127.0.0.1:11434/v1',
    availableModels: ['gpt-image-2']
  };
  const oversizedChunk = Buffer.alloc((10 * 1024 * 1024) + 1);
  let transportCalls = 0;
  let cancelled = false;
  const { calls, invoke } = createHarness(t, {
    account,
    fetchWithTimeout: async () => {
      transportCalls += 1;
      if (transportCalls === 1) {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ data: [{ url: 'http://127.0.0.1:11434/assets/generated.png' }] });
          }
        };
      }
      return {
        ok: true,
        status: 200,
        headers: responseHeaders({ 'content-type': 'image/png' }),
        body: {
          getReader() {
            let index = 0;
            return {
              async read() {
                index += 1;
                if (index <= 2) return { done: false, value: oversizedChunk };
                return { done: true, value: undefined };
              },
              async cancel() {
                cancelled = true;
              },
              releaseLock() {}
            };
          }
        }
      };
    }
  });
  const created = await invoke('POST', '/v0/webui/studio/image/sessions', {});
  const sessionId = created.res.body.session.id;

  const run = await invoke('POST', `/v0/webui/studio/image/sessions/${sessionId}/runs`, {
    mode: 'generation',
    modelKey: 'codex:gpt-image-2',
    prompt: 'return an oversized local asset'
  });

  assert.equal(run.res.statusCode, 413);
  assert.equal(run.res.body.error, 'image_asset_too_large');
  assert.equal(transportCalls, 2);
  assert.equal(cancelled, true);
  assert.equal(calls.failures.length, 1);
  assert.equal(calls.successes.length, 0);
});
