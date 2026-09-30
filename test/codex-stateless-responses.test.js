'use strict';

// ChatGPT 登录账号的上游不存储 response：store 必须为 false，previous_response_id 无法解析。
// 真实故障:gpt-6.1-sol 同步 /v1/responses 先后 400 "Store must be set to false" 与
// "One of input or previous_response_id … must be provided"。

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleCodexChatCompletions } = require('../lib/server/codex-adapter');
const {
  findStatelessContinuationConflict,
  describeResponsesRequestShape
} = require('../lib/server/codex-stateless-responses');

const COMPLETED_SSE = [
  'data: {"type":"response.created","response":{"id":"resp_next","model":"gpt-6.1-sol"}}',
  '',
  'data: {"type":"response.completed","response":{"id":"resp_next","object":"response","status":"completed","model":"gpt-6.1-sol","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}]}}',
  '',
  'data: [DONE]',
  ''
].join('\n');

function createRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    write(chunk = '') { this.body += String(chunk); },
    end(chunk = '') { this.body += String(chunk); }
  };
}

async function runRequest(account, requestJson) {
  const res = createRes();
  const fetches = [];
  const failures = [];
  await handleCodexChatCompletions({
    options: { codexBaseUrl: 'https://chatgpt.com/backend-api/codex', upstreamTimeoutMs: 3000, maxAttempts: 1, failureThreshold: 1, logRequests: false },
    state: { accounts: { codex: [account] }, cursors: { codex: 0 }, metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 } },
    req: { headers: { 'content-type': 'application/json', 'user-agent': 'OpenAI/Python 2.0' } },
    res,
    requestJson,
    routeKey: 'POST /v1/responses',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { sessionKey: 's', clientProtocol: 'openai_responses' },
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
      refreshCodexAccessToken: async () => ({ ok: true, refreshed: false }),
      fetchWithTimeout: async (_url, init) => {
        fetches.push(JSON.parse(String(init && init.body || '{}')));
        return { ok: true, status: 200, headers: { get: () => 'text/event-stream' }, text: async () => COMPLETED_SSE };
      },
      markProxyAccountFailure: (...args) => failures.push(args),
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });
  return { res, fetches, failures };
}

const OAUTH = { accountRef: `acct_${'1'.padStart(20, '0')}`, email: 'u@example.com', accessToken: 'tok', authType: 'oauth' };
const API_KEY = { accountRef: `acct_${'2'.padStart(20, '0')}`, email: 'k@example.com', accessToken: 'sk-live', apiKeyMode: true, authType: 'api-key', openaiBaseUrl: 'https://api.openai.com/v1' };

test('ChatGPT sign-in accounts always send store:false, whatever the client asked', async () => {
  for (const store of [true, undefined]) {
    const { res, fetches } = await runRequest(OAUTH, {
      model: 'gpt-6.1-sol',
      store,
      input: [
        { type: 'message', id: 'msg_hist1', role: 'assistant', content: 'old' },
        { type: 'message', role: 'user', content: 'hi' }
      ]
    });
    assert.equal(res.statusCode, 200);
    assert.equal(fetches[0].store, false);
    assert.equal(fetches[0].stream, true);
    assert.equal(Object.hasOwn(fetches[0].input[0], 'id'), false);
  }
});

test('string input becomes a user message list for ChatGPT sign-in accounts', async () => {
  const { res, fetches } = await runRequest(OAUTH, { model: 'gpt-6.1-sol', store: true, input: '只回复两个字：收到' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(fetches[0].input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '只回复两个字：收到' }] }
  ]);
});

test('a continuation that needs stored state is refused locally without touching the account', async () => {
  for (const requestJson of [
    { model: 'gpt-6.1-sol', store: false, previous_response_id: 'resp_prev', input: [] },
    { model: 'gpt-6.1-sol', previous_response_id: 'resp_prev', input: [{ type: 'message', role: 'user', content: 'next' }] }
  ]) {
    const { res, fetches, failures } = await runRequest(OAUTH, requestJson);
    assert.equal(res.statusCode, 400);
    assert.equal(fetches.length, 0);
    assert.equal(failures.length, 0);
    const body = JSON.parse(res.body);
    assert.equal(body.error.code, 'previous_response_not_found');
    assert.equal(body.error.param, 'previous_response_id');
  }
});

test('store:false with the full history inline still drops the chain reference and succeeds', async () => {
  const { res, fetches } = await runRequest(OAUTH, {
    model: 'gpt-6.1-sol',
    store: false,
    previous_response_id: 'resp_prev',
    input: [{ type: 'message', role: 'user', content: 'full history' }]
  });
  assert.equal(res.statusCode, 200);
  assert.equal(Object.hasOwn(fetches[0], 'previous_response_id'), false);
});

test('API key accounts keep store and previous_response_id for the real OpenAI store', async () => {
  const { fetches } = await runRequest(API_KEY, {
    model: 'gpt-6.1-sol',
    store: true,
    previous_response_id: 'resp_prev',
    input: [{ type: 'message', role: 'user', content: 'next' }]
  });
  assert.equal(fetches[0].store, true);
  assert.equal(fetches[0].previous_response_id, 'resp_prev');
});

test('conflict detection and request shape', () => {
  assert.equal(findStatelessContinuationConflict({ input: 'hi' }), null);
  assert.equal(findStatelessContinuationConflict({ store: false, previous_response_id: 'r', input: 'x' }), null);
  assert.ok(findStatelessContinuationConflict({ store: false, previous_response_id: 'r' }));
  assert.deepEqual(describeResponsesRequestShape({ headers: { 'user-agent': 'OpenAI/Python 2.0' } }, { previous_response_id: 'r', input: [] }), {
    client: { 'user-agent': 'OpenAI/Python 2.0' },
    store: 'unset',
    stream: false,
    previousResponseId: true,
    inputType: 'array',
    inputItems: 0
  });
});
