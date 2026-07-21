'use strict';

const { ChatRuntimeError } = require('./contracts');
const { TurnRehydrator } = require('./turn-rehydrator');
const { terminalResult } = require('./turn-settlement');

class TurnLifecycle {
  constructor(options) {
    this.sessionId = options.sessionId;
    this.store = options.store;
    this.driver = options.driver || {};
    this.idFactory = options.idFactory;
    this.enqueue = options.enqueue;
    this.active = null;
    this.rehydrator = new TurnRehydrator({
      driver: this.driver,
      sessionId: this.sessionId,
      store: this.store
    });
  }

  ensureCanSubmit() {
    if (this.active) throw new ChatRuntimeError('chat_turn_already_active', 409);
    if (typeof this.driver.startTurn !== 'function') {
      throw new ChatRuntimeError('chat_turn_driver_unavailable', 422);
    }
  }

  async rehydrate(recovery = {}) {
    if (this.active) throw new ChatRuntimeError('chat_turn_already_active', 409);
    const restored = await this.rehydrator.rehydrate(recovery);
    this.active = restored.run;
    restored.run.settlement = this.watch(restored.run, restored.done);
    return {
      turnId: restored.run.turnId,
      runId: restored.run.runId,
      state: restored.state
    };
  }

  submit(command, queue, trace) {
    this.ensureCanSubmit();
    const run = this.createRun(command, queue, trace, this.resolveImagePaths(command));
    this.active = run;
    try {
      this.begin(run);
    } catch (error) {
      this.active = null;
      throw error;
    }
    let providerRun;
    try {
      providerRun = this.driver.startTurn(this.driverContext(run, command));
    } catch (error) {
      this.failStart(run, error);
      throw error;
    }
    run.settlement = this.watch(run, providerRun);
    this.transition(run, 'running', 'turn.started');
    return { turnId: run.turnId, runId: run.runId, state: 'running' };
  }

  async interrupt(command) {
    const run = this.active;
    if (!run) throw new ChatRuntimeError('chat_turn_not_active', 409);
    if (typeof this.driver.interruptTurn !== 'function') {
      throw new ChatRuntimeError('chat_turn_interrupt_unsupported', 422);
    }
    this.transition(run, 'interrupting', 'turn.interrupt.requested', {
      reason: command.payload.reason || 'user_stop'
    });
    run.interruptRequested = true;
    try {
      await this.driver.interruptTurn(this.driverContext(run, command));
    } catch (error) {
      run.interruptRequested = false;
      try {
        this.transition(run, 'running', 'turn.phase.changed');
      } catch (rollbackError) {
        attachSecondaryError(error, 'rollbackError', rollbackError);
      }
      throw error;
    }
    return { turnId: run.turnId, runId: run.runId, state: 'interrupting' };
  }

  async waitForIdle() {
    while (this.active) {
      const settlement = this.active.settlement;
      if (settlement) await settlement;
      else await new Promise((resolve) => setImmediate(resolve));
    }
  }

  dispose() {
    if (this.driver && typeof this.driver.dispose === 'function') {
      return this.driver.dispose();
    }
    return false;
  }

  createRun(command, queue, trace, imagePaths) {
    const runId = this.idFactory('run');
    const run = {
      turnId: this.idFactory('turn'),
      runId,
      clientUserMessageId: runId,
      interruptRequested: false,
      settlement: null,
      imagePaths,
      queue: queue || null,
      trace
    };
    if (trace && typeof trace.bindRun === 'function') trace.bindRun(run.runId);
    return run;
  }

  driverContext(run, command) {
    return {
      sessionId: this.sessionId,
      turnId: run.turnId,
      runId: run.runId,
      command,
      imagePaths: run.imagePaths,
      trace: run.trace
    };
  }

  resolveImagePaths(command) {
    const attachmentIds = command && command.payload && command.payload.attachmentIds;
    if (!Array.isArray(attachmentIds) || attachmentIds.length === 0) return [];
    if (typeof this.store.resolveAttachmentPaths !== 'function') {
      throw new ChatRuntimeError('chat_attachment_store_unavailable', 503);
    }
    return this.store.resolveAttachmentPaths(this.sessionId, attachmentIds);
  }

  watch(run, providerRun) {
    return Promise.resolve(providerRun).then(
      (result) => this.enqueue(() => this.finish(run, result, null)),
      (error) => this.enqueue(() => this.finish(run, null, error))
    ).catch(() => {});
  }

  finish(run, result, error) {
    if (this.active !== run) return;
    try {
      this.settle(run, result, error);
    } finally {
      this.active = null;
    }
  }

  failStart(run, error) {
    try {
      this.settle(run, null, error);
    } catch (settlementError) {
      attachSecondaryError(error, 'settlementError', settlementError);
    } finally {
      this.active = null;
    }
  }

  settle(run, result, error) {
    const terminal = terminalResult(run, result, error);
    this.store.settleTurn(this.sessionId, {
      queue: run.queue && {
        ...run.queue,
        outcome: terminal.outcome,
        result: terminal.queueResult
      },
      event: this.eventDraft(terminal.type, run, terminal.payload)
    });
  }

  begin(run) {
    const activeTurn = this.activeTurn(run, 'starting');
    this.store.beginTurn(this.sessionId, {
      activeTurn,
      queue: run.queue,
      event: this.eventDraft('turn.queued', run, {
        state: 'starting',
        activeTurn
      })
    });
  }

  transition(run, state, type, payload = {}) {
    const activeTurn = this.activeTurn(run, state);
    this.store.transitionTurnPhase(this.sessionId, {
      state,
      activeTurn,
      event: this.eventDraft(type, run, {
        ...payload,
        state,
        activeTurn
      })
    });
    return activeTurn;
  }

  activeTurn(run, state) {
    const session = this.store.getSession(this.sessionId);
    const existing = session && session.activeTurn && session.activeTurn.runId === run.runId
      ? session.activeTurn
      : {};
    const activeTurn = {
      turnId: run.turnId,
      runId: run.runId,
      clientUserMessageId: existing.clientUserMessageId || run.clientUserMessageId,
      ...(existing.nativeTurnId || run.nativeTurnId
        ? { nativeTurnId: existing.nativeTurnId || run.nativeTurnId }
        : {}),
      state
    };
    return activeTurn;
  }

  eventDraft(type, run, payload) {
    const session = this.store.getSession(this.sessionId);
    return {
      type,
      turnId: run.turnId,
      runId: run.runId,
      source: {
        provider: session.provider,
        runtimeId: String(session.runtimeBinding.runtimeId || 'unbound')
      },
      payload
    };
  }
}

function attachSecondaryError(primary, property, secondary) {
  if (!primary || typeof primary !== 'object') return;
  try { primary[property] = secondary; } catch (_error) {}
}

module.exports = { TurnLifecycle };
