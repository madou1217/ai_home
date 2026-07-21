'use strict';

const { ChatRuntimeError } = require('./contracts');

class SessionQueueLifecycle {
  constructor(options) {
    this.turn = options.turn;
    this.idFactory = options.idFactory;
  }

  dispatch(context) {
    this.turn.ensureCanSubmit();
    const command = context.command;
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
