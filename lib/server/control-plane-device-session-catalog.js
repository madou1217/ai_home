'use strict';

const {
  buildControlPlaneDeviceSessionEvents,
  buildControlPlaneDeviceSessions
} = require('./control-plane-device-sessions');
const {
  getNativeChatRun,
  listNativeChatRuns,
  readNativeChatRunEvents
} = require('./native-chat-run-store');

const DEFAULT_ALLOWED_RUNNING_COMMANDS = Object.freeze([
  'attach',
  'detach',
  'message',
  'slash',
  'approval_response',
  'stop'
]);
const DEFAULT_ALLOWED_READONLY_COMMANDS = Object.freeze(['attach', 'detach']);

function normalizeText(value, maxLength = 256) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}

function normalizeLimit(value, fallback = 100) {
  const limit = normalizeCount(value || fallback);
  return Math.max(1, Math.min(500, limit));
}

function normalizeStatus(value) {
  const status = normalizeText(value, 32).toLowerCase();
  if (status === 'running') return 'running';
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'draft') return 'draft';
  return status || 'idle';
}

function allowedCommandsForStatus(status) {
  return status === 'running'
    ? DEFAULT_ALLOWED_RUNNING_COMMANDS.slice()
    : DEFAULT_ALLOWED_READONLY_COMMANDS.slice();
}

function latestEventTimestamp(events) {
  const source = Array.isArray(events) ? events : [];
  return source.reduce((latest, event) => {
    const value = Number(event && event.at);
    return Number.isFinite(value) ? Math.max(latest, value) : latest;
  }, 0);
}

function serializeRunSession(run) {
  if (!run || !run.runId) return null;
  const status = run.completed ? 'completed' : 'running';
  const cursor = normalizeCount(run.eventCursor);
  return {
    sessionId: normalizeText(run.runId, 128),
    runId: normalizeText(run.runId, 128),
    provider: normalizeText(run.provider, 64),
    runtimeProvider: normalizeText(run.provider, 64),
    runtimeAccountRef: normalizeText(run.accountId, 96),
    projectPath: normalizeText(run.projectPath, 2048),
    projectDirName: normalizeText(run.projectDirName, 512),
    status,
    cursor,
    lastCursor: cursor,
    startedAt: normalizeCount(run.startedAt),
    updatedAt: latestEventTimestamp(run.events) || normalizeCount(run.updatedAt) || normalizeCount(run.startedAt),
    source: 'active-run',
    allowedCommands: allowedCommandsForStatus(status)
  };
}

function serializeSnapshotSession(session) {
  if (!session || !session.sessionRef) return null;
  const status = normalizeStatus(session.status);
  return {
    sessionId: session.sessionRef,
    sessionRef: session.sessionRef,
    provider: normalizeText(session.provider, 64),
    runtimeProvider: normalizeText(session.provider, 64),
    projectRef: normalizeText(session.projectRef, 96),
    projectName: normalizeText(session.projectName, 120),
    title: normalizeText(session.title, 160),
    status,
    cursor: 0,
    lastCursor: 0,
    startedAt: normalizeCount(session.startedAt),
    updatedAt: normalizeCount(session.updatedAt),
    source: 'session-snapshot',
    allowedCommands: allowedCommandsForStatus(status)
  };
}

function summarizeCatalogSessions(allSessions, returnedSessions) {
  const summary = {
    total: allSessions.length,
    returned: returnedSessions.length,
    byProvider: {},
    byStatus: {},
    bySource: {},
    latestCursor: 0,
    recentlyUpdatedAt: 0
  };
  allSessions.forEach((session) => {
    const provider = normalizeText(session.provider || session.runtimeProvider, 64) || 'unknown';
    const status = normalizeStatus(session.status);
    const source = normalizeText(session.source, 64) || 'unknown';
    summary.byProvider[provider] = normalizeCount(summary.byProvider[provider]) + 1;
    summary.byStatus[status] = normalizeCount(summary.byStatus[status]) + 1;
    summary.bySource[source] = normalizeCount(summary.bySource[source]) + 1;
    summary.latestCursor = Math.max(summary.latestCursor, normalizeCount(session.cursor || session.lastCursor));
    summary.recentlyUpdatedAt = Math.max(summary.recentlyUpdatedAt, normalizeCount(session.updatedAt));
  });
  return summary;
}

function buildRemoteDevelopmentSessionCatalog(projectSnapshot, input = {}, deps = {}) {
  const listRuns = typeof deps.listNativeChatRuns === 'function' ? deps.listNativeChatRuns : listNativeChatRuns;
  const activeRunSessions = (Array.isArray(listRuns()) ? listRuns() : [])
    .map(serializeRunSession)
    .filter(Boolean);
  const snapshotSessions = buildControlPlaneDeviceSessions(projectSnapshot, {
    limit: normalizeLimit(input.snapshotLimit || input.limit)
  }).sessions
    .map(serializeSnapshotSession)
    .filter(Boolean);
  const allSessions = activeRunSessions.concat(snapshotSessions)
    .sort((left, right) => normalizeCount(right.updatedAt) - normalizeCount(left.updatedAt)
      || normalizeText(left.provider).localeCompare(normalizeText(right.provider))
      || normalizeText(left.sessionId).localeCompare(normalizeText(right.sessionId)));
  const limit = normalizeLimit(input.limit);
  const sessions = allSessions.slice(0, limit);
  return {
    sessions,
    summary: summarizeCatalogSessions(allSessions, sessions)
  };
}

function normalizeAttachPayload(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    sessionId: normalizeText(source.sessionId || source.session_id || source.runId || source.run_id || source.sessionRef, 128),
    cursor: normalizeCount(source.cursor),
    limit: normalizeLimit(source.limit, 100)
  };
}

function readNativeRunEvents(query) {
  return readNativeChatRunEvents(query.runId, {
    cursor: query.cursor,
    limit: query.limit
  });
}

function buildRunAttachSnapshot(payload, deps = {}) {
  const getRun = typeof deps.getNativeChatRun === 'function' ? deps.getNativeChatRun : getNativeChatRun;
  const readRunEvents = typeof deps.readNativeSessionRunEvents === 'function'
    ? deps.readNativeSessionRunEvents
    : readNativeRunEvents;
  let result = null;
  try {
    result = readRunEvents({
      runId: payload.sessionId,
      cursor: payload.cursor,
      limit: payload.limit
    });
  } catch (error) {
    if (Number(error && error.statusCode) === 404 || error && error.code === 'native_chat_run_not_found') {
      return null;
    }
    throw error;
  }
  if (!result) return null;
  const run = getRun(payload.sessionId) || {};
  const runId = normalizeText(result.runId || run.runId || payload.sessionId, 128);
  const status = normalizeStatus(result.status || (run.completed ? 'completed' : 'running'));
  return {
    sessionId: runId,
    runId,
    provider: normalizeText(result.provider || run.provider, 64),
    status,
    cursor: normalizeCount(result.cursor),
    snapshot: {
      kind: 'run-events',
      events: Array.isArray(result.events) ? result.events : [],
      requiresSnapshot: false,
      truncated: Boolean(result.truncated)
    },
    allowedCommands: allowedCommandsForStatus(status)
  };
}

function buildSnapshotAttachResult(projectSnapshot, payload, deps = {}) {
  const result = buildControlPlaneDeviceSessionEvents(projectSnapshot, {
    sessionRef: payload.sessionId,
    cursor: payload.cursor,
    limit: payload.limit
  }, deps);
  if (!result) return null;
  const status = normalizeStatus(result.session && result.session.status);
  return {
    sessionId: result.session.sessionRef,
    sessionRef: result.session.sessionRef,
    provider: result.session.provider,
    status,
    cursor: normalizeCount(result.cursor),
    snapshot: {
      kind: 'session-events',
      session: result.session,
      events: Array.isArray(result.events) ? result.events : [],
      requiresSnapshot: Boolean(result.requiresSnapshot),
      truncated: Boolean(result.truncated)
    },
    allowedCommands: allowedCommandsForStatus(status)
  };
}

function attachRemoteDevelopmentSession(projectSnapshot, input = {}, deps = {}) {
  const payload = normalizeAttachPayload(input);
  if (!payload.sessionId) {
    const error = new Error('missing_session_id');
    error.code = 'missing_session_id';
    error.statusCode = 400;
    throw error;
  }
  const runResult = buildRunAttachSnapshot(payload, deps);
  if (runResult) return runResult;
  const snapshotResult = buildSnapshotAttachResult(projectSnapshot, payload, deps);
  if (snapshotResult) return snapshotResult;
  const error = new Error('remote_development_session_not_found');
  error.code = 'remote_development_session_not_found';
  error.statusCode = 404;
  throw error;
}

module.exports = {
  attachRemoteDevelopmentSession,
  buildRemoteDevelopmentSessionCatalog
};
