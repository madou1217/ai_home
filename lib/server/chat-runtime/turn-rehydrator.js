'use strict';

const { ChatRuntimeError } = require('./contracts');

class TurnRehydrator {
  constructor(options) {
    this.driver = options.driver;
    this.sessionId = options.sessionId;
    this.store = options.store;
  }

  async rehydrate(recovery = {}) {
    this.validate(recovery);
    const run = recoveredRun(recovery);
    const providerRun = await this.driver.recoverTurn({
      sessionId: this.sessionId,
      turnId: run.turnId,
      runId: run.runId,
      activeTurn: recovery.activeTurn,
      queue: recovery.queue,
      pendingInteractions: recovery.interactions || []
    });
    const attached = await this.completeRecovery(providerRun);
    run.queue = queueIdentity(attached.queue);
    return {
      activeTurn: attached.activeTurn,
      done: providerRun && providerRun.done,
      run,
      state: attached.session.state
    };
  }

  async completeRecovery(providerRun) {
    try {
      return this.store.completeRestartRecovery(this.sessionId, {
        nativeTurnId: providerRun && providerRun.nativeTurnId
      });
    } catch (error) {
      const nativeCleanup = await abandonProviderRun(providerRun, error);
      if (error && typeof error === 'object') error.nativeCleanup = nativeCleanup;
      throw error;
    }
  }

  validate(recovery) {
    if (!recovery.activeTurn || typeof this.driver.recoverTurn !== 'function') {
      throw new ChatRuntimeError('chat_turn_recovery_unsupported', 422);
    }
  }
}

async function abandonProviderRun(providerRun, reason) {
  if (!providerRun || typeof providerRun.abandon !== 'function') return 'unsupported';
  try {
    return await providerRun.abandon(reason) || 'completed';
  } catch (_error) {
    return 'failed';
  }
}

function recoveredRun(recovery) {
  return {
    turnId: recovery.activeTurn.turnId,
    runId: recovery.activeTurn.runId,
    clientUserMessageId: recovery.activeTurn.clientUserMessageId,
    nativeTurnId: recovery.activeTurn.nativeTurnId,
    interruptRequested: false,
    settlement: null,
    queue: queueIdentity(recovery.queue),
    trace: null
  };
}

function queueIdentity(queue) {
  return queue && queue.queueId && queue.leaseId
    ? { queueId: queue.queueId, leaseId: queue.leaseId }
    : null;
}

module.exports = { TurnRehydrator };
