const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CONFIRM_PERMISSION_RULES,
  createServeEventMapper,
  servePortForAccount,
  serveSocketForAccount,
  startOpenCodeServeTurn
} = require('../lib/server/opencode-serve-runner');
const { decideApproval } = require('../lib/server/native-approval-bridge');

// P3c:opencode confirm 审批模式 runner——serve SSE 事件映射 + 审批桥往返(fake client 驱动)。

const SID = 'ses_test0001';

function props(extra = {}) {
  return { sessionID: SID, ...extra };
}

function waitFor(check, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      let value = null;
      try { value = check(); } catch (_e) { value = null; }
      if (value) {
        clearInterval(timer);
        resolve(value);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error('waitFor 超时'));
      }
    }, intervalMs);
  });
}

function createFakeClient({ createdSessionId = SID } = {}) {
  const calls = {
    createSession: [],
    updateSessionPermissions: [],
    promptAsync: [],
    replyPermission: [],
    abortSession: []
  };
  let handler = null;
  const client = {
    calls,
    emit(event) {
      if (handler) handler(event);
    },
    async createSession(opts) {
      calls.createSession.push(opts || {});
      return { id: createdSessionId, directory: (opts && opts.directory) || '' };
    },
    async updateSessionPermissions(sessionId, rules) {
      calls.updateSessionPermissions.push({ sessionId, rules });
      return {};
    },
    async promptAsync(sessionId, body) {
      calls.promptAsync.push({ sessionId, body });
      return true;
    },
    async replyPermission(permissionId, reply, message) {
      calls.replyPermission.push({ permissionId, reply, message });
      return true;
    },
    async abortSession(sessionId) {
      calls.abortSession.push(sessionId);
      return true;
    },
    openEventStream({ onEvent }) {
      handler = onEvent;
      setImmediate(() => client.emit({ type: 'server.connected' }));
      return {
        close() { handler = null; }
      };
    }
  };
  return client;
}

function createFakeBus() {
  const published = [];
  return {
    published,
    publish(session, event) {
      published.push({ session, event });
      return true;
    }
  };
}

function startTurn(fake, bus, events, overrides = {}) {
  return startOpenCodeServeTurn({
    accountId: '1',
    sessionId: '',
    projectPath: '/tmp/oc-proj',
    projectDirName: '',
    prompt: '跑个命令',
    model: 'opencode-go/glm-5.2',
    ensureServeImpl: async () => ({ baseUrl: 'http://127.0.0.1:1', port: 1, socket: 's' }),
    clientFactory: () => fake,
    sessionEventBus: bus,
    onEvent: (event) => events.push(event),
    ...overrides
  });
}

test('端口/socket 按账号确定性派生', () => {
  assert.equal(servePortForAccount('1'), servePortForAccount('1'));
  assert.notEqual(servePortForAccount('1'), servePortForAccount('2'));
  const port = servePortForAccount('1');
  assert.ok(port >= 46300 && port < 47000, `端口在预留区间:${port}`);
  assert.match(serveSocketForAccount('a/b c'), /^aih-run-ocserveabc$/);
});

test('事件映射器:只收本会话 assistant 文本;reasoning/用户回显/他会话不进正文;工具卡成对', () => {
  const out = [];
  let idle = false;
  const mapper = createServeEventMapper({
    sessionId: SID,
    emit: (event) => out.push(event),
    onIdle: () => { idle = true; }
  });

  // 用户消息 + 自己 prompt 的 text part → 不产出
  mapper.handle({ type: 'message.updated', properties: props({ info: { id: 'msg_u', role: 'user', sessionID: SID } }) });
  mapper.handle({ type: 'message.part.updated', properties: props({ part: { id: 'prt_u', messageID: 'msg_u', sessionID: SID, type: 'text', text: '跑个命令' } }) });
  // 别的会话的事件 → 全部忽略
  mapper.handle({ type: 'message.part.delta', properties: { sessionID: 'ses_other', messageID: 'msg_x', partID: 'prt_x', field: 'text', delta: '漏' } });
  // 无 sessionID 的事件 → 忽略
  mapper.handle({ type: 'session.idle', properties: {} });
  assert.equal(idle, false);

  // assistant 消息:reasoning part 的 delta 不进正文
  mapper.handle({ type: 'message.updated', properties: props({ info: { id: 'msg_a', role: 'assistant', sessionID: SID } }) });
  mapper.handle({ type: 'message.part.updated', properties: props({ part: { id: 'prt_r', messageID: 'msg_a', sessionID: SID, type: 'reasoning', text: '' } }) });
  mapper.handle({ type: 'message.part.delta', properties: props({ messageID: 'msg_a', partID: 'prt_r', field: 'text', delta: '思考中' }) });

  // 工具 part:pending 不发;running(带 input)发 call;completed 发 result
  mapper.handle({ type: 'message.part.updated', properties: props({ part: { id: 'prt_t', messageID: 'msg_a', sessionID: SID, type: 'tool', tool: 'bash', callID: 'call_1', state: { status: 'pending', input: {} } } }) });
  assert.equal(out.length, 0);
  mapper.handle({ type: 'message.part.updated', properties: props({ part: { id: 'prt_t', messageID: 'msg_a', sessionID: SID, type: 'tool', tool: 'bash', callID: 'call_1', state: { status: 'running', input: { command: 'echo hi' } } } }) });
  mapper.handle({ type: 'message.part.updated', properties: props({ part: { id: 'prt_t', messageID: 'msg_a', sessionID: SID, type: 'tool', tool: 'bash', callID: 'call_1', state: { status: 'completed', input: { command: 'echo hi' }, output: 'hi' } } }) });
  assert.equal(out[0].type, 'assistant_tool_call');
  assert.match(out[0].content, /:::tool\{name="bash"\}/);
  assert.match(out[0].content, /echo hi/);
  assert.equal(out[1].type, 'assistant_tool_result');
  assert.match(out[1].content, /:::tool-result\nhi\n:::/);

  // assistant text part:delta 流式 + 最终 part.updated 补尾不重复
  mapper.handle({ type: 'message.part.updated', properties: props({ part: { id: 'prt_txt', messageID: 'msg_a', sessionID: SID, type: 'text', text: '' } }) });
  mapper.handle({ type: 'message.part.delta', properties: props({ messageID: 'msg_a', partID: 'prt_txt', field: 'text', delta: '输出是' }) });
  mapper.handle({ type: 'message.part.delta', properties: props({ messageID: 'msg_a', partID: 'prt_txt', field: 'text', delta: ' hi' }) });
  mapper.handle({ type: 'message.part.updated', properties: props({ part: { id: 'prt_txt', messageID: 'msg_a', sessionID: SID, type: 'text', text: '输出是 hi!' } }) });
  const deltas = out.filter((event) => event.type === 'delta').map((event) => event.delta);
  assert.deepEqual(deltas, ['输出是', ' hi', '!']);
  assert.equal(mapper.state.content, '输出是 hi!');

  mapper.handle({ type: 'session.idle', properties: props() });
  assert.equal(idle, true);
});

test('工具 error 状态:result 卡带错误文本', () => {
  const out = [];
  const mapper = createServeEventMapper({ sessionId: SID, emit: (event) => out.push(event) });
  mapper.handle({ type: 'message.updated', properties: props({ info: { id: 'msg_a', role: 'assistant', sessionID: SID } }) });
  mapper.handle({ type: 'message.part.updated', properties: props({ part: { id: 'prt_t', messageID: 'msg_a', sessionID: SID, type: 'tool', tool: 'bash', state: { status: 'error', input: { command: 'rm x' }, error: 'The user rejected permission' } } }) });
  assert.equal(out[0].type, 'assistant_tool_call');
  assert.equal(out[1].type, 'assistant_tool_result');
  assert.match(out[1].content, /rejected permission/);
});

test('事件映射器把 session.status retry 透传为 canonical retry status', () => {
  const out = [];
  const mapper = createServeEventMapper({ sessionId: SID, emit: (event) => out.push(event) });
  mapper.handle({
    type: 'session.status',
    properties: props({
      status: { type: 'retry', attempt: 2, message: 'Provider is busy', next: 1_800_000_000_000 }
    })
  });

  assert.deepEqual(out, [{
    type: 'retry-status',
    phase: 'scheduled',
    source: 'provider-runtime',
    provider: 'opencode',
    attempt: 2,
    retryAt: 1_800_000_000_000,
    message: 'Provider is busy'
  }]);
});

test('confirm 全链路(allow):建会话→注入 ask 规则→prompt→permission 挂起→审批桥 allow→reply once→idle 收尾', async () => {
  const fake = createFakeClient();
  const bus = createFakeBus();
  const events = [];
  const handle = startTurn(fake, bus, events);

  // 建会话:directory=projectPath;session-created 事件带 runId
  await waitFor(() => fake.calls.promptAsync.length > 0);
  assert.deepEqual(fake.calls.createSession[0], { directory: '/tmp/oc-proj' });
  const createdEvent = events.find((event) => event.type === 'session-created');
  assert.equal(createdEvent.sessionId, SID);
  assert.equal(createdEvent.runId, handle.runId);
  // 会话级 ask 规则注入
  assert.deepEqual(fake.calls.updateSessionPermissions[0].rules, CONFIRM_PERMISSION_RULES);
  // prompt_async 带解析后的模型
  assert.deepEqual(fake.calls.promptAsync[0].body.model, { providerID: 'opencode-go', modelID: 'glm-5.2' });

  // 权限挂起 → 审批桥登记 + approval-request 事件发布
  fake.emit({ type: 'permission.asked', properties: props({ id: 'per_1', permission: 'bash', patterns: ['echo hi'], tool: { callID: 'call_1' } }) });
  const prompt = await waitFor(() => handle.getActivePrompt());
  assert.equal(prompt.kind, 'approval');
  assert.match(prompt.question, /bash/);
  const requestPublished = bus.published.find((item) => item.event.type === 'session:approval-request');
  assert.equal(requestPublished.session.sessionId, SID);
  assert.equal(requestPublished.event.runId, handle.runId);
  assert.equal(requestPublished.event.prompt.approvalId, prompt.approvalId);

  // webUI 决策 allow → reply once + approval-resolved(reason=allow)
  decideApproval(prompt.approvalId, 'allow');
  await waitFor(() => fake.calls.replyPermission.length > 0);
  assert.equal(fake.calls.replyPermission[0].permissionId, 'per_1');
  assert.equal(fake.calls.replyPermission[0].reply, 'once');
  const resolvedPublished = bus.published.find((item) => item.event.type === 'session:approval-resolved');
  assert.equal(resolvedPublished.event.reason, 'allow');
  assert.equal(resolvedPublished.event.promptId, prompt.approvalId);
  assert.equal(handle.getActivePrompt(), null);

  // 正文 + idle → result 事件 + done 兑现
  fake.emit({ type: 'message.updated', properties: props({ info: { id: 'msg_a', role: 'assistant', sessionID: SID } }) });
  fake.emit({ type: 'message.part.updated', properties: props({ part: { id: 'prt_txt', messageID: 'msg_a', sessionID: SID, type: 'text', text: '' } }) });
  fake.emit({ type: 'message.part.delta', properties: props({ messageID: 'msg_a', partID: 'prt_txt', field: 'text', delta: '完成' }) });
  fake.emit({ type: 'session.idle', properties: props() });
  const result = await handle.done;
  assert.equal(result.sessionId, SID);
  assert.equal(result.content, '完成');
  assert.ok(events.some((event) => event.type === 'result' && event.content === '完成'));
  assert.ok(events.some((event) => event.type === 'delta' && event.delta === '完成'));
});

test('confirm 全链路(deny):审批桥 deny → reply reject 带反馈;resume 轮不建会话', async () => {
  const fake = createFakeClient();
  const bus = createFakeBus();
  const events = [];
  const handle = startTurn(fake, bus, events, { sessionId: SID });

  await waitFor(() => fake.calls.promptAsync.length > 0);
  assert.equal(fake.calls.createSession.length, 0, 'resume 不重建会话');
  assert.equal(fake.calls.updateSessionPermissions[0].sessionId, SID, 'resume 同样注入 ask 规则');

  fake.emit({ type: 'permission.asked', properties: props({ id: 'per_2', permission: 'external_directory', patterns: ['/tmp/*'], tool: { callID: 'call_9' } }) });
  const prompt = await waitFor(() => handle.getActivePrompt());
  decideApproval(prompt.approvalId, 'deny', '不允许动这个目录');
  await waitFor(() => fake.calls.replyPermission.length > 0);
  assert.equal(fake.calls.replyPermission[0].reply, 'reject');
  assert.equal(fake.calls.replyPermission[0].message, '不允许动这个目录');
  const resolvedPublished = bus.published.find((item) => item.event.type === 'session:approval-resolved');
  assert.equal(resolvedPublished.event.reason, 'deny');

  fake.emit({ type: 'session.idle', properties: props() });
  const result = await handle.done;
  assert.equal(result.sessionId, SID);
});

test('外部决议(permission.replied):收起审批卡、不重复 reply', async () => {
  const fake = createFakeClient();
  const bus = createFakeBus();
  const handle = startTurn(fake, bus, [], { sessionId: SID });
  await waitFor(() => fake.calls.promptAsync.length > 0);

  fake.emit({ type: 'permission.asked', properties: props({ id: 'per_3', permission: 'bash', patterns: ['x'], tool: {} }) });
  await waitFor(() => handle.getActivePrompt());
  fake.emit({ type: 'permission.replied', properties: props({ requestID: 'per_3', reply: 'reject' }) });
  await waitFor(() => !handle.getActivePrompt());
  assert.equal(fake.calls.replyPermission.length, 0, '别的客户端已回复,不再重复 reply');
  const resolvedPublished = bus.published.find((item) => item.event.type === 'session:approval-resolved');
  assert.equal(resolvedPublished.event.reason, 'deny');

  fake.emit({ type: 'session.idle', properties: props() });
  await handle.done;
});

test('session.error → done 拒绝(coded);abort → abortSession + 挂起审批清空', async () => {
  {
    const fake = createFakeClient();
    const handle = startTurn(fake, createFakeBus(), [], { sessionId: SID });
    await waitFor(() => fake.calls.promptAsync.length > 0);
    fake.emit({ type: 'session.error', properties: props({ error: { message: 'provider blew up' } }) });
    await assert.rejects(handle.done, (error) => {
      assert.equal(error.code, 'opencode_serve_session_error');
      assert.match(error.message, /provider blew up/);
      return true;
    });
  }
  {
    const fake = createFakeClient();
    const handle = startTurn(fake, createFakeBus(), [], { sessionId: SID });
    await waitFor(() => fake.calls.promptAsync.length > 0);
    fake.emit({ type: 'permission.asked', properties: props({ id: 'per_4', permission: 'bash', patterns: [], tool: {} }) });
    await waitFor(() => handle.getActivePrompt());
    handle.abort();
    await assert.rejects(handle.done, (error) => {
      assert.equal(error.code, 'native_session_aborted');
      return true;
    });
    assert.deepEqual(fake.calls.abortSession, [SID]);
    assert.equal(handle.getActivePrompt(), null, 'run 结束挂起审批被清空');
  }
});

test('ensureServe 失败 → done 拒绝;writeInput 不支持;resize no-op', async () => {
  const fake = createFakeClient();
  const handle = startTurn(fake, createFakeBus(), [], {
    ensureServeImpl: async () => {
      const error = new Error('serve 起不来');
      error.code = 'opencode_serve_start_failed';
      throw error;
    }
  });
  await assert.rejects(handle.done, (error) => {
    assert.equal(error.code, 'opencode_serve_start_failed');
    return true;
  });
  assert.throws(() => handle.writeInput('x'), (error) => error.code === 'native_input_unsupported');
  assert.equal(handle.resize(80, 24), false);
});
