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

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function runMatchesSession(run, input = {}) {
  if (!run) return false;
  const provider = normalizeText(input.provider);
  const sessionId = normalizeText(input.sessionId);
  if (!provider || !sessionId) return false;
  return normalizeText(run.provider) === provider
    && normalizeText(run.sessionId) === sessionId
    && normalizeText(run.projectDirName) === normalizeText(input.projectDirName);
}

function findNativeChatRunBySession(input = {}) {
  for (const run of nativeChatRuns.values()) {
    if (runMatchesSession(run, input)) return run;
  }
  return null;
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
  findNativeChatRunBySession,
  createChatEventMeta
};
