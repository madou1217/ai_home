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
// failAccounts 里的账号在任何输出之前回 codex 额度错误（桥接据此换号恢复）。
// handshakes / receivedBy 记录每条上游连接与每个上游帧来自哪个账号。
async function wsFixture(t, { plugins = [], accounts = ['first'], failAccounts = [] } = {}) {
  const dir = tempDir('aihws-');
  const aiHomeDir = path.join(dir, 'home');
  fs.mkdirSync(aiHomeDir, { recursive: true });

  const received = [];
  const receivedBy = [];
  const handshakes = [];
  const raw = [];
  const held = [];
  const control = { hold: false };
  let counter = 0;
  const upstream = http.createServer();
  const wss = new WebSocket.Server({ noServer: true });
  upstream.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => {
    const key = String(req.headers.authorization || '').replace('Bearer ', '').replace('-key', '');
    handshakes.push(key);
    ws.on('message', (data) => {
      raw.push(data.toString());
      const event = JSON.parse(data.toString());
      received.push(event);
      receivedBy.push(key);
      if (event.type !== 'response.create') return;
      if (failAccounts.includes(key)) {
        ws.send(JSON.stringify({ type: 'error', status: 429, error: { type: 'usage_limit_reached', code: 'usage_limit_reached', message: 'quota exhausted' } }));
        return;
      }
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
    accounts: { codex: accounts.map((name) => ({ accountRef: `acct_ws_${name}`, accessToken: `${name}-key`, openaiBaseUrl: `${baseUrl}/v1` })) },
    cursors: {}
  };
  const system = getPluginSystem(state, { aiHomeDir, socketPath: socketFor(dir), backoffMs: [50] });
  for (const plugin of plugins) {
    system.control.install(packPlugin(dir, plugin.name, plugin.manifest, plugin.source));
  }

  const gateway = http.createServer();
  const sockets = new Set();
  gateway.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  // 选号替身：有插件偏好时取偏好里第一个在候选中的账号，否则取第一个（真实选择器的偏好排序另有测试）。
  const chooseAccount = (pool, _cursors, _key, selection = {}) => {
    const preferred = Array.isArray(selection.preferredAccountRefs) ? selection.preferredAccountRefs : [];
    return pool.find((account) => preferred.includes(account.accountRef)) || pool[0];
  };
  gateway.on('upgrade', (req, socket, head) => {
    handleCodexResponsesWebSocket({ req, socket, head, state, options: {} }, {
      chooseAccount, isLoopbackUrl: () => false, handshakeTimeoutMs: 1000
    });
  });
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
    const create = (extra = {}) => client.send(JSON.stringify({
      type: 'response.create', model: 'gpt-6-astra',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], ...extra
    }));
    return { client, events, create };
  }
  async function upgradeStatus() {
    return new Promise((resolve) => {
      const socket = new WebSocket(gatewayUrl);
      socket.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); });
      socket.on('open', () => { socket.close(); resolve(101); });
      socket.on('error', () => {});
    });
  }
  return { state, system, received, receivedBy, handshakes, raw, held, control, connect, upgradeStatus };
}

const REQUEST_PLUGIN = { name: 'wsreq', manifest: REQUEST_MANIFEST, source: REQUEST_SOURCE };
const OBSERVER_PLUGIN = { name: 'wsobs', manifest: OBSERVER_MANIFEST, source: OBSERVER_SOURCE };

test('without gateway contributions frames reach upstream byte-identical; plugins enabled mid-session apply to the next create', async (t) => {
  assert.equal(createResponsesWebSocketPlugins({ state: {} }), null, '没有插件系统时原始 socket 直接交给桥接');
  const f = await wsFixture(t, { plugins: [REQUEST_PLUGIN] });
  const { client, events } = await f.connect();
  const original = '{ "type":"response.create",  "model":"gpt-6-astra", "input":[], "n":9007199254740993 }';
  client.send(original);
  assert.ok(await waitFor(() => events.some((event) => event.type === 'response.completed')));
  assert.equal(f.raw[0], original, '没有网关类贡献时逐字节直通');

  await f.system.control.enable({ pluginId: 'aih.test.ws-request', configuration: { tag: 'late' } });
  client.send(original);
  assert.ok(await waitFor(() => events.filter((event) => event.type === 'response.completed').length === 2));
  assert.equal(f.received[1].instructions, 'tag:late', '连接建立后才启用的插件对下一个 create 生效');
});

// ---- gateway.attempt / gateway.account 经桥接换号恢复 ----

const RECOVERY_ATTEMPT_PLUGIN = {
  name: 'wsrec',
  manifest: manifest('aih.test.ws-recovery', {
    configSchema: { type: 'object', additionalProperties: false, properties: { mode: { type: 'string' } } },
    contributes: [
      { id: 'wsrec.attempt', capability: 'gateway.attempt', version: 1 },
      { id: 'wsrec.dump', capability: 'command', version: 1 }
    ]
  }),
  source: `const log = [];
export default { apply(ctx, config) {
  ctx.aih.register('wsrec.dump', () => log.splice(0));
  ctx.aih.register('wsrec.attempt', async (value, context) => {
    if (config.mode === 'reject-recovery' && value.attempt > 0) return { reject: { status: 451, message: 'no failover for you' } };
    if (config.mode === 'slow-recovery' && value.attempt > 0) await new Promise((resolve) => setTimeout(resolve, 600));
    const summary = await context.next();
    log.push({ attempt: value.attempt, accountRef: value.accountRef, summary });
    if (config.mode === 'stop') return { recovery: 'stop' };
    return null;
  });
} };`
};

const PREFER_ACCOUNT_PLUGIN = {
  name: 'wspref',
  manifest: manifest('aih.test.ws-prefer', {
    configSchema: { type: 'object', additionalProperties: false, properties: { prefer: { type: 'string' } } },
    contributes: [{ id: 'wspref.account', capability: 'gateway.account', version: 1 }]
  }),
  source: `export default { apply(ctx, config) {
  ctx.aih.register('wspref.account', (value) => (value.candidates.some((item) => item.accountRef === config.prefer) ? { prefer: [config.prefer] } : null));
} };`
};

async function dumpRecovery(runtime) {
  return (await runtime.invoke('wsrec.dump', null)).value;
}

test('attempt middleware wraps the first attempt and the in-bridge failover attempt', { timeout: 30000 }, async (t) => {
  const f = await wsFixture(t, { plugins: [RECOVERY_ATTEMPT_PLUGIN], accounts: ['first', 'second'], failAccounts: ['first'] });
  await f.system.control.enable({ pluginId: 'aih.test.ws-recovery', configuration: { mode: 'pass' } });
  const { events, create } = await f.connect();
  create();
  assert.ok(await waitFor(() => events.some((event) => event.type === 'response.completed')), JSON.stringify(events));
  const log = await dumpRecovery(f.system.runtime);
  assert.equal(log.length, 2, JSON.stringify(log));
  assert.deepEqual([log[0].attempt, log[0].accountRef], [0, 'acct_ws_first']);
  assert.equal(log[0].summary.committed, false);
  assert.equal(log[0].summary.outcome, 'retry_next');
  assert.deepEqual([log[1].attempt, log[1].accountRef], [1, 'acct_ws_second']);
  assert.equal(log[1].summary.committed, true);
  assert.deepEqual(f.system.runtime.status().leases, {});
});

test('stop after an uncommitted failure ends failover: no handshake to another account, the client gets the original failure', { timeout: 30000 }, async (t) => {
  const f = await wsFixture(t, { plugins: [RECOVERY_ATTEMPT_PLUGIN], accounts: ['first', 'second'], failAccounts: ['first'] });
  await f.system.control.enable({ pluginId: 'aih.test.ws-recovery', configuration: { mode: 'stop' } });
  const { client, events, create } = await f.connect();
  const closed = once(client, 'close');
  create();
  await closed;
  assert.deepEqual(f.handshakes, ['first'], '没有连向第二个账号');
  const failure = events.find((event) => event.type === 'error');
  assert.equal(failure && failure.error.code, 'usage_limit_reached', '客户端收到原始失败帧');
  assert.ok(await waitFor(() => Object.keys(f.system.runtime.status().leases).length === 0));
});

test('a middleware rejection on the failover attempt keeps the replay from going upstream', { timeout: 30000 }, async (t) => {
  const f = await wsFixture(t, { plugins: [RECOVERY_ATTEMPT_PLUGIN], accounts: ['first', 'second'], failAccounts: ['first'] });
  await f.system.control.enable({ pluginId: 'aih.test.ws-recovery', configuration: { mode: 'reject-recovery' } });
  const { client, events, create } = await f.connect();
  const closed = once(client, 'close');
  create();
  await closed;
  assert.equal(f.receivedBy.filter((key) => key === 'second').length, 0, '重放没有发往第二个账号');
  const rejection = events.find((event) => event.type === 'error' && event.status === 451);
  assert.equal(rejection && rejection.error.message, 'no failover for you');
  assert.ok(await waitFor(() => Object.keys(f.system.runtime.status().leases).length === 0));
});

test('an account plugin steers the failover choice within the pool', { timeout: 30000 }, async (t) => {
  const f = await wsFixture(t, { plugins: [PREFER_ACCOUNT_PLUGIN], accounts: ['first', 'second', 'third'], failAccounts: ['first'] });
  await f.system.control.enable({ pluginId: 'aih.test.ws-prefer', configuration: { prefer: 'acct_ws_third' } });
  const { events, create } = await f.connect();
  create();
  assert.ok(await waitFor(() => events.some((event) => event.type === 'response.completed')), JSON.stringify(events));
  assert.equal(f.handshakes.includes('second'), false, JSON.stringify(f.handshakes));
  assert.equal(f.handshakes[f.handshakes.length - 1], 'third');
});

test('a client disconnect while a failover hook is pending releases every lease without hanging', { timeout: 30000 }, async (t) => {
  const f = await wsFixture(t, { plugins: [RECOVERY_ATTEMPT_PLUGIN], accounts: ['first', 'second'], failAccounts: ['first'] });
  await f.system.control.enable({ pluginId: 'aih.test.ws-recovery', configuration: { mode: 'slow-recovery' } });
  const { client, create } = await f.connect();
  create();
  assert.ok(await waitFor(() => f.handshakes.includes('second')), '恢复已开始，新尝试的中间件在等待');
  client.terminate();
  assert.ok(await waitFor(() => Object.keys(f.system.runtime.status().leases).length === 0), JSON.stringify(f.system.runtime.status().leases));
  assert.equal(f.receivedBy.filter((key) => key === 'second').length, 0);
});

test('Responses WebSocket upgrades are accepted while attempt and account plugins are active', async (t) => {
  const f = await wsFixture(t, { plugins: [RECOVERY_ATTEMPT_PLUGIN, PREFER_ACCOUNT_PLUGIN], accounts: ['first'] });
  await f.system.control.enable({ pluginId: 'aih.test.ws-recovery', configuration: { mode: 'pass' } });
  await f.system.control.enable({ pluginId: 'aih.test.ws-prefer', configuration: { prefer: 'acct_ws_first' } });
  assert.equal(await f.upgradeStatus(), 101);
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
