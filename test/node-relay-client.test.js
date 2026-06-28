const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');
const WebSocket = require('ws');

const { parseAuthorizationBearer } = require('../lib/server/http-utils');
const { upsertRemoteNode } = require('../lib/server/remote/node-registry');
const { writeRemoteSecret } = require('../lib/server/remote/secret-store');
const { createRelaySessionRegistry } = require('../lib/server/remote/relay-session-registry');
const {
  handleRelayNodeUpgrade,
  requestRelayManagement,
  requestRelayManagementStream
} = require('../lib/server/remote/relay-server');
const { requestRemoteManagement } = require('../lib/server/remote/remote-gateway');
const {
  fetchLocalRelayRequest,
  normalizeRelayUrl,
  runNodeRelayConnect
} = require('../lib/cli/services/node/relay-client');
const { runNodeCommandRouter } = require('../lib/cli/commands/node-router');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function waitForCondition(predicate, timeoutMs = 500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

function readJsonMessageWithTimeout(socket, timeoutMs = 100) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();

    function cleanup() {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('error', onError);
    }
    function onMessage(data) {
      cleanup();
      try {
        resolve(JSON.parse(data.toString('utf8')));
      } catch (error) {
        reject(error);
      }
    }
    function onError(error) {
      cleanup();
      reject(error);
    }

    socket.once('message', onMessage);
    socket.once('error', onError);
  });
}

async function createRelayControlPlane(t, deps, registry) {
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
  return `http://127.0.0.1:${port}`;
}

async function createLocalManagementServer(t, handler) {
  const server = http.createServer(handler);
  const port = await listen(server);
  t.after(() => closeServer(server));
  return port;
}

test('normalizeRelayUrl builds websocket relay node endpoint', () => {
  const result = normalizeRelayUrl('https://control.example.com/app?x=1', 'Nat_Node');
  assert.equal(result.nodeId, 'nat_node');
  assert.equal(result.url.toString(), 'wss://control.example.com/v0/relay/node?nodeId=nat_node');
});

test('runNodeRelayConnect --once performs outbound websocket hello and heartbeat', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-relay-client-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };
  const registry = createRelaySessionRegistry({
    createSessionId: () => 'session-client-1',
    nowMs: () => 1234
  });
  const node = upsertRemoteNode({ id: 'nat-node', name: 'NAT Node' }, deps);
  writeRemoteSecret(node.authRef, { managementKey: 'node-secret' }, deps);
  const controlUrl = await createRelayControlPlane(t, deps, registry);

  const result = await runNodeRelayConnect([
    controlUrl,
    '--node-id',
    'nat-node',
    '--once'
  ], {
    WebSocket,
    readServerConfig: () => ({ managementKey: 'node-secret' })
  });

  assert.equal(result.ok, true);
  assert.equal(result.nodeId, 'nat-node');
  assert.equal(result.sessionId, 'session-client-1');
  assert.equal(result.transportId, 'nat-node-relay');
  assert.equal(result.relayUrl, `${controlUrl.replace(/^http:/, 'ws:')}/v0/relay/node?nodeId=nat-node`);
});

test('runNodeRelayConnect forwards relay management request to local server', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-relay-client-rpc-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };
  const registry = createRelaySessionRegistry();
  const node = upsertRemoteNode({ id: 'nat-node', name: 'NAT Node', preferredTransports: ['relay'] }, deps);
  writeRemoteSecret(node.authRef, { managementKey: 'node-secret' }, deps);
  const controlUrl = await createRelayControlPlane(t, deps, registry);
  let observed = null;
  const localPort = await createLocalManagementServer(t, (req, res) => {
    observed = {
      url: req.url,
      authorization: req.headers.authorization
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'local-node' }));
  });

  const relayRun = runNodeRelayConnect([
    controlUrl,
    '--node-id',
    'nat-node',
    '--max-attempts',
    '1'
  ], {
    WebSocket,
    readServerConfig: () => ({
      host: '127.0.0.1',
      port: localPort,
      managementKey: 'node-secret'
    })
  });

  await waitForCondition(() => registry.listRelaySessions().length === 1);
  const result = await requestRemoteManagement({
    node,
    transports: [{
      id: 'nat-node-relay',
      nodeId: 'nat-node',
      kind: 'relay',
      endpoint: 'relay://nat-node',
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

  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, { ok: true, service: 'local-node' });
  assert.deepEqual(observed, {
    url: '/v0/management/status',
    authorization: 'Bearer node-secret'
  });
  registry.closeAll();
  await relayRun;
});

test('runNodeRelayConnect forwards relay session stream from local SSE server', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-relay-client-stream-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };
  const registry = createRelaySessionRegistry();
  const node = upsertRemoteNode({ id: 'stream-node', name: 'Stream Node', preferredTransports: ['relay'] }, deps);
  writeRemoteSecret(node.authRef, { managementKey: 'node-secret' }, deps);
  const controlUrl = await createRelayControlPlane(t, deps, registry);
  let observed = null;
  const localPort = await createLocalManagementServer(t, (req, res) => {
    observed = {
      url: req.url,
      authorization: req.headers.authorization
    };
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache'
    });
    res.write(`data: ${JSON.stringify({ ok: true, rpc: 'node.session_stream', result: { cursor: 8192, events: [{ type: 'assistant_text', text: 'hello' }] } })}\n\n`);
    res.end();
  });

  const relayRun = runNodeRelayConnect([
    controlUrl,
    '--node-id',
    'stream-node',
    '--max-attempts',
    '1'
  ], {
    WebSocket,
    readServerConfig: () => ({
      host: '127.0.0.1',
      port: localPort,
      managementKey: 'node-secret'
    })
  });

  await waitForCondition(() => registry.listRelaySessions().length === 1);
  const chunks = [];
  const result = await requestRelayManagementStream({
    node,
    pathname: '/v0/node-rpc/session-stream?sessionRef=sess_0123456789abcdefabcd&cursor=4096',
    method: 'GET'
  }, {
    onChunk: (payload) => chunks.push(payload)
  }, {
    ...deps,
    relaySessionRegistry: registry
  });

  assert.equal(result.ok, true);
  assert.deepEqual(observed, {
    url: '/v0/node-rpc/session-stream?sessionRef=sess_0123456789abcdefabcd&cursor=4096',
    authorization: 'Bearer node-secret'
  });
  assert.deepEqual(chunks, [
    { ok: true, rpc: 'node.session_stream', result: { cursor: 8192, events: [{ type: 'assistant_text', text: 'hello' }] } }
  ]);
  registry.closeAll();
  await relayRun;
});

test('runNodeRelayConnect applies relay stream window before forwarding next chunk', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-relay-client-stream-window-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };
  const registry = createRelaySessionRegistry();
  const node = upsertRemoteNode({ id: 'window-node', name: 'Window Node', preferredTransports: ['relay'] }, deps);
  writeRemoteSecret(node.authRef, { managementKey: 'node-secret' }, deps);
  const controlUrl = await createRelayControlPlane(t, deps, registry);
  const localPort = await createLocalManagementServer(t, (_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache'
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    setTimeout(() => {
      res.write(`data: ${JSON.stringify({ ok: true, type: 'events', result: { cursor: 1, events: [{ type: 'assistant_text', text: 'one' }] } })}\n\n`);
      res.write(`data: ${JSON.stringify({ ok: true, type: 'events', result: { cursor: 2, events: [{ type: 'assistant_text', text: 'two' }] } })}\n\n`);
      setTimeout(() => res.end(), 80);
    }, 120);
  });

  const relayRun = runNodeRelayConnect([
    controlUrl,
    '--node-id',
    'window-node',
    '--max-attempts',
    '1'
  ], {
    WebSocket,
    readServerConfig: () => ({
      host: '127.0.0.1',
      port: localPort,
      managementKey: 'node-secret'
    })
  });

  await waitForCondition(() => registry.getRelaySession('window-node'));
  const session = registry.getRelaySession('window-node');
  session.socket.send(JSON.stringify({
    type: 'relay.stream.open',
    streamId: 'window-stream-1',
    method: 'GET',
    pathname: '/v0/node-rpc/session-stream?sessionRef=sess_0123456789abcdefabcd',
    window: { credit: 1, max: 1 }
  }));

  const opened = await readJsonMessageWithTimeout(session.socket, 500);
  assert.equal(opened.type, 'relay.stream.opened');
  assert.equal(opened.ok, true);

  const firstChunk = await readJsonMessageWithTimeout(session.socket, 500);
  assert.equal(firstChunk.type, 'relay.stream.chunk');
  assert.equal(firstChunk.sequence, 1);
  assert.equal(firstChunk.payload.result.cursor, 1);

  const blockedFrame = await readJsonMessageWithTimeout(session.socket, 60);
  assert.equal(blockedFrame, null);

  session.socket.send(JSON.stringify({
    type: 'relay.stream.ack',
    streamId: 'window-stream-1',
    credit: 1,
    sequence: 1
  }));

  const secondChunk = await readJsonMessageWithTimeout(session.socket, 500);
  assert.equal(secondChunk.type, 'relay.stream.chunk');
  assert.equal(secondChunk.sequence, 2);
  assert.equal(secondChunk.payload.result.cursor, 2);

  const endFramePromise = readJsonMessageWithTimeout(session.socket, 500);
  session.socket.send(JSON.stringify({
    type: 'relay.stream.ack',
    streamId: 'window-stream-1',
    credit: 1,
    sequence: 2
  }));
  const endFrame = await endFramePromise;
  assert.equal(endFrame.type, 'relay.stream.end');
  assert.equal(endFrame.ok, true);

  registry.closeAll();
  await relayRun;
});

test('runNodeRelayConnect rejects non allowlisted relay stream route before local fetch', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-node-relay-client-stream-deny-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const deps = { fs, aiHomeDir };
  const registry = createRelaySessionRegistry();
  const node = upsertRemoteNode({ id: 'stream-deny-node', name: 'Stream Deny Node', preferredTransports: ['relay'] }, deps);
  writeRemoteSecret(node.authRef, { managementKey: 'node-secret' }, deps);
  const controlUrl = await createRelayControlPlane(t, deps, registry);
  let fetchCalled = false;

  const relayRun = runNodeRelayConnect([
    controlUrl,
    '--node-id',
    'stream-deny-node',
    '--max-attempts',
    '1'
  ], {
    WebSocket,
    readServerConfig: () => ({
      host: '127.0.0.1',
      port: 9527,
      managementKey: 'node-secret'
    }),
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error('fetch_should_not_run');
    }
  });

  await waitForCondition(() => registry.getRelaySession('stream-deny-node'));
  const session = registry.getRelaySession('stream-deny-node');
  session.socket.send(JSON.stringify({
    type: 'relay.stream.open',
    streamId: 'stream-1',
    method: 'GET',
    pathname: '/v0/webui/accounts'
  }));
  const frame = await new Promise((resolve, reject) => {
    session.socket.once('message', (data) => {
      try {
        resolve(JSON.parse(data.toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    session.socket.once('error', reject);
  });

  assert.equal(fetchCalled, false);
  assert.equal(frame.type, 'relay.stream.error');
  assert.equal(frame.streamId, 'stream-1');
  assert.equal(frame.status, 403);
  assert.equal(frame.error, 'relay_local_stream_route_not_allowed');
  registry.closeAll();
  await relayRun;
});

test('fetchLocalRelayRequest rejects non allowlisted local route', async () => {
  let fetchCalled = false;
  const result = await fetchLocalRelayRequest({
    method: 'GET',
    pathname: '/v0/webui/accounts',
    requestId: 'request-1'
  }, {
    localBaseUrl: 'http://127.0.0.1:9527',
    managementKey: 'node-secret'
  }, {
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error('fetch_should_not_run');
    }
  });

  assert.equal(fetchCalled, false);
  assert.equal(result.status, 403);
  assert.equal(result.ok, false);
  assert.equal(result.payload.error, 'relay_local_route_not_allowed');
});

test('fetchLocalRelayRequest forwards node-rpc status to local server', async () => {
  let observed = null;
  const result = await fetchLocalRelayRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/status?summary=1',
    requestId: 'request-1'
  }, {
    localBaseUrl: 'http://127.0.0.1:9527',
    managementKey: 'node-secret'
  }, {
    fetchImpl: async (url, options) => {
      observed = {
        url,
        method: options.method,
        authorization: options.headers.authorization
      };
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ ok: true, service: 'node-rpc' })
      };
    }
  });

  assert.deepEqual(observed, {
    url: 'http://127.0.0.1:9527/v0/node-rpc/status?summary=1',
    method: 'GET',
    authorization: 'Bearer node-secret'
  });
  assert.equal(result.status, 200);
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, { ok: true, service: 'node-rpc' });
});

test('fetchLocalRelayRequest forwards node-rpc session messages to local server', async () => {
  let observed = null;
  const result = await fetchLocalRelayRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/session-messages?sessionRef=sess_0123456789abcdefabcd&limit=2',
    requestId: 'request-1'
  }, {
    localBaseUrl: 'http://127.0.0.1:9527',
    managementKey: 'node-secret'
  }, {
    fetchImpl: async (url, options) => {
      observed = {
        url,
        method: options.method,
        authorization: options.headers.authorization
      };
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ ok: true, rpc: 'node.session_messages', result: { messages: [] } })
      };
    }
  });

  assert.deepEqual(observed, {
    url: 'http://127.0.0.1:9527/v0/node-rpc/session-messages?sessionRef=sess_0123456789abcdefabcd&limit=2',
    method: 'GET',
    authorization: 'Bearer node-secret'
  });
  assert.equal(result.status, 200);
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, { ok: true, rpc: 'node.session_messages', result: { messages: [] } });
});

test('fetchLocalRelayRequest forwards node-rpc sessions to local server', async () => {
  let observed = null;
  const result = await fetchLocalRelayRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/sessions?limit=2',
    requestId: 'request-1'
  }, {
    localBaseUrl: 'http://127.0.0.1:9527',
    managementKey: 'node-secret'
  }, {
    fetchImpl: async (url, options) => {
      observed = {
        url,
        method: options.method,
        authorization: options.headers.authorization
      };
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ ok: true, rpc: 'node.sessions', result: { sessions: [] } })
      };
    }
  });

  assert.deepEqual(observed, {
    url: 'http://127.0.0.1:9527/v0/node-rpc/sessions?limit=2',
    method: 'GET',
    authorization: 'Bearer node-secret'
  });
  assert.equal(result.status, 200);
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, { ok: true, rpc: 'node.sessions', result: { sessions: [] } });
});

test('fetchLocalRelayRequest forwards typed node-rpc session input body to local server', async () => {
  let observed = null;
  const result = await fetchLocalRelayRequest({
    method: 'POST',
    pathname: '/v0/node-rpc/session-input',
    body: JSON.stringify({
      sessionRef: 'sess_0123456789abcdefabcd',
      input: 'remote yes',
      appendNewline: true
    }),
    requestId: 'request-1'
  }, {
    localBaseUrl: 'http://127.0.0.1:9527',
    managementKey: 'node-secret'
  }, {
    fetchImpl: async (url, options) => {
      observed = {
        url,
        method: options.method,
        authorization: options.headers.authorization,
        contentType: options.headers['content-type'],
        body: options.body
      };
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ ok: true, rpc: 'node.session_input', result: { accepted: true } })
      };
    }
  });

  assert.deepEqual(observed, {
    url: 'http://127.0.0.1:9527/v0/node-rpc/session-input',
    method: 'POST',
    authorization: 'Bearer node-secret',
    contentType: 'application/json',
    body: JSON.stringify({
      sessionRef: 'sess_0123456789abcdefabcd',
      input: 'remote yes',
      appendNewline: true
    })
  });
  assert.equal(result.status, 200);
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, { ok: true, rpc: 'node.session_input', result: { accepted: true } });
});

test('fetchLocalRelayRequest forwards session catalog and attach contract to local server', async () => {
  const observed = [];
  const catalog = await fetchLocalRelayRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/session-catalog?limit=2',
    requestId: 'request-catalog'
  }, {
    localBaseUrl: 'http://127.0.0.1:9527',
    managementKey: 'node-secret'
  }, {
    fetchImpl: async (url, options) => {
      observed.push({
        url,
        method: options.method,
        authorization: options.headers.authorization,
        contentType: options.headers['content-type'],
        body: options.body
      });
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ ok: true, rpc: 'node.session_catalog', result: { sessions: [] } })
      };
    }
  });

  assert.deepEqual(observed[0], {
    url: 'http://127.0.0.1:9527/v0/node-rpc/session-catalog?limit=2',
    method: 'GET',
    authorization: 'Bearer node-secret',
    contentType: undefined,
    body: undefined
  });
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.payload, { ok: true, rpc: 'node.session_catalog', result: { sessions: [] } });

  const attach = await fetchLocalRelayRequest({
    method: 'POST',
    pathname: '/v0/node-rpc/session-attach',
    body: JSON.stringify({ sessionId: 'run-1', cursor: 2 }),
    requestId: 'request-attach'
  }, {
    localBaseUrl: 'http://127.0.0.1:9527',
    managementKey: 'node-secret'
  }, {
    fetchImpl: async (url, options) => {
      observed.push({
        url,
        method: options.method,
        authorization: options.headers.authorization,
        contentType: options.headers['content-type'],
        body: options.body
      });
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ ok: true, rpc: 'node.session_attach', result: { sessionId: 'run-1' } })
      };
    }
  });

  assert.deepEqual(observed[1], {
    url: 'http://127.0.0.1:9527/v0/node-rpc/session-attach',
    method: 'POST',
    authorization: 'Bearer node-secret',
    contentType: 'application/json',
    body: JSON.stringify({ sessionId: 'run-1', cursor: 2 })
  });
  assert.equal(attach.status, 200);
  assert.deepEqual(attach.payload, { ok: true, rpc: 'node.session_attach', result: { sessionId: 'run-1' } });

  const command = await fetchLocalRelayRequest({
    method: 'POST',
    pathname: '/v0/node-rpc/session-command',
    body: JSON.stringify({
      type: 'message',
      sessionId: 'run-1',
      text: 'relay command',
      idempotencyKey: 'idem-relay-command'
    }),
    requestId: 'request-command'
  }, {
    localBaseUrl: 'http://127.0.0.1:9527',
    managementKey: 'node-secret'
  }, {
    fetchImpl: async (url, options) => {
      observed.push({
        url,
        method: options.method,
        authorization: options.headers.authorization,
        contentType: options.headers['content-type'],
        body: options.body
      });
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ ok: true, rpc: 'node.session_command', result: { accepted: true } })
      };
    }
  });

  assert.deepEqual(observed[2], {
    url: 'http://127.0.0.1:9527/v0/node-rpc/session-command',
    method: 'POST',
    authorization: 'Bearer node-secret',
    contentType: 'application/json',
    body: JSON.stringify({
      type: 'message',
      sessionId: 'run-1',
      text: 'relay command',
      idempotencyKey: 'idem-relay-command'
    })
  });
  assert.equal(command.status, 200);
  assert.deepEqual(command.payload, { ok: true, rpc: 'node.session_command', result: { accepted: true } });

  const ack = await fetchLocalRelayRequest({
    method: 'POST',
    pathname: '/v0/node-rpc/session-ack',
    body: JSON.stringify({ sessionId: 'run-1', cursor: 12, consumerId: 'phone' }),
    requestId: 'request-ack'
  }, {
    localBaseUrl: 'http://127.0.0.1:9527',
    managementKey: 'node-secret'
  }, {
    fetchImpl: async (url, options) => {
      observed.push({
        url,
        method: options.method,
        authorization: options.headers.authorization,
        contentType: options.headers['content-type'],
        body: options.body
      });
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ ok: true, rpc: 'node.session_ack', result: { accepted: true, cursor: 12 } })
      };
    }
  });

  assert.deepEqual(observed[3], {
    url: 'http://127.0.0.1:9527/v0/node-rpc/session-ack',
    method: 'POST',
    authorization: 'Bearer node-secret',
    contentType: 'application/json',
    body: JSON.stringify({ sessionId: 'run-1', cursor: 12, consumerId: 'phone' })
  });
  assert.equal(ack.status, 200);
  assert.deepEqual(ack.payload, { ok: true, rpc: 'node.session_ack', result: { accepted: true, cursor: 12 } });
});

test('fetchLocalRelayRequest forwards native session start and run controls to local server', async () => {
  const observed = [];
  const result = await fetchLocalRelayRequest({
    method: 'POST',
    pathname: '/v0/node-rpc/session-start',
    body: JSON.stringify({
      provider: 'codex',
      accountId: '3',
      prompt: 'relay start'
    }),
    requestId: 'request-start'
  }, {
    localBaseUrl: 'http://127.0.0.1:9527',
    managementKey: 'node-secret'
  }, {
    fetchImpl: async (url, options) => {
      observed.push({
        url,
        method: options.method,
        authorization: options.headers.authorization,
        contentType: options.headers['content-type'],
        body: options.body
      });
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ ok: true, rpc: 'node.session_start', result: { runId: 'run-1' } })
      };
    }
  });

  assert.deepEqual(observed[0], {
    url: 'http://127.0.0.1:9527/v0/node-rpc/session-start',
    method: 'POST',
    authorization: 'Bearer node-secret',
    contentType: 'application/json',
    body: JSON.stringify({
      provider: 'codex',
      accountId: '3',
      prompt: 'relay start'
    })
  });
  assert.equal(result.status, 200);
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, { ok: true, rpc: 'node.session_start', result: { runId: 'run-1' } });

  const events = await fetchLocalRelayRequest({
    method: 'GET',
    pathname: '/v0/node-rpc/session-run-events?runId=run-1&cursor=2',
    requestId: 'request-events'
  }, {
    localBaseUrl: 'http://127.0.0.1:9527',
    managementKey: 'node-secret'
  }, {
    fetchImpl: async (url, options) => {
      observed.push({
        url,
        method: options.method,
        authorization: options.headers.authorization
      });
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ ok: true, rpc: 'node.session_run_events', result: { events: [] } })
      };
    }
  });
  assert.deepEqual(observed[1], {
    url: 'http://127.0.0.1:9527/v0/node-rpc/session-run-events?runId=run-1&cursor=2',
    method: 'GET',
    authorization: 'Bearer node-secret'
  });
  assert.equal(events.ok, true);

  const input = await fetchLocalRelayRequest({
    method: 'POST',
    pathname: '/v0/node-rpc/session-run-input',
    body: JSON.stringify({ runId: 'run-1', input: '/status' }),
    requestId: 'request-input'
  }, {
    localBaseUrl: 'http://127.0.0.1:9527',
    managementKey: 'node-secret'
  }, {
    fetchImpl: async (url, options) => {
      observed.push({
        url,
        method: options.method,
        authorization: options.headers.authorization,
        contentType: options.headers['content-type'],
        body: options.body
      });
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ ok: true, rpc: 'node.session_run_input', result: { accepted: true } })
      };
    }
  });
  assert.deepEqual(observed[2], {
    url: 'http://127.0.0.1:9527/v0/node-rpc/session-run-input',
    method: 'POST',
    authorization: 'Bearer node-secret',
    contentType: 'application/json',
    body: JSON.stringify({ runId: 'run-1', input: '/status' })
  });
  assert.equal(input.ok, true);

  const abort = await fetchLocalRelayRequest({
    method: 'POST',
    pathname: '/v0/node-rpc/session-run-abort',
    body: JSON.stringify({ runId: 'run-1' }),
    requestId: 'request-abort'
  }, {
    localBaseUrl: 'http://127.0.0.1:9527',
    managementKey: 'node-secret'
  }, {
    fetchImpl: async (url, options) => {
      observed.push({
        url,
        method: options.method,
        authorization: options.headers.authorization,
        contentType: options.headers['content-type'],
        body: options.body
      });
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ ok: true, rpc: 'node.session_run_abort', result: { accepted: true } })
      };
    }
  });
  assert.deepEqual(observed[3], {
    url: 'http://127.0.0.1:9527/v0/node-rpc/session-run-abort',
    method: 'POST',
    authorization: 'Bearer node-secret',
    contentType: 'application/json',
    body: JSON.stringify({ runId: 'run-1' })
  });
  assert.equal(abort.ok, true);
});

test('runNodeCommandRouter routes relay connect without leaking management key', async () => {
  const writes = [];
  const errors = [];
  const exits = [];
  const observedArgs = [];

  await runNodeCommandRouter([
    'node',
    'relay',
    'connect',
    'https://control.example.com',
    '--node-id',
    'nat-node',
    '--management-key',
    'node-secret',
    '--once'
  ], {
    runNodeRelayConnect: async (args) => {
      observedArgs.push(args);
      return {
        ok: true,
        nodeId: 'nat-node',
        relayUrl: 'wss://control.example.com/v0/relay/node?nodeId=nat-node',
        sessionId: 'session-1',
        transportId: 'nat-node-relay',
        attempts: 1,
        once: true,
        json: false
      };
    },
    processObj: {
      stdout: { write: (value) => writes.push(String(value)) },
      exit: (code) => exits.push(code)
    },
    consoleImpl: {
      log: (value) => writes.push(String(value)),
      error: (value) => errors.push(String(value))
    }
  });

  assert.deepEqual(observedArgs[0], [
    'https://control.example.com',
    '--node-id',
    'nat-node',
    '--management-key',
    'node-secret',
    '--once'
  ]);
  assert.equal(writes.join('\n').includes('node-secret'), false);
  assert.equal(errors.join('\n').includes('node-secret'), false);
  assert.deepEqual(exits, [0]);
});

test('runNodeCommandRouter routes relay service install without leaking management key', async () => {
  const writes = [];
  const errors = [];
  const exits = [];
  const observedArgs = [];

  await runNodeCommandRouter([
    'node',
    'relay',
    'service',
    'install',
    'https://control.example.com',
    '--node-id',
    'nat-node'
  ], {
    runNodeRelayService: (args) => {
      observedArgs.push(args);
      return {
        ok: true,
        action: 'install',
        nodeId: 'nat-node',
        status: {
          type: 'systemd-user',
          file: '/home/model/.config/systemd/user/com.clawdcodex.ai_home.node-relay.nat-node.service',
          installed: true,
          loaded: true,
          state: 'running',
          running: true,
          issues: [],
          nextActions: [{
            label: 'Inspect relay logs',
            command: 'journalctl --user -u com.clawdcodex.ai_home.node-relay.nat-node.service -n 80 --no-pager'
          }]
        },
        json: false
      };
    },
    processObj: {
      stdout: { write: (value) => writes.push(String(value)) },
      exit: (code) => exits.push(code)
    },
    consoleImpl: {
      log: (value) => writes.push(String(value)),
      error: (value) => errors.push(String(value))
    }
  });

  assert.deepEqual(observedArgs[0], [
    'install',
    'https://control.example.com',
    '--node-id',
    'nat-node'
  ]);
  assert.equal(writes.join('\n').includes('node-secret'), false);
  assert.match(writes.join('\n'), /service state: running/);
  assert.match(writes.join('\n'), /running: yes/);
  assert.match(writes.join('\n'), /Inspect relay logs/);
  assert.equal(errors.join('\n').includes('node-secret'), false);
  assert.deepEqual(exits, [0]);
});
