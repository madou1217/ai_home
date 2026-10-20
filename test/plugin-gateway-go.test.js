'use strict';

// 插件架构 M2：Go 数据面的插件端口（第一阶段：gateway.request）。
// 真实 Go 二进制 + 真实 Plugin Host + 真实 Node 转发器 + 假 codex 上游：
// Node 推送投影、Go 确认后才带代次转发；Go 入口闸门执行插件的改写与拒绝；
// Go 未确认 / 不支持的阶段 / Go 丢了投影时请求留在或交还 Node。
// 全部在临时目录与随机端口上运行，不触碰用户的 ~/.ai_home 与 9527。

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { tempDir, socketFor, manifest, packPlugin, waitFor } = require('./helpers/plugin-gateway-harness');
const { startGoGateway } = require('./helpers/codex-http-go-fixture');
const { getPluginSystem, attachGoProjection } = require('../lib/plugins/control/plugin-system');
const { createGoManagementClient } = require('../lib/account/go-bridge/go-management-client');
const { createGoCoreGatewayForwarder } = require('../lib/server/go-core-gateway-forwarder');
const { compileRouteTable, loadRouteOwnershipManifest } = require('../lib/server/go-core-route-ownership');
const { pluginForwardingFor, shouldDeferToNodeForPlugins } = require('../lib/server/gateway-plugin-stage');
const { readRequestBody } = require('../lib/server/http-utils-utils');

const ROOT = path.join(__dirname, '..');

// 测试用 Go 二进制编译到临时目录，不覆盖线上正在运行的 bin/native 二进制。
let goBinary;
function testGoBinary() {
  if (goBinary !== undefined) return goBinary;
  if (process.env.AIH_CODEX_HTTP_GO_BINARY) return (goBinary = process.env.AIH_CODEX_HTTP_GO_BINARY);
  // 固定文件名：每次运行覆盖同一个文件，不在临时目录里堆积二进制。
  const output = path.join(os.tmpdir(), `aih-server-plugin-test${process.platform === 'win32' ? '.exe' : ''}`);
  const build = spawnSync('go', ['build', '-o', output, './cmd/aih-server'], { cwd: ROOT, encoding: 'utf8' });
  goBinary = build.status === 0 ? output : null;
  return goBinary;
}

const REQUEST_MANIFEST = manifest('aih.test.go-request', {
  configSchema: { type: 'object', additionalProperties: false, properties: { mode: { type: 'string' } } },
  contributes: [{ id: 'goreq.rewrite', capability: 'gateway.request', version: 1 }]
});
const REQUEST_SOURCE = `export default { apply(ctx, config) {
  ctx.aih.register('goreq.rewrite', async (value) => {
    if (config.mode === 'reject') return { reject: { status: 451, message: 'blocked in go' } };
    // instructions 只是 Responses 的字段；其它协议不改，避免把无效字段送进严格解码。
    if (value.protocol !== 'openai_responses') return null;
    return { body: { ...value.body, instructions: 'rewritten by plugin via ' + value.protocol } };
  });
} };`;
const OBSERVER_MANIFEST = manifest('aih.test.go-observer', {
  contributes: [
    { id: 'goobs.observe', capability: 'observe', version: 1 },
    { id: 'goobs.dump', capability: 'command', version: 1 }
  ]
});
const OBSERVER_SOURCE = `const events = [];
export default { apply(ctx) {
  ctx.aih.register('goobs.observe', (event) => { events.push(event); return null; });
  ctx.aih.register('goobs.dump', () => events.splice(0));
} };`;
const ACCOUNT_MANIFEST = manifest('aih.test.go-account', {
  configSchema: { type: 'object', additionalProperties: false, properties: { prefer: { type: 'string' } } },
  contributes: [{ id: 'goacct.prefer', capability: 'gateway.account', version: 1 }]
});
const ACCOUNT_SOURCE = `export default { apply(ctx, config) {
  ctx.aih.register('goacct.prefer', () => ({ prefer: [config.prefer] }));
} };`;
const ATTEMPT_MANIFEST = manifest('aih.test.go-attempt', {
  configSchema: { type: 'object', additionalProperties: false, properties: { mode: { type: 'string' } } },
  contributes: [
    { id: 'goattempt.attempt', capability: 'gateway.attempt', version: 1 },
    { id: 'goattempt.dump', capability: 'command', version: 1 }
  ]
});
const ATTEMPT_SOURCE = `const log = [];
export default { apply(ctx, config) {
  ctx.aih.register('goattempt.dump', () => log.splice(0));
  ctx.aih.register('goattempt.attempt', async (value, context) => {
    if (config.mode === 'reject') return { reject: { status: 451, message: 'blocked in go attempt' } };
    const summary = await context.next();
    log.push({ value, summary });
    if (config.mode === 'stop') return { recovery: 'stop' };
    return null;
  });
} };`;
const NODE_EVENT_KEYS = ['accountRef', 'attempt', 'committed', 'durationMs', 'error', 'generation', 'model', 'outcome', 'provider', 'type'];

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function goPluginFixture(t) {
  const upstreamBodies = [];
  const hold = { next: null };
  const failing = { next: 0, status: 400 };
  const upstreamKeys = [];
  const upstream = await listen(t, async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET') {
      response.end('{"data":[{"id":"gpt-5.4","object":"model"}]}');
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    upstreamBodies.push(body);
    upstreamKeys.push(String(request.headers.authorization || ''));
    if (failing.next > 0) {
      failing.next -= 1;
      response.writeHead(failing.status);
      response.end('{"error":{"message":"rejected by fixture","type":"invalid_request_error","code":"fixture_rejected"}}');
      return;
    }
    const completed = { id: 'resp_go', object: 'response', status: 'completed', model: 'gpt-5.4', output: [{ type: 'message', id: 'msg_go', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'served', annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    // Go 的 Canonical 路径（chat completions / 非 claude 模型的 messages）以流式请求上游。
    const finish = body.stream
      ? () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        response.write(frame({ type: 'response.created', response: { ...completed, status: 'in_progress', output: [] } }));
        response.write(frame({ type: 'response.output_item.added', output_index: 0, item: { ...completed.output[0], content: [] } }));
        response.write(frame({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg_go', delta: 'served' }));
        response.write(frame({ type: 'response.output_item.done', output_index: 0, item: completed.output[0] }));
        response.end(frame({ type: 'response.completed', response: completed }));
      }
      : () => response.end(JSON.stringify(completed));
    if (hold.next) {
      const release = hold.next;
      hold.next = null;
      release.push(finish);
    } else finish();
  });
  const go = await startGoGateway(t, upstream + '/v1', 'gpt-5.4', { binary: testGoBinary() });

  const dir = tempDir('aihgo-');
  const aiHomeDir = path.join(dir, 'home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const state = {};
  const system = getPluginSystem(state, { aiHomeDir, socketPath: socketFor(dir), backoffMs: [50] });
  system.control.install(packPlugin(dir, 'goreq', REQUEST_MANIFEST, REQUEST_SOURCE));
  system.control.install(packPlugin(dir, 'goobs', OBSERVER_MANIFEST, OBSERVER_SOURCE));
  system.control.install(packPlugin(dir, 'goacct', ACCOUNT_MANIFEST, ACCOUNT_SOURCE));
  system.control.install(packPlugin(dir, 'goattempt', ATTEMPT_MANIFEST, ATTEMPT_SOURCE));
  const management = createGoManagementClient({ baseUrl: go.base, managementKey: go.managementKey });
  const sync = attachGoProjection(system, (payload) => management.pushPluginProjection(payload), { intervalMs: 200 });
  t.after(async () => {
    sync.stop();
    await system.runtime.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const forwarder = createGoCoreGatewayForwarder({
    routeTable: compileRouteTable(loadRouteOwnershipManifest()),
    entryIds: new Set(['gateway.openai.responses', 'gateway.openai.chat_completions', 'gateway.anthropic.messages']),
    requiredClientKey: 'public-key',
    getTarget: () => ({ host: '127.0.0.1', port: Number(new URL(go.base).port), clientKey: go.clientKey }),
    needsRequestModel: () => true,
    deferToNode: (input) => shouldDeferToNodeForPlugins(state, input),
    pluginForwarding: () => pluginForwardingFor(state),
    mapPinnedAccountRef: () => go.accountRef,
    agent: new http.Agent({ keepAlive: false }),
    writeJson(target, status, document) { target.writeHead(status, { 'content-type': 'application/json' }); target.end(JSON.stringify(document)); }
  });
  const nodeServed = [];
  const node = await listen(t, async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (await forwarder.tryHandleHttp(request, response, { method: request.method, pathname, requestId: 'req-go-plugin' })) return;
    nodeServed.push(JSON.parse((await readRequestBody(request)).toString('utf8')));
    response.writeHead(200, { 'content-type': 'application/json', 'x-served-by': 'node' });
    response.end('{"servedBy":"node"}');
  });
  const send = (body, headers = {}, route = '/v1/responses') => fetch(`${node}${route}`, {
    method: 'POST',
    headers: { authorization: 'Bearer public-key', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  return { go, system, sync, management, upstreamBodies, upstreamKeys, nodeServed, send, hold, failing };
}

const BODY = { model: 'gpt-5.4', input: 'hello', stream: false };
// Windows：codex-http-go-fixture 在 Windows 上启动 Go 时打开账号库失败（SQLite out of memory，夹具既有问题，
// 与插件端口无关）。Go 侧插件代码在 Windows 上由 Go 单元测试覆盖（含命名管道上的真实宿主调用与重连）。
const skip = () => (process.platform === 'win32' && 'codex-http-go-fixture cannot start Go on Windows')
  || (!testGoBinary() && 'Go toolchain unavailable');

test('Go executes gateway.request for a generation it acknowledged; Node keeps requests until then', { skip: skip(), timeout: 120000 }, async (t) => {
  const f = await goPluginFixture(t);
  const forged = await f.send(BODY, { 'x-aih-plugin-generation': '999' });
  assert.equal(forged.status, 200, '没有插件时客户端伪造的代次头被剥掉，Go 照常服务');
  assert.equal(forged.headers.get('x-served-by'), null, '伪造的代次头没有到达 Go（否则 Go 会把请求交还 Node）');
  assert.equal(f.upstreamBodies.at(-1).instructions, undefined);

  await f.system.control.enable({ pluginId: 'aih.test.go-request', configuration: { mode: 'rewrite' } });
  const generation = f.system.runtime.snapshot().generation;
  assert.ok(await waitFor(() => f.sync.isAcked(generation)), 'Go 确认了投影');
  const rewritten = await f.send(BODY);
  assert.equal(rewritten.status, 200, await rewritten.clone().text());
  assert.equal(rewritten.headers.get('x-served-by'), null, '由 Go 服务');
  assert.equal(f.upstreamBodies.at(-1).instructions, 'rewritten by plugin via openai_responses');
  assert.equal(f.nodeServed.length, 0);

  await f.system.control.enable({ pluginId: 'aih.test.go-request', configuration: { mode: 'reject' } });
  assert.ok(await waitFor(() => f.sync.isAcked(f.system.runtime.snapshot().generation)));
  const hits = f.upstreamBodies.length;
  const rejected = await f.send(BODY);
  assert.equal(rejected.status, 451);
  assert.equal((await rejected.json()).error.code, 'plugin_rejected');
  assert.equal(f.upstreamBodies.length, hits, '被拒绝的请求零上游命中');
});

test('a generation Go lost (restart) is handed back to Node, and unsupported stages stay in Node', { skip: skip(), timeout: 120000 }, async (t) => {
  const f = await goPluginFixture(t);
  await f.system.control.enable({ pluginId: 'aih.test.go-request', configuration: { mode: 'rewrite' } });
  assert.ok(await waitFor(() => f.sync.isAcked(f.system.runtime.snapshot().generation)));

  // 宿主不可调用时 Go 不确认任何代次（确认前先 ping 宿主）。
  const unreachable = await f.management.pushPluginProjection({
    host: { address: path.join(os.tmpdir(), 'aih-no-such-plugin-host.sock'), token: 'x'.repeat(64) },
    generations: [{ generation: 1, contributions: [{ id: 'goreq.rewrite', capability: 'gateway.request', order: 0, failurePolicy: 'deny', instanceId: 'aih.test.go-request' }] }]
  });
  assert.deepEqual(unreachable.data.generations, [], '宿主不可调用时不确认');

  // 模拟 Go 重启：Go 的投影被清空，而 Node 仍认为已确认。Go 交还，Node 用原文处理。
  const cleared = await f.management.pushPluginProjection({ host: { address: '', token: '' }, generations: [] });
  assert.equal(cleared.ok, true);
  const handedBack = await f.send(BODY);
  assert.equal(handedBack.headers.get('x-served-by'), 'node');
  assert.deepEqual(f.nodeServed.at(-1), BODY, 'Node 收到的是未改写的原文');
  const generation = f.system.runtime.snapshot().generation;
  assert.ok(await waitFor(async () => {
    const listing = await f.management.send({ method: 'GET', path: '/v1/management/plugins/projection' });
    return Boolean(listing.ok && listing.data && listing.data.generations.includes(generation));
  }), '下一轮推送让 Go 重新持有投影');
  const recovered = await f.send(BODY);
  assert.equal(recovered.headers.get('x-served-by'), null);

  await f.system.control.enable({ pluginId: 'aih.test.go-observer' });
  assert.ok(await waitFor(() => f.sync.isAcked(f.system.runtime.snapshot().generation)));
  const observed = await f.send(BODY);
  assert.equal(observed.headers.get('x-served-by'), null, 'observe 由 Go 执行');
});

test('a request keeps the generation it was forwarded with across a publish', { skip: skip(), timeout: 120000 }, async (t) => {
  const f = await goPluginFixture(t);
  await f.system.control.enable({ pluginId: 'aih.test.go-request', configuration: { mode: 'rewrite' } });
  const first = f.system.runtime.snapshot().generation;
  assert.ok(await waitFor(() => f.sync.isAcked(first)));
  const releases = [];
  f.hold.next = releases;
  const inFlight = f.send(BODY);
  assert.ok(await waitFor(() => releases.length === 1), '请求停在上游');
  await f.system.control.enable({ pluginId: 'aih.test.go-request', configuration: { mode: 'reject' } });
  assert.deepEqual(f.system.runtime.status().retiringGenerations, [first], '在途请求持有旧代次');
  releases[0]();
  const response = await inFlight;
  assert.equal(response.status, 200);
  assert.ok(await waitFor(() => f.system.runtime.status().retiringGenerations.length === 0), '响应结束后旧代次卸载');
});

async function dumpObservations(system, count) {
  let events = [];
  assert.ok(await waitFor(async () => {
    events = events.concat((await system.runtime.invoke('goobs.dump', null)).value || []);
    return events.length >= count;
  // 观察事件由 Go 命中后经 Plugin Host 回传：CI 低核 runner 上排在启动/编译之后，
  // 5s 会偶发不够（本用例自身的兜底超时是 120s）。
  }, 20000), JSON.stringify(events));
  return events;
}

test('Go delivers one observe event per attempt on each Go entry, in the Node event shape', { skip: skip(), timeout: 120000 }, async (t) => {
  const f = await goPluginFixture(t);
  await f.system.control.enable({ pluginId: 'aih.test.go-observer' });
  await f.system.control.enable({ pluginId: 'aih.test.go-request', configuration: { mode: 'rewrite' } });
  const generation = f.system.runtime.snapshot().generation;
  assert.ok(await waitFor(() => f.sync.isAcked(generation)));

  const routes = [
    ['/v1/responses', BODY],
    ['/v1/chat/completions', { model: 'gpt-5.4', stream: false, messages: [{ role: 'user', content: 'hi' }] }],
    ['/v1/messages', { model: 'gpt-5.4', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] }]
  ];
  for (const [route, body] of routes) {
    const response = await f.send(body, {}, route);
    assert.equal(response.status, 200, `${route}: ${await response.clone().text()}`);
    assert.equal(response.headers.get('x-served-by'), null, `${route} 由 Go 服务`);
    const [event] = await dumpObservations(f.system, 1);
    assert.deepEqual(Object.keys(event).sort(), NODE_EVENT_KEYS, route);
    assert.equal(event.type, 'gateway.attempt');
    assert.equal(event.generation, generation);
    assert.equal(event.provider, 'codex', route);
    assert.equal(event.accountRef, f.go.accountRef, route);
    assert.equal(event.model, 'gpt-5.4');
    assert.equal(event.outcome, 'return');
    assert.equal(event.committed, true);
    assert.equal(event.attempt, 0);
    assert.equal(f.upstreamBodies.at(-1).instructions !== undefined || route !== '/v1/responses', true, 'request 与 observe 在同一代次里都由 Go 执行');
  }
  assert.equal(f.nodeServed.length, 0);

  f.failing.next = 4;
  const failed = await f.send(BODY);
  assert.notEqual(failed.status, 200);
  const [failure] = await dumpObservations(f.system, 1);
  assert.equal(failure.outcome, 'error');
  assert.equal(failure.committed, false, '失败的尝试在输出前结束');
  assert.notEqual(failure.error, '');
  const listing = await f.management.send({ method: 'GET', path: '/v1/management/plugins/projection' });
  assert.ok(listing.data.observations.delivered >= 4, JSON.stringify(listing.data));
});

test('Go applies gateway.account preference within the pool; a preference outside it fails the request in Go', { skip: skip(), timeout: 120000 }, async (t) => {
  const f = await goPluginFixture(t);
  const secondRef = await f.go.register('second-upstream-key');
  await f.system.control.enable({ pluginId: 'aih.test.go-account', configuration: { prefer: secondRef } });
  assert.ok(await waitFor(() => f.sync.isAcked(f.system.runtime.snapshot().generation)));
  for (let index = 0; index < 4; index += 1) {
    const response = await f.send(BODY);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('x-served-by'), null, '由 Go 服务');
  }
  assert.deepEqual(f.upstreamKeys.slice(-4), Array(4).fill('Bearer second-upstream-key'), '每次都选插件偏好的账号');

  await f.system.control.enable({ pluginId: 'aih.test.go-account', configuration: { prefer: 'acct_00000000000000000999' } });
  assert.ok(await waitFor(() => f.sync.isAcked(f.system.runtime.snapshot().generation)));
  const hits = f.upstreamKeys.length;
  const violated = await f.send(BODY);
  assert.notEqual(violated.status, 200);
  assert.equal(violated.headers.get('x-served-by'), null, '越界偏好由 Go 拒绝，不交回 Node');
  assert.equal(f.upstreamKeys.length, hits, '越界的偏好不会让请求出站');
});

// ---- gateway.attempt：Go 把每次尝试包进插件中间件（反向调用 next()） ----

async function dumpAttempts(system) {
  let entries = [];
  assert.ok(await waitFor(async () => {
    entries = entries.concat((await system.runtime.invoke('goattempt.dump', null)).value || []);
    return entries.length > 0;
  }), JSON.stringify(entries));
  return entries;
}

test('Go executes gateway.attempt for an attempt-only generation, and next() carries the summary', { skip: skip(), timeout: 120000 }, async (t) => {
  const f = await goPluginFixture(t);
  // 只装 attempt 插件：这一代没有任何 request/observe/account 贡献项，转发仍然必须带代次，
  // 否则 Go 的入口闸门会直接放行、中间件被静默跳过。
  await f.system.control.enable({ pluginId: 'aih.test.go-attempt', configuration: { mode: 'pass' } });
  assert.ok(await waitFor(() => f.sync.isAcked(f.system.runtime.snapshot().generation)));

  const hits = f.upstreamBodies.length;
  // gateway.attempt 由 Canonical 执行：/v1/chat/completions 走 Canonical Coordinator。
  const response = await f.send({ model: 'gpt-5.4', stream: false, messages: [{ role: 'user', content: 'hi' }] }, {}, '/v1/chat/completions');
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('x-served-by'), null, '由 Go 服务');
  assert.equal(f.nodeServed.length, 0, '请求没有被交回 Node');
  assert.equal(f.upstreamBodies.length, hits + 1, '上游恰好命中一次');

  const [entry] = await dumpAttempts(f.system);
  assert.deepEqual(Object.keys(entry.value).sort(), ['accountRef', 'attempt', 'authType', 'model', 'provider'], '插件看不到请求体与凭据');
  assert.equal(entry.value.provider, 'codex');
  assert.equal(entry.value.model, 'gpt-5.4');
  assert.equal(entry.value.attempt, 0);
  assert.equal(entry.value.accountRef, f.go.accountRef);
  assert.equal(entry.value.authType, 'api-key');
  assert.equal(entry.summary.committed, true, '非流式响应在尝试结束时已经提交');
  assert.equal(entry.summary.stopped, false);
});

test('a plugin rejection in Go keeps the upstream unhit and carries the plugin status', { skip: skip(), timeout: 120000 }, async (t) => {
  const f = await goPluginFixture(t);
  await f.system.control.enable({ pluginId: 'aih.test.go-attempt', configuration: { mode: 'reject' } });
  assert.ok(await waitFor(() => f.sync.isAcked(f.system.runtime.snapshot().generation)));

  const hits = f.upstreamBodies.length;
  const rejected = await f.send({ model: 'gpt-5.4', stream: false, messages: [{ role: 'user', content: 'hi' }] }, {}, '/v1/chat/completions');
  assert.equal(rejected.status, 451, await rejected.clone().text());
  assert.equal((await rejected.json()).error.code, 'plugin_rejected');
  assert.equal(rejected.headers.get('x-served-by'), null, '由 Go 拒绝，不交回 Node');
  assert.equal(f.upstreamBodies.length, hits, '被拒绝的尝试零上游命中');
  assert.equal(f.nodeServed.length, 0);
});

test('Go stops failover only when the attempt plugin asks for it on an uncommitted failure', { skip: skip(), timeout: 120000 }, async (t) => {
  const f = await goPluginFixture(t);
  // 第二个账号让换号真的会发生：没有插件时同一个失败会再打一次上游。
  await f.go.register('second-upstream-key');

  await f.system.control.enable({ pluginId: 'aih.test.go-attempt', configuration: { mode: 'pass' } });
  assert.ok(await waitFor(() => f.sync.isAcked(f.system.runtime.snapshot().generation)));
  let hits = f.upstreamBodies.length;
  f.failing.status = 503;
  f.failing.next = 1;
  const recovered = await f.send({ model: 'gpt-5.4', stream: false, messages: [{ role: 'user', content: 'hi' }] }, {}, '/v1/chat/completions');
  assert.equal(recovered.status, 200, await recovered.clone().text());
  assert.equal(f.upstreamBodies.length, hits + 2, '默认行为：换号重试第二个账号');
  let entries = await dumpAttempts(f.system);
  assert.deepEqual(entries.map((entry) => entry.value.attempt), [0, 1], '插件看到请求级的尝试序号');

  await f.system.control.enable({ pluginId: 'aih.test.go-attempt', configuration: { mode: 'stop' } });
  assert.ok(await waitFor(() => f.sync.isAcked(f.system.runtime.snapshot().generation)));
  hits = f.upstreamBodies.length;
  f.failing.next = 1;
  const stopped = await f.send({ model: 'gpt-5.4', stream: false, messages: [{ role: 'user', content: 'hi' }] }, {}, '/v1/chat/completions');
  assert.notEqual(stopped.status, 200);
  assert.equal(f.upstreamBodies.length, hits + 1, '插件要求停止换号：只打了一次上游');
  entries = await dumpAttempts(f.system);
  assert.equal(entries[0].summary.committed, false);
  assert.equal(entries[0].summary.outcome, 'retry_next');
});



test('a native Go entry without the attempt middleware hands the request back instead of skipping the plugin', { skip: skip(), timeout: 120000 }, async (t) => {
  const f = await goPluginFixture(t);
  await f.system.control.enable({ pluginId: 'aih.test.go-attempt', configuration: { mode: 'reject' } });
  assert.ok(await waitFor(() => f.sync.isAcked(f.system.runtime.snapshot().generation)));

  // /v1/responses 在 Go 走 native 快路径（没有尝试中间件）：必须交还 Node，
  // 而不是让 Go 静默跳过插件。交还发生在联系上游之前，Node 拿到未改写的原文。
  const hits = f.upstreamBodies.length;
  const response = await f.send(BODY);
  assert.equal(response.headers.get('x-served-by'), 'node', 'Go 交还，由 Node 处理');
  assert.deepEqual(f.nodeServed.at(-1), BODY, 'Node 收到的是未改写的原文');
  assert.equal(f.upstreamBodies.length, hits, '交还发生在联系上游之前');
});
