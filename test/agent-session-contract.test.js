'use strict';

// Agent Session 契约：能力自证、交互形状、决策形状。
// 交互 payload 的严格校验复用 canonical-interaction-payload，这里只验「包装层」
// 有没有把非法输入放过去。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AGENT_SESSION_EVENT_SCHEMA,
  AgentSessionError,
  assertEventType,
  assertSessionState,
  normalizeDecision,
  normalizeInteractionRequest,
  support
} = require('../lib/agent-session/contracts');

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
  actions: ['submit', 'decline', 'cancel'],
  answerShape: 'answers',
  confirmUnanswered: false
};

test('event schema reuses the canonical chat contract instead of a second name', () => {
  assert.equal(AGENT_SESSION_EVENT_SCHEMA, 'aih.chat.event.v1');
});

test('support() requires evidence for native/emulated and a reason for unsupported', () => {
  assert.throws(() => support('native', null, {}), (error) => error.code === 'agent_session_support_evidence_required');
  assert.throws(() => support('emulated', 'guess', {}), (error) => error.code === 'agent_session_support_evidence_required');
  assert.throws(() => support('unsupported', ''), (error) => error.code === 'agent_session_support_reason_required');
  assert.throws(() => support('maybe', 'x', { evidence: 'y' }), (error) => error.code === 'agent_session_support_level_invalid');

  const native = support('native', null, { evidence: 'session/request_permission' });
  assert.deepEqual(native, { level: 'native', reason: null, evidence: 'session/request_permission' });
  assert.ok(Object.isFrozen(native));

  const unsupported = support('unsupported', 'ACP has no question method');
  assert.deepEqual(unsupported, { level: 'unsupported', reason: 'ACP has no question method', evidence: null });
});

test('interaction requests validate through the canonical payload validators', () => {
  const approval = normalizeInteractionRequest({ interactionId: 'i1', kind: 'approval', payload: APPROVAL_PAYLOAD });
  assert.equal(approval.kind, 'approval');
  assert.equal(approval.payload.choices.length, 2);
  assert.ok(Object.isFrozen(approval));

  const question = normalizeInteractionRequest({ interactionId: 'i2', kind: 'question', payload: QUESTION_PAYLOAD });
  assert.equal(question.payload.answerShape, 'answers');

  assert.throws(
    () => normalizeInteractionRequest({ interactionId: '', kind: 'approval', payload: APPROVAL_PAYLOAD }),
    (error) => error.code === 'agent_session_interaction_id_required'
  );
  assert.throws(
    () => normalizeInteractionRequest({ interactionId: 'i3', kind: 'ask', payload: APPROVAL_PAYLOAD }),
    (error) => error.code === 'agent_session_interaction_kind_invalid'
  );
  assert.throws(
    () => normalizeInteractionRequest({ interactionId: 'i4', kind: 'approval', payload: { presentation: { title: 'x' }, choices: [] } }),
    (error) => error.code === 'agent_session_interaction_payload_invalid'
  );
});

test('approval decisions must name a declared choice', () => {
  assert.deepEqual(normalizeDecision('approval', APPROVAL_PAYLOAD, { choiceId: 'allow' }), { choiceId: 'allow' });
  assert.throws(
    () => normalizeDecision('approval', APPROVAL_PAYLOAD, {}),
    (error) => error.code === 'agent_session_decision_choice_required'
  );
  assert.throws(
    () => normalizeDecision('approval', APPROVAL_PAYLOAD, { choiceId: 'always' }),
    (error) => error.code === 'agent_session_decision_choice_unknown'
  );
});

test('question decisions accept submit/decline/cancel and reject unknown fields', () => {
  assert.deepEqual(
    normalizeDecision('question', QUESTION_PAYLOAD, { action: 'submit', answers: { branch: 'main' } }),
    { action: 'submit', answers: { branch: 'main' } }
  );
  assert.deepEqual(normalizeDecision('question', QUESTION_PAYLOAD, { action: 'decline' }), { action: 'decline' });
  assert.throws(
    () => normalizeDecision('question', QUESTION_PAYLOAD, { action: 'submit' }),
    (error) => error.code === 'agent_session_decision_answers_required'
  );
  assert.throws(
    () => normalizeDecision('question', QUESTION_PAYLOAD, { action: 'submit', answers: { nope: 'x' } }),
    (error) => error.code === 'agent_session_decision_answer_unknown_field'
  );
  assert.throws(
    () => normalizeDecision('question', QUESTION_PAYLOAD, { action: 'approve' }),
    (error) => error.code === 'agent_session_decision_action_invalid'
  );
});

test('an action the payload did not offer is rejected before the adapter sees it', () => {
  const submitOnly = Object.assign({}, QUESTION_PAYLOAD, { actions: ['submit'] });
  assert.throws(
    () => normalizeDecision('question', submitOnly, { action: 'decline' }),
    (error) => error.code === 'agent_session_decision_action_not_offered'
  );
  assert.deepEqual(
    normalizeDecision('question', submitOnly, { action: 'submit', answers: { branch: 'main' } }).action,
    'submit'
  );
});

test('event type and session state typos fail closed', () => {
  assert.equal(assertEventType('interaction.requested'), 'interaction.requested');
  assert.throws(() => assertEventType('interaction.requestd'), (error) => error.code === 'agent_session_event_type_unknown');
  assert.equal(assertSessionState('waiting_input'), 'waiting_input');
  assert.throws(() => assertSessionState('waiting'), (error) => error.code === 'agent_session_state_invalid');
});

test('AgentSessionError carries a stable code', () => {
  const error = new AgentSessionError('agent_session_x', { detail: 1 });
  assert.equal(error.name, 'AgentSessionError');
  assert.equal(error.code, 'agent_session_x');
  assert.deepEqual(error.details, { detail: 1 });
});
