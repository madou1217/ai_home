'use strict';

// Codex app-server adapter：用假 client 驱动，不连真 WS、不起子进程。
// 验的是「协议消息 → 契约事件/交互」的翻译与回写形状，不是 codex 本体。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAdapter } = require('../lib/agent-session/adapters/codex-app-server');
const { createEventBus } = require('../lib/agent-session/event-bus');
const { createInteractionRouter } = require('../lib/agent-session/interaction-router');
const { createAgentSession } = require('../lib/agent-session/session');

const THREAD_ID = 'thread-1';

function createFakeClient(overrides = {}) {
  const requests = [];
  const responses = [];
  const errors = [];
  let binding = null;
  let boundThreadId = '';
  let destroyed = 0;
  return {
    requests,
    responses,
    errors,
    get binding() { return binding; },
    get boundThreadId() { return boundThreadId; },
    get destroyed() { return destroyed; },
    async ensureConnected() {},
    async request(method, params) {
      requests.push({ method, params });
      const result = typeof overrides.request === 'function' ? overrides.request(method, params) : undefined;
      if (result !== undefined) return result;
      if (method === 'thread/start') return { thread: { id: THREAD_ID } };
      if (method === 'thread/resume') return { thread: { id: params.threadId } };
      if (method === 'model/list') {
        return { data: [{ model: 'gpt-5-codex', displayName: 'GPT-5 Codex', isDefault: true }] };
      }
      if (method === 'turn/start') return { turn: { id: 'turn-1' } };
      if (method === 'turn/interrupt') return {};
      throw Object.assign(new Error(`unexpected method ${method}`), { code: 'fake_unexpected_method' });
    },
    respond(id, result) {
      responses.push({ id, result });
      return true;
    },
    respondError(id, code, message) {
      errors.push({ id, code, message });
      return true;
    },
    bindTurn(thread, next) {
      boundThreadId = thread;
      binding = next;
    },
    unbindTurn() { binding = null; },
    destroy() { destroyed += 1; }
  };
}

function createHarness(options = {}) {
  const client = options.client || createFakeClient(options.overrides);
  const adapter = createAdapter({
    sessionId: 's1',
    provider: 'codex',
    transport: 'codex-app-server',
    context: { client }
  });
  const bus = createEventBus({ sessionId: 's1' });
  const router = createInteractionRouter({ sessionId: 's1', bus });
  const session = createAgentSession({ sessionId: 's1', adapter, bus, router });
  const events = [];
  session.subscribe((event) => events.push(event));
  return { adapter, bus, client, events, router, session };
}

function requested(events) {
  return events.filter((event) => event.type === 'interaction.requested');
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('open starts a thread, applies the approval mode and reports models and modes', async () => {
  const { client, session } = createHarness();
  const result = await session.open({ cwd: '/tmp/project', mode: 'confirm' });
  assert.equal(result.sessionId, THREAD_ID);
  assert.deepEqual(result.models.map((entry) => entry.id), ['gpt-5-codex']);
  assert.deepEqual(result.modes.map((entry) => entry.id), ['bypass', 'confirm', 'plan']);
  const start = client.requests.find((entry) => entry.method === 'thread/start');
  assert.equal(start.params.cwd, '/tmp/project');
  assert.equal(start.params.approvalPolicy, 'untrusted');
  assert.equal(start.params.sandbox, 'workspace-write');
  assert.equal(client.boundThreadId, THREAD_ID);
});

test('open with newSession:false resumes the given native thread', async () => {
  const { client, session } = createHarness();
  await session.open({ newSession: false, threadId: 'thread-old', mode: 'bypass' });
  const resume = client.requests.find((entry) => entry.method === 'thread/resume');
  assert.equal(resume.params.threadId, 'thread-old');
  assert.equal(resume.params.approvalPolicy, 'never');
  assert.equal(client.boundThreadId, 'thread-old');
});

test('open without a thread id refuses to silently start a new session', async () => {
  const { session } = createHarness();
  await assert.rejects(
    () => session.open({ newSession: false }),
    (error) => error.code === 'codex_thread_id_required'
  );
});

test('all three approval methods become canonical approval interactions', async () => {
  const cases = [
    {
      id: 11,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: THREAD_ID,
        itemId: 'item-1',
        command: 'npm test',
        cwd: '/tmp/project',
        availableDecisions: ['accept', 'decline']
      },
      intents: ['accept', 'deny'],
      result: { decision: 'accept' }
    },
    {
      id: 12,
      method: 'item/fileChange/requestApproval',
      params: { threadId: THREAD_ID, itemId: 'item-2' },
      intents: ['accept', 'accept', 'deny', 'cancel'],
      result: { decision: 'accept' }
    },
    {
      id: 13,
      method: 'item/permissions/requestApproval',
      params: { threadId: THREAD_ID, itemId: 'item-3', permissions: { network: true } },
      intents: ['accept', 'accept', 'accept', 'deny'],
      result: { permissions: { network: true }, scope: 'turn' }
    }
  ];
  const { client, events, session } = createHarness();
  await session.open({ mode: 'confirm' });
  for (const entry of cases) {
    const before = requested(events).length;
    client.binding.onServerRequest({ id: entry.id, method: entry.method, params: entry.params });
    const requests = requested(events);
    assert.equal(requests.length, before + 1, `${entry.method} 没有变成交互`);
    const payload = requests[requests.length - 1].payload;
    assert.equal(payload.kind, 'approval');
    assert.equal(payload.payload.choices[0].intent, 'accept');
    assert.deepEqual(payload.payload.choices.map((choice) => choice.intent), entry.intents);
    session.respond(payload.interactionId, { choiceId: 'choice-0' });
    assert.deepEqual(client.responses[client.responses.length - 1], { id: entry.id, result: entry.result });
  }
  assert.equal(client.responses.length, cases.length);
});

test('requestUserInput becomes a question and answers go back in the native shape', async () => {
  const { client, events, session } = createHarness();
  await session.open({ mode: 'confirm' });
  client.binding.onServerRequest({
    id: 21,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: THREAD_ID,
      itemId: 'item-q',
      questions: [{
        id: 'q1',
        header: 'Mode',
        question: 'Pick one',
        options: [{ label: 'Fast' }, { label: 'Safe' }],
        isOther: false
      }]
    }
  });
  const payload = requested(events)[0].payload;
  assert.equal(payload.kind, 'question');
  // 这条请求没有 turnId：router 会把 null 折叠成「不带该字段」。
  assert.equal(payload.turnId, undefined);
  assert.deepEqual(payload.payload.fields.map((field) => field.id), ['q1']);
  assert.equal(payload.payload.fields[0].type, 'single_select');
  assert.equal(payload.payload.answerShape, 'answers');
  session.respond(payload.interactionId, { action: 'submit', answers: { q1: 'Fast' } });
  assert.deepEqual(client.responses, [{ id: 21, result: { answers: { q1: { answers: ['Fast'] } } } }]);
});

test('declining a user-input question fails closed instead of faking an empty answer', async () => {
  const { client, events, session } = createHarness();
  await session.open({ mode: 'confirm' });
  client.binding.onServerRequest({
    id: 22,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: THREAD_ID,
      itemId: 'item-q',
      questions: [{ id: 'q1', question: 'Pick one', options: [{ label: 'Fast' }], isOther: false }]
    }
  });
  const interactionId = requested(events)[0].payload.interactionId;
  // app-server 的 requestUserInput 回复里没有「拒绝」这一档：宁可报错，
  // 也不能编一个空答案回过去冒充用户选择。
  // 外壳现在在 router 层就拦下未声明的动作，所以交互仍然 pending、可以改选合法项。
  assert.throws(
    () => session.respond(interactionId, { action: 'decline' }),
    (error) => error.code === 'agent_session_decision_action_not_offered'
  );
  assert.equal(client.responses.length, 0);
  assert.equal(session.router.pendingCount(), 1);
  session.respond(interactionId, { action: 'submit', answers: { q1: 'Fast' } });
  assert.equal(client.responses.length, 1);
});

test('a second answer never sends a second JSON-RPC response', async () => {
  const { client, events, session } = createHarness();
  await session.open({ mode: 'confirm' });
  client.binding.onServerRequest({
    id: 31,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: THREAD_ID, itemId: 'item-1', command: 'ls', availableDecisions: ['accept', 'decline'] }
  });
  const interactionId = requested(events)[0].payload.interactionId;
  session.respond(interactionId, { choiceId: 'choice-0' });
  assert.throws(
    () => session.respond(interactionId, { choiceId: 'choice-1' }),
    (error) => error.code === 'agent_session_interaction_already_resolved'
  );
  assert.equal(client.responses.length, 1);
});

test('a plan update in plan mode raises plan_confirmation and answers locally', async () => {
  const { client, events, session } = createHarness();
  await session.open({ mode: 'plan' });
  const notification = {
    method: 'turn/plan/updated',
    params: {
      threadId: THREAD_ID,
      turnId: 'turn-1',
      explanation: 'Two steps',
      plan: [{ step: 'Read the code', status: 'pending' }, { step: 'Write the test', status: 'pending' }]
    }
  };
  client.binding.onNotification(notification);
  const requests = requested(events);
  assert.equal(requests.length, 1);
  const payload = requests[0].payload;
  assert.equal(payload.kind, 'plan_confirmation');
  assert.deepEqual(payload.payload.actions, ['submit', 'cancel']);
  assert.equal(payload.payload.answerShape, 'answers');
  assert.equal(payload.payload.fields[0].id, 'choice');
  assert.match(payload.payload.presentation.message, /Read the code/);
  const resolved = session.respond(payload.interactionId, {
    action: 'submit',
    answers: { choice: 'implement' }
  });
  assert.equal(resolved.state, 'resolved');
  // turn/plan/updated 是通知，没有 JSON-RPC id：不能凭空发一条响应出去。
  assert.equal(client.responses.length, 0);
  // 同一 turn 的后续计划更新不再重复弹确认。
  client.binding.onNotification(notification);
  assert.equal(requested(events).length, 1);
});

test('plan updates outside plan mode stay plain timeline items', async () => {
  const { client, events, session } = createHarness();
  await session.open({ mode: 'confirm' });
  client.binding.onNotification({
    method: 'turn/plan/updated',
    params: { threadId: THREAD_ID, turnId: 'turn-1', plan: [{ step: 'Do it', status: 'pending' }] }
  });
  assert.equal(requested(events).length, 0);
  assert.ok(events.some((event) => event.type === 'timeline.item.updated'));
});

test('notifications become timeline events without duplicating shell-owned events', async () => {
  const { client, events, session } = createHarness();
  await session.open({ mode: 'confirm' });
  const before = events.length;
  client.binding.onNotification({
    method: 'item/agentMessage/delta',
    params: { threadId: THREAD_ID, turnId: 'turn-1', itemId: 'item-1', delta: 'hi' }
  });
  client.binding.onNotification({
    method: 'turn/completed',
    params: { threadId: THREAD_ID, turn: { id: 'turn-1', status: 'completed' } }
  });
  const added = events.slice(before).map((event) => event.type);
  assert.deepEqual(added, ['timeline.item.delta']);
});

test('a disconnect fails the in-flight prompt with a coded error', async () => {
  const { client, session } = createHarness();
  await session.open({ mode: 'confirm' });
  const pending = session.prompt({ text: 'hello' });
  await flush();
  client.binding.onDisconnected(Object.assign(new Error('socket closed'), { code: 'codex_app_server_disconnected' }));
  await assert.rejects(() => pending, (error) => error.code === 'codex_app_server_disconnected');
  assert.equal(session.state, 'idle');
});

// 直接打 adapter.cancel 而不是 session.cancel：外壳的 cancel 正在被别人改
// （running → interrupting 目前不在 TRANSITIONS 里），adapter 这一侧的行为不该跟着抖。
test('cancel interrupts the active native turn and the prompt settles as cancelled', async () => {
  const { adapter, client, session } = createHarness();
  await session.open({ mode: 'confirm' });
  const pending = session.prompt({ text: 'go' });
  await flush();
  const result = await adapter.cancel('user');
  assert.deepEqual(result, { cancelled: true, reason: 'user' });
  const interrupt = client.requests.find((entry) => entry.method === 'turn/interrupt');
  assert.deepEqual(interrupt.params, { threadId: THREAD_ID, turnId: 'turn-1' });
  const settled = await pending;
  assert.equal(settled.stopReason, 'cancelled');
  assert.equal(session.state, 'idle');
  // codex 的确认帧晚到也不能再把会话推回一次 idle→idle。
  client.binding.onNotification({
    method: 'turn/completed',
    params: { threadId: THREAD_ID, turn: { id: 'turn-1', status: 'interrupted' } }
  });
  assert.equal(session.state, 'idle');
});

test('a failed native turn rejects the prompt with a code', async () => {
  const { client, session } = createHarness();
  await session.open({ mode: 'confirm' });
  const pending = session.prompt({ text: 'go' });
  await flush();
  client.binding.onNotification({
    method: 'turn/completed',
    params: {
      threadId: THREAD_ID,
      turn: { id: 'turn-1', status: 'failed', error: { message: 'upstream boom' } }
    }
  });
  await assert.rejects(() => pending, (error) => error.code === 'codex_turn_failed' && /upstream boom/.test(error.message));
});

test('an invalid interaction request is answered with an error instead of being dropped', async () => {
  const { client, events, session } = createHarness();
  await session.open({ mode: 'confirm' });
  client.binding.onServerRequest({
    id: 41,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: THREAD_ID, itemId: 'item-1' }
  });
  assert.equal(requested(events).length, 0);
  assert.equal(client.errors.length, 1);
  assert.equal(client.errors[0].id, 41);
});

test('an unknown interaction id is refused before anything reaches the harness', async () => {
  const { adapter } = createHarness();
  assert.throws(
    () => adapter.respond('nope', { choiceId: 'choice-0' }),
    (error) => error.code === 'codex_interaction_not_pending'
  );
});

test('setMode rejects modes the protocol table does not know', async () => {
  const { adapter } = createHarness();
  assert.deepEqual(adapter.setMode('plan'), { mode: 'plan' });
  assert.throws(() => adapter.setMode('yolo'), (error) => error.code === 'agent_session_mode_unknown');
});
