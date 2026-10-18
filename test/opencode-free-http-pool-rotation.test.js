'use strict';

// 免费档 429（出口 IP 限流）的出口池轮换只对**确实走了出口池**的请求生效：
// url / system / 未绑定的账号轮换池既救不了自己，又会打乱其它用池账号的节点。

const test = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../lib/runtime/egress-pool-registry');
const { openCodeFreeHttpTransport } = require('../lib/server/upstream-endpoints-transport-opencode-free-http');

function freeUsageLimitError() {
  const error = new Error('HTTP_429');
  error.code = 'HTTP_429';
  error.statusCode = 429;
  error.responseBody = JSON.stringify({ type: 'error', error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached' } });
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

test('pool-bound account: 429 FreeUsageLimitError rotates the pool and retries without accounting', async (t) => {
  t.after(() => registry.resetEgressPoolServiceForTests());
  const rotations = installPool();
  const { ctx, failures } = buildCtx('pool');
  const action = await openCodeFreeHttpTransport.run(ctx);
  assert.deepEqual(action, { action: 'retry_next' });
  assert.equal(rotations(), 1);
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
