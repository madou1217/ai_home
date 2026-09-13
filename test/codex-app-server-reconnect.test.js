'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const WebSocket = require('ws');
const { createAppServerClient } = require('../lib/server/codex-app-server-json-rpc-client');

test('recovery pages use the current socket while live events and public commands wait', async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const order = [];
  let historyPort;
  const f = await fixture(t, (ws, message) => {
    order.push(message.method);
    if (message.method === 'thread/resume') {
      reply(ws, message, { thread: { id: 'thread-1', turns: [] } });
      ws.send(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-1' } }));
    } else reply(ws, message, { data: [] });
  });
  f.client.bindTurn('thread-1', {
    async onReconnectResume(_response, client) {
      historyPort = client;
      assert.throws(() => client.request('turn/start', { threadId: 'thread-1' }), /codex_recovery_request_invalid/);
      assert.throws(() => client.request('thread/turns/list', { threadId: 'foreign' }), /codex_recovery_request_invalid/);
      await client.request('thread/turns/list', { threadId: 'thread-1', itemsView: 'full' });
      order.push('page-read');
      await gate.promise;
      order.push('history-persisted');
    },
    onNotification() { order.push('live'); }
  });
  await disconnect(f);
  await waitFor(() => order.includes('page-read'));
  const stop = f.client.request('turn/interrupt', { threadId: 'thread-1', turnId: 'turn-1' });
  assert.deepEqual(order, ['thread/resume', 'thread/turns/list', 'page-read']);
  gate.resolve();
  await stop;
  assert.deepEqual(order, ['thread/resume', 'thread/turns/list', 'page-read', 'history-persisted', 'live', 'turn/interrupt']);
  assert.throws(() => historyPort.request('thread/turns/list', { threadId: 'thread-1' }), /codex_app_server_disconnected/);
});

test('a socket lost during recovery paging retries instead of abandoning its binding', async (t) => {
  let reads = 0;
  let recovered = false;
  const failures = [];
  const f = await fixture(t, (ws, message) => {
    if (message.method === 'thread/turns/list' && ++reads === 1) { ws.terminate(); return; }
    reply(ws, message, { data: [] });
  });
  f.client.bindTurn('thread-1', {
    onReconnectResume: (_response, client) => client.request('thread/turns/list', { threadId: 'thread-1' }),
    onReconnectRecovered: () => { recovered = true; },
    onDisconnected: (error) => failures.push(error)
  });
  await disconnect(f);
  await waitFor(() => recovered || failures.length);
  assert.deepEqual(failures, []);
  assert.equal(reads, 2);
  assert.equal(f.sockets.length, 3);
});

test('reconnect awaits history persistence before live events and commands', async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const order = [];
  const f = await fixture(t, (ws, message) => {
    if (message.method === 'thread/resume') {
      reply(ws, message, { thread: { id: 'thread-1', turns: [{ id: 'turn-1' }] } });
      ws.send(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-1' } }));
    } else { order.push(message.method); reply(ws, message, {}); }
  });
  f.client.bindTurn('thread-1', {
    async onReconnectResume(response) {
      assert.equal(response.thread.turns[0].id, 'turn-1');
      order.push('import-start');
      await gate.promise;
      order.push('import-end');
    },
    onNotification: () => order.push('completed'),
    onReconnectRecovered: () => order.push('recovered')
  });
  await disconnect(f);
  await waitFor(() => order.includes('import-start'));
  const stop = f.client.request('turn/interrupt', { threadId: 'thread-1', turnId: 'turn-1' });
  assert.deepEqual(order, ['import-start']);
  gate.resolve();
  await stop;
  assert.deepEqual(order, ['import-start', 'import-end', 'completed', 'recovered', 'turn/interrupt']);
});

test('a second disconnect uses one recovery loop and discards events from its stale socket', async (t) => {
  let resumes = 0;
  const gates = [deferred(), deferred()];
  t.after(() => gates.forEach((gate) => gate.resolve()));
  const received = [];
  const attempts = [];
  const f = await fixture(t, (ws, message) => {
    const revision = ++resumes;
    reply(ws, message, { revision });
    ws.send(JSON.stringify({ method: 'item/completed', params: { threadId: 'thread-1', revision } }));
  });
  f.client.bindTurn('thread-1', {
    onReconnectAttempt: ({ attempt }) => attempts.push(attempt),
    onReconnectResume: ({ revision }) => gates[revision - 1].promise,
    onNotification: ({ params }) => received.push(params.revision)
  });
  await disconnect(f);
  await waitFor(() => resumes === 1);
  await disconnect(f);
  gates[0].resolve();
  await waitFor(() => resumes === 2);
  gates[1].resolve();
  await waitFor(() => received.length === 1);
  assert.deepEqual(received, [2]);
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(f.sockets.length, 3);
});

test('failed history persistence fails only its original binding without reporting recovery', async (t) => {
  const failure = new Error('history write failed');
  const events = [];
  const f = await fixture(t, (ws, message) => reply(ws, message, {}));
  f.client.bindTurn('bad', {
    onReconnectResume: async () => { throw failure; },
    onDisconnected: (error) => { assert.equal(error, failure); events.push('failed'); },
    onReconnectRecovered: () => events.push('bad-recovered')
  });
  f.client.bindTurn('good', {
    onReconnectResume: async () => events.push('imported'),
    onReconnectRecovered: () => events.push('good-recovered')
  });
  await disconnect(f);
  await waitFor(() => events.includes('good-recovered'));
  assert.deepEqual(events, ['failed', 'imported', 'good-recovered']);
});

test('replaced bindings never receive buffered events from the previous turn', async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve());
  let importing = false;
  const events = [];
  const f = await fixture(t, (ws, message) => {
    reply(ws, message, {});
    if (message.method === 'thread/resume') {
      ws.send(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-1' } }));
    }
  });
  f.client.bindTurn('thread-1', {
    onReconnectResume: async () => { importing = true; await gate.promise; },
    onNotification: () => events.push('old')
  });
  await disconnect(f);
  await waitFor(() => importing);
  f.client.unbindTurn('thread-1');
  f.client.bindTurn('thread-1', { onNotification: () => events.push('new') });
  gate.resolve();
  await f.client.request('thread/read', { threadId: 'other' });
  assert.deepEqual(events, []);
});

async function fixture(t, handle) {
  const server = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const sockets = [];
  const clientSockets = [];
  server.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('message', (data) => {
      const message = JSON.parse(String(data));
      if (message.method === 'initialize') reply(ws, message, {});
      else if (message.id !== undefined) handle(ws, message);
    });
  });
  const client = createAppServerClient({
    wsImpl: class extends WebSocket {
      constructor(endpoint) { super(endpoint); clientSockets.push(this); }
    },
    resolveEndpoint: () => `ws://127.0.0.1:${server.address().port}`
  });
  t.after(async () => {
    client.destroy();
    for (const ws of sockets) ws.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  await client.ensureConnected();
  return { client, sockets, clientSockets };
}

async function disconnect(f) {
  const ws = f.sockets.at(-1);
  const clientWs = f.clientSockets.at(-1);
  const closed = Promise.all([ws, clientWs].map((socket) => socket.readyState === WebSocket.CLOSED
    ? Promise.resolve() : new Promise((resolve) => socket.once('close', resolve))));
  ws.terminate();
  // Server-side close does not mean the client has processed EOF. Releasing
  // the recovery gate earlier races valid buffered delivery with disconnect.
  await closed;
}

function reply(ws, message, result) {
  ws.send(JSON.stringify({ id: message.id, result }));
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('reconnect condition timed out');
}
