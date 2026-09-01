'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseServerAccount } = require('../lib/server/account-selector');
const { handleCodexChatCompletions } = require('../lib/server/codex-adapter');

const accountRef = (value) => `acct_${String(value).padStart(20, '0')}`;

function createAffinityState(boundRef, sessionKey = 'sess-1') {
  return {
    sessionAffinity: {
      codex: new Map([[sessionKey, { accountRef: boundRef, expiresAt: Date.now() + 60_000 }]])
    }
  };
}

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

test('encrypted reasoning affinity keeps soft model-cooled bound account', () => {
  const bound = {
    accountRef: accountRef('1'),
    accessToken: 'token-a',
    modelCooldowns: { 'gpt-5.4': Date.now() + 60_000 }
  };
  const other = { accountRef: accountRef('2'), accessToken: 'token-b' };
  const state = createAffinityState(bound.accountRef);

  const picked = chooseServerAccount([bound, other], state, 'codex', {
    provider: 'codex',
    sessionKey: 'sess-1',
    model: 'gpt-5.4',
    preserveEncryptedReasoningAffinity: true
  });

  assert.equal(picked.accountRef, bound.accountRef);
});

test('without encrypted reasoning flag the soft-cooled bound account is bypassed', () => {
  const bound = {
    accountRef: accountRef('1'),
    accessToken: 'token-a',
    modelCooldowns: { 'gpt-5.4': Date.now() + 60_000 }
  };
  const other = { accountRef: accountRef('2'), accessToken: 'token-b' };
  const state = createAffinityState(bound.accountRef);

  const picked = chooseServerAccount([bound, other], state, 'codex', {
    provider: 'codex',
    sessionKey: 'sess-1',
    model: 'gpt-5.4'
  });

  // 基线行为：绑定账号被（账号,模型）软冷却过滤后，普通请求落到其他健康账号。
  assert.equal(picked.accountRef, other.accountRef);
});

test('encrypted reasoning affinity does not resurrect a hard-cooled bound account', () => {
  const bound = {
    accountRef: accountRef('1'),
    accessToken: 'token-a',
    cooldownUntil: Date.now() + 60_000
  };
  const other = { accountRef: accountRef('2'), accessToken: 'token-b' };
  const state = createAffinityState(bound.accountRef);

  const picked = chooseServerAccount([bound, other], state, 'codex', {
    provider: 'codex',
    sessionKey: 'sess-1',
    model: 'gpt-5.4',
    preserveEncryptedReasoningAffinity: true
  });

  assert.equal(picked.accountRef, other.accountRef);
});

test('encrypted reasoning affinity yields once the bound account was already attempted', () => {
  const bound = { accountRef: accountRef('1'), accessToken: 'token-a' };
  const other = { accountRef: accountRef('2'), accessToken: 'token-b' };
  const state = createAffinityState(bound.accountRef);

  // 绑定账号本请求已失败（excludeAccountRefs），必须换号——由出站清洗剥离
  // encrypted_content 降级重试，而不是死磕同一账号。
  const picked = chooseServerAccount([bound, other], state, 'codex', {
    provider: 'codex',
    sessionKey: 'sess-1',
    model: 'gpt-5.4',
    preserveEncryptedReasoningAffinity: true,
    excludeAccountRefs: new Set([bound.accountRef])
  });

  assert.equal(picked.accountRef, other.accountRef);
});

test('codex adapter prefers session-bound account for encrypted reasoning requests', async () => {
  const res = createResCapture();
  const boundAccount = {
    accountRef: accountRef('1'),
    email: 'a@example.com',
    accessToken: 'token-a',
    availableModels: ['gpt-5.4'],
    modelCooldowns: { 'gpt-5.4': Date.now() + 60_000 }
  };
  const state = {
    accounts: {
      codex: [
        boundAccount,
        { accountRef: accountRef('2'), email: 'b@example.com', accessToken: 'token-b', availableModels: ['gpt-5.4'] }
      ]
    },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 },
    sessionAffinity: {
      codex: new Map([['s', { accountRef: boundAccount.accountRef, expiresAt: Date.now() + 60_000 }]])
    }
  };
  let seenUpstreamAccount = '';
  let seenBody = null;

  await handleCodexChatCompletions({
    options: {
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      upstreamTimeoutMs: 3000,
      maxAttempts: 2,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { headers: { 'content-type': 'application/json' } },
    res,
    requestJson: {
      model: 'gpt-5.4',
      stream: true,
      previous_response_id: 'resp_chain',
      input: [
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_blob', summary: [] },
        { type: 'message', role: 'user', content: 'hello' }
      ]
    },
    routeKey: 'POST /v1/responses',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { sessionKey: 's', clientProtocol: 'openai_responses' },
    deps: {
      chooseServerAccount,
      pushMetricError: () => {},
      writeJson: (r, code, payload) => {
        r.statusCode = code;
        r.setHeader('content-type', 'application/json');
        r.end(JSON.stringify(payload));
      },
      refreshCodexAccessToken: async () => ({ ok: true, refreshed: false, reason: 'not_due' }),
      fetchWithTimeout: async (_url, init) => {
        seenUpstreamAccount = init.headers['x-aih-account-ref'];
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

  // 绑定账号仅软冷却仍被硬性优先（能不解密就不换号）；store 未关时链式引用正常透传。
  assert.equal(seenUpstreamAccount, boundAccount.accountRef);
  assert.equal(seenBody.previous_response_id, 'resp_chain');
  assert.equal(Object.hasOwn(seenBody.input[0], 'encrypted_content'), false);
  assert.equal(res.statusCode, 200);
});
