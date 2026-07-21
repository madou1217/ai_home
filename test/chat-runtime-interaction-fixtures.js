'use strict';

function approvalPayload(overrides = {}) {
  return {
    presentation: overrides.presentation || { title: 'Approve operation' },
    choices: overrides.choices || [
      { id: 'choice-0', label: 'Allow', intent: 'accept' },
      { id: 'choice-1', label: 'Decline', intent: 'deny' }
    ]
  };
}

function questionPayload(overrides = {}) {
  const payload = {
    presentation: overrides.presentation || { title: 'Input required' },
    fields: overrides.fields || [{
      id: 'answer',
      label: 'Answer',
      type: 'text',
      required: false,
      allowOther: false,
      secret: false
    }],
    actions: overrides.actions || ['submit'],
    answerShape: overrides.answerShape || 'object',
    confirmUnanswered: overrides.confirmUnanswered === true
  };
  if (overrides.autoResolution) payload.autoResolution = overrides.autoResolution;
  return payload;
}

module.exports = { approvalPayload, questionPayload };
