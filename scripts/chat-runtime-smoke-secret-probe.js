'use strict';

const crypto = require('node:crypto');

const { findFilesContainingText } = require('./chat-runtime-smoke-evidence');

async function runSecretPersistenceProbe(options) {
  const sentinel = `aih-chat-runtime-secret-${crypto.randomUUID()}`;
  const interactionId = `smoke-secret-interaction-${crypto.randomUUID()}`;
  const commandId = `smoke-secret-command-${crypto.randomUUID()}`;
  options.service.store.createInteraction({
    interactionId,
    sessionId: options.sessionId,
    itemId: `smoke-secret-item-${crypto.randomUUID()}`,
    kind: 'question',
    revision: 1,
    payload: secretQuestionPayload()
  });
  let rejectionCode = '';
  try {
    await options.service.dispatchCommand(options.sessionId, {
      commandId,
      type: 'interaction.answer',
      payload: {
        interactionId,
        revision: 1,
        action: 'submit',
        answer: { secret: sentinel }
      }
    });
  } catch (error) {
    rejectionCode = String(error && error.code || '');
  }
  await options.service.waitForActorIdle(options.sessionId);
  const command = options.service.store.getCommand(commandId);
  const events = options.service.readEvents(options.sessionId).events;
  const leakLocations = [
    ...findFilesContainingText(options.tempRoot, sentinel)
      .map((filePath) => `file:${filePath}`),
    ...(JSON.stringify(command).includes(sentinel) ? ['command'] : []),
    ...(JSON.stringify(events).includes(sentinel) ? ['event'] : [])
  ];
  return {
    verified: rejectionCode === 'codex_interaction_not_pending'
      && command && command.status === 'failed'
      && leakLocations.length === 0,
    rejectionCode,
    commandStatus: String(command && command.status || ''),
    leakLocations
  };
}

function secretQuestionPayload() {
  return {
    presentation: { title: 'Secret persistence smoke' },
    fields: [{
      id: 'secret',
      label: 'Secret',
      type: 'text',
      required: true,
      allowOther: false,
      secret: true
    }],
    actions: ['submit'],
    answerShape: 'object',
    confirmUnanswered: false
  };
}

module.exports = { runSecretPersistenceProbe };
