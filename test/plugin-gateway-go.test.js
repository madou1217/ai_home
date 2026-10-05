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
  const output = path.join(os.tmpdir(), `aih-server-plugin-test-${process.pid}${process.platform === 'win32' ? '.exe' : ''}`);
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
    return { body: { ...value.body, instructions: 'rewritten by plugin via ' + value.protocol } };
  });
} };`;
const OBSERVER_MANIFEST = manifest('aih.test.go-observer', {
  contributes: [{ id: 'goobs.observe', capability: 'observe', version: 1 }]
});
const OBSERVER_SOURCE = `export default { apply(ctx) { ctx.aih.register('goobs.observe', () => null); } };`;

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function goPluginFixture(t) {
  const upstreamBodies = [];
  const hold = { next: null };
  const upstream = await listen(t, async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET') {
      response.end('{"data":[{"id":"gpt-5.4","object":"model"}]}');
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const finish = () => response.end('{"id":"resp_go","object":"response","status":"completed","model":"gpt-5.4","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}');
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
  const management = createGoManagementClient({ baseUrl: go.base, managementKey: go.managementKey });
  const sync = attachGoProjection(system, (payload) => management.pushPluginProjection(payload), { intervalMs: 200 });
  t.after(async () => {
    sync.stop();
    await system.runtime.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const forwarder = createGoCoreGatewayForwarder({
    routeTable: compileRouteTable(loadRouteOwnershipManifest()),
    entryIds: new Set(['gateway.openai.responses']),
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
  const send = (body, headers = {}) => fetch(`${node}/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer public-key', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  return { go, system, sync, management, upstreamBodies, nodeServed, send, hold };
}

const BODY = { model: 'gpt-5.4', input: 'hello', stream: false };
const skip = () => !testGoBinary() && 'Go toolchain unavailable';

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
  const observed = await f.send(BODY);
  assert.equal(observed.headers.get('x-served-by'), 'node', 'observe 还没有 Go 端口：留在 Node');
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
