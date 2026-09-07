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
  const messages = [];
  upstream.on('upgrade', (req, socket, head) => {
    requests.push(req);
    const status = options.status || (options.reject || (options.aliasOnly && req.url !== '/v1/responses/ws') ? 404 : 0);
    if (status) return socket.end(`HTTP/1.1 ${status} Rejected\r\nContent-Length: 0\r\n\r\n`);
    if (options.stall || options.stallAlias) { socket.resume(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws);
      ws.on('message', (data, isBinary) => {
        messages.push({ data: data.toString(), isBinary });
        if (options.onMessage) options.onMessage(ws, data, isBinary);
        else ws.send(data, { binary: isBinary });
      });
    });
  });
  const baseUrl = await listen(upstream);
  const accounts = ['first', 'second'].map(accountRef => ({
    accountRef, accessToken: `${accountRef}-key`, openaiBaseUrl: baseUrl + '/v1',
    upstreamAccountId: `${accountRef}-oauth-id`
  }));
  const activity = [];
  const gateway = http.createServer();
  const gatewaySockets = new Set();
  gateway.on('connection', socket => {
    gatewaySockets.add(socket);
    socket.once('close', () => gatewaySockets.delete(socket));
  });
  gateway.on('upgrade', (req, socket, head) => handleCodexResponsesWebSocket({
    req, socket, head, state: { accounts: { codex: accounts }, cursors: {} }, options: {}
  }, {
    chooseAccount: pool => pool[0], isLoopbackUrl: () => false,
    handshakeTimeoutMs: options.handshakeTimeoutMs || (options.stall || options.stallAlias ? 30 : 1000),
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
    for (const socket of gatewaySockets) socket.destroy();
    upstream.closeAllConnections();
    gateway.closeAllConnections();
    await Promise.all([new Promise(resolve => upstream.close(resolve)), new Promise(resolve => gateway.close(resolve))]);
  });
  return { gatewayUrl, requests, messages, activity, wss, upstream, upstreamSockets };
}

for (const aliasOnly of [false, true]) {
  test(`Responses WS pins the account and preserves frames via ${aliasOnly ? '404 alias' : 'standard path'}`, async t => {
    const f = await fixture(t, { aliasOnly });
    const client = new WebSocket(f.gatewayUrl, { headers: {
      authorization: 'Bearer client-key', 'x-account-ref': 'second',
      'openai-beta': 'responses_websockets=2026-02-06',
      'x-codex-turn-state': 'turn-state', 'chatgpt-account-id': 'untrusted-id',
      cookie: 'must-not-forward'
    } });
    t.after(() => client.terminate());
    await once(client, 'open');
    assert.deepEqual(f.requests.map(req => req.url), aliasOnly
      ? ['/v1/responses', '/v1/responses/ws'] : ['/v1/responses']);
    for (const req of f.requests) {
      assert.equal(req.headers.authorization, 'Bearer second-key');
      assert.equal(req.headers['chatgpt-account-id'], 'second-oauth-id');
      assert.equal(req.headers['openai-beta'], 'responses_websockets=2026-02-06');
      assert.equal(req.headers['x-codex-turn-state'], 'turn-state');
      assert.equal(req.headers.cookie, undefined);
      assert.equal(req.headers['x-account-ref'], undefined);
    }
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
}

for (const scenario of [{ name: 'unknown pinned account', ref: 'missing', expected: 503 },
  { name: 'both paths 404', reject: true, expected: 502, attempts: 2 },
  ...[401, 403, 429, 500, 302].map(status => ({ name: `upstream ${status}`, status, expected: 502 })),
  { name: 'stalled handshake', stall: true, expected: 502 },
  { name: 'stalled alias handshake', aliasOnly: true, stallAlias: true, expected: 502, attempts: 2 }]) {
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
    assert.equal(f.requests.length, scenario.ref ? 0 : (scenario.attempts || 1));
  });
}

test('Responses WS alias keeps multi-turn and tool frames on one connection without replay', async t => {
  const f = await fixture(t, { aliasOnly: true });
  const client = new WebSocket(f.gatewayUrl, { headers: { 'x-account-ref': 'second' } });
  t.after(() => client.terminate());
  await once(client, 'open');
  const turns = [
    { type: 'response.create', model: 'fixture', input: [{ role: 'user', content: 'hello' }] },
    { type: 'response.create', previous_response_id: 'first-response', input: [] },
    { type: 'response.create', previous_response_id: 'tool-response', input: [
      { type: 'function_call_output', call_id: 'tool-call', output: 'fixture-result' }
    ] }
  ];
  for (const turn of turns) {
    const received = once(client, 'message');
    client.send(JSON.stringify(turn));
    const [data, isBinary] = await received;
    assert.deepEqual(JSON.parse(data), turn);
    assert.equal(isBinary, false);
  }
  assert.deepEqual(f.messages.map(message => JSON.parse(message.data)), turns);
  assert.equal(f.requests.length, 2);
  const closed = once(client, 'close');
  client.close();
  await closed;
});

test('Responses WS does not reconnect after an application error with status 404', async t => {
  const f = await fixture(t, { onMessage: ws => {
    ws.send(JSON.stringify({ type: 'error', status: 404, error: { code: 'response_not_found' } }));
    ws.close(1000);
  } });
  const client = new WebSocket(f.gatewayUrl);
  t.after(() => client.terminate());
  await once(client, 'open');
  const received = once(client, 'message');
  const closed = once(client, 'close');
  client.send('{"type":"response.create"}');
  const [data] = await received;
  assert.equal(JSON.parse(data).status, 404);
  await closed;
  assert.equal(f.requests.length, 1);
  assert.equal(f.messages.length, 1);
});

test('Responses WS cancels a pending upstream handshake when the client disconnects', { timeout: 2000 }, async t => {
  const f = await fixture(t, { stall: true, handshakeTimeoutMs: 5000 });
  const attempted = once(f.upstream, 'upgrade');
  const client = new WebSocket(f.gatewayUrl);
  client.on('error', () => {});
  t.after(() => client.terminate());
  await attempted;
  const upstreamSocket = [...f.upstreamSockets][0];
  // The stalled fixture owns a half-open socket; consume the FIN and close it.
  upstreamSocket.once('end', () => upstreamSocket.destroy());
  const closedUpstream = once(upstreamSocket, 'close');
  client.terminate();
  await closedUpstream;
  assert.deepEqual(f.activity, ['begin:first', 'end:first']);
  assert.equal(f.requests.length, 1);
});
