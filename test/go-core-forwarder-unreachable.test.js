'use strict';

// Go 重启窗口：转发器手上的端口已不再监听。连接被拒时 Go 什么都没收到，
// 已缓冲请求体的请求交还 Node；连接建立后才出错的请求仍按 503 失败关闭（不重放）。

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { writeJson } = require('../lib/server/http-utils');
const { createGoCoreGatewayForwarder } = require('../lib/server/go-core-gateway-forwarder');
const { compileRouteTable, loadRouteOwnershipManifest } = require('../lib/server/go-core-route-ownership');
const { readRequestBody } = require('../lib/server/http-utils-utils');

const CLIENT_KEY = 'node-public-client-key';
const routeTable = compileRouteTable(loadRouteOwnershipManifest());

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

async function closedPort() {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function startNode(t, goPort, { buffered = true } = {}) {
  const nodeBodies = [];
  const fallbacks = [];
  const forwarder = createGoCoreGatewayForwarder({
    routeTable,
    requiredClientKey: CLIENT_KEY,
    writeJson,
    agent: new http.Agent({ keepAlive: false }),
    entryIds: new Set(['gateway.openai.chat_completions']),
    getTarget: () => ({ host: '127.0.0.1', port: goPort, clientKey: 'go-key' }),
    needsRequestModel: () => buffered,
    deferToNode: () => false,
    onUnavailableFallback: (event) => fallbacks.push(event)
  });
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (await forwarder.tryHandleHttp(req, res, { method: req.method, pathname, requestId: 'req-restart' })) return;
    nodeBodies.push((await readRequestBody(req)).toString('utf8'));
    writeJson(res, 200, { ok: true, handledBy: 'node' });
  });
  const port = await listen(server);
  t.after(() => close(server));
  const post = (payload) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, agent: false, method: 'POST', path: '/v1/chat/completions',
      headers: { authorization: `Bearer ${CLIENT_KEY}`, 'content-type': 'application/json' }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(payload));
  });
  return { post, nodeBodies, fallbacks };
}

test('a refused Go connection hands a buffered request back to Node instead of 503', async (t) => {
  const node = await startNode(t, await closedPort());
  const payload = { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] };
  const response = await node.post(payload);
  assert.equal(response.status, 200, response.body);
  assert.match(response.body, /handledBy/);
  assert.deepEqual(node.nodeBodies, [JSON.stringify(payload)], 'Node 读到的是原样缓冲的请求体');
  assert.deepEqual(node.fallbacks, [{ entryId: 'gateway.openai.chat_completions', requestId: 'req-restart', code: 'ECONNREFUSED' }]);
});

test('a Go connection that fails after it was established still fails closed with 503', async (t) => {
  const go = http.createServer((req) => req.socket.destroy());
  const goPort = await listen(go);
  t.after(() => close(go));
  const node = await startNode(t, goPort);
  const response = await node.post({ model: 'gpt-5.5', messages: [] });
  assert.equal(response.status, 503);
  assert.match(response.body, /go_core_unavailable/);
  assert.deepEqual(node.nodeBodies, [], 'Go 可能已收到请求，不交还 Node');
});

test('an unbuffered (streamed) request cannot be handed back and keeps the 503', async (t) => {
  const node = await startNode(t, await closedPort(), { buffered: false });
  const response = await node.post({ model: 'gpt-5.5', messages: [] });
  assert.equal(response.status, 503);
  assert.deepEqual(node.nodeBodies, []);
});
