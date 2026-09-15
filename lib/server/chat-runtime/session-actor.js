'use strict';

const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const { createGenericCommandHandlers } = require('./chat-command-handlers');
const { ChatRuntimeError, normalizeCommand } = require('./contracts');
const {
  projectInteractionCommandForPersistence
} = require('./interaction-secret-policy');
const { sanitizeCanonicalDiagnostic } = require('./canonical-diagnostic-sanitizer');
const { SessionQueueLifecycle } = require('./session-queue-lifecycle');
const { TurnLifecycle } = require('./turn-lifecycle');
const { createChatRuntimeExtensionPipeline } = require('./chat-runtime-extension-pipeline');
const { branchSessionId } = require('./branch-session-identity');

const INTERACTION_COMMAND_KINDS = new Map([
  ['interaction.answer', 'question'],
  ['approval.decide', 'approval']
]);

class SessionActor {
  constructor(options) {
    this.sessionId = options.sessionId;
    this.store = options.store;
    this.extensions = createChatRuntimeExtensionPipeline(options.extensions);
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

  supportsHistoryBranch() {
    const port = this.turn.driver.historyBranch;
    return typeof port?.plan === 'function' && typeof port?.native === 'function';
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
    const extensionContext = {
      sessionId: this.sessionId,
      command: structuredClone(command),
      trace: input.trace
    };
    const existing = this.store.getCommand(command.commandId);
    if (existing && (existing.sessionId !== command.sessionId || existing.type !== command.type)) {
      throw new ChatRuntimeError('chat_command_id_conflict', 409);
    }
    if (existing && ['session.fork', 'turn.regenerate'].includes(command.type)
      && !isDeepStrictEqual(existing.payload, command.payload)) {
      throw new ChatRuntimeError('chat_command_id_conflict', 409);
    }
    if (existing && !(existing.status === 'accepted'
      && ['session.fork', 'turn.regenerate'].includes(command.type))) {
      return duplicateResponse(existing);
    }
    let prepared;
    try {
      const candidate = command.type === 'turn.submit' || command.type === 'turn.retry'
        ? await this.extensions.runWaterfall('prepareNextTurn', structuredClone(command), extensionContext)
        : command;
      if (!candidate || candidate.commandId !== command.commandId
        || candidate.sessionId !== command.sessionId || candidate.type !== command.type) {
        throw new ChatRuntimeError('chat_extension_command_identity_changed', 409);
      }
      prepared = normalizeCommand(candidate);
    } catch (error) {
      // A failed preparation still owns its command id. Persist the original
      // validated request so retries cannot rerun a failing preparation hook.
      const rejected = this.store.acceptCommand(command);
      if (!rejected.duplicate) this.failCommand(command.commandId, error);
      this.extensions.observe({ type: 'command.failed', command, error }, extensionContext);
      throw error;
    }
    extensionContext.command = prepared;
    const interaction = interactionForCommand(this.store, command);
    const persisted = projectInteractionCommandForPersistence(prepared, interaction);
    const accepted = this.store.acceptCommand({
      ...persisted,
      ...(input.trace ? { trace: input.trace } : {})
    });
    if (accepted.duplicate && !(accepted.command.status === 'accepted'
      && ['session.fork', 'turn.regenerate'].includes(command.type))) return duplicateResponse(accepted.command);
    extensionContext.acceptedCommand = accepted.command;
    try {
      const executable = { ...accepted.command, payload: prepared.payload };
      await this.extensions.runSerial('beforeCommand', structuredClone(executable), {
        ...extensionContext,
        command: structuredClone(executable)
      });
      this.extensions.observe({ type: 'command.accepted', command: structuredClone(executable) }, {
        ...extensionContext,
        command: structuredClone(executable)
      });
      const result = await this.execute(executable, input.trace);
      this.store.completeCommand(accepted.command.commandId, 'completed', result);
      this.extensions.observe({ type: 'command.completed', command: executable, result }, {
        ...extensionContext,
        command: executable,
        result
      });
      return commandResponse(accepted.command, false, result);
    } catch (error) {
      this.failCommand(accepted.command.commandId, error);
      this.extensions.observe({ type: 'command.failed', command: extensionContext.command, error }, extensionContext);
      throw error;
    }
  }

  execute(command, trace) {
    if (command.type === 'turn.submit') return this.turn.submit(command, null, trace);
    if (command.type === 'turn.retry') return this.turn.retry(command, trace);
    if (command.type === 'slash.execute' && String(command.payload.name).replace(/^\//, '') === 'compact'
      && !String(command.payload.arguments || '').trim()
      && typeof this.turn.driver.compactThread === 'function') {
      return this.turn.submit(command, null, trace);
    }
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
      historyBranch: this.turn.driver.historyBranch,
      trace
    });
  }

  failCommand(commandId, error) {
    // A native branch can have accepted I/O without a receipt. Keep its
    // existing command resumable; recovery consults durable checkpoints only.
    if (this.store.store?.branchOperations?.read(this.sessionId, commandId)) return;
    const command = this.store.getCommand(commandId);
    if (command && ['session.fork', 'turn.regenerate'].includes(command.type)) {
      const child = this.store.getSession(branchSessionId(commandId));
      if (child?.policy.lineage?.parentSessionId === this.sessionId
        && child.policy.lineage.commandId === commandId) return;
    }
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
