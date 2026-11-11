'use strict';

// qoder HTTP 策略的**排队契约**（Node 回落路径）。
//
// 背景：chat completions 入口已由 Go 的 qoderrelay 承接（core/providers/builtins.go
// 的 relayHostsGoRelay），但账号绑定出口、自定义上游、未推送的错误规则等场景仍会
// 把请求留在 Node。这条回落路径必须与 Go 侧把同一件事讲清楚：
//   - 上游排队（HTTP 403 + 10605 / RESOURCE_LIMIT）→ 立刻 429 + retry-after，
//     不回落 CLI：CLI 排的是同一个队列，等下去只会让用户干等；
//   - 排队不是账号失败（不记 recordAccountFailure），否则健康账号会被冷却；
//   - 非排队失败仍交还 CLI（返回 null），同样不记账号失败（CLI 会再试一次）。
//
// 真机取证见 docs/providers/qoder-client-protocol.md（2026-10-21）：排队 16.6s /
// 115.4s / 177.3s，CLI 首字节预算 180s，再长就变成 504 空等。
//
// 本测试只钉协议事实，不启动服务、不打真实上游。

const test = require('node:test');
const assert = require('node:assert/strict');

const { qoderHttpTransport } = require('../lib/server/upstream-endpoints-transport-qoder-http');

// nestedQueuePayload 复刻真机三层 JSON：只有最内层带 isQueued / retryAfterSeconds。
function nestedQueuePayload(retryAfterSeconds) {
  const inner = JSON.stringify({
    isQueued: true,
    queueType: 'p3',
    retryAfterSeconds,
    waitTime: retryAfterSeconds,
    subCode: 'RESOURCE_LIMIT',
    serviceAvailable: false
  });
  const middle = JSON.stringify({ code: '10605', message: inner, subCode: 'RESOURCE_LIMIT' });
  return JSON.stringify({ code: '403', message: middle });
}

// responseRecorder 是 http.ServerResponse 的最小可观察替身。
function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    writableEnded: false,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    end(payload) {
      this.body = payload === undefined ? Buffer.alloc(0) : Buffer.from(payload);
      this.writableEnded = true;
    }
  };
}

// runQoderHttp 只跑一次策略（stream=false），并记录账号成功/失败与 attempt 注解。
async function runQoderHttp(error) {
  const res = responseRecorder();
  const failures = [];
  const successes = [];
  const attemptMutable = { annotations: {} };
  const context = {
    options: {},
    state: { metrics: { totalFailures: 0, totalTimeouts: 0, providerFailures: {} } },
    res,
    requestJson: { model: 'Qwen3.8-Flash', messages: [{ role: 'user', content: 'ping' }] },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 60_000,
    requestMeta: { requestId: 'req-qoder-contract' },
    deps: {
      fetchQoderHttpChatCompletion: async () => {
        throw error;
      }
    },
    provider: 'qoder',
    streamRequested: false,
    recordAccountSuccess: (account) => successes.push(account),
    recordAccountFailure: (account, policy) => failures.push(policy),
    diagnosticMaxAttempts: 1,
    recordModelUsage: () => {},
    appendProxyRequestLog: () => {},
    control: {},
    account: { accountRef: 'acct_0000000000000000000a', provider: 'qoder' },
    attemptUpstreamTimeoutMs: 30_000,
    attemptMutable
  };
  const result = await qoderHttpTransport.run(context);
  return { result, res, failures, successes, attemptMutable };
}

test('上游排队（403 + 10605）交付 429 + retry-after，且不回落 CLI', async () => {
  const error = new Error(nestedQueuePayload(30));
  error.statusCode = 403;
  const { result, res, failures, successes, attemptMutable } = await runQoderHttp(error);

  // action=return 终止 transport 链：CLI 走的是同一个队列，回落没有意义。
  assert.deepEqual(result, { action: 'return' });
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['retry-after'], '30');
  assert.equal(res.headers['x-aih-qoder-queue'], '1');
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  const payload = JSON.parse(res.body.toString('utf8'));
  assert.equal(payload.error.code, 'qoder_resource_limit');
  assert.equal(payload.error.type, 'qoder_resource_limit');

  // 排队与账号无关：不记账号失败，也不记成功。
  assert.deepEqual(failures, []);
  assert.deepEqual(successes, []);
  assert.equal(attemptMutable.streamTransport, 'qoder_http_queued');
  assert.equal(attemptMutable.annotations.qoderQueueShortCircuit, true);
  assert.equal(attemptMutable.annotations.qoderQueueRetryAfterMs, 30_000);
});

test('排队负载缺 retryAfterSeconds 时回落到 30 秒并仍标 429', async () => {
  const error = new Error(nestedQueuePayload(0));
  error.statusCode = 403;
  const { result, res, failures } = await runQoderHttp(error);

  assert.deepEqual(result, { action: 'return' });
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['retry-after'], '30');
  assert.deepEqual(failures, []);
});

test('非排队失败回落 CLI，且不记账号失败（CLI 会再试一次）', async () => {
  const error = new Error('upstream exploded');
  error.statusCode = 500;
  const { result, res, failures, attemptMutable } = await runQoderHttp(error);

  assert.equal(result, null);
  // 不写响应：回落后由链上的 CLI 策略接管。
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.headers, {});
  assert.equal(res.body, null);
  assert.deepEqual(failures, []);
  assert.equal(attemptMutable.annotations.qoderHttpFallback, true);
  const attempts = attemptMutable.annotations.transportAttempts;
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].transport, 'qoder_http');
  assert.equal(attempts[0].outcome, 'failure');
  assert.equal(attempts[0].details.streamTransport, 'qoder_http_failed');
});
