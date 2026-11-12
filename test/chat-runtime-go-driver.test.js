'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { openChatRuntimeStore } = require('../lib/server/chat-runtime/store');
const { SessionActor } = require('../lib/server/chat-runtime/session-actor');
const { createGoChatDriverEntry } = require('../lib/server/chat-runtime/go-chat-driver');

// 端到端：dispatchCommand → SessionActor → TurnLifecycle → Go 驱动 → 真 HTTP SSE →
// canonical 事件表。Go 一侧用真 HTTP 服务器返回与 webuichatapi 逐字节相同的帧，
// 证明 Node 消费的是传输层真实形状，而不是直接调函数。

const SESSION_ID = 'session-go-chat';
const RUNTIME = { provider: 'codex', runtimeId: 'codex:gateway' };

function frame(seq, type, data) {
  return `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function goStreamEvents(content, usage) {
  return [
    { type: 'turn.queued', data: { state: 'starting' } },
    { type: 'turn.started', data: { state: 'running' } },
    {
      type: 'timeline.item.started',
      data: {
        item: {
          id: 'item-assistant-1',
          kind: 'message',
          createdAt: 1_700_000_000_000,
          status: 'running',
          content: '',
          detail: { role: 'assistant', model: 'gpt-test' },
          turnId: 'go-turn-1'
        }
      }
    },
    { type: 'timeline.item.delta', data: { itemId: 'item-assistant-1', chunk: content.slice(0, 2) } },
    { type: 'timeline.item.delta', data: { itemId: 'item-assistant-1', chunk: content.slice(2) } },
    {
      type: 'timeline.item.completed',
      data: {
        item: {
          id: 'item-assistant-1',
          kind: 'message',
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_050,
          status: 'completed',
          content,
          detail: { role: 'assistant', model: 'gpt-test', metrics: usage },
          turnId: 'go-turn-1'
        }
      }
    },
    { type: 'turn.completed', data: { state: 'idle' } }
  ];
}

// fakeGoServer 是最小 Go 入口：校验管理凭据、记录请求体、按给定事件流回写 SSE。
function resolvePlan(plan, requestIndex) {
  if (typeof plan === 'function') return plan(requestIndex);
  return plan || null;
}

async function fakeGoServer(options = {}) {
  const requests = [];
  const state = { plan: options.plan || null };
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
        accountRef: request.headers['x-account-ref'],
        body: body ? JSON.parse(body) : null
      });
      if (request.headers.authorization !== 'Bearer management-key') {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: 'chat_runtime_unauthorized', message: '管理凭据无效' }));
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      const plan = resolvePlan(state.plan, requests.length);
      const events = plan || goStreamEvents('你好，世界', { durationMs: 50, ttftMs: 10, inputTokens: 7, outputTokens: 3 });
      let seq = 0;
      for (const event of events) {
        seq += 1;
        response.write(frame(seq, event.type, event.data));
      }
      if (plan && plan.hold) return;
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    state,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function readHistory(store) {
  const page = store.readTimeline(SESSION_ID, { limit: 100 });
  return (page.items || [])
    .filter((item) => item.kind === 'message' && item.status === 'completed'
      && item.detail && ['user', 'assistant'].includes(item.detail.role))
    .map((item) => ({ role: item.detail.role, content: item.content }));
}

function createHarness(store, baseUrl, policy = {}, executionAccountRef = 'gateway') {
  const session = {
    sessionId: SESSION_ID,
    provider: 'codex',
    executionAccountRef,
    projectPath: '',
    policy: { model: 'gpt-test', ...policy }
  };
  const entry = createGoChatDriverEntry({
    session,
    getSessionPolicy: () => session.policy,
    eventSink: (event) => store.appendEvent(SESSION_ID, { ...event, source: RUNTIME }),
    readChatHistory: () => readHistory(store),
    createItemId: () => `item-${crypto.randomUUID()}`,
    streamTurn: ({ sessionId, accountRef, body, signal }) => fetch(
      `${baseUrl}/v1/management/webui/chat/sessions/${encodeURIComponent(sessionId)}/commands`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer management-key',
          'content-type': 'application/json',
          ...(accountRef ? { 'x-account-ref': accountRef } : {})
        },
        body: JSON.stringify(body),
        signal
      }
    )
  });
  return {
    session,
    actor: new SessionActor({
      sessionId: SESSION_ID,
      store,
      driver: entry.driver,
      handlers: entry.handlers,
      composerCatalog: entry.composerCatalog
    })
  };
}

async function withRuntime(t, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-go-chat-'));
  const store = openChatRuntimeStore({
    fs,
    aiHomeDir: root,
    historyCompaction: false,
    clock: () => 1_700_000_000_000
  });
  store.createSession({
    sessionId: SESSION_ID,
    provider: 'codex',
    executionAccountRef: 'gateway',
    projectPath: '',
    policy: { model: 'gpt-test' },
    runtimeBinding: { runtimeId: 'codex:gateway' }
  });
  const go = await fakeGoServer();
  t.after(async () => {
    await go.close();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await run({ store, go });
}

test('dispatchCommand 走 Go 后事件形状与既有 canonical 协议一致', async (t) => {
  await withRuntime(t, async ({ store, go }) => {
    const { actor } = createHarness(store, go.baseUrl);
    const result = await actor.dispatch({
      commandId: 'command-1',
      sessionId: SESSION_ID,
      type: 'turn.submit',
      payload: { content: '你好', model: 'gpt-test' }
    });
    assert.equal(result.commandId, 'command-1');
    assert.equal(result.duplicate, false);
    assert.equal(result.result.state, 'running');
    assert.match(result.result.turnId, /^turn-/);
    assert.equal(result.result.runId.length > 0, true);
    await actor.waitForIdle();

    assert.equal(go.requests.length, 1);
    const request = go.requests[0];
    assert.equal(request.url, `/v1/management/webui/chat/sessions/${SESSION_ID}/commands`);
    assert.equal(request.authorization, 'Bearer management-key');
    assert.equal(request.body.type, 'turn.submit');
    assert.equal(request.body.payload.model, 'gpt-test');
    // 历史由 Node 提供：首轮只有 system + 本轮用户消息。
    assert.deepEqual(request.body.payload.messages.map((message) => message.role), ['system', 'user']);
    assert.equal(request.body.payload.messages[1].content, '你好');
    assert.equal(request.body.payload.avatarRef, undefined);

    const events = store.listEvents(SESSION_ID, { limit: 500 });
    const index = (predicate) => events.findIndex(predicate);
    const types = events.map((event) => event.type);
    // 202 + 独立 SSE 的语义：turn.queued / turn.started 仍由 Node 发，Go 的同类事件被忽略。
    assert.equal(types.filter((type) => type === 'turn.queued').length, 1);
    assert.equal(types.filter((type) => type === 'turn.started').length, 1);
    assert.equal(types.filter((type) => type === 'turn.completed').length, 1);
    const queuedAt = index((event) => event.type === 'turn.queued');
    const startedAt = index((event) => event.type === 'turn.started');
    const userCompleted = index((event) => event.type === 'timeline.item.completed'
      && event.payload.item.detail.role === 'user');
    const assistantStarted = index((event) => event.type === 'timeline.item.started'
      && event.payload.item.detail.role === 'assistant');
    const metricsAt = index((event) => event.type === 'turn.metrics.updated');
    const completedAt = index((event) => event.type === 'turn.completed');
    assert.ok(queuedAt >= 0 && startedAt > queuedAt);
    assert.ok(userCompleted > startedAt);
    assert.ok(assistantStarted > userCompleted);
    assert.ok(metricsAt > assistantStarted);
    assert.ok(completedAt > metricsAt);

    // 事件信封与来源与会话绑定一致，seq 严格递增。
    for (const event of events) {
      assert.equal(event.sessionId, SESSION_ID);
      assert.deepEqual(event.source, RUNTIME);
      assert.equal(typeof event.seq, 'number');
      assert.equal(typeof event.eventId, 'string');
    }
    assert.deepEqual(types.every((type, position) => position === 0 || events[position].seq > events[position - 1].seq), true);

    // delta 用 Go 的 itemId，且被翻译成 Node 的 turnId/runId。
    const delta = events.find((event) => event.type === 'timeline.item.delta');
    assert.equal(delta.payload.itemId, 'item-assistant-1');
    assert.equal(delta.payload.chunk, '你好');
    assert.equal(delta.turnId, result.result.turnId);
    assert.equal(delta.runId, result.result.runId);

    // 用量：真实 token 数从 Go 的 metrics 带进 canonical turn.metrics.updated。
    const metrics = events[metricsAt];
    assert.equal(metrics.payload.metrics.inputTokens, 7);
    assert.equal(metrics.payload.metrics.outputTokens, 3);

    // 时间线：用户消息 + 助手消息，助手条目带结算后的 metrics。
    const timeline = store.readTimeline(SESSION_ID, { limit: 100 }).items;
    assert.deepEqual(timeline.map((item) => item.detail.role), ['user', 'assistant']);
    assert.equal(timeline[0].content, '你好');
    assert.equal(timeline[1].content, '你好，世界');
    assert.equal(timeline[1].status, 'completed');
    assert.equal(typeof timeline[1].detail.metrics.durationMs, 'number');
    assert.equal(timeline[1].detail.model, 'gpt-test');
  });
});

test('第二轮把会话历史随指令带给 Go（多轮上下文不丢）', async (t) => {
  await withRuntime(t, async ({ store, go }) => {
    const { actor } = createHarness(store, go.baseUrl);
    await actor.dispatch({
      commandId: 'command-1', sessionId: SESSION_ID, type: 'turn.submit',
      payload: { content: '第一轮', model: 'gpt-test' }
    });
    await actor.waitForIdle();
    await actor.dispatch({
      commandId: 'command-2', sessionId: SESSION_ID, type: 'turn.submit',
      payload: { content: '第二轮', model: 'gpt-test' }
    });
    await actor.waitForIdle();

    assert.equal(go.requests.length, 2);
    const messages = go.requests[1].body.payload.messages;
    assert.deepEqual(messages.map((message) => message.role), ['system', 'user', 'assistant', 'user']);
    assert.equal(messages[1].content, '第一轮');
    assert.equal(messages[2].content, '你好，世界');
    assert.equal(messages[3].content, '第二轮');
  });
});

test('带附件的轮次显式拒绝，不会静默丢文件', async (t) => {
  await withRuntime(t, async ({ store, go }) => {
    store.context.db.prepare(`
      INSERT INTO chat_runtime_attachments
        (attachment_id, session_id, file_path, name, mime_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('att-1', SESSION_ID, '/tmp/picture.png', 'picture.png', 'image/png', 1_700_000_000_000);
    const { actor } = createHarness(store, go.baseUrl);
    await assert.rejects(
      actor.dispatch({
        commandId: 'command-attachment', sessionId: SESSION_ID, type: 'turn.submit',
        payload: { content: '看看这张图', model: 'gpt-test', attachmentIds: ['att-1'] }
      }),
      (error) => {
        assert.equal(error.code, 'chat_attachment_store_unavailable');
        assert.equal(error.statusCode, 503);
        return true;
      }
    );
    assert.equal(go.requests.length, 0);
  });
});

test('没有模型时显式失败，不猜默认模型', async (t) => {
  await withRuntime(t, async ({ store, go }) => {
    const { actor } = createHarness(store, go.baseUrl, { model: '' });
    await assert.rejects(
      actor.dispatch({
        commandId: 'command-no-model', sessionId: SESSION_ID, type: 'turn.submit',
        payload: { content: '你好' }
      }),
      (error) => {
        assert.equal(error.code, 'chat_turn_model_required');
        assert.equal(error.statusCode, 422);
        return true;
      }
    );
    assert.equal(go.requests.length, 0);
  });
});

test('turn.interrupt 断开 Go 连接并收敛为 turn.interrupted', async (t) => {
  await withRuntime(t, async ({ store, go }) => {
    const { actor } = createHarness(store, go.baseUrl);
    const plan = goStreamEvents('...', {});
    plan.pop(); // 去掉 turn.completed：让这一轮停在流中
    plan.hold = true;
    go.state.plan = plan;
    {
      await actor.dispatch({
        commandId: 'command-interrupt', sessionId: SESSION_ID, type: 'turn.submit',
        payload: { content: '长对话', model: 'gpt-test' }
      });
      // 等第一块增量到达（流已经建立），再发中断。
      await waitFor(() => store.listEvents(SESSION_ID, { limit: 500 })
        .some((event) => event.type === 'timeline.item.delta'));
      const interrupt = await actor.dispatch({
        commandId: 'command-stop', sessionId: SESSION_ID, type: 'turn.interrupt',
        payload: { reason: 'user_stop' }
      });
      assert.equal(interrupt.result.state, 'interrupting');
      await actor.waitForIdle();
    }
    const types = store.listEvents(SESSION_ID, { limit: 500 }).map((event) => event.type);
    assert.ok(types.includes('turn.interrupt.requested'));
    assert.ok(types.includes('turn.interrupted'));
    assert.equal(types.includes('turn.failed'), false);
  });
});

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timeout');
}

test('会话钉选账号时把 X-Account-Ref 交给 Go，不静默改成池化', async (t) => {
  await withRuntime(t, async ({ store, go }) => {
    const { actor } = createHarness(store, go.baseUrl, {}, 'acct_pinned');
    await actor.dispatch({
      commandId: 'command-pinned', sessionId: SESSION_ID, type: 'turn.submit',
      payload: { content: '你好', model: 'gpt-test' }
    });
    await actor.waitForIdle();
    assert.equal(go.requests.length, 1);
    assert.equal(go.requests[0].accountRef, 'acct_pinned');
  });
});

test('网关作用域的会话不带钉选头（由 Go 池化选号）', async (t) => {
  await withRuntime(t, async ({ store, go }) => {
    const { actor } = createHarness(store, go.baseUrl);
    await actor.dispatch({
      commandId: 'command-pool', sessionId: SESSION_ID, type: 'turn.submit',
      payload: { content: '你好', model: 'gpt-test' }
    });
    await actor.waitForIdle();
    assert.equal(go.requests[0].accountRef, undefined);
  });
});
