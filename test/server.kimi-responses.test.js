'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { handleV1Request } = require('../lib/server/v1-router');
const { handleUpstreamPassthrough } = require('../lib/server/upstream-endpoints');
const { chooseServerAccount, resolveRequestProvider } = require('../lib/server/router');
const { createMemoryResponse } = require('../lib/server/protocol-fallback-bridge');

const FIRST_REF = 'acct_11111111111111111111';
const SECOND_REF = 'acct_22222222222222222222';

// Exercise the real Responses router, adapters, account selection and Kimi
// passthrough; only the upstream I/O and credential refresh are test doubles.
async function requestKimi({ stream = false, accountRef = SECOND_REF, status = 200 } = {}) {
  const requests = [];
  const refreshedAccounts = [];
  const accounts = [FIRST_REF, SECOND_REF].map((ref) => ({
    accountRef: ref, provider: 'kimi', authType: 'oauth', apiKeyMode: false,
    accessToken: `probe-${ref}`, refreshToken: 'local-refresh-probe',
    tokenExpiresAt: Date.now() + 3600000, availableModels: ['k3'],
    openaiBaseUrl: 'https://api.kimi.com/coding/v1'
  }));
  const res = createMemoryResponse();
  const input = { model: 'k3', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    max_output_tokens: 64, stream, reasoning: { effort: 'max' },
    tools: [{ type: 'function', name: 'lookup', description: 'Look up a value',
      parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }] };
  const handled = await handleV1Request({
    req: { headers: { 'x-provider': 'kimi', 'x-account-ref': accountRef }, url: '/v1/responses' },
    res, method: 'POST', pathname: '/v1/responses',
    options: { backend: 'codex-adapter', provider: 'auto', maxAttempts: 1, upstreamTimeoutMs: 3000 },
    state: { accounts: { kimi: accounts }, cursors: { kimi: 0 },
      metrics: { totalRequests: 0, totalSuccess: 0, totalFailures: 0, routeCounts: {} } },
    requiredClientKey: '', cooldownMs: 1000, maxRequestBodyBytes: 1024 * 1024, requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (target, code, payload) => {
        target.statusCode = code;
        target.setHeader('content-type', 'application/json');
        target.end(JSON.stringify(payload));
      },
      readRequestBody: async () => Buffer.from(JSON.stringify(input)),
      chooseServerAccount, resolveRequestProvider, handleUpstreamPassthrough,
      handleCodexChatCompletions: async () => assert.fail('Kimi must not dispatch to Codex'),
      refreshKimiAccessToken: async (account, options) => {
        if (!options.force) return { ok: true, refreshed: false };
        refreshedAccounts.push(account.accountRef);
        return { ok: false, refreshed: false, reason: 'refresh_unauthorized', oauthError: 'invalid_grant' };
      },
      fetchWithTimeout: async (url, init) => {
        requests.push({ url: String(url), authorization: init.headers.authorization, body: JSON.parse(init.body) });
        if (status !== 200) return new Response(JSON.stringify({
          error: { message: 'Kimi credential rejected', type: 'invalid_authentication_error' }
        }), { status, headers: { 'content-type': 'application/json' } });
        if (stream) return new Response([
          { id: 'chatcmpl_kimi', model: 'k3', choices: [{ index: 0, delta: { role: 'assistant', content: 'world' } }] },
          { id: 'chatcmpl_kimi', model: 'k3', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }
        ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' }
        });
        return new Response(JSON.stringify({
          id: 'chatcmpl_kimi', object: 'chat.completion', model: 'k3',
          choices: [{ index: 0, message: { role: 'assistant', content: 'world' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
        }), { headers: { 'content-type': 'application/json' } });
      },
      markProxyAccountSuccess: () => {}, markProxyAccountFailure: () => {},
      pushMetricError: () => {}, appendProxyRequestLog: () => {}
    }
  });
  assert.equal(handled, true);
  return { res, requests, refreshedAccounts };
}

for (const stream of [false, true]) {
  test(`Kimi Responses ${stream ? 'stream' : 'JSON'} reaches Chat passthrough on the pinned account`, async () => {
    const { res, requests } = await requestKimi({ stream });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.url, 'https://api.kimi.com/coding/v1/chat/completions');
    assert.equal(request.authorization, `Bearer probe-${SECOND_REF}`);
    assert.equal(request.body.model, 'k3');
    assert.equal(request.body.stream, stream);
    assert.equal(request.body.max_completion_tokens, 64);
    assert.deepEqual(request.body.thinking, { type: 'enabled', effort: 'max' });
    assert.equal(Object.hasOwn(request.body, 'max_tokens'), false);
    assert.equal(Object.hasOwn(request.body, 'reasoning_effort'), false);
    assert.deepEqual(request.body.messages, [{ role: 'user', content: 'hello' }]);
    assert.equal(request.body.tools[0].function.name, 'lookup');
    if (stream) {
      assert.match(res.headers['content-type'], /text\/event-stream/);
      assert.match(res.body, /event: response\.output_text\.delta/);
      assert.match(res.body, /"delta":"world"/);
      assert.match(res.body, /event: response\.completed/);
    } else {
      const response = JSON.parse(res.body);
      assert.equal(response.object, 'response');
      assert.equal(response.output[0].content[0].text, 'world');
      assert.deepEqual(response.usage, { input_tokens: 2, output_tokens: 3, total_tokens: 5 });
    }
  });

  test(`Kimi Responses ${stream ? 'stream' : 'JSON'} preserves upstream 401 and the same-account refresh hook`, async () => {
    const { res, requests, refreshedAccounts } = await requestKimi({ stream, status: 401 });
    assert.equal(res.statusCode, 401, res.body);
    assert.equal(requests.length, 1);
    assert.deepEqual(refreshedAccounts, [SECOND_REF]);
    assert.match(res.body, /auth_invalid_reauth_required/);
  });
}

test('Kimi Responses rejects a missing pinned account without borrowing another account', async () => {
  const { res, requests } = await requestKimi({ accountRef: 'acct_33333333333333333333' });
  assert.equal(res.statusCode, 404, res.body);
  assert.deepEqual(requests, []);
});
