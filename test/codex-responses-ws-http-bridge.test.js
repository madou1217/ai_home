const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createGatewayHttpResponsesConnection,
  buildForwardHeaders,
  resolveLoopbackBaseUrl,
  isGatewayHttpAccount
} = require('../lib/server/codex-responses-ws-http-bridge');

function sseBody(events) {
  const text = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return (async function* stream() {
    // 故意劈开分块，验证增量解析。
    for (let offset = 0; offset < text.length; offset += 17) yield Buffer.from(text.slice(offset, offset + 17));
  })();
}

function completedEvents(id, output) {
  return [
    { type: 'response.created', response: { id, status: 'in_progress' } },
    { type: 'response.output_text.delta', delta: 'hi' },
    { type: 'response.completed', response: { id, status: 'completed', output } }
  ];
}

function collectFrames(ws) {
  const frames = [];
  ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
  return frames;
}

async function settle() {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('response.create frames become streamed HTTP /v1/responses calls; SSE events come back as WS frames', async () => {
  const calls = [];
  const assistantItem = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] };
  const { ws, account } = createGatewayHttpResponsesConnection({
    baseUrl: 'http://127.0.0.1:9527',
    clientHeaders: { authorization: 'Bearer k', 'x-aih-session': 's1', cookie: 'nope', session_id: 'abc' },
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return { ok: true, status: 200, body: sseBody(completedEvents(`resp_${calls.length}`, [assistantItem])) };
    }
  });
  assert.equal(isGatewayHttpAccount(account), true);
  const frames = collectFrames(ws);
  ws.send(JSON.stringify({ type: 'response.create', model: 'kiro-opus', input: [{ role: 'user', content: 'a' }] }));
  await settle();
  ws.send(JSON.stringify({ type: 'response.create', model: 'kiro-opus', previous_response_id: 'resp_1', input: [{ role: 'user', content: 'b' }] }));
  await settle();

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://127.0.0.1:9527/v1/responses');
  assert.equal(calls[0].init.headers.authorization, 'Bearer k');
  assert.equal(calls[0].init.headers['x-aih-session'], 's1');
  assert.equal(calls[0].init.headers.session_id, 'abc');
  assert.equal(calls[0].init.headers.cookie, undefined);
  assert.equal(calls[0].body.stream, true);
  assert.equal(calls[0].body.type, undefined);
  // 第二轮：previous_response_id 被展开成完整上下文（HTTP 下游 provider 没有服务端状态）。
  assert.equal(calls[1].body.previous_response_id, undefined);
  assert.deepEqual(calls[1].body.input.map((item) => item.content), ['a', assistantItem.content, 'b']);
  assert.deepEqual(frames.map((frame) => frame.type), [
    'response.created', 'response.output_text.delta', 'response.completed',
    'response.created', 'response.output_text.delta', 'response.completed'
  ]);
});

test('warm-up frames (generate:false) never call the upstream', async () => {
  let called = false;
  const { ws } = createGatewayHttpResponsesConnection({ baseUrl: 'http://x', fetchImpl: async () => { called = true; } });
  const frames = collectFrames(ws);
  ws.send(JSON.stringify({ type: 'response.create', model: 'm', generate: false, input: [] }));
  await settle();
  assert.equal(called, false);
  assert.deepEqual(frames.map((frame) => frame.type), ['response.created', 'response.completed']);
});

test('HTTP failures and unknown previous_response_id surface as WS error frames', async () => {
  const { ws } = createGatewayHttpResponsesConnection({
    baseUrl: 'http://x',
    fetchImpl: async () => ({ ok: false, status: 429, text: async () => JSON.stringify({ error: { message: 'slow down' } }) })
  });
  const frames = collectFrames(ws);
  ws.send(JSON.stringify({ type: 'response.create', model: 'm', input: [{ role: 'user', content: 'a' }] }));
  await settle();
  ws.send(JSON.stringify({ type: 'response.create', model: 'm', previous_response_id: 'resp_missing', input: [] }));
  await settle();
  assert.deepEqual(frames.map((frame) => [frame.type, frame.status, frame.error.message.slice(0, 10)]), [
    ['error', 429, 'slow down'],
    ['error', 400, 'previous_r']
  ]);
});

test('loopback base URL and forwarded headers are derived safely', () => {
  assert.equal(resolveLoopbackBaseUrl({ host: '0.0.0.0', port: 9527 }), 'http://127.0.0.1:9527');
  assert.equal(resolveLoopbackBaseUrl({ host: '::1', port: 1 }), 'http://[::1]:1');
  assert.deepEqual(Object.keys(buildForwardHeaders({ authorization: 'a', host: 'h', 'x-codex-turn-state': 't' })).sort(),
    ['accept', 'authorization', 'content-type', 'x-codex-turn-state']);
});

test('a Codex WS session with no Codex account is served end-to-end through the gateway HTTP pipeline', async (t) => {
  const http = require('node:http');
  const WebSocket = require('ws');
  const { handleCodexResponsesWebSocket } = require('../lib/server/codex-responses-websocket');
  const fetchCalls = [];
  const gateway = http.createServer();
  const sockets = new Set();
  gateway.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  gateway.on('upgrade', (req, socket, head) => handleCodexResponsesWebSocket({
    req, socket, head, state: { accounts: { codex: [], kiro: [{ accountRef: 'acct_kiro' }] }, cursors: {} }, options: { port: 1, host: '127.0.0.1' }
  }, {
    chooseAccount: (pool) => pool[0] || null,
    isLoopbackUrl: () => false,
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        body: sseBody(completedEvents('resp_kiro', [{ type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}' }]))
      };
    }
  }));
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => gateway.close(resolve));
  });
  const client = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/responses`, { headers: { authorization: 'Bearer client-key' } });
  await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
  const frames = [];
  const done = new Promise((resolve) => client.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    frames.push(frame.type);
    if (frame.type === 'response.completed') resolve();
  }));
  client.send(JSON.stringify({ type: 'response.create', model: 'kiro-opus', input: [{ role: 'user', content: 'list files' }] }));
  await done;
  client.close();
  assert.deepEqual(frames, ['response.created', 'response.output_text.delta', 'response.completed']);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'http://127.0.0.1:1/v1/responses');
  assert.equal(fetchCalls[0].body.model, 'kiro-opus');
});
