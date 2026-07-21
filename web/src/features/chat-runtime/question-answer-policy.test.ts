import assert from 'node:assert/strict';
import test from 'node:test';
import type { InteractionField } from './interaction-view-model';
import {
  buildQuestionAnswer,
  firstMissingRequiredField,
  unansweredQuestionFields,
} from './question-answer-policy';

const fields: InteractionField[] = [
  field('target', 'single_select', true),
  field('note', 'text', false),
  field('retries', 'integer', false),
  field('enabled', 'boolean', false),
  field('tags', 'multi_select', false),
];

test('question answer policy distinguishes missing values from false and zero', () => {
  assert.equal(firstMissingRequiredField(fields, {
    note: { kind: 'text', value: 'optional' },
  })?.id, 'target');
  assert.equal(firstMissingRequiredField(fields, {
    target: { kind: 'option', value: 'web' },
    retries: { kind: 'number', value: 0 },
    enabled: { kind: 'boolean', value: false },
  }), undefined);
});

test('answers shape emits string arrays and preserves explicitly unanswered fields', () => {
  assert.deepEqual(buildQuestionAnswer('answers', fields, {
    target: { kind: 'other', value: 'desktop app' },
    retries: { kind: 'number', value: 2 },
    enabled: { kind: 'boolean', value: false },
    tags: { kind: 'multi', values: ['fast', 'stable'] },
  }), {
    target: ['desktop app'], note: [], retries: ['2'], enabled: ['false'],
    tags: ['fast', 'stable'],
  });
});

test('object and none shapes use canonical objects without a synthetic text field', () => {
  assert.deepEqual(buildQuestionAnswer('object', fields, {
    target: { kind: 'option', value: 'web' },
    note: { kind: 'text', value: 'optional' },
    retries: { kind: 'number', value: 3 },
    enabled: { kind: 'boolean', value: true },
  }), {
    target: 'web', note: 'optional', retries: 3, enabled: true,
  });
  assert.deepEqual(buildQuestionAnswer('none', [], {}), {});
  assert.equal(JSON.stringify(buildQuestionAnswer('none', [], {})).includes('__text'), false);
});

test('question answer policy reports unanswered fields for explicit confirmation', () => {
  assert.deepEqual(unansweredQuestionFields(fields, {
    target: { kind: 'option', value: 'web' },
  }).map((field) => field.id), ['note', 'retries', 'enabled', 'tags']);
});

function field(
  id: string,
  type: InteractionField['type'],
  required: boolean,
): InteractionField {
  return {
    id, label: id, type, options: [], required, allowOther: false, secret: false,
  };
}
