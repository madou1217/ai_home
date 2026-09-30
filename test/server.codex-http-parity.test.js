'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { handleCodexChatCompletions } = require('../lib/server/codex-adapter');
const { handleV1Request } = require('../lib/server/v1-router');
const errors = require('../contracts/codex-relay/errors.json');
const { startGoGateway } = require('./helpers/codex-http-go-fixture');
const { createGoCoreGatewayForwarder } = require('../lib/server/go-core-gateway-forwarder');
const { compileRouteTable, loadRouteOwnershipManifest } = require('../lib/server/go-core-route-ownership');

async function listen(context, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function capture() {
  return { headers: {}, statusCode: 0, body: '',
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(body) { this.body = body; }
  };
}

for (const [code, headers, body] of [
  ['unauthorized', { authorization: 'Bearer wrong' }, '{}'],
  ['infinite_loop_detected', { 'x-aih-codex-relay-hop': '1' }, '{}'],
  ['invalid_account_ref', { 'x-account-ref': 'bad' }, '{}'],
  ['invalid_request_body', {}, '{broken']
]) {
  test(`Responses entry uses the shared ${code} contract`, async () => {
    const response = capture();
    await handleV1Request({ req: { headers: { authorization: 'Bearer fixture', ...headers } }, res: response,
      method: 'POST', pathname: '/v1/responses', requiredClientKey: 'fixture', options: {}, state: {},
      deps: { parseAuthorizationBearer: value => String(value).replace(/^Bearer /, ''),
        readRequestBody: async () => Buffer.from(body) } });
    const definition = errors[code];
    assert.equal(response.statusCode, definition.status);
    assert.deepEqual(JSON.parse(response.body), { error: { code, message: definition.message, type: definition.type, param: null } });
  });
}

test('Node adapter and Go HTTP server preserve the same upstream failures', {
  skip: !process.env.AIH_CODEX_HTTP_GO_BINARY, timeout: 60000
}, async context => {
  for (const scenario of [
    { status: 400 }, { status: 401 }, { status: 429 }, { status: 503 },
    { status: 503, empty: true }, { status: 403, safety: true },
    { status: 200, safety: true }, { status: 200, safety: true, sse: true }
  ]) {
    await context.test(JSON.stringify(scenario), async scenarioContext => {
      const errorBody = scenario.empty ? '' : scenario.safety
        ? '{"error":{"code":"content_policy_violation","message":"blocked by safety policy"}}'
        : '{ "error":{"code":"fixture","message":"upstream original"},"opaque":9007199254740993 }';
      const body = scenario.sse
        ? 'data: {"type":"response.created","response":{"output":[]}}\n\n'
          + `data: {"type":"error",${errorBody.slice(1)}\n\n`
        : errorBody;
      const upstream = await listen(scenarioContext, (request, response) => {
        if (request.method === 'GET') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{"data":[{"id":"gpt-5.4","object":"model"}]}');
          return;
        }
        response.writeHead(scenario.status, { 'content-type': scenario.sse ? 'text/event-stream' : 'application/json', 'retry-after': '7', 'x-request-id': 'fixture-original' });
        response.end(body);
      });
      const go = await startGoGateway(scenarioContext, upstream + '/v1', 'gpt-5.4');
      const state = { accounts: { codex: [{ accountRef: 'acct_0123456789abcdefabcd', apiKeyMode: true,
        accessToken: 'fixture-upstream-key', openaiBaseUrl: upstream + '/v1' }] },
      cursors: { codex: 0 }, metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 } };
      const payload = { model: 'gpt-5.4', stream: true, input: 'fixture' };
      const node = await listen(scenarioContext, (request, response) => {
        handleCodexChatCompletions({ req: request, res: response, state, requestJson: payload,
          options: { maxAttempts: 1, upstreamTimeoutMs: 2000 }, cooldownMs: 1000,
          requestMeta: { clientProtocol: 'openai_responses' }, routeKey: 'POST /v1/responses', requestStartedAt: Date.now(),
          deps: { chooseServerAccount: pool => pool[0], pushMetricError() {},
            writeJson(target, status, document) { target.writeHead(status); target.end(JSON.stringify(document)); },
            fetchWithTimeout: fetch, markProxyAccountFailure() {}, markProxyAccountSuccess() {},
            appendProxyRequestLog() {}, waitForTransientRetry: async () => {} }
        }).catch(error => response.destroy(error));
      });
      const responses = await Promise.all([node, go.base].map(base => fetch(base + '/v1/responses', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${go.clientKey}` },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(10000)
      })));
      const bodies = await Promise.all(responses.map(response => response.text()));
      for (let index = 0; index < responses.length; index += 1) {
        assert.equal(responses[index].status, scenario.safety ? 403 : scenario.status, index === 0 ? 'Node' : 'Go');
        if (scenario.safety) {
          assert.deepEqual(JSON.parse(bodies[index]), { error: { code: 'upstream_safety_rejected',
            message: errors.upstream_safety_rejected.message, type: 'permission_error', param: null } });
        } else {
          assert.equal(bodies[index], body);
          assert.equal(responses[index].headers.get('retry-after'), '7');
          assert.equal(responses[index].headers.get('x-request-id'), 'fixture-original');
        }
      }
    });
  }
});

test('Node public ingress, Go HTTP relay and the upstream preserve compressed native requests end to end', {
  skip: !process.env.AIH_CODEX_HTTP_GO_BINARY, timeout: 15000
}, async context => {
  const seen = [];
  const responseBody = '{ "id":"resp_fixture","status":"completed","output":[],"opaque":9007199254740993 }';
  const upstream = await listen(context, async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET') {
      response.end('{"data":[{"id":"gpt-5.4","object":"model"}]}');
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    seen.push({ body: Buffer.concat(chunks), headers: request.headers });
    response.end(responseBody);
  });
  const go = await startGoGateway(context, upstream + '/v1', 'gpt-5.4');
  const decisions = [];
  const forwarder = createGoCoreGatewayForwarder({
    routeTable: compileRouteTable(loadRouteOwnershipManifest()), entryIds: new Set(['gateway.openai.responses']),
    requiredClientKey: 'fixture-public-key',
    getTarget: () => ({ host: '127.0.0.1', port: Number(new URL(go.base).port), clientKey: go.clientKey }),
    needsRequestModel: () => true,
    deferToNode: input => { decisions.push(input.model); return false; },
    mapPinnedAccountRef: () => go.accountRef, agent: new http.Agent({ keepAlive: false }),
    writeJson(target, status, document) { target.writeHead(status); target.end(JSON.stringify(document)); }
  });
  const node = await listen(context, (request, response) => {
    forwarder.tryHandleHttp(request, response, { method: request.method, pathname: '/v1/responses' })
      .catch(error => response.destroy(error));
  });
  const payload = Buffer.from('{ "model":"gpt-5.4", "input":"fixture", "opaque":9007199254740993 }');
  for (const [encoding, encode] of [['identity', body => body], ['gzip', zlib.gzipSync], ['zstd', zlib.zstdCompressSync]]) {
    const body = encode(payload);
    const response = await fetch(node + '/v1/responses', { method: 'POST', body,
      headers: { authorization: 'Bearer fixture-public-key', 'content-type': 'application/json',
        'content-encoding': encoding, 'x-account-ref': 'acct_00000000000000000001' } });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), responseBody);
    assert.deepEqual(seen.at(-1).body, body);
    assert.equal(seen.at(-1).headers['content-encoding'], encoding);
    assert.equal(seen.at(-1).headers.authorization, 'Bearer synthetic-upstream-key');
    assert.equal(seen.at(-1).headers['x-account-ref'], undefined);
    assert.equal(response.headers.get('x-aih-server-account-ref'), go.accountRef);
  }
  assert.deepEqual(decisions, ['gpt-5.4', 'gpt-5.4', 'gpt-5.4']);
});
