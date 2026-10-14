'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { handleCodexChatCompletions, handleCodexModels } = require('../lib/server/codex-adapter');
const { chooseServerAccount, markProxyAccountFailure, markProxyAccountSuccess } = require('../lib/server/router');
const { deriveAccountRuntimeStatus } = require('../lib/server/account-runtime-state');
const { validateUpstreamErrorRules } = require('../lib/account/upstream-error-rules');
const { buildOpenAIModelsList } = require('../lib/server/models');
const { handleUpstreamPassthrough } = require('../lib/server/upstream-endpoints');
const {
  createAccountRuntimeEventHub,
  createAccountRuntimeEventPublisher,
  registerAccountRuntimeEventListeners
} = require('../lib/server/account-runtime-events');

// 响应体按字节累积、最后一次性解码：上游可以把一个 UTF-8 字符拆到两个 chunk
// （sse_partial 用例故意从 '用' 中间切开），如果这里对每个 chunk 单独 String(data)，
// 拆开的字符就会变成 U+FFFD，断言随 fetch 的 chunk 边界（=机器负载）随机变红。
function captureResponse() {
  const chunks = [];
  return { statusCode: 0, headers: {}, headersSent: false, writableEnded: false,
    get body() { return Buffer.concat(chunks).toString('utf8'); },
    setHeader(key, value) { this.headers[key] = value; },
    flushHeaders() { this.headersSent = true; },
    write(data) { this.headersSent = true; chunks.push(toChunkBuffer(data)); },
    end(data = '') {
      this.headersSent = true;
      this.writableEnded = true;
      if (data !== '' && data !== undefined && data !== null) chunks.push(toChunkBuffer(data));
    } };
}

function toChunkBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(String(data));
}

for (const failureTransport of ['http', 'sse', 'sse_partial', 'sse_untyped']) {
  test(`general passthrough ${failureTransport} billing failure releases existing sessions and reroutes healthy accounts`, async t => {
    const error = { message: '用户额度不足, 剩余额度: ＄-0.028880', type: 'new_api_error', code: 'insufficient_user_quota' };
    const partial = failureTransport === 'sse_partial'
      ? `data: ${JSON.stringify({ choices: [{ delta: { content: 'already delivered' } }] })}\r\n\r\n`
      : '';
    const errorFrame = failureTransport === 'sse_untyped'
      ? `data: ${JSON.stringify({ status: 403, error })}\r\n\r\n`
      : `event: error\r\ndata: ${JSON.stringify({ status: 403, error })}\r\n\r\n`;
    const healthyFrame = `data: ${JSON.stringify({ choices: [{ delta: { content: 'recovered' } }] })}\n\n`;
    const attempts = [];
    const server = http.createServer((req, res) => {
      req.resume();
      attempts.push(req.headers.authorization);
      if (req.headers.authorization !== 'Bearer fixture-depleted') {
        res.setHeader('content-type', 'text/event-stream');
        res.end(healthyFrame);
        return;
      }
      if (failureTransport === 'http') {
        res.statusCode = 403;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error }));
        return;
      }
      res.setHeader('content-type', 'text/event-stream');
      if (partial) res.write(partial);
      // 分割 UTF-8 字符和 CRLF，验证流观察不依赖 fetch 的 chunk 边界。
      const raw = Buffer.from(errorFrame);
      const split = raw.indexOf(Buffer.from('用户')) + 1;
      res.write(raw.subarray(0, split));
      setImmediate(() => res.end(raw.subarray(split)));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const rules = validateUpstreamErrorRules([{
      name: 'New API 余额不足', kind: 'billing_blocked', statuses: [403],
      matchers: [
        { source: 'json', path: 'error.type', operator: 'equals', value: 'new_api_error' },
        { source: 'json', path: 'error.code', operator: 'equals', value: 'insufficient_user_quota' }
      ]
    }]);
    const accounts = ['depleted', 'healthy'].map((name, i) => ({
      accountRef: `acct_${String(i + 1).padStart(20, '0')}`, provider: 'codex',
      accessToken: `fixture-${name}`, apiKeyMode: true, authType: 'api-key',
      openaiBaseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      upstreamErrorRules: i === 0 ? rules : []
    }));
    const sessionKey = 'existing-session';
    const state = { accounts: { codex: accounts }, cursors: {},
      metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 },
      sessionAffinity: { codex: new Map([
        [sessionKey, { accountRef: accounts[0].accountRef, expiresAt: Date.now() + 60000 }],
        ['other-depleted-session', { accountRef: accounts[0].accountRef, expiresAt: Date.now() + 60000 }],
        ['healthy-session', { accountRef: accounts[1].accountRef, expiresAt: Date.now() + 60000 }]
      ]) }
    };
    const persisted = new Map();
    const hub = createAccountRuntimeEventHub({ onError(error) { throw error; } });
    const publisher = createAccountRuntimeEventPublisher(hub);
    const unsubscribe = registerAccountRuntimeEventListeners(hub, { state, accountStateService: {
      recordRuntimeFailure(ref, _provider, runtimeState) {
        persisted.set(ref, structuredClone(runtimeState));
        return true;
      }
    } });
    t.after(() => unsubscribe.forEach(off => off()));
    let refreshes = 0;
    const deps = {
      chooseServerAccount, pushMetricError() {}, appendProxyRequestLog() {},
      fetchWithTimeout: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(3000) }),
      refreshCodexAccessToken: async () => { refreshes++; return { ok: true, refreshed: false }; },
      markProxyAccountFailure(account, ...args) {
        const previous = deriveAccountRuntimeStatus(account).status;
        markProxyAccountFailure(account, ...args);
        publisher.publishChanged(account, previous, 'server.upstream.failure');
      },
      markProxyAccountSuccess(account, ...args) {
        markProxyAccountSuccess(account, ...args);
        publisher.publishChanged(account, 'healthy', 'server.upstream.success');
      },
      writeJson(res, status, data) { res.statusCode = status; res.end(JSON.stringify(data)); }
    };
    async function request() {
      const res = captureResponse();
      const requestJson = { model: 'gpt-5.6-sol', stream: true, messages: [{ role: 'user', content: 'local fixture' }] };
      await handleUpstreamPassthrough({ state, deps, res,
        options: { provider: 'codex', port: 1, maxAttempts: 3, upstreamTimeoutMs: 3000, failureThreshold: 1 },
        req: { url: '/v1/chat/completions', headers: { 'content-type': 'application/json' } },
        method: 'POST', requestJson, bodyBuffer: Buffer.from(JSON.stringify(requestJson)),
        routeKey: 'POST /v1/chat/completions', requestStartedAt: Date.now(), cooldownMs: 1000,
        requestMeta: { sessionKey, clientProtocol: 'openai_chat' }
      });
      assert.equal(res.statusCode, 200, res.body);
      return res;
    }
    const first = await request();
    assert.equal(deriveAccountRuntimeStatus(accounts[0]).status, 'billing_blocked');
    assert.equal(persisted.get(accounts[0].accountRef).routingBlock.kind, 'billing_blocked');
    assert.equal(state.sessionAffinity.codex.has('other-depleted-session'), false);
    assert.equal(state.sessionAffinity.codex.get('healthy-session').accountRef, accounts[1].accountRef);
    if (failureTransport === 'http') {
      assert.equal(first.body, healthyFrame);
      assert.deepEqual(attempts, ['Bearer fixture-depleted', 'Bearer fixture-healthy']);
    } else {
      assert.equal(first.body, partial + errorFrame, 'a committed stream keeps its original bytes without replay');
      assert.equal(state.sessionAffinity.codex.has(sessionKey), false);
      assert.equal(state.metrics.totalSuccess, 0);
      assert.equal(state.metrics.totalFailures, 1);
      assert.deepEqual(attempts, ['Bearer fixture-depleted']);
    }
    const second = await request();
    assert.equal(second.body, healthyFrame);
    assert.equal(state.sessionAffinity.codex.get(sessionKey).accountRef, accounts[1].accountRef);
    assert.equal(attempts.filter(key => key === 'Bearer fixture-depleted').length, 1);
    assert.equal(refreshes, 0, 'configured billing errors never refresh OAuth credentials');
  });
}

for (const failureTransport of ['http', 'sse']) {
  test(`account error rules classify a real ${failureTransport} failure, rotate once and survive successful models probes`, async t => {
    const attempts = [];
    const server = http.createServer((req, res) => {
      const key = req.headers.authorization;
      req.resume();
      if (req.url.startsWith('/v1/models')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }));
        return;
      }
      attempts.push(key);
      if (key === 'Bearer fixture-depleted') {
        const error = { message: '用户额度不足, 剩余额度: ＄-0.028880', type: 'new_api_error', code: 'insufficient_user_quota' };
        res.statusCode = failureTransport === 'http' ? 403 : 200;
        res.setHeader('content-type', failureTransport === 'http' ? 'application/json' : 'text/event-stream');
        res.end(failureTransport === 'http' ? JSON.stringify({ error })
          : `data: ${JSON.stringify({ type: 'error', status: 403, error })}\n\n`);
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ type: 'response.completed', response: {
          id: 'fixture-success', model: 'gpt-5.6-sol', status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'recovered' }] }]
        } }));
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const rules = validateUpstreamErrorRules([{ name: '余额不足', kind: 'billing_blocked', statuses: [403],
      matchers: [{ field: 'code', pattern: '^insufficient_user_quota$' }] }]);
    const accounts = ['depleted', 'healthy'].map((name, i) => ({ accountRef: `acct_${String(i + 1).padStart(20, '0')}`,
      accessToken: `fixture-${name}`, apiKeyMode: true, authType: 'api-key', openaiBaseUrl: baseUrl,
      upstreamErrorRules: i === 0 ? rules : [] }));
    const state = { accounts: { codex: accounts }, cursors: {},
      metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 } };
    let refreshes = 0;
    const deps = { chooseServerAccount, markProxyAccountFailure, markProxyAccountSuccess, buildOpenAIModelsList,
      fetchWithTimeout: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(3000) }),
      pushMetricError() {}, appendProxyRequestLog() {},
      refreshCodexAccessToken: async () => { refreshes++; return { ok: true, refreshed: false }; },
      writeJson: (res, status, data) => { res.statusCode = status; res.end(JSON.stringify(data)); } };
    async function request() {
      const res = captureResponse();
      await handleCodexChatCompletions({ state, deps, res,
        options: { port: 1, maxAttempts: 3, upstreamTimeoutMs: 3000, failureThreshold: 1 },
        req: { headers: { 'x-account-ref': accounts[0].accountRef } },
        requestJson: { model: 'gpt-5.6-sol', stream: false, input: 'local fixture' },
        routeKey: 'POST /v1/responses', requestStartedAt: Date.now(), cooldownMs: 1000,
        requestMeta: { clientProtocol: 'openai_responses', sessionKey: 'fixture-affinity' } });
      assert.equal(res.statusCode, 200, res.body);
      assert.match(res.body, /recovered/);
    }
    await request();
    assert.equal(deriveAccountRuntimeStatus(accounts[0]).status, 'billing_blocked');
    const modelsResponse = captureResponse();
    await handleCodexModels({ state, deps, options: { port: 1, codexModels: ['gpt-5.6-sol'] },
      req: { headers: {} }, res: modelsResponse });
    assert.equal(modelsResponse.statusCode, 200, modelsResponse.body);
    assert.equal(deriveAccountRuntimeStatus(accounts[0]).status, 'billing_blocked');
    await request();
    assert.deepEqual(attempts, ['Bearer fixture-depleted', 'Bearer fixture-healthy', 'Bearer fixture-healthy']);
    assert.equal(refreshes, 0, 'a billing failure never triggers an OAuth refresh');
  });
}
