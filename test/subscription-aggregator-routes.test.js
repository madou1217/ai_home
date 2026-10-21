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
    startSourceSync: (ids) => { calls.push(['startSourceSync', ids]); return { ok: true, job: { id: 'job_all' } }; },
    startSourceSyncOne: (id) => {
      calls.push(['startSourceSyncOne', id]);
      return id === 'sub_a' ? { ok: true, job: { id: 'job_one' } } : { ok: false, error: 'subscription_not_found' };
    },
    setSourceEnabled: async (id, enabled) => {
      calls.push(['setSourceEnabled', id, enabled]);
      return id === 'sub_a' ? { ok: true, subscription: { id, enabled } } : { ok: false, error: 'subscription_not_found' };
    },
    scanLocalSources: () => { calls.push(['scanLocalSources']); return { ok: true, clients: [], candidates: [{ id: 'clash-verge:https://a' }] }; },
    importLocalSources: async (ids) => { calls.push(['importLocalSources', ids]); return { ok: true, imported: [], skipped: [], job: null }; },
    ...overrides
  };
}

/** SSE 响应替身：记下每一帧 data 的 JSON。 */
function createStreamRes() {
  const chunks = [];
  const handlers = {};
  return {
    statusCode: 0,
    headers: {},
    destroyed: false,
    writableEnded: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    on(event, handler) {
      handlers[event] = handler;
    },
    close() {
      this.destroyed = true;
      if (handlers.close) handlers.close();
    },
    frames() {
      return chunks.filter((chunk) => chunk.startsWith('data: ')).map((chunk) => JSON.parse(chunk.slice(6)));
    }
  };
}

const PREFIX = '/v0/webui/toolkit/subscription-aggregator';

async function call(method, pathname, { body, service = createService(), url, bodyLimits = [], remoteAddress = '127.0.0.1' } = {}) {
  const recorder = createRecorder();
  const handled = await handleWebUiSubscriptionAggregatorRoutes(
    { url: url || pathname, socket: { remoteAddress } },
    {},
    method,
    pathname,
    {
      subscriptionAggregatorService: service,
      writeJson: recorder.writeJson,
      readRequestBody: async (_req, options) => {
        bodyLimits.push(options.maxBytes);
        return Buffer.from(body === undefined ? '' : JSON.stringify(body));
      }
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

test('aggregator routes serve draft node lists and rule tests', async () => {
  const service = createService({
    previewNodes: (input) => { service.calls.push(['previewNodes', input]); return { ok: true, nodes: [] }; },
    testRoute: async (input) => {
      service.calls.push(['testRoute', input]);
      if (input.target === 'bad host') throw Object.assign(new Error('invalid_route_target'), { code: 'invalid_route_target' });
      return { ok: true, rule: { origin: { kind: 'final' } } };
    }
  });
  const nodes = await call('POST', `${PREFIX}/profiles/nodes`, { body: { filter: { include: '日本' } }, service });
  assert.equal(nodes.status, 200);
  assert.deepEqual(service.calls.at(-1), ['previewNodes', { filter: { include: '日本' } }]);
  const traced = await call('POST', `${PREFIX}/profiles/test-route`, { body: { profile: { name: 'p' }, target: 'x.com' }, service });
  assert.equal(traced.status, 200);
  assert.deepEqual(service.calls.at(-1), ['testRoute', { profile: { name: 'p' }, target: 'x.com' }]);
  const invalid = await call('POST', `${PREFIX}/profiles/test-route`, { body: { target: 'bad host' }, service });
  assert.deepEqual([invalid.status, invalid.payload.error], [422, 'invalid_route_target']);
});

test('aggregator routes start sync jobs asynchronously instead of waiting for every source', async () => {
  // 单个与批量同步都只是「开始任务」：立刻 202，结果走 /sources/sync/watch。
  const one = await call('POST', `${PREFIX}/sources/sub_a/sync`);
  assert.deepEqual([one.status, one.payload.job.id, one.service.calls[0]], [202, 'job_one', ['startSourceSyncOne', 'sub_a']]);
  const all = await call('POST', `${PREFIX}/sources/sync`, { body: {} });
  assert.deepEqual([all.status, all.service.calls[0]], [202, ['startSourceSync', []]]);
  const some = await call('POST', `${PREFIX}/sources/sync`, { body: { ids: ['sub_a', 7] } });
  assert.deepEqual(some.service.calls[0], ['startSourceSync', ['sub_a', '7']]);
  const missing = await call('POST', `${PREFIX}/sources/sub_x/sync`);
  assert.equal(missing.status, 404);
  const empty = await call('POST', `${PREFIX}/sources/sync`, {
    body: {},
    service: createService({ startSourceSync: () => ({ ok: false, error: 'subscription_source_required' }) })
  });
  assert.equal(empty.status, 409);
});

test('aggregator routes toggle a source on and off', async () => {
  const off = await call('POST', `${PREFIX}/sources/sub_a/enabled`, { body: { enabled: false } });
  assert.deepEqual([off.status, off.service.calls[0]], [200, ['setSourceEnabled', 'sub_a', false]]);
  const on = await call('POST', `${PREFIX}/sources/sub_a/enabled`, { body: { enabled: true } });
  assert.deepEqual(on.service.calls[0], ['setSourceEnabled', 'sub_a', true]);
  // 只认显式的 true：缺省 / 字符串都按停用处理之外的「不启用」，避免误把停用的源打开。
  const junk = await call('POST', `${PREFIX}/sources/sub_a/enabled`, { body: { enabled: 'yes' } });
  assert.deepEqual(junk.service.calls[0], ['setSourceEnabled', 'sub_a', false]);
  assert.equal((await call('POST', `${PREFIX}/sources/sub_x/enabled`, { body: { enabled: true } })).status, 404);
});

test('aggregator routes only scan and import local client configs for loopback callers', async () => {
  const scanned = await call('GET', `${PREFIX}/local-sources`, { remoteAddress: '127.0.0.1' });
  assert.deepEqual([scanned.status, scanned.payload.candidates.length], [200, 1]);
  const remote = await call('GET', `${PREFIX}/local-sources`, { remoteAddress: '203.0.113.9' });
  assert.deepEqual([remote.status, remote.payload.error], [403, 'local_scan_requires_local_request']);
  const imported = await call('POST', `${PREFIX}/local-sources/import`, { remoteAddress: '::1', body: { ids: ['clash-verge:https://a'] } });
  assert.deepEqual([imported.status, imported.service.calls[0]], [200, ['importLocalSources', ['clash-verge:https://a']]]);
  const remoteImport = await call('POST', `${PREFIX}/local-sources/import`, { remoteAddress: '203.0.113.9', body: { ids: ['x'] } });
  assert.equal(remoteImport.status, 403);
  assert.deepEqual(remoteImport.service.calls, [], 'remote callers never reach the importer');
});

test('aggregator sync watch streams a snapshot then every job change', async () => {
  const listeners = new Set();
  const service = createService({
    listSourceSyncJobs: () => ({ sources: {}, jobs: [{ id: 'job_old' }] }),
    onSourceSyncChange: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }
  });
  const res = createStreamRes();
  const req = { on() {}, socket: { remoteAddress: '127.0.0.1' }, url: `${PREFIX}/sources/sync/watch` };
  const handled = await handleWebUiSubscriptionAggregatorRoutes(req, res, 'GET', `${PREFIX}/sources/sync/watch`, { subscriptionAggregatorService: service });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /text\/event-stream/);
  assert.deepEqual(res.frames(), [{ type: 'snapshot', sources: {}, jobs: [{ id: 'job_old' }] }]);
  for (const listener of listeners) listener({ type: 'job', job: { id: 'job_new', status: 'running' } });
  assert.deepEqual(res.frames().at(-1), { type: 'job', job: { id: 'job_new', status: 'running' } });
  // 第二个订阅者复用同一个服务监听，不会给服务挂两份。
  await handleWebUiSubscriptionAggregatorRoutes(req, createStreamRes(), 'GET', `${PREFIX}/sources/sync/watch`, { subscriptionAggregatorService: service });
  assert.equal(listeners.size, 1);
  res.close();
});

test('aggregator routes dispatch source operations and map upstream failures', async () => {
  const removed = await call('DELETE', `${PREFIX}/sources/sub_a`);
  assert.deepEqual(removed.service.calls[0], ['deleteSource', 'sub_a']);
  // 保存订阅源的请求可以带本地订阅内容，读取上限比其它接口大。
  const bodyLimits = [];
  const created = await call('POST', `${PREFIX}/sources`, { body: { name: 'x', url: 'https://x.example' }, bodyLimits });
  assert.deepEqual(created.service.calls[0], ['saveSource', { name: 'x', url: 'https://x.example' }]);
  await call('POST', `${PREFIX}/profiles`, { body: { name: 'p' }, bodyLimits });
  assert.deepEqual(bodyLimits, [3 * 1024 * 1024, 256 * 1024]);
  const tooLarge = await call('POST', `${PREFIX}/sources`, {
    body: { name: 'x', kind: 'local', content: 'x' },
    service: createService({ saveSource: async () => { const error = new Error('too large'); error.code = 'subscription_content_too_large'; throw error; } })
  });
  assert.equal(tooLarge.status, 422);
});

test('aggregator routes preview local content with the large body limit', async () => {
  const service = createService({
    previewSource: (input) => {
      service.calls.push(['previewSource', input]);
      return input.content ? { ok: true, format: 'uri', nodes: [] } : { ok: false, error: 'invalid_subscription_content' };
    }
  });
  const bodyLimits = [];
  const preview = await call('POST', `${PREFIX}/sources/preview`, { body: { content: 'trojan://x' }, service, bodyLimits });
  assert.deepEqual([preview.status, service.calls.at(-1)], [200, ['previewSource', { content: 'trojan://x' }]]);
  assert.deepEqual(bodyLimits, [3 * 1024 * 1024]);
  assert.equal((await call('POST', `${PREFIX}/sources/preview`, { body: {}, service })).status, 422);
});

test('aggregator routes serve the node tools', async () => {
  const calls = [];
  const nodeTools = {
    sourceNodes: (id) => { calls.push(['sourceNodes', id]); return id === 'sub_a' ? { ok: true, nodes: [] } : { ok: false, error: 'subscription_not_found' }; },
    measureLatency: async (id, options) => { calls.push(['measureLatency', id, options]); return { ok: true, results: {} }; },
    probe: async (input) => {
      calls.push(['probe', input]);
      if (input.host === '169.254.169.254') throw Object.assign(new Error('blocked'), { code: 'probe_address_blocked' });
      return { ok: true, ports: [] };
    },
    parseNodes: (input) => { calls.push(['parseNodes', input]); return { ok: true, nodes: [] }; },
    allNodes: () => { calls.push(['allNodes']); return { ok: true, nodes: [] }; },
    setNodeChain: (nodeId, chain) => {
      calls.push(['setNodeChain', nodeId, chain]);
      return nodeId === 'n_a' ? { ok: true, node: { id: nodeId, name: 'A', chain } } : { ok: false, error: 'proxy_node_not_found' };
    }
  };
  const service = createService({ nodeTools });
  assert.equal((await call('GET', `${PREFIX}/sources/sub_a/nodes`, { service })).status, 200);
  assert.equal((await call('GET', `${PREFIX}/sources/sub_x/nodes`, { service })).status, 404);
  await call('POST', `${PREFIX}/sources/sub_a/latency`, { body: { fresh: true }, service });
  assert.deepEqual(calls.at(-1), ['measureLatency', 'sub_a', { fresh: true }]);
  await call('POST', `${PREFIX}/probe`, { body: { host: 'a.example', ports: [443] }, service });
  assert.deepEqual(calls.at(-1), ['probe', { host: 'a.example', ports: [443] }]);
  assert.equal((await call('POST', `${PREFIX}/probe`, { body: { host: '169.254.169.254' }, service })).status, 422);
  const bodyLimits = [];
  await call('POST', `${PREFIX}/nodes/parse`, { body: { content: 'trojan://x' }, service, bodyLimits });
  assert.deepEqual([calls.at(-1), bodyLimits], [['parseNodes', { content: 'trojan://x' }], [3 * 1024 * 1024]]);
  // 链式代理：选前置要的节点清单，以及按节点保存前置。
  assert.equal((await call('GET', `${PREFIX}/nodes`, { service })).status, 200);
  assert.deepEqual(calls.at(-1), ['allNodes']);
  const chained = await call('POST', `${PREFIX}/nodes/chain`, { body: { nodeId: 'n_a', chain: 'n_b' }, service });
  assert.deepEqual([chained.status, calls.at(-1)], [200, ['setNodeChain', 'n_a', 'n_b']]);
  assert.equal((await call('POST', `${PREFIX}/nodes/chain`, { body: { nodeId: 'n_x', chain: '' }, service })).status, 404);
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
  // 请求没有 Host 头时拿不到 origin，渲染里依赖绝对地址的部分（托管配置、转换规则集）留空。
  // relay 三态：没写就是 undefined（交给服务层按客户端与本机判断）；remoteAddress 来自 socket。
  assert.deepEqual(seen, [[token, {
    target: 'sing-box', view: '', userAgent: 'clash-verge', origin: '', relay: undefined, remoteAddress: ''
  }]]);
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
