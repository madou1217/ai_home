'use strict';

const { readCodexSessionHistory } = require('./codex-session-history');

class CodexSessionHistorySync {
  constructor(options = {}) {
    this.client = options.client;
    this.getThreadId = options.getThreadId || (() => '');
    this.historyReader = options.historyReader || readCodexSessionHistory;
    this.historySink = options.historySink;
    this.runtimeId = String(options.runtimeId || 'codex:unbound');
    this.inFlightByThreadId = new Map();
  }

  async run() {
    const threadId = String(this.getThreadId() || '').trim();
    if (!threadId || typeof this.historySink !== 'function') {
      return { imported: 0, skipped: true };
    }
    const inFlight = this.inFlightByThreadId.get(threadId);
    if (inFlight) return inFlight;
    const synchronization = this.synchronize(threadId);
    this.inFlightByThreadId.set(threadId, synchronization);
    try {
      return await synchronization;
    } finally {
      if (this.inFlightByThreadId.get(threadId) === synchronization) {
        this.inFlightByThreadId.delete(threadId);
      }
    }
  }

  async synchronize(threadId) {
    const history = await this.historyReader(this.client, threadId, {
      runtimeId: this.runtimeId
    });
    return this.historySink(history);
  }
}

module.exports = { CodexSessionHistorySync };
