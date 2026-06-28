'use strict';

const nativeChatRuns = new Map();
const DEFAULT_MAX_RUN_EVENTS = 1000;

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

function listNativeChatRuns() {
  return Array.from(nativeChatRuns.values());
}

function normalizeRunEventCursor(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}

function appendNativeChatRunEvent(runId, event = {}, options = {}) {
  const run = getNativeChatRun(runId);
  if (!run) return null;
  const maxEvents = Math.max(1, Math.floor(Number(options.maxEvents) || DEFAULT_MAX_RUN_EVENTS));
  const events = Array.isArray(run.events) ? run.events : [];
  const cursor = normalizeRunEventCursor(run.eventCursor) + 1;
  const item = {
    seq: cursor,
    cursor,
    at: Date.now(),
    ...event
  };
  if (!item.seq) item.seq = cursor;
  if (!item.cursor) item.cursor = cursor;
  run.eventCursor = cursor;
  run.updatedAt = item.at;
  events.push(item);
  while (events.length > maxEvents) events.shift();
  run.events = events;
  if (item.sessionId) run.sessionId = normalizeText(item.sessionId);
  return item;
}

function readNativeChatRunEvents(runId, options = {}) {
  const run = getNativeChatRun(runId);
  if (!run) return null;
  const cursor = normalizeRunEventCursor(options.cursor);
  const limit = Math.max(1, Math.min(500, Math.floor(Number(options.limit) || 100)));
  const events = (Array.isArray(run.events) ? run.events : [])
    .filter((event) => normalizeRunEventCursor(event && event.cursor) > cursor)
    .map((event) => ({
      ...event,
      seq: normalizeRunEventCursor(event && (event.seq || event.cursor)),
      cursor: normalizeRunEventCursor(event && event.cursor)
    }))
    .slice(0, limit);
  const latestCursor = Math.max(cursor, normalizeRunEventCursor(run.eventCursor));
  return {
    runId: normalizeText(runId),
    provider: normalizeText(run.provider),
    sessionId: normalizeText(run.sessionId),
    status: run.completed ? 'completed' : 'running',
    cursor: latestCursor,
    events,
    truncated: events.length >= limit,
    completed: Boolean(run.completed)
  };
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
  listNativeChatRuns,
  appendNativeChatRunEvent,
  readNativeChatRunEvents,
  findNativeChatRunBySession,
  createChatEventMeta
};
