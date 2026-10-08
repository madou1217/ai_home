'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleUpstreamPassthrough } = require('../lib/server/upstream-endpoints');
const { extractRequestSessionKey } = require('../lib/server/session-key');
const { chooseServerAccount, markProxyAccountFailure } = require('../lib/server/router');
const {
  createProviderProtocolRouteMeta,
  resolveDirectProviderProtocolRoute
} = require('../lib/server/provider-protocol-routing');

function createResponseCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writableEnded: false,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    flushHeaders() { this.headersSent = true; },
    write(chunk) { this.headersSent = true; this.body += Buffer.from(chunk).toString(); },
    end(chunk) {
      if (chunk) this.write(chunk);
      this.headersSent = true;
      this.writableEnded = true;
    }
  };
}

for (const stream of [false, true]) {
  test(`OpenCode subscription refusal preserves 403 after the pool is exhausted (stream=${stream})`, async () => {
    const model = 'opencode-go/glm-5.3';
    const account = { accountRef: 'acct_0123456789abcdef0123', provider: 'opencode', accessToken: 'sk-fixture' };
    const state = {
      accounts: { opencode: [account, {
        ...account,
        accountRef: 'acct_0123456789abcdef0124',
        authInvalidUntil: Date.now() + 60_000,
        cooldownUntil: Date.now() + 60_000,
        lastFailureKind: 'auth_invalid'
      }] },
      cursors: { opencode: 0 },
      metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
    };
    const requestJson = { model, stream, messages: [{ role: 'user', content: 'Reply OK.' }] };
    const res = createResponseCapture();
    let upstreamCalls = 0;
    await handleUpstreamPassthrough({
      options: { provider: 'opencode', upstreamTimeoutMs: 3000, maxAttempts: 2 },
      state,
      req: { url: '/v1/chat/completions', headers: {} },
      res,
      method: 'POST',
      bodyBuffer: Buffer.from(JSON.stringify(requestJson)),
      requestJson,
      routeKey: 'POST /v1/chat/completions',
      requestStartedAt: Date.now(),
      cooldownMs: 1000,
      requestMeta: {
        sessionId: 'ses_entitlement',
        providerProtocolRoute: createProviderProtocolRouteMeta(resolveDirectProviderProtocolRoute('openai_chat', 'opencode'))
      },
      deps: {
        chooseServerAccount,
        pushMetricError: () => {},
        writeJson: (response, code, payload) => { response.statusCode = code; response.end(JSON.stringify(payload)); },
        fetchWithTimeout: async (_url, init) => {
          upstreamCalls += 1;
          assert.equal(init.headers['x-opencode-session'], 'ses_entitlement');
          return new Response(JSON.stringify({ error: {
            type: 'server_error',
            message: 'Upstream request failed: An active OpenCode Go subscription is required to use Go models.'
          } }), { status: 403 });
        },
        markProxyAccountFailure,
        markProxyAccountSuccess: () => assert.fail('a refused request cannot succeed'),
        recordModelUsage: () => assert.fail('a refused request cannot create usage'),
        appendProxyRequestLog: () => {}
      }
    });
    assert.equal(upstreamCalls, 1);
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).detail, /active OpenCode Go subscription is required/);
    assert.equal(account.authInvalidUntil, 0);
    assert.equal(account.cooldownUntil, 0);
    assert.equal(account.lastFailureKind, 'model_entitlement_required');
    assert.ok(account.modelCooldowns[model] > Date.now());
  });
}

const cases = [
  { name: 'buffered chat', model: 'opencode-go/glm-5.2', stream: false },
  { name: 'chat SSE', model: 'opencode-go/glm-5.2', stream: true },
  { name: 'Anthropic buffered fallback', model: 'opencode-go/qwen3.7-plus', stream: true }
];

for (const scenario of cases) {
  test(`OpenCode transport preserves the client session for ${scenario.name}`, async () => {
    const sessionId = 'ses_client_session';
    const account = { accountRef: 'acct_0123456789abcdef0123', provider: 'opencode', accessToken: 'sk-fixture' };
    const requestHeaders = { 'x-opencode-session': sessionId };
    const requestJson = {
      model: scenario.model,
      stream: scenario.stream,
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Reply OK.' }]
    };
    const res = createResponseCapture();
    const state = {
      accounts: { opencode: [account] },
      cursors: { opencode: 0 },
      metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
    };
    const usageRecords = [];
    const upstreamCalls = [];

    await handleUpstreamPassthrough({
      options: { provider: 'opencode', upstreamTimeoutMs: 3000, maxAttempts: 1 },
      state,
      req: { url: '/v1/chat/completions', headers: requestHeaders },
      res,
      method: 'POST',
      bodyBuffer: Buffer.from(JSON.stringify(requestJson)),
      requestJson,
      routeKey: 'POST /v1/chat/completions',
      requestStartedAt: Date.now(),
      cooldownMs: 1000,
      requestMeta: {
        sessionKey: extractRequestSessionKey(requestHeaders, requestJson),
        providerProtocolRoute: createProviderProtocolRouteMeta(resolveDirectProviderProtocolRoute('openai_chat', 'opencode'))
      },
      deps: {
        chooseServerAccount: (pool) => pool[0],
        pushMetricError: () => {},
        writeJson: (response, code, payload) => {
          response.statusCode = code;
          response.end(JSON.stringify(payload));
        },
        fetchWithTimeout: async (url, init) => {
          upstreamCalls.push({ url, init });
          if (init.headers['x-opencode-session'] !== sessionId) {
            return new Response(JSON.stringify({ error: { type: 'MissingSessionID' } }), { status: 400 });
          }
          const payload = JSON.parse(init.body);
          assert.equal(payload.session_id, undefined);
          assert.equal(payload.sessionId, undefined);
          if (String(url).endsWith('/messages')) {
            return new Response(JSON.stringify({
              content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn',
              usage: { input_tokens: 2, output_tokens: 1 }
            }));
          }
          const responseBody = {
            model: 'glm-5.2',
            choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
          };
          if (!payload.stream) return new Response(JSON.stringify(responseBody));
          return new Response(`data: ${JSON.stringify(responseBody)}\n\ndata: [DONE]\n\n`, {
            headers: { 'content-type': 'text/event-stream' }
          });
        },
        markProxyAccountFailure: () => assert.fail('session header was lost before reaching upstream'),
        markProxyAccountSuccess: () => {},
        recordModelUsage: (record) => usageRecords.push(record),
        appendProxyRequestLog: () => {}
      }
    });

    assert.equal(res.statusCode, 200);
    assert.match(res.body, /OK/);
    assert.equal(upstreamCalls.length, 1);
    assert.equal(upstreamCalls[0].init.headers['x-opencode-session'], sessionId);
    assert.equal(usageRecords.length, 1);
    assert.equal(usageRecords[0].sessionId, sessionId);
    assert.equal(usageRecords[0].model, scenario.model);
    assert.equal(state.metrics.totalSuccess, 1);
    if (scenario.stream) assert.match(res.body, /data: \[DONE\]/);
  });
}
