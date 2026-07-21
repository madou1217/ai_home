'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createCliInteractionCoordinator } = require('../lib/server/cli-interaction-coordinator');
const { openChatRuntimeStore } = require('../lib/server/chat-runtime/store');

test('CLI interaction coordinator projects, validates, delivers and resolves a Codex prompt', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cli-interaction-'));
  const store = openChatRuntimeStore({ aiHomeDir });
  t.after(() => {
    store.close();
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });
  const session = store.createSession({
    sessionId: 'session-1',
    provider: 'codex',
    executionAccountRef: 'account-1',
    projectPath: '/repo',
    runtimeBinding: { nativeSessionId: 'native-session-1' },
    capabilitySnapshot: {},
    policy: {}
  });
  const service = {
    store,
    async resolveSession() { throw new Error('existing session should be adopted'); }
  };
  const coordinator = createCliInteractionCoordinator({ chatRuntimeService: service });
  const prompt = {
    provider: 'codex',
    kind: 'choice',
    promptId: 'prompt-1',
    question: 'Additional safety checks',
    options: [
      { value: '1', title: 'Continue' },
      { value: '2', title: 'Cancel' }
    ]
  };

  const registered = await coordinator.sync({
    correlationId: 'correlation-1',
    accountRef: 'account-1',
    session: { provider: 'codex', sessionId: 'native-session-1', projectPath: '/repo' },
    prompt,
    promptRevision: 1
  });
  assert.equal(registered.promptChanged, true);
  assert.equal(registered.sessionId, session.sessionId);
  const pending = store.getSnapshot(session.sessionId).interactions[0];
  assert.equal(pending.kind, 'question');
  assert.equal(pending.payload.fields[0].options[1].value, '2');

  const accepted = await coordinator.dispatch(session.sessionId, {
    commandId: 'command-1',
    type: 'interaction.answer',
    payload: {
      interactionId: pending.interactionId,
      revision: pending.revision,
      action: 'submit',
      answer: { choice: ['2'] }
    }
  });
  assert.equal(accepted.result.queued, true);

  const polled = await coordinator.sync({
    correlationId: 'correlation-1',
    accountRef: 'account-1',
    session: { provider: 'codex', sessionId: 'native-session-1', projectPath: '/repo' },
    prompt,
    promptRevision: 1
  });
  assert.equal(polled.promptChanged, undefined);
  assert.equal(polled.command.choiceValue, '2');

  await coordinator.sync({
    correlationId: 'correlation-1',
    session: { provider: 'codex', sessionId: 'native-session-1' },
    resolvedDeliveryId: polled.command.deliveryId
  });
  assert.deepEqual(store.getSnapshot(session.sessionId).interactions, []);
  assert.equal(store.getCommand('command-1').status, 'completed');
});

test('CLI interaction coordinator returns an accepted duplicate while delivery is resolving', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cli-interaction-duplicate-'));
  const store = openChatRuntimeStore({ aiHomeDir });
  t.after(() => {
    store.close();
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });
  const session = store.createSession({
    sessionId: 'session-duplicate',
    provider: 'codex',
    executionAccountRef: 'account-1',
    projectPath: '/repo',
    runtimeBinding: { nativeSessionId: 'native-session-duplicate' },
    capabilitySnapshot: {},
    policy: {}
  });
  const coordinator = createCliInteractionCoordinator({
    chatRuntimeService: {
      store,
      async resolveSession() { throw new Error('existing session should be adopted'); }
    }
  });
  await coordinator.sync({
    correlationId: 'correlation-duplicate',
    accountRef: 'account-1',
    session: {
      provider: 'codex', sessionId: 'native-session-duplicate', projectPath: '/repo'
    },
    prompt: {
      provider: 'codex',
      kind: 'choice',
      promptId: 'prompt-duplicate',
      question: 'Continue?',
      options: [
        { value: '1', title: 'Continue' },
        { value: '2', title: 'Cancel' }
      ]
    },
    promptRevision: 1
  });
  const interaction = store.getSnapshot(session.sessionId).interactions[0];
  const command = {
    commandId: 'command-duplicate',
    type: 'interaction.answer',
    payload: {
      interactionId: interaction.interactionId,
      revision: interaction.revision,
      action: 'submit',
      answer: { choice: ['1'] }
    }
  };

  const first = await coordinator.dispatch(session.sessionId, command);
  const duplicate = await coordinator.dispatch(session.sessionId, command);

  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.commandId, command.commandId);
  assert.equal(store.interactions.get(interaction.interactionId).state, 'resolving');
});
