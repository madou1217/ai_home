'use strict';

// Node 终端边界只剩「管理密钥门后的反代」：这里验证路径/字段收口、状态透传、
// SSE 字节转发与 Go 不可用时的 503；会话语义本身由 Go handler 测试覆盖。

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  handleWebUiTerminalRequest,
  openWebUiTerminalSession,
  probeTerminalSession
} = require('../lib/server/webui-terminal-routes');

function makeContext({ method = 'POST', action, body, query = '', goHost }) {
  const replies = [];
  const chunks = [];
  let head = null;
  let ended = false;
  const req = { on: () => {} };
  const res = {
    writeHead: (status, headers) => { head = { status, headers }; },
    write: (chunk) => { chunks.push(Buffer.from(chunk)); return true; },
    end: () => { ended = true; },
    once: () => {},
    on: () => {}
  };
  const ctx = {
    method,
    pathname: `/v0/webui/terminal/${action}`,
    url: new URL(`http://127.0.0.1/v0/webui/terminal/${action}${query}`),
    req,
    res,
    deps: {},
    readRequestBody: async () => Buffer.from(JSON.stringify(body || {})),
    writeJson: (_res, status, payload) => { replies.push({ status, payload }); }
  };
  if (goHost !== undefined) ctx.deps.goCoreSync = goHost;
  return {
    ctx,
    replies,
    chunks,
    head: () => head,
    ended: () => ended
  };
}

function jsonGoHost(calls, response = { ok: true, status: 200, body: { ok: true } }) {
  return {
    terminalRequest: async (request) => {
      calls.push(request);
      return response;
    }
  };
}

test('open strips executable fields and proxies to the Go management prefix', async () => {
  const calls = [];
  const goHost = jsonGoHost(calls, { ok: true, status: 200, body: { ok: true, termId: 't1' } });
  const harness = makeContext({
    action: 'open',
    goHost,
    body: {
      cols: 80,
      rows: 24,
      muxId: 'mux-1',
      cwd: '/tmp',
      sessionKey: 'k1',
      // 浏览器不允许指定任意可执行/argv/env，必须被丢弃。
      file: '/bin/sh',
      args: ['-c', 'id'],
      env: { EVIL: '1' }
    }
  });

  assert.equal(await handleWebUiTerminalRequest(harness.ctx), true);
  assert.deepEqual(calls, [{
    method: 'POST',
    path: '/v1/management/webui/terminal/open',
    body: { cols: 80, rows: 24, muxId: 'mux-1', cwd: '/tmp', sessionKey: 'k1' }
  }]);
  assert.deepEqual(harness.replies, [{ status: 200, payload: { ok: true, termId: 't1' } }]);
});

test('input/resize/close forward the browser payload and Go status', async () => {
  const calls = [];
  const goHost = jsonGoHost(calls, { ok: false, status: 404, body: { ok: false, error: 'terminal_not_found' } });
  for (const [action, body] of [
    ['input', { termId: 't1', data: 'ls\n' }],
    ['resize', { termId: 't1', cols: 100, rows: 30 }],
    ['close', { termId: 't1', sessionKey: 'k1' }]
  ]) {
    const harness = makeContext({ action, body, goHost });
    assert.equal(await handleWebUiTerminalRequest(harness.ctx), true);
    assert.equal(harness.replies[0].status, 404);
    assert.equal(harness.replies[0].payload.error, 'terminal_not_found');
  }
  assert.deepEqual(calls.map((call) => call.path), [
    '/v1/management/webui/terminal/input',
    '/v1/management/webui/terminal/resize',
    '/v1/management/webui/terminal/close'
  ]);
});

test('Go unavailable becomes an explicit 503 instead of a fake success', async () => {
  for (const goHost of [null, {}, { terminalRequest: async () => null }]) {
    const harness = makeContext({ action: 'open', body: {}, goHost });
    assert.equal(await handleWebUiTerminalRequest(harness.ctx), true);
    assert.equal(harness.replies[0].status, 503);
    assert.equal(harness.replies[0].payload.error, 'go_core_unavailable');
  }
});

test('mux stream forwards Go SSE bytes unchanged', async () => {
  const calls = [];
  const encoder = new TextEncoder();
  const payload = 'data: {"type":"connected","muxId":"m1"}\n\ndata: {"type":"output","termId":"t1","data":"aGk="}\n\n';
  const goHost = {
    openTerminalStream: async ({ path, query }) => {
      calls.push({ path, query });
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(payload));
            controller.close();
          }
        })
      };
    }
  };
  const harness = makeContext({ method: 'GET', action: 'mux', query: '?muxId=m1', goHost });
  assert.equal(await handleWebUiTerminalRequest(harness.ctx), true);
  assert.deepEqual(calls, [{ path: '/v1/management/webui/terminal/mux', query: 'muxId=m1' }]);
  assert.equal(harness.head().status, 200);
  assert.equal(harness.head().headers['Content-Type'], 'text/event-stream');
  assert.equal(Buffer.concat(harness.chunks).toString('utf8'), payload);
  assert.equal(harness.ended(), true);
});

test('mux stream surfaces Go JSON errors with the same status', async () => {
  const goHost = {
    openTerminalStream: async () => ({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ ok: false, error: 'terminal_unavailable' })
    })
  };
  const harness = makeContext({ method: 'GET', action: 'mux', query: '?muxId=m1', goHost });
  assert.equal(await handleWebUiTerminalRequest(harness.ctx), true);
  assert.deepEqual(harness.replies, [{
    status: 503,
    payload: { ok: false, error: 'terminal_unavailable' }
  }]);
});

test('openWebUiTerminalSession launches through Go and normalizes env pairs', async () => {
  const calls = [];
  const goHost = jsonGoHost(calls, {
    ok: true,
    status: 200,
    body: { ok: true, termId: 't1', sessionKey: 'k1', durable: true }
  });
  const result = await openWebUiTerminalSession({
    sessionKey: 'k1',
    cwd: '/tmp',
    file: '/usr/bin/node',
    args: ['bin/ai-home.js'],
    env: { AIH_HOME_DIR: '/tmp/home', AIH_RUNTIME_MARKER: 'utf8=x,web=1', EMPTY: null },
    cols: 120,
    rows: 40,
    persistent: true
  }, goHost);

  assert.equal(calls[0].path, '/v1/management/webui/terminal/launch');
  assert.deepEqual(calls[0].body.env, ['AIH_HOME_DIR=/tmp/home', 'AIH_RUNTIME_MARKER=utf8=x,web=1']);
  assert.equal(calls[0].body.file, '/usr/bin/node');
  assert.equal(calls[0].body.persistent, true);
  assert.equal(result.termId, 't1');
  assert.equal(result.durable, true);
});

test('openWebUiTerminalSession reports unavailability instead of pretending to open', async () => {
  const result = await openWebUiTerminalSession({ sessionKey: 'k1' }, null);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'web_terminal_unavailable');
});

test('probeTerminalSession reads the Go tmux state', async () => {
  const calls = [];
  const goHost = jsonGoHost(calls, { ok: true, status: 200, body: { ok: true, state: 'alive' } });
  assert.deepEqual(await probeTerminalSession('remote-ws:ws_1', goHost), { state: 'alive', message: '' });
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].path, '/v1/management/webui/terminal/probe?sessionKey=remote-ws%3Aws_1');
  assert.deepEqual(await probeTerminalSession('remote-ws:ws_1', null), {
    state: 'unavailable',
    message: 'go_core_unavailable'
  });
});

test('unknown terminal actions fall through to the router', async () => {
  const harness = makeContext({ action: 'does-not-exist', body: {}, goHost: jsonGoHost([]) });
  assert.equal(await handleWebUiTerminalRequest(harness.ctx), false);
});
