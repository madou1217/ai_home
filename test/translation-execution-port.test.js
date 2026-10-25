'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTranslationExecutionPort } = require('../lib/translation/execution-port');
const { createDirectProviderExecutor } = require('../lib/translation/executors/direct-provider');
const { createAihServerExecutor } = require('../lib/translation/executors/aih-server');

function response(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    body: null,
    async json() { return body; },
    async text() { return JSON.stringify(body); }
  };
}

function request(overrides = {}) {
  return {
    id: 'request-1',
    target: 'direct-provider',
    operation: 'selection',
    text: 'hello',
    source: 'en',
    targetLanguage: 'zh-Hans',
    routes: [{ id: 'microsoft-route', provider: 'microsoft', model: 'default', enabled: true, priority: 0, operations: ['selection'] }],
    ...overrides
  };
}

test('direct provider selects the first successful route and preserves route attempts', async () => {
  const calls = [];
  const direct = createDirectProviderExecutor({
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return response([{ translations: [{ text: '你好' }] }]);
    },
    providerConfig: { apiKey: 'test-key', endpoint: 'https://translator.test' }
  });
  const port = createTranslationExecutionPort({ direct });
  const events = [];
  const result = await port.translate(request(), { emit: (event) => events.push(event) });
  assert.equal(result.ok, true);
  assert.equal(result.text, '你好');
  assert.equal(result.attempts.length, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].init.headers['Ocp-Apim-Subscription-Key'], /test-key/);
  assert.equal(events.some((event) => event.type === 'attempt_success'), true);
});

test('direct provider reports missing configured credentials without calling transport', async () => {
  let calls = 0;
  const direct = createDirectProviderExecutor({
    fetch: async () => { calls += 1; return response([]); },
    providerConfig: { endpoint: 'https://translator.test' }
  });
  const result = await createTranslationExecutionPort({ direct }).translate(request());
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'translation_config_missing');
  assert.equal(result.error.retryable, true);
  assert.equal(calls, 0);
});

test('aborted execution returns the normalized non-retryable cancellation result', async () => {
  const controller = new AbortController();
  controller.abort();
  const direct = async () => { throw new Error('must not run'); };
  const result = await createTranslationExecutionPort({ direct }).translate(request(), { signal: controller.signal });
  assert.deepEqual(result.error, { code: 'translation_aborted', message: '翻译已取消', retryable: false });
  assert.equal(result.ok, false);
});

test('cancellation interrupts an in-flight executor without waiting for transport completion', async () => {
  const controller = new AbortController();
  const direct = async () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, text: 'late' }), 100));
  const started = Date.now();
  const pending = createTranslationExecutionPort({ direct }).translate(request(), { signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  const result = await pending;
  assert.deepEqual(result.error, { code: 'translation_aborted', message: '翻译已取消', retryable: false });
  assert.ok(Date.now() - started < 80);
});

test('AIH Server executor sends server routing headers and parses SSE fallback', async () => {
  const calls = [];
  const server = createAihServerExecutor({
    getManagementKey: () => 'management-secret',
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        body: (async function* stream() {
          yield new TextEncoder().encode('data: {"type":"start"}\n\n');
          yield new TextEncoder().encode('data: {"type":"delta","content":"你好"}\n\n');
          yield new TextEncoder().encode('data: {"type":"done","text":"你好"}\n\n');
        })()
      };
    }
  });
  const events = [];
  const result = await createTranslationExecutionPort({ server }).translate(request({
    target: 'aih-server', origin: 'https://server.test/', serverId: 'remote-1'
  }), { emit: (event) => events.push(event) });
  assert.equal(result.ok, true);
  assert.equal(result.text, '你好');
  assert.equal(calls[0].url, 'https://server.test/v0/webui/translation/stream');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer management-secret');
  assert.equal(calls[0].init.headers['x-aih-server-id'], 'remote-1');
  assert.equal(events.some((event) => event.type === 'delta' && event.content === '你好'), true);
});

test('stale request events are suppressed by request generation predicate', async () => {
  const events = [];
  const direct = async (_request, context) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    context.emit({ type: 'delta', content: 'stale' });
    return { ok: true, text: 'stale' };
  };
  const result = await createTranslationExecutionPort({ direct }).translate(request(), {
    emit: (event) => events.push(event),
    isCurrent: () => false
  });
  assert.equal(result.ok, true);
  assert.deepEqual(events, []);
});

test('unknown execution targets return a normalized retryable error', async () => {
  const result = await createTranslationExecutionPort({}).translate(request({ target: 'unknown-target' }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.error, {
    code: 'translation_target_unsupported',
    message: '翻译执行目标不可用',
    retryable: true
  });
});
