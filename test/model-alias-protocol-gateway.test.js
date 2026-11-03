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

function createAccount() {
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
    lastError: ''
  };
}

function createState() {
  return {
    accounts: { claude: [createAccount()] },
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

function sseResponse() {
  const chunks = [
    'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"deepseek-flash","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}\n\n',
    'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"deepseek-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n'
  ];
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
    return sseResponse();
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
    readRequestBody: async () => Buffer.from(JSON.stringify({
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
    state: createState(),
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
  return { seen, writes, output };
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
