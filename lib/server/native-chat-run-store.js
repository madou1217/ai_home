'use strict';

const { externalizeSessionEventArtifact } = require('./native-chat-run-artifact-store');
const {
  persistNativeChatRunEvent,
  readPersistedNativeChatRunEvents
} = require('./native-chat-run-persistence');

const nativeChatRuns = new Map();
const DEFAULT_MAX_RUN_EVENTS = 1000;

// Deletion retains the inspected handle, not a caller-supplied PID or the public
// registry's presence. A normal turn's `done` may settle before its child exits.
const { ChildProcess } = require('node:child_process');
let PtyTerminal;
function isPtyChild(child) {
  if (PtyTerminal === undefined) {
    try { PtyTerminal = require('node-pty/lib/terminal').Terminal; } catch (_error) { PtyTerminal = null; }
  }
  return Boolean(PtyTerminal && child instanceof PtyTerminal);
}

const deletionChildExits = new WeakMap();
const deletionSnapshots = new WeakSet();
const deletionObservers = new Map();

function beginNativeAccountDeletion(provider, accountRef, token, expiresAt) {
  deletionObservers.set(token, { provider, accountRef, expiresAt, begun: true, changed: false });
}

// Check before any spawn side effect. Only begin installs an observer; inspect
// alone must never block launches. Expired/cancelled leases cannot strand users.
function assertNativeAccountLaunchAllowed(provider, accountRef, aiHomeDir) {
  require('./account-deletion-runtime').restorePreparedGates(aiHomeDir);
  const targetProvider = String(provider || '').trim().toLowerCase();
  const targetRef = String(accountRef || '').trim();
  if (!targetProvider || !targetRef) return;
  const now = Date.now();
  for (const [token, observer] of deletionObservers) {
    if (!observer.prepared && observer.expiresAt <= now) {
      deletionObservers.delete(token);
      continue;
    }
    if (observer.begun === true && observer.provider === targetProvider && observer.accountRef === targetRef) {
      const error = new Error('account_runtime_active');
      error.code = 'account_runtime_active';
      throw error;
    }
  }
}

function pinNativeAccountDeletion(token) {
  const observer = deletionObservers.get(token);
  if (!observer) throw deletionRunError();
  observer.prepared = true;
}

function renewNativeAccountDeletion(token, expiresAt) {
  const observer = deletionObservers.get(token);
  if (!observer || observer.prepared) throw deletionRunError();
  observer.expiresAt = expiresAt;
}

function endNativeAccountDeletion(token) {
  deletionObservers.delete(token);
}

function nativeAccountDeletionChanged(token) {
  const observer = deletionObservers.get(token);
  return !observer || (!observer.prepared && observer.expiresAt <= Date.now()) || observer.changed;
}

function deletionRunError() {
  const error = new Error('native_run_exit_unverifiable');
  error.code = 'account_runtime_unverifiable';
  return error;
}

function captureNativeRunForDeletion(run) {
  const child = run.child || null;
  if (child && (typeof child !== 'object' && typeof child !== 'function')) throw deletionRunError();
  let exit = child && deletionChildExits.get(child);
  if (child && !exit) {
    // A plain object with a pid/kill/onExit method is not a lifecycle owner.
    // In particular, adopted:true + a resolved done promise proves nothing.
    exit = { exited: false, owned: false, pid: null };
    deletionChildExits.set(child, exit);
    if (child instanceof ChildProcess || isPtyChild(child)) {
      exit.pid = child.pid;
      exit.owned = Number.isSafeInteger(exit.pid) && exit.pid > 1 && exit.pid !== process.pid;
      if (exit.owned && child instanceof ChildProcess) {
        exit.exited = Number.isInteger(child.exitCode) || typeof child.signalCode === 'string';
        if (!exit.exited) child.once('exit', () => { exit.exited = true; });
      } else if (exit.owned) {
        child.onExit(() => { exit.exited = true; });
      }
    }
  }
  const snapshot = Object.freeze({
    run,
    child,
    pid: exit && exit.pid,
    exit,
    provider: String(run.provider || '').trim(),
    accountRef: String(run.accountRef || '').trim(),
    runId: String(run.runId || '').trim(),
    abort: run.abort,
    session: String(run.sessionId || run.runId || '').trim()
  });
  deletionSnapshots.add(snapshot);
  return snapshot;
}

function snapshotNativeAccountRuns(provider, accountRef) {
  const snapshots = [];
  for (const run of nativeChatRuns.values()) {
    if (String(run.provider || '').trim() !== provider ||
      String(run.accountRef || '').trim() !== accountRef) continue;
    snapshots.push(captureNativeRunForDeletion(run));
  }
  return snapshots;
}

function inspectNativeRunExit(snapshot) {
  if (!snapshot || !deletionSnapshots.has(snapshot) || !snapshot.run ||
    String(snapshot.run.provider || '').trim() !== snapshot.provider ||
    String(snapshot.run.accountRef || '').trim() !== snapshot.accountRef ||
    String(snapshot.run.runId || '').trim() !== snapshot.runId ||
    (snapshot.run.child || null) !== snapshot.child) throw deletionRunError();
  // Do not probe even an absent PID until the actual child type is trusted.
  // Otherwise an arbitrary object can turn ESRCH into false exit evidence.
  if (!snapshot.exit || !snapshot.exit.owned) return { verifiable: false, exited: false };
  if (snapshot.child.pid !== snapshot.pid || snapshot.exit.pid !== snapshot.pid) throw deletionRunError();
  if (snapshot.exit.exited) return { verifiable: true, exited: true };
  try {
    process.kill(snapshot.pid, 0);
    return { verifiable: true, exited: false };
  } catch (error) {
    if (!error || error.code !== 'ESRCH') throw deletionRunError();
    snapshot.exit.exited = true;
    return { verifiable: true, exited: true };
  }
}

function registerNativeChatRun(run) {
  if (!run || !run.runId) return;
  // Registration follows spawn in legacy callers. Never reject or hide that
  // handle: invalidate the deletion snapshot and let the Go admission guard own
  // pre-spawn exclusion, rather than pretending this Map can prevent a spawn.
  for (const [token, observer] of deletionObservers) {
    if (!observer.prepared && observer.expiresAt <= Date.now()) deletionObservers.delete(token);
    else if (run.provider === observer.provider && run.accountRef === observer.accountRef) observer.changed = true;
  }
  try { captureNativeRunForDeletion(run); } catch (_error) { /* deletion will report unknown, never hide a spawned run */ }
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
  const eventPayload = externalizeSessionEventArtifact(runId, cursor, event, options);
  const item = {
    seq: cursor,
    cursor,
    at: Date.now(),
    ...eventPayload
  };
  if (!item.seq) item.seq = cursor;
  if (!item.cursor) item.cursor = cursor;
  run.eventCursor = cursor;
  run.updatedAt = item.at;
  events.push(item);
  while (events.length > maxEvents) events.shift();
  run.events = events;
  if (item.sessionId) run.sessionId = normalizeText(item.sessionId);
  persistNativeChatRunEvent(run, item, options);
  return item;
}

function readNativeChatRunEvents(runId, options = {}) {
  const run = getNativeChatRun(runId);
  if (!run) return readPersistedNativeChatRunEvents(runId, options);
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
  const identity = run.gateway === true
    ? { gateway: true }
    : { accountRef: normalizeText(run.accountRef) };
  return {
    runId: normalizeText(runId),
    provider: normalizeText(run.provider),
    ...identity,
    sessionId: normalizeText(run.sessionId),
    projectDirName: normalizeText(run.projectDirName),
    projectPath: normalizeText(run.projectPath),
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
  snapshotNativeAccountRuns,
  inspectNativeRunExit,
  beginNativeAccountDeletion,
  pinNativeAccountDeletion,
  renewNativeAccountDeletion,
  assertNativeAccountLaunchAllowed,
  endNativeAccountDeletion,
  nativeAccountDeletionChanged,
  appendNativeChatRunEvent,
  readNativeChatRunEvents,
  findNativeChatRunBySession,
  createChatEventMeta
};
