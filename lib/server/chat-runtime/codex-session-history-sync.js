'use strict';

const {
  hydrateCodexHistoryResponse,
  readCodexSessionHistory,
  projectCodexSessionHistory
} = require('./codex-session-history');

class CodexSessionHistorySync {
  constructor(options = {}) {
    this.client = options.client;
    this.getThreadId = options.getThreadId || (() => '');
    this.historyReader = options.historyReader || readCodexSessionHistory;
    this.historySink = options.historySink;
    this.readNativeThreadItems = options.readNativeThreadItems;
    this.readNativeCoverage = options.readNativeCoverage;
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
      runtimeId: this.runtimeId, ...this.nativeEvidenceOptions()
    });
    return this.historySink(history);
  }

  async importRecovered(response, recoveryAnchor) {
    if (typeof this.historySink !== 'function') return { imported: 0, skipped: true };
    const threadId = this.getThreadId();
    const hydrated = await hydrateCodexHistoryResponse(this.client, response, { threadId });
    return this.historySink(projectCodexSessionHistory(hydrated, {
      threadId, runtimeId: this.runtimeId, recoveryAnchor,
      ...this.nativeEvidenceOptions()
    }));
  }

  nativeEvidenceOptions() {
    return this.readNativeThreadItems && this.readNativeCoverage
      ? { readNativeThreadItems: this.readNativeThreadItems, readNativeCoverage: this.readNativeCoverage } : {};
  }
}

module.exports = { CodexSessionHistorySync };
