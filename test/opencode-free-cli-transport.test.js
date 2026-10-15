'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { test } = require('node:test');

const {
  bareOpenCodeModelId,
  buildOpenCodeCliPrompt,
  buildRelayConfigContent,
  buildRelayEnv,
  fetchOpenCodeFreeCliChatCompletion,
  fetchOpenCodeFreeCliChatCompletionStream,
  isOpenCodeFreeModelId,
  mapFinishReason,
  supportsOpenCodeFreeCliTransport,
  __private
} = require('../lib/server/opencode-free-cli-transport');
const { openCodeFreeCliTransport } = require('../lib/server/upstream-endpoints-transport-opencode-free-cli');
const { runTransportChain } = require('../lib/server/upstream-endpoints-transport-chain');
const { classifyUpstreamFailure } = require('../lib/server/upstream-failure-policy');

const ACCOUNT = { provider: 'opencode', accountRef: 'acct_6019fcf2cb146ac5c19b' };
const FREE_MODEL = 'opencode/deepseek-v4.1-flash-free';

function fakeChild(lines, code = 0) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    written: '',
    write(chunk) { this.written += String(chunk); },
    end() {
      setImmediate(() => {
        for (const line of lines) child.stdout.emit('data', Buffer.from(`${line}\n`));
        child.emit('close', code);
      });
    }
  };
  child.kill = () => {};
  return child;
}

function makeDeps(lines, code = 0, overrides = {}) {
  const invocations = [];
  const fs = { mkdirSync() {} };
  return {
    invocations,
    aiHomeDir: '/tmp/aih-opencode-free-test',
    hostHomeDir: '/tmp',
    env: { OPENCODE_API_KEY: 'host-pollution', PATH: '/usr/bin' },
    fs,
    path,
    materializeProviderAuth: () => ({ materialized: 1, removed: 0, missing: false }),
    resolveProviderCliPath: () => '/usr/bin/opencode',
    spawn: (command, args, options) => {
      const child = fakeChild(lines, code);
      invocations.push({ command, args, options, child });
      return child;
    },
    ...overrides
  };
}

const OK_LINES = [
  '{"type":"step_start","timestamp":1,"sessionID":"ses_test_1","part":{"id":"prt_1","type":"step-start"}}',
  '{"type":"text","timestamp":2,"sessionID":"ses_test_1","part":{"id":"prt_2","type":"text","text":"po"}}',
  '{"type":"text","timestamp":3,"sessionID":"ses_test_1","part":{"id":"prt_2","type":"text","text":"pong"}}',
  '{"type":"step_finish","timestamp":4,"sessionID":"ses_test_1","part":{"id":"prt_3","reason":"stop","tokens":{"total":7829,"input":18,"output":3,"reasoning":0,"cache":{"write":0,"read":7808}}}}'
];

test('supportsOpenCodeFreeCliTransport gates opencode free models only', () => {
  assert.equal(supportsOpenCodeFreeCliTransport('opencode', FREE_MODEL), true);
  assert.equal(supportsOpenCodeFreeCliTransport('OPENCODE', 'deepseek-v4.1-flash-free'), true);
  assert.equal(supportsOpenCodeFreeCliTransport('opencode', 'zen/cat-jam-free'), true);
  assert.equal(supportsOpenCodeFreeCliTransport('opencode', 'opencode-go/step-5-preview-free'), true);
  // 付费模型继续走 HTTP 通道，绝不能被 CLI 通道截走。
  assert.equal(supportsOpenCodeFreeCliTransport('opencode', 'opencode/deepseek-v4.1-flash'), false);
  assert.equal(supportsOpenCodeFreeCliTransport('opencode', 'opencode-go/glm-5.2'), false);
  assert.equal(supportsOpenCodeFreeCliTransport('codex', FREE_MODEL), false);
  assert.equal(supportsOpenCodeFreeCliTransport(null, FREE_MODEL), false);
});

test('model id helpers strip every documented opencode prefix', () => {
  assert.equal(bareOpenCodeModelId('opencode-go/deepseek-v4-pro'), 'deepseek-v4-pro');
  assert.equal(bareOpenCodeModelId('opencode/deepseek-v4.1-flash-free'), 'deepseek-v4.1-flash-free');
  assert.equal(bareOpenCodeModelId('zen/cat-jam-free'), 'cat-jam-free');
  assert.equal(bareOpenCodeModelId('go/x-free'), 'x-free');
  assert.equal(bareOpenCodeModelId('deepseek-v4.1-flash-free'), 'deepseek-v4.1-flash-free');
  assert.equal(isOpenCodeFreeModelId(FREE_MODEL), true);
  assert.equal(isOpenCodeFreeModelId('opencode/mimo-v2.6-flash'), false);
});

test('buildRelayConfigContent declares the model and disables only side-effecting tools', () => {
  const parsed = JSON.parse(buildRelayConfigContent('deepseek-v4.1-flash-free'));
  const declared = parsed.provider.opencode.models['deepseek-v4.1-flash-free'];
  assert.equal(declared.id, 'deepseek-v4.1-flash-free');
  assert.equal(declared.tool_call, true);
  assert.equal(declared.limit.context, 200000);
  // 免费档门禁要求请求里必须带工具：不能整体清空工具面。
  assert.equal(parsed.tools.bash, false);
  assert.equal(parsed.tools.edit, false);
  assert.equal(parsed.tools.write, false);
  assert.equal(parsed.tools.task, false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.tools, 'read'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.tools, 'glob'), false);
});

test('buildRelayConfigContent merges an existing OPENCODE_CONFIG_CONTENT instead of clobbering it', () => {
  const parsed = JSON.parse(buildRelayConfigContent(
    'x-free',
    '{"theme":"dark","tools":{"read":false},"provider":{"other":{"models":{"m":{}}}}}'
  ));
  assert.equal(parsed.theme, 'dark');
  assert.equal(parsed.tools.read, false);
  assert.equal(parsed.tools.bash, false);
  assert.ok(parsed.provider.other.models.m);
  assert.ok(parsed.provider.opencode.models['x-free']);
});

test('buildOpenCodeCliPrompt flattens the transcript and keeps system instructions', () => {
  const prompt = buildOpenCodeCliPrompt({
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: [{ type: 'text', text: '回答一' }] }
    ]
  });
  assert.ok(prompt.includes('你是助手'));
  assert.ok(prompt.includes('User: 第一句'));
  assert.ok(prompt.includes('Assistant: 回答一'));
  assert.ok(prompt.endsWith('Assistant:'));
  assert.equal(buildOpenCodeCliPrompt({}), '');
  assert.equal(mapFinishReason('stop'), 'stop');
  assert.equal(mapFinishReason('length'), 'length');
  assert.equal(mapFinishReason('tool-calls'), 'tool_calls');
});

test('buildRelayEnv isolates HOME/XDG to the account projection and strips host pollution', () => {
  const env = buildRelayEnv(
    { proxyUrl: 'http://127.0.0.1:7890', noProxy: 'localhost' },
    { env: { OPENCODE_API_KEY: 'leak', OPENCODE_CONFIG_CONTENT: 'leak', PATH: '/usr/bin' } },
    '/tmp/aih/run/auth-projections/opencode/acct_1',
    '/tmp',
    path,
    '{"tools":{}}'
  );
  assert.equal(env.HOME, '/tmp/aih/run/auth-projections/opencode/acct_1');
  assert.equal(env.USERPROFILE, env.HOME);
  assert.equal(env.XDG_CONFIG_HOME, path.join(env.HOME, '.config'));
  assert.equal(env.XDG_DATA_HOME, path.join(env.HOME, '.local', 'share'));
  assert.equal(env.OPENCODE_CONFIG_CONTENT, '{"tools":{}}');
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'OPENCODE_API_KEY'), false);
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.equal(env.NO_PROXY, 'localhost');
  assert.equal(env.npm_config_cache, path.join('/tmp', '.npm'));
  // socks 代理在 Bun 侧直接 UnsupportedProxyProtocol：必须 fail closed，不能静默直连。
  assert.throws(
    () => buildRelayEnv({ proxyUrl: 'socks5://127.0.0.1:1080' }, { env: {} }, '/tmp/p', '/tmp', path, '{}'),
    (error) => error.code === 'opencode_free_cli_proxy_unsupported'
  );
});

test('runOpenCodeFreeCliTurn spawns the native CLI, streams deltas and maps usage', async () => {
  const deps = makeDeps(OK_LINES);
  const deltas = [];
  const result = await __private.runOpenCodeFreeCliTurn(
    { aiHomeDir: deps.aiHomeDir, hostHomeDir: '/tmp' },
    ACCOUNT,
    { model: FREE_MODEL, messages: [{ role: 'user', content: 'hi' }] },
    1000,
    deps,
    (delta) => deltas.push(delta)
  );
  assert.equal(result.content, 'pong');
  assert.equal(result.sessionId, 'ses_test_1');
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(result.usage, { prompt_tokens: 7826, completion_tokens: 3, total_tokens: 7829 });
  assert.deepEqual(deltas, ['po', 'ng']);

  const invocation = deps.invocations[0];
  assert.equal(invocation.command, '/usr/bin/opencode');
  assert.deepEqual(invocation.args.slice(0, 4), ['run', '--format', 'json', '--dangerously-skip-permissions']);
  const modelIndex = invocation.args.indexOf('--model');
  assert.equal(invocation.args[modelIndex + 1], 'opencode/deepseek-v4.1-flash-free');
  const dirIndex = invocation.args.indexOf('--dir');
  assert.ok(String(invocation.args[dirIndex + 1]).includes('opencode-free-relay'));
  // 提示词走 stdin（Windows argv 有 32K 上限）。
  assert.ok(invocation.child.stdin.written.includes('User: hi'));
  const env = invocation.options.env;
  assert.ok(String(env.HOME).includes('auth-projections'));
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'OPENCODE_API_KEY'), false);
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.ok(config.provider.opencode.models['deepseek-v4.1-flash-free']);
  assert.equal(config.tools.bash, false);
});


test('runOpenCodeFreeCliTurn surfaces the FreeTierError gate as a coded upstream error', async () => {
  const deps = makeDeps([
    '{"type":"error","timestamp":1,"sessionID":"ses_x","error":{"name":"APIError","data":{"message":"OpenCode\'s free tier can only be used from within OpenCode.","statusCode":403}}}'
  ]);
  await assert.rejects(
    __private.runOpenCodeFreeCliTurn({}, ACCOUNT, { model: FREE_MODEL, messages: [{ role: 'user', content: 'hi' }] }, 1000, deps),
    (error) => error.code === 'opencode_free_cli_upstream_error'
      && /free tier can only be used from within OpenCode/i.test(error.message)
  );
});

test('runOpenCodeFreeCliTurn rejects non-zero exit without content and missing auth', async () => {
  await assert.rejects(
    __private.runOpenCodeFreeCliTurn({}, ACCOUNT, { model: FREE_MODEL, messages: [{ role: 'user', content: 'hi' }] }, 1000, makeDeps([], 1)),
    (error) => error.code === 'opencode_free_cli_exit_nonzero'
  );
  await assert.rejects(
    __private.runOpenCodeFreeCliTurn({}, ACCOUNT, { model: FREE_MODEL, messages: [{ role: 'user', content: 'hi' }] }, 1000,
      makeDeps(OK_LINES, 0, { materializeProviderAuth: () => ({ materialized: 0, removed: 0, missing: true }) })),
    (error) => error.code === 'opencode_free_cli_auth_missing'
  );
  await assert.rejects(
    __private.runOpenCodeFreeCliTurn({}, ACCOUNT, { model: 'opencode/deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] }, 1000, makeDeps(OK_LINES)),
    (error) => error.code === 'opencode_free_cli_unsupported_model'
  );
});

test('fetchOpenCodeFreeCliChatCompletion returns an OpenAI chat completion payload', async () => {
  const deps = makeDeps(OK_LINES);
  const payload = await fetchOpenCodeFreeCliChatCompletion({}, ACCOUNT, { model: FREE_MODEL, messages: [{ role: 'user', content: 'hi' }] }, 1000, deps);
  assert.equal(payload.object, 'chat.completion');
  assert.equal(payload.model, FREE_MODEL);
  assert.equal(payload.choices[0].message.role, 'assistant');
  assert.equal(payload.choices[0].message.content, 'pong');
  assert.equal(payload.choices[0].finish_reason, 'stop');
  assert.deepEqual(payload.usage, { prompt_tokens: 7826, completion_tokens: 3, total_tokens: 7829 });
  assert.equal(payload.session_id, 'ses_test_1');
});

test('fetchOpenCodeFreeCliChatCompletionStream emits OpenAI SSE chunks live', async () => {
  const deps = makeDeps(OK_LINES);
  const upstream = await fetchOpenCodeFreeCliChatCompletionStream({}, ACCOUNT, { model: FREE_MODEL, messages: [{ role: 'user', content: 'hi' }] }, 1000, deps);
  assert.equal(upstream.ok, true);
  const text = await new Promise((resolve, reject) => {
    let buf = '';
    upstream.body.on('data', (chunk) => { buf += chunk.toString('utf8'); });
    upstream.body.on('end', () => resolve(buf));
    upstream.body.on('error', reject);
  });
  const frames = text.split('\n\n').filter(Boolean);
  assert.match(frames[0], /"role":"assistant"/);
  assert.match(frames[1], /"content":"po"/);
  assert.match(frames[2], /"content":"ng"/);
  assert.match(frames[3], /"finish_reason":"stop"/);
  assert.match(frames[3], /"usage":\{"prompt_tokens":7826/);
  assert.equal(frames[4], 'data: [DONE]');
});


test('openCodeFreeCliTransport matches free models only and dispatches through the chain', async () => {
  assert.equal(openCodeFreeCliTransport.matches({ provider: 'opencode', requestJson: { model: FREE_MODEL } }), true);
  assert.equal(openCodeFreeCliTransport.matches({ provider: 'opencode', requestJson: { model: 'opencode/glm-5.2' } }), false);
  assert.equal(openCodeFreeCliTransport.matches({ provider: 'codex', requestJson: { model: FREE_MODEL } }), false);
  assert.equal(openCodeFreeCliTransport.matches(null), false);

  const sent = { headers: {}, body: '' };
  const res = {
    statusCode: 0,
    setHeader(key, value) { sent.headers[key] = value; },
    end(body) { sent.body = body ? body.toString() : ''; },
    write(chunk) { sent.body += chunk.toString(); },
    get headersSent() { return true; },
    get writableEnded() { return false; }
  };
  const deps = makeDeps(OK_LINES);
  const action = await runTransportChain({
    options: {},
    res,
    requestJson: { model: FREE_MODEL, messages: [{ role: 'user', content: 'hi' }] },
    provider: 'opencode',
    streamRequested: false,
    requestMeta: {},
    state: { metrics: { providerFailures: {} } },
    deps: {
      fetchOpenCodeFreeCliChatCompletion: (options, account, requestJson, timeoutMs) =>
        fetchOpenCodeFreeCliChatCompletion(options, account, requestJson, timeoutMs, deps)
    },
    recordAccountSuccess: () => {},
    recordAccountFailure: () => {},
    recordModelUsage: () => {},
    appendProxyRequestLog: () => {},
    diagnosticMaxAttempts: () => 1,
    control: { attempt: 0, setLastError() {} },
    account: ACCOUNT,
    attemptUpstreamTimeoutMs: 1000,
    attemptMutable: {}
  }, [openCodeFreeCliTransport]);
  assert.deepEqual(action, { action: 'return' });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(sent.body).choices[0].message.content, 'pong');
  assert.equal(sent.headers['x-aih-server-account-ref'], ACCOUNT.accountRef);
});

test('upstream failure policy: FreeTierError never locks the account for a year', () => {
  const httpPolicy = classifyUpstreamFailure({
    provider: 'opencode',
    account: { apiKeyMode: false, authType: 'opencode-auth' },
    statusCode: 403,
    detail: 'HTTP 403 {"error":{"type":"FreeTierError","message":"free tier can only be used from within OpenCode"}}'
  });
  assert.notEqual(httpPolicy.kind, 'auth_invalid');
  assert.equal(httpPolicy.shouldMarkFailure, false);
  assert.equal(httpPolicy.cooldownMs, 0);
  assert.equal(httpPolicy.shouldRetryAnotherAccount, false);
  assert.equal(httpPolicy.clientStatusCode, 403);
  assert.match(httpPolicy.detail, /免费模型/);

  // CLI 通道把同一门禁作为事件文本透出（statusCode 0）：同样不能按 unknown_error 记账。
  const cliPolicy = classifyUpstreamFailure({
    provider: 'opencode',
    statusCode: 0,
    error: new Error("OpenCode's free tier can only be used from within OpenCode.")
  });
  assert.equal(cliPolicy.failureReason, 'opencode_free_tier_client_gated');
  assert.equal(cliPolicy.shouldMarkFailure, false);
  assert.equal(cliPolicy.cooldownMs, 0);
});

