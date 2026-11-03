'use strict';

// 外壳装配：adapter 只吐契约事件，外壳负责 fan-out、单答者仲裁、生命周期收尾。
// 用一个假 adapter 就能验证这三件事，不需要真起 harness。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createEventBus } = require('../lib/agent-session/event-bus');
const { createInteractionRouter } = require('../lib/agent-session/interaction-router');
const { createAgentSession } = require('../lib/agent-session/session');

const APPROVAL_PAYLOAD = {
  presentation: { title: 'Run npm test?' },
  choices: [
    { id: 'allow', label: 'Allow', intent: 'accept' },
    { id: 'deny', label: 'Deny', intent: 'deny' }
  ]
};

function fakeAdapter() {
  const listeners = new Set();
  const requests = new Set();
  const expirations = new Set();
  const calls = { open: 0, prompt: 0, cancel: 0, respond: [], expire: [], dispose: 0 };
  return {
    id: 'fake',
    provider: 'codex',
    transport: 'codex-app-server',
    calls,
    open: async () => { calls.open += 1; return { sessionId: 'h1' }; },
    prompt: async () => { calls.prompt += 1; return { stopReason: 'end_turn' }; },
    cancel: async () => { calls.cancel += 1; return { cancelled: true }; },
    respond: (interactionId, decision) => { calls.respond.push({ interactionId, decision }); },
    expire: (interactionId, reason) => { calls.expire.push({ interactionId, reason }); },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onInteractionRequest(handler) {
      requests.add(handler);
      return () => requests.delete(handler);
    },
    onInteractionExpire(handler) {
      expirations.add(handler);
      return () => expirations.delete(handler);
    },
    dispose: () => { calls.dispose += 1; },
    emit(event) { for (const listener of listeners) listener(event); },
    ask(request) { for (const handler of requests) handler(request); },
    retract(interactionId, reason) { for (const handler of expirations) handler(interactionId, reason); }
  };
}

function setup() {
  const adapter = fakeAdapter();
  const bus = createEventBus({ sessionId: 's1' });
  const router = createInteractionRouter({ sessionId: 's1', bus });
  const session = createAgentSession({ sessionId: 's1', adapter, bus, router });
  return { adapter, bus, router, session };
}

test('adapter events fan out to every listener', () => {
  const { adapter, session } = setup();
  const a = [];
  const b = [];
  session.subscribe((event) => a.push(event.type));
  session.subscribe((event) => b.push(event.type));
  adapter.emit({ type: 'timeline.item.completed', payload: { kind: 'message' } });
  assert.deepEqual(a, ['timeline.item.completed']);
  assert.deepEqual(b, ['timeline.item.completed']);
});

test('an adapter interaction request lands in the router and is answered exactly once', async () => {
  const { adapter, router, session } = setup();
  await session.open({});
  adapter.ask({ interactionId: 'i1', kind: 'approval', payload: APPROVAL_PAYLOAD, turnId: 't1' });
  assert.equal(router.pendingCount(), 1);
  const resolved = session.respond('i1', { choiceId: 'allow' });
  assert.equal(resolved.state, 'resolved');
  assert.deepEqual(adapter.calls.respond, [{ interactionId: 'i1', decision: { choiceId: 'allow' } }]);
  assert.throws(
    () => session.respond('i1', { choiceId: 'deny' }),
    (error) => error.code === 'agent_session_interaction_already_resolved'
  );
  assert.equal(adapter.calls.respond.length, 1);
});

test('an invalid adapter request surfaces as stream.error instead of crashing the session', async () => {
  const { adapter, session, router } = setup();
  await session.open({});
  const seen = [];
  session.subscribe((event) => seen.push(event.type));
  assert.throws(
    () => adapter.ask({ interactionId: 'i1', kind: 'approval', payload: { choices: [] } }),
    (error) => error.code === 'agent_session_interaction_payload_invalid'
  );
  assert.deepEqual(seen, ['stream.error']);
  assert.equal(router.pendingCount(), 0);
});

test('prompt brackets the turn with started/completed', async () => {
  const { adapter, session } = setup();
  await session.open({});
  const seen = [];
  session.subscribe((event) => seen.push(event.type));
  const result = await session.prompt({ text: 'hi' });
  assert.equal(result.turnId, 'turn_1');
  assert.equal(adapter.calls.prompt, 1);
  assert.deepEqual(seen, ['turn.started', 'turn.completed']);
  assert.equal(session.state, 'idle');
});

test('a failing prompt becomes turn.failed and returns to idle', async () => {
  const { adapter, session } = setup();
  await session.open({});
  adapter.prompt = async () => { throw Object.assign(new Error('nope'), { code: 'adapter_boom' }); };
  const seen = [];
  session.subscribe((event) => seen.push(event));
  await assert.rejects(() => session.prompt({ text: 'hi' }), (error) => error.code === 'adapter_boom');
  assert.deepEqual(seen.map((event) => event.type), ['turn.started', 'turn.failed']);
  assert.equal(seen[1].payload.code, 'adapter_boom');
  assert.equal(session.state, 'idle');
});

test('concurrent prompts are refused', async () => {
  const { adapter, session } = setup();
  await session.open({});
  let release;
  adapter.prompt = () => new Promise((resolve) => { release = () => resolve({ stopReason: 'end_turn' }); });
  const first = session.prompt({ text: 'one' });
  await assert.rejects(
    () => session.prompt({ text: 'two' }),
    (error) => error.code === 'agent_session_turn_in_progress'
  );
  release();
  await first;
});

test('dispose expires pending interactions, disposes the adapter and closes the bus', async () => {
  const { adapter, session, bus } = setup();
  await session.open({});
  adapter.ask({ interactionId: 'i1', kind: 'approval', payload: APPROVAL_PAYLOAD });
  const seen = [];
  session.subscribe((event) => seen.push(event.type));
  session.dispose('done');
  assert.equal(adapter.calls.dispose, 1);
  assert.equal(session.state, 'closed');
  assert.equal(bus.closed, true);
  assert.deepEqual(seen, ['interaction.expired', 'session.closed']);
});

test('disposing during an in-flight prompt surfaces the adapter error, not a transition error', async () => {
  const { adapter, session } = setup();
  await session.open({});
  let rejectPrompt;
  adapter.prompt = () => new Promise((_resolve, reject) => { rejectPrompt = reject; });
  const inflight = session.prompt({ text: 'hi' });
  await new Promise((resolve) => setImmediate(resolve));
  session.dispose('done');
  rejectPrompt(Object.assign(new Error('closed by user'), { code: 'adapter_closed' }));
  await assert.rejects(() => inflight, (error) => error.code === 'adapter_closed');
  assert.equal(session.state, 'closed');
});

test('cancel goes through interrupting and settles exactly once', async () => {
  const { adapter, session } = setup();
  await session.open({});
  let rejectPrompt;
  adapter.prompt = () => new Promise((_resolve, reject) => { rejectPrompt = reject; });
  adapter.cancel = async () => {
    rejectPrompt(Object.assign(new Error('cancelled'), { code: 'adapter_cancelled' }));
    return { cancelled: true };
  };
  const seen = [];
  session.subscribe((event) => seen.push(event.type));
  const inflight = session.prompt({ text: 'hi' });
  await new Promise((resolve) => setImmediate(resolve));
  await session.cancel('user');
  await assert.rejects(() => inflight, (error) => error.code === 'adapter_cancelled');
  assert.equal(session.state, 'idle');
  assert.deepEqual(seen, ['turn.started', 'turn.interrupt.requested', 'turn.failed', 'turn.interrupted']);
});

test('a router-side expiry is written back to the adapter', async () => {
  const { adapter, session, router } = setup();
  await session.open({});
  adapter.ask({ interactionId: 'i1', kind: 'approval', payload: APPROVAL_PAYLOAD });
  router.expire('i1', 'timeout');
  assert.deepEqual(adapter.calls.expire, [{ interactionId: 'i1', reason: 'timeout' }]);
});

test('an adapter can retract an interaction so attention frames clear', async () => {
  const { adapter, session, router } = setup();
  await session.open({});
  adapter.ask({ interactionId: 'i1', kind: 'approval', payload: APPROVAL_PAYLOAD });
  assert.equal(router.pendingCount(), 1);
  adapter.retract('i1', 'prompt_gone');
  assert.equal(router.pendingCount(), 0);
  assert.equal(router.get('i1').state, 'expired');
  assert.throws(
    () => session.respond('i1', { choiceId: 'allow' }),
    (error) => error.code === 'agent_session_interaction_already_resolved'
  );
});

test('the adapter descriptor is mandatory', () => {
  const bus = createEventBus({ sessionId: 's1' });
  const router = createInteractionRouter({ sessionId: 's1', bus });
  assert.throws(
    () => createAgentSession({ sessionId: 's1', adapter: { id: 'x', provider: 'codex', transport: 'pty' }, bus, router }),
    (error) => error.code === 'agent_session_adapter_method_missing'
  );
});
