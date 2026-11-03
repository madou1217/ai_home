'use strict';

// 消费者投影：canonical 事件 → provider-session-state 的转移。
// 用真 store + 真 bus，证明「交互请求到达 → 标题源能读到 question」这条链路。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createEventBus } = require('../lib/agent-session/event-bus');
const { createProviderSessionStateStore } = require('../lib/server/provider-session-state-store');
const { attachSessionStateConsumer, projectEvent } = require('../lib/agent-session/consumers/session-state');
const { createQuestionTitleSource } = require('../lib/cli/services/pty/terminal-title/sources');

const APPROVAL_PAYLOAD = {
  presentation: { title: '允许执行「npm test」吗？' },
  choices: [
    { id: 'allow', label: '允许', intent: 'accept' },
    { id: 'deny', label: '拒绝', intent: 'deny' }
  ]
};

const QUESTION_PAYLOAD = {
  presentation: { title: '用哪个分支？', message: '当前在 main' },
  fields: [{
    id: 'branch',
    label: 'Branch',
    type: 'single_select',
    required: true,
    allowOther: false,
    secret: false,
    options: [{ value: 'main', label: 'main' }, { value: 'dev', label: 'dev' }]
  }],
  actions: ['submit', 'cancel'],
  answerShape: 'answers',
  confirmUnanswered: false
};

function setup() {
  const bus = createEventBus({ sessionId: 's1' });
  const store = createProviderSessionStateStore({});
  const session = { provider: 'gemini', sessionId: 'native-1' };
  const detach = attachSessionStateConsumer({ bus, store, session });
  return { bus, store, session, detach };
}

test('an approval request becomes a question with the choice labels as options', () => {
  const { bus, store, session } = setup();
  bus.publish({
    type: 'interaction.requested',
    payload: { interactionId: 'i1', kind: 'approval', payload: APPROVAL_PAYLOAD }
  });
  const state = store.get(session);
  assert.equal(state.question.question, '允许执行「npm test」吗？');
  assert.deepEqual(state.question.options, ['允许', '拒绝']);
  assert.equal(state.turnState, 'waiting');
});

test('resolving the interaction clears the question', () => {
  const { bus, store, session } = setup();
  bus.publish({
    type: 'interaction.requested',
    payload: { interactionId: 'i1', kind: 'approval', payload: APPROVAL_PAYLOAD }
  });
  bus.publish({
    type: 'interaction.resolved',
    payload: { interactionId: 'i1', kind: 'approval', decision: { choiceId: 'allow' } }
  });
  assert.equal(store.get(session).question, null);
});

test('a question carries title + message and only real options', () => {
  const { bus, store, session } = setup();
  bus.publish({
    type: 'interaction.requested',
    payload: { interactionId: 'i2', kind: 'question', payload: QUESTION_PAYLOAD }
  });
  const state = store.get(session);
  assert.equal(state.question.question, '用哪个分支？ 当前在 main');
  assert.deepEqual(state.question.options, ['main', 'dev']);
});

test('a text-only question does not invent options', () => {
  const textQuestion = {
    presentation: { title: '输入提交信息' },
    fields: [{ id: 'msg', label: 'Message', type: 'text', required: true, allowOther: false, secret: false }],
    actions: ['submit', 'cancel'],
    answerShape: 'answers',
    confirmUnanswered: false
  };
  const projection = projectEvent({
    type: 'interaction.requested',
    payload: { interactionId: 'i3', kind: 'question', payload: textQuestion }
  });
  assert.equal(projection.type, 'question-opened');
  assert.deepEqual(projection.payload.options, []);
});

test('turn lifecycle projects to turn transitions', () => {
  const { bus, store, session } = setup();
  bus.publish({ type: 'turn.started', turnId: 't1' });
  assert.equal(store.get(session).turnState, 'working');
  bus.publish({ type: 'turn.completed', turnId: 't1', payload: { stopReason: 'end_turn' } });
  assert.equal(store.get(session).turnState, 'completed');
});

test('unrelated events project to nothing', () => {
  assert.equal(projectEvent({ type: 'timeline.item.delta', payload: {} }), null);
  assert.equal(projectEvent({ type: 'interaction.requested', payload: { kind: 'approval', payload: {} } }), null);
});

test('the projection drives the real terminal-title question frame', () => {
  const { bus, store, session } = setup();
  bus.publish({
    type: 'interaction.requested',
    payload: { interactionId: 'i1', kind: 'approval', payload: APPROVAL_PAYLOAD }
  });
  const source = createQuestionTitleSource();
  const frames = source.provide({ sessionState: store.get(session) });
  assert.deepEqual(frames, ['? 允许执行「npm test」吗？']);

  bus.publish({ type: 'interaction.resolved', payload: { interactionId: 'i1' } });
  assert.deepEqual(source.provide({ sessionState: store.get(session) }), []);
});

test('detach stops writing', () => {
  const { bus, store, session, detach } = setup();
  detach();
  bus.publish({
    type: 'interaction.requested',
    payload: { interactionId: 'i1', kind: 'approval', payload: APPROVAL_PAYLOAD }
  });
  assert.equal(store.get(session).question, null);
});
