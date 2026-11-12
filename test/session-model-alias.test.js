'use strict';

// 单次会话模型改写（--model-alias）的回归守卫：
//   aih <cli> <account> --model modelA --model-alias modelB  → modelA=modelB
//   aih <cli> <account> --model-alias modelB                 → *=modelB
// 规则不落库；claude / codex 经 x-aih-model-alias 头交给网关，网关在别名解析前应用。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  HEADER_NAME,
  parseSessionModelAliasSpec,
  encodeSessionModelAlias,
  readSessionModelAliasHeader,
  sessionModelAliasMatches,
  applySessionModelAlias
} = require('../lib/server/session-model-alias');
const {
  splitSessionModelAliasPath,
  buildSessionModelAliasPathPrefix
} = require('../lib/server/session-model-alias');
const {
  applySessionModelAliasToRequest,
  applySessionModelAliasToRequestState
} = require('../lib/server/session-model-alias-request');
const {
  extractModelAliasFlag,
  readModelFlagValue,
  buildSessionModelAliasRule,
  wrapSessionModelAliasBaseUrl
} = require('../lib/harness/model-alias-flag');
const { parseHarnessArgs, resolveHarnessAliasLaunchModel } = require('../lib/cli/commands/harness/router');
const { resolveGatewayProfile } = require('../lib/cli/services/ai-cli/launch-profile/opencode-strategy');
const { buildCodexProviderArgs } = require('../lib/cli/services/ai-cli/codex-provider-args');
const { buildProviderRuntimeEnv } = require('../lib/cli/services/ai-cli/provider-runtime-env');
const { explainGoRouteDeferral } = require('../lib/server/go-core-route-deferral');
const { NODE_FALLBACK_REASONS } = require('../lib/server/go-core-node-fallback-counters');
const { createRoutesElsewhere } = require('../lib/server/codex-responses-websocket');
const { createGoCoreGatewayForwarder } = require('../lib/server/go-core-gateway-forwarder');
const { EventEmitter } = require('node:events');

test('规则解析：A=B / 裸模型名（通配）', () => {
  assert.deepEqual(parseSessionModelAliasSpec('modelA=modelB'), { source: 'modelA', target: 'modelB' });
  assert.deepEqual(parseSessionModelAliasSpec('modelB'), { source: '*', target: 'modelB' });
  assert.deepEqual(parseSessionModelAliasSpec('=modelB'), { source: '*', target: 'modelB' });
  assert.equal(parseSessionModelAliasSpec('modelA='), null);
  assert.equal(parseSessionModelAliasSpec(''), null);
});

test('规则编码与头解析（大小写、数组形式）', () => {
  assert.equal(encodeSessionModelAlias({ source: 'a', target: 'b' }), 'a=b');
  assert.equal(encodeSessionModelAlias({ source: '*', target: 'b' }), '*=b');
  assert.deepEqual(readSessionModelAliasHeader({ [HEADER_NAME]: 'a=b' }), { source: 'a', target: 'b' });
  assert.deepEqual(readSessionModelAliasHeader({ 'X-Aih-Model-Alias': ['*=b'] }), { source: '*', target: 'b' });
  assert.equal(readSessionModelAliasHeader({}), null);
});

test('命中判断：具名只命中同名（忽略大小写），通配命中任意模型', () => {
  assert.equal(sessionModelAliasMatches({ source: 'ModelA', target: 'b' }, 'modela'), true);
  assert.equal(sessionModelAliasMatches({ source: 'modelA', target: 'b' }, 'modelC'), false);
  assert.equal(sessionModelAliasMatches({ source: '*', target: 'b' }, 'whatever'), true);
  assert.equal(sessionModelAliasMatches(null, 'whatever'), false);
});

test('应用到请求体：只改 model，其余字段原样，不改入参', () => {
  const request = { model: 'modelA', messages: [{ role: 'user', content: 'hi' }] };
  const applied = applySessionModelAlias({ requestJson: request, headers: { [HEADER_NAME]: 'modelA=modelB' } });
  assert.equal(applied.changed, true);
  assert.equal(applied.requestJson.model, 'modelB');
  assert.equal(applied.requestJson.messages, request.messages);
  assert.equal(request.model, 'modelA');

  const miss = applySessionModelAlias({ requestJson: request, headers: { [HEADER_NAME]: 'other=x' } });
  assert.equal(miss.changed, false);
  assert.equal(miss.requestJson, request);
});

test('CLI 解析：--model-alias 两种写法，-- 之后不抢', () => {
  assert.deepEqual(
    extractModelAliasFlag(['claude', '3', '--model', 'A', '--model-alias', 'B']),
    { args: ['claude', '3', '--model', 'A'], alias: 'B' }
  );
  assert.deepEqual(
    extractModelAliasFlag(['claude', '3', '--model-alias=B']),
    { args: ['claude', '3'], alias: 'B' }
  );
  assert.equal(extractModelAliasFlag(['claude', '--model-alias']).error, 'model_alias_value_missing');
  assert.deepEqual(
    extractModelAliasFlag(['claude', '--', '--model-alias', 'B']),
    { args: ['claude', '--', '--model-alias', 'B'], alias: '' }
  );
  assert.equal(readModelFlagValue(['claude', '3', '--model', 'A']), 'A');
  assert.equal(readModelFlagValue(['claude', '3', '--model=A']), 'A');
});

test('规则构造：给了 --model 是具名规则，没给是通配', () => {
  assert.deepEqual(buildSessionModelAliasRule({ model: 'A', alias: 'B' }), { source: 'A', target: 'B' });
  assert.deepEqual(buildSessionModelAliasRule({ model: '', alias: 'B' }), { source: '*', target: 'B' });
  assert.deepEqual(buildSessionModelAliasRule({ model: 'A', alias: 'X=Y' }), { source: 'X', target: 'Y' });
  assert.equal(buildSessionModelAliasRule({ model: 'A', alias: '' }), null);
});

test('codex：规则翻译成 model_providers.*.http_headers.X-Aih-Model-Alias', () => {
  const args = buildCodexProviderArgs({
    OPENAI_API_KEY: 'k',
    OPENAI_BASE_URL: 'http://127.0.0.1:9527/v1',
    AIH_MODEL_ALIAS: 'modelA=modelB'
  });
  assert.ok(args.includes('model_providers.aih_server.http_headers.X-Aih-Model-Alias=modelA=modelB'));
});

// ---- 第二条送达通道：base URL 的路径前缀（没有自定义头通道的原生 CLI）----

test('路径前缀：空规则/空 token/非法入参都不产前缀、不抛', () => {
  // 没有规则就不能往 base URL 上挂前缀（否则每个请求都多一段 /-/ma/）。
  assert.equal(buildSessionModelAliasPathPrefix(null), '');
  assert.equal(buildSessionModelAliasPathPrefix({ source: 'a', target: '' }), '');
  // 前缀后面什么都没有 = 空 token：解不开，按「没有前缀」处理，路径原样交还路由。
  assert.deepEqual(splitSessionModelAliasPath('/-/ma/'), {
    rule: null, pathname: '/-/ma/', token: ''
  });
  // 非字符串入参（内部护栏）：折成空串，同样按「没有前缀」处理。
  assert.deepEqual(splitSessionModelAliasPath(null), {
    rule: null, pathname: '', token: ''
  });
  assert.deepEqual(splitSessionModelAliasPath(undefined), {
    rule: null, pathname: '', token: ''
  });
});

test('路径前缀：规则编成 base64url，拆回来还是同一条规则', () => {
  const rule = { source: 'modelA', target: 'modelB' };
  const prefix = buildSessionModelAliasPathPrefix(rule);
  assert.match(prefix, /^\/-\/ma\/[A-Za-z0-9_-]+$/);
  const split = splitSessionModelAliasPath(`${prefix}/v1beta/models/x:generateContent`);
  assert.deepEqual(split.rule, rule);
  assert.equal(split.pathname, '/v1beta/models/x:generateContent');
  // 没有前缀 / token 坏掉：原样返回，让路由自然 404，不把被改写的路径交给上游。
  assert.deepEqual(splitSessionModelAliasPath('/v1/chat/completions'), {
    rule: null, pathname: '/v1/chat/completions', token: ''
  });
  assert.equal(splitSessionModelAliasPath('/-/ma/!!!not-base64!!!/v1').rule, null);
});

test('base URL 包装：只改本机网关；非网关地址返回空串', () => {
  const rule = { source: 'A', target: 'B' };
  const wrapped = wrapSessionModelAliasBaseUrl('http://127.0.0.1:9527/v1', rule, { serverPort: 9527 });
  assert.match(wrapped, /^http:\/\/127\.0\.0\.1:9527\/-\/ma\/[A-Za-z0-9_-]+\/v1$/);
  // 幂等：已经带前缀不再叠一层。
  assert.equal(wrapSessionModelAliasBaseUrl(wrapped, rule, { serverPort: 9527 }), wrapped);
  // 端口不同 = 不是本机网关。
  assert.equal(wrapSessionModelAliasBaseUrl('http://127.0.0.1:1234/v1', rule, { serverPort: 9527 }), '');
  // 账号自带的厂商上游：加前缀只会 404。
  assert.equal(wrapSessionModelAliasBaseUrl('https://api.deepseek.com/anthropic', rule, { serverPort: 9527 }), '');
  // 调用方已知是网关（opencode overlay）时无条件包装。
  assert.match(
    wrapSessionModelAliasBaseUrl('https://gw.example.com/v1', rule, { isGateway: true }),
    /^https:\/\/gw\.example\.com\/-\/ma\/[A-Za-z0-9_-]+\/v1$/
  );
});

test('gemini：base URL 是本机网关时，规则随路径前缀送达', () => {
  const env = buildProviderRuntimeEnv('gemini', '/tmp', {}, {
    accountEnv: { GEMINI_BASE_URL: 'http://127.0.0.1:9527', AIH_MODEL_ALIAS: 'gemini-2.5-pro=glm-4.6' }
  });
  assert.match(String(env.GOOGLE_GEMINI_BASE_URL || ''), /^http:\/\/127\.0\.0\.1:9527\/-\/ma\/[A-Za-z0-9_-]+$/);
});

test('gemini：直连厂商上游时不包装（规则到不了网关）', () => {
  const env = buildProviderRuntimeEnv('gemini', '/tmp', {}, {
    accountEnv: {
      GEMINI_BASE_URL: 'https://generativelanguage.googleapis.com',
      AIH_MODEL_ALIAS: 'gemini-2.5-pro=glm-4.6'
    }
  });
  assert.equal(env.GOOGLE_GEMINI_BASE_URL, 'https://generativelanguage.googleapis.com');
});

test('网关改写：请求体的 model 与 Gemini 路径里的 model 都要覆盖', () => {
  const bodyRule = { source: 'modelA', target: 'modelB' };
  const bodyApplied = applySessionModelAliasToRequest({
    rule: bodyRule,
    pathname: '/v1/chat/completions',
    requestJson: { model: 'modelA' }
  });
  assert.equal(bodyApplied.kind, 'body');
  assert.equal(bodyApplied.requestJson.model, 'modelB');

  // gemini 的请求体没有 model，模型只在路径里。
  const pathApplied = applySessionModelAliasToRequest({
    rule: { source: 'gemini-2.5-pro', target: 'glm-4.6' },
    pathname: '/v1beta/models/gemini-2.5-pro:streamGenerateContent',
    requestJson: { contents: [] }
  });
  assert.equal(pathApplied.kind, 'path');
  assert.equal(pathApplied.pathname, '/v1beta/models/glm-4.6:streamGenerateContent');

  // 不命中：一个字都不改。
  const miss = applySessionModelAliasToRequest({
    rule: { source: 'other', target: 'x' },
    pathname: '/v1beta/models/gemini-2.5-pro:generateContent',
    requestJson: { contents: [] }
  });
  assert.equal(miss.changed, false);
  assert.equal(miss.pathname, '/v1beta/models/gemini-2.5-pro:generateContent');
});

// 网关接线：规则命中后，请求体 / 路径 / 请求头 / 上游 body 四个状态各自该变成什么。
// 这段之前只能启动整个网关才能验证，等于没有回归保护。
test('网关接线（body）：改请求体与上游 body，摘头，路径不动', () => {
  const headers = {
    'content-type': 'application/json',
    'x-aih-model-alias': 'modelA=modelB',
    'X-Aih-Model-Alias': 'modelA=modelB'
  };
  const bodyBuffer = Buffer.from(JSON.stringify({ model: 'modelA' }));
  const state = applySessionModelAliasToRequestState({
    rule: { source: 'modelA', target: 'modelB' },
    requestJson: { model: 'modelA', messages: [] },
    pathname: '/v1/chat/completions',
    headers,
    bodyBuffer
  });
  assert.equal(state.kind, 'body');
  assert.equal(state.requestJson.model, 'modelB');
  assert.equal(state.pathname, '/v1/chat/completions');
  // 上游 body 必须跟着改，否则转发出去的还是原模型。
  assert.deepEqual(JSON.parse(state.bodyBuffer.toString()), { model: 'modelB', messages: [] });
  // 规则头两种大小写都要摘掉，绝不透传上游。
  assert.deepEqual(Object.keys(state.headers), ['content-type']);
  // 入参不被改。
  assert.equal(headers['x-aih-model-alias'], 'modelA=modelB');
});

test('网关接线（gemini 路径）：改路径，body 原样，同样摘头', () => {
  const bodyBuffer = Buffer.from('{"contents":[]}');
  const state = applySessionModelAliasToRequestState({
    rule: { source: 'gemini-2.5-pro', target: 'glm-4.6' },
    requestJson: { contents: [] },
    pathname: '/v1beta/models/gemini-2.5-pro:generateContent',
    headers: { 'x-aih-model-alias': 'gemini-2.5-pro=glm-4.6' },
    bodyBuffer
  });
  assert.equal(state.kind, 'path');
  assert.equal(state.pathname, '/v1beta/models/glm-4.6:generateContent');
  assert.equal(state.bodyBuffer, bodyBuffer, 'gemini 请求体没有 model，不该重建');
  assert.deepEqual(state.headers, {});
});

test('网关接线：规则没命中也要摘头；没规则时一个对象都不动', () => {
  const headers = { 'x-aih-model-alias': 'other=x', accept: 'application/json' };
  const bodyBuffer = Buffer.from('{"model":"modelA"}');
  const miss = applySessionModelAliasToRequestState({
    rule: { source: 'other', target: 'x' },
    requestJson: { model: 'modelA' },
    pathname: '/v1/chat/completions',
    headers,
    bodyBuffer
  });
  assert.equal(miss.changed, false);
  assert.equal(miss.requestJson.model, 'modelA');
  assert.equal(miss.bodyBuffer, bodyBuffer);
  assert.deepEqual(miss.headers, { accept: 'application/json' });

  const noRule = applySessionModelAliasToRequestState({
    rule: null,
    requestJson: { model: 'modelA' },
    pathname: '/v1/chat/completions',
    headers,
    bodyBuffer
  });
  assert.equal(noRule.changed, false);
  assert.equal(noRule.headers, headers, '没有规则时不该复制请求头');
});

// 端到端：真的把请求喂给 handleV1Request，看下游拿到的是不是改写后的模型。
// 这条守的是「接线」——前面几条守的是判定逻辑，判定对了但没接上照样是 bug。
async function runRouterOnce({ pathname, headers = {}, body = {}, accounts = {}, aiHomeDir = '' }) {
  const { handleV1Request } = require('../lib/server/v1-router');
  const seen = [];
  const state = { accounts, metrics: {} };
  const res = { setHeader() {}, end() {}, writeHead() {}, on() {}, once() {} };
  const ctx = {
    req: { headers: { 'content-type': 'application/json', ...headers }, url: pathname, on() {}, once() {} },
    res,
    method: 'POST',
    pathname,
    options: {},
    state,
    requiredClientKey: '',
    cooldownMs: 0,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: () => {},
      readRequestBody: async () => Buffer.from(JSON.stringify(body)),
      resolveRequestProvider: (...args) => { seen.push(args); return ''; },
      chooseServerAccount: () => null,
      markProxyAccountSuccess() {}, markProxyAccountFailure() {}, pushMetricError() {},
      appendProxyRequestLog() {}, recordModelUsage() {},
      handleUpstreamModels: async () => false,
      handleUpstreamPassthrough: async () => false,
      handleCodexModels: async () => false,
      handleCodexChatCompletions: async () => false,
      handleImageGenerations: async () => false,
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => { throw new Error('no network'); },
      accountStateIndex: {},
      fs: require('node:fs'),
      aiHomeDir: aiHomeDir || '/tmp/aih-nonexistent',
      pushModelCatalogProjection() {}
    }
  };
  // 路由会往 stdout 打一行 Incoming request，别让它污染测试输出。
  const log = console.log;
  console.log = () => {};
  try {
    await handleV1Request(ctx);
  } finally {
    console.log = log;
  }
  return { seen, state };
}

test('端到端：头里的规则真的改到了下游拿到的 model，且头被摘掉', async () => {
  const { seen } = await runRouterOnce({
    pathname: '/v1/chat/completions',
    headers: { 'x-aih-model-alias': 'modelA=modelB' },
    body: { model: 'modelA', messages: [] }
  });
  assert.equal(seen.length, 1, '应该走到 provider 解析');
  const [, requestJson, downstreamHeaders] = seen[0];
  assert.equal(requestJson.model, 'modelB');
  assert.equal(downstreamHeaders['x-aih-model-alias'], undefined, '规则头不能透传上游');
});

test('端到端：路径前缀里的规则改掉了 Gemini 的路径模型，前缀本身不进路由', async () => {
  const prefix = buildSessionModelAliasPathPrefix({ source: 'gemini-2.5-pro', target: 'glm-4.6' });
  const { state } = await runRouterOnce({
    pathname: `${prefix}/v1beta/models/gemini-2.5-pro:generateContent`,
    body: { contents: [] }
  });
  const routes = Object.keys(state.metrics.routeCounts || {});
  assert.deepEqual(routes, ['POST /v1beta/models/glm-4.6:generateContent']);
});

test('网关入口：剥前缀重写 req.url 时，query 原样保留', () => {
  const { __private } = require('../lib/server/v1-router');
  const rewrite = __private.rewriteRequestUrlPathname;

  // 有 query：/v1/models?capability=chat&x=1
  const req = { url: '/v1/models?capability=chat&x=1', headers: { 'x-aih-model-alias': 'a=b' } };
  const rewritten = rewrite(req, '/v1/models');
  assert.equal(rewritten.url, '/v1/models?capability=chat&x=1');
  assert.deepEqual(rewritten.headers, { 'x-aih-model-alias': 'a=b' });
  // 不改原对象：下游可能还在用同一个 req
  assert.equal(req.url, '/v1/models?capability=chat&x=1');

  // 没有 query 时不凭空补一个 '?'
  assert.equal(rewrite({ url: '/v1/models' }, '/v1/models').url, '/v1/models');

  // 多个 '?' 只按第一个切：后面整段都算 query（值里带 '?' 不能丢）
  assert.equal(rewrite({ url: '/v1/models?a=1?b=2' }, '/v1/m').url, '/v1/m?a=1?b=2');

  // 真机形态：带前缀的原始 URL → 剥前缀后 query 跟着新路径
  const prefix = buildSessionModelAliasPathPrefix({ source: 'a', target: 'b' });
  const split = splitSessionModelAliasPath(`${prefix}/v1beta/models`);
  const live = rewrite({ url: `${prefix}/v1beta/models?alt=sse` }, split.pathname);
  assert.equal(live.url, '/v1beta/models?alt=sse');

  // 兜底：非对象 req 原样返回；空 pathname 折成 '/'
  assert.equal(rewrite(null, '/x'), null);
  assert.equal(rewrite({ url: '/x' }, '').url, '/');
  assert.deepEqual(rewrite({ url: '/x' }, '/y').headers, {});
});

test('网关入口：前缀在 /v1 判断之前剥掉，请求照样进入路由', async () => {
  const { handleV1Request } = require('../lib/server/v1-router');
  const prefix = buildSessionModelAliasPathPrefix({ source: 'a', target: 'b' });
  const ctx = (pathname) => ({
    req: { headers: {}, url: pathname },
    res: {},
    method: 'GET',
    pathname,
    options: {},
    state: {},
    requiredClientKey: '',
    cooldownMs: 0,
    maxRequestBodyBytes: 1024,
    requestMeta: {},
    deps: {}
  });
  // 非 /v1 路径交还调用方（这里就是 404 的来源）。
  assert.equal(await handleV1Request(ctx('/-/ma/nope')), false);
  // 带前缀的 /v1 路径必须被当成 /v1 处理：依赖缺失时报的是下游错误，而不是「不是 v1」。
  const outcome = await handleV1Request(ctx(`${prefix}/v1/models`)).then(
    (returned) => ({ returned }),
    (error) => ({ error })
  );
  assert.notEqual(outcome.returned, false);
});

test('harness：--model-alias 被摘出来，不当原生参数透传', () => {
  const parsed = parseHarnessArgs(['pi', '--provider', 'codex', '--model', 'A', '--model-alias', 'B', '--', '--verbose']);
  assert.equal(parsed.model, 'A');
  assert.equal(parsed.modelAlias, 'B');
  assert.deepEqual(parsed.nativeArgs, ['--verbose']);
});

test('harness：规则在启动期落地成目标模型（会话内不换模型，结果等价）', () => {
  assert.deepEqual(
    resolveHarnessAliasLaunchModel({ model: 'A', modelAlias: 'B' }),
    { ok: true, model: 'B', rule: { source: 'A', target: 'B' } }
  );
  // 没给 --model = 通配规则，同样直接按目标启动。
  assert.equal(resolveHarnessAliasLaunchModel({ model: '', modelAlias: 'B' }).model, 'B');
  assert.equal(resolveHarnessAliasLaunchModel({ model: 'A', modelAlias: '' }).model, 'A');
  assert.deepEqual(resolveHarnessAliasLaunchModel({ model: 'A', modelAlias: 'x=' }), {
    ok: false, reason: 'model_alias_value_invalid'
  });
});

test('opencode：网关 profile 的 base URL 带上规则前缀（这个地址确定是网关）', () => {
  const baseEnv = {
    AIH_OPENCODE_GATEWAY: `baseUrl=${encodeURIComponent('https://gw.example.com/v1')},apiKey=k`,
    AIH_MODEL_ALIAS: 'modelA=modelB'
  };
  const profile = resolveGatewayProfile({ baseEnv });
  assert.match(profile.baseUrl, /^https:\/\/gw\.example\.com\/-\/ma\/[A-Za-z0-9_-]+\/v1$/);
  assert.equal(profile.isExplicitServerProfile, true);
  // 没有规则：base URL 原样，不给自己加负担。
  const plain = resolveGatewayProfile({ baseEnv: { ...baseEnv, AIH_MODEL_ALIAS: '' } });
  assert.equal(plain.baseUrl, 'https://gw.example.com/v1');
});

test('claude：规则进 ANTHROPIC_CUSTOM_HEADERS，并要求 Node 处理', () => {
  const env = buildProviderRuntimeEnv('claude', '/tmp', {}, {
    accountEnv: { AIH_MODEL_ALIAS: 'modelA=modelB' },
    accountRef: 'acct_test'
  });
  const headers = String(env.ANTHROPIC_CUSTOM_HEADERS || '');
  assert.ok(headers.includes('x-aih-model-alias: modelA=modelB'));
  assert.ok(headers.includes('X-Aih-Route-Owner: node'));
});


// ---- Go Core：带会话级规则的请求必须留在 Node ----
//
// 这条守卫的是真实故障：/v1/responses 等推理入口已划给 Go Core，而 Go 不认
// x-aih-model-alias（转发器会把它摘掉）。Node 的转发前判定以前只看长期别名表，
// 于是带会话级规则的请求被原样转给 Go，规则在启动期就「消失」了。

test('Go Core 交还：带 x-aih-model-alias 的请求留在 Node（不看钉选与模型）', () => {
  const decision = explainGoRouteDeferral({
    entryId: 'gateway.openai.responses',
    model: 'gpt-6.1-sol',
    sessionModelAlias: 'gpt-6.1-sol=gemini-3.8-flash-high',
    state: { accounts: {} }
  });
  assert.deepEqual(decision, { defer: true, reason: 'session_model_alias' });
  // 规则只属于本次会话，和有没有钉选账号无关。
  const pinned = explainGoRouteDeferral({
    entryId: 'gateway.openai.responses',
    model: 'gpt-6.1-sol',
    pinnedAccountRef: 'acct_c016fd7eee0f64163068',
    sessionModelAlias: '*=gemini-3.8-flash-high',
    state: { accounts: {} }
  });
  assert.deepEqual(pinned, { defer: true, reason: 'session_model_alias' });
});

test('Go Core 交还：非法规则不冒充会话级规则（交给既有的保守判定）', () => {
  const decision = explainGoRouteDeferral({
    entryId: 'gateway.openai.responses',
    model: 'gpt-6.1-sol',
    // 缺 target：parseSessionModelAliasSpec 返回 null，规则头本身不会生效。
    sessionModelAlias: 'gpt-6.1-sol=',
    state: { accounts: {} }
  });
  assert.notEqual(decision.reason, 'session_model_alias');
});

test('Go Core 交还：原因名登记在 /readyz 的固定原因表里', () => {
  assert.ok(NODE_FALLBACK_REASONS.includes('session_model_alias'));
});

function responseRouteTable() {
  return [{
    entryId: 'gateway.openai.responses',
    transport: 'http',
    methods: ['POST'],
    regex: /^\/v1\/responses$/,
    literalLength: '/v1/responses'.length
  }];
}

test('转发器：把规则头原样交给宿主判定（HTTP 与 WebSocket 握手）', async () => {
  const seen = [];
  const forwarder = createGoCoreGatewayForwarder({
    routeTable: responseRouteTable(),
    entryIds: new Set(['gateway.openai.responses']),
    needsRequestModel: () => false,
    deferToNode: (input) => { seen.push(input); return true; }
  });
  const headers = {
    'x-aih-model-alias': 'gpt-6.1-sol=gemini-3.8-flash-high',
    'x-accounT-ref': 'acct_test'
  };

  const req = Object.assign(new EventEmitter(), {
    method: 'POST',
    url: '/v1/responses',
    headers
  });
  const handled = await forwarder.tryHandleHttp(req, {}, { method: 'POST', pathname: '/v1/responses' });
  // 交还 Node = 不从转发器返回（由调用方继续走 Node 路由）。
  assert.equal(handled, false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sessionModelAlias, 'gpt-6.1-sol=gemini-3.8-flash-high');
  assert.equal(seen[0].entryId, 'gateway.openai.responses');

  const upgradeSeen = [];
  const wsForwarder = createGoCoreGatewayForwarder({
    routeTable: [{ ...responseRouteTable()[0], transport: 'websocket' }],
    entryIds: new Set(['gateway.openai.responses']),
    deferToNode: (input) => { upgradeSeen.push(input); return true; }
  });
  const upgradeReq = Object.assign(new EventEmitter(), {
    method: 'GET',
    url: '/v1/responses',
    headers
  });
  const handledUpgrade = wsForwarder.tryHandleUpgrade(upgradeReq, { on() {}, destroy() {} }, Buffer.alloc(0), { pathname: '/v1/responses' });
  assert.equal(handledUpgrade, false);
  assert.equal(upgradeSeen.length, 1);
  assert.equal(upgradeSeen[0].transport, 'websocket');
  assert.equal(upgradeSeen[0].sessionModelAlias, 'gpt-6.1-sol=gemini-3.8-flash-high');
});

test('codex WS：命中会话级规则的模型改走网关 HTTP 管线', () => {
  const base = (model) => model === 'gpt-6.1-sol';
  const routes = createRoutesElsewhere(base, { source: 'gpt-6.1-sol', target: 'gemini-3.8-flash-high' });
  // 命中规则：哪怕 base 认为这是 Codex 原生模型，也必须交给 HTTP 管线改写。
  assert.equal(routes('gpt-6.1-sol'), true);
  // 不命中：保持原有判定。
  assert.equal(routes('gpt-6.1-astra'), false);
  assert.equal(routes('gemini-3.8-flash-high'), false);
  // 通配规则命中任意模型。
  assert.equal(createRoutesElsewhere(() => false, { source: '*', target: 'x' })('anything'), true);
  // 没有规则时行为完全不变（返回原函数本体）。
  assert.equal(createRoutesElsewhere(base, null), base);
});

// ---- 目标命名空间：provider / 账号 ----
//
// 模型名被多家共持（glm-5 同时在 zcode 与 kiro 名下），光给模型名会落到错误的 Provider。
// `kiro.glm-5` / `kiro.1.glm-5` 把 Provider 与 CLI 账号编号一起钉住。

test('目标命名空间：provider / 账号 / 裸模型名互不混淆', () => {
  assert.deepEqual(
    parseSessionModelAliasSpec('kiro.glm-5'),
    { source: '*', target: 'glm-5', provider: 'kiro' }
  );
  assert.deepEqual(
    parseSessionModelAliasSpec('kiro.1.glm-5'),
    { source: '*', target: 'glm-5', provider: 'kiro', account: '1' }
  );
  assert.deepEqual(
    parseSessionModelAliasSpec('gpt-6.1-sol=kiro.1.glm-5'),
    { source: 'gpt-6.1-sol', target: 'glm-5', provider: 'kiro', account: '1' }
  );
  // 持久 accountRef 写法。
  const ref = 'acct_0123456789abcdef0123';
  assert.deepEqual(
    parseSessionModelAliasSpec(`kiro.${ref}.glm-5`),
    { source: '*', target: 'glm-5', provider: 'kiro', account: ref }
  );
  // 模型名带点但首段不是已注册 Provider：整体仍是模型名。
  assert.deepEqual(parseSessionModelAliasSpec('gemini-2.5-pro'), { source: '*', target: 'gemini-2.5-pro' });
  assert.deepEqual(parseSessionModelAliasSpec('gpt-5.1-codex'), { source: '*', target: 'gpt-5.1-codex' });
  assert.deepEqual(parseSessionModelAliasSpec('nope.glm-5'), { source: '*', target: 'nope.glm-5' });
  // 带点的裸模型在 provider 命名空间下也完整保留。
  assert.deepEqual(
    parseSessionModelAliasSpec('zcode.glm-5.3'),
    { source: '*', target: 'glm-5.3', provider: 'zcode' }
  );
});

test('目标命名空间：编码回原串（头与路径前缀两条通道共用）', () => {
  for (const spec of ['*=kiro.glm-5', '*=kiro.1.glm-5', 'a=kiro.glm-5.3', '*=glm-5']) {
    assert.equal(encodeSessionModelAlias(parseSessionModelAliasSpec(spec)), spec);
  }
  // 路径前缀 token 同样能往返。
  const rule = parseSessionModelAliasSpec('kiro.2.glm-5');
  const split = splitSessionModelAliasPath(`${buildSessionModelAliasPathPrefix(rule)}/v1/responses`);
  assert.deepEqual(split.rule, rule);
  assert.equal(split.pathname, '/v1/responses');
});

test('目标命名空间：--model-alias 的规则带着 provider / 账号一起走', () => {
  assert.deepEqual(
    buildSessionModelAliasRule({ model: 'gpt-6.1-sol', alias: 'kiro.glm-5' }),
    { source: 'gpt-6.1-sol', target: 'glm-5', provider: 'kiro' }
  );
  assert.deepEqual(
    buildSessionModelAliasRule({ model: '', alias: 'kiro.1.glm-5' }),
    { source: '*', target: 'glm-5', provider: 'kiro', account: '1' }
  );
  // 显式 source=target 仍然以写出来的 source 为准。
  assert.deepEqual(
    buildSessionModelAliasRule({ model: 'ignored', alias: 'A=kiro.glm-5' }),
    { source: 'A', target: 'glm-5', provider: 'kiro' }
  );
});

test('目标命名空间：请求体只写裸模型名（provider 不进模型字段）', () => {
  const rule = parseSessionModelAliasSpec('kiro.1.glm-5');
  const applied = applySessionModelAlias({ rule, requestJson: { model: 'gpt-6.1-sol' } });
  assert.equal(applied.changed, true);
  assert.equal(applied.requestJson.model, 'glm-5');
});

test('路由钉选：CLI 账号编号 → 持久 accountRef；解析不到就报错', () => {
  const os = require('node:os');
  const fsImpl = require('node:fs');
  const nodePath = require('node:path');
  const { upsertAccountRef, getPublicAccountRef } = require('../lib/server/account-ref-store');
  const { resolveSessionModelAliasPin } = require('../lib/server/session-model-alias-routing');
  const home = fsImpl.mkdtempSync(nodePath.join(os.tmpdir(), 'aih-alias-pin-'));
  try {
    const expectedRef = getPublicAccountRef('unique:kiro-account-1');
    upsertAccountRef(fsImpl, home, { provider: 'kiro', cliAccountId: '1', identitySeed: 'kiro-account-1' });

    const pin = resolveSessionModelAliasPin({ rule: { provider: 'kiro', account: '1' }, fs: fsImpl, aiHomeDir: home });
    assert.deepEqual(pin, { provider: 'kiro', accountRef: expectedRef });

    // 只钉 provider：不带账号。
    assert.deepEqual(
      resolveSessionModelAliasPin({ rule: { provider: 'kiro' }, fs: fsImpl, aiHomeDir: home }),
      { provider: 'kiro', accountRef: '' }
    );
    // 没有命名空间：什么都不钉（行为与以前一致）。
    assert.equal(resolveSessionModelAliasPin({ rule: { target: 'glm-5' }, fs: fsImpl, aiHomeDir: home }), null);

    // 账号不存在：明确报错，绝不悄悄换号。
    assert.deepEqual(
      resolveSessionModelAliasPin({ rule: { provider: 'kiro', account: '9' }, fs: fsImpl, aiHomeDir: home }),
      { provider: 'kiro', accountRef: '', account: '9', error: 'model_alias_account_not_found' }
    );

    // 直接给 accountRef 时不再查库。
    assert.deepEqual(
      resolveSessionModelAliasPin({ rule: { provider: 'kiro', account: expectedRef }, fs: fsImpl, aiHomeDir: home }),
      { provider: 'kiro', accountRef: expectedRef }
    );
  } finally {
    fsImpl.rmSync(home, { recursive: true, force: true });
  }
});

test('端到端：--model-alias kiro.glm-5 把请求钉到 kiro（x-provider 通道）', async () => {
  const { seen } = await runRouterOnce({
    pathname: '/v1/chat/completions',
    headers: { 'x-aih-model-alias': 'kiro.glm-5' },
    body: { model: 'gpt-6.1-sol', messages: [] }
  });
  assert.equal(seen.length, 1);
  const [, requestJson, downstreamHeaders] = seen[0];
  assert.equal(requestJson.model, 'glm-5');
  assert.equal(downstreamHeaders['x-provider'], 'kiro');
  // 没指定账号：不产生钉选头，仍由该 Provider 的池子选号。
  assert.equal(downstreamHeaders['x-account-ref'], undefined);
});

test('端到端：--model-alias kiro.1.glm-5 钉到该 Provider 的 1 号账号', async () => {
  const os = require('node:os');
  const fsImpl = require('node:fs');
  const nodePath = require('node:path');
  const { upsertAccountRef, getPublicAccountRef } = require('../lib/server/account-ref-store');
  const home = fsImpl.mkdtempSync(nodePath.join(os.tmpdir(), 'aih-alias-e2e-'));
  try {
    const accountRef = getPublicAccountRef('unique:kiro-e2e-1');
    upsertAccountRef(fsImpl, home, { provider: 'kiro', cliAccountId: '1', identitySeed: 'kiro-e2e-1' });
    const { seen } = await runRouterOnce({
      pathname: '/v1/chat/completions',
      headers: { 'x-aih-model-alias': 'kiro.1.glm-5' },
      body: { model: 'gpt-6.1-sol', messages: [] },
      aiHomeDir: home,
      accounts: { kiro: [{ accountRef, provider: 'kiro', status: 'up', accessToken: 't' }] }
    });
    assert.equal(seen.length, 1);
    const [, requestJson, downstreamHeaders] = seen[0];
    assert.equal(requestJson.model, 'glm-5');
    assert.equal(downstreamHeaders['x-provider'], 'kiro');
    assert.equal(downstreamHeaders['x-account-ref'], accountRef);
  } finally {
    fsImpl.rmSync(home, { recursive: true, force: true });
  }
});

test('端到端：指定了不存在的账号时明确 400，不悄悄换号', async () => {
  const { handleV1Request } = require('../lib/server/v1-router');
  const writes = [];
  const res = { setHeader() {}, end() {}, writeHead() {}, on() {}, once() {} };
  const ctx = {
    req: { headers: { 'content-type': 'application/json', 'x-aih-model-alias': 'kiro.9.glm-5' }, url: '/v1/chat/completions', on() {}, once() {} },
    res,
    method: 'POST',
    pathname: '/v1/chat/completions',
    options: {},
    state: { accounts: {}, metrics: {} },
    requiredClientKey: '',
    cooldownMs: 0,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (_res, status, payload) => { writes.push({ status, payload }); },
      readRequestBody: async () => Buffer.from(JSON.stringify({ model: 'gpt-6.1-sol', messages: [] })),
      resolveRequestProvider: () => { throw new Error('should not route'); },
      chooseServerAccount: () => null,
      markProxyAccountSuccess() {}, markProxyAccountFailure() {}, pushMetricError() {},
      appendProxyRequestLog() {}, recordModelUsage() {},
      handleUpstreamModels: async () => false,
      handleUpstreamPassthrough: async () => false,
      handleCodexModels: async () => false,
      handleCodexChatCompletions: async () => false,
      handleImageGenerations: async () => false,
      fetchModelsForAccount: async () => [],
      FALLBACK_MODELS: [],
      fetchWithTimeout: async () => { throw new Error('no network'); },
      accountStateIndex: {},
      fs: require('node:fs'),
      aiHomeDir: '/tmp/aih-nonexistent',
      pushModelCatalogProjection() {}
    }
  };
  const log = console.log;
  console.log = () => {};
  try {
    const handled = await handleV1Request(ctx);
    assert.equal(handled, true);
  } finally {
    console.log = log;
  }
  assert.equal(writes.length, 1);
  assert.equal(writes[0].status, 400);
  assert.equal(writes[0].payload.error, 'model_alias_account_not_found');
});
