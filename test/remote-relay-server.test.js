const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');
const WebSocket = require('ws');

const { parseAuthorizationBearer } = require('../lib/server/http-utils');
const { upsertRemoteNode } = require('../lib/server/remote/node-registry');
const { listNodeTransports } = require('../lib/server/remote/transport-registry');
const { writeRemoteSecret } = require('../lib/server/remote/secret-store');
const { createRelaySessionRegistry } = require('../lib/server/remote/relay-session-registry');
const {
  handleRelayNodeUpgrade,
  requestRelayManagement,
  requestRelayManagementStream
} = require('../lib/server/remote/relay-server');
const { requestRemoteManagement } = require('../lib/server/remote/remote-gateway');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function createRelayTestServer(t, deps, registry) {
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    handleRelayNodeUpgrade({
      req,
      socket,
      head,
      deps: {
        ...deps,
        WebSocket,
        parseAuthorizationBearer,
        relaySessionRegistry: registry,
        clientIp: '127.0.0.1'
      }
    });
  });
  const port = await listen(server);
  t.after(() => {
    registry.closeAll();
    return closeServer(server);
  });
  return port;
}

function openRelay(url, token) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: token ? { authorization: `Bearer ${token}` } : {}
    });
    const firstMessage = readJsonMessage(socket);
    firstMessage.catch(() => {});
    socket.once('open', () => resolve({ socket, firstMessage }));
    socket.once('unexpected-response', (_request, response) => {
      const error = new Error(`unexpected_response:${response.statusCode}`);
      error.statusCode = response.statusCode;
      reject(error);
    });
    socket.once('error', reject);
  });
}

function readJsonMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => {
      try {
        resolve(JSON.parse(data.toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    socket.once('error', reject);
  });
}

async function waitForCondition(predicate, timeoutMs = 500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

test('relay node upgrade registers online session and relay transport', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-relay-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };
  const registry = createRelaySessionRegistry({
    createSessionId: () => 'session-1',
    nowMs: () => 1234
  });

  const node = upsertRemoteNode({ id: 'nat-node', name: 'NAT Node' }, deps);
  writeRemoteSecret(node.authRef, { managementKey: 'node-secret' }, deps);
  const port = await createRelayTestServer(t, deps, registry);
  const opened = await openRelay(`ws://127.0.0.1:${port}/v0/relay/node?nodeId=nat-node`, 'node-secret');
  const { socket } = opened;
  t.after(() => socket.close());

  const hello = await opened.firstMessage;
  assert.equal(hello.type, 'relay.hello');
  assert.equal(hello.nodeId, 'nat-node');
  assert.equal(hello.sessionId, 'session-1');
  assert.equal(registry.listRelaySessions().length, 1);

  socket.send(JSON.stringify({ type: 'relay.ping' }));
  const pong = await readJsonMessage(socket);
  assert.equal(pong.type, 'relay.pong');
  assert.equal(pong.nodeId, 'nat-node');

  const transports = listNodeTransports('nat-node', deps);
  assert.equal(transports[0].kind, 'relay');
  assert.equal(transports[0].endpoint, 'relay://nat-node');
  assert.equal(transports[0].status, 'up');

  socket.close();
  await new Promise((resolve) => socket.once('close', resolve));
  await waitForCondition(() => registry.listRelaySessions().length === 0);
  assert.equal(registry.listRelaySessions().length, 0);
  assert.equal(listNodeTransports('nat-node', deps)[0].status, 'degraded');
});

test('relay node upgrade rejects invalid token and unknown node', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-relay-reject-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };
  const registry = createRelaySessionRegistry();

  const node = upsertRemoteNode({ id: 'known-node', name: 'Known Node' }, deps);
  writeRemoteSecret(node.authRef, { managementKey: 'node-secret' }, deps);
  const port = await createRelayTestServer(t, deps, registry);

  await assert.rejects(
    openRelay(`ws://127.0.0.1:${port}/v0/relay/node?nodeId=known-node`, 'bad-secret'),
    { statusCode: 401 }
  );
  await assert.rejects(
    openRelay(`ws://127.0.0.1:${port}/v0/relay/node?nodeId=missing-node`, 'node-secret'),
    { statusCode: 404 }
  );
  assert.equal(registry.listRelaySessions().length, 0);
});

test('relay management request uses connected node frame response', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-relay-rpc-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };
  const registry = createRelaySessionRegistry();

  const node = upsertRemoteNode({ id: 'rpc-node', name: 'RPC Node', preferredTransports: ['relay'] }, deps);
  writeRemoteSecret(node.authRef, { managementKey: 'node-secret' }, deps);
  const port = await createRelayTestServer(t, deps, registry);
  const opened = await openRelay(`ws://127.0.0.1:${port}/v0/relay/node?nodeId=rpc-node`, 'node-secret');
  const { socket } = opened;
  t.after(() => socket.close());
  await opened.firstMessage;

  const framePromise = readJsonMessage(socket);
  const requestPromise = requestRemoteManagement({
    node,
    transports: [{
      id: 'rpc-node-relay',
      nodeId: 'rpc-node',
      kind: 'relay',
      endpoint: 'relay://rpc-node',
      status: 'up',
      score: 55
    }],
    pathname: '/v0/management/status',
    method: 'GET',
    audit: false
  }, {
    ...deps,
    relaySessionRegistry: registry,
    requestRelayManagement
  });

  const frame = await framePromise;
  assert.equal(frame.type, 'relay.request');
  assert.equal(frame.method, 'GET');
  assert.equal(frame.pathname, '/v0/management/status');
  socket.send(JSON.stringify({
    type: 'relay.response',
    requestId: frame.requestId,
    status: 200,
    ok: true,
    payload: { ok: true, service: 'remote-node' }
  }));

  const result = await requestPromise;
  assert.equal(result.ok, true);
  assert.equal(result.transport.kind, 'relay');
  assert.deepEqual(result.payload, { ok: true, service: 'remote-node' });
});

test('relay management request allows typed node session messages route', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-relay-session-messages-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };
  const registry = createRelaySessionRegistry();

  const node = upsertRemoteNode({ id: 'messages-node', name: 'Messages Node', preferredTransports: ['relay'] }, deps);
  writeRemoteSecret(node.authRef, { managementKey: 'node-secret' }, deps);
  const port = await createRelayTestServer(t, deps, registry);
  const opened = await openRelay(`ws://127.0.0.1:${port}/v0/relay/node?nodeId=messages-node`, 'node-secret');
  const { socket } = opened;
  t.after(() => socket.close());
  await opened.firstMessage;

  const framePromise = readJsonMessage(socket);
  const requestPromise = requestRemoteManagement({
    node,
    transports: [{
      id: 'messages-node-relay',
      nodeId: 'messages-node',
      kind: 'relay',
      endpoint: 'relay://messages-node',
      status: 'up',
      score: 55
    }],
    pathname: '/v0/node-rpc/session-messages?sessionRef=sess_0123456789abcdefabcd&limit=2',
    method: 'GET',
    audit: false
  }, {
    ...deps,
    relaySessionRegistry: registry,
    requestRelayManagement
  });

  const frame = await framePromise;
  assert.equal(frame.type, 'relay.request');
  assert.equal(frame.method, 'GET');
  assert.equal(frame.pathname, '/v0/node-rpc/session-messages?sessionRef=sess_0123456789abcdefabcd&limit=2');
  socket.send(JSON.stringify({
    type: 'relay.response',
    requestId: frame.requestId,
    status: 200,
    ok: true,
    payload: { ok: true, rpc: 'node.session_messages', result: { messages: [] } }
  }));

  const result = await requestPromise;
  assert.equal(result.ok, true);
  assert.equal(result.transport.kind, 'relay');
  assert.deepEqual(result.payload, { ok: true, rpc: 'node.session_messages', result: { messages: [] } });
});

test('relay management request allows typed node sessions route', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-relay-sessions-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };
  const registry = createRelaySessionRegistry();

  const node = upsertRemoteNode({ id: 'sessions-node', name: 'Sessions Node', preferredTransports: ['relay'] }, deps);
  writeRemoteSecret(node.authRef, { managementKey: 'node-secret' }, deps);
  const port = await createRelayTestServer(t, deps, registry);
  const opened = await openRelay(`ws://127.0.0.1:${port}/v0/relay/node?nodeId=sessions-node`, 'node-secret');
  const { socket } = opened;
  t.after(() => socket.close());
  await opened.firstMessage;

  const framePromise = readJsonMessage(socket);
  const requestPromise = requestRemoteManagement({
    node,
    transports: [{
      id: 'sessions-node-relay',
      nodeId: 'sessions-node',
      kind: 'relay',
      endpoint: 'relay://sessions-node',
      status: 'up',
      score: 55
    }],
    pathname: '/v0/node-rpc/sessions?limit=2',
    method: 'GET',
    audit: false
  }, {
    ...deps,
    relaySessionRegistry: registry,
    requestRelayManagement
  });

  const frame = await framePromise;
  assert.equal(frame.type, 'relay.request');
  assert.equal(frame.method, 'GET');
  assert.equal(frame.pathname, '/v0/node-rpc/sessions?limit=2');
  socket.send(JSON.stringify({
    type: 'relay.response',
    requestId: frame.requestId,
    status: 200,
    ok: true,
    payload: { ok: true, rpc: 'node.sessions', result: { sessions: [] } }
  }));

  const result = await requestPromise;
  assert.equal(result.ok, true);
  assert.equal(result.transport.kind, 'relay');
  assert.deepEqual(result.payload, { ok: true, rpc: 'node.sessions', result: { sessions: [] } });
});

test('relay management request allows session catalog and attach routes', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-relay-session-catalog-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };
  const registry = createRelaySessionRegistry();

  const node = upsertRemoteNode({ id: 'catalog-node', name: 'Catalog Node', preferredTransports: ['relay'] }, deps);
  writeRemoteSecret(node.authRef, { managementKey: 'node-secret' }, deps);
  const port = await createRelayTestServer(t, deps, registry);
  const opened = await openRelay(`ws://127.0.0.1:${port}/v0/relay/node?nodeId=catalog-node`, 'node-secret');
  const { socket } = opened;
  t.after(() => socket.close());
  await opened.firstMessage;

  const catalogFramePromise = readJsonMessage(socket);
  const catalogPromise = requestRemoteManagement({
    node,
    transports: [{
      id: 'catalog-node-relay',
      nodeId: 'catalog-node',
      kind: 'relay',
      endpoint: 'relay://catalog-node',
      status: 'up',
      score: 55
    }],
    pathname: '/v0/node-rpc/session-catalog?limit=2',
    method: 'GET',
    audit: false
  }, {
    ...deps,
    relaySessionRegistry: registry,
    requestRelayManagement
  });

  const catalogFrame = await catalogFramePromise;
  assert.equal(catalogFrame.type, 'relay.request');
  assert.equal(catalogFrame.pathname, '/v0/node-rpc/session-catalog?limit=2');
  socket.send(JSON.stringify({
    type: 'relay.response',
    requestId: catalogFrame.requestId,
    status: 200,
    ok: true,
    payload: { ok: true, rpc: 'node.session_catalog', result: { sessions: [] } }
  }));
  const catalogResult = await catalogPromise;
  assert.equal(catalogResult.ok, true);
  assert.equal(catalogResult.payload.rpc, 'node.session_catalog');

  const attachFramePromise = readJsonMessage(socket);
  const attachPromise = requestRemoteManagement({
    node,
    transports: [{
      id: 'catalog-node-relay',
      nodeId: 'catalog-node',
      kind: 'relay',
      endpoint: 'relay://catalog-node',
      status: 'up',
      score: 55
    }],
    pathname: '/v0/node-rpc/session-attach',
    method: 'POST',
    body: JSON.stringify({ sessionId: 'run-catalog-1' }),
    audit: false
  }, {
    ...deps,
    relaySessionRegistry: registry,
    requestRelayManagement
  });

  const attachFrame = await attachFramePromise;
  assert.equal(attachFrame.type, 'relay.request');
  assert.equal(attachFrame.method, 'POST');
  assert.equal(attachFrame.pathname, '/v0/node-rpc/session-attach');
  assert.equal(JSON.parse(attachFrame.body).sessionId, 'run-catalog-1');
  socket.send(JSON.stringify({
    type: 'relay.response',
    requestId: attachFrame.requestId,
    status: 200,
    ok: true,
    payload: { ok: true, rpc: 'node.session_attach', result: { sessionId: 'run-catalog-1' } }
  }));
  const attachResult = await attachPromise;
  assert.equal(attachResult.ok, true);
  assert.equal(attachResult.payload.rpc, 'node.session_attach');
});

test('relay management request allows typed node session input route with body', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-relay-session-input-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };
  const registry = createRelaySessionRegistry();

  const node = upsertRemoteNode({ id: 'input-node', name: 'Input Node', preferredTransports: ['relay'] }, deps);
  writeRemoteSecret(node.authRef, { managementKey: 'node-secret' }, deps);
  const port = await createRelayTestServer(t, deps, registry);
  const opened = await openRelay(`ws://127.0.0.1:${port}/v0/relay/node?nodeId=input-node`, 'node-secret');
  const { socket } = opened;
  t.after(() => socket.close());
  await opened.firstMessage;

  const body = JSON.stringify({
    sessionRef: 'sess_0123456789abcdefabcd',
    input: 'remote yes',
    appendNewline: true
  });
  const framePromise = readJsonMessage(socket);
  const requestPromise = requestRemoteManagement({
    node,
    transports: [{
      id: 'input-node-relay',
      nodeId: 'input-node',
      kind: 'relay',
      endpoint: 'relay://input-node',
      status: 'up',
      score: 55
    }],
    pathname: '/v0/node-rpc/session-input',
    method: 'POST',
    body,
    audit: false
  }, {
    ...deps,
    relaySessionRegistry: registry,
    requestRelayManagement
  });

  const frame = await framePromise;
  assert.equal(frame.type, 'relay.request');
  assert.equal(frame.method, 'POST');
  assert.equal(frame.pathname, '/v0/node-rpc/session-input');
  assert.equal(frame.body, body);
  socket.send(JSON.stringify({
    type: 'relay.response',
    requestId: frame.requestId,
    status: 200,
    ok: true,
    payload: { ok: true, rpc: 'node.session_input', result: { accepted: true } }
  }));

  const result = await requestPromise;
  assert.equal(result.ok, true);
  assert.equal(result.transport.kind, 'relay');
  assert.deepEqual(result.payload, { ok: true, rpc: 'node.session_input', result: { accepted: true } });
});

test('relay management request rejects non allowlisted route', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-relay-deny-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };
  const registry = createRelaySessionRegistry();

  const node = upsertRemoteNode({ id: 'deny-node', name: 'Deny Node', preferredTransports: ['relay'] }, deps);
  writeRemoteSecret(node.authRef, { managementKey: 'node-secret' }, deps);
  const port = await createRelayTestServer(t, deps, registry);
  const opened = await openRelay(`ws://127.0.0.1:${port}/v0/relay/node?nodeId=deny-node`, 'node-secret');
  const { socket } = opened;
  t.after(() => socket.close());
  await opened.firstMessage;

  await assert.rejects(
    requestRemoteManagement({
      node,
      transports: [{
        id: 'deny-node-relay',
        nodeId: 'deny-node',
        kind: 'relay',
        endpoint: 'relay://deny-node',
        status: 'up',
        score: 55
      }],
      pathname: '/v0/webui/accounts',
      method: 'GET',
      audit: false
    }, {
      ...deps,
      relaySessionRegistry: registry,
      requestRelayManagement
    }),
    { code: 'remote_relay_route_not_allowed', status: 403 }
  );
});

test('relay management stream receives typed chunks from connected node', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-relay-stream-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };
  const registry = createRelaySessionRegistry();

  const node = upsertRemoteNode({ id: 'stream-node', name: 'Stream Node', preferredTransports: ['relay'] }, deps);
  writeRemoteSecret(node.authRef, { managementKey: 'node-secret' }, deps);
  const port = await createRelayTestServer(t, deps, registry);
  const opened = await openRelay(`ws://127.0.0.1:${port}/v0/relay/node?nodeId=stream-node`, 'node-secret');
  const { socket } = opened;
  t.after(() => socket.close());
  await opened.firstMessage;

  const chunks = [];
  const streamPromise = requestRelayManagementStream({
    node,
    pathname: '/v0/node-rpc/session-stream?sessionRef=sess_0123456789abcdefabcd',
    method: 'GET'
  }, {
    onChunk: (payload) => chunks.push(payload)
  }, {
    ...deps,
    relaySessionRegistry: registry
  });
  const frame = await readJsonMessage(socket);
  assert.equal(frame.type, 'relay.stream.open');
  assert.equal(frame.method, 'GET');
  assert.equal(frame.pathname, '/v0/node-rpc/session-stream?sessionRef=sess_0123456789abcdefabcd');
  socket.send(JSON.stringify({
    type: 'relay.stream.opened',
    streamId: frame.streamId,
    status: 200,
    ok: true
  }));
  socket.send(JSON.stringify({
    type: 'relay.stream.chunk',
    streamId: frame.streamId,
    payload: { ok: true, type: 'events', result: { cursor: 8192, events: [{ type: 'assistant_text', text: 'hello' }] } }
  }));
  socket.send(JSON.stringify({
    type: 'relay.stream.end',
    streamId: frame.streamId,
    status: 200,
    ok: true
  }));

  const result = await streamPromise;
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.deepEqual(chunks, [
    { ok: true, type: 'events', result: { cursor: 8192, events: [{ type: 'assistant_text', text: 'hello' }] } }
  ]);
});

test('relay management stream opens with window and acks handled chunks', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-relay-window-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };
  const registry = createRelaySessionRegistry();

  const node = upsertRemoteNode({ id: 'window-node', name: 'Window Node', preferredTransports: ['relay'] }, deps);
  writeRemoteSecret(node.authRef, { managementKey: 'node-secret' }, deps);
  const port = await createRelayTestServer(t, deps, registry);
  const opened = await openRelay(`ws://127.0.0.1:${port}/v0/relay/node?nodeId=window-node`, 'node-secret');
  const { socket } = opened;
  t.after(() => socket.close());
  await opened.firstMessage;

  let releaseChunk = null;
  const chunks = [];
  const streamPromise = requestRelayManagementStream({
    node,
    pathname: '/v0/node-rpc/session-stream?sessionRef=sess_0123456789abcdefabcd',
    method: 'GET',
    windowSize: 4
  }, {
    onChunk: (payload) => new Promise((resolve) => {
      chunks.push(payload);
      releaseChunk = resolve;
    })
  }, {
    ...deps,
    relaySessionRegistry: registry
  });
  let streamSettled = false;
  const observedStream = streamPromise.then((result) => {
    streamSettled = true;
    return result;
  });

  const frame = await readJsonMessage(socket);
  assert.equal(frame.type, 'relay.stream.open');
  assert.equal(frame.window.credit, 4);
  assert.equal(frame.window.max, 4);

  socket.send(JSON.stringify({
    type: 'relay.stream.opened',
    streamId: frame.streamId,
    status: 200,
    ok: true
  }));
  socket.send(JSON.stringify({
    type: 'relay.stream.chunk',
    streamId: frame.streamId,
    sequence: 1,
    payload: { ok: true, type: 'events', result: { cursor: 1, events: [{ type: 'assistant_text', text: 'hello' }] } }
  }));
  socket.send(JSON.stringify({
    type: 'relay.stream.end',
    streamId: frame.streamId,
    status: 200,
    ok: true
  }));

  await waitForCondition(() => chunks.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(streamSettled, false);
  releaseChunk();

  const ack = await readJsonMessage(socket);
  assert.equal(ack.type, 'relay.stream.ack');
  assert.equal(ack.streamId, frame.streamId);
  assert.equal(ack.credit, 1);
  assert.equal(ack.sequence, 1);

  const result = await observedStream;
  assert.equal(result.ok, true);
  assert.deepEqual(chunks, [
    { ok: true, type: 'events', result: { cursor: 1, events: [{ type: 'assistant_text', text: 'hello' }] } }
  ]);
});

test('relay management stream rejects non allowlisted route before sending frame', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-relay-stream-deny-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };
  const registry = createRelaySessionRegistry();

  const node = upsertRemoteNode({ id: 'stream-deny-node', name: 'Stream Deny Node', preferredTransports: ['relay'] }, deps);
  writeRemoteSecret(node.authRef, { managementKey: 'node-secret' }, deps);
  const port = await createRelayTestServer(t, deps, registry);
  const opened = await openRelay(`ws://127.0.0.1:${port}/v0/relay/node?nodeId=stream-deny-node`, 'node-secret');
  const { socket } = opened;
  t.after(() => socket.close());
  await opened.firstMessage;

  await assert.rejects(
    requestRelayManagementStream({
      node,
      pathname: '/v0/webui/accounts',
      method: 'GET'
    }, {}, {
      ...deps,
      relaySessionRegistry: registry
    }),
    { code: 'remote_relay_stream_route_not_allowed', status: 403 }
  );
});

test('relay management stream abort sends close frame to node', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-remote-relay-stream-abort-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };
  const registry = createRelaySessionRegistry();

  const node = upsertRemoteNode({ id: 'stream-abort-node', name: 'Stream Abort Node', preferredTransports: ['relay'] }, deps);
  writeRemoteSecret(node.authRef, { managementKey: 'node-secret' }, deps);
  const port = await createRelayTestServer(t, deps, registry);
  const opened = await openRelay(`ws://127.0.0.1:${port}/v0/relay/node?nodeId=stream-abort-node`, 'node-secret');
  const { socket } = opened;
  t.after(() => socket.close());
  await opened.firstMessage;

  const controller = new AbortController();
  const streamPromise = requestRelayManagementStream({
    node,
    pathname: '/v0/node-rpc/session-stream?sessionRef=sess_0123456789abcdefabcd',
    method: 'GET',
    signal: controller.signal
  }, {}, {
    ...deps,
    relaySessionRegistry: registry
  });
  const rejected = assert.rejects(streamPromise, { code: 'remote_relay_stream_aborted', status: 499 });
  const frame = await readJsonMessage(socket);
  assert.equal(frame.type, 'relay.stream.open');
  controller.abort();
  const closeFrame = await readJsonMessage(socket);
  assert.equal(closeFrame.type, 'relay.stream.close');
  assert.equal(closeFrame.streamId, frame.streamId);
  await rejected;
});
