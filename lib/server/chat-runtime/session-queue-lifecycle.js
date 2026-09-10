'use strict';

const { ChatRuntimeError } = require('./contracts');

class SessionQueueLifecycle {
  constructor(options) {
    this.turn = options.turn;
    this.idFactory = options.idFactory;
  }

  dispatch(context) {
    const command = context.command;
    // Recheck inside the actor mailbox: a newer submit/stop may have won the
    // race after the coordinator observed the successful completion.
    if (command.payload.afterRunId) {
      const session = context.store.getSession(context.sessionId);
      if (session.state !== 'idle' || session.activeTurn || session.policy.queueControl?.paused
        || session.policy.queueControl?.lastRunId !== command.payload.afterRunId) {
        return { skipped: true, reason: 'queue_boundary_superseded' };
      }
    }
    this.turn.ensureCanSubmit();
    const item = context.store.leaseQueueItem(context.sessionId, {
      queueId: command.payload.queueId,
      leaseId: this.idFactory('lease'),
      policy: command.payload.policy
    });
    if (!item) {
      throw new ChatRuntimeError('chat_queue_item_unavailable', 409, {
        queueId: command.payload.queueId
      });
    }
    const started = this.turn.submit({
      ...command,
      type: 'turn.submit',
      payload: item.payload
    }, {
      queueId: item.queueId,
      leaseId: item.leaseId
    }, context.trace);
    return { ...started, queueId: item.queueId };
  }
}

module.exports = { SessionQueueLifecycle };
