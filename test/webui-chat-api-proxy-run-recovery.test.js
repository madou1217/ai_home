'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const {
  handleChatRequest,
  handleNativeChatRunListRequest,
  createApiProxyRunHandle
} = require('../lib/server/webui-chat-routes');
const {
  registerNativeChatRun,
  unregisterNativeChatRun,
  getNativeChatRun,
  listNativeChatRuns,
  createChatEventMeta
} = require('../lib/server/native-chat-run-store');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');

function createMockStreamResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writableEnded: false,
    writeHead(status, headers) {
      this.statusCode = status;
      Object.assign(this.headers, headers || {});
      return this;
    },
    flushHeaders() {},
    write(chunk) {
      this.body += String(chunk);
      return true;
    },
    end(chunk) {
      if (chunk) this.body += String(chunk);
      this.writableEnded = true;
      return this;
    }
  };
}

test('createApiProxyRunHandle 提供快照/abort/能力边界', () => {
  let content = '';
  let cancelled = 0;
  const run = createApiProxyRunHandle({
    runId: 'run-api-1',
    provider: 'kimi',
    identity: { accountRef: 'acct_1' },
    sessionId: 'chat-1',
    projectDirName: '',
    projectPath: '/tmp/p',
    startedAt: 123,
    getContent: () => content,
    cancelUpstream: () => { cancelled += 1; }
  });

  assert.equal(run.mode, 'api-proxy');
  assert.equal(run.interactionMode, 'default');
  assert.equal(run.getActivePrompt(), null);
  assert.equal(run.getContentSnapshot(), '');
  content = '已经生成的部分内容';
  assert.equal(run.getContentSnapshot(), '已经生成的部分内容');

  run.abort();
  assert.equal(cancelled, 1);

  assert.throws(() => run.writeInput('x'), /api_proxy_run_input_unsupported/);
  assert.equal(typeof run.writeSteer, 'undefined');
  assert.equal(typeof run.resize, 'undefined');
});

test('GET /webui/chat/runs 返回 api-proxy run 的 mode 与 contentSnapshot', async () => {
  const runs = [
    {
      runId: 'run-native-1', provider: 'claude', accountRef: 'acct_n',
      sessionId: 'sess-1', startedAt: 111,
      interactionMode: 'default',
      getActivePrompt: () => ({ promptId: 'p1', kind: 'choice', question: '继续?', options: [] })
    },
    createApiProxyRunHandle({
      runId: 'run-api-1',
      provider: 'kimi',
      identity: { accountRef: 'acct_a' },
      sessionId: 'sess-1',
      startedAt: 222,
      getContent: () => '半截回复'
    })
  ];
  let written = null;
  await handleNativeChatRunListRequest({
    url: new URL('http://localhost/v0/webui/chat/runs?sessionId=sess-1'),
    res: {},
    listNativeChatRuns: () => runs,
    deps: {},
    writeJson: (_res, status, payload) => { written = { status, payload }; }
  });

  assert.equal(written.status, 200);
  assert.equal(written.payload.runs.length, 2);
  const nativeRun = written.payload.runs.find((run) => run.runId === 'run-native-1');
  const apiRun = written.payload.runs.find((run) => run.runId === 'run-api-1');
  assert.equal(nativeRun.mode, 'native-session');
  assert.equal(nativeRun.contentSnapshot, '');
  assert.equal(nativeRun.activePrompt.promptId, 'p1');
  assert.equal(apiRun.mode, 'api-proxy');
  assert.equal(apiRun.contentSnapshot, '半截回复');
  // api-proxy run 永远不带交互卡,恢复时不触发 native 专属 prompt 逻辑
  assert.equal(apiRun.activePrompt, null);
});

test('api-proxy 流式 run 上游中断时注销并发布 turn-failed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-api-proxy-fail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const { accountRef } = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'agy',
    cliAccountId: '1',
    identitySeed: 'oauth:agy:run-fail@example.com'
  });
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
    oauthToken: { access_token: 'fake-token', token_type: 'Bearer' }
  });

  // mock 网关：写一段后直接销毁 socket,模拟上游中途断开。
  const mockServer = http.createServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '半截' } }] })}\n\n`);
      setTimeout(() => req.socket.destroy(), 60);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const port = mockServer.address().port;
  t.after(() => mockServer.close());

  const publishedEvents = [];
  const req = new EventEmitter();
  req.headers = {};
  const res = createMockStreamResponse();

  const handled = await handleChatRequest({
    req,
    res,
    url: new URL('http://127.0.0.1/v0/webui/chat'),
    aiHomeDir,
    hostHomeDir: root,
    fs,
    state: { accounts: { agy: [{ accountRef, email: 'run-fail@example.com' }] } },
    options: { port, clientKey: 'test-key' },
    deps: {
      hostHomeDir: root,
      sessionEventBus: {
        publish: (session, event) => {
          publishedEvents.push({ session, event });
          return true;
        }
      }
    },
    readRequestBody: async () => Buffer.from(JSON.stringify({
      provider: 'agy',
      accountRef,
      model: 'some-chat-model',
      sessionId: 'chat-run-fail-1',
      mode: 'chat',
      prompt: '你好',
      stream: true,
      messages: [{ role: 'user', content: '你好' }]
    }), 'utf8'),
    writeJson(resObj, statusCode, payload) {
      resObj.statusCode = statusCode;
      resObj.body = JSON.stringify(payload);
      resObj.writableEnded = true;
    },
    createChatEventMeta,
    registerNativeChatRun,
    unregisterNativeChatRun
  });

  assert.equal(handled, true);
  assert.equal(listNativeChatRuns().some((run) => run.mode === 'api-proxy'), false);
  const eventTypes = publishedEvents.map((entry) => entry.event.type);
  assert.ok(eventTypes.includes('session:turn-started'));
  assert.ok(eventTypes.includes('session:turn-failed'));
});

test('api-proxy 流式 run 注册/快照/完成注销/turn 事件闭环', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-api-proxy-run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiHomeDir = path.join(root, '.ai_home');
  const { accountRef } = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'agy',
    cliAccountId: '1',
    identitySeed: 'oauth:agy:run-recovery@example.com'
  });
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
    oauthToken: { access_token: 'fake-token', token_type: 'Bearer' }
  });

  // mock 网关 /v1/chat/completions:两段 SSE delta,间隔 120ms 以便中途观察在途 run。
  const sseChunk = (text) => `data: ${JSON.stringify({
    choices: [{ delta: { content: text } }]
  })}\n\n`;
  const mockServer = http.createServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sseChunk('第一段。'));
      setTimeout(() => {
        res.write(sseChunk('第二段。'));
        res.write('data: [DONE]\n\n');
        res.end();
      }, 120);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const port = mockServer.address().port;
  t.after(() => mockServer.close());

  const publishedEvents = [];
  const req = new EventEmitter();
  req.headers = {};
  const res = createMockStreamResponse();

  const ctx = {
    req,
    res,
    url: new URL('http://127.0.0.1/v0/webui/chat'),
    aiHomeDir,
    hostHomeDir: root,
    fs,
    state: { accounts: { agy: [{ accountRef, email: 'run-recovery@example.com' }] } },
    options: { port, clientKey: 'test-key' },
    deps: {
      hostHomeDir: root,
      sessionEventBus: {
        publish: (session, event) => {
          publishedEvents.push({ session, event });
          return true;
        }
      }
    },
    readRequestBody: async () => Buffer.from(JSON.stringify({
      provider: 'agy',
      accountRef,
      model: 'some-chat-model',
      sessionId: 'chat-run-recovery-1',
      mode: 'chat',
      prompt: '你好',
      stream: true,
      messages: [{ role: 'user', content: '你好' }]
    }), 'utf8'),
    writeJson(resObj, statusCode, payload) {
      resObj.statusCode = statusCode;
      resObj.body = JSON.stringify(payload);
      resObj.writableEnded = true;
    },
    createChatEventMeta,
    registerNativeChatRun,
    unregisterNativeChatRun
  };

  const done = handleChatRequest(ctx);

  // 轮询等待 run 注册（注册发生在上游响应到达、进入流式分支之后）。
  let activeRun = null;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    activeRun = listNativeChatRuns().find((run) => run.mode === 'api-proxy') || null;
    if (activeRun && activeRun.getContentSnapshot().includes('第一段')) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(activeRun, 'api-proxy 在途 run 应注册进 run store');
  assert.equal(activeRun.sessionId, 'chat-run-recovery-1');
  assert.equal(activeRun.provider, 'agy');
  assert.ok(activeRun.startedAt > 0);
  // 刷新场景的关键:在途即可拿到已累积的部分内容快照。
  assert.ok(activeRun.getContentSnapshot().includes('第一段'), '快照应包含已累积内容');

  await done;

  // 完成后注销,/chat/runs 不再列出。
  assert.equal(getNativeChatRun(activeRun.runId), null);
  assert.equal(listNativeChatRuns().some((run) => run.runId === activeRun.runId), false);

  // ready 事件带 runId,前端可据此显式 abort。
  assert.match(res.body, /"type":"ready"/);
  assert.match(res.body, new RegExp(`"runId":"${activeRun.runId}"`));
  assert.match(res.body, /第一段/);
  assert.match(res.body, /第二段/);

  // turn-started/turn-completed 事件驱动刷新后页面的 watch 重载全量历史。
  const eventTypes = publishedEvents.map((entry) => entry.event.type);
  assert.deepEqual(eventTypes, ['session:turn-started', 'session:turn-completed']);
  assert.equal(publishedEvents[0].session.sessionId, 'chat-run-recovery-1');
  assert.equal(publishedEvents[1].event.runId, activeRun.runId);
});
