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

    await client.updateSessionPermissions('ses_new', [{ action: '*', resource: '*', effect: 'ask' }]);
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

// 真 http server 往返:v2(opencode ≥2.0)端点形状——/api/* 前缀 + Basic 鉴权 + {data} 信封。
// 布局判定靠 JSON 形状:同一端口上 /global/health 返回 200 HTML(Web UI),只有 /api/info 的
// {version} 能证明这是 v2(2026-10-16 真机 2.0.29 实证)。
test('HTTP 客户端 v2:布局探测(Basic 密码来自日志)/location body/信封/切模型/会话级权限回执', async () => {
  const PASSWORD = 'pw-123';
  const expectedAuth = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`;
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const auth = req.headers.authorization || '';
      const parsed = body ? JSON.parse(body) : null;
      seen.push({ method: req.method, url: req.url, auth, body: parsed });
      if (req.url === '/global/health') { // v2 上这是 Web UI 的 200 HTML,不是健康面
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><html></html>');
        return;
      }
      if (auth !== expectedAuth) {
        res.statusCode = 401;
        res.end('{"error":"unauthorized"}');
        return;
      }
      if (req.url === '/api/info') {
        res.end(JSON.stringify({ version: '2.0.29', pid: 42 }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/session') {
        res.end(JSON.stringify({ data: {
          id: 'ses_v2',
          location: parsed.location,
          model: parsed.model
        } }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/session/ses_v2') {
        res.end(JSON.stringify({ data: { id: 'ses_v2', location: { directory: '/tmp/proj2' } } }));
        return;
      }
      if (req.method === 'PATCH' && req.url === '/api/session/ses_v2') {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.method === 'POST' && req.url === '/api/session/ses_v2/model') {
        res.end(JSON.stringify({ data: { id: 'ses_v2' } }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/session/ses_v2/prompt') {
        res.end(JSON.stringify({ data: { id: 'msg_1', sessionID: 'ses_v2', delivery: 'steer' } }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/session/ses_v2/permission') {
        res.end(JSON.stringify({ data: [{ id: 'per_9', action: 'shell', resources: ['ls'] }] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/session/ses_v2/permission/per_9/reply') {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.method === 'POST' && req.url === '/api/session/ses_v2/interrupt') {
        res.end(JSON.stringify({ interrupted: false }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // 无日志密码:探测不到(401),fail closed 返回 null。
    const blind = createOpenCodeServeClient({ baseUrl });
    assert.equal(await blind.health(), null);

    const client = createOpenCodeServeClient({
      baseUrl,
      readLogTail: () => 'server password pw-old\nsome log\nserver password pw-123\n'
    });
    const health = await client.health();
    assert.equal(health.layout, 'v2', '/global/health 的 200 HTML 不得被当成 v1');
    assert.equal(health.version, '2.0.29');
    assert.equal(client.layout.id, 'v2');
    assert.equal(client.password, PASSWORD);

    const created = await client.createSession({
      directory: '/tmp/proj2',
      model: { providerID: 'opencode-go', modelID: 'glm-5.2' }
    });
    const createCall = seen.find((item) => item.method === 'POST' && item.url === '/api/session');
    assert.deepEqual(createCall.body, {
      location: { directory: '/tmp/proj2' },
      model: { id: 'glm-5.2', providerID: 'opencode-go' }
    });
    assert.equal(createCall.auth, expectedAuth);
    assert.equal(created.id, 'ses_v2');
    // 信封解开 + location.directory 归一成 directory(runner 反查作用域两代同构)。
    assert.equal(created.directory, '/tmp/proj2');

    const info = await client.getSession('ses_v2');
    assert.equal(info.directory, '/tmp/proj2');

    await client.updateSessionPermissions('ses_v2', [{ action: '*', resource: '*', effect: 'ask' }]);
    const patchCall = seen.find((item) => item.method === 'PATCH');
    assert.equal(patchCall.url, '/api/session/ses_v2');
    assert.deepEqual(patchCall.body, { permissions: [{ action: '*', resource: '*', effect: 'ask' }] });

    await client.promptAsync('ses_v2', {
      model: { providerID: 'opencode-go', modelID: 'glm-5.2' },
      text: '你好'
    });
    // 模型不在 prompt 体里:先切会话模型再发 prompt。
    const modelCall = seen.find((item) => item.url === '/api/session/ses_v2/model');
    assert.deepEqual(modelCall.body, { model: { id: 'glm-5.2', providerID: 'opencode-go' } });
    const promptCall = seen.find((item) => item.url === '/api/session/ses_v2/prompt');
    assert.deepEqual(promptCall.body, { text: '你好' });
    assert.ok(seen.indexOf(modelCall) < seen.indexOf(promptCall));

    assert.deepEqual(await client.listPermissions({ sessionId: 'ses_v2' }), [
      { id: 'per_9', action: 'shell', resources: ['ls'] }
    ]);

    await client.replyPermission('per_9', 'once', undefined, { sessionId: 'ses_v2' });
    await client.replyPermission('per_9', 'reject', '不要执行', { sessionId: 'ses_v2' });
    const replyCalls = seen.filter((item) => item.url.endsWith('/reply'));
    assert.equal(replyCalls[0].url, '/api/session/ses_v2/permission/per_9/reply');
    assert.deepEqual(replyCalls[0].body, { decision: 'once' });
    assert.deepEqual(replyCalls[1].body, { decision: 'reject', message: '不要执行' });

    await client.abortSession('ses_v2');
    assert.ok(seen.some((item) => item.url === '/api/session/ses_v2/interrupt'));
  } finally {
    server.close();
  }
});

test('openEventStream v2:挂 Basic 鉴权 + 全局流路径 /api/event', async () => {
  const seenAuth = [];
  let sseRes = null;
  const server = http.createServer((req, res) => {
    seenAuth.push(req.headers.authorization || '');
    if (req.url === '/api/event') {
      sseRes = res;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"id":"evt_1","type":"server.connected","data":{}}\n\n');
      res.write('data: {"id":"evt_2","type":"session.execution.succeeded","data":{"sessionID":"ses_x"}}\n\n');
      return;
    }
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const password = 'pw-stream';
  const client = createOpenCodeServeClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    layout: 'v2',
    password
  });
  const events = [];
  try {
    const stream = client.openEventStream({ directory: '/tmp/proj2', onEvent: (event) => events.push(event) });
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (events.length >= 2) { clearInterval(timer); resolve(); }
      }, 20);
    });
    assert.deepEqual(events.map((event) => event.type), ['server.connected', 'session.execution.succeeded']);
    assert.equal(
      seenAuth[0],
      `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
      'v2 事件流必须带 Basic 鉴权'
    );
    stream.close();
    assert.equal(stream.closed, true);
  } finally {
    if (sseRes) try { sseRes.destroy(); } catch (_e) { /* ignore */ }
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
