'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  REDACTED_SECRET_ANSWER,
  projectInteractionCommandForPersistence,
  projectInteractionResolutionForPersistence
} = require('../lib/server/chat-runtime/interaction-secret-policy');

test('secret answer projection masks only answered secret fields', () => {
  const interaction = secretInteraction();
  const command = {
    commandId: 'answer-1',
    sessionId: 'session-1',
    type: 'interaction.answer',
    payload: {
      interactionId: interaction.interactionId,
      revision: 1,
      action: 'submit',
      answer: {
        token: ['top-secret'],
        optionalSecret: [],
        target: ['web']
      }
    }
  };

  const persisted = projectInteractionCommandForPersistence(command, interaction);

  assert.deepEqual(persisted.payload.answer, {
    token: [REDACTED_SECRET_ANSWER],
    optionalSecret: [],
    target: ['web']
  });
  assert.deepEqual(command.payload.answer.token, ['top-secret']);
});

test('secret resolution projection preserves native answer wrappers without plaintext', () => {
  const interaction = secretInteraction();
  const resolution = {
    action: 'submit',
    answer: {
      token: { answers: ['top-secret'] },
      target: { answers: ['web'] }
    }
  };

  assert.deepEqual(projectInteractionResolutionForPersistence(interaction, resolution), {
    action: 'submit',
    answer: {
      token: { answers: [REDACTED_SECRET_ANSWER] },
      target: { answers: ['web'] }
    }
  });
});

function secretInteraction() {
  return {
    interactionId: 'question-1',
    kind: 'question',
    payload: {
      fields: [
        { id: 'token', secret: true },
        { id: 'optionalSecret', secret: true },
        { id: 'target', secret: false }
      ]
    }
  };
}
