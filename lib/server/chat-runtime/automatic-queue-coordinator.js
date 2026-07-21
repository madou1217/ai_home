'use strict';

const {
  AutomaticQueueBoundaryStrategy
} = require('./automatic-queue-boundary-strategy');
const { sanitizeCanonicalDiagnostic } = require('./canonical-diagnostic-sanitizer');

class AutomaticQueueCoordinator {
  constructor(options) {
    this.store = options.store;
    this.dispatchCommand = options.dispatchCommand;
    this.waitForIdle = options.waitForIdle;
    this.idFactory = options.idFactory;
    this.strategy = options.strategy || new AutomaticQueueBoundaryStrategy();
    this.schedule = options.schedule || ((task) => setImmediate(task));
    this.onError = options.onError || (() => {});
    this.lanes = new Map();
    this.closed = false;
  }

  observe(event) {
    if (this.closed) return false;
    const session = this.store.getSession(event && event.sessionId);
    const action = session && this.strategy.resolve(event, session);
    if (!action) return false;
    this.schedule(() => this.enqueue(action));
    return true;
  }

  close() {
    this.closed = true;
    this.lanes.clear();
  }

  enqueue(action) {
    if (this.closed) return;
    const previous = this.lanes.get(action.sessionId) || Promise.resolve();
    const current = previous
      .then(() => this.closed ? null : this.execute(action))
      .catch((error) => this.report(error, action));
    this.lanes.set(action.sessionId, current);
    current.then(() => {
      if (this.lanes.get(action.sessionId) === current) {
        this.lanes.delete(action.sessionId);
      }
    });
  }

  execute(action) {
    return action.type === 'tool_boundary'
      ? this.interveneAtToolBoundary(action)
      : this.dispatchAfterTurn(action);
  }

  async interveneAtToolBoundary(action) {
    const item = this.store.leaseNextQueueItem(action.sessionId, {
      leaseId: this.idFactory('lease'),
      policy: action.policy,
      boundaryItemId: action.boundaryItemId
    });
    if (!item) return null;
    this.store.markQueueRunning(item.queueId, item.leaseId);
    const command = interventionCommand(action, item);
    try {
      const response = await this.dispatchCommand(action.sessionId, command);
      return this.store.settleQueueItem(
        item.queueId,
        item.leaseId,
        'completed',
        { commandId: command.commandId, result: response.result }
      );
    } catch (error) {
      return this.store.settleQueueItem(
        item.queueId,
        item.leaseId,
        'failed',
        { commandId: command.commandId, error: serializeError(error) }
      );
    }
  }

  async dispatchAfterTurn(action) {
    await this.waitForIdle(action.sessionId);
    if (this.closed || !hasQueuedPolicy(this.store, action.sessionId, action.policy)) {
      return null;
    }
    return this.dispatchCommand(action.sessionId, {
      commandId: automaticCommandId(action),
      type: 'queue.dispatch',
      payload: { policy: action.policy }
    });
  }

  report(error, action) {
    try { this.onError(error, action); } catch (_reportError) {}
    return null;
  }
}

function interventionCommand(action, item) {
  return {
    commandId: automaticCommandId(action, item.queueId),
    type: 'turn.intervene',
    payload: { mode: 'steer_current', content: item.payload.content }
  };
}

function automaticCommandId(action, queueId) {
  const parts = ['aih-auto', action.type, action.sessionId, action.identity];
  if (queueId) parts.push(queueId);
  return parts.map((part) => encodeURIComponent(String(part))).join(':');
}

function hasQueuedPolicy(store, sessionId, policy) {
  return store.listQueue(sessionId, { activeOnly: true }).some((item) => (
    item.status === 'queued' && item.policy === policy
  ));
}

function serializeError(error) {
  return sanitizeCanonicalDiagnostic(error, {
    fallbackCode: 'chat_command_failed',
    includeStatusCode: true
  });
}

module.exports = { AutomaticQueueCoordinator };
