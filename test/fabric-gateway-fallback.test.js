'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createBrokerRequestHandler } = require('../lib/cli/services/fabric/broker-request-handler');
const {
  localWebSocketHeaders,
  localWebSocketUrl
} = require('../lib/cli/services/fabric/broker-websocket-handler');
const {
  buildFabricGatewayCapability,
  buildFabricGatewayReadiness,
  selectFabricGatewayServer
} = require('../lib/server/fabric-gateway-capability');
const { proxyFabricGatewayRequest } = require('../lib/server/fabric-gateway-fallback');
const { recordFabricGatewayResult } = require('../lib/server/fabric-gateway-route');
const {
  FABRIC_GATEWAY_PROTOCOL_VERSION,
  FABRIC_GATEWAY_REQUEST_PURPOSE,
  FABRIC_GATEWAY_WEBSOCKET_OPEN_FRAME,
  isFabricGatewayFrame,
  isFabricGatewayWebSocketOpenFrame
} = require('../lib/server/fabric-gateway-protocol');
const { handleV1Request } = require('../lib/server/v1-router');

const CODEX_ACCOUNT_REF = 'acct_0123456789abcdefabcd';

function emptyGatewayState() {
  return {
    accounts: { codex: [], gemini: [], claude: [], agy: [], opencode: [] },
    metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0 }
  };
}

function connectedGateway(serverId = 'home-server') {
  return {
    stableServerId: serverId,
    online: true,
    capabilities: {
      gateway: {
        protocolVersion: FABRIC_GATEWAY_PROTOCOL_VERSION,
        enabled: true,
        available: 1,
        models: ['gpt-5.5']
      }
    }
  };
}

function responseCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writableEnded: false,
    setHeader(name, value) { this.headers[name] = value; },
    write(value = '') { this.headersSent = true; this.body += String(value); },
    end(value = '') { this.headersSent = true; this.writableEnded = true; this.body += String(value); }
  };
}

test('fabric descriptor capability exposes only aggregate gateway availability', () => {
  const capability = buildFabricGatewayCapability({
    accounts: {
      codex: [{
        accountRef: CODEX_ACCOUNT_REF,
        provider: 'codex',
        accessToken: 'provider-secret',
        availableModels: ['gpt-5.5']
      }]
    }
  });

  assert.equal(capability.enabled, true);
  assert.equal(capability.accounts, 1);
  assert.equal(capability.available, 1);
  assert.deepEqual(capability.models, ['gpt-5.5']);
  assert.equal(JSON.stringify(capability).includes(CODEX_ACCOUNT_REF), false);
  assert.equal(JSON.stringify(capability).includes('provider-secret'), false);
});

test('fabric descriptor capability advertises only providers enabled by the local Server', () => {
  const capability = buildFabricGatewayCapability({
    accounts: {
      codex: [],
      claude: [{
        accountRef: CODEX_ACCOUNT_REF,
        provider: 'claude',
        accessToken: 'provider-secret',
        availableModels: ['claude-opus-4-6']
      }]
    }
  }, { provider: 'codex' });

  assert.equal(capability.enabled, false);
  assert.equal(capability.accounts, 0);
  assert.equal(capability.available, 0);
  assert.deepEqual(capability.models, []);
  assert.deepEqual(capability.providers.codex, {
    accounts: 0,
    available: 0,
    models: []
  });
  assert.equal(capability.providers.claude, undefined);
});

test('fabric gateway selection prefers an online server advertising the requested model', () => {
  const selected = selectFabricGatewayServer([
    connectedGateway('server-b'),
    {
      ...connectedGateway('server-a'),
      capabilities: { gateway: { enabled: true, available: 3, models: ['claude-opus-4-6'] } }
    }
  ], 'gpt-5.5');

  assert.equal(selected.stableServerId, 'server-b');
  assert.equal(selectFabricGatewayServer([connectedGateway()], 'claude-opus-4-6'), null);
});

test('fabric gateway selection rejects incompatible protocol versions and reports readiness', () => {
  const incompatible = connectedGateway('future-server');
  incompatible.capabilities.gateway.protocolVersion = FABRIC_GATEWAY_PROTOCOL_VERSION + 1;
  const compatible = connectedGateway('current-server');
  compatible.capabilities.gateway.protocolVersion = FABRIC_GATEWAY_PROTOCOL_VERSION;

  assert.equal(selectFabricGatewayServer([incompatible], 'gpt-5.5'), null);
  assert.equal(selectFabricGatewayServer([incompatible, compatible], 'gpt-5.5').stableServerId, 'current-server');
  assert.deepEqual(buildFabricGatewayReadiness({
    listBrokerServers: () => [incompatible, compatible]
  }), {
    ready: true,
    connectedServers: 1,
    availableAccounts: 1
  });
});

test('fabric gateway selection honors an explicitly requested provider', () => {
  const codex = connectedGateway('codex-server');
  codex.capabilities.gateway.providers = {
    codex: { accounts: 1, available: 1, models: ['shared-model'] }
  };
  codex.capabilities.gateway.models = ['shared-model'];
  const claude = connectedGateway('claude-server');
  claude.capabilities.gateway.providers = {
    claude: { accounts: 1, available: 1, models: ['shared-model'] }
  };
  claude.capabilities.gateway.models = ['shared-model'];

  assert.equal(
    selectFabricGatewayServer([codex, claude], 'shared-model', 'claude').stableServerId,
    'claude-server'
  );
  assert.equal(selectFabricGatewayServer([codex], 'shared-model', 'claude'), null);
});

test('fabric gateway selection matches models inside the requested provider capability', () => {
  const mixed = connectedGateway('mixed-provider-server');
  mixed.capabilities.gateway.providers = {
    codex: { accounts: 1, available: 1, models: ['gpt-5.5'] },
    claude: { accounts: 1, available: 1, models: ['claude-opus-4-6'] }
  };
  mixed.capabilities.gateway.models = ['claude-opus-4-6', 'gpt-5.5'];

  assert.equal(selectFabricGatewayServer([mixed], 'claude-opus-4-6', 'codex'), null);
  assert.equal(
    selectFabricGatewayServer([mixed], 'claude-opus-4-6', 'claude').stableServerId,
    'mixed-provider-server'
  );
});

test('fabric gateway request frames require the negotiated protocol version', () => {
  const frame = {
    type: 'broker.request',
    purpose: FABRIC_GATEWAY_REQUEST_PURPOSE,
    gatewayProtocolVersion: FABRIC_GATEWAY_PROTOCOL_VERSION,
    method: 'POST',
    pathname: '/v1/responses',
    headers: { 'x-aih-gateway-hop': '1' }
  };

  assert.equal(isFabricGatewayFrame(frame), true);
  assert.equal(isFabricGatewayFrame({ ...frame, gatewayProtocolVersion: undefined }), false);
  assert.equal(isFabricGatewayFrame({
    ...frame,
    gatewayProtocolVersion: FABRIC_GATEWAY_PROTOCOL_VERSION + 1
  }), false);
});

test('fabric gateway websocket open frames require the versioned responses route contract', () => {
  const frame = {
    type: FABRIC_GATEWAY_WEBSOCKET_OPEN_FRAME,
    purpose: FABRIC_GATEWAY_REQUEST_PURPOSE,
    gatewayProtocolVersion: FABRIC_GATEWAY_PROTOCOL_VERSION,
    requestId: 'websocket-request-1',
    pathname: '/v1/responses',
    headers: { 'x-aih-gateway-hop': '1' }
  };

  assert.equal(isFabricGatewayWebSocketOpenFrame(frame), true);
  assert.equal(isFabricGatewayWebSocketOpenFrame({ ...frame, pathname: '/v1/chat/completions' }), false);
  assert.equal(isFabricGatewayWebSocketOpenFrame({ ...frame, gatewayProtocolVersion: 2 }), false);
  assert.equal(isFabricGatewayWebSocketOpenFrame({ ...frame, headers: { 'x-aih-gateway-hop': '2' } }), false);
});

test('fabric gateway fallback proxies only when the local Server has no accounts', async () => {
  const socket = { readyState: 1 };
  const server = connectedGateway();
  const frames = [];
  const registry = {
    listBrokerServers: () => [server],
    getBrokerSession: () => ({ socket })
  };
  const res = responseCapture();
  const result = await proxyFabricGatewayRequest({
    req: {
      url: '/v1/responses?trace=1',
      headers: {
        authorization: 'Bearer public-client-key',
        'x-api-key': 'public-anthropic-key',
        accept: 'text/event-stream',
        'content-type': 'application/json',
        'x-provider': 'claude',
        'x-session-id': 'session-1',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31'
      }
    },
    res,
    method: 'POST',
    pathname: '/v1/responses',
    options: { provider: 'auto' },
    state: emptyGatewayState(),
    model: 'gpt-5.5',
    bodyBuffer: Buffer.from('{"model":"gpt-5.5"}')
  }, {
    fabricBrokerSessionRegistry: registry,
    streamBrokerResponse: async (input) => { frames.push(input.requestFrame); }
  });

  assert.deepEqual(result, { handled: true, serverId: 'home-server', reason: 'proxied' });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].purpose, FABRIC_GATEWAY_REQUEST_PURPOSE);
  assert.equal(frames[0].gatewayProtocolVersion, FABRIC_GATEWAY_PROTOCOL_VERSION);
  assert.equal(frames[0].pathname, '/v1/responses?trace=1');
  assert.equal(frames[0].headers.authorization, undefined);
  assert.equal(frames[0].headers['x-api-key'], undefined);
  assert.equal(frames[0].headers['x-provider'], 'claude');
  assert.equal(frames[0].headers['x-session-id'], 'session-1');
  assert.equal(frames[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(frames[0].headers['anthropic-beta'], 'prompt-caching-2024-07-31');
  assert.equal(frames[0].headers['x-aih-gateway-hop'], '1');

  const localState = emptyGatewayState();
  localState.accounts.codex.push({
    accountRef: CODEX_ACCOUNT_REF,
    provider: 'codex',
    accessToken: 'token'
  });
  const localResult = await proxyFabricGatewayRequest({
    req: { headers: {} },
    res: responseCapture(),
    state: localState
  }, { fabricBrokerSessionRegistry: registry });
  assert.deepEqual(localResult, { handled: false, reason: 'local_accounts_present' });
});

test('fabric gateway fallback stops at one hop to prevent Server loops', async () => {
  const result = await proxyFabricGatewayRequest({
    req: { headers: { 'x-aih-gateway-hop': '1' } },
    res: responseCapture(),
    state: emptyGatewayState()
  });
  assert.deepEqual(result, { handled: false, reason: 'gateway_hop_limit_reached' });
});

test('fabric gateway fallback bounds concurrency and marks client cancellation', async () => {
  const socket = { readyState: 1 };
  const server = connectedGateway('limit-server');
  const registry = {
    listBrokerServers: () => [server],
    getBrokerSession: () => ({ socket })
  };
  let releaseFirst;
  const firstStream = new Promise((resolve) => { releaseFirst = resolve; });
  const first = proxyFabricGatewayRequest({
    req: { headers: {} },
    res: responseCapture(),
    method: 'POST',
    pathname: '/v1/responses',
    state: emptyGatewayState(),
    model: 'gpt-5.5'
  }, {
    fabricBrokerSessionRegistry: registry,
    fabricGatewayMaxConcurrentRequests: 1,
    streamBrokerResponse: async () => firstStream
  });
  await Promise.resolve();

  const limitedResponse = responseCapture();
  const limited = await proxyFabricGatewayRequest({
    req: { headers: {} },
    res: limitedResponse,
    method: 'POST',
    pathname: '/v1/responses',
    state: emptyGatewayState(),
    model: 'gpt-5.5'
  }, {
    fabricBrokerSessionRegistry: registry,
    fabricGatewayMaxConcurrentRequests: 1
  });
  assert.equal(limited.reason, 'concurrency_limited');
  assert.equal(limitedResponse.statusCode, 429);
  assert.equal(limitedResponse.headers['retry-after'], '1');

  releaseFirst({ ok: true });
  assert.equal((await first).reason, 'proxied');
  const cancelled = await proxyFabricGatewayRequest({
    req: { headers: {} },
    res: responseCapture(),
    method: 'POST',
    pathname: '/v1/responses',
    state: emptyGatewayState(),
    model: 'gpt-5.5'
  }, {
    fabricBrokerSessionRegistry: registry,
    streamBrokerResponse: async () => ({ ok: false, cancelled: true })
  });
  assert.equal(cancelled.reason, 'client_cancelled');
});

test('fabric gateway metrics count a failed stream even after a successful status started', () => {
  const metricErrors = [];
  const state = emptyGatewayState();
  const res = responseCapture();
  res.statusCode = 200;
  recordFabricGatewayResult({ method: 'POST', pathname: '/v1/responses', state, res }, {
    handled: true,
    serverId: 'home-server',
    reason: 'proxy_failed'
  }, {
    incrementRouteMetrics(currentState, routeKey) {
      currentState.metrics.totalRequests += 1;
      currentState.metrics.routeCounts[routeKey] = 1;
    },
    pushMetricError(...args) { metricErrors.push(args); }
  });

  assert.equal(state.metrics.totalSuccess, 0);
  assert.equal(state.metrics.totalFailures, 1);
  assert.equal(metricErrors.length, 1);
});

test('broker gateway frame injects the local Server client key and strips caller authorization', async () => {
  const sent = [];
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    send(value) { sent.push(JSON.parse(value)); }
  });
  const requests = [];
  const handler = createBrokerRequestHandler({
    localUrl: 'http://127.0.0.1:9527',
    localClientKey: 'local-client-key',
    requestTimeoutMs: 3000
  }, {
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        status: 200,
        headers: { forEach(callback) { callback('text/event-stream', 'content-type'); } },
        arrayBuffer: async () => Buffer.from('data: ok\n\n')
      };
    }
  });

  await handler(socket, {
    type: 'broker.request',
    purpose: FABRIC_GATEWAY_REQUEST_PURPOSE,
    gatewayProtocolVersion: FABRIC_GATEWAY_PROTOCOL_VERSION,
    requestId: 'request-1',
    method: 'POST',
    pathname: '/v1/responses',
    headers: {
      authorization: 'Bearer caller-key',
      'content-type': 'application/json',
      'x-provider': 'claude',
      'x-session-id': 'session-1',
      'anthropic-beta': 'prompt-caching-2024-07-31',
      'x-aih-gateway-hop': '1'
    },
    bodyBase64: Buffer.from('{}').toString('base64')
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.headers.authorization, 'Bearer local-client-key');
  assert.equal(requests[0].init.headers['x-provider'], 'claude');
  assert.equal(requests[0].init.headers['x-session-id'], 'session-1');
  assert.equal(requests[0].init.headers['anthropic-beta'], 'prompt-caching-2024-07-31');
  assert.equal(requests[0].init.headers['x-aih-gateway-hop'], '1');
  assert.equal(sent.some((frame) => frame.type === 'broker.response.start'), true);
  assert.equal(sent.some((frame) => frame.type === 'broker.response.end'), true);

  requests.length = 0;
  sent.length = 0;
  await handler(socket, {
    type: 'broker.request',
    requestId: 'request-2',
    method: 'POST',
    pathname: '/v1/responses',
    headers: {},
    bodyBase64: ''
  });
  assert.equal(requests.length, 0);
  assert.equal(sent[0].status, 403);
});

test('broker gateway websocket targets only the local Server and substitutes its client key', () => {
  const frame = {
    type: FABRIC_GATEWAY_WEBSOCKET_OPEN_FRAME,
    purpose: FABRIC_GATEWAY_REQUEST_PURPOSE,
    gatewayProtocolVersion: FABRIC_GATEWAY_PROTOCOL_VERSION,
    requestId: 'websocket-request-1',
    pathname: '/v1/responses?mode=test',
    headers: {
      authorization: 'Bearer caller-key',
      'x-api-key': 'caller-api-key',
      'x-provider': 'codex',
      'x-session-id': 'session-1',
      'x-aih-gateway-hop': '1'
    }
  };

  assert.equal(
    localWebSocketUrl('http://127.0.0.1:9527', frame.pathname),
    'ws://127.0.0.1:9527/v1/responses?mode=test'
  );
  assert.deepEqual(localWebSocketHeaders(frame, { localClientKey: 'local-client-key' }), {
    authorization: 'Bearer local-client-key',
    'x-provider': 'codex',
    'x-session-id': 'session-1',
    'x-aih-gateway-hop': '1'
  });
});

test('v1 router delegates to the connected fabric gateway before local provider routing', async () => {
  const res = responseCapture();
  const calls = [];
  const handled = await handleV1Request({
    req: { headers: { 'x-provider': 'claude' }, url: '/v1/responses' },
    res,
    method: 'POST',
    pathname: '/v1/responses',
    options: { backend: 'codex-adapter', provider: 'auto' },
    state: emptyGatewayState(),
    requiredClientKey: '',
    cooldownMs: 1000,
    maxRequestBodyBytes: 1024,
    requestMeta: {},
    deps: {
      readRequestBody: async () => Buffer.from('{"model":"gpt-5.5","input":"hello"}'),
      proxyFabricGatewayRequest: async (input, deps) => {
        calls.push({ input, deps });
        input.res.statusCode = 200;
        input.res.end('proxied');
        return { handled: true, serverId: 'home-server', reason: 'proxied' };
      },
      fabricBrokerSessionRegistry: { listBrokerServers: () => [] }
    }
  });

  assert.equal(handled, true);
  assert.equal(res.body, 'proxied');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.model, 'gpt-5.5');
  assert.equal(calls[0].input.provider, 'claude');
  assert.equal(calls[0].input.bodyBuffer.toString('utf8').includes('hello'), true);
  assert.equal(calls[0].input.state.metrics.totalRequests, 1);
  assert.equal(calls[0].input.state.metrics.totalSuccess, 1);
});
