'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleWebUiSubscriptionAggregatorRoutes } = require('../lib/server/webui-subscription-aggregator-routes');
const { handleAggregatedSubscriptionRequest } = require('../lib/server/subscription-aggregator-public-route');

function createRecorder() {
  const writes = [];
  return {
    writes,
    writeJson(_res, status, payload) {
      writes.push({ status, payload });
      return true;
    }
  };
}

function createRes() {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    }
  };
}

function createService(overrides = {}) {
  const calls = [];
  return {
    calls,
    getOverview: () => ({ ok: true, profiles: [], sources: [] }),
    saveProfile: (input) => { calls.push(['saveProfile', input]); return { ok: true, profile: { id: 'agg_1', ...input } }; },
    deleteProfile: (id) => (id === 'agg_1' ? { ok: true } : { ok: false, error: 'aggregator_profile_not_found' }),
    rotateToken: (id) => { calls.push(['rotate', id]); return { ok: true, profile: { id } }; },
    preview: (id, format) => { calls.push(['preview', id, format]); return { ok: true, content: 'x' }; },
    saveSource: async (input) => { calls.push(['saveSource', input]); return { ok: true }; },
    deleteSource: async (id) => { calls.push(['deleteSource', id]); return { ok: true }; },
    syncSource: async (id) => { calls.push(['syncSource', id]); return { ok: false, error: 'subscription_fetch_timeout' }; },
    syncSources: async (ids) => { calls.push(['syncSources', ids]); return { ok: true, results: {} }; },
    ...overrides
  };
}

const PREFIX = '/v0/webui/toolkit/subscription-aggregator';

async function call(method, pathname, { body, service = createService(), url } = {}) {
  const recorder = createRecorder();
  const handled = await handleWebUiSubscriptionAggregatorRoutes(
    { url: url || pathname },
    {},
    method,
    pathname,
    {
      subscriptionAggregatorService: service,
      writeJson: recorder.writeJson,
      readRequestBody: async () => Buffer.from(body === undefined ? '' : JSON.stringify(body))
    }
  );
  return { handled, service, ...(recorder.writes[0] || {}) };
}

test('aggregator routes ignore unrelated paths', async () => {
  const result = await call('GET', '/v0/webui/toolkit/proxy-pool/nodes');
  assert.equal(result.handled, false);
});

test('aggregator routes dispatch profile operations', async () => {
  assert.equal((await call('GET', PREFIX)).status, 200);
  const saved = await call('POST', `${PREFIX}/profiles`, { body: { name: '甲' } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.service.calls[0], ['saveProfile', { name: '甲' }]);
  const rotated = await call('POST', `${PREFIX}/profiles/agg_1/token`);
  assert.deepEqual(rotated.service.calls[0], ['rotate', 'agg_1']);
  const preview = await call('GET', `${PREFIX}/profiles/agg_1/preview`, { url: `${PREFIX}/profiles/agg_1/preview?format=sing-box` });
  assert.deepEqual(preview.service.calls[0], ['preview', 'agg_1', 'sing-box']);
  assert.equal((await call('DELETE', `${PREFIX}/profiles/agg_x`)).status, 404);
});

test('aggregator routes dispatch source operations and map upstream failures', async () => {
  const sync = await call('POST', `${PREFIX}/sources/sub_a/sync`);
  assert.equal(sync.status, 502);
  const all = await call('POST', `${PREFIX}/sources/sync`, { body: {} });
  assert.deepEqual(all.service.calls[0], ['syncSources', []]);
  const removed = await call('DELETE', `${PREFIX}/sources/sub_a`);
  assert.deepEqual(removed.service.calls[0], ['deleteSource', 'sub_a']);
  const created = await call('POST', `${PREFIX}/sources`, { body: { name: 'x', url: 'https://x.example' } });
  assert.deepEqual(created.service.calls[0], ['saveSource', { name: 'x', url: 'https://x.example' }]);
});

test('aggregator routes turn validation exceptions into 422', async () => {
  const service = createService({
    saveProfile: () => {
      const error = new Error('invalid_aggregator_pattern_include');
      error.code = 'invalid_aggregator_pattern';
      throw error;
    }
  });
  const result = await call('POST', `${PREFIX}/profiles`, { body: {}, service });
  assert.equal(result.status, 422);
  assert.equal(result.payload.error, 'invalid_aggregator_pattern');
});

test('public subscription route serves rendered content by token without WebUI auth', async () => {
  const token = 'a'.repeat(43);
  const seen = [];
  const service = {
    serveSubscription: async (value, request) => {
      seen.push([value, request]);
      return { ok: true, status: 200, headers: { 'Content-Type': 'text/yaml' }, body: 'proxies: []' };
    }
  };
  const res = createRes();
  const handled = await handleAggregatedSubscriptionRequest({
    req: { headers: { 'user-agent': 'clash-verge' } },
    res,
    method: 'GET',
    pathname: `/sub/${token}`,
    url: new URL(`http://h/sub/${token}?target=sing-box`),
    service
  });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'proxies: []');
  assert.deepEqual(seen, [[token, { target: 'sing-box', userAgent: 'clash-verge' }]]);
});

test('public subscription route hides unknown or malformed tokens behind 404', async () => {
  const service = { serveSubscription: async () => ({ ok: false, status: 404 }) };
  const malformed = createRes();
  await handleAggregatedSubscriptionRequest({ req: { headers: {} }, res: malformed, method: 'GET', pathname: '/sub/../x', service });
  assert.equal(malformed.statusCode, 404);
  const unknown = createRes();
  await handleAggregatedSubscriptionRequest({ req: { headers: {} }, res: unknown, method: 'GET', pathname: `/sub/${'b'.repeat(43)}`, url: new URL('http://h/'), service });
  assert.equal(unknown.statusCode, 404);
  const post = createRes();
  await handleAggregatedSubscriptionRequest({ req: { headers: {} }, res: post, method: 'POST', pathname: `/sub/${'b'.repeat(43)}`, service });
  assert.equal(post.statusCode, 405);
  assert.equal(await handleAggregatedSubscriptionRequest({ req: {}, res: createRes(), method: 'GET', pathname: '/v1/models', service }), false);
});
