'use strict';

const protocol = require('../codex-app-server-protocol');
const { ChatRuntimeError } = require('./contracts');
const {
  InteractionResolutionCoordinator
} = require('./interaction-resolution-coordinator');
const {
  projectInteractionResolutionForPersistence
} = require('./interaction-secret-policy');

function createCodexCommandPort(options) {
  return {
    answerInteraction: (payload) => answerInteraction(options, payload),
    decideApproval: (payload) => decideApproval(options, payload),
    executeSlash: (payload) => executeSlash(options, payload),
    interruptTurn: () => interruptTurn(options),
    intervene: (payload) => intervene(options, payload),
    prewarm: () => prewarm(options)
  };
}

async function prewarm(options) {
  const tasks = [options.prewarmRuntime()];
  if (typeof options.syncHistory === 'function') tasks.push(options.syncHistory());
  await Promise.all(tasks);
  return { ready: true, provider: 'codex', runtimeScope: options.runtimeScope };
}

function interruptTurn(options) {
  const run = requireActive(options.getActive());
  return options.client.request('turn/interrupt', protocol.buildTurnInterruptParams({
    threadId: run.nativeThreadId,
    turnId: requiredText(run.nativeTurnId, 'codex_native_turn_not_started')
  }));
}

function intervene(options, payload = {}) {
  if (payload.mode !== 'steer_current') {
    throw new ChatRuntimeError('codex_intervene_mode_unsupported', 422, {
      mode: payload.mode
    });
  }
  const run = requireActive(options.getActive());
  return options.client.request('turn/steer', protocol.buildTurnSteerParams({
    threadId: run.nativeThreadId,
    turnId: requiredText(run.nativeTurnId, 'codex_native_turn_not_started'),
    text: requiredText(payload.content, 'chat_turn_content_required')
  }));
}

function decideApproval(options, payload = {}) {
  return options.bridge.respond(
    payload.interactionId,
    'approval',
    payload.revision,
    { choiceId: payload.choiceId }
  );
}

function answerInteraction(options, payload = {}) {
  return options.bridge.respond(
    payload.interactionId,
    'question',
    payload.revision,
    {
      action: payload.action,
      ...(payload.answer === undefined ? {} : { answer: payload.answer })
    }
  );
}

function executeSlash(options, payload = {}) {
  const name = requiredText(payload.name, 'chat_slash_name_required')
    .replace(/^\//, '')
    .toLowerCase();
  if (name !== 'compact' || String(payload.arguments || '').trim()) {
    throw new ChatRuntimeError('codex_slash_command_unsupported', 422, { name });
  }
  const threadId = requiredText(options.getThreadId(), 'codex_native_session_missing');
  return options.client.request('thread/compact/start', { threadId });
}

function createCodexHandlers(port, options = {}) {
  return Object.freeze({
    'runtime.prewarm': () => port.prewarm(),
    'turn.intervene': ({ command }) => port.intervene(command.payload),
    'interaction.answer': (context) => resolveThenRespond(
      context,
      'question',
      {
        action: context.command.payload.action,
        ...(context.command.payload.answer === undefined
          ? {} : { answer: context.command.payload.answer })
      },
      () => port.answerInteraction(context.command.payload),
      options
    ),
    'approval.decide': (context) => resolveThenRespond(
      context,
      'approval',
      { choiceId: context.command.payload.choiceId },
      () => port.decideApproval(context.command.payload),
      options
    ),
    'slash.execute': ({ command }) => port.executeSlash(command.payload)
  });
}

async function resolveThenRespond(context, kind, resolution, respond, options) {
  const payload = context.command.payload;
  const identity = { kind, revision: payload.revision };
  const persistedResolution = projectInteractionResolutionForPersistence(
    readInteraction(context.store, payload.interactionId),
    resolution
  );
  const result = await createResolutionCoordinator(context.store, options).resolve(
    payload.interactionId,
    { ...identity, resolution: persistedResolution, sessionId: context.sessionId },
    respond
  );
  return result.response;
}

function readInteraction(store, interactionId) {
  const repository = store && store.interactions;
  return repository && typeof repository.get === 'function'
    ? repository.get(interactionId)
    : null;
}

function createResolutionCoordinator(store, options = {}) {
  const transitions = requireInteractionTransitions(store);
  return new InteractionResolutionCoordinator({
    claim: (interactionId, input) => (
      transitions.claimInteractionResolution(interactionId, input)
    ),
    finish: (claim) => transitions.finishInteractionResolution(claim),
    release: (claim) => transitions.releaseInteractionResolution(claim)
  }, {
    releaseFailureSink: options.releaseFailureSink
  });
}

function requireInteractionTransitions(store) {
  const methods = [
    'claimInteractionResolution',
    'finishInteractionResolution',
    'releaseInteractionResolution'
  ];
  if (!store || methods.some((method) => typeof store[method] !== 'function')) {
    throw new ChatRuntimeError('chat_interaction_store_unavailable', 500);
  }
  return store;
}

function requireActive(run) {
  if (!run) throw new ChatRuntimeError('chat_turn_not_active', 409);
  return run;
}

function requiredText(value, code) {
  const text = String(value || '').trim();
  if (!text) throw new ChatRuntimeError(code, 422);
  return text;
}

module.exports = { createCodexCommandPort, createCodexHandlers };
