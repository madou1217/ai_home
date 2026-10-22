'use strict';

// 免费档 429（出口 IP 限流）的出口池轮换只对**确实走了出口池**的请求生效：
// url / system / 未绑定的账号轮换池既救不了自己，又会打乱其它用池账号的节点。

const test = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../lib/runtime/egress-pool-registry');
const { openCodeFreeHttpTransport } = require('../lib/server/upstream-endpoints-transport-opencode-free-http');
const { DEFAULT_MAX_EGRESS_HOPS } = require('../lib/server/opencode-free-egress-rotation');

function freeUsageLimitError(responseHeaders) {
  const error = new Error('HTTP_429');
  error.code = 'HTTP_429';
  error.statusCode = 429;
  error.responseBody = JSON.stringify({ type: 'error', error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached' } });
  // opencode-zen-free-client 会把响应头挂在这里；上游的重置时刻只存在于头上。
  error.responseHeaders = responseHeaders || {};
  return error;
}

function buildCtx(accountEgressSource) {
  const failures = [];
  const recorded = [];
  const ctx = {
    options: { logRequests: false },
    state: { metrics: { totalTimeouts: 0, totalFailures: 0, providerFailures: {} } },
    res: {},
    requestJson: { model: 'glm-5.3-flash-free', messages: [{ role: 'user', content: 'hi' }] },
    routeKey: 'POST /v1/chat/completions',
    requestStartedAt: Date.now(),
    cooldownMs: 60000,
    requestMeta: { requestId: 'req-1' },
    deps: {
      fetchOpenCodeZenFreeChatCompletion: async () => { throw freeUsageLimitError(); }
    },
    provider: 'opencode',
    streamRequested: false,
    recordAccountSuccess: () => {},
    recordAccountFailure: (account, policy) => failures.push(policy),
    upstreamFailureRecorder: { record: (entry) => recorded.push(entry) },
    diagnosticMaxAttempts: () => 3,
    fetchWithTimeout: async () => { throw new Error('unexpected'); },
    recordModelUsage: () => {},
    appendProxyRequestLog: () => {},
    control: { attempt: 0, setLastError: () => {} },
    account: { accountRef: 'acct_opencode_1', provider: 'opencode' },
    accountEgressSource,
    attemptUpstreamTimeoutMs: 1000,
    attemptMutable: {}
  };
  return { ctx, failures, recorded };
}

function installPool() {
  let rotations = 0;
  registry.setEgressPoolService({
    ready: true,
    proxyUrl: 'http://127.0.0.1:17890',
    runtime: { rotateNode: async () => { rotations += 1; return `node-${rotations}`; } }
  });
  return () => rotations;
}

// 2026-10-18：单账号池的 maxAttempts = 1，旧逻辑「轮换后 retry_next 换账号」没有下一次
// 尝试，节点换了请求照样失败。现在出口受限时在 transport 内**同账号原地**换节点重发。
test('pool-bound account: a limited exit is rotated and the same request succeeds in place', async (t) => {
  t.after(() => registry.resetEgressPoolServiceForTests());
  const rotations = installPool();
  const { ctx, failures } = buildCtx('pool');
  let calls = 0;
  ctx.deps.fetchOpenCodeZenFreeChatCompletion = async () => {
    calls += 1;
    if (calls === 1) throw freeUsageLimitError();
    return { id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] };
  };
  const written = {};
  ctx.res = { setHeader: () => {}, end: (raw) => { written.body = String(raw); } };
  const action = await openCodeFreeHttpTransport.run(ctx);
  assert.deepEqual(action, { action: 'return' });
  assert.equal(calls, 2);
  assert.equal(rotations(), 1);
  assert.equal(failures.length, 0);
  assert.equal(ctx.res.statusCode, 200);
  assert.match(written.body, /"OK"/);
});

test('pool-bound account: a fully limited pool hands off to the account loop without accounting', async (t) => {
  t.after(() => registry.resetEgressPoolServiceForTests());
  const rotations = installPool();
  const { ctx, failures } = buildCtx('pool');
  const action = await openCodeFreeHttpTransport.run(ctx);
  assert.deepEqual(action, { action: 'retry_next' });
  // 原地跳数用完（DEFAULT_MAX_EGRESS_HOPS）后再轮换一次交给账号循环：多账号池时下一个
  // 账号直接用上新节点。全程是出口问题，不给账号记失败。
  assert.equal(rotations(), DEFAULT_MAX_EGRESS_HOPS + 1);
  assert.equal(failures.length, 0);
  assert.equal(ctx.attemptMutable.finalStatusCode, 429);
});

for (const source of ['url', 'system', '']) {
  test(`account egress "${source || 'unbound'}": 429 does not rotate the shared pool and records the failure`, async (t) => {
    t.after(() => registry.resetEgressPoolServiceForTests());
    const rotations = installPool();
    const { ctx, failures, recorded } = buildCtx(source);
    const action = await openCodeFreeHttpTransport.run(ctx);
    assert.equal(rotations(), 0);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].scope, 'model');
    assert.equal(recorded.length, 1);
    assert.deepEqual(action, { action: 'retry_next' });
  });
}

// 2026-10-22：上游把恢复时刻写在 retry-after 里（opencode 2.1.2 的「Resets at …」）。
// 这条头必须同时进两处：① 冷却（经 classifyUpstreamFailure 的 headers）；
// ② 客户端交付（attemptMutable.finalRetryAfterMs，由 upstream-endpoints 写成 retry-after）。
test('the upstream reset hint reaches both the cooldown and the client-facing retry-after', async (t) => {
  t.after(() => registry.resetEgressPoolServiceForTests());
  installPool();
  const { ctx, failures } = buildCtx('url');
  ctx.deps.fetchOpenCodeZenFreeChatCompletion = async () => {
    throw freeUsageLimitError({ 'retry-after': '21600' });
  };
  const action = await openCodeFreeHttpTransport.run(ctx);
  assert.deepEqual(action, { action: 'retry_next' });
  // ① 冷却：端点日额度用尽 → 6 小时，而不是历史固定的 5 分钟。
  assert.equal(failures.length, 1);
  assert.equal(failures[0].cooldownMs, 6 * 60 * 60 * 1000);
  assert.equal(failures[0].retryHintMs, 6 * 60 * 60 * 1000);
  // ② 交付：留给最终响应写 retry-after。
  assert.equal(ctx.attemptMutable.finalRetryAfterMs, 6 * 60 * 60 * 1000);
  assert.equal(ctx.attemptMutable.finalStatusCode, 429);
});

test('a 429 without any hint leaves the client-facing retry-after unset', async (t) => {
  t.after(() => registry.resetEgressPoolServiceForTests());
  installPool();
  const { ctx, failures } = buildCtx('url');
  const action = await openCodeFreeHttpTransport.run(ctx);
  assert.deepEqual(action, { action: 'retry_next' });
  assert.equal(failures[0].cooldownMs, 5 * 60 * 1000);
  // 0 = 上游没给：不写 retry-after，客户端按自己的策略退避。
  assert.equal(ctx.attemptMutable.finalRetryAfterMs, 0);
});

test('a rotated exit keeps the hint for the terminal 429 the pool hands back', async (t) => {
  t.after(() => registry.resetEgressPoolServiceForTests());
  const rotations = installPool();
  const { ctx, failures } = buildCtx('pool');
  ctx.deps.fetchOpenCodeZenFreeChatCompletion = async () => {
    throw freeUsageLimitError({ 'retry-after-ms': '21600000' });
  };
  const action = await openCodeFreeHttpTransport.run(ctx);
  // 跳数用完 → 交回账号循环；此时客户端拿到的就是这个 429，必须带 retry-after。
  assert.deepEqual(action, { action: 'retry_next' });
  assert.equal(rotations(), DEFAULT_MAX_EGRESS_HOPS + 1);
  assert.equal(failures.length, 0);
  assert.equal(ctx.attemptMutable.finalStatusCode, 429);
  assert.equal(ctx.attemptMutable.finalRetryAfterMs, 6 * 60 * 60 * 1000);
});
