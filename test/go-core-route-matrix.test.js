'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  compileRouteTable,
  loadRouteOwnershipManifest,
  classifyRoute
} = require('../lib/server/go-core-route-ownership');
const { createGoCoreGatewayForwarder } = require('../lib/server/go-core-gateway-forwarder');

const manifest = loadRouteOwnershipManifest();
const routeTable = compileRouteTable(manifest);
const OWNED = new Set([
  'gateway.openai.responses',
  'gateway.openai.responses.websocket'
]);

function request({ transport = 'http', headers = {}, body = '{"model":"gpt-6.1-sol"}' } = {}) {
  const req = new EventEmitter();
  req.method = transport === 'websocket' ? 'GET' : 'POST';
  req.url = '/v1/responses';
  req.headers = headers;
  req.complete = false;
  req.resume = () => {};
  req.emitBody = () => {
    if (transport === 'websocket') return;
    req.emit('data', Buffer.from(body));
    req.emit('end');
  };
  return req;
}

test('route ownership matrix keeps HTTP and WebSocket responses paired', () => {
  assert.equal(classifyRoute(routeTable, {
    transport: 'http', method: 'POST', pathname: '/v1/responses'
  }), 'gateway.openai.responses');
  assert.equal(classifyRoute(routeTable, {
    transport: 'websocket', method: 'GET', pathname: '/v1/responses'
  }), 'gateway.openai.responses.websocket');
  assert.equal(classifyRoute(routeTable, {
    transport: 'http', method: 'GET', pathname: '/v1/responses'
  }), '');
});

test('custom relay is handed back to Node for pinned and unpinned HTTP requests', async () => {
  let targetCalls = 0;
  const forwarder = createGoCoreGatewayForwarder({
    routeTable,
    entryIds: OWNED,
    requiredClientKey: 'client-key',
    getTarget: () => { targetCalls += 1; return { host: '127.0.0.1', port: 19527, clientKey: 'go-key' }; },
    needsRequestModel: () => true,
    deferToNode: () => true,
    maxRequestBodyBytes: 1024 * 1024,
    writeJson: () => {}
  });

  for (const headers of [
    { authorization: 'Bearer client-key', 'x-account-ref': 'relay-account' },
    { authorization: 'Bearer client-key' }
  ]) {
    const req = request({ headers });
    const resultPromise = forwarder.tryHandleHttp(req, {}, {
      pathname: '/v1/responses',
      method: 'POST',
      requestId: 'matrix-http'
    });
    req.emitBody();
    assert.equal(await resultPromise, false);
  }
  assert.equal(targetCalls, 0);
});

test('custom relay is handed back to Node for WebSocket responses', () => {
  let targetCalls = 0;
  const forwarder = createGoCoreGatewayForwarder({
    routeTable,
    entryIds: OWNED,
    requiredClientKey: 'client-key',
    getTarget: () => { targetCalls += 1; return { host: '127.0.0.1', port: 19527, clientKey: 'go-key' }; },
    deferToNode: () => true,
    writeJson: () => {}
  });

  const req = request({
    transport: 'websocket',
    headers: { authorization: 'Bearer client-key', 'x-account-ref': 'relay-account' }
  });
  assert.equal(forwarder.tryHandleUpgrade(req, {}, Buffer.alloc(0), {
    pathname: '/v1/responses',
    requestId: 'matrix-ws'
  }), false);
  assert.equal(targetCalls, 0);
});
