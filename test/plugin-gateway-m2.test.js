'use strict';

// 插件架构 M2（第一批）：代次固定与按租约退役、gateway.request 阶段语义、Go 路由交回 Node，
// 以及经真实 aih server（假上游）的端到端：插件改写请求体、拒绝请求、无插件时零开销。
// 全部在 /tmp 临时目录与随机端口上运行，不触碰用户的 ~/.ai_home 与 9527。

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('fs-extra');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { buildArtifact } = require('../lib/plugins/control/artifact');
const { createPluginSystem, getPluginSystem } = require('../lib/plugins/control/plugin-system');
const { runRequestStage, identityFingerprint } = require('../lib/plugins/gateway/request-stage');
const { applyGatewayRequestPlugins, shouldDeferToNodeForPlugins } = require('../lib/server/gateway-plugin-stage');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', prefix));
}

function socketFor(dir) {
  return process.platform === 'win32' ? `\\\\.\\pipe\\aih-plugin-m2-${path.basename(dir)}` : path.join(dir, 'h.sock');
}

function manifest(pluginId, extra = {}) {
  return {
    manifestVersion: 1, protocolVersion: 1, pluginId, version: '0.1.0',
    engines: { aih: '>=1.0.0' }, runtime: 'node', entry: 'index.mjs', contributes: [], ...extra
  };
}

function packPlugin(dir, name, pluginManifest, source) {
  const pluginDir = path.join(dir, 'src', name);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(pluginManifest));
  fs.writeFileSync(path.join(pluginDir, 'index.mjs'), source);
  return buildArtifact(pluginDir, path.join(dir, 'packages', `${name}.aih-plugin`)).file;
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

const TAG_MANIFEST = manifest('aih.test.tag', {
  configSchema: { type: 'object', additionalProperties: false, required: ['tag'], properties: { tag: { type: 'string' } } },
  contributes: [{ id: 'tag.read', capability: 'command', version: 1 }]
});
const TAG_SOURCE = `export default { apply(ctx, config) { ctx.aih.register('tag.read', () => config.tag); } };`;

async function withTagSystem(fn, extra = {}) {
  const dir = tempDir('aihm2-');
  const aiHomeDir = path.join(dir, 'home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const system = createPluginSystem({ aiHomeDir, socketPath: socketFor(dir), backoffMs: [50], ...extra });
  try {
    system.control.install(packPlugin(dir, 'tag', TAG_MANIFEST, TAG_SOURCE));
    await fn(system);
  } finally {
    await system.runtime.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 代次固定 ----

test('an in-flight request keeps its generation across a publish; the old generation retires when released', async () => {
  await withTagSystem(async ({ control, runtime }) => {
    await control.enable({ pluginId: 'aih.test.tag', configuration: { tag: 'v1' } });
    const inFlight = runtime.acquire();
    await control.enable({ pluginId: 'aih.test.tag', configuration: { tag: 'v2' } });

    assert.equal((await runtime.invoke('tag.read', null, { generation: inFlight.generation })).value, 'v1');
    const fresh = runtime.acquire();
    assert.notEqual(fresh.generation, inFlight.generation);
    assert.equal((await runtime.invoke('tag.read', null, { generation: fresh.generation })).value, 'v2');
    assert.deepEqual(runtime.status().retiringGenerations, [inFlight.generation]);

    inFlight.release();
    inFlight.release();
    assert.ok(await waitFor(async () => {
      try { await runtime.invoke('tag.read', null, { generation: inFlight.generation }); return false; } catch (error) { return error.code === 'plugin_generation_unknown'; }
    }), '最后一个租约释放后旧代次被卸载');
    assert.deepEqual(runtime.status().retiringGenerations, []);
    fresh.release();
  });
});

test('a generation still held past the retire timeout is force-retired and counted', async () => {
  await withTagSystem(async ({ control, runtime }) => {
    await control.enable({ pluginId: 'aih.test.tag', configuration: { tag: 'v1' } });
    const stuck = runtime.acquire();
    await control.enable({ pluginId: 'aih.test.tag', configuration: { tag: 'v2' } });
    assert.ok(await waitFor(() => runtime.status().forcedRetirements === 1));
    await assert.rejects(runtime.invoke('tag.read', null, { generation: stuck.generation }), { code: 'plugin_generation_unknown' });
    stuck.release();
  }, { retireTimeoutMs: 100 });
});

test('host recycling waits until no request holds a generation', async () => {
  await withTagSystem(async ({ control, runtime }) => {
    await control.enable({ pluginId: 'aih.test.tag', configuration: { tag: 'a' } });
    const pid = runtime.status().host.pid;
    const held = runtime.acquire();
    await control.enable({ pluginId: 'aih.test.tag', configuration: { tag: 'b' } });
    await control.enable({ pluginId: 'aih.test.tag', configuration: { tag: 'c' } });
    assert.equal(runtime.status().host.pid, pid, '有在途租约时不回收宿主');
    assert.equal((await runtime.invoke('tag.read', null, { generation: held.generation })).value, 'a');
    held.release();
    await control.enable({ pluginId: 'aih.test.tag', configuration: { tag: 'd' } });
    assert.notEqual(runtime.status().host.pid, pid, '租约归零后下一次发布先回收宿主');
    const lease = runtime.acquire();
    assert.equal((await runtime.invoke('tag.read', null, { generation: lease.generation })).value, 'd');
    lease.release();
  }, { recycleAfterGenerations: 2 });
});

// ---- gateway.request 语义（假运行时，确定性） ----

function fakeRuntime(handlers) {
  const calls = [];
  return {
    calls,
    invoke: async (id, value, options) => {
      calls.push({ id, generation: options.generation, model: value.model });
      const handler = handlers[id];
      return { value: await handler(value) };
    }
  };
}

function leaseFor(chain, generation = 7) {
  return { generation, snapshot: { generation, byCapability: new Map([['gateway.request', chain]]) } };
}

const step = (id, extra = {}) => ({ id, capability: 'gateway.request', order: 0, failurePolicy: 'deny', instanceId: id.split('.')[0], ...extra });

test('request plugins run in snapshot order on the pinned generation and see each other\'s output', async () => {
  const runtime = fakeRuntime({
    'a.first': (input) => ({ body: { ...input.body, model: 'rewritten', max_tokens: 5 } }),
    'b.second': (input) => ({ body: { ...input.body, seenModel: input.model } })
  });
  const outcome = await runRequestStage(runtime, leaseFor([step('a.first'), step('b.second')], 42),
    { protocol: 'openai_chat', path: '/v1/chat/completions', body: { model: 'orig', messages: [] } });
  assert.equal(outcome.changed, true);
  assert.deepEqual(outcome.body, { model: 'rewritten', messages: [], max_tokens: 5, seenModel: 'rewritten' });
  assert.deepEqual(runtime.calls.map((call) => [call.id, call.generation]), [['a.first', 42], ['b.second', 42]]);
});

test('request plugins cannot modify identity, continuation or encrypted fields', async () => {
  const body = {
    model: 'm', previous_response_id: 'resp_1', store: false, metadata: { session_id: 's1', note: 'free' },
    input: [{ type: 'reasoning', encrypted_content: 'gAAAA-secret' }]
  };
  const attempts = {
    previous: (input) => ({ body: { ...input.body, previous_response_id: 'resp_2' } }),
    store: (input) => ({ body: { ...input.body, store: true } }),
    session: (input) => ({ body: { ...input.body, metadata: { ...input.body.metadata, session_id: 'other' } } }),
    encrypted: (input) => ({ body: { ...input.body, input: [{ type: 'reasoning', encrypted_content: 'forged' }] } })
  };
  for (const [name, handler] of Object.entries(attempts)) {
    await assert.rejects(
      runRequestStage(fakeRuntime({ [`${name}.x`]: handler }), leaseFor([step(`${name}.x`)]), { protocol: 'p', path: '/v1/responses', body }),
      { code: 'plugin_identity_modified' }, name);
  }
  const allowed = await runRequestStage(fakeRuntime({ 'ok.x': (input) => ({ body: { ...input.body, metadata: { ...input.body.metadata, note: 'changed' } } }) }),
    leaseFor([step('ok.x')]), { protocol: 'p', path: '/v1/responses', body });
  assert.equal(allowed.body.metadata.note, 'changed');
  assert.equal(identityFingerprint(allowed.body), identityFingerprint(body));
});

test('rejections are limited to 4xx, failures deny by default and delegate skips only that plugin', async () => {
  const body = { model: 'm' };
  const reject = await runRequestStage(fakeRuntime({ 'r.x': () => ({ reject: { status: 200, message: 'nope' } }) }),
    leaseFor([step('r.x')]), { protocol: 'p', path: '/', body });
  assert.equal(reject.reject.status, 403, '非 4xx 状态码被收敛为 403');

  const failing = { 'f.x': () => { throw new Error('boom'); }, 'g.x': (input) => ({ body: { ...input.body, touched: true } }) };
  await assert.rejects(runRequestStage(fakeRuntime(failing), leaseFor([step('f.x'), step('g.x')]), { protocol: 'p', path: '/', body }),
    (error) => error.contributionId === 'f.x' && /boom/.test(error.message));
  const delegated = [];
  const outcome = await runRequestStage(fakeRuntime(failing), leaseFor([step('f.x', { failurePolicy: 'delegate' }), step('g.x')]),
    { protocol: 'p', path: '/', body }, { onDelegated: (event) => delegated.push(event.item.id) });
  assert.deepEqual(outcome.body, { model: 'm', touched: true });
  assert.deepEqual(delegated, ['f.x']);
});

// ---- 接缝：快路径、租约随响应关闭释放、Go 路由交回 Node ----

const REWRITER_MANIFEST = manifest('aih.test.rewriter', {
  configSchema: { type: 'object', additionalProperties: false, required: ['target'], properties: { target: { type: 'string' } } },
  contributes: [{ id: 'rewriter.request', capability: 'gateway.request', version: 1 }]
});
const REWRITER_SOURCE = `export default { apply(ctx, config) {
  ctx.aih.register('rewriter.request', (input) => {
    if (JSON.stringify(input.body.messages || []).includes('forbidden-topic')) {
      return { reject: { status: 451, message: 'blocked by the policy plugin' } };
    }
    if (input.body.model === 'plugin-alias') return { body: { ...input.body, model: config.target, temperature: 0 } };
    return null;
  });
} };`;

test('the router seam is free without plugins, pins a lease per request and defers Go routes while active', async () => {
  const dir = tempDir('aihm2s-');
  const aiHomeDir = path.join(dir, 'home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const state = {};
  const writeJson = () => { throw new Error('unexpected write'); };
  try {
    assert.deepEqual(await applyGatewayRequestPlugins({ state, res: new EventEmitter(), requestJson: { model: 'x' }, writeJson }), { handled: false });
    assert.equal(shouldDeferToNodeForPlugins(state), false);
    const { control, runtime } = getPluginSystem(state, { aiHomeDir, socketPath: socketFor(dir) });
    assert.equal(shouldDeferToNodeForPlugins(state), false, '只安装不启用不交回');
    control.install(packPlugin(dir, 'rewriter', REWRITER_MANIFEST, REWRITER_SOURCE));
    await control.enable({ pluginId: 'aih.test.rewriter', configuration: { target: 'claude-opus-5' } });
    assert.equal(shouldDeferToNodeForPlugins(state), true);

    const res = new EventEmitter();
    const requestMeta = {};
    const stage = await applyGatewayRequestPlugins({ state, res, pathname: '/v1/messages', clientProtocol: 'anthropic_messages',
      requestJson: { model: 'plugin-alias', messages: [] }, writeJson, requestMeta });
    assert.equal(stage.requestJson.model, 'claude-opus-5');
    assert.equal(JSON.parse(stage.bodyBuffer.toString()).temperature, 0);
    assert.equal(requestMeta.pluginGeneration, runtime.status().activeGeneration);
    assert.deepEqual(runtime.status().leases, { [requestMeta.pluginGeneration]: 1 });
    res.emit('close');
    assert.deepEqual(runtime.status().leases, {});

    await control.disable({ instanceId: 'aih.test.rewriter' });
    assert.equal(shouldDeferToNodeForPlugins(state), false);
    await runtime.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 经真实 aih server 的端到端 ----

const MANAGEMENT_KEY = 'management-key-that-is-long-enough';

async function startClaudeServer(t) {
  const { startLocalServer } = require('../lib/server/server');
  const { createProcessCapture, createServerDeps, createServeOptions, getFreePort } = require('./helpers/local-server-harness');
  const { registerAccountIdentity } = require('../lib/account/account-registration');
  const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');
  const { createAccountStateIndex } = require('../lib/account/state-index');
  const { createAccountStateService } = require('../lib/account/state-service');
  const { loadServerRuntimeAccounts } = require('../lib/server/accounts');
  const { applyReloadState } = require('../lib/server/management');

  const dir = tempDir('aihm2e-');
  const aiHomeDir = path.join(dir, 'home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const { accountRef } = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'claude', cliAccountId: '1', identitySeed: 'oauth:claude:uuid:33333333-3333-4333-8333-333333333333'
  });
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, { credentials: { claudeAiOauth: {
    accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 7200_000,
    account: { uuid: '33333333-3333-4333-8333-333333333333', emailAddress: 'm2@example.com' }
  } } });

  const upstreamBodies = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.url !== '/v1/messages') { res.writeHead(404); res.end('{}'); return; }
      upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_m2', type: 'message', role: 'assistant', model: 'claude-opus-5',
        content: [{ type: 'text', text: 'served' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  const port = await getFreePort();
  const lifecycle = { relayClosed: 0, webrtcClosed: 0, fabricClosed: 0, mdnsStopped: 0, outboundStopped: 0, frpStopped: 0, logTimers: new Set(), logTimersCleared: 0 };
  const handle = await startLocalServer(createServeOptions(port, {
    provider: 'claude', backend: 'passthrough', manageProcessLifecycle: false, managementKey: MANAGEMENT_KEY,
    clientKey: 'test-client-key', noProxy: true, upstreamTimeoutMs: 5000,
    claudeBaseUrl: `http://127.0.0.1:${upstream.address().port}`
  }), createServerDeps(aiHomeDir, createProcessCapture(), lifecycle, {
    loadServerRuntimeAccounts,
    applyReloadState,
    checkStatus: () => ({ configured: true, accountName: 'm2@example.com' }),
    accountRuntimeEvents: new EventEmitter()
  }));
  const index = createAccountStateIndex({ fs, aiHomeDir });
  createAccountStateService({ accountStateIndex: index }).recordRuntimeSuccess(accountRef, 'claude', { configured: true, authMode: 'oauth' });
  index.setStatus(accountRef, 'up');
  index.close();

  t.after(async () => {
    await handle.stop('test-cleanup');
    await new Promise((resolve) => upstream.close(resolve));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (error) { if (!(process.platform === 'win32' && error.code === 'EBUSY')) throw error; }
  });
  const base = `http://127.0.0.1:${port}`;
  const management = async (route, body) => {
    const response = await fetch(`${base}/v0/plugins${route}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${MANAGEMENT_KEY}` },
      body: body ? JSON.stringify(body) : undefined
    });
    return response.json();
  };
  const message = (model, text) => fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-client-key' },
    body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: text }] }),
    signal: AbortSignal.timeout(10000)
  });
  return { dir, upstreamBodies, management, message };
}

test('through aih server: no plugin means an untouched request; an enabled plugin rewrites and rejects', async (t) => {
  const { dir, upstreamBodies, management, message } = await startClaudeServer(t);

  const plain = await message('claude-opus-5', 'hello');
  assert.equal(plain.status, 200, await plain.text());
  assert.equal(upstreamBodies[0].temperature, undefined);
  assert.equal((await management('')).runtime.host.running, false, '没有插件时不启动宿主');

  const installed = await management('/install', { file: packPlugin(dir, 'rewriter', REWRITER_MANIFEST, REWRITER_SOURCE) });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  const enabled = await management('/enable', { pluginId: 'aih.test.rewriter', configuration: { target: 'claude-opus-5' } });
  assert.equal(enabled.ok, true, JSON.stringify(enabled));

  const rewritten = await message('plugin-alias', 'hello again');
  const rewrittenBody = await rewritten.json();
  assert.equal(rewritten.status, 200, JSON.stringify(rewrittenBody));
  assert.equal(rewrittenBody.content[0].text, 'served');
  assert.equal(upstreamBodies[1].model, 'claude-opus-5');
  assert.equal(upstreamBodies[1].temperature, 0);

  const blocked = await message('claude-opus-5', 'tell me about forbidden-topic');
  const blockedBody = await blocked.json();
  assert.equal(blocked.status, 451);
  assert.equal(blockedBody.error.code, 'plugin_rejected');
  assert.equal(upstreamBodies.length, 2, '被拒绝的请求不出站');

  assert.ok(await waitFor(async () => Object.keys((await management('')).runtime.leases).length === 0), '请求结束后租约全部释放');
});
