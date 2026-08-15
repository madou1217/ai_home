'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { handleWebUiProxyPoolRoutes } = require('../lib/server/webui-proxy-pool-routes');

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
    if (body) {
      req.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.emit('end');
  });

  return { req, res };
}

test('handleWebUiProxyPoolRoutes responds to GET /v0/webui/toolkit/proxy-pool/nodes', async () => {
  const { req, res } = createMockReqRes('GET', '/v0/webui/toolkit/proxy-pool/nodes');
  const handled = await handleWebUiProxyPoolRoutes(req, res, 'GET', '/v0/webui/toolkit/proxy-pool/nodes', {});
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.nodes));
});

test('handleWebUiProxyPoolRoutes responds to GET /v0/webui/toolkit/proxy-pool/subscriptions', async () => {
  const { req, res } = createMockReqRes('GET', '/v0/webui/toolkit/proxy-pool/subscriptions');
  const handled = await handleWebUiProxyPoolRoutes(req, res, 'GET', '/v0/webui/toolkit/proxy-pool/subscriptions', {});
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.subscriptions));
});

test('handleWebUiProxyPoolRoutes responds to GET /v0/webui/toolkit/proxy-pool/routing', async () => {
  const { req, res } = createMockReqRes('GET', '/v0/webui/toolkit/proxy-pool/routing');
  const handled = await handleWebUiProxyPoolRoutes(req, res, 'GET', '/v0/webui/toolkit/proxy-pool/routing', {});
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, true);
  assert.ok(data.routing);
});

test('handleWebUiProxyPoolRoutes responds to GET /v0/webui/toolkit/proxy-pool/dedicated-ports', async () => {
  const { req, res } = createMockReqRes('GET', '/v0/webui/toolkit/proxy-pool/dedicated-ports');
  const handled = await handleWebUiProxyPoolRoutes(req, res, 'GET', '/v0/webui/toolkit/proxy-pool/dedicated-ports', {});
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, true);
  assert.ok(data.config);
});
