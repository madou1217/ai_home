'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGoManagementClient } = require('../lib/account/go-bridge/go-management-client');

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body === undefined ? '' : JSON.stringify(body)
  };
}

test('pushModelCatalogProjection sends the complete projection contract', async () => {
  const calls = [];
  const client = createGoManagementClient({
    baseUrl: 'http://127.0.0.1:19550/',
    managementKey: 'management-secret',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response(200, {
        data: {
          generation: 4,
          revision: 'catalog-rev-4',
          accepted_count: 1,
          routable_model_ids: ['gpt-6.1-sol']
        }
      });
    }
  });
  const payload = {
    revision: 'catalog-rev-4',
    models: [{
      id: 'gpt-6.1-sol',
      owned_by: 'openai',
      input_modalities: ['text'],
      output_modalities: ['text'],
      reasoning_efforts: ['low']
    }]
  };

  const result = await client.pushModelCatalogProjection(payload);

  assert.deepEqual(result, {
    ok: true,
    status: 200,
    data: {
      generation: 4,
      revision: 'catalog-rev-4',
      accepted_count: 1,
      routable_model_ids: ['gpt-6.1-sol']
    },
    page: null,
    body: {
      data: {
        generation: 4,
        revision: 'catalog-rev-4',
        accepted_count: 1,
        routable_model_ids: ['gpt-6.1-sol']
      }
    },
    errorCode: ''
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:19550/v1/management/model-catalog');
  assert.equal(calls[0].init.method, 'PUT');
  assert.equal(calls[0].init.headers.authorization, 'Bearer management-secret');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), payload);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('getModelCatalog uses the read-only management contract without a request body', async () => {
  let call;
  const client = createGoManagementClient({
    baseUrl: 'http://go.local',
    managementKey: 'management-secret',
    fetchImpl: async (url, init) => {
      call = { url, init };
      return response(200, {
        data: { generation: 9, revision: 'catalog-rev-9', accepted_count: 0, routable_model_ids: [] }
      });
    }
  });

  const result = await client.getModelCatalog();

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, {
    generation: 9,
    revision: 'catalog-rev-9',
    accepted_count: 0,
    routable_model_ids: []
  });
  assert.equal(call.url, 'http://go.local/v1/management/model-catalog');
  assert.equal(call.init.method, 'GET');
  assert.equal(call.init.headers.authorization, 'Bearer management-secret');
  assert.equal(Object.hasOwn(call.init.headers, 'content-type'), false);
  assert.equal(call.init.body, undefined);
});

test('management status and metrics use read-only Go shadow contracts', async () => {
  const calls = [];
  const client = createGoManagementClient({
    baseUrl: 'http://go.local',
    managementKey: 'management-secret',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response(200, { ok: true, total_requests: 3 });
    }
  });

  const status = await client.getManagementStatus();
  const metrics = await client.getManagementMetrics();

  assert.equal(status.ok, true);
  assert.equal(metrics.ok, true);
  assert.deepEqual(calls.map((call) => call.url), [
    'http://go.local/v1/management/status',
    'http://go.local/v1/management/metrics'
  ]);
  for (const call of calls) {
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.body, undefined);
    assert.equal(call.init.headers.authorization, 'Bearer management-secret');
    assert.equal(Object.hasOwn(call.init.headers, 'content-type'), false);
  }
});

test('usage query methods preserve explicit filters and use read-only contracts', async () => {
  const calls = [];
  const client = createGoManagementClient({
    baseUrl: 'http://go.local',
    managementKey: 'management-secret',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response(200, { ok: true, stats: { total_calls: 1 } });
    }
  });

  await client.getUsageStats({ from: '2026-10-01', to: '2026-10-02', provider: 'codex', model: 'gpt-6.1-sol' });
  await client.getUsageModels({ from: '2026-10-01', to: '2026-10-02' });
  await client.getUsageSessions({ from: '2026-10-01', to: '2026-10-02', session_id: 's 1' });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'http://go.local/v1/management/usage/stats?from=2026-10-01&to=2026-10-02&provider=codex&model=gpt-6.1-sol');
  assert.equal(calls[1].url, 'http://go.local/v1/management/usage/models?from=2026-10-01&to=2026-10-02');
  assert.equal(calls[2].url, 'http://go.local/v1/management/usage/sessions?from=2026-10-01&to=2026-10-02&session_id=s+1');
  for (const call of calls) {
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.body, undefined);
    assert.equal(call.init.headers.authorization, 'Bearer management-secret');
  }
});

test('management client preserves structured HTTP errors and does not expose the key', async () => {
  const client = createGoManagementClient({
    baseUrl: 'http://go.local',
    managementKey: 'management-secret',
    fetchImpl: async () => response(400, {
      error: {
        code: 'invalid_projection',
        message: 'invalid model catalog'
      }
    })
  });

  const result = await client.pushModelCatalogProjection({ revision: 'bad', models: [] });

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.errorCode, 'invalid_projection');
  assert.equal(JSON.stringify(result).includes('management-secret'), false);
});

test('management client maps malformed HTTP errors to the status fallback', async () => {
  const client = createGoManagementClient({
    baseUrl: 'http://go.local',
    managementKey: 'management-secret',
    fetchImpl: async () => ({
      ok: false,
      status: 502,
      text: async () => 'upstream returned html'
    })
  });

  const result = await client.getModelCatalog();

  assert.deepEqual(result, {
    ok: false,
    status: 502,
    data: null,
    page: null,
    body: null,
    errorCode: 'http_502'
  });
});

test('management client distinguishes network failures and abort timeouts', async (t) => {
  await t.test('network failure', async () => {
    const client = createGoManagementClient({
      baseUrl: 'http://go.local',
      managementKey: 'management-secret',
      fetchImpl: async () => {
        throw new Error('socket closed');
      }
    });

    const result = await client.getModelCatalog();

    assert.deepEqual(result, {
      ok: false,
      status: 0,
      data: null,
      page: null,
      errorCode: 'network_error'
    });
  });

  await t.test('abort timeout', async () => {
    const client = createGoManagementClient({
      baseUrl: 'http://go.local',
      managementKey: 'management-secret',
      timeoutMs: 5,
      fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      })
    });

    // The production timeout timer is deliberately unref'ed; keep this test's
    // event loop alive long enough for the injected fetch to observe abort.
    const keepAlive = setTimeout(() => {}, 30);
    const result = await client.getModelCatalog();
    clearTimeout(keepAlive);

    assert.deepEqual(result, {
      ok: false,
      status: 0,
      data: null,
      page: null,
      errorCode: 'timeout'
    });
  });
});
