'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const WebSocket = require('ws');
const { createSessionEventBus } = require('../lib/server/session-event-bus');
const { buildSessionWatchPayload } = require('../lib/server/webui-session-watch');
const { SESSION_WATCH_WEBSOCKET_PATH, createSessionWatchWebSocketServer } = require('../lib/server/webui-session-watch-websocket');

const MANAGEMENT_KEY = 'session-watch-management';
const TARGET = { provider: 'workbuddycn', sessionId: 'native-session', projectDirName: 'project' };

async function fixture(t, options = {}) {
  const bus = createSessionEventBus({ resolveSessionFilePath: () => '' });
  let key = MANAGEMENT_KEY;
  const clients = new Set();
  const watch = createSessionWatchWebSocketServer({
    sessionEventBus: bus, getRequiredManagementKey: () => key,
    authTimeoutMs: options.authTimeoutMs
  });
  const server = http.createServer((_req, res) => res.end('available'));
  server.on('upgrade', (req, socket, head) => watch.handleUpgrade(req, socket, head));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    watch.close();
    clients.forEach((client) => client.terminate());
    bus.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const connect = (socketOptions = {}) => {
    const client = new WebSocket(`${origin.replace('http:', 'ws:')}${SESSION_WATCH_WEBSOCKET_PATH}`, socketOptions);
    clients.add(client);
    return client;
  };
  const authenticate = async (client, payload = {}) => {
    await once(client, 'open');
    const frame = once(client, 'message');
    client.send(JSON.stringify({ authorization: `Bearer ${MANAGEMENT_KEY}`, ...TARGET, ...payload }));
    const [bytes] = await frame;
    return JSON.parse(bytes.toString());
  };
  return { bus, origin, connect, authenticate, close: () => watch.close(), rotate: (value) => { key = value; } };
}

test('unauthenticated sockets subscribe to no session and receive no events', async (t) => {
  const f = await fixture(t, { authTimeoutMs: 75 });
  const client = f.connect();
  await once(client, 'open');
  let frames = 0;
  client.on('message', () => { frames += 1; });
  const closed = once(client, 'close');
  f.bus.publish(TARGET, { phase: 'complete' });
  await closed;
  assert.equal(frames, 0);
  assert.equal(f.bus.getStats().subscribers, 0);
});

for (const [name, authorization, query] of [
  ['missing credential', '', ''],
  ['Client Key', 'Bearer client-key', ''],
  ['wrong Management Key', 'Bearer wrong-management-key', ''],
  ['query credential', '', '?managementKey=session-watch-management']
]) {
  test(`session socket rejects ${name}`, async (t) => {
    const f = await fixture(t);
    const client = query ? new WebSocket(`${f.origin.replace('http:', 'ws:')}${SESSION_WATCH_WEBSOCKET_PATH}${query}`) : f.connect();
    t.after(() => client.terminate());
    await once(client, 'open');
    const closed = once(client, 'close');
    client.send(JSON.stringify({ authorization, ...TARGET }));
    const [code] = await closed;
    assert.equal(code, 4401);
    assert.equal(f.bus.getStats().subscribers, 0);
  });
}

test('session socket checks the current Management Key when the first frame arrives', async (t) => {
  const f = await fixture(t);
  const client = f.connect();
  await once(client, 'open');
  f.rotate('rotated-key');
  const closed = once(client, 'close');
  client.send(JSON.stringify({ authorization: `Bearer ${MANAGEMENT_KEY}`, ...TARGET }));
  assert.equal((await closed)[0], 4401);
  assert.equal(f.bus.getStats().subscribers, 0);
});

test('a foreign browser origin is rejected before the WebSocket upgrade', async (t) => {
  const f = await fixture(t);
  const client = f.connect({ origin: 'https://foreign.example' });
  const [error] = await once(client, 'error');
  assert.match(error.message, /403/);
  assert.equal(f.bus.getStats().subscribers, 0);
});

test('valid credential still requires a complete session identity', async (t) => {
  const f = await fixture(t);
  const client = f.connect();
  await once(client, 'open');
  const closed = once(client, 'close');
  client.send(JSON.stringify({ authorization: `Bearer ${MANAGEMENT_KEY}`, provider: 'workbuddy' }));
  assert.equal((await closed)[0], 4400);
  assert.equal(f.bus.getStats().subscribers, 0);
});

test('background session sockets preserve native prompts and retries and release their subscription on close', async (t) => {
  const f = await fixture(t);
  const client = f.connect({ origin: f.origin });
  assert.deepEqual(await f.authenticate(client), { type: 'connected' });
  assert.equal(f.bus.getStats().subscribers, 1);
  const event = {
    type: 'session:native-prompt', phase: 'waiting-input', runId: 'run-1', promptId: 'prompt-1',
    prompt: { type: 'choice', options: ['continue'] }, retryStatus: { attempt: 2, maxAttempts: 5 }
  };
  const next = once(client, 'message');
  f.bus.publish(TARGET, event);
  const payload = JSON.parse((await next)[0].toString());
  assert.deepEqual(payload, buildSessionWatchPayload({}, TARGET, { ...TARGET, ...event, source: 'unknown' }));
  const closed = once(client, 'close');
  client.close();
  await closed;
  // The peer sees the close acknowledgement before the server socket emits
  // close. Verify eventual server cleanup rather than relying on event order.
  const deadline = Date.now() + 1000;
  while (f.bus.getStats().subscribers && Date.now() < deadline) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(f.bus.getStats().subscribers, 0);
});

test('eight background sessions leave the HTTP endpoint available and isolate each event identity', async (t) => {
  const f = await fixture(t);
  const clients = await Promise.all(Array.from({ length: 8 }, async (_value, index) => {
    const client = f.connect();
    await f.authenticate(client, { sessionId: `session-${index}` });
    return client;
  }));
  assert.equal(f.bus.getStats().subscribers, 8);
  const response = await fetch(f.origin, { signal: AbortSignal.timeout(1000) });
  assert.equal(await response.text(), 'available');
  const received = clients.map(() => []);
  clients.forEach((client, index) => client.on('message', (bytes) => received[index].push(JSON.parse(bytes.toString()))));
  const delivery = once(clients[3], 'message');
  f.bus.publish({ ...TARGET, sessionId: 'session-3' }, { phase: 'complete' });
  await delivery;
  assert.equal(received[3].length, 1);
  assert.equal(received.filter((events) => events.length > 0).length, 1);
});

test('server shutdown closes authenticated and pending sockets and releases session subscriptions', async (t) => {
  const f = await fixture(t);
  const authenticated = f.connect();
  await f.authenticate(authenticated);
  const pending = f.connect();
  await once(pending, 'open');
  const closed = [once(authenticated, 'close'), once(pending, 'close')];
  f.close();
  await Promise.all(closed);
  assert.equal(f.bus.getStats().subscribers, 0);
});
