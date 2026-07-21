'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeCanonicalInteractionPayload
} = require('../lib/server/chat-runtime/canonical-interaction-payload');
const {
  questionPayload
} = require('./chat-runtime-interaction-fixtures');

test('question answer shape and fields have one strict canonical invariant', () => {
  assert.throws(
    () => normalizeCanonicalInteractionPayload('question', questionPayload({ fields: [] })),
    invalidPayload
  );
  assert.throws(() => normalizeCanonicalInteractionPayload('question', questionPayload({
    fields: [textField()], answerShape: 'none'
  })), invalidPayload);

  const link = normalizeCanonicalInteractionPayload('question', questionPayload({
    presentation: {
      title: 'Authorize',
      link: { label: 'Open', url: 'https://example.com/oauth' }
    },
    fields: [],
    answerShape: 'none'
  }));
  assert.equal(link.presentation.link.url, 'https://example.com/oauth');
});

test('only single-select fields allow other and every select has options', () => {
  assert.throws(() => normalizeCanonicalInteractionPayload('question', questionPayload({
    fields: [{ ...textField(), allowOther: true }]
  })), invalidPayload);
  assert.throws(() => normalizeCanonicalInteractionPayload('question', questionPayload({
    fields: [{ ...textField(), type: 'single_select', options: [] }]
  })), invalidPayload);
  assert.doesNotThrow(() => normalizeCanonicalInteractionPayload('question', questionPayload({
    fields: [{
      ...textField(), type: 'single_select', allowOther: true,
      options: [{ value: 'web', label: 'Web' }]
    }]
  })));
});

test('auto-resolution modes reject missing or cross-mode timing fields', () => {
  assert.throws(() => normalizeCanonicalInteractionPayload('question', questionPayload({
    autoResolution: {
      mode: 'countdown', onExpire: 'decline', snooze: 'disable'
    }
  })), invalidPayload);
  assert.throws(() => normalizeCanonicalInteractionPayload('question', questionPayload({
    autoResolution: {
      mode: 'inactivity_countdown', countdownMs: 1000,
      onExpire: 'submit_empty', snooze: 'disable'
    }
  })), invalidPayload);
  assert.throws(() => normalizeCanonicalInteractionPayload('question', questionPayload({
    autoResolution: {
      mode: 'countdown', inactivityMs: 0, countdownMs: 1000,
      onExpire: 'decline', snooze: 'disable'
    }
  })), invalidPayload);
  assert.doesNotThrow(() => normalizeCanonicalInteractionPayload('question', questionPayload({
    autoResolution: {
      mode: 'inactivity_countdown', inactivityMs: 0, countdownMs: 1000,
      onExpire: 'submit_empty', snooze: 'disable'
    }
  })));
});

test('canonical link normalization rejects dangerous schemes independently of providers', () => {
  assert.throws(() => normalizeCanonicalInteractionPayload('question', questionPayload({
    presentation: {
      title: 'Unsafe',
      link: { label: 'Open', url: 'javascript:alert(1)' }
    },
    fields: [],
    answerShape: 'none'
  })), invalidPayload);
});

function textField() {
  return {
    id: 'answer', label: 'Answer', type: 'text', required: false,
    allowOther: false, secret: false
  };
}

function invalidPayload(error) {
  return error.code === 'invalid_canonical_interaction_payload' && error.statusCode === 422;
}
