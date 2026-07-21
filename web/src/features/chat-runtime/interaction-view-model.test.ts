import assert from 'node:assert/strict';
import test from 'node:test';
import type { PendingInteraction, QuestionInteractionPayload } from '@/chat-runtime';
import {
  interactionCommandDisabled,
  interactionControlsDisabled,
  interactionLifecycleKey,
  questionViewModel,
} from './interaction-view-model';

test('question view model projects the validated canonical presentation and fields', () => {
  const view = questionViewModel(interaction('question', payload({
    fields: [{
      id: 'target', header: '目标', label: '选择目标', description: '部署环境',
      type: 'single_select', required: false, allowOther: true, secret: true,
      options: [{ value: 'web', label: 'Web', description: '浏览器' }],
    }],
    autoResolution: {
      mode: 'inactivity_countdown', inactivityMs: 60_000, countdownMs: 60_000,
      onExpire: 'submit_empty', snooze: 'disable',
    },
  })));

  assert.equal(view.title, '需要你的回答');
  assert.equal(view.answerShape, 'answers');
  assert.deepEqual(view.fields[0], {
    id: 'target', header: '目标', label: '选择目标', description: '部署环境',
    type: 'single_select', required: false, allowOther: true, secret: true,
    options: [{ value: 'web', label: 'Web', description: '浏览器' }],
  });
  assert.equal(view.autoResolution?.mode, 'inactivity_countdown');
});

test('plan confirmation reuses the canonical question payload without inferred fields', () => {
  const view = questionViewModel(interaction('plan_confirmation', payload({
    presentation: { title: '确认计划', message: '是否实现？' },
    fields: [],
    answerShape: 'none',
    confirmUnanswered: false,
  })));

  assert.equal(view.title, '确认计划');
  assert.deepEqual(view.fields, []);
  assert.equal(view.answerShape, 'none');
});

test('interaction controls are disabled only while provider resolution is in flight', () => {
  const pending = interaction('question', payload());
  const resolving = { ...pending, state: 'resolving' as const };

  assert.equal(interactionControlsDisabled(pending), false);
  assert.equal(interactionControlsDisabled(resolving), true);
});

test('question commands fail closed whenever the canonical stream is not connected', () => {
  const pending = interaction('question', payload());

  assert.equal(interactionCommandDisabled(pending, false), true);
  assert.equal(interactionCommandDisabled(pending, true), false);
});

test('a new interaction revision starts a distinct component lifecycle', () => {
  const first = interaction('question', payload());
  const second = { ...first, revision: first.revision + 1 };

  assert.notEqual(interactionLifecycleKey(first), interactionLifecycleKey(second));
});

function payload(overrides: Partial<QuestionInteractionPayload> = {}): QuestionInteractionPayload {
  return {
    presentation: { title: '需要你的回答', message: '继续？' },
    fields: [{
      id: 'target', label: '目标', type: 'text', required: false,
      allowOther: false, secret: false,
    }],
    actions: ['submit'],
    answerShape: 'answers',
    confirmUnanswered: true,
    ...overrides,
  };
}

function interaction(
  kind: 'question' | 'plan_confirmation',
  interactionPayload: QuestionInteractionPayload,
): Extract<PendingInteraction, { kind: 'question' | 'plan_confirmation' }> {
  return {
    interactionId: 'interaction-1', sessionId: 'session-1', itemId: 'item-1',
    revision: 1, state: 'pending', createdAt: 1, updatedAt: 1,
    kind, payload: interactionPayload,
  };
}
