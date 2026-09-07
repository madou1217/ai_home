'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { handleCodexChatCompletions } = require('../lib/server/codex-adapter');

const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
const completed = () => frame({
  type: 'response.completed',
  response: { id: 'resp_stream', model: 'gpt-6-astra', usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } }
});

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function gateway(t, upstream, { native = false, stream = true, timeoutMs = 2000 } = {}) {
  const usages = [];
  const failures = [];
  const requests = [];
  const state = {
    accounts: { codex: [{ accountRef: 'acct_stream_test', accessToken: 'local-test', apiKeyMode: true, openaiBaseUrl: upstream }] },
    cursors: { codex: 0 },
    metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 }
  };
  const url = await listen(t, (req, res) => {
    handleCodexChatCompletions({
      options: { codexBaseUrl: upstream, upstreamTimeoutMs: timeoutMs, maxAttempts: 1, failureThreshold: 1, logRequests: true },
      state, req, res,
      requestJson: { model: 'gpt-6-astra', stream, messages: [{ role: 'user', content: 'local test' }] },
      routeKey: native ? 'POST /v1/responses' : 'POST /v1/chat/completions',
      requestStartedAt: Date.now(), cooldownMs: 1000,
      requestMeta: { requestId: 'stream-test', ...(native ? { clientProtocol: 'openai_responses' } : {}) },
      deps: {
        chooseServerAccount: (pool) => pool[0],
        pushMetricError: () => {},
        writeJson: (r, status, payload) => { r.writeHead(status, { 'content-type': 'application/json' }); r.end(JSON.stringify(payload)); },
        fetchWithTimeout: async (url, init) => { requests.push(init); return fetch(url, init); },
        markProxyAccountFailure: (...args) => failures.push(args),
        markProxyAccountSuccess: () => {},
        appendProxyRequestLog: () => {},
        recordModelUsage: (usage) => usages.push(usage),
        waitForTransientRetry: async () => {}
      }
    }).catch((error) => res.destroy(error));
  });
  return { url, state, usages, failures, requests };
}

async function readUntil(reader, marker) {
  const decoder = new TextDecoder();
  let output = '';
  while (!output.includes(marker)) {
    const { value, done } = await reader.read();
    output += decoder.decode(value, { stream: !done });
    if (done) break;
  }
  assert.ok(output.includes(marker), output);
  return output;
}

function parseChunks(text) {
  return text.split('\n').filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
    .map((line) => JSON.parse(line.slice(6)));
}

for (const native of [false, true]) {
  test(`codex ${native ? 'responses' : 'chat'} forwards text before upstream completes`, async (t) => {
    let finish;
    let ended = false;
    const upstream = await listen(t, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(frame({ type: 'response.created', response: { id: 'resp_stream', model: 'gpt-6-astra' } }));
      res.write(frame({ type: 'response.output_text.delta', delta: '立即输出' }));
      finish = () => { ended = true; res.end(completed()); };
    });
    const app = await gateway(t, upstream, { native });
    const response = await fetch(app.url, { signal: AbortSignal.timeout(1500) });
    const reader = response.body.getReader();
    const prefix = await readUntil(reader, '立即输出');
    assert.equal(ended, false, 'text must arrive while upstream is still open');
    assert.equal(response.headers.get('x-aih-server-account-ref'), 'acct_stream_test');
    finish();
    const suffix = await readUntil(reader, native ? 'response.completed' : '[DONE]');
    assert.equal((prefix + suffix).split('立即输出').length - 1, 1);
    assert.equal(app.state.metrics.totalSuccess, 1);
    assert.equal(app.usages.length, 1);
  });
}

test('codex streams split UTF-8, CRLF, reasoning and tool arguments without duplication', async (t) => {
  const upstream = await listen(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = [
      { type: 'response.reasoning_summary_text.delta', delta: '思考中' },
      { type: 'response.output_text.delta', delta: '你好🙂' },
      { type: 'response.output_item.added', output_index: 1, item: { id: 'fc_1', call_id: 'call_1', type: 'function_call', name: 'lookup', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"q":' },
      { type: 'response.function_call_arguments.done', call_id: 'call_1', arguments: '{"q":"中文"}' }
    ];
    const bytes = Buffer.from((events.map(frame).join('') + completed()).replace(/\n/g, '\r\n'));
    for (let offset = 0; offset < bytes.length; offset += 7) {
      res.write(bytes.subarray(offset, offset + 7));
      await new Promise((resolve) => setImmediate(resolve));
    }
    res.end();
  });
  const app = await gateway(t, upstream);
  const response = await fetch(app.url, { signal: AbortSignal.timeout(2000) });
  const chunks = parseChunks(await response.text());
  const deltas = chunks.map((chunk) => chunk.choices[0].delta);
  assert.equal(deltas.map((delta) => delta.content || '').join(''), '你好🙂');
  assert.equal(deltas.map((delta) => delta.reasoning_content || '').join(''), '思考中');
  assert.equal(deltas.flatMap((delta) => delta.tool_calls || []).map((call) => call.function.arguments).join(''), '{"q":"中文"}');
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
  assert.equal(chunks.at(-1).usage.total_tokens, 5);
});

test('codex retries a capacity error before any response has been exposed', async (t) => {
  let calls = 0;
  const upstream = await listen(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    calls += 1;
    res.end(calls === 1
      ? frame({ type: 'response.failed', response: { error: { message: 'Selected model is at capacity' } } })
      : frame({ type: 'response.output_text.delta', delta: 'recovered' }) + completed());
  });
  const app = await gateway(t, upstream);
  const response = await fetch(app.url, { signal: AbortSignal.timeout(2000) });
  assert.match(await response.text(), /recovered/);
  assert.equal(calls, 2);
  assert.equal(app.state.metrics.totalSuccess, 1);
});

for (const failure of ['sse', 'eof', 'idle']) {
  test(`codex reports ${failure} failure after a delta without replay or success`, async (t) => {
    const upstream = await listen(t, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(frame({ type: 'response.output_text.delta', delta: 'partial' }));
      if (failure === 'sse') res.end(frame({ type: 'response.failed', response: { error: { message: 'Selected model is at capacity' } } }));
      if (failure === 'eof') res.end();
    });
    const app = await gateway(t, upstream, { timeoutMs: 100 });
    const response = await fetch(app.url, { signal: AbortSignal.timeout(2000) });
    const text = await response.text();
    assert.match(text, /partial/);
    assert.ok(parseChunks(text).some((chunk) => chunk.error));
    assert.doesNotMatch(text, /\[DONE\]|"finish_reason":"stop"/);
    assert.equal(app.requests.length, 1);
    assert.equal(app.state.metrics.totalSuccess, 0);
    assert.equal(app.state.metrics.totalFailures, 1);
    assert.equal(app.usages.length, 0);
    if (failure === 'idle') assert.equal(app.state.metrics.totalTimeouts, 1);
  });
}

test('codex preserves invalid-request status before stream starts', async (t) => {
  const upstream = await listen(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(frame({ type: 'error', error: { code: 'invalid_request_error', message: 'invalid local test input' } }));
  });
  const app = await gateway(t, upstream);
  const response = await fetch(app.url, { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /invalid local test input/);
  assert.equal(app.requests.length, 1);
});

test('codex cancels the upstream when its client disconnects without penalizing the account', async (t) => {
  let upstreamClosed;
  const closed = new Promise((resolve) => { upstreamClosed = resolve; });
  const upstream = await listen(t, (_req, res) => {
    res.on('close', upstreamClosed);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(frame({ type: 'response.output_text.delta', delta: 'partial' }));
  });
  const app = await gateway(t, upstream);
  const response = await fetch(app.url, { signal: AbortSignal.timeout(2000) });
  const reader = response.body.getReader();
  await readUntil(reader, 'partial');
  await reader.cancel();
  let timer;
  try {
    await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('upstream not cancelled')), 1000); })]);
  } finally { clearTimeout(timer); }
  assert.equal(app.requests.length, 1);
  assert.equal(app.failures.length, 0);
  assert.equal(app.state.metrics.totalSuccess, 0);
});

test('codex keeps non-stream responses aggregated', async (t) => {
  const upstream = await listen(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(frame({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: '完整回答' }] }] } }));
  });
  const app = await gateway(t, upstream, { stream: false });
  const response = await fetch(app.url, { signal: AbortSignal.timeout(2000) });
  assert.equal((await response.json()).choices[0].message.content, '完整回答');
});
