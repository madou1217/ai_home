'use strict';

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');

const {
  acquireAppServerClient,
  startCodexAppServerTurn,
  appServerSocketName,
  getAppServerClient,
  codexAppServerLaunchEnv,
  resolveCodexAppServerLaunch,
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
      if (message.method === 'account/read') {
        send({ id: message.id, result: { account: { type: 'chatgpt' } } });
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

function verifiedOAuthIdentity() {
  return {
    verified: true,
    kind: 'oauth',
    assurance: 'identity',
    identityHash: 'a'.repeat(64),
    runtimeHomeHash: 'b'.repeat(64)
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
    accountIdentityValidator: async () => verifiedOAuthIdentity(),
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
  const turnStart = mock.received.find((message) => message.method === 'turn/start');
  assert.strictEqual(turnStart.params.approvalPolicy, 'untrusted');
  assert.deepStrictEqual(turnStart.params.sandboxPolicy, { type: 'workspaceWrite' });
  const initialize = mock.received.find((message) => message.method === 'initialize');
  assert.deepStrictEqual(initialize.params.capabilities, { experimentalApi: true });
  assert.deepStrictEqual(
    mock.received.filter((message) => message.method).slice(0, 4)
      .map((message) => message.method),
    ['initialize', 'initialized', 'account/read', 'thread/start']
  );
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
    accountIdentityValidator: async () => verifiedOAuthIdentity(),
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
    accountIdentityValidator: async () => verifiedOAuthIdentity(),
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
  assert.strictEqual(resume.params.excludeTurns, true);
  const turnStart = mock.received.find((message) => message.method === 'turn/start');
  assert.strictEqual(turnStart.params.approvalPolicy, 'untrusted');
  assert.deepStrictEqual(turnStart.params.sandboxPolicy, { type: 'workspaceWrite' });
  assert.ok(!mock.received.some((message) => message.method === 'thread/start'), '不应新开 thread');
  await mock.close();
});

test('willRetry 通知只更新重试状态，不提前结束 legacy turn', async () => {
  __resetClientsForTest();
  const mock = await createMockAppServer(({ send }) => {
    send({ method: 'turn/started', params: { threadId: THREAD_ID, turn: { id: 'turn-retry' } } });
    send({
      method: 'error',
      params: {
        threadId: THREAD_ID,
        turnId: 'turn-retry',
        error: { message: 'stream disconnected' },
        willRetry: true
      }
    });
    send({
      method: 'item/agentMessage/delta',
      params: { threadId: THREAD_ID, itemId: 'msg-retry', delta: '恢复成功' }
    });
    send({
      method: 'turn/completed',
      params: {
        threadId: THREAD_ID,
        turn: { id: 'turn-retry', status: 'completed', error: null }
      }
    });
  });
  const events = [];
  const handle = startCodexAppServerTurn({
    accountRef: 'acct_44444444444444444444',
    accountIdentityValidator: async () => verifiedOAuthIdentity(),
    getProfileDir: () => '/tmp/aih-ut-profiles/codex/ut-native-retry',
    endpoint: mock.endpoint,
    prompt: '继续',
    approvalMode: 'confirm',
    sessionEventBus: createBusSpy(),
    onEvent: (event) => events.push(event)
  });

  const result = await handle.done;
  assert.strictEqual(result.content, '恢复成功');
  assert.deepStrictEqual(
    events.filter((event) => event.type === 'retry-status').map(({ runId, ...event }) => event),
    [{
      type: 'retry-status',
      phase: 'scheduled',
      source: 'upstream-api',
      provider: 'codex'
    }]
  );
  assert.ok(events.some((event) => event.type === 'delta'));
  assert.ok(events.some((event) => event.type === 'result'));
  await mock.close();
});

test('abort while turn/start is pending interrupts the returned native turn and releases the runtime', async (t) => {
  __resetClientsForTest();
  const received = [];
  let pendingTurnStart = null;
  let resolveTurnStartRequested;
  const turnStartRequested = new Promise((resolve) => {
    resolveTurnStartRequested = resolve;
  });
  const wss = new WebSocket.Server({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (ws) => {
    const send = (message) => ws.send(JSON.stringify({ jsonrpc: '2.0', ...message }));
    ws.on('message', (data) => {
      const message = JSON.parse(String(data));
      received.push(message);
      if (message.method === 'initialize') {
        send({ id: message.id, result: { userAgent: 'mock/1.0' } });
      } else if (message.method === 'account/read') {
        send({ id: message.id, result: { account: { type: 'chatgpt' } } });
      } else if (message.method === 'thread/resume') {
        send({ id: message.id, result: { thread: { id: THREAD_ID, turns: [] } } });
      } else if (message.method === 'turn/start') {
        pendingTurnStart = { id: message.id, send };
        resolveTurnStartRequested();
      } else if (message.method === 'turn/interrupt') {
        send({ id: message.id, result: {} });
        send({
          method: 'turn/completed',
          params: {
            threadId: THREAD_ID,
            turn: { id: 'turn-aborted-before-start-response', status: 'interrupted', error: null }
          }
        });
      }
    });
  });
  await new Promise((resolve) => wss.once('listening', resolve));
  t.after(async () => {
    __resetClientsForTest();
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
  });

  const accountRef = 'acct_66666666666666666666';
  const clientOptions = {
    accountRef,
    runtimeScope: accountRef,
    endpoint: `ws://127.0.0.1:${wss.address().port}`,
    accountIdentityValidator: async () => verifiedOAuthIdentity()
  };
  const handle = startCodexAppServerTurn({
    ...clientOptions,
    getProfileDir: () => '/tmp/aih-ut-profiles/codex/ut-abort-race',
    sessionId: THREAD_ID,
    prompt: 'stop before native turn id is known',
    approvalMode: 'confirm',
    sessionEventBus: createBusSpy(),
    onEvent: () => {}
  });

  await turnStartRequested;
  const residentBeforeAbort = getAppServerClient(clientOptions);
  handle.abort();
  assert.equal(
    received.some((message) => message.method === 'turn/interrupt'),
    false,
    'turn/start 返回 turnId 前无法发送 interrupt'
  );

  pendingTurnStart.send({
    id: pendingTurnStart.id,
    result: { turn: { id: 'turn-aborted-before-start-response', status: 'inProgress' } }
  });
  const interrupt = await waitFor(
    () => received.find((message) => message.method === 'turn/interrupt'),
    500,
    'deferred turn/start 返回后补发 interrupt'
  );
  assert.deepStrictEqual(interrupt.params, {
    threadId: THREAD_ID,
    turnId: 'turn-aborted-before-start-response'
  });
  await handle.done;

  const residentAfterSettlement = getAppServerClient(clientOptions);
  assert.notStrictEqual(residentAfterSettlement, residentBeforeAbort);
  await assert.rejects(
    residentBeforeAbort.ensureConnected(),
    (error) => error.code === 'codex_app_server_client_closed'
  );
  residentAfterSettlement.destroy();
});

test('socket 命名：账号号压缩进 tmux socket 名', () => {
  assert.strictEqual(appServerSocketName('1'), 'aih-codexapp-1');
  assert.strictEqual(appServerSocketName('acc/表情!42'), 'aih-codexapp-acc42');
});

test('resident client is replaced when the default runtime fingerprint changes', () => {
  __resetClientsForTest();
  const first = getAppServerClient({
    runtimeScope: 'acct-runtime',
    runtimeFingerprint: 'fingerprint-1',
    endpoint: 'ws://127.0.0.1:1'
  });
  const reused = getAppServerClient({
    runtimeScope: 'acct-runtime',
    runtimeFingerprint: 'fingerprint-1',
    endpoint: 'ws://127.0.0.1:1'
  });
  const replaced = getAppServerClient({
    runtimeScope: 'acct-runtime',
    runtimeFingerprint: 'fingerprint-2',
    endpoint: 'ws://127.0.0.1:1'
  });

  assert.strictEqual(reused, first);
  assert.notStrictEqual(replaced, first);
});

test('resident client never reuses an unscoped cache entry for an account target', async (t) => {
  __resetClientsForTest();
  const mock = await createMockAppServer(() => {});
  let validatorCalls = 0;
  const unscoped = getAppServerClient({
    runtimeScope: 'account-target-cache',
    runtimeFingerprint: 'fingerprint-1',
    endpoint: mock.endpoint
  });
  const scoped = getAppServerClient({
    accountRef: 'acct_55555555555555555555',
    runtimeScope: 'account-target-cache',
    runtimeFingerprint: 'fingerprint-1',
    endpoint: mock.endpoint,
    async accountIdentityValidator() {
      validatorCalls += 1;
      const error = new Error('codex_account_identity_mismatch');
      error.code = 'codex_account_identity_mismatch';
      throw error;
    }
  });
  t.after(async () => {
    scoped.destroy();
    await mock.close();
  });

  assert.notStrictEqual(scoped, unscoped);
  await assert.rejects(
    scoped.request('thread/start', { cwd: '/tmp' }),
    (error) => error.code === 'codex_account_identity_mismatch'
  );
  assert.equal(validatorCalls, 1);
  assert.deepStrictEqual(
    mock.received.filter((message) => message.method).map((message) => message.method),
    ['initialize', 'initialized', 'account/read']
  );
});

test('resident client defers a runtime replacement while another session is active', () => {
  __resetClientsForTest();
  const first = getAppServerClient({
    runtimeScope: 'acct-active-runtime',
    runtimeFingerprint: 'fingerprint-1',
    endpoint: 'ws://127.0.0.1:1'
  });
  first.bindTurn('thread-active', {});

  assert.throws(() => getAppServerClient({
    runtimeScope: 'acct-active-runtime',
    runtimeFingerprint: 'fingerprint-2',
    endpoint: 'ws://127.0.0.1:1'
  }), (error) => {
    assert.strictEqual(error.code, 'codex_runtime_refresh_conflict');
    return true;
  });

  first.unbindTurn('thread-active');
  const replaced = getAppServerClient({
    runtimeScope: 'acct-active-runtime',
    runtimeFingerprint: 'fingerprint-2',
    endpoint: 'ws://127.0.0.1:1'
  });
  assert.notStrictEqual(replaced, first);
});

test('resident client leases close only after the final owner releases', () => {
  __resetClientsForTest();
  const options = {
    runtimeScope: 'acct-shared-runtime',
    runtimeFingerprint: 'fingerprint-1',
    endpoint: 'ws://127.0.0.1:1'
  };
  const first = acquireAppServerClient(options);
  const second = acquireAppServerClient(options);

  assert.strictEqual(first.client, second.client);
  assert.equal(first.release(), true);
  assert.strictEqual(getAppServerClient(options), second.client);
  assert.equal(first.release(), false);
  assert.equal(second.release(), true);
  assert.notStrictEqual(getAppServerClient(options), second.client);
});

test('runtime refresh fails closed while an idle resident client lease is held', () => {
  __resetClientsForTest();
  const first = acquireAppServerClient({
    runtimeScope: 'acct-held-runtime',
    runtimeFingerprint: 'fingerprint-1',
    endpoint: 'ws://127.0.0.1:1'
  });

  assert.throws(() => acquireAppServerClient({
    runtimeScope: 'acct-held-runtime',
    runtimeFingerprint: 'fingerprint-2',
    endpoint: 'ws://127.0.0.1:1'
  }), (error) => error.code === 'codex_runtime_refresh_conflict');

  first.release();
  const refreshed = acquireAppServerClient({
    runtimeScope: 'acct-held-runtime',
    runtimeFingerprint: 'fingerprint-2',
    endpoint: 'ws://127.0.0.1:1'
  });
  assert.notStrictEqual(refreshed.client, first.client);
  refreshed.release();
});

test('destroyed resident clients cannot reconnect or bind new turns', async () => {
  __resetClientsForTest();
  const stale = getAppServerClient({
    runtimeScope: 'acct-stale-runtime',
    runtimeFingerprint: 'fingerprint-1',
    endpoint: 'ws://127.0.0.1:1'
  });
  const current = getAppServerClient({
    runtimeScope: 'acct-stale-runtime',
    runtimeFingerprint: 'fingerprint-2',
    endpoint: 'ws://127.0.0.1:1'
  });

  await assert.rejects(
    stale.ensureConnected(),
    (error) => error.code === 'codex_app_server_client_closed'
  );
  assert.throws(
    () => stale.bindTurn('thread-stale', {}),
    (error) => error.code === 'codex_app_server_client_closed'
  );
  current.destroy();
});

test('app server launch honors the executable selected by the default runtime resolver', () => {
  const fallback = () => ({ command: '/fallback/codex', prefixArgs: ['legacy'] });

  assert.deepStrictEqual(resolveCodexAppServerLaunch({
    runtimeExecutablePath: '/aih/default/codex'
  }, {}, fallback), {
    command: '/aih/default/codex',
    prefixArgs: []
  });
  assert.deepStrictEqual(resolveCodexAppServerLaunch({}, {}, fallback), {
    command: '/fallback/codex',
    prefixArgs: ['legacy']
  });
});

test('account-scoped app server launch bypasses the desktop proxy only for account runtimes', () => {
  const base = {
    CODEX_HOME: '/profiles/codex/account/.codex',
    AIH_CODEX_APP_SERVER_PASSTHROUGH: 'inherited'
  };

  assert.deepStrictEqual(codexAppServerLaunchEnv(base), {
    ...base,
    AIH_CODEX_APP_SERVER_PASSTHROUGH: '1'
  });
  assert.deepStrictEqual(codexAppServerLaunchEnv(base, { gateway: true }), {
    CODEX_HOME: '/profiles/codex/account/.codex'
  });
  assert.deepStrictEqual(base, {
    CODEX_HOME: '/profiles/codex/account/.codex',
    AIH_CODEX_APP_SERVER_PASSTHROUGH: 'inherited'
  });
});

test('account-scoped resident clients require an identity validator', () => {
  __resetClientsForTest();
  assert.throws(() => getAppServerClient({
    accountRef: 'acct_11111111111111111111',
    runtimeScope: 'identity-required',
    endpoint: 'ws://127.0.0.1:1'
  }), (error) => error.code === 'codex_account_identity_validator_required');
});

test('resident client validates account identity before any thread request', async () => {
  __resetClientsForTest();
  const wss = new WebSocket.Server({ port: 0, host: '127.0.0.1' });
  const received = [];
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const message = JSON.parse(String(data));
      received.push(message);
      if (message.method === 'initialize') {
        ws.send(JSON.stringify({
          jsonrpc: '2.0', id: message.id,
          result: { codexHome: '/profiles/codex/account/.codex' }
        }));
      } else if (message.method === 'account/read') {
        ws.send(JSON.stringify({
          jsonrpc: '2.0', id: message.id,
          result: { account: { type: 'chatgpt', email: 'native@example.com' } }
        }));
      }
    });
  });
  await new Promise((resolve) => wss.once('listening', resolve));
  const client = getAppServerClient({
    runtimeScope: 'identity-ok',
    runtimeFingerprint: 'identity-ok-v1',
    endpoint: `ws://127.0.0.1:${wss.address().port}`,
    async accountIdentityValidator(input) {
      assert.equal(input.initializeResult.codexHome, '/profiles/codex/account/.codex');
      assert.equal(input.accountResult.account.email, 'native@example.com');
      return {
        ...verifiedOAuthIdentity(),
        email: 'must-not-leave-validator',
        accessToken: 'must-not-leave-validator'
      };
    }
  });

  await client.ensureConnected();

  assert.deepStrictEqual(
    received.filter((message) => message.method).map((message) => message.method),
    ['initialize', 'initialized', 'account/read']
  );
  const verified = client.getVerifiedAccountIdentity();
  assert.equal(verified.identityHash, 'a'.repeat(64));
  assert.equal(verified.runtimeHomeHash, 'b'.repeat(64));
  assert.equal(JSON.stringify(verified).includes('must-not-leave-validator'), false);
  client.destroy();
  await new Promise((resolve) => wss.close(resolve));
});

test('resident client accepts a verified API-key execution credential context', async () => {
  __resetClientsForTest();
  const mock = await createMockAppServer(() => {});
  const client = getAppServerClient({
    accountRef: 'acct_33333333333333333333',
    runtimeScope: 'api-key-context-ok',
    runtimeFingerprint: 'api-key-context-ok-v1',
    endpoint: mock.endpoint,
    async accountIdentityValidator() {
      return {
        verified: true,
        kind: 'api-key',
        assurance: 'execution-credential',
        executionAccountHash: 'c'.repeat(64),
        runtimeHomeHash: 'd'.repeat(64)
      };
    }
  });

  await client.ensureConnected();

  assert.deepStrictEqual(client.getVerifiedAccountIdentity(), {
    verified: true,
    kind: 'api-key',
    assurance: 'execution-credential',
    executionAccountHash: 'c'.repeat(64),
    runtimeHomeHash: 'd'.repeat(64)
  });
  client.destroy();
  await mock.close();
});

test('resident reconnect keeps identity verification as the transport barrier', async (t) => {
  __resetClientsForTest();
  const wss = new WebSocket.Server({ port: 0, host: '127.0.0.1' });
  const messages = [];
  let connectionCount = 0;
  let verificationCount = 0;
  const reconnectEvents = [];
  let releaseSecondVerification;
  const secondVerification = new Promise((resolve) => {
    releaseSecondVerification = resolve;
  });
  wss.on('connection', (ws) => {
    connectionCount += 1;
    const connection = connectionCount;
    ws.on('message', (data) => {
      const message = JSON.parse(String(data));
      messages.push({ connection, message });
      if (message.method === 'initialize') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
      } else if (message.method === 'account/read') {
        ws.send(JSON.stringify({
          jsonrpc: '2.0', id: message.id,
          result: { account: { type: 'chatgpt', email: 'native@example.com' } }
        }));
      } else if (message.method === 'thread/resume' || message.method === 'thread/read') {
        ws.send(JSON.stringify({
          jsonrpc: '2.0', id: message.id,
          result: { thread: { id: 'thread-1', turns: [] } }
        }));
      }
    });
  });
  await new Promise((resolve) => wss.once('listening', resolve));
  const client = getAppServerClient({
    runtimeScope: 'identity-reconnect-barrier',
    runtimeFingerprint: 'identity-reconnect-barrier-v1',
    endpoint: `ws://127.0.0.1:${wss.address().port}`,
    async accountIdentityValidator() {
      verificationCount += 1;
      if (verificationCount === 2) await secondVerification;
      return verifiedOAuthIdentity();
    }
  });
  t.after(async () => {
    client.destroy();
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
  });

  await client.ensureConnected();
  client.bindTurn('thread-1', {
    resumeParams: { threadId: 'thread-1', excludeTurns: true },
    onReconnectAttempt: (event) => reconnectEvents.push({ type: 'attempt', ...event }),
    onReconnectRecovered: (event) => reconnectEvents.push({ type: 'recovered', ...event })
  });
  [...wss.clients][0].terminate();
  await waitFor(() => verificationCount === 2, 5000, 'reconnect identity verification');

  let readSettled = false;
  const read = client.request('thread/read', { threadId: 'thread-1', includeTurns: true })
    .then((value) => { readSettled = true; return value; });
  const responseAccepted = client.respond(77, { decision: 'accept' });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const sentBeforeVerification = messages.some(({ connection, message }) => (
    connection === 2 && (message.method === 'thread/read' || message.id === 77)
  ));
  const settledBeforeVerification = readSettled;
  releaseSecondVerification();
  await read;
  await waitFor(() => messages.some(({ connection, message }) => (
    connection === 2 && message.method === 'thread/resume'
  )), 1000, 'thread resume after identity verification');

  assert.equal(responseAccepted, false);
  assert.equal(sentBeforeVerification, false);
  assert.equal(settledBeforeVerification, false);
  assert.equal(connectionCount, 2);
  assert.deepEqual(reconnectEvents, [
    { type: 'attempt', attempt: 1, maxAttempts: 8, delayMs: 500 },
    { type: 'recovered', attempt: 1 }
  ]);
});

test('resident client closes a mismatched identity before a thread request', async () => {
  __resetClientsForTest();
  const wss = new WebSocket.Server({ port: 0, host: '127.0.0.1' });
  const received = [];
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const message = JSON.parse(String(data));
      received.push(message);
      if (message.method === 'initialize') {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { codexHome: '/wrong' } }));
      } else if (message.method === 'account/read') {
        ws.send(JSON.stringify({
          jsonrpc: '2.0', id: message.id,
          result: { account: { type: 'apiKey' } }
        }));
      }
    });
  });
  await new Promise((resolve) => wss.once('listening', resolve));
  const client = getAppServerClient({
    runtimeScope: 'identity-mismatch',
    runtimeFingerprint: 'identity-mismatch-v1',
    endpoint: `ws://127.0.0.1:${wss.address().port}`,
    async accountIdentityValidator() {
      const error = new Error('codex_account_identity_mismatch');
      error.code = 'codex_account_identity_mismatch';
      throw error;
    }
  });

  await assert.rejects(
    client.request('thread/start', { cwd: '/tmp' }),
    (error) => error.code === 'codex_account_identity_mismatch'
  );

  assert.deepStrictEqual(
    received.filter((message) => message.method).map((message) => message.method),
    ['initialize', 'initialized', 'account/read']
  );
  assert.equal(client.getVerifiedAccountIdentity(), null);
  client.destroy();
  await new Promise((resolve) => wss.close(resolve));
});

test('resident client rejects an API-key result without execution-credential assurance', async () => {
  __resetClientsForTest();
  const mock = await createMockAppServer(() => {});
  const client = getAppServerClient({
    accountRef: 'acct_44444444444444444444',
    runtimeScope: 'identity-not-verified',
    runtimeFingerprint: 'identity-not-verified-v1',
    endpoint: mock.endpoint,
    async accountIdentityValidator() {
      return {
        verified: true,
        kind: 'api-key',
        assurance: 'mode_only',
        identityHash: 'c'.repeat(64)
      };
    }
  });

  await assert.rejects(
    client.request('thread/start', { cwd: '/tmp' }),
    (error) => error.code === 'codex_account_identity_not_verified'
  );
  assert.deepStrictEqual(
    mock.received.filter((message) => message.method).map((message) => message.method),
    ['initialize', 'initialized', 'account/read']
  );

  client.destroy();
  await mock.close();
});
