'use strict';

// 端到端：`--model-alias claude.<model>` + 会话级协议提示，真的改变上游 URL 与请求体。
//
// 这条守的是接线，不是判定：
//   - 带 x-aih-upstream-protocol 时，codex 的 /v1/responses 必须被改写成 OpenAI Chat
//     Completions，发到厂商的 OpenAI 基址（而不是 Anthropic 兼容层）；
//   - 不带提示时仍走原来的 Anthropic Messages 回落，证明切换是提示驱动的；
//   - 提示头不会透传到上游。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handleV1Request } = require('../lib/server/v1-router');
const { handleUpstreamPassthrough } = require('../lib/server/upstream-endpoints');
const { fetchWithTimeout } = require('../lib/server/http-utils');

const ACCOUNT_REF = 'acct_aaaaaaaaaaaaaaaaaaaa';
const OFFICIAL_ACCOUNT_REF = 'acct_bbbbbbbbbbbbbbbbbbbb';

function createAccount(overrides = {}) {
  return {
    accountRef: ACCOUNT_REF,
    provider: 'claude',
    accessToken: 'sk-test-key',
    apiKeyMode: true,
    authType: 'api-key',
    baseUrl: 'https://api.deepseek.com/anthropic',
    availableModels: ['deepseek-flash'],
    status: 'up',
    cooldownUntil: 0,
    consecutiveFailures: 0,
    successCount: 0,
    failCount: 0,
    lastError: '',
    ...overrides
  };
}

function createOfficialAccount() {
  return createAccount({
    accountRef: OFFICIAL_ACCOUNT_REF,
    accessToken: 'sk-ant-official',
    baseUrl: 'https://api.anthropic.com'
  });
}

function createState(accounts = [createAccount()]) {
  return {
    accounts: { claude: accounts },
    metrics: {},
    strategy: 'random',
    cursors: {},
    sessionAffinity: {},
    modelAccountIndex: {
      builtAt: 0,
      accountToModels: new Map(),
      accountByRef: new Map()
    }
  };
}

function chatChunks(events) {
  return events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').concat('data: [DONE]\n\n');
}

function sseResponse(chunks = chatChunks([
  {
    id: 'x',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'deepseek-flash',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }]
  },
  {
    id: 'x',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'deepseek-flash',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
  }
])) {
  const stream = new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(new TextEncoder().encode(chunk)));
      controller.close();
    }
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
}

async function runRouterOnce(input) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-protocol-gateway-'));
  const seen = { url: '', headers: null, body: '' };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.url = String(url);
    seen.headers = init && init.headers || {};
    seen.body = String(init && init.body || '');
    return sseResponse(input.upstreamChunks);
  };
  const writes = [];
  let output = '';
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(key, value) { this.headers[String(key).toLowerCase()] = value; },
    writeHead(statusCode, headers) { this.statusCode = statusCode; Object.assign(this.headers, headers || {}); },
    flushHeaders() {},
    write(chunk) { output += String(chunk || ''); return true; },
    end(chunk) { if (chunk) output += String(chunk); this.writableEnded = true; },
    on() {},
    once() {}
  };
  const deps = {
    parseAuthorizationBearer: () => '',
    writeJson: (_res, status, payload) => { writes.push({ status, payload }); },
    readRequestBody: async () => Buffer.from(JSON.stringify(input.requestBody || {
      model: 'ignored',
      input: [{ role: 'user', content: 'hi' }],
      stream: true
    })),
    resolveRequestProvider: () => '',
    chooseServerAccount: (pool) => pool[0],
    markProxyAccountSuccess() {},
    markProxyAccountFailure() {},
    pushMetricError() {},
    appendProxyRequestLog() {},
    recordModelUsage() {},
    accountActivity: { begin() {}, end() {} },
    handleUpstreamModels: async () => false,
    handleUpstreamPassthrough,
    handleCodexModels: async () => false,
    handleCodexChatCompletions: async () => false,
    handleImageGenerations: async () => false,
    fetchWithTimeout,
    FALLBACK_MODELS: [],
    accountStateIndex: {},
    fs,
    aiHomeDir: home,
    providerSessionStateStore: {},
    refreshCodexAccessToken: async () => {},
    refreshClaudeAccessToken: async () => {},
    refreshAgyAccessToken: async () => {},
    refreshKimiAccessToken: async () => {},
    resolveAccountEgressRequestOptions: async (options) => ({
      ok: true,
      options: options.options,
      egress: { source: 'direct' }
    }),
    pushModelCatalogProjection() {}
  };
  const headers = {
    'content-type': 'application/json',
    'x-aih-model-alias': '*=claude.deepseek-flash',
    ...(input.protocol ? { 'x-aih-upstream-protocol': input.protocol } : {})
  };
  const ctx = {
    req: { headers, url: '/v1/responses', on() {}, once() {} },
    res,
    method: 'POST',
    pathname: '/v1/responses',
    options: {
      backend: 'codex-adapter',
      upstreamTimeoutMs: 5000,
      port: 1,
      logRequests: false,
      maxAttempts: 1
    },
    state: createState(input.accounts),
    requiredClientKey: '',
    cooldownMs: 0,
    maxRequestBodyBytes: 1024 * 1024,
    requestMeta: {},
    deps
  };
  const log = console.log;
  console.log = () => {};
  try {
    await handleV1Request(ctx);
  } finally {
    console.log = log;
    globalThis.fetch = originalFetch;
    fs.rmSync(home, { recursive: true, force: true });
  }
  return { seen, writes, output, headers: res.headers };
}

test('自动适配：Responses 请求按 OpenAI Chat 发到厂商的 OpenAI 基址', async () => {
  const { seen, output } = await runRouterOnce({ protocol: 'openai_chat' });
  assert.equal(seen.url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(seen.headers.authorization, 'Bearer sk-test-key');
  const body = JSON.parse(seen.body);
  assert.equal(body.model, 'deepseek-flash');
  assert.ok(Array.isArray(body.messages), '应转换成 Chat Completions 的 messages 形状');
  assert.equal(body.input, undefined, '不应把 Responses 的 input 原样发出去');
  assert.equal(seen.headers['x-aih-upstream-protocol'], undefined, '提示头不能透传上游');
  // 回程必须真的转成 Responses 事件，而不是走 Anthropic 解析器（那会丢正文/报
  // stream_incomplete）。
  assert.match(output, /"delta":"hello"/);
  assert.match(output, /"type":"response\.completed"/);
});

test('没有提示时保持原有 Anthropic 回落', async () => {
  const { seen } = await runRouterOnce({});
  assert.equal(seen.url, 'https://api.deepseek.com/anthropic/v1/messages');
  const body = JSON.parse(seen.body);
  assert.ok(Array.isArray(body.messages), 'Anthropic Messages 同样有 messages');
  assert.equal(body.max_tokens !== undefined, true);
  assert.equal(body.model, 'deepseek-flash');
});

test('协议提示只选能用 OpenAI 端点的账号：官方 Anthropic 账号必须被过滤', async () => {
  // 官方账号放在池首：若少了协议过滤，chooseServerAccount 会先选它，URL 变成
  // https://api.anthropic.com/v1/chat/completions（OpenAI 请求体打 Anthropic 端点）。
  const { seen } = await runRouterOnce({
    protocol: 'openai_chat',
    accounts: [createOfficialAccount(), createAccount()]
  });
  assert.equal(seen.url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(seen.headers.authorization, 'Bearer sk-test-key');
});

test('工具调用回程转成 function_call，不出现 DSML 文本', async () => {
  const toolChunks = chatChunks([
    {
      id: 'x',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'deepseek-flash',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'exec', arguments: '{"cmd":"pwd"}' }
          }]
        },
        finish_reason: null
      }]
    },
    {
      id: 'x',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'deepseek-flash',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
    }
  ]);
  const { seen, output } = await runRouterOnce({
    protocol: 'openai_chat',
    upstreamChunks: toolChunks,
    requestBody: {
      model: 'ignored',
      input: 'run pwd',
      stream: true,
      tools: [{
        type: 'function',
        name: 'exec',
        description: 'run a command',
        parameters: {
          type: 'object',
          properties: { cmd: { type: 'string' } },
          required: ['cmd']
        }
      }]
    }
  });
  // 请求侧：Responses 的 tools 必须转成 Chat Completions 的 tools。
  const upstreamBody = JSON.parse(seen.body);
  assert.equal(upstreamBody.tools[0].type, 'function');
  assert.equal(upstreamBody.tools[0].function.name, 'exec');
  // 回程侧：tool_calls 必须变成 Responses 的 function_call，而不是正文里的文本标记。
  assert.match(output, /"type":"function_call"/);
  assert.match(output, /"name":"exec"/);
  assert.match(output, /pwd/);
  assert.equal(/DSML/i.test(output), false);
  assert.equal(/response\.failed/.test(output), false);
});
