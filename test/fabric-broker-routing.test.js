const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');

const { runFabricCommandRouter } = require('../lib/cli/commands/fabric-router');
const {
  handleFabricBrokerControlUpgrade,
  handleFabricBrokerProxyRequest,
  isFabricBrokerRouteAllowed,
  parseBrokerProxyPath
} = require('../lib/server/fabric-broker-router');
const { createFabricBrokerSessionRegistry } = require('../lib/server/fabric-broker-session-registry');
const {
  buildLocalRequestUrl,
  connectFabricBroker,
  normalizeBrokerUrl,
  parseFabricBrokerConnectArgs,
  runFabricBrokerConnect
} = require('../lib/cli/services/fabric/broker-connect');
const {
  brokerProxyBase,
  parseArgs: parseRealBrokerSmokeArgs
} = require('../scripts/fabric-real-broker-smoke');

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
  return new Promise((resolve) => {
    if (!server || !server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
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

function writeJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.end(body);
}

function readRequestBody(req, options = {}) {
  const maxBytes = Number(options.maxBytes || 1024 * 1024);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

test('parseFabricBrokerConnectArgs normalizes broker and local endpoints', () => {
  const options = parseFabricBrokerConnectArgs([
    'https://broker.example.com/root',
    '--server-id',
    'Home Server',
    '--token',
    'broker-token',
    '--local-url',
    'http://127.0.0.1:9527/',
    '--reconnect-delay-ms',
    '500',
    '--max-attempts',
    '3',
    '--once',
    '--json'
  ], { env: {} });

  assert.equal(options.brokerUrl, 'wss://broker.example.com/v0/fabric/broker/control');
  assert.equal(options.serverId, 'home-server');
  assert.equal(options.managementKey, 'broker-token');
  assert.deepEqual(options.brokers, [{
    brokerUrl: 'wss://broker.example.com/v0/fabric/broker/control',
    managementKey: 'broker-token'
  }]);
  assert.equal(options.localUrl, 'http://127.0.0.1:9527');
  assert.equal(options.reconnectDelayMs, 500);
  assert.equal(options.maxAttempts, 3);
  assert.equal(options.once, true);
  assert.equal(options.json, true);
});

test('broker session registry keeps last disconnect diagnostics', () => {
  let now = 1000;
  const registry = createFabricBrokerSessionRegistry({
    nowMs: () => now,
    createSessionId: () => 'session-a'
  });
  const socket = { readyState: 1, close: () => {} };
  registry.registerBrokerSession({
    serverId: 'Home Server',
    socket,
    remoteAddress: '127.0.0.1'
  });
  assert.equal(registry.getBrokerServerStatus('home-server').online, true);
  socket.readyState = 3;
  assert.equal(registry.getBrokerServerStatus('home-server').online, false);
  socket.readyState = 1;
  now = 1500;
  registry.touchBrokerSession('session-a');
  now = 2000;
  registry.removeBrokerSession('session-a', {
    reason: 'broker_server_link_closed',
    closeCode: 1006,
    closeReason: 'network drop'
  });

  assert.deepEqual(registry.getBrokerServerStatus('home-server'), {
    serverId: 'home-server',
    online: false,
    session: null,
    lastDisconnected: {
      sessionId: 'session-a',
      serverId: 'home-server',
      remoteAddress: '127.0.0.1',
      connectedAt: 1000,
      lastSeenAt: 1500,
      disconnectedAt: 2000,
      disconnectReason: 'broker_server_link_closed',
      closeCode: 1006,
      closeReason: 'network drop'
    }
  });
});

test('broker route allowlist is limited to Client API and public Server diagnostics', () => {
  assert.equal(isFabricBrokerRouteAllowed('GET', '/healthz'), true);
  assert.equal(isFabricBrokerRouteAllowed('GET', '/readyz'), true);
  assert.equal(isFabricBrokerRouteAllowed('GET', '/v0/fabric/descriptor'), true);
  assert.equal(isFabricBrokerRouteAllowed('GET', '/v0/webui/projects'), true);
  assert.equal(isFabricBrokerRouteAllowed('POST', '/v0/webui/chat'), true);
  assert.equal(isFabricBrokerRouteAllowed('DELETE', '/v0/webui/accounts/claude/account-1'), true);
  assert.equal(isFabricBrokerRouteAllowed('POST', '/v0/webui/server-config/management-key/rotate'), false);
  assert.equal(isFabricBrokerRouteAllowed('GET', '/v0/node-rpc/device-profile'), false);
  assert.equal(isFabricBrokerRouteAllowed('GET', '/v0/management/accounts'), false);
  assert.equal(isFabricBrokerRouteAllowed('POST', '/v1/responses'), false);
});

test('broker proxy path preserves target path and query', () => {
  assert.deepEqual(parseBrokerProxyPath(
    '/v0/fabric/broker/servers/Home Server/proxy/v0/fabric/descriptor',
    '?x=1'
  ), {
    serverId: 'home-server',
    targetPath: '/v0/fabric/descriptor?x=1'
  });
  assert.equal(buildLocalRequestUrl('http://127.0.0.1:9527', '/v0/fabric/descriptor?x=1'), 'http://127.0.0.1:9527/v0/fabric/descriptor?x=1');
  assert.equal(normalizeBrokerUrl('http://127.0.0.1:9527'), 'ws://127.0.0.1:9527/v0/fabric/broker/control');

  assert.deepEqual(parseBrokerProxyPath(
    '/v0/fabric/broker/servers/home-server/proxy/v0/webui/a/../projects',
    '?page=1'
  ), {
    serverId: 'home-server',
    targetPath: '/v0/webui/projects?page=1'
  });
  [
    '/v0/fabric/broker/servers/home-server/proxy//attacker.invalid/v0/webui/projects',
    '/v0/fabric/broker/servers/home-server/proxy/\\attacker.invalid/v0/webui/projects',
    '/v0/fabric/broker/servers/home-server/proxy/v0/webui%2Fprojects'
  ].forEach((pathname) => {
    const parsed = parseBrokerProxyPath(pathname);
    assert.equal(parsed.serverId, 'home-server');
    assert.equal(parsed.targetPath, '');
    assert.equal(isFabricBrokerRouteAllowed('GET', parsed.targetPath), false);
  });
});

test('real broker smoke parser defaults to existing 9527 endpoint', () => {
  const options = parseRealBrokerSmokeArgs([
    '--server-id',
    'Local Default'
  ], {
    AIH_FABRIC_BROKER_TOKEN: 'broker-token',
    AIH_MANAGEMENT_KEY: 'management-secret'
  });

  assert.equal(options.endpoint, 'http://127.0.0.1:9527');
  assert.equal(options.localUrl, 'http://127.0.0.1:9527');
  assert.equal(options.serverId, 'local-default');
  assert.equal(options.managementKey, 'management-secret');
  assert.equal(brokerProxyBase(options.endpoint, options.serverId), 'http://127.0.0.1:9527/v0/fabric/broker/servers/local-default/proxy');
});

test('broker connect proxies real HTTP requests over real WebSocket sockets', async (t) => {
  const localRequests = [];
  const localServer = http.createServer(async (req, res) => {
    const body = await readRequestBody(req);
    localRequests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization || '',
      body: body.toString('utf8')
    });
    if (req.url === '/readyz') {
      writeJson(res, 200, { ok: true, service: 'local-aih', ready: true });
      return;
    }
    if (req.url === '/v0/fabric/descriptor') {
      writeJson(res, 200, {
        ok: true,
        rpc: 'fabric.descriptor.read',
        result: {
          service: 'aih-fabric',
          server: { id: 'host-derived-id', name: 'Home Mac' },
          capabilities: { clientApi: true, streams: ['sse', 'blob'] }
        }
      });
      return;
    }
    if (req.url === '/v0/webui/projects') {
      writeJson(res, 200, {
        ok: true,
        projects: [{ path: '/workspace/app', name: 'app' }],
        authorization: req.headers.authorization || ''
      });
      return;
    }
    if (req.url === '/v0/webui/chat') {
      writeJson(res, 200, {
        ok: true,
        runId: 'broker-run-1',
        body: JSON.parse(body.toString('utf8')),
        authorization: req.headers.authorization || ''
      });
      return;
    }
    writeJson(res, 404, { ok: false, error: 'not_found' });
  });
  const localAddress = await listen(localServer);
  t.after(() => closeServer(localServer));

  const registry = createFabricBrokerSessionRegistry();
  const brokerServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const handled = await handleFabricBrokerProxyRequest({
      method: req.method,
      pathname: url.pathname,
      url,
      req,
      res,
      requiredManagementKey: 'broker-token',
      deps: {
        writeJson,
        readRequestBody,
        requiredManagementKey: 'broker-token',
        fabricBrokerSessionRegistry: registry
      }
    });
    if (!handled) writeJson(res, 404, { ok: false, error: 'not_found' });
  });
  brokerServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/v0/fabric/broker/control') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    handleFabricBrokerControlUpgrade({
      req,
      socket,
      head,
      deps: {
        WebSocket,
        fabricBrokerSessionRegistry: registry,
        requiredManagementKey: 'broker-token'
      }
    });
  });
  const brokerAddress = await listen(brokerServer);
  t.after(() => closeServer(brokerServer));

  const brokerHandle = await connectFabricBroker({
    brokerUrl: `http://127.0.0.1:${brokerAddress.port}`,
    serverId: 'home-server',
    managementKey: 'broker-token',
    localUrl: `http://127.0.0.1:${localAddress.port}`,
    connectTimeoutMs: 3000,
    requestTimeoutMs: 3000,
    heartbeatMs: 1000
  }, { WebSocket });
  t.after(() => brokerHandle.close());

  await waitForCondition(() => {
    const servers = registry.listBrokerServers();
    return servers.length === 1 && servers[0].name === 'Home Mac';
  });
  const discovery = await fetch(`http://127.0.0.1:${brokerAddress.port}/v0/fabric/broker/servers`, {
    headers: { authorization: 'Bearer broker-token' }
  });
  assert.equal(discovery.status, 200);
  const discoveredServers = (await discovery.json()).result.servers;
  assert.equal(discoveredServers[0].stableServerId, 'home-server');
  assert.equal(discoveredServers[0].name, 'Home Mac');
  assert.equal(discoveredServers[0].routes.at(-1).kind, 'relay');

  const ready = await fetch(`http://127.0.0.1:${brokerAddress.port}/v0/fabric/broker/servers/home-server/proxy/readyz`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { ok: true, service: 'local-aih', ready: true });

  const descriptor = await fetch(`http://127.0.0.1:${brokerAddress.port}/v0/fabric/broker/servers/home-server/proxy/v0/fabric/descriptor`, {
    headers: { authorization: 'Bearer management-secret' }
  });
  assert.equal(descriptor.status, 200);
  assert.equal((await descriptor.json()).result.service, 'aih-fabric');

  assert.equal(localRequests.some((entry) => entry.url === '/readyz'), true);
  const descriptorRequest = localRequests.filter((entry) => entry.url === '/v0/fabric/descriptor').at(-1);
  assert.equal(descriptorRequest.authorization, 'Bearer management-secret');

  const projects = await fetch(`http://127.0.0.1:${brokerAddress.port}/v0/fabric/broker/servers/home-server/proxy/v0/webui/projects`, {
    headers: { authorization: 'Bearer management-secret' }
  });
  assert.equal(projects.status, 200);
  const projectsPayload = await projects.json();
  assert.equal(projectsPayload.projects[0].path, '/workspace/app');
  assert.equal(projectsPayload.authorization, 'Bearer management-secret');
  const projectsRequest = localRequests.find((entry) => entry.url === '/v0/webui/projects');
  assert.equal(projectsRequest.authorization, 'Bearer management-secret');

  const chat = await fetch(`http://127.0.0.1:${brokerAddress.port}/v0/fabric/broker/servers/home-server/proxy/v0/webui/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer management-secret'
    },
    body: JSON.stringify({
      provider: 'claude',
      message: 'broker command'
    })
  });
  assert.equal(chat.status, 200);
  const chatPayload = await chat.json();
  assert.equal(chatPayload.runId, 'broker-run-1');
  assert.equal(chatPayload.body.message, 'broker command');
  assert.equal(chatPayload.authorization, 'Bearer management-secret');
  const chatRequest = localRequests.find((entry) => entry.url === '/v0/webui/chat');
  assert.equal(chatRequest.authorization, 'Bearer management-secret');

  brokerHandle.close();
  await waitForCondition(() => {
    const status = registry.getBrokerServerStatus('home-server');
    return status.online === false && Boolean(status.lastDisconnected);
  });
  const offline = await fetch(`http://127.0.0.1:${brokerAddress.port}/v0/fabric/broker/servers/home-server/proxy/readyz`);
  assert.equal(offline.status, 503);
  const offlinePayload = await offline.json();
  assert.equal(offlinePayload.error, 'fabric_broker_server_offline');
  assert.equal(offlinePayload.brokerStatus.online, false);
  assert.equal(offlinePayload.brokerStatus.lastDisconnected.disconnectReason, 'broker_server_link_closed');
});

test('runFabricBrokerConnect foreground reconnects with bounded attempts', async () => {
  const calls = [];
  const result = await runFabricBrokerConnect([
    'http://broker.example.com',
    '--server-id',
    'home-server',
    '--token',
    'broker-token',
    '--max-attempts',
    '2',
    '--reconnect-delay-ms',
    '250',
    '--json'
  ], {
    env: {},
    sleep: async () => {},
    connectFabricBroker: async (options) => {
      calls.push(options);
      const attempt = calls.length;
      return {
        serverId: options.serverId,
        brokerUrl: options.brokerUrl,
        localUrl: options.localUrl,
        sessionId: `session-${attempt}`,
        diagnostics: {
          connectedAt: attempt * 1000,
          lastHeartbeatAt: attempt * 1000 + 100,
          lastPongAt: attempt * 1000 + 200
        },
        closed: Promise.resolve({
          ok: true,
          reason: 'closed',
          code: 1006,
          closeReason: 'network drop',
          connectedAt: attempt * 1000,
          lastHeartbeatAt: attempt * 1000 + 100,
          lastPongAt: attempt * 1000 + 200,
          disconnectedAt: attempt * 1000 + 300
        }),
        close: () => {}
      };
    }
  });

  assert.equal(calls.length, 2);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.sessionId, 'session-2');
  assert.equal(result.reason, 'closed');
  assert.equal(result.closeCode, 1006);
  assert.equal(result.closeReason, 'network drop');
  assert.equal(result.lastPongAt, 2200);
});

test('runFabricCommandRouter exposes broker connect JSON result', async () => {
  const writes = [];
  const exits = [];
  await runFabricCommandRouter([
    'fabric',
    'broker',
    'connect',
    'http://127.0.0.1:9527',
    '--server-id',
    'home-server',
    '--token',
    'token',
    '--once',
    '--json'
  ], {
    processObj: {
      stdout: { write: (value) => writes.push(String(value)) },
      exit: (code) => exits.push(code)
    },
    consoleImpl: {
      log: () => {},
      error: () => {}
    },
    runFabricBrokerConnect: async (args) => ({
      ok: true,
      json: args.includes('--json'),
      serverId: 'home-server',
      brokerUrl: 'ws://127.0.0.1:9527/v0/fabric/broker/control',
      localUrl: 'http://127.0.0.1:9527',
      sessionId: 'session-1',
      mode: 'once'
    })
  });

  assert.deepEqual(exits, [0]);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.ok, true);
  assert.equal(payload.serverId, 'home-server');
  assert.equal(payload.mode, 'once');
});
