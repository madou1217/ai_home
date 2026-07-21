'use strict';

const crypto = require('node:crypto');

const { adaptCliPrompt, extractCliChoice } = require('./cli-interaction-adapter');
const { ChatRuntimeError, normalizeCommand } = require('./chat-runtime/contracts');
const {
  projectInteractionCommandForPersistence
} = require('./chat-runtime/interaction-secret-policy');

function createCliInteractionCoordinator(options = {}) {
  const service = options.chatRuntimeService;
  const routes = new Map();
  const activeByCorrelation = new Map();
  const deliveries = new Map();

  async function sync(input = {}) {
    requireService(service);
    const correlationId = requiredText(input.correlationId, 'cli_interaction_correlation_required');
    const nativeSession = input.session || {};
    if (String(nativeSession.provider || '').trim().toLowerCase() !== 'codex') {
      throw new ChatRuntimeError('cli_interaction_provider_invalid', 422);
    }

    if (input.resolvedDeliveryId) acknowledgeDelivery(correlationId, input.resolvedDeliveryId);
    if (input.clearedPromptId) clearPrompt(correlationId, input.clearedPromptId, input.clearedPromptRevision);
    let promptRegistration = null;
    if (input.prompt) {
      const session = await resolveCanonicalSession(service, nativeSession, input.accountRef);
      promptRegistration = registerPrompt(
        correlationId,
        session,
        nativeSession,
        input.prompt,
        input.promptRevision
      );
    }

    const delivery = deliveries.get(correlationId);
    return {
      ok: true,
      ...(promptRegistration && promptRegistration.changed ? {
        promptChanged: true,
        sessionId: promptRegistration.route.sessionId
      } : {}),
      ...(delivery ? {
        command: {
          deliveryId: delivery.deliveryId,
          promptId: delivery.route.promptId,
          promptRevision: delivery.route.promptRevision,
          choiceValue: delivery.choiceValue
        }
      } : {})
    };
  }

  async function dispatch(sessionId, input = {}) {
    const interactionId = String(input && input.payload && input.payload.interactionId || '').trim();
    const route = routes.get(interactionId);
    if (!route) return null;
    if (route.sessionId !== sessionId) throw new ChatRuntimeError('stale_interaction', 409);

    const command = normalizeCommand({ ...input, sessionId });
    if (service.store.getCommand(command.commandId)) {
      const accepted = service.store.acceptCommand(command);
      return commandResponse(accepted.command, true);
    }
    const current = service.store.validateInteraction(interactionId, {
      sessionId,
      revision: command.payload.revision,
      kind: route.kind
    });
    const choiceValue = extractCliChoice(command, route);
    const persisted = projectInteractionCommandForPersistence(command, current);
    const accepted = service.store.acceptCommand(persisted);
    if (accepted.duplicate) return commandResponse(accepted.command, true);

    const resolution = { action: 'submit', answer: command.payload.answer };
    const claim = service.store.claimInteractionResolution(interactionId, {
      sessionId,
      revision: command.payload.revision,
      kind: route.kind,
      resolution
    });
    const delivery = {
      deliveryId: `cli-delivery-${crypto.randomUUID()}`,
      commandId: command.commandId,
      choiceValue,
      claim,
      route
    };
    deliveries.set(route.correlationId, delivery);
    return commandResponse(accepted.command, false, { queued: true });
  }

  function registerPrompt(correlationId, session, nativeSession, prompt, promptRevision) {
    const adapted = adaptCliPrompt({
      correlationId,
      nativeSessionId: nativeSession.sessionId,
      prompt,
      promptRevision,
      sessionId: session.sessionId
    });
    const previous = activeByCorrelation.get(correlationId);
    if (previous && previous.interactionId === adapted.route.interactionId) {
      return { changed: false, route: previous };
    }
    if (previous && previous.interactionId !== adapted.route.interactionId) {
      settleElsewhere(previous);
    }

    const existing = service.store.interactions.get(adapted.route.interactionId);
    if (!existing) service.store.createInteraction(adapted.interaction);
    const route = {
      ...adapted.route,
      correlationId,
      sessionId: session.sessionId,
      kind: adapted.interaction.kind
    };
    routes.set(route.interactionId, route);
    activeByCorrelation.set(correlationId, route);
    return { changed: true, route };
  }

  function clearPrompt(correlationId, promptId, promptRevision) {
    const route = activeByCorrelation.get(correlationId);
    if (!route || route.promptId !== String(promptId || '').trim()) return false;
    if (promptRevision && route.promptRevision !== Number(promptRevision)) return false;
    settleElsewhere(route);
    return true;
  }

  function settleElsewhere(route) {
    const delivery = deliveries.get(route.correlationId);
    if (delivery && delivery.route.interactionId === route.interactionId) {
      service.store.finishInteractionResolution(delivery.claim);
      service.store.completeCommand(delivery.commandId, 'completed', { resolvedElsewhere: true });
      deliveries.delete(route.correlationId);
    } else {
      service.store.acknowledgeExternalInteraction(route.interactionId);
    }
    routes.delete(route.interactionId);
    if (activeByCorrelation.get(route.correlationId) === route) {
      activeByCorrelation.delete(route.correlationId);
    }
  }

  function acknowledgeDelivery(correlationId, deliveryId) {
    const delivery = deliveries.get(correlationId);
    if (!delivery || delivery.deliveryId !== String(deliveryId || '').trim()) return false;
    service.store.finishInteractionResolution(delivery.claim);
    service.store.completeCommand(delivery.commandId, 'completed', { delivered: true });
    deliveries.delete(correlationId);
    routes.delete(delivery.route.interactionId);
    if (activeByCorrelation.get(correlationId) === delivery.route) activeByCorrelation.delete(correlationId);
    return true;
  }

  return { sync, dispatch };
}

async function resolveCanonicalSession(service, nativeSession, accountRef) {
  const identity = {
    provider: 'codex',
    nativeSessionId: requiredText(nativeSession.sessionId, 'cli_interaction_native_session_required')
  };
  const existing = service.store.sessions.findByNativeIdentity(identity);
  if (existing) return existing;
  const executionAccountRef = requiredText(accountRef, 'cli_interaction_account_required');
  const result = await service.resolveSession({
    ...identity,
    executionAccountRef,
    projectPath: String(nativeSession.projectPath || '').trim(),
    policy: {}
  });
  return result.session;
}

function commandResponse(command, duplicate, result) {
  return {
    sessionId: command.sessionId,
    commandId: command.commandId,
    acceptedSeq: command.acceptedSeq,
    duplicate,
    result: result === undefined ? command.result : result
  };
}

function requireService(service) {
  if (!service || !service.store) throw new ChatRuntimeError('chat_runtime_unavailable', 503);
}

function requiredText(value, code) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new ChatRuntimeError(code, 422);
  return text;
}

module.exports = { createCliInteractionCoordinator };
