'use strict';

// zcode OAuth 计划账号推理的 3007 验证码拦截：缺 X-Aliyun-Captcha-Verify-Param
// 时上游返回 400 {"code":3007}，这是请求级拦截而非账号失效——首次 3007 不熔断，
// 经 zcodeCaptchaBridge 拿到一次性 verify param 后原样重发一次。

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleUpstreamPassthrough } = require('../lib/server/upstream-endpoints');

const ZCODE_PLAN_BASE = 'https://zcode.z.ai/api/v1/zcode-plan/anthropic';
const CAPTCHA_400_BODY = '{"code":3007,"msg":"captcha verify failed"}';

const accountRef = (value) => {
  const hex = Buffer.from(String(value)).toString('hex').slice(0, 20).padEnd(20, '0');
  return `acct_${hex}`;
};

function createResCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: Buffer.alloc(0),
    headersSent: false,
    writableEnded: false,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    flushHeaders() { this.headersSent = true; },
    write(chunk = '') {
      this.headersSent = true;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      this.body = Buffer.concat([this.body, buf]);
    },
    end(chunk = '') {
      if (chunk !== undefined && chunk !== null && String(chunk).length > 0) this.write(chunk);
      this.headersSent = true;
      this.writableEnded = true;
    }
  };
}

function createUpstreamResponse(status, bodyText) {
  return {
    status,
    headers: new Map([['content-type', 'application/json']]),
    clone() {
      return { text: async () => bodyText };
    },
    arrayBuffer: async () => Buffer.from(bodyText)
  };
}

function runZcodePassthrough(options = {}) {
  const account = {
    accountRef: accountRef(options.accountLabel || 'zcode-oauth'),
    email: 'zcode@example.com',
    provider: 'zcode',
    authType: options.apiKey ? 'api-key' : 'oauth',
    apiKeyMode: Boolean(options.apiKey),
    accessToken: options.apiKey ? 'zcode-api-key' : 'zai-access-token',
    zcodeJwtToken: options.apiKey ? '' : 'zcode-jwt-token',
    openaiBaseUrl: options.apiKey ? 'https://open.bigmodel.cn/api/anthropic' : ZCODE_PLAN_BASE,
    cooldownUntil: 0,
    consecutiveFailures: 0
  };
  const res = createResCapture();
  const state = {
    accounts: { zcode: [account] },
    cursors: { zcode: 0 },
    metrics: {
      totalFailures: 0,
      totalSuccess: 0,
      totalTimeouts: 0,
      providerCounts: {},
      providerSuccess: {},
      providerFailures: {}
    }
  };
  const fetchCalls = [];
  const failureMarks = [];
  const completion = handleUpstreamPassthrough({
    options: {
      provider: 'zcode',
      upstreamTimeoutMs: 3000,
      maxAttempts: 1,
      failureThreshold: 1,
      logRequests: false
    },
    state,
    req: {
      url: '/v1/messages',
      headers: { 'content-type': 'application/json' }
    },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from(JSON.stringify({ model: 'glm-5', messages: [] })),
    requestJson: { model: 'glm-5', messages: [] },
    routeKey: 'POST /v1/messages',
    requestStartedAt: Date.now(),
    cooldownMs: 60_000,
    deps: {
      chooseServerAccount: (pool) => pool[0],
      pushMetricError: () => {},
      writeJson: (response, code, payload) => {
        response.statusCode = code;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(payload));
      },
      fetchWithTimeout: async (url, init) => {
        fetchCalls.push({ url, headers: { ...(init && init.headers || {}) } });
        return options.onFetch
          ? options.onFetch(fetchCalls.length)
          : createUpstreamResponse(200, '{"ok":true}');
      },
      markProxyAccountFailure: (acc, info) => {
        failureMarks.push(info);
        acc.consecutiveFailures = Number(acc.consecutiveFailures || 0) + 1;
        acc.cooldownUntil = Date.now() + 60_000;
      },
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {},
      zcodeCaptchaBridge: options.captchaBridge
    }
  });
  return { completion, res, state, account, fetchCalls, failureMarks };
}

test('zcode OAuth 3007 triggers the captcha bridge and resends with verify headers', async () => {
  const bridgeCalls = [];
  const scenario = runZcodePassthrough({
    onFetch: (callIndex) => (callIndex === 1
      ? createUpstreamResponse(400, CAPTCHA_400_BODY)
      : createUpstreamResponse(200, '{"ok":true}')),
    captchaBridge: {
      requestVerification: async (ref, opts) => {
        bridgeCalls.push({ ref, opts });
        return { ok: true, verifyParam: 'verify-param-xyz', region: 'cn' };
      }
    }
  });
  await scenario.completion;

  assert.equal(scenario.res.statusCode, 200);
  assert.equal(String(scenario.res.body), '{"ok":true}');
  assert.equal(scenario.fetchCalls.length, 2, 'one 3007 attempt plus one captcha resend');
  assert.equal(scenario.fetchCalls[0].url, `${ZCODE_PLAN_BASE}/v1/messages`);
  assert.equal(scenario.fetchCalls[1].url, `${ZCODE_PLAN_BASE}/v1/messages`);

  // 桌面端同款双头：Bearer + x-api-key 均为 zcodeJwtToken，外加 anthropic-version。
  for (const call of scenario.fetchCalls) {
    assert.equal(call.headers.authorization, 'Bearer zcode-jwt-token');
    assert.equal(call.headers['x-api-key'], 'zcode-jwt-token');
    assert.equal(call.headers['anthropic-version'], '2023-06-01');
  }
  assert.equal(scenario.fetchCalls[0].headers['x-aliyun-captcha-verify-param'], undefined);
  assert.equal(scenario.fetchCalls[1].headers['x-aliyun-captcha-verify-param'], 'verify-param-xyz');
  assert.equal(scenario.fetchCalls[1].headers['x-aliyun-captcha-verify-region'], 'cn');

  assert.equal(bridgeCalls.length, 1);
  assert.equal(bridgeCalls[0].ref, scenario.account.accountRef);
  assert.equal(bridgeCalls[0].opts.timeoutMs, 120_000);

  // 首次 3007 不计失败、不熔断。
  assert.equal(scenario.failureMarks.length, 0);
  assert.equal(scenario.account.consecutiveFailures, 0);
  assert.equal(scenario.account.cooldownUntil, 0);
  assert.equal(scenario.state.metrics.totalSuccess, 1);
});

test('zcode OAuth captcha bridge failure returns 409 zcode_captcha_required without cooldown', async () => {
  const scenario = runZcodePassthrough({
    accountLabel: 'zcode-bridge-fail',
    onFetch: () => createUpstreamResponse(400, CAPTCHA_400_BODY),
    captchaBridge: {
      requestVerification: async () => ({ ok: false, reason: 'no_webui_listener' })
    }
  });
  await scenario.completion;

  assert.equal(scenario.res.statusCode, 409);
  const payload = JSON.parse(String(scenario.res.body));
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'zcode_captcha_required');
  assert.equal(payload.reason, 'no_webui_listener');
  // 桥失败不等于账号失效：不熔断、不重发。
  assert.equal(scenario.fetchCalls.length, 1);
  assert.equal(scenario.failureMarks.length, 0);
  assert.equal(scenario.account.cooldownUntil, 0);
});

test('zcode API-key accounts never hit the captcha bridge', async () => {
  let bridgeCalled = false;
  const scenario = runZcodePassthrough({
    apiKey: true,
    accountLabel: 'zcode-api-key',
    onFetch: () => createUpstreamResponse(400, CAPTCHA_400_BODY),
    captchaBridge: {
      requestVerification: async () => {
        bridgeCalled = true;
        return { ok: true, verifyParam: 'should-not-be-used' };
      }
    }
  });
  await scenario.completion;

  assert.equal(bridgeCalled, false);
  assert.equal(scenario.fetchCalls.length, 1);
  // API-key 账号按原有 400 逻辑处理：invalid_request 不记账号失败，错误回给客户端。
  assert.equal(scenario.res.statusCode, 400);
  const payload = JSON.parse(String(scenario.res.body));
  assert.equal(payload.error, 'upstream_failed');
  assert.ok(String(payload.detail).includes('3007'));
  assert.equal(scenario.failureMarks.length, 0);
  // x-api-key 是 API key 本身，无 Bearer。
  assert.equal(scenario.fetchCalls[0].headers['x-api-key'], 'zcode-api-key');
  assert.equal(scenario.fetchCalls[0].headers.authorization, undefined);
});

test('a second 3007 after the captcha resend falls back to normal failure handling', async () => {
  const scenario = runZcodePassthrough({
    accountLabel: 'zcode-captcha-rejected',
    onFetch: () => createUpstreamResponse(400, CAPTCHA_400_BODY),
    captchaBridge: {
      requestVerification: async () => ({ ok: true, verifyParam: 'verify-param-xyz', region: '' })
    }
  });
  await scenario.completion;

  assert.equal(scenario.fetchCalls.length, 2, 'the captcha resend happened');
  assert.equal(scenario.fetchCalls[1].headers['x-aliyun-captcha-verify-param'], 'verify-param-xyz');
  // 重发仍 3007 → 落入普通 400 失败路径：错误回给客户端（400 不记账号失败）。
  assert.equal(scenario.res.statusCode, 400);
  const payload = JSON.parse(String(scenario.res.body));
  assert.equal(payload.error, 'upstream_failed');
  assert.ok(String(payload.detail).includes('3007'));
  assert.equal(scenario.failureMarks.length, 0);
});
