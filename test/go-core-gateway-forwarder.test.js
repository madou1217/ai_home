'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { writeJson } = require('../lib/server/http-utils');
const { createGoCoreGatewayForwarder } = require('../lib/server/go-core-gateway-forwarder');
const { compileRouteTable, loadRouteOwnershipManifest } = require('../lib/server/go-core-route-ownership');

const CLIENT_KEY = 'node-public-client-key';
const GO_KEY = 'go-internal-client-key';
const routeTable = compileRouteTable(loadRouteOwnershipManifest());

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** 假 Go Core：记录收到的请求，按路径返回 JSON、SSE 或永不结束的响应。 */
async function startFakeGo(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const record = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      seen.push(record);
      if (req.url.startsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive', 'x-go-trace': 'yes' });
        res.write('event: message_start\ndata: {}\n\n');
        setTimeout(() => res.end('event: message_stop\ndata: {}\n\n'), 20);
        return;
      }
      if (req.url.startsWith('/v1/chat/completions')) {
        record.closed = new Promise((resolve) => res.on('close', resolve));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"partial":true}\n\n');
        return; // 永不结束：用于验证客户端断开时取消 Go 请求。
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
    });
  });
  server.on('upgrade', (req, socket) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, upgrade: true });
    if (req.headers.authorization !== `Bearer ${GO_KEY}`) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (data) => socket.write(Buffer.concat([Buffer.from('echo:'), data])));
    // http.Server 的升级 socket 允许半开；对端关闭后主动收尾，否则 server.close() 永远等不到它。
    socket.on('end', () => socket.end());
  });
  const port = await listen(server);
  t.after(() => close(server));
  return { port, seen };
}

async function startNodeHost(t, forwarderOptions) {
  const forwarder = createGoCoreGatewayForwarder({
    routeTable,
    requiredClientKey: CLIENT_KEY,
    writeJson,
    agent: new http.Agent({ keepAlive: false }),
    ...forwarderOptions
  });
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (forwarder.tryHandleHttp(req, res, { method: req.method, pathname, requestId: 'req-123' })) return;
    writeJson(res, 404, { ok: false, error: 'handled_by_node' });
  });
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (forwarder.tryHandleUpgrade(req, socket, head, { pathname, requestId: 'req-ws' })) return;
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
  });
  const port = await listen(server);
  t.after(() => close(server));
  return port;
}

function request(port, options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, agent: false, ...options }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('forwards a Go-owned streaming route with swapped credentials and without hop-by-hop headers', async (t) => {
  const go = await startFakeGo(t);
  const port = await startNodeHost(t, {
    entryIds: new Set(['gateway.anthropic.messages']),
    getTarget: () => ({ host: '127.0.0.1', port: go.port, clientKey: GO_KEY })
  });

  const response = await request(port, {
    method: 'POST',
    path: '/v1/v1/messages?beta=true',
    headers: {
      'x-api-key': CLIENT_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'keep-alive': 'timeout=5',
      'x-aih-request-id': 'spoofed'
    }
  }, '{"model":"claude"}');

  assert.equal(response.status, 200);
  assert.match(response.body, /message_start[\s\S]*message_stop/);
  assert.equal(response.headers['x-go-trace'], 'yes');
  const forwarded = go.seen[0];
  assert.equal(forwarded.url, '/v1/messages?beta=true');
  assert.equal(forwarded.body, '{"model":"claude"}');
  assert.equal(forwarded.headers.authorization, `Bearer ${GO_KEY}`);
  assert.equal(forwarded.headers['x-api-key'], undefined);
  assert.equal(forwarded.headers['keep-alive'], undefined);
  assert.equal(forwarded.headers['anthropic-version'], '2023-06-01');
  assert.equal(forwarded.headers['x-aih-request-id'], 'req-123');
});

test('routes that are not Go-owned stay with Node', async (t) => {
  const go = await startFakeGo(t);
  const port = await startNodeHost(t, {
    entryIds: new Set(['gateway.anthropic.messages']),
    getTarget: () => ({ host: '127.0.0.1', port: go.port, clientKey: GO_KEY })
  });

  const response = await request(port, { method: 'GET', path: '/v1/models', headers: { authorization: `Bearer ${CLIENT_KEY}` } });

  assert.equal(response.status, 404);
  assert.match(response.body, /handled_by_node/);
  assert.equal(go.seen.length, 0);
});

test('rejects bad client keys and account pins before contacting Go', async (t) => {
  const go = await startFakeGo(t);
  const port = await startNodeHost(t, {
    entryIds: new Set(['gateway.models.list']),
    getTarget: () => ({ host: '127.0.0.1', port: go.port, clientKey: GO_KEY })
  });

  const unauthorized = await request(port, { method: 'GET', path: '/v1/models', headers: { authorization: 'Bearer wrong' } });
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.body, /unauthorized_client/);

  const pinned = await request(port, {
    method: 'GET',
    path: '/v1/models',
    headers: { authorization: `Bearer ${CLIENT_KEY}`, 'x-account-ref': 'acct_0123456789abcdef0123' }
  });
  assert.equal(pinned.status, 501);
  assert.match(pinned.body, /go_core_capability_unsupported/);
  assert.equal(go.seen.length, 0);
});

test('fails closed with 503 when Go Core is not ready or unreachable, never falling back to Node', async (t) => {
  const notReady = await startNodeHost(t, { entryIds: new Set(['gateway.models.list']), getTarget: () => null });
  const first = await request(notReady, { method: 'GET', path: '/v1/models', headers: { authorization: `Bearer ${CLIENT_KEY}` } });
  assert.equal(first.status, 503);
  assert.match(first.body, /go_core_unavailable/);

  const closedServer = http.createServer();
  const closedPort = await listen(closedServer);
  await close(closedServer);
  const unreachable = await startNodeHost(t, {
    entryIds: new Set(['gateway.models.list']),
    getTarget: () => ({ host: '127.0.0.1', port: closedPort, clientKey: GO_KEY })
  });
  const second = await request(unreachable, { method: 'GET', path: '/v1/models', headers: { authorization: `Bearer ${CLIENT_KEY}` } });
  assert.equal(second.status, 503);
  assert.match(second.body, /go_core_unavailable/);
});

test('a client disconnect cancels the in-flight Go request', async (t) => {
  const go = await startFakeGo(t);
  const port = await startNodeHost(t, {
    entryIds: new Set(['gateway.openai.chat_completions']),
    getTarget: () => ({ host: '127.0.0.1', port: go.port, clientKey: GO_KEY })
  });

  await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      agent: false,
      headers: { authorization: `Bearer ${CLIENT_KEY}`, 'content-type': 'application/json' }
    }, (res) => {
      res.once('data', () => {
        req.destroy();
        resolve();
      });
    });
    req.on('error', () => {});
    req.on('response', () => {});
    req.once('error', reject);
    req.end('{}');
  });

  const timeout = new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error('Go request was not cancelled')), 2000).unref();
  });
  await Promise.race([go.seen[0].closed, timeout]);
});

test('splices a Go-owned WebSocket upgrade with swapped credentials', async (t) => {
  const go = await startFakeGo(t);
  const port = await startNodeHost(t, {
    entryIds: new Set(['gateway.openai.responses', 'gateway.openai.responses.websocket']),
    getTarget: () => ({ host: '127.0.0.1', port: go.port, clientKey: GO_KEY })
  });

  const echoed = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/v1/responses',
      agent: false,
      headers: {
        authorization: `Bearer ${CLIENT_KEY}`,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13'
      }
    });
    req.on('upgrade', (res, socket) => {
      assert.equal(res.statusCode, 101);
      socket.once('data', (data) => {
        socket.destroy();
        resolve(data.toString('utf8'));
      });
      socket.write('ping');
    });
    req.on('response', (res) => reject(new Error(`unexpected status ${res.statusCode}`)));
    req.on('error', reject);
    req.end();
  });

  assert.equal(echoed, 'echo:ping');
  const upgrade = go.seen.find((item) => item.upgrade);
  assert.equal(upgrade.headers.authorization, `Bearer ${GO_KEY}`);
  assert.equal(upgrade.headers.upgrade, 'websocket');
  assert.equal(upgrade.headers['sec-websocket-key'], 'dGhlIHNhbXBsZSBub25jZQ==');
  assert.equal(upgrade.headers['x-aih-request-id'], 'req-ws');
});
