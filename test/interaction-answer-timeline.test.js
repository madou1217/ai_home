'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createInteractionAnswerTimelineEvent,
  formatInteractionAnswer
} = require('../lib/server/chat-runtime/interaction-answer-timeline');

test('single question answer is projected as a completed user message', () => {
  const event = createInteractionAnswerTimelineEvent(interaction({
    kind: 'plan_confirmation',
    fields: [field('choice', 'Choice', {
      type: 'single_select',
      options: [{ value: '3', label: 'No, stay in Plan mode' }]
    })],
    answer: { choice: ['3'] }
  }));

  assert.equal(event.itemId, 'interaction-answer:question-1:2');
  assert.deepEqual(event.payload.item, {
    id: 'interaction-answer:question-1:2',
    kind: 'message',
    createdAt: 1200,
    updatedAt: 1200,
    status: 'completed',
    content: 'No, stay in Plan mode',
    detail: { role: 'user', phase: 'interaction_answer' }
  });
});

test('other answers stay verbatim and multiple answered fields retain their labels', () => {
  assert.equal(formatInteractionAnswer(interaction({
    fields: [
      field('choice', '选择', {
        type: 'single_select',
        options: [{ value: 'a', label: '选项 A' }]
      }),
      field('retries', '次数', { type: 'integer' }),
      field('enabled', '启用', { type: 'boolean' })
    ],
    answer: {
      choice: ['我什么都不选'],
      retries: 0,
      enabled: false
    }
  })), '选择：我什么都不选\n次数：0\n启用：false');
});

test('secret answers are visible as submitted without leaking their values', () => {
  const projected = formatInteractionAnswer(interaction({
    fields: [field('token', 'Token', { secret: true })],
    answer: { token: ['never-persist-this-secret'] }
  }));

  assert.equal(projected, '已提交敏感回答');
  assert.doesNotMatch(projected, /never-persist-this-secret/);
});

test('empty, declined, approval, and externally resolved interactions are not projected', () => {
  assert.equal(createInteractionAnswerTimelineEvent(interaction({ answer: {} })), null);
  assert.equal(createInteractionAnswerTimelineEvent(interaction({ action: 'decline' })), null);
  assert.equal(createInteractionAnswerTimelineEvent(interaction({ kind: 'approval' })), null);
  assert.equal(createInteractionAnswerTimelineEvent(interaction({
    resolution: { reason: 'resolved_elsewhere' }
  })), null);
});

function interaction(overrides = {}) {
  return {
    interactionId: 'question-1',
    revision: 2,
    kind: overrides.kind || 'question',
    payload: { fields: overrides.fields || [field('answer', 'Answer')] },
    resolution: overrides.resolution || {
      action: overrides.action || 'submit',
      answer: overrides.answer === undefined ? { answer: ['yes'] } : overrides.answer
    },
    updatedAt: 1200
  };
}

function field(id, label, overrides = {}) {
  return {
    id,
    label,
    type: overrides.type || 'text',
    required: false,
    allowOther: false,
    secret: overrides.secret === true,
    ...(overrides.options ? { options: overrides.options } : {})
  };
}
