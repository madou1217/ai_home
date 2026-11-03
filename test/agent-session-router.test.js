'use strict';

// 交互路由器：单答者、幂等重放、超时收尾。
// 单答者是硬要求：两个消费者（比如 terminal title 的快捷键和 WebUI）同时应答时，
// 只能有一个写回 harness，另一个必须拿到 already_resolved 而不是静默成功。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createEventBus } = require('../lib/agent-session/event-bus');
const { createInteractionRouter } = require('../lib/agent-session/interaction-router');

const APPROVAL_PAYLOAD = {
  presentation: { title: 'Run npm test?' },
  choices: [
    { id: 'allow', label: 'Allow', intent: 'accept' },
    { id: 'deny', label: 'Deny', intent: 'deny' }
  ]
};

const QUESTION_PAYLOAD = {
  presentation: { title: 'Which branch?' },
  fields: [{ id: 'branch', label: 'Branch', type: 'text', required: true, allowOther: false, secret: false }],
  actions: ['submit', 'cancel'],
  answerShape: 'answers',
  confirmUnanswered: false
};

function fakeTimers() {
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout(fn) {
      const id = ++seq;
      pending.set(id, fn);
      return { id, unref() {} };
    },
    clearTimeout(handle) {
      if (handle) pending.delete(handle.id);
    },
    fire() {
      const fns = Array.from(pending.values());
      pending.clear();
      for (const fn of fns) fn();
    },
    size() {
      return pending.size;
    }
  };
}

function setup(options = {}) {
  const bus = createEventBus({ sessionId: 's1', now: () => 1 });
  const events = [];
  bus.subscribe((event) => events.push(event));
  const timers = fakeTimers();
  const router = createInteractionRouter({
    sessionId: 's1',
    bus,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    timeoutMs: options.timeoutMs || 0
  });
  return { bus, router, events, timers };
}

test('request publishes interaction.requested with the validated payload', () => {
  const { router, events } = setup();
  const view = router.request({ interactionId: 'i1', kind: 'approval', payload: APPROVAL_PAYLOAD, turnId: 't1' });
  assert.equal(view.state, 'pending');
  assert.equal(view.revision, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'interaction.requested');
  assert.equal(events[0].turnId, 't1');
  assert.equal(events[0].payload.interactionId, 'i1');
  assert.equal(events[0].payload.kind, 'approval');
  assert.equal(events[0].payload.payload.choices.length, 2);
});

test('every listener observes the request; only the router answers', () => {
  const { bus, router, events } = setup();
  const second = [];
  bus.subscribe((event) => second.push(event.type));
  router.request({ interactionId: 'i1', kind: 'approval', payload: APPROVAL_PAYLOAD });
  assert.deepEqual(second, ['interaction.requested']);
  assert.equal(events.length, 1);
});

test('the second response is rejected as already resolved', () => {
  const { router, events } = setup();
  router.request({ interactionId: 'i1', kind: 'approval', payload: APPROVAL_PAYLOAD });
  const resolved = router.respond('i1', { choiceId: 'allow' });
  assert.equal(resolved.state, 'resolved');
  assert.deepEqual(resolved.decision, { choiceId: 'allow' });
  assert.throws(
    () => router.respond('i1', { choiceId: 'deny' }),
    (error) => error.code === 'agent_session_interaction_already_resolved' && error.details.state === 'resolved'
  );
  assert.deepEqual(events.map((event) => event.type), ['interaction.requested', 'interaction.resolved']);
  assert.equal(router.pendingCount(), 0);
});

test('unknown interaction ids are rejected, never auto-created', () => {
  const { router } = setup();
  assert.throws(
    () => router.respond('nope', { choiceId: 'allow' }),
    (error) => error.code === 'agent_session_interaction_unknown'
  );
  assert.throws(() => router.expire('nope'), (error) => error.code === 'agent_session_interaction_unknown');
});

test('an invalid decision leaves the interaction pending', () => {
  const { router } = setup();
  router.request({ interactionId: 'i1', kind: 'question', payload: QUESTION_PAYLOAD });
  assert.throws(
    () => router.respond('i1', { action: 'submit', answers: { other: 'x' } }),
    (error) => error.code === 'agent_session_decision_answer_unknown_field'
  );
  assert.equal(router.get('i1').state, 'pending');
  assert.equal(router.pendingCount(), 1);
});

test('timeout expires the interaction so attention frames cannot pin forever', () => {
  const { router, events, timers } = setup({ timeoutMs: 50 });
  router.request({ interactionId: 'i1', kind: 'approval', payload: APPROVAL_PAYLOAD });
  assert.equal(timers.size(), 1);
  timers.fire();
  const view = router.get('i1');
  assert.equal(view.state, 'expired');
  assert.equal(view.resolution, 'timeout');
  assert.deepEqual(events.map((event) => event.type), ['interaction.requested', 'interaction.expired']);
  assert.throws(
    () => router.respond('i1', { choiceId: 'allow' }),
    (error) => error.code === 'agent_session_interaction_already_resolved'
  );
});

test('auto resolution settles instead of dangling', () => {
  const { router, timers } = setup();
  router.request({
    interactionId: 'i1',
    kind: 'question',
    payload: QUESTION_PAYLOAD,
    autoResolution: { mode: 'inactivity_countdown', inactivityMs: 30, onExpire: 'decline' }
  });
  timers.fire();
  const view = router.get('i1');
  assert.equal(view.state, 'resolved');
  assert.equal(view.resolution, 'auto_resolution');
  assert.deepEqual(view.decision, { action: 'decline' });
});

test('update bumps revision and re-validates the payload', () => {
  const { router, events } = setup();
  router.request({ interactionId: 'i1', kind: 'approval', payload: APPROVAL_PAYLOAD });
  const updated = router.update('i1', {
    payload: {
      presentation: { title: 'Run npm test? (2 files)' },
      choices: APPROVAL_PAYLOAD.choices
    }
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.payload.presentation.title, 'Run npm test? (2 files)');
  assert.equal(events[1].type, 'interaction.updated');
  assert.throws(
    () => router.update('i1', { payload: { presentation: { title: 'x' }, choices: [] } }),
    (error) => error.code === 'agent_session_interaction_payload_invalid'
  );
});

test('a replayed request with the same id and payload is idempotent', () => {
  const { router, events } = setup();
  router.request({ interactionId: 'i1', kind: 'approval', payload: APPROVAL_PAYLOAD });
  router.request({ interactionId: 'i1', kind: 'approval', payload: APPROVAL_PAYLOAD });
  assert.equal(events.length, 1);
  assert.throws(
    () => router.request({
      interactionId: 'i1',
      kind: 'approval',
      payload: { presentation: { title: 'Different' }, choices: APPROVAL_PAYLOAD.choices }
    }),
    (error) => error.code === 'agent_session_interaction_duplicate'
  );
});

test('dispose expires every pending interaction', () => {
  const { router, events } = setup();
  router.request({ interactionId: 'i1', kind: 'approval', payload: APPROVAL_PAYLOAD });
  router.request({ interactionId: 'i2', kind: 'question', payload: QUESTION_PAYLOAD });
  router.dispose('session_closed');
  assert.equal(router.pendingCount(), 0);
  assert.deepEqual(
    events.filter((event) => event.type === 'interaction.expired').map((event) => event.payload.resolution),
    ['session_closed', 'session_closed']
  );
  assert.throws(() => router.request({ interactionId: 'i3', kind: 'approval', payload: APPROVAL_PAYLOAD }),
    (error) => error.code === 'agent_session_router_disposed');
});
