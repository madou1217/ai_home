const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  createOpenCodeServeClient,
  createSseJsonDecoder,
  parseOpenCodeModelRef
} = require('../lib/server/opencode-serve-client');

// P3c:opencode serve 本地客户端——模型引用切分、SSE 解码器、HTTP 端点形状(真 http server 往返)。

test('parseOpenCodeModelRef:providerID/modelID 首个斜杠切分,残缺返回 null', () => {
  assert.deepEqual(parseOpenCodeModelRef('opencode-go/glm-5.2'), {
    providerID: 'opencode-go',
    modelID: 'glm-5.2'
  });
  // modelID 自身可以带斜杠(首个 / 切分)
  assert.deepEqual(parseOpenCodeModelRef('openrouter/meta/llama-3'), {
    providerID: 'openrouter',
    modelID: 'meta/llama-3'
  });
  assert.equal(parseOpenCodeModelRef('glm-5.2'), null);
  assert.equal(parseOpenCodeModelRef('/glm'), null);
  assert.equal(parseOpenCodeModelRef('opencode-go/'), null);
  assert.equal(parseOpenCodeModelRef(''), null);
});

test('createSseJsonDecoder:跨 chunk 帧重组,非 JSON data 行忽略', () => {
  const events = [];
  const decode = createSseJsonDecoder((event) => events.push(event));
  decode('data: {"type":"a"');
  assert.equal(events.length, 0, '半帧不产出');
  decode('}\n\ndata: not-json\n\n');
  decode('data: {"type":"b","properties":{"sessionID":"ses_1"}}\n\n');
  assert.deepEqual(events.map((event) => event.type), ['a', 'b']);
  assert.equal(events[1].properties.sessionID, 'ses_1');
});

test('baseUrl 校验:非 http 直接抛', () => {
  assert.throws(() => createOpenCodeServeClient({ baseUrl: 'ftp://x' }), /baseUrl/);
});

// 真 http server 往返:端点路径/方法/请求体形状与 1.4.7 实证契约一致。
test('HTTP 客户端:createSession(directory query)/patch 权限/prompt_async/permission reply/abort', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      if (req.url === '/global/health') {
        res.end(JSON.stringify({ healthy: true, version: '1.4.7' }));
        return;
      }
      if (req.method === 'POST' && req.url.startsWith('/session?')) {
        res.end(JSON.stringify({ id: 'ses_new', directory: '/tmp/proj' }));
        return;
      }
      if (req.method === 'POST' && req.url.endsWith('/prompt_async')) {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.url === '/permission') {
        res.end(JSON.stringify([{ id: 'per_1' }]));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const client = createOpenCodeServeClient({ baseUrl: `http://127.0.0.1:${port}/` });

  try {
    assert.equal((await client.health()).version, '1.4.7');

    const created = await client.createSession({ directory: '/tmp/proj' });
    assert.equal(created.id, 'ses_new');
    const createCall = seen.find((item) => item.url.startsWith('/session?'));
    assert.equal(createCall.url, `/session?directory=${encodeURIComponent('/tmp/proj')}`);

    await client.updateSessionPermissions('ses_new', [{ permission: '*', pattern: '*', action: 'ask' }]);
    const patchCall = seen.find((item) => item.method === 'PATCH');
    assert.equal(patchCall.url, '/session/ses_new');
    assert.deepEqual(patchCall.body.permission, [{ permission: '*', pattern: '*', action: 'ask' }]);

    await client.promptAsync('ses_new', {
      model: { providerID: 'opencode-go', modelID: 'glm-5.2' },
      text: '你好'
    });
    const promptCall = seen.find((item) => item.url === '/session/ses_new/prompt_async');
    assert.deepEqual(promptCall.body.model, { providerID: 'opencode-go', modelID: 'glm-5.2' });
    assert.deepEqual(promptCall.body.parts, [{ type: 'text', text: '你好' }]);

    // model 为 null 时不带 model 字段(用会话默认)
    await client.promptAsync('ses_new', { model: null, text: 'x' });
    const promptCalls = seen.filter((item) => item.url === '/session/ses_new/prompt_async');
    assert.equal('model' in promptCalls[1].body, false);

    assert.deepEqual(await client.listPermissions(), [{ id: 'per_1' }]);

    await client.replyPermission('per_1', 'once');
    await client.replyPermission('per_2', 'reject', '用户拒绝');
    const replyCalls = seen.filter((item) => item.url.startsWith('/permission/') && item.url.endsWith('/reply'));
    assert.deepEqual(replyCalls[0].body, { reply: 'once' });
    assert.deepEqual(replyCalls[1].body, { reply: 'reject', message: '用户拒绝' });

    await client.abortSession('ses_new');
    assert.ok(seen.some((item) => item.url === '/session/ses_new/abort'));
  } finally {
    server.close();
  }
});

test('HTTP 客户端:非 2xx 抛 coded error', async () => {
  const server = http.createServer((req, res) => {
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = createOpenCodeServeClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
  try {
    await assert.rejects(client.createSession({}), (error) => {
      assert.equal(error.code, 'opencode_serve_http_error');
      assert.equal(error.status, 404);
      return true;
    });
  } finally {
    server.close();
  }
});

test('openEventStream:SSE 事件送达,close 幂等', async () => {
  let sseRes = null;
  const server = http.createServer((req, res) => {
    if (req.url === '/event') {
      sseRes = res;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"type":"server.connected"}\n\n');
      res.write('data: {"type":"session.idle","properties":{"sessionID":"ses_x"}}\n\n');
      return;
    }
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = createOpenCodeServeClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
  const events = [];
  try {
    const stream = client.openEventStream({ onEvent: (event) => events.push(event) });
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (events.length >= 2) { clearInterval(timer); resolve(); }
      }, 20);
    });
    assert.deepEqual(events.map((event) => event.type), ['server.connected', 'session.idle']);
    stream.close();
    stream.close(); // 幂等
    assert.equal(stream.closed, true);
  } finally {
    if (sseRes) try { sseRes.destroy(); } catch (_e) { /* ignore */ }
    server.close();
  }
});
