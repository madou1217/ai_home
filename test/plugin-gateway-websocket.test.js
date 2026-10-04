'use strict';

// 插件架构 M2：Responses WebSocket 按 response.create 接入 gateway.request 与 observe。
// 真实 Plugin Host 子进程 + 假的上游 WebSocket；全部在 /tmp 临时目录与随机端口上运行，
// 不触碰用户的 ~/.ai_home 与 9527。

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const fs = require('fs-extra');
const WebSocket = require('ws');

const { tempDir, socketFor, manifest, packPlugin, waitFor, startClaudeServer } = require('./helpers/plugin-gateway-harness');
const { getPluginSystem } = require('../lib/plugins/control/plugin-system');
const { handleCodexResponsesWebSocket } = require('../lib/server/codex-responses-websocket');
const { createResponsesWebSocketPlugins } = require('../lib/server/codex-responses-ws-plugins');

const REQUEST_MANIFEST = manifest('aih.test.ws-request', {
  configSchema: { type: 'object', additionalProperties: false, properties: { mode: { type: 'string' }, tag: { type: 'string' } } },
  contributes: [{ id: 'wsreq.rewrite', capability: 'gateway.request', version: 1 }]
});
const REQUEST_SOURCE = `export default { apply(ctx, config) {
  ctx.aih.register('wsreq.rewrite', async (value) => {
    if (config.mode === 'reject') return { reject: { status: 451, message: 'blocked by policy' } };
    if (config.mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 300));
    return { body: { ...value.body, instructions: 'tag:' + config.tag } };
  });
} };`;

const OBSERVER_MANIFEST = manifest('aih.test.ws-observer', {
  contributes: [
    { id: 'wsobs.observe', capability: 'observe', version: 1 },
    { id: 'wsobs.dump', capability: 'command', version: 1 }
  ]
});
const OBSERVER_SOURCE = `const events = [];
export default { apply(ctx) {
  ctx.aih.register('wsobs.observe', (event) => { events.push(event); return null; });
  ctx.aih.register('wsobs.dump', () => events.splice(0));
} };`;

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

// 假上游：每个 response.create 回 created → delta → completed；hold=true 时 completed 留到 release() 再发。
async function wsFixture(t, { plugins = [] } = {}) {
  const dir = tempDir('aihws-');
  const aiHomeDir = path.join(dir, 'home');
  fs.mkdirSync(aiHomeDir, { recursive: true });

  const received = [];
  const held = [];
  const control = { hold: false };
  let counter = 0;
  const upstream = http.createServer();
  const wss = new WebSocket.Server({ noServer: true });
  upstream.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('message', (data) => {
      const event = JSON.parse(data.toString());
      received.push(event);
      if (event.type !== 'response.create') return;
      counter += 1;
      const id = `resp_${counter}`;
      ws.send(JSON.stringify({ type: 'response.created', response: { id, model: event.model } }));
      ws.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'served' }));
      const complete = () => ws.send(JSON.stringify({ type: 'response.completed', response: { id, model: event.model, usage: { input_tokens: 1, output_tokens: 1 } } }));
      if (control.hold) held.push(complete);
      else complete();
    });
  }));
  const baseUrl = await listen(upstream);

  const state = {
    accounts: { codex: [{ accountRef: 'acct_ws_first', accessToken: 'first-key', openaiBaseUrl: `${baseUrl}/v1` }] },
    cursors: {}
  };
  const system = getPluginSystem(state, { aiHomeDir, socketPath: socketFor(dir), backoffMs: [50] });
  for (const plugin of plugins) {
    system.control.install(packPlugin(dir, plugin.name, plugin.manifest, plugin.source));
  }

  const gateway = http.createServer();
  const sockets = new Set();
  gateway.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  gateway.on('upgrade', (req, socket, head) => handleCodexResponsesWebSocket({ req, socket, head, state, options: {} }, {
    chooseAccount: (pool) => pool[0], isLoopbackUrl: () => false, handshakeTimeoutMs: 1000
  }));
  const gatewayUrl = (await listen(gateway)).replace('http:', 'ws:') + '/v1/responses';

  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    for (const socket of sockets) socket.destroy();
    upstream.closeAllConnections();
    gateway.closeAllConnections();
    await Promise.all([new Promise((resolve) => upstream.close(resolve)), new Promise((resolve) => gateway.close(resolve))]);
    await system.runtime.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function connect() {
    const client = new WebSocket(gatewayUrl);
    const events = [];
    client.on('message', (data) => events.push(JSON.parse(data.toString())));
    t.after(() => client.terminate());
    await once(client, 'open');
    const create = (extra = {}) => client.send(JSON.stringify({ type: 'response.create', model: 'gpt-6-astra', input: [], ...extra }));
    return { client, events, create };
  }
  return { state, system, received, held, control, connect };
}

const REQUEST_PLUGIN = { name: 'wsreq', manifest: REQUEST_MANIFEST, source: REQUEST_SOURCE };
const OBSERVER_PLUGIN = { name: 'wsobs', manifest: OBSERVER_MANIFEST, source: OBSERVER_SOURCE };

test('without gateway plugins the raw client socket goes to the bridge', async (t) => {
  assert.equal(createResponsesWebSocketPlugins({ state: {} }), null, '没有插件系统');
  const f = await wsFixture(t);
  assert.equal(createResponsesWebSocketPlugins({ state: f.state }), null, '插件系统存在但没有网关类贡献');
  const { events, create } = await f.connect();
  create();
  assert.ok(await waitFor(() => events.some((event) => event.type === 'response.completed')));
  assert.equal(f.received[0].instructions, undefined);
});

test('each response.create is rewritten by gateway.request and observed once', async (t) => {
  const f = await wsFixture(t, { plugins: [REQUEST_PLUGIN, OBSERVER_PLUGIN] });
  await f.system.control.enable({ pluginId: 'aih.test.ws-request', configuration: { tag: 'v1' } });
  await f.system.control.enable({ pluginId: 'aih.test.ws-observer' });
  const { events, create } = await f.connect();
  create();
  assert.ok(await waitFor(() => events.filter((event) => event.type === 'response.completed').length === 1));
  create();
  assert.ok(await waitFor(() => events.filter((event) => event.type === 'response.completed').length === 2));
  assert.deepEqual(f.received.map((event) => event.instructions), ['tag:v1', 'tag:v1'], '改写到达上游');
  assert.equal(f.received[0].type, 'response.create', '帧类型保留');
  let observed = [];
  assert.ok(await waitFor(async () => {
    observed = observed.concat((await f.system.runtime.invoke('wsobs.dump', null)).value);
    return observed.length >= 2;
  }));
  assert.equal(observed.length, 2, '每个 response 一条观察事件');
  for (const event of observed) {
    assert.equal(event.provider, 'codex');
    assert.equal(event.model, 'gpt-6-astra');
    assert.equal(event.accountRef, 'acct_ws_first');
    assert.equal(event.outcome, 'return');
    assert.equal(event.committed, true);
  }
  assert.deepEqual(f.system.runtime.status().leases, {}, '回答结束后租约全部释放');
});

test('a rejected response.create never reaches upstream and the connection keeps working', async (t) => {
  const f = await wsFixture(t, { plugins: [REQUEST_PLUGIN] });
  await f.system.control.enable({ pluginId: 'aih.test.ws-request', configuration: { mode: 'reject' } });
  const { events, create } = await f.connect();
  create();
  assert.ok(await waitFor(() => events.length === 1));
  assert.deepEqual(events[0], { type: 'error', status: 451, error: { type: 'invalid_request_error', code: 'plugin_rejected', message: 'blocked by policy' } });
  assert.equal(f.received.length, 0, '被拒绝的 create 不出站');

  await f.system.control.enable({ pluginId: 'aih.test.ws-request', configuration: { tag: 'after' } });
  create();
  assert.ok(await waitFor(() => events.some((event) => event.type === 'response.completed')));
  assert.equal(f.received.length, 1);
  assert.equal(f.received[0].instructions, 'tag:after');
});

test('each response.create pins the generation current at its arrival; the old one retires when its response ends', async (t) => {
  const f = await wsFixture(t, { plugins: [REQUEST_PLUGIN] });
  await f.system.control.enable({ pluginId: 'aih.test.ws-request', configuration: { tag: 'v1' } });
  const first = f.system.runtime.status().activeGeneration;
  const { events, create } = await f.connect();
  f.control.hold = true;
  create();
  assert.ok(await waitFor(() => f.held.length === 1));
  await f.system.control.enable({ pluginId: 'aih.test.ws-request', configuration: { tag: 'v2' } });
  assert.deepEqual(f.system.runtime.status().retiringGenerations, [first], '回答进行中，旧代次保留');
  f.control.hold = false;
  f.held.shift()();
  assert.ok(await waitFor(() => events.some((event) => event.type === 'response.completed')));
  assert.ok(await waitFor(() => f.system.runtime.status().retiringGenerations.length === 0), '回答结束后旧代次卸载');
  create();
  assert.ok(await waitFor(() => events.filter((event) => event.type === 'response.completed').length === 2));
  assert.deepEqual(f.received.map((event) => event.instructions), ['tag:v1', 'tag:v2'], '同一连接上的下一个 create 拿新代次');
});

test('frames sent while a create is being staged keep their order behind it', async (t) => {
  const f = await wsFixture(t, { plugins: [REQUEST_PLUGIN] });
  await f.system.control.enable({ pluginId: 'aih.test.ws-request', configuration: { mode: 'slow', tag: 'slow' } });
  const { client, create } = await f.connect();
  f.control.hold = true;
  create();
  client.send(JSON.stringify({ type: 'response.cancel' }));
  assert.ok(await waitFor(() => f.received.length === 2));
  assert.deepEqual(f.received.map((event) => event.type), ['response.create', 'response.cancel']);
  assert.equal(f.received[0].instructions, 'tag:slow');
});

test('a client disconnect mid-response releases the lease', async (t) => {
  const f = await wsFixture(t, { plugins: [REQUEST_PLUGIN, OBSERVER_PLUGIN] });
  await f.system.control.enable({ pluginId: 'aih.test.ws-request', configuration: { tag: 'v1' } });
  await f.system.control.enable({ pluginId: 'aih.test.ws-observer' });
  const { client, create } = await f.connect();
  f.control.hold = true;
  create();
  assert.ok(await waitFor(() => f.held.length === 1));
  assert.equal(Object.values(f.system.runtime.status().leases).reduce((sum, count) => sum + count, 0), 1);
  client.terminate();
  assert.ok(await waitFor(() => Object.keys(f.system.runtime.status().leases).length === 0), '断开后租约释放');
  let observed = [];
  assert.ok(await waitFor(async () => {
    observed = observed.concat((await f.system.runtime.invoke('wsobs.dump', null)).value);
    return observed.length >= 1;
  }));
  assert.equal(observed[0].outcome, 'disconnected');
  assert.equal(observed[0].committed, true, '断开前已经有回答输出');
});

test('through aih server: a gateway.request plugin no longer forces the Responses WebSocket fallback', async (t) => {
  const server = await startClaudeServer(t);
  const upgrade = () => new Promise((resolve) => {
    const socket = new WebSocket(`${server.base.replace('http', 'ws')}/v1/responses`, { headers: { authorization: 'Bearer test-client-key' } });
    socket.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); });
    socket.on('open', () => { socket.close(); resolve(101); });
    socket.on('error', () => {});
  });
  const installed = await server.management('/install', { file: packPlugin(server.dir, 'wsreq', REQUEST_MANIFEST, REQUEST_SOURCE) });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  assert.equal((await server.management('/enable', { pluginId: 'aih.test.ws-request', configuration: { tag: 'x' } })).ok, true);
  assert.notEqual(await upgrade(), 426, '只有 gateway.request 时不回落');
});
