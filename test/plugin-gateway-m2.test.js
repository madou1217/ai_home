'use strict';

// 插件架构 M2（第一批）：代次固定与按租约退役、gateway.request 阶段语义、Go 路由交回 Node，
// 以及经真实 aih server（假上游）的端到端：插件改写请求体、拒绝请求、无插件时零开销。
// 全部在 /tmp 临时目录与随机端口上运行，不触碰用户的 ~/.ai_home 与 9527。

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('fs-extra');
const path = require('node:path');

const { tempDir, socketFor, manifest, packPlugin, waitFor, startClaudeServer } = require('./helpers/plugin-gateway-harness');
const { createPluginSystem, getPluginSystem } = require('../lib/plugins/control/plugin-system');
const { runRequestStage, identityFingerprint } = require('../lib/plugins/gateway/request-stage');
const { applyGatewayRequestPlugins, explainPluginDeferral, shouldDeferToNodeForPlugins } = require('../lib/server/gateway-plugin-stage');

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

// ---- gateway.account ----

const { runAccountStage } = require('../lib/plugins/gateway/account-stage');
const { chooseServerAccount } = require('../lib/server/account-selector');

function accountLease(chain, generation = 9) {
  return { generation, snapshot: { generation, byCapability: new Map([['gateway.account', chain]]) } };
}
const accountStep = (id, extra = {}) => ({ id, capability: 'gateway.account', order: 0, failurePolicy: 'deny', instanceId: id.split('.')[0], ...extra });

test('account plugins only reorder the host candidates and see no credentials', async () => {
  const pool = [
    { accountRef: 'acct_a', authType: 'oauth', accessToken: 'secret-a', email: 'a@example.com' },
    { accountRef: 'acct_b', apiKeyMode: true, openaiApiKey: 'sk-b' },
    { accountRef: 'acct_c', authType: 'oauth' }
  ];
  const seen = [];
  const runtime = fakeRuntime({
    'p.first': (input) => { seen.push(input); return { prefer: ['acct_c'] }; },
    'q.second': (input) => { seen.push(input); return { prefer: ['acct_b'] }; }
  });
  const order = await runAccountStage(runtime, accountLease([accountStep('p.first'), accountStep('q.second')]), { provider: 'codex', model: 'gpt-x', candidates: pool });
  assert.deepEqual(order, ['acct_b', 'acct_c']);
  assert.deepEqual(seen[0].candidates, [
    { accountRef: 'acct_a', authType: 'oauth' }, { accountRef: 'acct_b', authType: 'api-key' }, { accountRef: 'acct_c', authType: 'oauth' }
  ], '候选只暴露 accountRef 与认证类型');
  assert.deepEqual(seen[1].candidates.map((item) => item.accountRef), ['acct_c', 'acct_a', 'acct_b'], '后一个插件看到前一个调整后的顺序');

  await assert.rejects(runAccountStage(fakeRuntime({ 'x.bad': () => ({ prefer: ['acct_outside'] }) }), accountLease([accountStep('x.bad')]),
    { provider: 'codex', model: 'gpt-x', candidates: pool }), { code: 'plugin_scope_violation' });
  assert.deepEqual(await runAccountStage(fakeRuntime({ 'x.bad': () => ({ prefer: ['acct_outside'] }) }), accountLease([accountStep('x.bad', { failurePolicy: 'delegate' })]),
    { provider: 'codex', model: 'gpt-x', candidates: pool }), [], 'delegate 忽略越界插件的偏好');
});

test('plugin account preference ranks after session affinity and before the default account', () => {
  const accounts = ['acct_1', 'acct_2', 'acct_3'].map((accountRef) => ({ accountRef, provider: 'claude', authType: 'oauth' }));
  const state = { strategy: 'round_robin' };
  assert.equal(chooseServerAccount(accounts, state, 'claude', { provider: 'claude', preferredAccountRefs: ['acct_3'], preferredAccountRef: 'acct_2' }).accountRef, 'acct_3');
  assert.equal(chooseServerAccount(accounts, state, 'claude', { provider: 'claude', preferredAccountRefs: ['acct_9', 'acct_2'] }).accountRef, 'acct_2', '偏好不可用时取下一个');
  // 会话亲和先绑定 acct_1，之后插件偏好也不能把同一会话挪走。
  assert.equal(chooseServerAccount(accounts, state, 'claude', { provider: 'claude', sessionKey: 's1', preferredAccountRefs: ['acct_1'] }).accountRef, 'acct_1');
  assert.equal(chooseServerAccount(accounts, state, 'claude', { provider: 'claude', sessionKey: 's1', preferredAccountRefs: ['acct_3'] }).accountRef, 'acct_1');
  assert.equal(chooseServerAccount(accounts, state, 'claude', { provider: 'claude', preferredAccountRefs: ['acct_2'], excludeAccountRefs: ['acct_2'] }).accountRef !== 'acct_2', true, '已试过的账号不因偏好被重选');
});

const ACCOUNT_POLICY_MANIFEST = manifest('aih.test.account-policy', {
  configSchema: { type: 'object', additionalProperties: false, required: ['prefer'], properties: { prefer: { type: 'string' } } },
  contributes: [{ id: 'policy.account', capability: 'gateway.account', version: 1 }]
});
const ACCOUNT_POLICY_SOURCE = `export default { apply(ctx, config) {
  ctx.aih.register('policy.account', (input) => ({ prefer: [config.prefer] }));
} };`;

test('through aih server: an account policy plugin steers selection within the authorized pool only', async (t) => {
  const { dir, upstreamTokens, accountRefs, management, message } = await startClaudeServer(t);
  assert.equal((await management('/install', { file: packPlugin(dir, 'account-policy', ACCOUNT_POLICY_MANIFEST, ACCOUNT_POLICY_SOURCE) })).ok, true);
  const enabled = await management('/enable', { pluginId: 'aih.test.account-policy', configuration: { prefer: accountRefs[1] } });
  assert.equal(enabled.ok, true, JSON.stringify(enabled));
  for (let index = 0; index < 3; index += 1) {
    const response = await message('claude-opus-5', `turn ${index}`);
    assert.equal(response.status, 200, await response.text());
  }
  assert.deepEqual(upstreamTokens, ['Bearer access-2', 'Bearer access-2', 'Bearer access-2'], '每次都选插件偏好的账号');

  const scoped = await management('/enable', { pluginId: 'aih.test.account-policy', configuration: { prefer: 'acct_not_in_pool' } });
  assert.equal(scoped.ok, true);
  const violated = await message('claude-opus-5', 'outside');
  const body = await violated.json();
  assert.equal(violated.status, 502);
  assert.equal(body.error.code, 'plugin_scope_violation');
  assert.equal(upstreamTokens.length, 3, '越界的插件偏好不会让请求出站');
});

// ---- model.catalog ----

const { collectCatalogAliases, mergePluginAliases } = require('../lib/plugins/gateway/catalog');

function catalogSnapshot(items) {
  return { generation: 3, byCapability: new Map([['model.catalog', items.map((id) => ({ id, capability: 'model.catalog', instanceId: id.split('.')[0], failurePolicy: 'deny', order: 0 }))]]) };
}

test('catalog aliases are validated, conflicts reject the candidate, and user aliases win', async () => {
  const invokeWith = (table) => async (id) => ({ value: table[id] });
  const ok = await collectCatalogAliases(invokeWith({ 'a.cat': { aliases: [{ alias: 'team-fast', target: 'gpt-x' }] } }), catalogSnapshot(['a.cat']));
  assert.deepEqual(ok.map((item) => [item.alias, item.target, item.instanceId]), [['team-fast', 'gpt-x', 'a']]);
  await assert.rejects(collectCatalogAliases(invokeWith({
    'a.cat': { aliases: [{ alias: 'shared', target: 'x' }] }, 'b.cat': { aliases: [{ alias: 'SHARED', target: 'y' }] }
  }), catalogSnapshot(['a.cat', 'b.cat'])), { code: 'plugin_catalog_conflict' });
  for (const bad of [{ aliases: 'nope' }, { aliases: [{ alias: '../x', target: 'y' }] }, { aliases: [{ alias: 'same', target: 'same' }] }]) {
    await assert.rejects(collectCatalogAliases(invokeWith({ 'a.cat': bad }), catalogSnapshot(['a.cat'])), { code: 'plugin_catalog_invalid' });
  }
  const merged = mergePluginAliases([{ id: 'u1', alias: 'Team-Fast', target: 'user-target' }],
    { catalogAliases: [{ alias: 'team-fast', target: 'plugin-target', instanceId: 'a' }, { alias: 'other', target: 't', instanceId: 'a' }] });
  assert.deepEqual(merged.map((item) => [item.alias, item.target]), [['Team-Fast', 'user-target'], ['other', 't']], '同名时用户别名优先');
  const shadowing = mergePluginAliases([{ id: 'u2', alias: 'mine', target: 'real-model' }],
    { catalogAliases: [{ alias: 'real-model', target: 'elsewhere', instanceId: 'a' }] }, { isRealModel: (id) => id === 'real-model' });
  assert.deepEqual(shadowing.map((item) => item.alias), ['mine'], '与真实模型同名的插件别名被丢弃，不会让用户别名失效');
});

const CATALOG_MANIFEST = manifest('aih.test.catalog', {
  contributes: [{ id: 'catalog.aliases', capability: 'model.catalog', version: 1 }]
});
const CATALOG_SOURCE = `export default { apply(ctx) {
  ctx.aih.register('catalog.aliases', () => ({ aliases: [{ alias: 'team-default', target: 'claude-opus-5', description: 'team default' }] }));
} };`;

test('through aih server: a catalog plugin alias routes to its target and disappears when disabled', async (t) => {
  const { dir, upstreamBodies, management, message } = await startClaudeServer(t);
  assert.equal((await management('/install', { file: packPlugin(dir, 'catalog', CATALOG_MANIFEST, CATALOG_SOURCE) })).ok, true);
  const enabled = await management('/enable', { pluginId: 'aih.test.catalog' });
  assert.equal(enabled.ok, true, JSON.stringify(enabled));
  assert.deepEqual((await management('')).runtime.catalogAliases, [{ alias: 'team-default', target: 'claude-opus-5', instanceId: 'aih.test.catalog' }]);

  const aliased = await message('team-default', 'via alias');
  assert.equal(aliased.status, 200, await aliased.text());
  assert.equal(upstreamBodies.at(-1).model, 'claude-opus-5', '上游收到的是目标模型');

  await management('/disable', { instanceId: 'aih.test.catalog' });
  assert.deepEqual((await management('')).runtime.catalogAliases, []);
  await message('team-default', 'alias gone');
  assert.equal(upstreamBodies.at(-1).model, 'team-default', '停用后别名不再改写，透传模式原样转发');
});

test('the auto-mode model list includes catalog plugin aliases and refreshes when the generation changes', async () => {
  const { handleV1Request } = require('../lib/server/v1-router');
  const { buildOpenAIModelsList } = require('../lib/server/models');
  const { handleUpstreamModels } = require('../lib/server/upstream-endpoints');
  const dir = tempDir('aihm2l-');
  const aiHomeDir = path.join(dir, 'home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const state = {
    metrics: { totalRequests: 0, routeCounts: {}, totalSuccess: 0 },
    accounts: { codex: [], gemini: [{ id: '1', accountRef: 'acct_0123456789abcdef0123', provider: 'gemini', accessToken: 't', availableModels: ['gemini-x'] }], claude: [] },
    modelRegistry: { providers: { codex: new Set(), gemini: new Set(), claude: new Set() } },
    modelsCache: { ids: [], updatedAt: 0, byAccount: {}, sourceCount: 0 }
  };
  let control = null;
  let runtime = null;
  const listIds = async () => {
    const res = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, write(c = '') { this.body += String(c); }, end(c = '') { this.body += String(c); } };
    await handleV1Request({
      req: { headers: {}, url: '/v1/models' }, res, method: 'GET', pathname: '/v1/models',
      options: { backend: 'codex-adapter', provider: 'auto', upstreamTimeoutMs: 500, modelsProbeAccounts: 1 },
      state, requiredClientKey: '', cooldownMs: 1000, maxRequestBodyBytes: 1024 * 1024, localExecOpts: {},
      deps: {
        parseAuthorizationBearer: () => '',
        writeJson: (r, code, payload) => { r.statusCode = code; r.end(JSON.stringify(payload)); },
        readRequestBody: async () => Buffer.from(''),
        loadAliases: async () => ({ aliases: [] }), fs, aiHomeDir,
        buildOpenAIModelsList,
        handleCodexModels: async ({ res: routeRes }) => {
          routeRes.statusCode = 200;
          routeRes.end(JSON.stringify({ object: 'list', data: [{ id: 'gemini-x', object: 'model' }] }));
        },
        handleUpstreamModels: async ({ res: routeRes }) => {
          routeRes.statusCode = 200;
          routeRes.end(JSON.stringify({ object: 'list', data: [] }));
        },
        fetchModelsForAccount: async () => ['gemini-x'],
        FALLBACK_MODELS: []
      }
    });
    if (!res.body) throw new Error('empty body status=' + res.statusCode + ' headers=' + JSON.stringify(res.headers));
    return { status: res.statusCode, ids: JSON.parse(res.body).data.map((item) => item.id) };
  };
  try {
    const before = await listIds();
    assert.equal(before.status, 200, JSON.stringify(before));
    assert.equal(before.ids.includes('team-default'), false);
    ({ control, runtime } = getPluginSystem(state, { aiHomeDir, socketPath: socketFor(dir) }));
    control.install(packPlugin(dir, 'catalog', manifest('aih.test.catalog', {
      contributes: [{ id: 'catalog.aliases', capability: 'model.catalog', version: 1 }]
    }), `export default { apply(ctx) { ctx.aih.register('catalog.aliases', () => ({ aliases: [
      { alias: 'team-default', target: 'gemini-x' }, { alias: 'gemini-x', target: 'something-else' }
    ] })); } };`));
    await control.enable({ pluginId: 'aih.test.catalog' });
    const enabled = await listIds();
    assert.equal(enabled.ids.includes('team-default'), true, `插件别名进入列表：${enabled.ids}`);
    assert.equal(enabled.ids.filter((id) => id === 'gemini-x').length, 1, '与真实模型同名的插件别名不覆盖真实条目');
    await control.disable({ instanceId: 'aih.test.catalog' });
    const disabled = await listIds();
    assert.equal(disabled.ids.includes('team-default'), false, '代次变化后缓存失效，别名消失');
  } finally {
    if (runtime) await runtime.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 尝试观察 ----

const OBSERVER_MANIFEST = manifest('aih.test.observer', {
  configSchema: { type: 'object', additionalProperties: false, properties: { delayMs: { type: 'integer', minimum: 0 } } },
  contributes: [
    { id: 'observer.events', capability: 'observe', version: 1 },
    { id: 'observer.dump', capability: 'command', version: 1 }
  ]
});
const OBSERVER_SOURCE = `const seen = [];
export default { apply(ctx, config) {
  ctx.aih.register('observer.events', async (event) => {
    if (config.delayMs) await new Promise((resolve) => setTimeout(resolve, config.delayMs));
    seen.push(event);
  });
  ctx.aih.register('observer.dump', () => seen.slice());
} };`;

test('through aih server: observers get a low-sensitivity summary of every attempt, including failed ones', async (t) => {
  const { dir, management, message, failures, accountRefs } = await startClaudeServer(t);
  assert.equal((await management('/install', { file: packPlugin(dir, 'observer', OBSERVER_MANIFEST, OBSERVER_SOURCE) })).ok, true);
  assert.equal((await management('/enable', { pluginId: 'aih.test.observer' })).ok, true);
  failures.remaining = 1;
  const response = await message('claude-opus-5', 'observe me');
  assert.equal(response.status, 200, await response.text());
  let events = [];
  assert.ok(await waitFor(async () => {
    events = (await management('/invoke', { contributionId: 'observer.dump' })).value || [];
    return events.length >= 2;
  }), JSON.stringify(events));
  assert.deepEqual(events.map((event) => event.outcome), ['retry_next', 'return']);
  assert.notEqual(events[0].accountRef, events[1].accountRef, '失败后换号');
  assert.ok(accountRefs.includes(events[0].accountRef) && accountRefs.includes(events[1].accountRef));
  assert.equal(events[1].committed, true);
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), ['accountRef', 'attempt', 'committed', 'durationMs', 'error', 'generation', 'model', 'outcome', 'provider', 'type']);
    assert.equal(JSON.stringify(event).includes('observe me'), false, '事件不带请求正文');
    assert.equal(JSON.stringify(event).includes('access-'), false, '事件不带凭据');
  }
  assert.equal((await management('')).runtime.observations.dropped, 0);
});

test('the observation queue is bounded, never blocks the caller and outlives a publish on its own lease', async () => {
  const dir = tempDir('aihm2o-');
  const aiHomeDir = path.join(dir, 'home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const { control, runtime } = createPluginSystem({ aiHomeDir, socketPath: socketFor(dir), observeQueueLimit: 3 });
  try {
    control.install(packPlugin(dir, 'observer', OBSERVER_MANIFEST, OBSERVER_SOURCE));
    await control.enable({ pluginId: 'aih.test.observer', configuration: { delayMs: 100 } });
    const lease = runtime.acquire();
    const firstGeneration = lease.generation;
    const started = Date.now();
    const accepted = Array.from({ length: 10 }, (_, index) => runtime.observe(lease, { type: 'test', index }));
    assert.ok(Date.now() - started < 50, 'observe() 立即返回');
    assert.deepEqual(accepted, [true, true, true, false, false, false, false, false, false, false]);
    assert.equal(runtime.status().observations.dropped, 7);
    lease.release();
    // 新代次发布后，排队中的事件仍在原代次上投递（每个事件持有自己的租约）。
    await control.enable({ pluginId: 'aih.test.observer', configuration: { delayMs: 0 } });
    assert.ok(await waitFor(() => runtime.status().observations.delivered === 3, 3000), JSON.stringify(runtime.status().observations));
    const oldEvents = (await runtime.invoke('observer.dump', null, { generation: firstGeneration }).catch(() => ({ value: null }))).value;
    assert.ok(oldEvents === null || oldEvents.length === 3, '旧代次收到全部 3 个事件（或已在排空后退役）');
    assert.ok(await waitFor(() => runtime.status().retiringGenerations.length === 0, 3000), '投递完释放租约后旧代次退役');
  } finally {
    await runtime.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- G5：插件阶段的交还原因必须可区分（入口/能力/代次是三种不同的下线阻塞项） ----

const ATTEMPT_MANIFEST = manifest('aih.test.attempt', {
  configSchema: { type: 'object', additionalProperties: false, properties: {} },
  contributes: [{ id: 'attempt.record', capability: 'gateway.attempt', version: 1 }]
});
const ATTEMPT_SOURCE = `export default { apply(ctx) { ctx.aih.register('attempt.record', () => null); } };`;

test('plugin deferrals report which of the three blockers applies', async () => {
  const dir = tempDir('aihm2r-');
  const aiHomeDir = path.join(dir, 'home');
  fs.mkdirSync(aiHomeDir, { recursive: true });
  const state = {};
  try {
    const { control, runtime } = getPluginSystem(state, { aiHomeDir, socketPath: socketFor(dir) });
    // 没有活跃的网关贡献项：不交回，也不产生原因（正常转发不该被记成一次回落）。
    assert.deepEqual(explainPluginDeferral(state, { entryId: 'gateway.openai.responses' }), { defer: false, reason: '' });

    control.install(packPlugin(dir, 'rewriter', REWRITER_MANIFEST, REWRITER_SOURCE));
    await control.enable({ pluginId: 'aih.test.rewriter', configuration: { target: 'claude-opus-5' } });
    // Go 只执行三个推理入口，也不执行 WebSocket 升级。
    assert.equal(explainPluginDeferral(state, { entryId: 'gateway.props' }).reason, 'plugin_unsupported_entry');
    assert.equal(explainPluginDeferral(state, { entryId: 'gateway.openai.responses', transport: 'websocket' }).reason, 'plugin_unsupported_entry');
    // 入口与传输都支持，剩下的唯一阻塞项是这一代插件还没被 Go 确认。
    assert.equal(explainPluginDeferral(state, { entryId: 'gateway.openai.responses' }).reason, 'plugin_generation_unacked');

    control.install(packPlugin(dir, 'attempt', ATTEMPT_MANIFEST, ATTEMPT_SOURCE));
    await control.enable({ pluginId: 'aih.test.attempt', configuration: {} });
    // gateway.attempt 目前只有 Node 执行：这类请求必须先补 Go 才能下线。
    assert.equal(explainPluginDeferral(state, { entryId: 'gateway.openai.responses' }).reason, 'plugin_unsupported_capability');
    assert.equal(shouldDeferToNodeForPlugins(state, { entryId: 'gateway.openai.responses' }), true);
    await runtime.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
