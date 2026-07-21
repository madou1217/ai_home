import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePendingInteraction } from './interaction-parser';

test('approval parser rebuilds the canonical presentation and ordered choices', () => {
  const parsed = parsePendingInteraction(interaction('approval', {
    presentation: {
      title: '命令审批',
      description: '需要运行命令',
      detail: 'npm test',
      annotations: [{ label: '目录', value: '/repo' }],
    },
    choices: [
      { id: 'approve-once', label: '允许一次', intent: 'accept' },
      { id: 'decline', label: '拒绝', description: '继续任务', intent: 'deny' },
    ],
  }), 'session-1');

  assert.equal(parsed.kind, 'approval');
  assert.deepEqual(parsed.payload, {
    presentation: {
      title: '命令审批',
      description: '需要运行命令',
      detail: 'npm test',
      annotations: [{ label: '目录', value: '/repo' }],
    },
    choices: [
      { id: 'approve-once', label: '允许一次', intent: 'accept' },
      { id: 'decline', label: '拒绝', description: '继续任务', intent: 'deny' },
    ],
  });
});

test('question and emulated plan confirmation share the complete canonical payload', () => {
  const payload = canonicalQuestionPayload();
  const question = parsePendingInteraction(interaction('question', payload), 'session-1');
  const plan = parsePendingInteraction(interaction('plan_confirmation', payload), 'session-1');

  assert.deepEqual(question.payload, payload);
  assert.deepEqual(plan.payload, payload);
  assert.equal(question.kind, 'question');
  assert.equal(plan.kind, 'plan_confirmation');
});

test('question parser trusts only canonical secret metadata', () => {
  const parsed = parsePendingInteraction(interaction('question', {
    ...canonicalQuestionPayload(),
    fields: [{
      id: 'token', label: 'Token', type: 'text', required: true,
      allowOther: false, secret: false,
    }],
  }), 'session-1');

  assert.equal(parsed.kind, 'question');
  if (parsed.kind !== 'question') assert.fail('expected question');
  assert.equal(parsed.payload.fields[0]?.secret, false);
});

test('provider-private interaction keys fail closed instead of being stripped', () => {
  assert.throws(() => parsePendingInteraction(interaction('approval', {
    presentation: { title: '审批' },
    choices: [{ id: 'once', label: '允许', intent: 'accept' }],
    method: 'item/commandExecution/requestApproval',
    requestId: 17,
    threadId: 'native-thread',
  }), 'session-1'), /chat_runtime_approval_payload_invalid/);

  assert.throws(() => parsePendingInteraction(interaction('question', {
    ...canonicalQuestionPayload(),
    requestedSchema: { type: 'object' },
  }), 'session-1'), /chat_runtime_question_payload_invalid/);

  assert.throws(() => parsePendingInteraction(interaction('question', {
    ...canonicalQuestionPayload(),
    fields: [{ ...canonicalField('target'), isSecret: true }],
  }), 'session-1'), /chat_runtime_question_field_invalid/);
});

test('question links allow only canonical http and https URLs', () => {
  for (const url of ['javascript:alert(1)', 'file:///tmp/secret', '/relative']) {
    assert.throws(() => parsePendingInteraction(interaction('question', {
      ...canonicalQuestionPayload(),
      presentation: {
        title: '需要你的回答',
        link: { label: '打开', url },
      },
    }), 'session-1'), /chat_runtime_question_link_url_invalid/);
  }
});

test('interaction parser fails closed on empty, duplicate, and unknown canonical schemas', () => {
  const invalidApprovalPayloads = [
    { presentation: { title: 'Approve' }, choices: [] },
    {
      presentation: { title: 'Approve' },
      choices: [
        { id: 'same', label: 'Allow', intent: 'accept' },
        { id: 'same', label: 'Deny', intent: 'deny' },
      ],
    },
    {
      presentation: { title: 'Approve' },
      choices: [{ id: 'choice', label: 'Maybe', intent: 'provider_private' }],
    },
  ];
  invalidApprovalPayloads.forEach((payload) => {
    assert.throws(
      () => parsePendingInteraction(interaction('approval', payload), 'session-1'),
      /chat_runtime_approval_/,
    );
  });

  const duplicateFields = canonicalQuestionPayload({
    fields: [canonicalField('same'), canonicalField('same')],
  });
  const duplicateActions = canonicalQuestionPayload({ actions: ['submit', 'submit'] });
  const unknownType = canonicalQuestionPayload({
    fields: [{ ...canonicalField('target'), type: 'provider_private' }],
  });
  const unknownShape = canonicalQuestionPayload({ answerShape: 'text' });
  const emptyFields = canonicalQuestionPayload({ fields: [] });
  [duplicateFields, duplicateActions, unknownType, unknownShape, emptyFields].forEach((payload) => {
    assert.throws(
      () => parsePendingInteraction(interaction('question', payload), 'session-1'),
      /chat_runtime_question_/,
    );
  });
});

test('question parser validates select options and mode-specific auto resolution', () => {
  const duplicateOptions = canonicalQuestionPayload({
    fields: [{
      ...canonicalField('target'),
      type: 'single_select',
      options: [
        { value: 'web', label: 'Web' },
        { value: 'web', label: 'Browser' },
      ],
    }],
  });
  const incompleteCountdown = canonicalQuestionPayload({
    autoResolution: {
      mode: 'inactivity_countdown', inactivityMs: 60_000,
      onExpire: 'submit_empty', snooze: 'disable',
    },
  });
  const emptySelectOptions = canonicalQuestionPayload({
    fields: [{
      ...canonicalField('target'),
      options: [],
      allowOther: true,
    }],
  });
  const multiSelectOther = canonicalQuestionPayload({
    fields: [{
      ...canonicalField('target'),
      type: 'multi_select',
      allowOther: true,
    }],
  });

  assert.throws(
    () => parsePendingInteraction(interaction('question', duplicateOptions), 'session-1'),
    /chat_runtime_question_option_duplicate/,
  );
  assert.throws(
    () => parsePendingInteraction(interaction('question', incompleteCountdown), 'session-1'),
    /chat_runtime_question_auto_resolution_countdown_invalid/,
  );
  assert.throws(
    () => parsePendingInteraction(interaction('question', emptySelectOptions), 'session-1'),
    /chat_runtime_question_field_options_invalid/,
  );
  assert.throws(
    () => parsePendingInteraction(interaction('question', multiSelectOther), 'session-1'),
    /chat_runtime_question_field_allow_other_invalid/,
  );
});

function interaction(kind: string, payload: unknown) {
  return {
    interactionId: 'interaction-1', sessionId: 'session-1', itemId: 'item-1',
    kind, revision: 1, payload, state: 'pending', createdAt: 1, updatedAt: 1,
  };
}

function canonicalQuestionPayload(overrides: Record<string, unknown> = {}) {
  return {
    presentation: {
      title: '需要你的回答',
      message: '选择目标',
      link: { label: '查看说明', url: 'https://example.com/help' },
    },
    fields: [canonicalField('target')],
    actions: ['submit', 'decline'],
    answerShape: 'answers',
    confirmUnanswered: true,
    autoResolution: {
      mode: 'inactivity_countdown', inactivityMs: 60_000, countdownMs: 90_000,
      onExpire: 'submit_empty', snooze: 'disable',
    },
    ...overrides,
  };
}

function canonicalField(id: string) {
  return {
    id, label: '目标', header: '环境', description: '请选择',
    type: 'single_select', required: false, allowOther: true, secret: false,
    options: [{ value: 'web', label: 'Web', description: '浏览器' }],
  };
}
