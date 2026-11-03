'use strict';

// ACP 协议适配器的单元守卫：不启真实子进程，用假 client 驱动
// `startAcpSessionTurn` 的握手 / 回放丢弃 / 事件映射 / 权限回执 / 失败上报。
// 真实子进程与转录收尾由 cline 的引擎测试覆盖；这里锁住协议层契约。

const test = require('node:test');
const assert = require('node:assert/strict');

const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const {
  acpChoices,
  createAcpSessionChild,
  startAcpSessionTurn
} = require('../lib/server/acp-session-runner');
const {
  resolveNativeChatTransport
} = require('../lib/server/native-session-chat-transport');

function createFakeClient(handlers = {}) {
  const requests = [];
  let notificationHandler = null;
  let requestHandler = null;

  const client = {
    requests,
    request(method, params = {}) {
      requests.push({ method, params });
      const handler = handlers[method];
      return handler ? Promise.resolve(handler(params, client)) : Promise.resolve({});
    },
    onNotification(handler) {
      notificationHandler = typeof handler === 'function' ? handler : null;
    },
    onRequest(handler) {
      requestHandler = typeof handler === 'function' ? handler : null;
    },
    notify(method, params) {
      if (notificationHandler) notificationHandler({ method, params });
    },
    askPermission(params) {
      if (!requestHandler) return Promise.resolve(undefined);
      return Promise.resolve(requestHandler({ method: 'session/request_permission', params }));
    }
  };
  return client;
}

function collectEvents() {
  const events = [];
  return { events, emitEvent: (event) => events.push(event) };
}

test('ACP 握手顺序、load 回放丢弃与 delta/tool 事件映射', async () => {
  const { events, emitEvent } = collectEvents();
  const permissionResponses = [];
  const client = createFakeClient({
    initialize: () => ({ protocolVersion: 1 }),
    authenticate: () => ({}),
    'session/load': (_params, fake) => {
      // load 响应前的 update 是历史回放：此时 handler 还没注册，必须被丢弃。
      fake.notify('session/update', {
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replay' } }
      });
      return {};
    },
    'session/prompt': async (_params, fake) => {
      permissionResponses.push(await fake.askPermission({
        options: [
          { optionId: 'allow-always', name: 'Always', kind: 'allow_always' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
        ]
      }));
      fake.notify('session/update', {
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } }
      });
      fake.notify('session/update', {
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } }
      });
      fake.notify('session/update', {
        update: { sessionUpdate: 'tool_call', title: 'read_file', kind: 'read' }
      });
      return { stopReason: 'end_turn' };
    }
  });

  await startAcpSessionTurn(client, {
    sessionId: 's-1',
    cwd: '/tmp/project',
    prompt: 'go on',
    authMethod: 'cline',
    approvalMode: 'bypass',
    emitEvent
  });

  assert.deepEqual(client.requests.map((item) => item.method), [
    'initialize',
    'authenticate',
    'session/load',
    'session/prompt'
  ]);
  assert.equal(client.requests[2].params.sessionId, 's-1');
  assert.equal(client.requests[3].params.prompt[0].text, 'go on');
  // 回放被丢弃，只有 load 之后的更新进入事件流。
  assert.deepEqual(events, [
    { type: 'thinking', thinking: 'thinking' },
    { type: 'delta', delta: 'hello' },
    { type: 'assistant_tool_call', content: 'read_file' }
  ]);
  // bypass 自动选 allow_always，优先于 allow_once/拒绝项。
  assert.deepEqual(permissionResponses, [
    { outcome: { outcome: 'selected', optionId: 'allow-always' } }
  ]);
});

test('非 bypass + 审批面：选项映射与用户选择回传', async () => {
  let captured = null;
  const approvalSurface = {
    request(input) {
      captured = input;
      input.resolve({ choiceId: 'reject-once' });
    }
  };
  const permissionResponses = [];
  const client = createFakeClient({
    initialize: () => ({}),
    'session/load': () => ({}),
    'session/prompt': async (_params, fake) => {
      permissionResponses.push(await fake.askPermission({
        toolCall: { kind: 'execute', title: 'rm -rf build', rawInput: { command: 'rm -rf build' } },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          { optionId: 'save-all', name: 'Always save', kind: 'allow_always' }
        ]
      }));
      return { stopReason: 'end_turn' };
    }
  });

  await startAcpSessionTurn(client, {
    sessionId: 's-2',
    prompt: 'run',
    approvalMode: 'confirm',
    approvalSurface
  });

  assert.deepEqual(permissionResponses, [
    { outcome: { outcome: 'selected', optionId: 'reject-once' } }
  ]);
  assert.ok(captured);
  assert.equal(captured.toolName, 'execute');
  assert.match(captured.title, /rm -rf build/);
  assert.deepEqual(captured.choices, [
    { id: 'allow-once', label: '允许一次', intent: 'accept' },
    { id: 'reject-once', label: '拒绝', intent: 'deny' },
    { id: 'save-all', label: '总是允许（保存到 CLI 配置）：Always save', intent: 'accept' }
  ]);
});

test('非 bypass 但没有审批面：fail closed，不静默放行工具', async () => {
  const failures = [];
  const permissionResponses = [];
  const client = createFakeClient({
    initialize: () => ({}),
    'session/load': () => ({}),
    'session/prompt': async (_params, fake) => {
      permissionResponses.push(await fake.askPermission({
        options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }]
      }));
      return { stopReason: 'end_turn' };
    }
  });

  await startAcpSessionTurn(client, {
    sessionId: 's-3',
    prompt: 'run',
    approvalMode: 'confirm',
    onFatal: (error) => failures.push(error)
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(permissionResponses, [{ outcome: { outcome: 'cancelled' } }]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, 'native_session_approval_bridge_unavailable');
});

test('newSession + plan 模式：session/new、set_mode、set_model 与 session-created', async () => {
  const { events, emitEvent } = collectEvents();
  const client = createFakeClient({
    initialize: () => ({}),
    'session/new': () => ({
      sessionId: 's-new',
      models: { availableModels: [{ id: 'gemini-3-pro' }] },
      modes: { availableModes: [{ id: 'plan' }] }
    }),
    'session/set_mode': () => ({}),
    'session/set_model': () => ({}),
    'session/prompt': () => ({ stopReason: 'end_turn' })
  });

  await startAcpSessionTurn(client, {
    sessionId: '',
    newSession: true,
    prompt: 'plan this',
    approvalMode: 'plan',
    model: 'gemini-3-pro',
    emitEvent
  });

  assert.deepEqual(client.requests.map((item) => item.method), [
    'initialize',
    'session/new',
    'session/set_mode',
    'session/set_model',
    'session/prompt'
  ]);
  assert.equal(client.requests[1].params.cwd, process.cwd());
  assert.deepEqual(events, [{ type: 'session-created', sessionId: 's-new' }]);
});

test('认证失败：onFatal 收到原始错误，且不进入 session/prompt', async () => {
  const failures = [];
  const client = createFakeClient({
    initialize: () => ({}),
    authenticate: () => Promise.reject(Object.assign(new Error('bad credentials'), { code: 'acp_auth_failed' }))
  });

  await startAcpSessionTurn(client, {
    sessionId: 's-4',
    prompt: 'run',
    authMethod: 'cline',
    onFatal: (error) => failures.push(error)
  });

  assert.deepEqual(client.requests.map((item) => item.method), ['initialize', 'authenticate']);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, 'acp_auth_failed');
});

test('进程死亡：prompt 被拒绝时 onFatal 收到 acp_session_process_exited', async () => {
  const failures = [];
  const client = createFakeClient({
    initialize: () => ({}),
    'session/load': () => ({}),
    'session/prompt': () => Promise.reject(Object.assign(new Error('ACP 进程已退出'), {
      code: 'acp_session_process_exited'
    }))
  });

  await startAcpSessionTurn(client, {
    sessionId: 's-5',
    prompt: 'run',
    onFatal: (error) => failures.push(error)
  });

  assert.deepEqual(client.requests.map((item) => item.method), [
    'initialize',
    'session/load',
    'session/prompt'
  ]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, 'acp_session_process_exited');
});

test('ACP 选项映射：未知 kind 按拒绝处理，持久化 allow_always 标注保存语义', () => {
  assert.deepEqual(acpChoices([
    { optionId: 'a', kind: 'allow_once', name: 'A' },
    { optionId: 'b', kind: 'reject_once', name: 'B' },
    { optionId: 'proceed_always_and_save', kind: 'allow_always', name: 'C' },
    { optionId: 'd', kind: 'mystery', name: 'D' },
    { optionId: '', kind: 'allow_once', name: 'ignored' }
  ]), [
    { id: 'a', label: '允许一次', intent: 'accept' },
    { id: 'b', label: '拒绝', intent: 'deny' },
    { id: 'proceed_always_and_save', label: '总是允许（保存到 CLI 配置）：C', intent: 'accept' },
    { id: 'd', label: 'D', intent: 'deny' }
  ]);
});


function createFakeAcpProcess() {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.exitCode = null;
  proc.killed = false;
  const writes = [];
  proc.stdin.on('data', (chunk) => writes.push(String(chunk)));
  proc.kill = () => {
    proc.killed = true;
    proc.emit('exit', 0);
  };
  return { proc, writes };
}

test('ACP child：分片 NDJSON 帧能拼回响应，请求 id 递增', async () => {
  const { proc, writes } = createFakeAcpProcess();
  const { client } = createAcpSessionChild({ command: 'fake-acp', spawnImpl: () => proc });

  const pending = client.request('initialize', { protocolVersion: 1 });
  const sent = JSON.parse(writes.join('').trim());
  assert.equal(sent.jsonrpc, '2.0');
  assert.equal(sent.id, 1);
  assert.equal(sent.method, 'initialize');

  // 故意把一帧拆成两次 data，验证 stdout 缓冲区。
  proc.stdout.write('{"jsonrpc":"2.0","id":1,');
  proc.stdout.write('"result":{"protocolVersion":1}}\n');
  assert.deepEqual(await pending, { protocolVersion: 1 });
});

test('ACP child：agent→client 请求用原 id 回复，通知走 handler', async () => {
  const { proc, writes } = createFakeAcpProcess();
  const { client } = createAcpSessionChild({ command: 'fake-acp', spawnImpl: () => proc });
  const notifications = [];
  client.onNotification((notification) => notifications.push(notification));
  client.onRequest((request) => {
    assert.equal(request.method, 'session/request_permission');
    assert.equal(request.id, 0);
    return { outcome: { outcome: 'selected', optionId: 'allow-once' } };
  });

  proc.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 0,
    method: 'session/request_permission',
    params: { options: [{ optionId: 'allow-once', kind: 'allow_once' }] }
  }) + '\n');
  proc.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } }
  }) + '\n');

  await new Promise((resolve) => setImmediate(resolve));
  const responses = writes.join('').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(responses, [{
    jsonrpc: '2.0',
    id: 0,
    result: { outcome: { outcome: 'selected', optionId: 'allow-once' } }
  }]);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].method, 'session/update');
});

test('ACP child：进程退出会拒绝所有未完成请求', async () => {
  const { proc } = createFakeAcpProcess();
  const { client } = createAcpSessionChild({ command: 'fake-acp', spawnImpl: () => proc });
  const pending = client.request('session/prompt', { sessionId: 's', prompt: [] });
  proc.exitCode = 1;
  proc.emit('exit', 1);
  await assert.rejects(pending, (error) => error.code === 'acp_session_process_exited');
});


test('引擎接线：cline 续聊选择 acp-session，新会话仍走 headless-stream', () => {
  assert.deepEqual(resolveNativeChatTransport('cline'), {
    mode: 'headless-stream',
    promptDelivery: 'argv',
    streamUsage: false
  });
  assert.deepEqual(resolveNativeChatTransport('cline', { isResume: true }), {
    mode: 'acp-session',
    promptDelivery: 'argv',
    streamUsage: false
  });
  // 未声明 resumeMode 的 provider 保持普通轮次形态，不会被误路由到 ACP。
  assert.equal(resolveNativeChatTransport('gemini', { isResume: true }).mode, 'pty-transcript');
});
