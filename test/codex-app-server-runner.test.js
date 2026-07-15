'use strict';

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');

const {
  startCodexAppServerTurn,
  appServerSocketName,
  __resetClientsForTest
} = require('../lib/server/codex-app-server-runner');
const {
  decideApproval,
  getPendingApprovalPromptForRun
} = require('../lib/server/native-approval-bridge');

const THREAD_ID = '019f0000-0000-0000-0000-00000000e2e1';

// 极简 mock app-server：按脚本响应 initialize/thread/turn,turn/start 后按 scenario 推流。
function createMockAppServer(scenario) {
  const wss = new WebSocket.Server({ port: 0, host: '127.0.0.1' });
  const received = [];
  wss.on('connection', (ws) => {
    const send = (message) => ws.send(JSON.stringify({ jsonrpc: '2.0', ...message }));
    ws.on('message', (data) => {
      const message = JSON.parse(String(data));
      received.push(message);
      if (message.method === 'initialize') {
        send({ id: message.id, result: { userAgent: 'mock/1.0' } });
        return;
      }
      if (message.method === 'thread/start') {
        send({ id: message.id, result: { thread: { id: THREAD_ID } } });
        return;
      }
      if (message.method === 'thread/resume') {
        send({ id: message.id, result: { thread: { id: message.params.threadId, turns: [] } } });
        return;
      }
      if (message.method === 'turn/start') {
        send({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
        scenario({ ws, send, message });
        return;
      }
      // 审批决策(对 server request 的响应,无 method 只有 id/result)。
      if (message.method === undefined && message.id !== undefined) {
        if (typeof wss.onApprovalDecision === 'function') wss.onApprovalDecision(message);
      }
    });
  });
  return new Promise((resolve) => {
    wss.on('listening', () => {
      resolve({
        wss,
        received,
        endpoint: `ws://127.0.0.1:${wss.address().port}`,
        close: () => new Promise((done) => {
          for (const client of wss.clients) {
            try { client.terminate(); } catch (_error) { /* ignore */ }
          }
          wss.close(() => done());
        })
      });
    });
  });
}

function createBusSpy() {
  const published = [];
  return {
    published,
    publish(session, event) {
      published.push({ session, event });
      return true;
    }
  };
}

after(() => {
  // 销毁残留 ws 客户端,避免 event loop 悬挂导致 node --test 不退出。
  __resetClientsForTest();
});

async function waitFor(predicate, timeoutMs = 5000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`waitFor 超时: ${label}`);
}

test('confirm turn：审批请求→桥登记→allow→JSON-RPC accept→turn 完成', async () => {
  __resetClientsForTest();
  const decisions = [];
  const mock = await createMockAppServer(({ send }) => {
    send({ method: 'turn/started', params: { threadId: THREAD_ID, turn: { id: 'turn-1' } } });
    send({
      method: 'item/agentMessage/delta',
      params: { threadId: THREAD_ID, itemId: 'msg-1', delta: '正在创建文件…' }
    });
    // 审批 = server→client JSON-RPC request(带 id)。
    send({
      id: 0,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: THREAD_ID,
        itemId: 'call-1',
        command: 'sh -c "echo p3b > out.txt"',
        cwd: '/tmp/p3b-work',
        availableDecisions: ['accept', 'decline']
      }
    });
  });
  mock.wss.onApprovalDecision = (message) => {
    decisions.push(message);
    const client = [...mock.wss.clients][0];
    const send = (payload) => client.send(JSON.stringify({ jsonrpc: '2.0', ...payload }));
    send({ method: 'serverRequest/resolved', params: { threadId: THREAD_ID, requestId: message.id } });
    send({
      method: 'item/completed',
      params: {
        threadId: THREAD_ID,
        item: {
          type: 'commandExecution', id: 'call-1',
          command: 'sh -c "echo p3b > out.txt"', status: 'completed',
          aggregatedOutput: '', exitCode: 0
        }
      }
    });
    send({
      method: 'item/completed',
      params: { threadId: THREAD_ID, item: { type: 'agentMessage', id: 'msg-1', text: '正在创建文件…完成。' } }
    });
    send({
      method: 'turn/completed',
      params: { threadId: THREAD_ID, turn: { id: 'turn-1', status: 'completed', error: null } }
    });
  };

  const events = [];
  const bus = createBusSpy();
  const handle = startCodexAppServerTurn({
    accountRef: 'acct_11111111111111111111',
    getProfileDir: () => '/tmp/aih-ut-profiles/codex/ut-accept',
    endpoint: mock.endpoint,
    prompt: '创建 out.txt',
    approvalMode: 'confirm',
    projectPath: '/tmp/p3b-work',
    sessionEventBus: bus,
    onEvent: (event) => events.push(event)
  });

  // 审批桥挂账 + 会话事件通道弹卡。
  const prompt = await waitFor(() => getPendingApprovalPromptForRun(handle.runId), 5000, '审批挂账');
  assert.strictEqual(prompt.kind, 'approval');
  assert.strictEqual(prompt.toolName, 'Shell');
  assert.match(prompt.detail, /echo p3b/);
  const approvalPublish = bus.published.find((item) => item.event.type === 'session:approval-request');
  assert.ok(approvalPublish, '应发布 session:approval-request');
  assert.strictEqual(approvalPublish.session.provider, 'codex');
  assert.strictEqual(approvalPublish.session.sessionId, THREAD_ID);
  assert.strictEqual(approvalPublish.event.runId, handle.runId);

  // 用户决策 allow → respond 把 accept 写回 ws。
  decideApproval(prompt.approvalId, 'allow');
  await waitFor(() => decisions.length > 0, 5000, '审批响应回传');
  assert.deepStrictEqual(decisions[0], { jsonrpc: '2.0', id: 0, result: { decision: 'accept' } });

  const result = await handle.done;
  assert.strictEqual(result.sessionId, THREAD_ID);
  assert.strictEqual(result.content, '正在创建文件…完成。');

  const types = events.map((event) => event.type);
  assert.ok(types.includes('session-created'), 'session-created 事件');
  assert.ok(types.includes('delta'), 'delta 事件');
  assert.ok(types.includes('assistant_tool_result'), '工具结果事件');
  assert.ok(types.includes('result'), 'result 事件');
  // thread/start 走 confirm 策略。
  const threadStart = mock.received.find((message) => message.method === 'thread/start');
  assert.strictEqual(threadStart.params.approvalPolicy, 'untrusted');
  assert.strictEqual(threadStart.params.sandbox, 'workspace-write');
  await mock.close();
});

test('confirm turn：deny → decline 回传,turn 正常收尾', async () => {
  __resetClientsForTest();
  const decisions = [];
  const mock = await createMockAppServer(({ send }) => {
    send({ method: 'turn/started', params: { threadId: THREAD_ID, turn: { id: 'turn-1' } } });
    send({
      id: 7,
      method: 'item/fileChange/requestApproval',
      params: { threadId: THREAD_ID, itemId: 'call-9', reason: null }
    });
  });
  mock.wss.onApprovalDecision = (message) => {
    decisions.push(message);
    const client = [...mock.wss.clients][0];
    const send = (payload) => client.send(JSON.stringify({ jsonrpc: '2.0', ...payload }));
    send({
      method: 'item/completed',
      params: { threadId: THREAD_ID, item: { type: 'agentMessage', id: 'msg-1', text: '好的，已取消修改。' } }
    });
    send({
      method: 'turn/completed',
      params: { threadId: THREAD_ID, turn: { id: 'turn-1', status: 'completed', error: null } }
    });
  };

  const handle = startCodexAppServerTurn({
    accountRef: 'acct_22222222222222222222',
    getProfileDir: () => '/tmp/aih-ut-profiles/codex/ut-deny',
    endpoint: mock.endpoint,
    prompt: '改文件',
    approvalMode: 'confirm',
    sessionEventBus: createBusSpy(),
    onEvent: () => {}
  });

  const prompt = await waitFor(() => getPendingApprovalPromptForRun(handle.runId), 5000, '审批挂账');
  assert.strictEqual(prompt.toolName, 'FileChange');
  decideApproval(prompt.approvalId, 'deny', '用户拒绝');
  await waitFor(() => decisions.length > 0, 5000, '审批响应回传');
  assert.deepStrictEqual(decisions[0].result, { decision: 'decline' });

  const result = await handle.done;
  assert.strictEqual(result.content, '好的，已取消修改。');
  await mock.close();
});

test('resume turn：带 sessionId 走 thread/resume,turn 失败 → done reject', async () => {
  __resetClientsForTest();
  const mock = await createMockAppServer(({ send }) => {
    send({ method: 'turn/started', params: { threadId: THREAD_ID, turn: { id: 'turn-2' } } });
    send({
      method: 'turn/completed',
      params: { threadId: THREAD_ID, turn: { id: 'turn-2', status: 'failed', error: { message: 'usage limit reached' } } }
    });
  });

  const handle = startCodexAppServerTurn({
    accountRef: 'acct_33333333333333333333',
    getProfileDir: () => '/tmp/aih-ut-profiles/codex/ut-resume',
    endpoint: mock.endpoint,
    sessionId: THREAD_ID,
    prompt: '继续',
    approvalMode: 'confirm',
    sessionEventBus: createBusSpy(),
    onEvent: () => {}
  });

  await assert.rejects(handle.done, (error) => {
    assert.strictEqual(error.code, 'codex_app_server_turn_failed');
    assert.match(error.message, /usage limit/);
    return true;
  });
  const resume = mock.received.find((message) => message.method === 'thread/resume');
  assert.ok(resume, '应走 thread/resume');
  assert.strictEqual(resume.params.threadId, THREAD_ID);
  assert.strictEqual(resume.params.approvalPolicy, 'untrusted');
  assert.ok(!mock.received.some((message) => message.method === 'thread/start'), '不应新开 thread');
  await mock.close();
});

test('socket 命名：账号号压缩进 tmux socket 名', () => {
  assert.strictEqual(appServerSocketName('1'), 'aih-codexapp-1');
  assert.strictEqual(appServerSocketName('acc/表情!42'), 'aih-codexapp-acc42');
});
