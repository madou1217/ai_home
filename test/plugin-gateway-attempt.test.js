'use strict';

// 插件架构 M2 gateway.attempt：包在每次上游尝试外面的单次 next 洋葱中间件。
// 在真实 Plugin Host 子进程上验证：next 在提交点返回、至多一次、等待上游不计入插件预算、
// 拒绝/停止换号只能收窄、失败语义（deny/delegate）、洋葱顺序、挂起调用不挤占 inflight、
// 代次固定、客户端断开；再经真实 aih server（假上游）端到端验证上游命中次数与响应。
// 全部在 /tmp 临时目录与随机端口上运行，不触碰用户的 ~/.ai_home 与 9527。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('node:path');

const { tempDir, socketFor, manifest, packPlugin, waitFor, startClaudeServer } = require('./helpers/plugin-gateway-harness');
const { createPluginSystem } = require('../lib/plugins/control/plugin-system');
const { runAttemptStage } = require('../lib/plugins/gateway/attempt-stage');
const { createAttemptMiddleware } = require('../lib/server/gateway-plugin-stage');

function attemptManifest(pluginId, prefix, contribution = {}) {
  return manifest(pluginId, {
    configSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string' }, mode: { type: 'string' }, sleepMs: { type: 'number' } }
    },
    contributes: [
      { id: `${prefix}.attempt`, capability: 'gateway.attempt', version: 1, ...contribution },
      { id: `${prefix}.dump`, capability: 'command', version: 1 },
      { id: `${prefix}.order`, capability: 'command', version: 1 }
    ]
  });
}

// 一个可配置的中间件：mode 决定行为；log 记录它看到的摘要、二次 next 的错误与取消原因。
function attemptSource(prefix) {
  return `
const log = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export default { apply(ctx, config) {
  ctx.aih.register('${prefix}.dump', () => log.splice(0));
  ctx.aih.register('${prefix}.order', () => (globalThis.__aihAttemptOrder || []).splice(0));
  ctx.aih.register('${prefix}.attempt', async (value, context) => {
    const order = (globalThis.__aihAttemptOrder ||= []);
    order.push(config.name + ':in');
    context.signal.addEventListener('abort', () => log.push({ aborted: String(context.signal.reason && context.signal.reason.code) }));
    if (config.mode === 'reject') return { reject: { status: 451, message: 'blocked by ' + config.name } };
    if (config.mode === 'slow') await sleep(config.sleepMs);
    if (config.mode === 'noop') return null;
    const summary = await context.next();
    log.push({ value, summary });
    if (config.mode === 'twice') {
      try { await context.next(); } catch (error) { log.push({ twice: error.code }); }
    }
    order.push(config.name + ':out');
    if (config.mode === 'stop') return { recovery: 'stop' };
    return null;
  });
} };`;
}

async function withAttemptSystem(fn, plugins = [{ pluginId: 'aih.test.attempt-a', prefix: 'a' }]) {
  const dir = tempDir('aihat-');
  const aiHomeDir = path.join(dir, 'home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const system = createPluginSystem({ aiHomeDir, socketPath: socketFor(dir), backoffMs: [50] });
  try {
    for (const plugin of plugins) {
      system.control.install(packPlugin(dir, plugin.prefix, attemptManifest(plugin.pluginId, plugin.prefix, plugin.contribution), attemptSource(plugin.prefix)));
    }
    await fn(system);
  } finally {
    await system.runtime.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function fakeCommit() {
  const listeners = new Set();
  let committed = false;
  return {
    committed: () => committed,
    onCommit(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    fire(status = 200) {
      committed = true;
      for (const listener of [...listeners]) listener(status);
    }
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 假的上游尝试：记录命中次数；按脚本先提交再结束，或不提交直接给出失败动作。
function fakeAttempt(commit, script = {}) {
  const hits = { count: 0 };
  const run = async () => {
    hits.count += 1;
    if (script.beforeCommitMs) await sleep(script.beforeCommitMs);
    if (script.throws) throw script.throws;
    if (script.commit !== false) commit.fire(200);
    if (script.afterCommitMs) await sleep(script.afterCommitMs);
    return { action: script.action || 'return' };
  };
  return { hits, run };
}

function stageRequest(commit, attempt, extra = {}) {
  return {
    attempt: { provider: 'claude', model: 'claude-opus-5', attempt: 0, accountRef: 'acct_00000000000000000001', authType: 'oauth' },
    runAttempt: attempt.run,
    commit,
    lastError: () => 'upstream exploded',
    ...extra
  };
}

async function dump(runtime, prefix = 'a') {
  return (await runtime.invoke(`${prefix}.dump`, null)).value;
}

test('next() returns at the commit point, before the attempt finishes, and the attempt runs exactly once', async () => {
  await withAttemptSystem(async ({ control, runtime }) => {
    await control.enable({ pluginId: 'aih.test.attempt-a', configuration: { name: 'A', mode: 'pass' } });
    const lease = runtime.acquire();
    const commit = fakeCommit();
    const attempt = fakeAttempt(commit, { afterCommitMs: 300 });
    const stage = await runAttemptStage(runtime, lease, stageRequest(commit, attempt));
    lease.release();
    assert.equal(stage.started, true);
    assert.deepEqual(stage.outcome, { action: 'return' });
    assert.equal(stage.stop, false);
    assert.equal(attempt.hits.count, 1);
    const [entry] = await dump(runtime);
    assert.deepEqual(entry.summary, { committed: true, outcome: 'committed', status: 200, stopped: false });
    assert.deepEqual(Object.keys(entry.value).sort(), ['accountRef', 'attempt', 'authType', 'model', 'provider'], '插件看不到请求体与凭据');
  });
});

test('a second next() fails with plugin_next_called_twice and never re-runs the attempt', async () => {
  await withAttemptSystem(async ({ control, runtime }) => {
    await control.enable({ pluginId: 'aih.test.attempt-a', configuration: { name: 'A', mode: 'twice' } });
    const lease = runtime.acquire();
    const commit = fakeCommit();
    const attempt = fakeAttempt(commit);
    const stage = await runAttemptStage(runtime, lease, stageRequest(commit, attempt));
    lease.release();
    assert.equal(stage.started, true);
    assert.equal(attempt.hits.count, 1);
    assert.deepEqual((await dump(runtime)).filter((entry) => entry.twice), [{ twice: 'plugin_next_called_twice' }]);
  });
});

test('a plugin can reject an attempt only before next(); the upstream is never hit', async () => {
  await withAttemptSystem(async ({ control, runtime }) => {
    await control.enable({ pluginId: 'aih.test.attempt-a', configuration: { name: 'A', mode: 'reject' } });
    const lease = runtime.acquire();
    const commit = fakeCommit();
    const attempt = fakeAttempt(commit);
    const stage = await runAttemptStage(runtime, lease, stageRequest(commit, attempt));
    lease.release();
    assert.equal(stage.started, false);
    assert.deepEqual(stage.rejected, { status: 451, message: 'blocked by A' });
    assert.equal(attempt.hits.count, 0);
  });
});

test('pre-next budget overruns deny by default and delegate passes through to the attempt', async () => {
  await withAttemptSystem(async ({ control, runtime }) => {
    await control.enable({ pluginId: 'aih.test.attempt-a', configuration: { name: 'A', mode: 'slow', sleepMs: 1000 } });
    const lease = runtime.acquire();
    const commit = fakeCommit();
    const attempt = fakeAttempt(commit);
    const stage = await runAttemptStage(runtime, lease, stageRequest(commit, attempt), { stepBudgetMs: 100 });
    lease.release();
    assert.equal(stage.started, false);
    assert.equal(stage.rejected.status, 502);
    assert.equal(stage.rejected.code, 'plugin_rpc_timeout');
    assert.equal(attempt.hits.count, 0, 'deny：插件超时时上游零命中');
    assert.deepEqual((await dump(runtime)), [{ aborted: 'plugin_rpc_cancelled' }], '超时真的取消了插件 handler');
  });
  await withAttemptSystem(async ({ control, runtime }) => {
    await control.enable({ pluginId: 'aih.test.attempt-d', configuration: { name: 'D', mode: 'slow', sleepMs: 1000 } });
    const lease = runtime.acquire();
    const commit = fakeCommit();
    const attempt = fakeAttempt(commit);
    const stage = await runAttemptStage(runtime, lease, stageRequest(commit, attempt), { stepBudgetMs: 100 });
    lease.release();
    assert.equal(stage.started, true);
    assert.deepEqual(stage.outcome, { action: 'return' });
    assert.equal(attempt.hits.count, 1, 'delegate：网关替它调用 next');
    assert.equal(stage.failures.length, 1);
  }, [{ pluginId: 'aih.test.attempt-d', prefix: 'd', contribution: { failurePolicy: 'delegate' } }]);
});

test('waiting for upstream headers inside next() does not count against the plugin budget', async () => {
  await withAttemptSystem(async ({ control, runtime }) => {
    await control.enable({ pluginId: 'aih.test.attempt-a', configuration: { name: 'A', mode: 'pass' } });
    const lease = runtime.acquire();
    const commit = fakeCommit();
    const attempt = fakeAttempt(commit, { beforeCommitMs: 600 });
    const stage = await runAttemptStage(runtime, lease, stageRequest(commit, attempt), { stepBudgetMs: 100 });
    lease.release();
    assert.equal(stage.started, true);
    assert.deepEqual(stage.failures, []);
    assert.equal((await dump(runtime))[0].summary.committed, true);
  });
});

test('stop only narrows: it ends failover after an uncommitted failure and is ignored after commit', async () => {
  await withAttemptSystem(async ({ control, runtime }) => {
    await control.enable({ pluginId: 'aih.test.attempt-a', configuration: { name: 'A', mode: 'stop' } });
    let lease = runtime.acquire();
    let commit = fakeCommit();
    let attempt = fakeAttempt(commit, { commit: false, action: 'retry_next' });
    let stage = await runAttemptStage(runtime, lease, stageRequest(commit, attempt));
    lease.release();
    assert.equal(stage.stop, true);
    assert.deepEqual(stage.outcome, { action: 'retry_next' });
    assert.deepEqual((await dump(runtime))[0].summary, { committed: false, outcome: 'retry_next', error: 'upstream exploded', stopped: false });

    lease = runtime.acquire();
    commit = fakeCommit();
    attempt = fakeAttempt(commit, { action: 'return' });
    stage = await runAttemptStage(runtime, lease, stageRequest(commit, attempt));
    lease.release();
    assert.equal(stage.stop, false, '已提交的尝试不能被插件改写');
  });
});

test('middleware composes as an onion: enter A then B, return B then A', async () => {
  await withAttemptSystem(async ({ control, runtime }) => {
    await control.enable({ pluginId: 'aih.test.attempt-a', configuration: { name: 'A', mode: 'pass' } });
    await control.enable({ pluginId: 'aih.test.attempt-b', configuration: { name: 'B', mode: 'stop' } });
    await runtime.invoke('a.order', null);
    const lease = runtime.acquire();
    const commit = fakeCommit();
    const attempt = fakeAttempt(commit, { commit: false, action: 'retry_next' });
    const stage = await runAttemptStage(runtime, lease, stageRequest(commit, attempt));
    lease.release();
    assert.deepEqual((await runtime.invoke('a.order', null)).value, ['A:in', 'B:in', 'B:out', 'A:out']);
    assert.equal(attempt.hits.count, 1);
    assert.equal(stage.stop, true);
    assert.equal((await dump(runtime, 'a'))[0].summary.stopped, true, '外层看到内层的停止决定');
  }, [
    { pluginId: 'aih.test.attempt-a', prefix: 'a', contribution: { order: 1 } },
    { pluginId: 'aih.test.attempt-b', prefix: 'b', contribution: { order: 2 } }
  ]);
});

test('an attempt that throws reaches the host unchanged', async () => {
  await withAttemptSystem(async ({ control, runtime }) => {
    await control.enable({ pluginId: 'aih.test.attempt-a', configuration: { name: 'A', mode: 'pass' } });
    const lease = runtime.acquire();
    const commit = fakeCommit();
    const failure = new Error('socket hang up');
    failure.code = 'ECONNRESET';
    const attempt = fakeAttempt(commit, { throws: failure });
    await assert.rejects(runAttemptStage(runtime, lease, stageRequest(commit, attempt)), (error) => error === failure);
    lease.release();
    assert.deepEqual((await dump(runtime))[0].summary, { committed: false, outcome: 'error', error: 'ECONNRESET', stopped: false });
  });
});

test('attempts parked in next() do not use up the in-flight budget of other plugin calls', async () => {
  await withAttemptSystem(async ({ control, runtime }) => {
    await control.enable({ pluginId: 'aih.test.attempt-a', configuration: { name: 'A', mode: 'pass' } });
    let open;
    const gate = new Promise((resolve) => { open = resolve; });
    const parked = { count: 0 };
    const stages = [];
    // 逐个停到 next() 里（尝试已开始 = 反向调用已到达网关），超过 inflightCalls(64) 个。
    // 断言失败时也要放行闸门，否则挂起的尝试会拖住清理。
    try {
      for (let index = 0; index < 70; index += 1) {
        const lease = runtime.acquire();
        const commit = fakeCommit();
        stages.push(runAttemptStage(runtime, lease, stageRequest(commit, {
          run: async () => { parked.count += 1; await gate; commit.fire(200); return { action: 'return' }; }
        })).finally(() => lease.release()));
        assert.ok(await waitFor(() => parked.count === index + 1), `第 ${index + 1} 个尝试停在 next()`);
      }
      assert.deepEqual((await runtime.invoke('a.dump', null)).value, [], '70 个挂起时普通调用仍然可用');
    } finally {
      open();
    }
    const results = await Promise.all(stages);
    assert.equal(results.filter((stage) => stage.started && !stage.failures.length).length, 70);
  });
});

test('an attempt keeps its generation across a publish, and the old generation retires once it drains', async () => {
  await withAttemptSystem(async ({ control, runtime }) => {
    await control.enable({ pluginId: 'aih.test.attempt-a', configuration: { name: 'old', mode: 'pass' } });
    const lease = runtime.acquire();
    let open;
    const gate = new Promise((resolve) => { open = resolve; });
    const commit = fakeCommit();
    const pending = runAttemptStage(runtime, lease, stageRequest(commit, {
      run: async () => { await gate; commit.fire(200); return { action: 'return' }; }
    }));
    await sleep(200);
    await control.enable({ pluginId: 'aih.test.attempt-a', configuration: { name: 'new', mode: 'pass' } });
    assert.deepEqual(runtime.status().retiringGenerations, [lease.generation]);
    open();
    await pending;
    assert.deepEqual((await runtime.invoke('a.order', null, { generation: lease.generation })).value, ['old:in', 'old:out']);
    lease.release();
    assert.ok(await waitFor(() => runtime.status().retiringGenerations.length === 0), '旧代次排空后卸载');
  });
});

test('a client disconnect while parked cancels the plugin call but the host still owns the attempt', async () => {
  await withAttemptSystem(async ({ control, runtime }) => {
    await control.enable({ pluginId: 'aih.test.attempt-a', configuration: { name: 'A', mode: 'pass' } });
    const lease = runtime.acquire();
    const commit = fakeCommit();
    const disconnect = new AbortController();
    let finished = false;
    const attempt = {
      run: async () => {
        await sleep(400);
        finished = true;
        return { action: 'return' };
      }
    };
    const pending = runAttemptStage(runtime, lease, stageRequest(commit, attempt, { signal: disconnect.signal }));
    await sleep(150);
    disconnect.abort();
    const stage = await pending;
    lease.release();
    assert.equal(finished, true, '尝试由宿主执行完毕，不因插件被取消而丢失');
    assert.deepEqual(stage.outcome, { action: 'return' });
    assert.ok(await waitFor(async () => (await dump(runtime)).some((entry) => entry.aborted === 'plugin_rpc_cancelled')));
  });
});

test('no attempt contribution means no middleware at all', async () => {
  const res = { once() {} };
  assert.equal(createAttemptMiddleware({ requestMeta: {}, provider: 'claude', model: 'x', res }), null);
  const lease = { snapshot: { byCapability: new Map([['observe', [{ id: 'o' }]]]) } };
  assert.equal(createAttemptMiddleware({ requestMeta: { pluginLease: lease }, provider: 'claude', model: 'x', res }), null);
});

test('the middleware seam reports rejections to observers and counts plugin failures in the runtime status', async () => {
  const { EventEmitter } = require('node:events');
  const { runWithAccountAttempts } = require('../lib/server/request-orchestrator');
  function fakeRes() {
    const res = new EventEmitter();
    res.headersSent = false;
    res.writableFinished = false;
    res.statusCode = 200;
    res.writeHead = function writeHead(status) { this.statusCode = status; this.headersSent = true; return this; };
    res.end = function end(body) { this.body = body; this.writableFinished = true; };
    return res;
  }
  const writeJson = (res, status, payload) => { res.writeHead(status); res.end(JSON.stringify(payload)); };
  const pool = [{ accountRef: 'acct_00000000000000000001' }];

  await withAttemptSystem(async ({ control, runtime }) => {
    await control.enable({ pluginId: 'aih.test.attempt-a', configuration: { name: 'A', mode: 'reject' } });
    const lease = runtime.acquire();
    const res = fakeRes();
    const observed = [];
    let hits = 0;
    const result = await runWithAccountAttempts({
      pool, maxAttempts: 2, provider: 'claude', model: 'claude-opus-5',
      chooseServerAccount: (candidates, _state, _key, options) => candidates.find((item) => !options.excludeAccountRefs.has(item.accountRef)) || null,
      wrapAttempt: createAttemptMiddleware({ requestMeta: { pluginLease: lease, pluginRuntime: runtime }, provider: 'claude', model: 'claude-opus-5', res, writeJson }),
      observeAttempt: (summary) => observed.push(summary.outcome),
      onAttempt: async () => { hits += 1; return { action: 'return' }; }
    });
    lease.release();
    assert.equal(result.kind, 'returned');
    assert.equal(hits, 0);
    assert.equal(res.statusCode, 451);
    assert.deepEqual(observed, ['rejected']);
  });

  await withAttemptSystem(async ({ control, runtime }) => {
    await control.enable({ pluginId: 'aih.test.attempt-d', configuration: { name: 'D', mode: 'noop' } });
    const lease = runtime.acquire();
    const res = fakeRes();
    let hits = 0;
    const middleware = createAttemptMiddleware({ requestMeta: { pluginLease: lease, pluginRuntime: runtime }, provider: 'claude', model: 'claude-opus-5', res, writeJson });
    const outcome = await middleware(pool[0], { attempt: 0, lastError: () => '' }, async () => { hits += 1; return { action: 'return' }; });
    lease.release();
    assert.deepEqual(outcome, { action: 'return' });
    assert.equal(hits, 1, 'delegate：插件返回无效时网关替它调用 next');
    const failures = runtime.status().contributionFailures;
    assert.equal(failures.total, 1);
    assert.equal(failures.recent[0].code, 'plugin_result_invalid');
    assert.equal(failures.recent[0].capability, 'gateway.attempt');
  }, [{ pluginId: 'aih.test.attempt-d', prefix: 'd', contribution: { failurePolicy: 'delegate' } }]);
});

// ---- 经真实 aih server ----

async function enableAttempt(server, configuration) {
  const installed = await server.management('/install', { file: packPlugin(server.dir, 'a', attemptManifest('aih.test.attempt-a', 'a'), attemptSource('a')) });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  const enabled = await server.management('/enable', { pluginId: 'aih.test.attempt-a', configuration });
  assert.equal(enabled.ok, true, JSON.stringify(enabled));
}

test('through aih server: a pass-through middleware leaves the response byte-identical; a rejecting one never reaches upstream', async (t) => {
  const server = await startClaudeServer(t);
  const plain = await server.message('claude-opus-5', 'hello');
  assert.equal(plain.status, 200);
  const plainBody = await plain.text();

  await enableAttempt(server, { name: 'A', mode: 'pass' });
  const wrapped = await server.message('claude-opus-5', 'hello');
  assert.equal(wrapped.status, 200);
  assert.equal(await wrapped.text(), plainBody);
  assert.equal(server.upstreamTokens.length, 2);
  const [seen] = (await server.management('/invoke', { contributionId: 'a.dump' })).value;
  assert.equal(seen.summary.committed, true);
  assert.equal(seen.summary.status, 200);

  assert.equal((await server.management('/enable', { pluginId: 'aih.test.attempt-a', configuration: { name: 'A', mode: 'reject' } })).ok, true);
  const rejected = await server.message('claude-opus-5', 'blocked');
  const body = await rejected.json();
  assert.equal(rejected.status, 451);
  assert.equal(body.error.code, 'plugin_rejected');
  assert.equal(server.upstreamTokens.length, 2, '被拒绝的尝试零上游命中');
});

test('through aih server: stop ends failover after the first failed account with the normal exhausted error', async (t) => {
  const server = await startClaudeServer(t);
  await enableAttempt(server, { name: 'A', mode: 'stop' });
  server.failures.remaining = 1;
  const stopped = await server.message('claude-opus-5', 'fail once');
  assert.notEqual(stopped.status, 200, await stopped.clone().text());
  assert.equal(server.upstreamTokens.length, 1, '停止换号：第二个账号没有被打到');

  assert.equal((await server.management('/enable', { pluginId: 'aih.test.attempt-a', configuration: { name: 'A', mode: 'pass' } })).ok, true);
  server.failures.remaining = 1;
  const recovered = await server.message('claude-opus-5', 'fail once');
  assert.equal(recovered.status, 200, await recovered.text());
  assert.equal(server.upstreamTokens.length, 3, '不停止时照常换号');
});

test('through aih server: slow upstream headers beyond the plugin budget still succeed', async (t) => {
  const server = await startClaudeServer(t);
  await enableAttempt(server, { name: 'A', mode: 'pass' });
  server.failures.headerDelayMs = 1500;
  const response = await server.message('claude-opus-5', 'slow');
  assert.equal(response.status, 200, await response.text());
  assert.equal(server.upstreamTokens.length, 1);
});

// ---- codex 选号循环（native Responses 流式）----

const http = require('node:http');
const { handleCodexChatCompletions } = require('../lib/server/codex-adapter');

const sseFrame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
const CODEX_STREAM = [
  sseFrame({ type: 'response.created', response: { id: 'resp_attempt', model: 'gpt-6-astra' } }),
  sseFrame({ type: 'response.output_text.delta', delta: 'served' }),
  sseFrame({ type: 'response.completed', response: { id: 'resp_attempt', model: 'gpt-6-astra', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })
].join('');

async function listenOn(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

// 假 codex 上游：failures.remaining 次回 500，其余回一段 SSE；hits 记录命中的账号令牌。
async function codexGateway(t, runtime) {
  const hits = [];
  const failures = { remaining: 0 };
  const upstream = await listenOn(t, (req, res) => {
    req.resume();
    req.on('end', () => {
      hits.push(req.headers.authorization);
      if (failures.remaining > 0) {
        failures.remaining -= 1;
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'upstream exploded', type: 'server_error' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(CODEX_STREAM);
    });
  });
  const state = {
    accounts: { codex: [0, 1].map((n) => ({
      accountRef: `acct_attempt_codex_${n}`, accessToken: `local-test-${n}`, apiKeyMode: true, openaiBaseUrl: upstream
    })) },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  const leases = [];
  const url = await listenOn(t, (req, res) => {
    const lease = req.headers['x-test-plugins'] === '1' ? runtime.acquire() : null;
    if (lease) {
      leases.push(lease);
      res.once('close', () => lease.release());
    }
    handleCodexChatCompletions({
      options: { codexBaseUrl: upstream, upstreamTimeoutMs: 5000, maxAttempts: 2, failureThreshold: 1 },
      state, req, res,
      requestJson: { model: 'gpt-6-astra', stream: true, input: 'local test' },
      routeKey: 'POST /v1/responses',
      requestStartedAt: Date.now(), cooldownMs: 1000,
      requestMeta: { requestId: 'attempt-codex', clientProtocol: 'openai_responses', ...(lease ? { pluginLease: lease, pluginRuntime: runtime } : {}) },
      deps: {
        chooseServerAccount: require('../lib/server/router').chooseServerAccount,
        pushMetricError: () => {},
        writeJson: (r, status, payload) => { r.writeHead(status, { 'content-type': 'application/json' }); r.end(JSON.stringify(payload)); },
        fetchWithTimeout: (target, init) => fetch(target, init),
        markProxyAccountFailure: () => {},
        markProxyAccountSuccess: () => {},
        appendProxyRequestLog: () => {},
        recordModelUsage: () => {},
        waitForTransientRetry: async () => {}
      }
    }).catch((error) => res.destroy(error));
  });
  const send = (withPlugins) => fetch(`${url}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(withPlugins ? { 'x-test-plugins': '1' } : {}) },
    body: '{}',
    signal: AbortSignal.timeout(10000)
  });
  return { hits, failures, send, leases };
}

test('codex: streaming passthrough is byte-identical and next() sees the commit after the upstream answered', async (t) => {
  await withAttemptSystem(async ({ control, runtime }) => {
    await control.enable({ pluginId: 'aih.test.attempt-a', configuration: { name: 'A', mode: 'pass' } });
    const codex = await codexGateway(t, runtime);
    const plain = await codex.send(false);
    assert.equal(plain.status, 200);
    const plainBody = await plain.text();
    const wrapped = await codex.send(true);
    assert.equal(wrapped.status, 200);
    assert.equal(await wrapped.text(), plainBody);
    assert.equal(codex.hits.length, 2);
    const [entry] = await dump(runtime);
    assert.deepEqual(entry.summary, { committed: true, outcome: 'committed', status: 200, stopped: false });
    assert.equal(entry.value.provider, 'codex');
    assert.equal(entry.value.authType, 'api-key');
  });
});

test('codex: reject never reaches upstream; stop ends failover after one upstream hit', async (t) => {
  await withAttemptSystem(async ({ control, runtime }) => {
    await control.enable({ pluginId: 'aih.test.attempt-a', configuration: { name: 'A', mode: 'reject' } });
    const codex = await codexGateway(t, runtime);
    const rejected = await codex.send(true);
    assert.equal(rejected.status, 451);
    assert.equal((await rejected.json()).error.code, 'plugin_rejected');
    assert.equal(codex.hits.length, 0);

    await control.enable({ pluginId: 'aih.test.attempt-a', configuration: { name: 'A', mode: 'stop' } });
    codex.failures.remaining = 1;
    const stopped = await codex.send(true);
    assert.notEqual(stopped.status, 200, await stopped.clone().text());
    assert.equal(codex.hits.length, 1, '停止换号：第二个账号没有被打到');
    const [entry] = await dump(runtime);
    assert.equal(entry.summary.committed, false);

    await control.enable({ pluginId: 'aih.test.attempt-a', configuration: { name: 'A', mode: 'pass' } });
    codex.failures.remaining = 1;
    const recovered = await codex.send(true);
    assert.equal(recovered.status, 200, await recovered.clone().text());
    assert.equal(codex.hits.length, 3, '不停止时照常换号');
  });
});

test('through aih server: an active attempt plugin no longer refuses Responses WebSocket upgrades', async (t) => {
  const WebSocket = require('ws');
  const server = await startClaudeServer(t);
  const upgrade = () => new Promise((resolve) => {
    const socket = new WebSocket(`${server.base.replace('http', 'ws')}/v1/responses`, { headers: { authorization: 'Bearer test-client-key' } });
    socket.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); });
    socket.on('open', () => { socket.close(); resolve(101); });
    socket.on('error', () => {});
  });
  const before = await upgrade();
  await enableAttempt(server, { name: 'A', mode: 'pass' });
  const during = await upgrade();
  // 这个服务端没有 codex 账号，两次都由 WS 处理器按「无可用账号」回答；关键是插件启用后不再走 426 回落。
  assert.notEqual(during, 426);
  assert.equal(during, before);
});