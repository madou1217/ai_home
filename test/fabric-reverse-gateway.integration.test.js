'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const WebSocket = require('ws');

const { connectFabricBroker } = require('../lib/cli/services/fabric/broker-connect');
const { proxyFabricGatewayRequest } = require('../lib/server/fabric-gateway-fallback');
const {
  handleFabricBrokerControlUpgrade
} = require('../lib/server/fabric-broker-router');
const {
  createFabricBrokerSessionRegistry
} = require('../lib/server/fabric-broker-session-registry');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition_timeout');
}

test('public Server uses an outbound local Server connection as its automatic gateway', async (t) => {
  let connection = null;
  let localServer = null;
  let publicServer = null;
  t.after(async () => {
    if (connection) await connection.close();
    if (publicServer) {
      if (typeof publicServer.closeAllConnections === 'function') publicServer.closeAllConnections();
      await closeServer(publicServer);
    }
    if (localServer) {
      if (typeof localServer.closeAllConnections === 'function') localServer.closeAllConnections();
      await closeServer(localServer);
    }
  });
  const localRequests = [];
  let gatewayAvailable = 0;
  localServer = http.createServer(async (req, res) => {
    if (req.url === '/v0/fabric/descriptor') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        ok: true,
        result: {
          server: { name: 'Local Server 2' },
          capabilities: {
            gateway: {
              protocolVersion: 1,
              enabled: gatewayAvailable > 0,
              accounts: 1,
              available: gatewayAvailable,
              models: ['gpt-5.5']
            }
          }
        }
      }));
      return;
    }
    if (req.url === '/v1/responses' && req.method === 'POST') {
      const body = await readBody(req);
      localRequests.push({
        authorization: req.headers.authorization,
        hop: req.headers['x-aih-gateway-hop'],
        body: body.toString('utf8')
      });
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache'
      });
      res.write('data: {"type":"response.output_text.delta","delta":"pong"}\n\n');
      res.end('data: [DONE]\n\n');
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const localAddress = await listen(localServer);

  const registry = createFabricBrokerSessionRegistry();
  publicServer = http.createServer(async (req, res) => {
    if (req.url === '/v1/responses' && req.method === 'POST') {
      const bodyBuffer = await readBody(req);
      await proxyFabricGatewayRequest({
        req,
        res,
        method: req.method,
        pathname: '/v1/responses',
        options: { provider: 'auto' },
        state: {
          accounts: { codex: [], gemini: [], claude: [], agy: [], opencode: [] }
        },
        model: 'gpt-5.5',
        bodyBuffer
      }, {
        fabricBrokerSessionRegistry: registry
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  publicServer.on('upgrade', (req, socket, head) => {
    handleFabricBrokerControlUpgrade({
      req,
      socket,
      head,
      deps: {
        WebSocket,
        fabricBrokerSessionRegistry: registry,
        requiredManagementKey: 'public-management-key'
      }
    });
  });
  const publicAddress = await listen(publicServer);

  connection = await connectFabricBroker({
    brokerUrl: `http://127.0.0.1:${publicAddress.port}`,
    serverId: 'local-server-2',
    managementKey: 'public-management-key',
    localUrl: `http://127.0.0.1:${localAddress.port}`,
    localClientKey: 'local-client-key',
    connectTimeoutMs: 3000,
    requestTimeoutMs: 3000,
    heartbeatMs: 1000
  }, { WebSocket });

  await waitFor(() => registry.listBrokerServers()[0]?.capabilities?.gateway);
  assert.equal(registry.listBrokerServers()[0].capabilities.gateway.available, 0);
  gatewayAvailable = 1;
  await waitFor(() => registry.listBrokerServers()[0]?.capabilities?.gateway?.available === 1);

  const response = await fetch(`http://127.0.0.1:${publicAddress.port}/v1/responses`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer public-client-key',
      'content-type': 'application/json',
      accept: 'text/event-stream'
    },
    body: JSON.stringify({ model: 'gpt-5.5', input: 'ping' })
  });
  const responseText = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-aih-fabric-broker-server-id'), 'local-server-2');
  assert.equal(responseText.includes('pong'), true);
  assert.equal(localRequests.length, 1);
  assert.equal(localRequests[0].authorization, 'Bearer local-client-key');
  assert.equal(localRequests[0].hop, '1');
  assert.equal(localRequests[0].body.includes('ping'), true);
});
