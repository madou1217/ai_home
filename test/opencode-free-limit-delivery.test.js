'use strict';

// 免费档 429 的「什么时候恢复」必须交到客户端手上（2026-10-22，对齐 opencode 2.1.2）。
//
// 上游把恢复时刻只写在响应头里（retry-after / retry-after-ms），opencode 自己的客户端就是
// 解析它渲染 "Resets at …"。链路有三段，任何一段丢掉这个头，客户端都只能立刻再试：
//   ① opencode-zen-free-client 把响应头挂在错误上；
//   ② upstream-failure-policy 用它当 (账号,模型) 冷却；
//   ③ upstream-endpoints 把冷却同源的秒数写进 retry-after 与响应体。
// ① ② 由各自单测覆盖，这里守 ③ 的端到端形态。

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleUpstreamPassthrough } = require('../lib/server/upstream-endpoints');
const { chooseServerAccount, markProxyAccountFailure } = require('../lib/server/router');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';
const MODEL = 'opencode/deepseek-v4.1-flash-free';

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

function freeLimitError(responseHeaders) {
  const error = new Error('HTTP 429');
  error.code = 'HTTP_429';
  error.statusCode = 429;
  error.responseBody = JSON.stringify({
    type: 'error',
    error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached.' }
  });
  error.responseHeaders = responseHeaders || {};
  return error;
}

async function runRequest({ responseHeaders, maxAttempts = 1, blockedAccount = false }) {
  const account = { accountRef: ACCOUNT_REF, provider: 'opencode', accessToken: 'sk-fixture' };
  const pool = [account];
  if (blockedAccount) {
    // 账号级冷却 = 硬阻断（选择器直接拦下），模拟「另一个账号要重新登录 / 被限额」。
    pool.push({ accountRef: 'acct_ffffffffffffffffffff', provider: 'opencode', cooldownUntil: Date.now() + 3_600_000 });
  }
  const state = {
    accounts: { opencode: pool },
    cursors: { opencode: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  const requestJson = { model: MODEL, messages: [{ role: 'user', content: 'hi' }] };
  const res = createResponseCapture();
  let upstreamCalls = 0;
  await handleUpstreamPassthrough({
    options: { provider: 'opencode', upstreamTimeoutMs: 3000, maxAttempts },
    state,
    req: { url: '/v1/chat/completions', headers: {} },
    res,
    method: 'POST',
    bodyBuffer: Buffer.from(JSON.stringify(requestJson)),
    requestJson,
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 60_000,
    requestMeta: { requestId: 'req-free-limit' },
    deps: {
      chooseServerAccount,
      pushMetricError: () => {},
      writeJson: (response, code, payload) => { response.statusCode = code; response.end(JSON.stringify(payload)); },
      fetchWithTimeout: async () => { throw new Error('unexpected'); },
      fetchOpenCodeZenFreeChatCompletion: async () => {
        upstreamCalls += 1;
        throw freeLimitError(responseHeaders);
      },
      markProxyAccountFailure,
      markProxyAccountSuccess: () => assert.fail('a limited request cannot succeed'),
      recordModelUsage: () => assert.fail('a limited request cannot create usage'),
      appendProxyRequestLog: () => {}
    }
  });
  return { res, account, upstreamCalls };
}

test('a free-limit 429 hands the upstream reset time to the client', async () => {
  const { res, account, upstreamCalls } = await runRequest({ responseHeaders: { 'retry-after': '21600' } });
  assert.equal(upstreamCalls, 1);
  // 上游状态码原样交回（不是合成的 503 no_available_account）。
  assert.equal(res.statusCode, 429);
  // 头与体都给：CLI 客户端读头，WebUI / 调试读体。
  assert.equal(res.headers['retry-after'], '21600');
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'upstream_failed');
  assert.equal(body.retryAfterSeconds, 21600);
  // 冷却同源：这个 (账号,模型) 在同一个时刻之前不再被路由选中，重撞随之消失。
  const cooldownUntil = Number(account.modelCooldowns && account.modelCooldowns[MODEL]);
  assert.ok(cooldownUntil > Date.now() + 6 * 60 * 60 * 1000 - 60_000, '模型冷却应对齐上游的 6 小时');
  assert.ok(cooldownUntil <= Date.now() + 6 * 60 * 60 * 1000 + 60_000);
});

test('the millisecond reset header is delivered in the same shape', async () => {
  const { res } = await runRequest({ responseHeaders: { 'retry-after-ms': '21600000' } });
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['retry-after'], '21600');
  assert.equal(JSON.parse(res.body).retryAfterSeconds, 21600);
});

test('a 429 without a reset hint carries no retry-after at all', async () => {
  const { res } = await runRequest({});
  assert.equal(res.statusCode, 429);
  // 上游没说等多久就不要编一个：客户端按自己的策略退避。
  assert.equal(res.headers['retry-after'], undefined);
  assert.equal(JSON.parse(res.body).retryAfterSeconds, undefined);
});

test('an absurd hint is capped in both the cooldown and the delivered retry-after', async () => {
  // 同源是关键：不能「网关只冷 24 小时、却告诉客户端等一年」。
  const { res, account } = await runRequest({ responseHeaders: { 'retry-after': '31536000' } });
  assert.equal(res.headers['retry-after'], String(24 * 60 * 60));
  assert.equal(JSON.parse(res.body).retryAfterSeconds, 24 * 60 * 60);
  const cooldownUntil = Number(account.modelCooldowns && account.modelCooldowns[MODEL]);
  assert.ok(cooldownUntil <= Date.now() + 24 * 60 * 60 * 1000 + 60_000);
});

// 池里还有账号、但它被硬阻断（要重新登录 / 账号级限额）时，编排结果是 no_account：
// 这时客户端拿到的是「本次请求里最后一次真实的上游失败」的重放，而不是合成的
// 503 no_available_account —— 重放同样要带 retry-after，否则这条路径又把恢复时刻丢了。
test('the replayed upstream 429 keeps the reset header when the pool runs dry', async () => {
  const { res, upstreamCalls } = await runRequest({
    responseHeaders: { 'retry-after': '21600' },
    maxAttempts: 2,
    blockedAccount: true
  });
  // 只打了健康的那一个账号：被硬阻断的账号不该被选中。
  assert.equal(upstreamCalls, 1);
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['retry-after'], '21600');
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'upstream_failed');
  assert.match(String(body.detail || ''), /429/);
});
