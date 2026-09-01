'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyUpstreamFailure } = require('../lib/server/upstream-failure-policy');
const { chooseServerAccount } = require('../lib/server/account-selector');
const { handleCodexChatCompletions } = require('../lib/server/codex-adapter');

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

test('auth_invalid policy on an OAuth account prefers api-key retry', () => {
  for (const statusCode of [401, 403]) {
    const policy = classifyUpstreamFailure({
      provider: 'codex',
      statusCode,
      body: '{"error":{"message":"invalid authentication"}}',
      detail: `upstream_${statusCode}`,
      account: { accountRef: accountRef('1'), authType: 'oauth', apiKeyMode: false }
    });
    assert.equal(policy.kind, 'auth_invalid');
    assert.equal(policy.shouldRetryAnotherAccount, true);
    assert.equal(policy.preferRetryAuthType, 'api-key');
  }
});

test('auth_invalid policy on an api-key account carries no retry preference', () => {
  for (const account of [
    { accountRef: accountRef('1'), authType: 'api-key' },
    { accountRef: accountRef('2'), apiKeyMode: true }
  ]) {
    const policy = classifyUpstreamFailure({
      provider: 'codex',
      statusCode: 401,
      body: '{"error":{"message":"invalid api key"}}',
      detail: 'upstream_401',
      account
    });
    assert.equal(policy.kind, 'auth_invalid');
    assert.equal(policy.preferRetryAuthType, '');
  }
});

test('auth_invalid policy without account context carries no retry preference', () => {
  const policy = classifyUpstreamFailure({
    provider: 'codex',
    statusCode: 401,
    body: '{"error":{"message":"unauthorized"}}',
    detail: 'upstream_401'
  });
  assert.equal(policy.kind, 'auth_invalid');
  assert.equal(policy.preferRetryAuthType, '');
});

test('selector preferAuthType api-key reroutes round-robin pick to api-key account', () => {
  const oauthAccount = { accountRef: accountRef('1'), accessToken: 'tok-a', authType: 'oauth' };
  const apiKeyAccount = { accountRef: accountRef('2'), accessToken: 'sk-b', authType: 'api-key', apiKeyMode: true };

  const baseline = chooseServerAccount([oauthAccount, apiKeyAccount], { cursors: {} }, 'codex', {
    provider: 'codex',
    cursorState: { codex: 0 }
  });
  assert.equal(baseline.accountRef, oauthAccount.accountRef);

  const preferred = chooseServerAccount([oauthAccount, apiKeyAccount], { cursors: {} }, 'codex', {
    provider: 'codex',
    cursorState: { codex: 0 },
    preferAuthType: 'api-key'
  });
  assert.equal(preferred.accountRef, apiKeyAccount.accountRef);
});

test('selector preferAuthType falls back to OAuth accounts when no api-key account is healthy', () => {
  const oauthA = { accountRef: accountRef('1'), accessToken: 'tok-a', authType: 'oauth' };
  const oauthB = { accountRef: accountRef('2'), accessToken: 'tok-b', authType: 'oauth' };
  const cooledApiKey = {
    accountRef: accountRef('3'),
    accessToken: 'sk-c',
    authType: 'api-key',
    apiKeyMode: true,
    cooldownUntil: Date.now() + 60_000
  };

  // 排序偏好而非硬过滤：唯一 api-key 账号冷却中（health 语义不变），退回健康 OAuth 账号。
  const picked = chooseServerAccount([oauthA, oauthB, cooledApiKey], { cursors: {} }, 'codex', {
    provider: 'codex',
    cursorState: { codex: 0 },
    preferAuthType: 'api-key'
  });
  assert.equal(picked.accountRef, oauthA.accountRef);
});

test('selector explicit preferredAccountRef still wins over preferAuthType', () => {
  const oauthAccount = { accountRef: accountRef('1'), accessToken: 'tok-a', authType: 'oauth' };
  const apiKeyAccount = { accountRef: accountRef('2'), accessToken: 'sk-b', authType: 'api-key', apiKeyMode: true };

  const picked = chooseServerAccount([oauthAccount, apiKeyAccount], { cursors: {} }, 'codex', {
    provider: 'codex',
    cursorState: { codex: 0 },
    preferredAccountRef: oauthAccount.accountRef,
    preferAuthType: 'api-key'
  });
  assert.equal(picked.accountRef, oauthAccount.accountRef);
});

test('codex adapter retries OAuth 401 on a healthy api-key account first', async () => {
  const res = createResCapture();
  const oauthA = { accountRef: accountRef('1'), email: 'a@example.com', accessToken: 'tok-a', authType: 'oauth' };
  const oauthB = { accountRef: accountRef('2'), email: 'b@example.com', accessToken: 'tok-b', authType: 'oauth' };
  const apiKeyC = {
    accountRef: accountRef('3'),
    email: 'c@example.com',
    accessToken: 'sk-c',
    authType: 'api-key',
    apiKeyMode: true,
    openaiBaseUrl: 'https://proxy.example.com/v1'
  };
  const state = {
    accounts: { codex: [oauthA, oauthB, apiKeyC] },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  const attemptedRefs = [];

  await handleCodexChatCompletions({
    options: {
      codexBaseUrl: 'https://chatgpt.com/backend-api/codex',
      upstreamTimeoutMs: 3000,
      maxAttempts: 3,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: { headers: { 'content-type': 'application/json' } },
    res,
    requestJson: {
      model: 'gpt-5.4',
      stream: false,
      messages: [{ role: 'user', content: 'hello' }]
    },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 1000,
    requestMeta: { sessionKey: 's' },
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
        const ref = String(init && init.headers && init.headers['x-aih-account-ref'] || '');
        attemptedRefs.push(ref);
        if (ref === oauthA.accountRef) {
          return {
            ok: false,
            status: 401,
            headers: new Map(),
            text: async () => '{"error":{"message":"invalid authentication"}}'
          };
        }
        return {
          ok: true,
          status: 200,
          headers: new Map(),
          text: async () => JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_ok',
              created_at: 1700000000,
              model: 'gpt-5.4',
              output: [{
                type: 'message',
                content: [{ type: 'output_text', text: 'ok' }]
              }],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
            }
          })
        };
      },
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {}
    }
  });

  // 轮询裸顺序本应落到第二个 OAuth 账号；定向偏好把重试定向到健康的 api-key 账号。
  assert.deepEqual(attemptedRefs, [oauthA.accountRef, apiKeyC.accountRef]);
  assert.equal(res.statusCode, 200);
});
