'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleCodexChatCompletions, __private } = require('../lib/server/codex-adapter');

const accountRef = (value) => `acct_${String(value).padStart(20, '0')}`;

function createResCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    write(chunk = '') { this.body += String(chunk); },
    end(chunk = '') { this.body += String(chunk); }
  };
}

test('store:false outbound strips previous_response_id and unpersistable item ids', () => {
  const payload = __private.convertOpenAIResponsesToCodexPayload({
    model: 'gpt-5.4',
    store: false,
    previous_response_id: 'resp_previous',
    input: [
      { type: 'reasoning', id: 'rs_hist1', encrypted_content: 'enc_blob', summary: [] },
      { type: 'message', id: 'msg_hist1', role: 'assistant', content: 'old answer' },
      { type: 'function_call', id: 'fc_hist1', call_id: 'call_1', name: 'lookup', arguments: '{}' },
      { type: 'message', role: 'user', content: 'next question' }
    ]
  }, 'gpt-5.4');

  // store:false 时上游不持久化任何 item：链式引用与前缀合法的 item id 必然 404，出站前剥离。
  assert.equal(Object.hasOwn(payload, 'previous_response_id'), false);
  assert.equal(payload.store, false);
  assert.equal(Object.hasOwn(payload.input[0], 'id'), false);
  assert.equal(Object.hasOwn(payload.input[0], 'encrypted_content'), false);
  assert.equal(Object.hasOwn(payload.input[1], 'id'), false);
  assert.equal(Object.hasOwn(payload.input[2], 'id'), false);
  // 内容与无 id 的新 item 不受影响。
  assert.equal(payload.input[2].call_id, 'call_1');
  assert.deepEqual(payload.input[3], { type: 'message', role: 'user', content: 'next question' });
});

test('stored responses keep previous_response_id and prefix-valid item ids', () => {
  for (const store of [undefined, true]) {
    const payload = __private.convertOpenAIResponsesToCodexPayload({
      model: 'gpt-5.4',
      store,
      previous_response_id: 'resp_previous',
      input: [
        { type: 'reasoning', id: 'rs_hist1', encrypted_content: 'enc_blob', summary: [] },
        { type: 'message', id: 'msg_hist1', role: 'assistant', content: 'old answer' },
        { type: 'message', id: 'foreign_id', role: 'user', content: 'hi' }
      ]
    }, 'gpt-5.4');

    // store 开启（默认）时同账号链式调用的正常路径不变：引用与前缀合法 id 原样透传。
    assert.equal(payload.previous_response_id, 'resp_previous');
    assert.equal(payload.input[0].id, 'rs_hist1');
    assert.equal(payload.input[1].id, 'msg_hist1');
    // 既有规则不受影响：换号不可解密的 encrypted_content 与前缀不匹配的外来 id 仍剥离。
    assert.equal(Object.hasOwn(payload.input[0], 'encrypted_content'), false);
    assert.equal(Object.hasOwn(payload.input[2], 'id'), false);
  }
});

test('codex adapter drops store:false chain references before upstream fetch', async () => {
  const res = createResCapture();
  const state = {
    accounts: {
      codex: [{
        accountRef: accountRef('10015'),
        email: 'api@example.com',
        accessToken: 'sk-live',
        apiKeyMode: true,
        authType: 'api-key',
        openaiBaseUrl: 'https://proxy.example.com/v1'
      }]
    },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  let seenBody = null;

  await handleCodexChatCompletions({
    options: {
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { headers: { 'content-type': 'application/json' } },
    res,
    requestJson: {
      model: 'gpt-5.4',
      stream: true,
      store: false,
      previous_response_id: 'resp_previous',
      input: [
        { type: 'reasoning', id: 'rs_hist1', encrypted_content: 'enc_blob', summary: [] },
        { type: 'message', id: 'msg_hist1', role: 'user', content: 'hello' }
      ]
    },
    routeKey: 'POST /v1/responses',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { sessionKey: 's', clientProtocol: 'openai_responses' },
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      refreshCodexAccessToken: async () => ({ ok: true, refreshed: false, reason: 'api_key_mode' }),
      fetchWithTimeout: async (_url, init) => {
        seenBody = JSON.parse(String(init && init.body || '{}'));
        return {
          ok: true,
          status: 200,
          text: async () => [
            'data: {"type":"response.created","response":{"id":"resp_next","model":"gpt-5.4"}}',
            '',
            'data: {"type":"response.completed","response":{"id":"resp_next","object":"response","status":"completed","model":"gpt-5.4","output":[]}}',
            '',
            'data: [DONE]',
            ''
          ].join('\n')
        };
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(Object.hasOwn(seenBody, 'previous_response_id'), false);
  assert.equal(seenBody.store, false);
  assert.equal(Object.hasOwn(seenBody.input[0], 'id'), false);
  assert.equal(Object.hasOwn(seenBody.input[1], 'id'), false);
});
