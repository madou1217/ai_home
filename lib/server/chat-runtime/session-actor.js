'use strict';

const crypto = require('node:crypto');

const { createGenericCommandHandlers } = require('./chat-command-handlers');
const { ChatRuntimeError, normalizeCommand } = require('./contracts');
const {
  projectInteractionCommandForPersistence
} = require('./interaction-secret-policy');
const { sanitizeCanonicalDiagnostic } = require('./canonical-diagnostic-sanitizer');
const { SessionQueueLifecycle } = require('./session-queue-lifecycle');
const { TurnLifecycle } = require('./turn-lifecycle');

const INTERACTION_COMMAND_KINDS = new Map([
  ['interaction.answer', 'question'],
  ['approval.decide', 'approval']
]);

class SessionActor {
  constructor(options) {
    this.sessionId = options.sessionId;
    this.store = options.store;
    this.composerCatalog = typeof options.composerCatalog === 'function'
      ? options.composerCatalog
      : async () => ({ models: [], defaultModel: '' });
    this.disposed = false;
    this.mailbox = Promise.resolve();
    const idFactory = options.idFactory || ((prefix) => `${prefix}-${crypto.randomUUID()}`);
    this.turn = new TurnLifecycle({
      sessionId: this.sessionId,
      store: this.store,
      driver: options.driver,
      idFactory,
      enqueue: (task) => this.enqueue(task)
    });
    const queueLifecycle = new SessionQueueLifecycle({
      turn: this.turn,
      idFactory
    });
    this.handlers = {
      ...createGenericCommandHandlers({ queueLifecycle }),
      ...(options.handlers || {})
    };
  }

  dispatch(input) {
    if (this.disposed) return Promise.reject(new ChatRuntimeError('chat_actor_closed', 410));
    return this.enqueue(() => this.process(input));
  }

  rehydrate(recovery) {
    if (this.disposed) return Promise.reject(new ChatRuntimeError('chat_actor_closed', 410));
    return this.enqueue(() => this.turn.rehydrate(recovery));
  }

  async waitForIdle() {
    await this.mailbox;
    await this.turn.waitForIdle();
    await this.mailbox;
  }

  readComposerCatalog() {
    if (this.disposed) return Promise.reject(new ChatRuntimeError('chat_actor_closed', 410));
    return this.enqueue(() => this.composerCatalog());
  }

  dispose() {
    if (this.disposed) return false;
    this.disposed = true;
    this.turn.dispose();
    return true;
  }

  enqueue(task) {
    const result = this.mailbox.then(task);
    this.mailbox = result.catch(() => {});
    return result;
  }

  async process(input) {
    if (String(input && input.sessionId || '').trim() !== this.sessionId) {
      throw new ChatRuntimeError('chat_actor_session_mismatch', 409);
    }
    const command = normalizeCommand(input);
    const interaction = interactionForCommand(this.store, command);
    const persisted = projectInteractionCommandForPersistence(command, interaction);
    const accepted = this.store.acceptCommand({
      ...persisted,
      ...(input.trace ? { trace: input.trace } : {})
    });
    if (accepted.duplicate) return duplicateResponse(accepted.command);
    const executable = { ...accepted.command, payload: command.payload };
    try {
      const result = await this.execute(executable, input.trace);
      this.store.completeCommand(accepted.command.commandId, 'completed', result);
      return commandResponse(accepted.command, false, result);
    } catch (error) {
      this.failCommand(accepted.command.commandId, error);
      throw error;
    }
  }

  execute(command, trace) {
    if (command.type === 'turn.submit') return this.turn.submit(command, null, trace);
    if (command.type === 'turn.interrupt') return this.turn.interrupt(command);
    const handler = this.handlers[command.type];
    if (typeof handler !== 'function') {
      throw new ChatRuntimeError('chat_command_handler_unavailable', 422, {
        type: command.type
      });
    }
    return handler({
      sessionId: this.sessionId,
      command,
      store: this.store,
      trace
    });
  }

  failCommand(commandId, error) {
    try {
      this.store.completeCommand(commandId, 'failed', serializeError(error));
    } catch (_completionError) {}
  }
}

function interactionForCommand(store, command) {
  const expectedKind = INTERACTION_COMMAND_KINDS.get(command.type);
  if (!expectedKind) return null;
  const repository = store && store.interactions;
  const read = () => repository && typeof repository.get === 'function'
    ? repository.get(command.payload.interactionId)
    : null;
  if (hasPersistedCommand(store, command.commandId)) return read();
  if (!store || typeof store.validateInteraction !== 'function') {
    throw new ChatRuntimeError('chat_interaction_store_unavailable', 500);
  }
  try {
    return store.validateInteraction(command.payload.interactionId, {
      sessionId: command.sessionId,
      revision: command.payload.revision,
      kind: expectedKind
    });
  } catch (error) {
    if (hasPersistedCommand(store, command.commandId)) return read();
    throw error;
  }
}

function hasPersistedCommand(store, commandId) {
  return Boolean(store && typeof store.getCommand === 'function' && store.getCommand(commandId));
}

function commandResponse(command, duplicate, result) {
  return {
    commandId: command.commandId,
    acceptedSeq: command.acceptedSeq,
    duplicate,
    result
  };
}

function duplicateResponse(command) {
  if (command.status === 'failed') {
    const result = command.result || {};
    throw new ChatRuntimeError(
      result.code || 'chat_command_failed',
      result.statusCode || 500,
      result
    );
  }
  return commandResponse(command, true, command.result);
}

function serializeError(error) {
  return sanitizeCanonicalDiagnostic(error, {
    fallbackCode: 'chat_command_failed',
    includeStatusCode: true
  });
}

module.exports = { SessionActor };
