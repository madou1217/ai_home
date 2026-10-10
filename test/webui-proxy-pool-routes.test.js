'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { errorStatus, handleWebUiProxyPoolRoutes } = require('../lib/server/webui-proxy-pool-routes');

const PREFIX = '/v0/webui/toolkit/proxy-pool';

function createMockReqRes(method, url, body = null) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = {};
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = { ...this.headers, ...headers };
    },
    end(data) {
      this.body = data;
    }
  };
  process.nextTick(() => {
    if (body) req.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
    req.emit('end');
  });
  return { req, res };
}

async function call(method, url, { body, service }) {
  const pathname = url.split('?')[0];
  const { req, res } = createMockReqRes(method, url, body);
  const handled = await handleWebUiProxyPoolRoutes(req, res, method, pathname, { proxyPoolService: service });
  return { handled, status: res.statusCode, data: res.body ? JSON.parse(res.body) : null };
}

function createService() {
  const calls = [];
  return {
    calls,
    listNodes(filter) { calls.push(['listNodes', filter]); return { ok: true, total: 0, groups: [], nodes: [] }; },
    listGroups() { return { ok: true, groups: [] }; },
    async upsertGroup(input) { calls.push(['upsertGroup', input]); return { ok: true, applied: true, group: { id: 'group_a' } }; },
    async updateGroupPolicy(id, policy) { calls.push(['updateGroupPolicy', id, policy]); return { ok: true, applied: true }; },
    async deleteGroup(id) { calls.push(['deleteGroup', id]); return { ok: false, applied: false, error: 'proxy_group_not_found' }; },
    async importNodes(content, subscriptionId) { calls.push(['importNodes', content, subscriptionId]); return { ok: false, error: 'no_valid_proxy_nodes_found', count: 0 }; }
  };
}

test('proxy-pool routes serve the node list with group and protocol filters', async () => {
  const service = createService();
  const result = await call('GET', `${PREFIX}/nodes?group=US&protocol=vless`, { service });
  assert.equal(result.handled, true);
  assert.equal(result.status, 200);
  assert.deepEqual(service.calls, [['listNodes', { group: 'US', protocol: 'vless' }]]);
});

test('proxy-pool routes manage groups and map missing groups to 404', async () => {
  const service = createService();
  assert.equal((await call('GET', `${PREFIX}/groups`, { service })).status, 200);
  assert.equal((await call('POST', `${PREFIX}/groups`, { body: { name: '组' }, service })).status, 200);
  assert.equal((await call('POST', `${PREFIX}/groups/policy`, { body: { id: 'US', strategy: 'sticky' }, service })).status, 200);
  assert.equal((await call('POST', `${PREFIX}/groups/policy`, { body: {}, service })).status, 400);
  assert.equal((await call('DELETE', `${PREFIX}/groups/group_a`, { service })).status, 404);
  assert.deepEqual(service.calls.map((entry) => entry[0]), ['upsertGroup', 'updateGroupPolicy', 'deleteGroup']);
});

test('proxy-pool import route requires text content and reports parse failures as 422', async () => {
  const service = createService();
  assert.equal((await call('POST', `${PREFIX}/import`, { body: {}, service })).status, 400);
  const result = await call('POST', `${PREFIX}/import`, { body: { content: 'garbage' }, service });
  assert.equal(result.status, 422);
  assert.deepEqual(service.calls, [['importNodes', 'garbage', null]]);
});

test('retired core, routing, port, network and subscription routes are no longer handled here', async () => {
  const service = createService();
  for (const [method, path] of [
    ['GET', 'core'], ['POST', 'core/start'], ['GET', 'routing'], ['GET', 'dedicated-ports'],
    ['GET', 'network/status'], ['GET', 'outbound/failover'], ['GET', 'export'], ['GET', 'subscriptions'],
    ['POST', 'subscriptions/sync'], ['GET', 'protocols'], ['POST', 'nodes'], ['DELETE', 'nodes/x']
  ]) {
    const result = await call(method, `${PREFIX}/${path}`, { service });
    assert.equal(result.handled, false, `${method} ${path}`);
  }
});

test('proxy-pool errorStatus keeps validation, conflict and not-found codes distinct', () => {
  assert.equal(errorStatus('invalid_proxy_group_strategy'), 422);
  assert.equal(errorStatus('reserved_proxy_group_id'), 422);
  assert.equal(errorStatus('proxy_store_busy'), 409);
  assert.equal(errorStatus('group_node_not_found'), 404);
  assert.equal(errorStatus('proxy_import_content_required'), 400);
  assert.equal(errorStatus('proxy_store_write_failed'), 500);
});
