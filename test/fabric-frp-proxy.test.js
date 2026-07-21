'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  handleFabricBrokerProxyRequest
} = require('../lib/server/fabric-broker-router');
const {
  createFabricBrokerSessionRegistry,
  normalizeFabricServerId
} = require('../lib/server/fabric-broker-session-registry');
const {
  listManagedFrpRoutes,
  normalizeStableServerId
} = require('../lib/server/frp-route-registry');
const {
  normalizeFragmentOptions
} = require('../lib/cli/services/fabric/frp-config-document');
const {
  normalizeApplyPayload
} = require('../lib/server/webui-frp-config-routes');

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

function writeJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-length', String(body.length));
  res.end(body);
}

function writeDescriptor(res, stableServerId = 'server-home', name = stableServerId) {
  writeJson(res, 200, {
    ok: true,
    rpc: 'fabric.descriptor.read',
    result: {
      ok: true,
      service: 'aih-fabric',
      server: {
        id: stableServerId,
        name
      }
    }
  });
}

function readRequestBody(req, options = {}) {
  const maxBytes = Math.max(1, Number(options.maxBytes) || 1024 * 1024);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error('request_body_too_large');
        error.code = 'request_body_too_large';
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function createAwsHarness(t, options = {}) {
  const registry = options.registry || createFabricBrokerSessionRegistry();
  const routes = options.routes || [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const handled = await handleFabricBrokerProxyRequest({
      method: req.method,
      pathname: url.pathname,
      url,
      req,
      res,
      requiredManagementKey: options.awsManagementKey || 'aws-management-key',
      deps: {
        writeJson,
        readRequestBody,
        requiredManagementKey: options.awsManagementKey || 'aws-management-key',
        fabricBrokerSessionRegistry: registry,
        listFrpVisitorRoutes: () => routes,
        ...options.deps
      }
    });
    if (!handled && !res.writableEnded) {
      writeJson(res, 404, { ok: false, error: 'not_found' });
    }
  });
  const address = await listen(server);
  t.after(() => closeServer(server));
  return {
    origin: `http://127.0.0.1:${address.port}`,
    registry
  };
}

function requestFirstChunk(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      res.once('data', (chunk) => resolve({ req, res, chunk }));
      res.once('error', reject);
    });
    req.once('error', reject);
    req.end(options.body);
  });
}

function requestHeaders(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => resolve({ req, res }));
    req.once('error', reject);
    req.end(options.body);
  });
}

function waitForSignal(register, timeoutMs = 1500) {
  return Promise.race([
    new Promise((resolve) => register(resolve)),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('signal_timeout')), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    })
  ]);
}

function withTimeout(promise, timeoutMs = 1500) {
  return waitForSignal((resolve) => {
    Promise.resolve(promise).then(resolve);
  }, timeoutMs);
}

test('FRP and Broker reject non-canonical or oversized stable Server IDs without truncation', () => {
  const nearMaxLengthId = `s${'a'.repeat(62)}`;
  const maxLengthId = `s${'a'.repeat(63)}`;
  const oversizedId = `${maxLengthId}b`;

  assert.equal(nearMaxLengthId.length, 63);
  assert.equal(normalizeFabricServerId(nearMaxLengthId), nearMaxLengthId);
  assert.equal(normalizeStableServerId(nearMaxLengthId), nearMaxLengthId);
  assert.equal(normalizeFabricServerId(maxLengthId), maxLengthId);
  assert.equal(normalizeStableServerId(maxLengthId), maxLengthId);
  assert.equal(normalizeFabricServerId(oversizedId), '');
  assert.equal(normalizeStableServerId(oversizedId), '');
  assert.equal(normalizeStableServerId('Home Server'), '');
  assert.throws(() => normalizeFragmentOptions({
    role: 'visitor',
    serverId: oversizedId,
    secretKey: 'secret'
  }), { code: 'frp_server_id_invalid' });
  assert.equal(normalizeApplyPayload({
    role: 'visitor',
    stableServerId: oversizedId,
    secretKey: 'secret',
    bindPort: 19527
  }, { options: { port: 9527 } }), null);
});

test('FRP route registry drops conflicting duplicate Visitor bindings', () => {
  const routes = listManagedFrpRoutes({ fs: {}, aiHomeDir: '/tmp/aih' }, {
    readJsonValue: () => ({
      routes: [
        { stableServerId: 'server-home', name: 'Home A', bindPort: 19527 },
        { stableServerId: 'server-home', name: 'Home B', bindPort: 19528 }
      ]
    }),
    nowMs: () => 1234
  });

  assert.deepEqual(routes, []);
});

test('AWS directory merges FRP Visitor routes with broker servers by stable Server ID', async (t) => {
  const registry = createFabricBrokerSessionRegistry({
    createSessionId: () => 'broker-session-home'
  });
  registry.registerBrokerSession({
    serverId: 'server-home',
    socket: { readyState: 1, close() {} },
    descriptor: {
      name: 'Home from broker',
      capabilities: { clientApi: true },
      routes: [{ kind: 'direct-lan', endpoint: 'http://192.168.1.20:9527' }]
    }
  });
  registry.registerBrokerSession({
    sessionId: 'broker-session-lab-before-disconnect',
    serverId: 'server-lab',
    socket: { readyState: 1, close() {} },
    descriptor: { name: 'Lab before disconnect' }
  });
  registry.removeBrokerSession('broker-session-lab-before-disconnect', {
    reason: 'broker_server_link_closed'
  });
  const harness = await createAwsHarness(t, {
    registry,
    routes: [
      {
        stableServerId: 'server-home',
        name: 'Home from FRP',
        bindPort: 19527,
        endpoint: 'http://127.0.0.1:19527',
        health: 'healthy',
        secretKey: 'must-never-leak'
      },
      {
        stableServerId: 'server-lab',
        name: 'Lab Server',
        bindPort: 19528,
        endpoint: 'http://127.0.0.1:19528',
        health: 'degraded'
      }
    ]
  });

  const response = await fetch(`${harness.origin}/v0/fabric/broker/servers`, {
    headers: {
      authorization: 'Bearer aws-management-key',
      'x-forwarded-host': 'attacker.invalid',
      'x-forwarded-proto': 'javascript'
    }
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.result.servers.length, 2);
  const home = payload.result.servers.find((server) => server.stableServerId === 'server-home');
  const lab = payload.result.servers.find((server) => server.stableServerId === 'server-lab');
  assert.equal(home.name, 'Home from broker');
  assert.deepEqual(home.routes.find((route) => route.kind === 'relay'), {
    kind: 'relay',
    path: '/v0/fabric/broker/servers/server-home/proxy'
  });
  assert.equal(home.routes.filter((route) => route.kind === 'frp').length, 1);
  assert.deepEqual(home.routes.find((route) => route.kind === 'frp'), {
    kind: 'frp',
    path: '/v0/fabric/frp/servers/server-home/proxy',
    health: 'healthy'
  });
  assert.deepEqual(lab, {
    stableServerId: 'server-lab',
    name: 'Lab Server',
    capabilities: {},
    routes: [{
      kind: 'frp',
      path: '/v0/fabric/frp/servers/server-lab/proxy',
      health: 'degraded'
    }]
  });
  assert.equal(Object.hasOwn(home, 'bindPort'), false);
  assert.equal(Object.hasOwn(lab, 'bindPort'), false);
  assert.equal(home.routes.some((route) => Object.hasOwn(route, 'bindPort')), false);
  assert.equal(lab.routes.some((route) => Object.hasOwn(route, 'bindPort')), false);
  assert.equal(JSON.stringify(payload).includes('must-never-leak'), false);
  assert.equal(JSON.stringify(payload).includes('attacker.invalid'), false);
});

test('conflicting Visitor records are neither published nor used for proxying', async (t) => {
  const harness = await createAwsHarness(t, {
    routes: [
      { stableServerId: 'server-home', name: 'Home A', bindPort: 19527 },
      { stableServerId: 'server-home', name: 'Home B', bindPort: 19528 }
    ]
  });

  const directory = await fetch(`${harness.origin}/v0/fabric/broker/servers`, {
    headers: { authorization: 'Bearer aws-management-key' }
  });
  assert.equal(directory.status, 200);
  assert.deepEqual((await directory.json()).result.servers, []);

  const proxied = await fetch(
    `${harness.origin}/v0/fabric/frp/servers/server-home/proxy/v0/webui/projects`,
    { headers: { authorization: 'Bearer local-management-key' } }
  );
  assert.equal(proxied.status, 404);
  assert.equal((await proxied.json()).error, 'fabric_frp_server_not_found');
});

test('FRP proxy verifies the loopback Server identity before forwarding Local authorization', async (t) => {
  const requests = [];
  const localServer = http.createServer((req, res) => {
    requests.push({
      url: req.url,
      authorization: req.headers.authorization || ''
    });
    if (req.url === '/v0/fabric/descriptor') {
      writeDescriptor(res, 'server-other');
      return;
    }
    writeJson(res, 200, { ok: true, captured: req.headers.authorization || '' });
  });
  const localAddress = await listen(localServer);
  t.after(() => closeServer(localServer));
  const harness = await createAwsHarness(t, {
    routes: [{
      stableServerId: 'server-home',
      name: 'Home',
      bindPort: localAddress.port
    }]
  });

  const response = await fetch(
    `${harness.origin}/v0/fabric/frp/servers/server-home/proxy/v0/webui/projects`,
    { headers: { authorization: 'Bearer local-management-key' } }
  );

  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, 'fabric_frp_server_identity_mismatch');
  assert.deepEqual(requests, [{
    url: '/v0/fabric/descriptor',
    authorization: ''
  }]);
});

test('FRP proxy limits concurrent requests per Server and releases the slot after streaming completes', async (t) => {
  let targetCalls = 0;
  let finishFirst;
  const localServer = http.createServer((req, res) => {
    if (req.url === '/v0/fabric/descriptor') {
      writeDescriptor(res);
      return;
    }
    if (req.url !== '/v0/webui/hold') {
      writeJson(res, 404, { ok: false });
      return;
    }
    targetCalls += 1;
    if (targetCalls === 1) {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.flushHeaders();
      res.write('data: holding\n\n');
      finishFirst = () => res.end('data: done\n\n');
      return;
    }
    writeJson(res, 200, { ok: true, targetCalls });
  });
  const localAddress = await listen(localServer);
  t.after(async () => {
    if (finishFirst) finishFirst();
    await closeServer(localServer);
  });
  const harness = await createAwsHarness(t, {
    routes: [{ stableServerId: 'server-home', name: 'Home', bindPort: localAddress.port }],
    deps: { frpProxyMaxConcurrentRequests: 1 }
  });
  const url = `${harness.origin}/v0/fabric/frp/servers/server-home/proxy/v0/webui/hold`;

  const first = await requestHeaders(url, {
    headers: { authorization: 'Bearer local-management-key' }
  });
  const denied = await fetch(url, {
    headers: { authorization: 'Bearer local-management-key' }
  });
  assert.equal(denied.status, 429);
  assert.equal((await denied.json()).error, 'fabric_frp_concurrency_limited');
  assert.equal(targetCalls, 1);

  const firstEnded = waitForSignal((resolve) => first.res.once('end', resolve));
  first.res.resume();
  finishFirst();
  await firstEnded;

  const afterRelease = await fetch(url, {
    headers: { authorization: 'Bearer local-management-key' }
  });
  assert.equal(afterRelease.status, 200);
  assert.deepEqual(await afterRelease.json(), { ok: true, targetCalls: 2 });
});

test('FRP proxy enforces a bounded request body before forwarding to the Visitor', async (t) => {
  let targetCalls = 0;
  const localServer = http.createServer(async (req, res) => {
    if (req.url === '/v0/fabric/descriptor') {
      writeDescriptor(res);
      return;
    }
    targetCalls += 1;
    await readRequestBody(req).catch(() => Buffer.alloc(0));
    if (!res.destroyed) writeJson(res, 200, { ok: true });
  });
  const localAddress = await listen(localServer);
  t.after(() => closeServer(localServer));
  const harness = await createAwsHarness(t, {
    routes: [{ stableServerId: 'server-home', name: 'Home', bindPort: localAddress.port }],
    deps: { frpProxyMaxBodyBytes: 8 }
  });

  const response = await fetch(
    `${harness.origin}/v0/fabric/frp/servers/server-home/proxy/v0/webui/upload`,
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-management-key',
        'content-type': 'text/plain'
      },
      body: '123456789'
    }
  );

  assert.equal(response.status, 413);
  assert.equal((await response.json()).error, 'fabric_frp_body_too_large');
  assert.equal(targetCalls, 0);
});

test('FRP proxy releases its concurrency slot when Client disconnects during body read', async (t) => {
  let markDescriptorRead;
  const descriptorRead = new Promise((resolve) => { markDescriptorRead = resolve; });
  const localServer = http.createServer((req, res) => {
    if (req.url === '/v0/fabric/descriptor') {
      markDescriptorRead();
      writeDescriptor(res, 'server-abort');
      return;
    }
    if (req.url === '/v0/webui/projects') {
      writeJson(res, 200, { ok: true, projects: [] });
      return;
    }
    writeJson(res, 404, { ok: false });
  });
  const localAddress = await listen(localServer);
  t.after(() => closeServer(localServer));
  const harness = await createAwsHarness(t, {
    routes: [{ stableServerId: 'server-abort', name: 'Abort', bindPort: localAddress.port }],
    deps: {
      frpProxyMaxConcurrentRequests: 1,
      readRequestBody: () => new Promise(() => {})
    }
  });
  const proxyBase = `${harness.origin}/v0/fabric/frp/servers/server-abort/proxy`;

  const upload = http.request(`${proxyBase}/v0/webui/upload`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer local-management-key',
      'content-type': 'application/octet-stream'
    }
  });
  upload.on('error', () => {});
  upload.write('partial');
  await withTimeout(descriptorRead);
  upload.destroy();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const afterAbort = await fetch(`${proxyBase}/v0/webui/projects`, {
    headers: { authorization: 'Bearer local-management-key' }
  });
  assert.equal(afterAbort.status, 200);
  assert.deepEqual(await afterAbort.json(), { ok: true, projects: [] });
});

test('FRP proxy uses only the registered loopback Visitor and preserves auth, query, body, blob, and headers', async (t) => {
  const localRequests = [];
  const blob = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
  const localServer = http.createServer(async (req, res) => {
    const body = await readRequestBody(req);
    localRequests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization || '',
      contentType: req.headers['content-type'] || '',
      body: body.toString('utf8')
    });
    if (req.url === '/v0/fabric/descriptor') {
      writeDescriptor(res);
      return;
    }
    if (req.url === '/v0/webui/files/blob?offset=7') {
      res.statusCode = 206;
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-disposition', 'attachment; filename="fixture.bin"');
      res.setHeader('content-range', 'bytes 7-13/14');
      res.setHeader('accept-ranges', 'bytes');
      res.setHeader('etag', '"blob-etag"');
      res.setHeader('x-local-response', 'preserved');
      res.setHeader('set-cookie', ['a=1; HttpOnly', 'b=2; SameSite=Strict']);
      res.setHeader('authorization', 'Bearer response-secret');
      res.end(blob);
      return;
    }
    if (req.url === '/v0/webui/chat') {
      writeJson(res, 200, {
        ok: true,
        authorization: req.headers.authorization || '',
        body: JSON.parse(body.toString('utf8'))
      });
      return;
    }
    writeJson(res, 404, { ok: false, error: 'local_not_found' });
  });
  const localAddress = await listen(localServer);
  t.after(() => closeServer(localServer));
  const harness = await createAwsHarness(t, {
    routes: [{
      stableServerId: 'server-home',
      name: 'Home',
      bindPort: localAddress.port
    }]
  });
  const proxyBase = `${harness.origin}/v0/fabric/frp/servers/server-home/proxy`;

  const chat = await fetch(`${proxyBase}/v0/webui/chat`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer local-management-key',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ message: 'through frp' })
  });
  assert.equal(chat.status, 200);
  assert.deepEqual(await chat.json(), {
    ok: true,
    authorization: 'Bearer local-management-key',
    body: { message: 'through frp' }
  });

  const blobResponse = await fetch(`${proxyBase}/v0/webui/files/blob?offset=7`, {
    headers: {
      authorization: 'Bearer local-management-key',
      range: 'bytes=7-13'
    }
  });
  assert.equal(blobResponse.status, 206);
  assert.deepEqual(Buffer.from(await blobResponse.arrayBuffer()), blob);
  assert.equal(blobResponse.headers.get('content-disposition'), 'attachment; filename="fixture.bin"');
  assert.equal(blobResponse.headers.get('content-range'), 'bytes 7-13/14');
  assert.equal(blobResponse.headers.get('x-local-response'), null);
  assert.equal(blobResponse.headers.get('set-cookie'), null);
  assert.equal(blobResponse.headers.get('authorization'), null);
  assert.equal(blobResponse.headers.get('x-aih-frp-server-id'), 'server-home');

  const descriptorRequests = localRequests.filter((request) => request.url === '/v0/fabric/descriptor');
  assert.equal(descriptorRequests.length, 2);
  assert.equal(descriptorRequests.every((request) => request.authorization === ''), true);
  assert.deepEqual(localRequests.filter((request) => request.url !== '/v0/fabric/descriptor').map((request) => ({
    method: request.method,
    url: request.url,
    authorization: request.authorization
  })), [
    {
      method: 'POST',
      url: '/v0/webui/chat',
      authorization: 'Bearer local-management-key'
    },
    {
      method: 'GET',
      url: '/v0/webui/files/blob?offset=7',
      authorization: 'Bearer local-management-key'
    }
  ]);
});

test('FRP proxy streams SSE before completion and aborts the loopback request when Client disconnects', async (t) => {
  let sendFirstSse;
  let finishSse;
  let markSseStarted;
  const sseStarted = new Promise((resolve) => { markSseStarted = resolve; });
  let markCancelled;
  const cancelled = new Promise((resolve) => { markCancelled = resolve; });
  const localServer = http.createServer((req, res) => {
    if (req.url === '/v0/fabric/descriptor') {
      writeDescriptor(res);
      return;
    }
    if (req.url === '/v0/webui/events') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('x-stream-origin', 'local');
      res.flushHeaders();
      markSseStarted();
      sendFirstSse = () => res.write('event: first\ndata: one\n\n');
      finishSse = () => res.end('event: second\ndata: two\n\n');
      return;
    }
    if (req.url === '/v0/webui/slow') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.flushHeaders();
      res.write('data: connected\n\n');
      let settled = false;
      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        markCancelled();
      };
      req.once('aborted', resolveOnce);
      res.once('close', resolveOnce);
      return;
    }
    if (req.url === '/v0/webui/projects') {
      writeJson(res, 200, { ok: true, projects: [] });
      return;
    }
    writeJson(res, 404, { ok: false, error: 'local_not_found' });
  });
  const localAddress = await listen(localServer);
  t.after(async () => {
    if (finishSse) finishSse();
    await closeServer(localServer);
  });
  const harness = await createAwsHarness(t, {
    routes: [{
      stableServerId: 'server-home',
      name: 'Home',
      bindPort: localAddress.port
    }],
    deps: { frpProxyMaxConcurrentRequests: 1 }
  });
  const proxyBase = `${harness.origin}/v0/fabric/frp/servers/server-home/proxy`;

  const responsePending = requestHeaders(`${proxyBase}/v0/webui/events`, {
    headers: { authorization: 'Bearer local-management-key' }
  });
  await withTimeout(sseStarted);
  const first = await withTimeout(responsePending).catch((error) => {
    if (finishSse) finishSse();
    throw error;
  });
  assert.equal(first.res.statusCode, 200);
  assert.equal(first.res.headers['content-type'], 'text/event-stream');
  assert.equal(first.res.headers['x-stream-origin'], undefined);
  assert.equal(first.res.complete, false);
  const firstChunk = waitForSignal((resolve) => first.res.once('data', resolve));
  sendFirstSse();
  assert.match((await firstChunk).toString('utf8'), /event: first/);
  const sseEnded = waitForSignal((resolve) => first.res.once('end', resolve));
  finishSse();
  await sseEnded;

  const slow = await requestFirstChunk(`${proxyBase}/v0/webui/slow`, {
    headers: { authorization: 'Bearer local-management-key' }
  });
  assert.match(slow.chunk.toString('utf8'), /connected/);
  slow.req.destroy();
  slow.res.destroy();
  await withTimeout(cancelled);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const afterCancel = await fetch(`${proxyBase}/v0/webui/projects`, {
    headers: { authorization: 'Bearer local-management-key' }
  });
  assert.equal(afterCancel.status, 200);
  assert.deepEqual(await afterCancel.json(), { ok: true, projects: [] });
});

test('FRP proxy rejects unknown, malformed, and non-Client API paths without accepting a target URL', async (t) => {
  let localRequests = 0;
  const localServer = http.createServer((_req, res) => {
    localRequests += 1;
    writeJson(res, 200, { ok: true });
  });
  const localAddress = await listen(localServer);
  t.after(() => closeServer(localServer));
  const harness = await createAwsHarness(t, {
    routes: [{
      stableServerId: 'server-home',
      name: 'Home',
      bindPort: localAddress.port
    }]
  });

  const unknown = await fetch(`${harness.origin}/v0/fabric/frp/servers/not-registered/proxy/v0/webui/projects`);
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, 'fabric_frp_server_not_found');

  const forbidden = await fetch(
    `${harness.origin}/v0/fabric/frp/servers/server-home/proxy/v1/responses?target=http://169.254.169.254`
  );
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error, 'fabric_frp_route_not_allowed');

  const networkPathTarget = await fetch(
    `${harness.origin}/v0/fabric/frp/servers/server-home/proxy//169.254.169.254/v0/webui`
  );
  assert.equal(networkPathTarget.status, 403);
  assert.equal((await networkPathTarget.json()).error, 'fabric_frp_route_not_allowed');

  const malformed = await fetch(
    `${harness.origin}/v0/fabric/frp/servers/server-home/not-proxy/v0/webui/projects`
  );
  assert.equal(malformed.status, 404);
  assert.equal((await malformed.json()).error, 'fabric_frp_route_not_found');

  const encodedSlash = await fetch(
    `${harness.origin}/v0/fabric/frp/servers/server-home%2Fescape/proxy/v0/webui/projects`
  );
  assert.equal(encodedSlash.status, 404);
  assert.equal((await encodedSlash.json()).error, 'fabric_frp_route_not_found');

  const encodedTargetSlash = await fetch(
    `${harness.origin}/v0/fabric/frp/servers/server-home/proxy/v0/webui%2Fprojects`
  );
  assert.equal(encodedTargetSlash.status, 403);
  assert.equal((await encodedTargetSlash.json()).error, 'fabric_frp_route_not_allowed');

  const encodedBackslash = await fetch(
    `${harness.origin}/v0/fabric/frp/servers/server-home/proxy/%5C%5Cattacker.invalid/v0/webui/projects`
  );
  assert.equal(encodedBackslash.status, 403);
  assert.equal((await encodedBackslash.json()).error, 'fabric_frp_route_not_allowed');
  assert.equal(localRequests, 0);
});
