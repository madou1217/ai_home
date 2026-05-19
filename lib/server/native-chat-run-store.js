'use strict';

const nativeChatRuns = new Map();

function registerNativeChatRun(run) {
  if (!run || !run.runId) return;
  nativeChatRuns.set(run.runId, run);
}

function unregisterNativeChatRun(runId) {
  if (!runId) return;
  nativeChatRuns.delete(runId);
}

function getNativeChatRun(runId) {
  if (!runId) return null;
  return nativeChatRuns.get(runId) || null;
}

function createChatEventMeta(startedAt, extra = {}) {
  const now = Date.now();
  return {
    ts: new Date(now).toISOString(),
    elapsedMs: now - startedAt,
    ...extra
  };
}

module.exports = {
  registerNativeChatRun,
  unregisterNativeChatRun,
  getNativeChatRun,
  createChatEventMeta
};
