'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const WebSocket = require('ws');
const { handleCodexResponsesWebSocket } = require('../lib/server/codex-responses-websocket');

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, options = {}) {
  const upstream = http.createServer();
  const wss = new WebSocket.Server({ noServer: true });
  const upstreamSockets = new Set();
  upstream.on('connection', socket => {
    upstreamSockets.add(socket);
    socket.once('close', () => upstreamSockets.delete(socket));
  });
  const requests = [];
  upstream.on('upgrade', (req, socket, head) => {
    requests.push(req);
    if (options.reject) return socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
    if (options.stall) return;
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws);
      ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
    });
  });
  const baseUrl = await listen(upstream);
  const accounts = ['first', 'second'].map(accountRef => ({
    accountRef, accessToken: `${accountRef}-key`, openaiBaseUrl: baseUrl + '/v1',
    upstreamAccountId: `${accountRef}-oauth-id`
  }));
  const activity = [];
  const gateway = http.createServer();
  gateway.on('upgrade', (req, socket, head) => handleCodexResponsesWebSocket({
    req, socket, head, state: { accounts: { codex: accounts }, cursors: {} }, options: {}
  }, {
    chooseAccount: pool => pool[0], isLoopbackUrl: () => false,
    handshakeTimeoutMs: options.stall ? 30 : 1000,
    accountActivity: {
      begin: (_provider, ref) => activity.push(`begin:${ref}`),
      end: (_provider, ref) => activity.push(`end:${ref}`)
    }
  }));
  const gatewayUrl = (await listen(gateway)).replace('http:', 'ws:') + '/v1/responses';
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    // closeAllConnections excludes sockets handed to the upgrade listener,
    // including the intentionally stalled handshake fixture.
    for (const socket of upstreamSockets) socket.destroy();
    upstream.closeAllConnections();
    gateway.closeAllConnections();
    await Promise.all([new Promise(resolve => upstream.close(resolve)), new Promise(resolve => gateway.close(resolve))]);
  });
  return { gatewayUrl, requests, activity, wss };
}

test('Responses WS pins the account, preserves protocol headers and both frame types', async t => {
  const f = await fixture(t);
  const client = new WebSocket(f.gatewayUrl, { headers: {
    authorization: 'Bearer client-key', 'x-account-ref': 'second',
    'openai-beta': 'responses_websockets=2026-02-06',
    'x-codex-turn-state': 'turn-state', 'chatgpt-account-id': 'untrusted-id',
    cookie: 'must-not-forward'
  } });
  t.after(() => client.terminate());
  await once(client, 'open');
  const req = f.requests[0];
  assert.equal(req.url, '/v1/responses');
  assert.equal(req.headers.authorization, 'Bearer second-key');
  assert.equal(req.headers['chatgpt-account-id'], 'second-oauth-id');
  assert.equal(req.headers['openai-beta'], 'responses_websockets=2026-02-06');
  assert.equal(req.headers['x-codex-turn-state'], 'turn-state');
  assert.equal(req.headers.cookie, undefined);
  for (const isBinary of [false, true]) {
    const received = once(client, 'message');
    client.send('{"type":"response.create"}', { binary: isBinary });
    const [data, binary] = await received;
    assert.equal(binary, isBinary);
    assert.equal(data.toString(), '{"type":"response.create"}');
  }
  const closed = once(client, 'close');
  [...f.wss.clients][0].close(1000, 'finished');
  const [code, reason] = await closed;
  assert.equal(code, 1000);
  assert.equal(reason.toString(), 'finished');
  assert.deepEqual(f.activity, ['begin:second', 'end:second']);
});

for (const scenario of [{ name: 'unknown pinned account', ref: 'missing', expected: 503 },
  { name: 'upstream 404', reject: true, expected: 502 },
  { name: 'stalled handshake', stall: true, expected: 502 }]) {
  test(`Responses WS fails cleanly on ${scenario.name}`, async t => {
    const f = await fixture(t, scenario);
    const client = new WebSocket(f.gatewayUrl, { headers: { 'x-account-ref': scenario.ref || 'first' } });
    t.after(() => client.terminate());
    client.on('error', () => {});
    const status = await new Promise(resolve => client.once('unexpected-response', (req, res) => {
      res.resume();
      res.once('end', () => { req.destroy(); resolve(res.statusCode); });
    }));
    assert.equal(status, scenario.expected);
    assert.deepEqual(f.activity, scenario.ref ? [] : ['begin:first', 'end:first']);
    if (scenario.ref) assert.equal(f.requests.length, 0);
  });
}
