'use strict';

const { ChatRuntimeError } = require('./chat-runtime/contracts');

class ChatRuntimeRecoveryCoordinator {
  constructor(options) {
    this.actors = options.actors;
    this.store = options.store;
    this.bySession = new Map();
    this.ready = Promise.resolve([]);
  }

  start() {
    const sessions = this.store.listRecoveryCandidates() || [];
    const recoveries = sessions.map((session) => {
      const recovery = this.recover(session);
      this.bySession.set(session.sessionId, recovery);
      return recovery;
    });
    this.ready = Promise.allSettled(recoveries);
    return this.ready;
  }

  waitForSession(sessionId) {
    return this.bySession.get(sessionId) || Promise.resolve();
  }

  waitForAll() { return this.ready; }

  async recover(session) {
    try {
      const state = this.store.beginRestartRecovery(session.sessionId);
      if (!state.recoverable) return state;
      requireNativeSession(state.session);
      await this.actors.acquire(state.session, state);
      return this.store.readRestartRecovery(session.sessionId);
    } catch (error) {
      this.actors.dispose(session.sessionId);
      return this.store.failRestartRecovery(session.sessionId, error);
    }
  }
}

function requireNativeSession(session) {
  const nativeSessionId = String(
    session.runtimeBinding && session.runtimeBinding.nativeSessionId || ''
  ).trim();
  if (!nativeSessionId) {
    throw new ChatRuntimeError('chat_native_session_missing_during_recovery', 409);
  }
}

module.exports = { ChatRuntimeRecoveryCoordinator };
