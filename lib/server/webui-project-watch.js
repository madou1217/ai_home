'use strict';

const fs = require('node:fs');
const { getCodexStopEventsPath } = require('./codex-project-registry');
const { defaultSessionEventBus } = require('./session-event-bus');
const {
  getProjectsSnapshot,
  ensureProjectsSnapshotScheduler,
  closeProjectsSnapshotScheduler
} = require('./webui-project-cache');
const {
  openSseStream,
  writeSseJson,
  broadcastSseJson,
  attachSseWatcher
} = require('./webui-sse-broadcaster');
const { collectPersistentSessionRunKeys } = require('./persistent-session-runtime');

const PROJECTS_WATCH_POLL_MS = 1000;
const PROJECTS_WATCH_HEARTBEAT_MS = 30000;
const PROJECT_RUNTIME_STALE_MS = 10 * 60 * 1000;
const PROJECT_PERSISTENT_RUNTIME_SCAN_MS = 3000;

function setsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function getProjectsWatchState(state) {
  if (!state.__webUiProjectsWatch) {
    state.__webUiProjectsWatch = {
      watchers: new Set(),
      poller: null,
      bootstrapTimer: null,
      sessionEventBus: null,
      sessionEventListener: null,
      knownSessionKeys: new Set(),
      sessionKeysByIdentity: new Map(),
      projectPathByKey: new Map(),
      runningUntilByKey: new Map(),
      persistentRunningKeys: new Set(),
      persistentRuntimeScannedAt: 0,
      lastSentRunningKeys: new Set(),
      lastSentSnapshotRevision: 0,
      stopEventsOffset: 0
    };
  }
  return state.__webUiProjectsWatch;
}

function normalizeProjectPath(projectPath) {
  return String(projectPath || '').trim().replace(/\/+$/, '');
}

function buildRuntimeKey(provider, sessionId, projectDirName) {
  return `${String(provider || '').trim().toLowerCase()}:${String(sessionId || '').trim()}:${String(projectDirName || '').trim()}`;
}

function buildSessionIdentity(provider, sessionId) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedProvider || !normalizedSessionId) return '';
  return `${normalizedProvider}:${normalizedSessionId}`;
}

function addSessionKey(index, key, session, project) {
  const provider = String(session.provider || project.provider || '').trim().toLowerCase();
  const sessionId = String(session.id || '').trim();
  const identity = buildSessionIdentity(provider, sessionId);
  if (!key || !identity) return;
  index.knownSessionKeys.add(key);
  if (!index.sessionKeysByIdentity.has(identity)) {
    index.sessionKeysByIdentity.set(identity, new Set());
  }
  index.sessionKeysByIdentity.get(identity).add(key);
  index.projectPathByKey.set(key, normalizeProjectPath(session.projectPath || project.path));
}

function buildRuntimeIndex(projects) {
  const index = {
    knownSessionKeys: new Set(),
    sessionKeysByIdentity: new Map(),
    projectPathByKey: new Map()
  };
  for (const project of Array.isArray(projects) ? projects : []) {
    for (const session of Array.isArray(project.sessions) ? project.sessions : []) {
      if (!session || !session.id) continue;
      const provider = String(session.provider || project.provider || '').trim().toLowerCase();
      const key = buildRuntimeKey(provider, session.id, session.projectDirName || project.id || '');
      addSessionKey(index, key, { ...session, provider }, project);
    }
  }
  return index;
}

function applyRuntimeIndex(watchState, projects) {
  const index = buildRuntimeIndex(projects);
  watchState.knownSessionKeys = index.knownSessionKeys;
  watchState.sessionKeysByIdentity = index.sessionKeysByIdentity;
  watchState.projectPathByKey = index.projectPathByKey;
  remapRunningKeysToKnownSessions(watchState);
}

function parseRuntimeKey(key) {
  const parts = String(key || '').split(':');
  return {
    provider: String(parts[0] || '').trim().toLowerCase(),
    sessionId: String(parts[1] || '').trim()
  };
}

function remapRunningKeysToKnownSessions(watchState) {
  for (const [key, until] of [...watchState.runningUntilByKey.entries()]) {
    if (watchState.knownSessionKeys.has(key)) continue;
    const { provider, sessionId } = parseRuntimeKey(key);
    const identity = buildSessionIdentity(provider, sessionId);
    const candidates = Array.from(watchState.sessionKeysByIdentity.get(identity) || []);
    if (candidates.length === 0) continue;
    watchState.runningUntilByKey.delete(key);
    candidates.forEach((candidate) => watchState.runningUntilByKey.set(candidate, until));
  }
}

function extractStopEventPayload(entry) {
  if (entry && entry.payload && typeof entry.payload === 'object') return entry.payload;
  return entry && typeof entry === 'object' ? entry : {};
}

function extractCodexStopEventSessionId(entry) {
  const payload = extractStopEventPayload(entry);
  return String(
    payload.session_id
    || payload.sessionId
    || (payload.session && (payload.session.id || payload.session.session_id))
    || ''
  ).trim();
}

function extractCodexStopEventProjectPath(entry) {
  const payload = extractStopEventPayload(entry);
  return normalizeProjectPath(
    payload.cwd
    || payload.project_path
    || payload.projectPath
    || payload.workdir
    || (payload.workspace && payload.workspace.cwd)
    || ''
  );
}

function readCodexStopEvents(watchState) {
  const stopEventsPath = getCodexStopEventsPath();
  if (!stopEventsPath || !fs.existsSync(stopEventsPath)) return [];

  try {
    const stat = fs.statSync(stopEventsPath);
    const size = Number(stat.size) || 0;
    if (size <= 0) {
      watchState.stopEventsOffset = 0;
      return [];
    }
    if (watchState.stopEventsOffset > size) {
      watchState.stopEventsOffset = 0;
    }

    const content = fs.readFileSync(stopEventsPath, 'utf8');
    const slice = content.slice(watchState.stopEventsOffset);
    watchState.stopEventsOffset = content.length;
    return slice
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_error) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function emitProjectsRuntime(watchState, runningKeys) {
  watchState.lastSentRunningKeys = new Set(runningKeys);
  broadcastSseJson(watchState.watchers, {
    type: 'runtime',
    runningSessionKeys: [...runningKeys]
  }, {
    onWatcherRemoved: (watcher) => stopProjectsWatchPoller(watcher.ctx, watchState)
  });
}

function getSessionEventBus(ctx) {
  return ctx && ctx.deps && ctx.deps.sessionEventBus
    ? ctx.deps.sessionEventBus
    : defaultSessionEventBus;
}

function isRuntimeStartEvent(event = {}) {
  const type = String(event.type || '').trim();
  const eventName = String(event.eventName || '').trim();
  return type === 'session:turn-started'
    || eventName === 'PreInvocation';
}

function isRuntimeProgressEvent(event = {}) {
  return String(event.type || '').trim() === 'session:turn-updated';
}

function isRuntimeStopEvent(event = {}) {
  const type = String(event.type || '').trim();
  return type === 'session:turn-completed'
    || type === 'session:turn-failed'
    || type === 'session:closed';
}

function resolveRuntimeKeysForEvent(watchState, event = {}) {
  const provider = String(event.provider || '').trim().toLowerCase();
  const sessionId = String(event.sessionId || event.session_id || '').trim();
  if (!provider || !sessionId) return [];

  const projectDirName = String(event.projectDirName || event.project_dir_name || '').trim();
  const exactKey = buildRuntimeKey(provider, sessionId, projectDirName);
  if (projectDirName && watchState.knownSessionKeys.has(exactKey)) {
    return [exactKey];
  }

  const identity = buildSessionIdentity(provider, sessionId);
  let candidates = Array.from(watchState.sessionKeysByIdentity.get(identity) || []);
  const projectPath = normalizeProjectPath(event.projectPath || event.project_path || event.cwd);
  if (projectPath && candidates.length > 1) {
    const projectMatches = candidates.filter((key) => watchState.projectPathByKey.get(key) === projectPath);
    if (projectMatches.length > 0) {
      candidates = projectMatches;
    }
  }
  if (candidates.length > 0) return candidates;
  return [exactKey];
}

function collectRunningKeys(watchState, now = Date.now()) {
  const nextRunningKeys = new Set();
  for (const [key, until] of watchState.runningUntilByKey.entries()) {
    if (Number(until) > now) {
      nextRunningKeys.add(key);
      continue;
    }
    watchState.runningUntilByKey.delete(key);
  }
  return nextRunningKeys;
}

function collectVisibleRunningKeys(watchState, now = Date.now()) {
  const nextRunningKeys = collectRunningKeys(watchState, now);
  for (const key of watchState.persistentRunningKeys || []) {
    if (key) nextRunningKeys.add(key);
  }
  return nextRunningKeys;
}

function emitRuntimeIfChanged(watchState) {
  const nextRunningKeys = collectVisibleRunningKeys(watchState);
  if (!setsEqual(watchState.lastSentRunningKeys, nextRunningKeys)) {
    emitProjectsRuntime(watchState, nextRunningKeys);
    return true;
  }
  return false;
}

function applyProjectRuntimeEvent(watchState, event = {}) {
  const keys = resolveRuntimeKeysForEvent(watchState, event);
  if (keys.length === 0) return false;
  const now = Date.now();

  if (isRuntimeStopEvent(event)) {
    keys.forEach((key) => watchState.runningUntilByKey.delete(key));
    return emitRuntimeIfChanged(watchState);
  }

  if (isRuntimeStartEvent(event)) {
    keys.forEach((key) => watchState.runningUntilByKey.set(key, now + PROJECT_RUNTIME_STALE_MS));
    return emitRuntimeIfChanged(watchState);
  }

  if (isRuntimeProgressEvent(event)) {
    keys.forEach((key) => {
      if (watchState.runningUntilByKey.has(key)) {
        watchState.runningUntilByKey.set(key, now + PROJECT_RUNTIME_STALE_MS);
      }
    });
    return emitRuntimeIfChanged(watchState);
  }

  return false;
}

function normalizePersistentRuntimeKeys(keys) {
  if (keys instanceof Set) return new Set([...keys].map((key) => String(key || '').trim()).filter(Boolean));
  if (Array.isArray(keys)) return new Set(keys.map((key) => String(key || '').trim()).filter(Boolean));
  return new Set();
}

function collectPersistentRuntimeKeys(ctx, projects) {
  const deps = ctx && ctx.deps || {};
  if (typeof deps.collectPersistentSessionRunKeys === 'function') {
    return normalizePersistentRuntimeKeys(deps.collectPersistentSessionRunKeys(projects, ctx));
  }
  return collectPersistentSessionRunKeys(projects, {
    fs: (ctx && ctx.fs) || deps.fs,
    aiHomeDir: String((ctx && ctx.aiHomeDir) || deps.aiHomeDir || '').trim(),
    hostHomeDir: String((ctx && ctx.hostHomeDir) || deps.hostHomeDir || '').trim(),
    platform: deps.platform || process.platform,
    env: deps.env || process.env,
    spawnSync: deps.spawnSync,
    execFileSync: deps.execFileSync,
    resolveCommandPath: deps.resolveCommandPath,
    listOpenFilesForPid: deps.listOpenFilesForPid,
    readProcessParentRows: deps.readProcessParentRows,
    readCodexActiveSessionRecords: deps.readCodexActiveSessionRecords,
    readCodexThreadRecords: deps.readCodexThreadRecords,
    resolveAgentSessionTitles: deps.resolveAgentSessionTitles
  });
}

function refreshPersistentRuntimeKeys(ctx, watchState, projects, now = Date.now()) {
  if (now - Number(watchState.persistentRuntimeScannedAt || 0) < PROJECT_PERSISTENT_RUNTIME_SCAN_MS) return;
  watchState.persistentRuntimeScannedAt = now;
  try {
    watchState.persistentRunningKeys = collectPersistentRuntimeKeys(ctx, projects);
  } catch (_error) {
    watchState.persistentRunningKeys = new Set();
  }
}

function ensureSessionEventBridge(ctx, watchState) {
  const bus = getSessionEventBus(ctx);
  if (!bus || typeof bus.on !== 'function' || typeof bus.off !== 'function') return;
  if (watchState.sessionEventBus === bus && watchState.sessionEventListener) return;
  clearSessionEventBridge(watchState);
  const listener = (event) => {
    applyProjectRuntimeEvent(watchState, event);
  };
  bus.on('session', listener);
  watchState.sessionEventBus = bus;
  watchState.sessionEventListener = listener;
}

function clearSessionEventBridge(watchState) {
  if (watchState.sessionEventBus && watchState.sessionEventListener && typeof watchState.sessionEventBus.off === 'function') {
    watchState.sessionEventBus.off('session', watchState.sessionEventListener);
  }
  watchState.sessionEventBus = null;
  watchState.sessionEventListener = null;
}

function buildProjectsSnapshotEvent(snapshot) {
  return {
    type: 'snapshot',
    revision: Number(snapshot && snapshot.revision) || 0,
    updatedAt: Number(snapshot && snapshot.updatedAt) || 0,
    projects: Array.isArray(snapshot && snapshot.projects) ? snapshot.projects : []
  };
}

function emitProjectsSnapshot(watchState, snapshot, options = {}) {
  const revision = Number(snapshot && snapshot.revision) || 0;
  if (!options.force && revision === watchState.lastSentSnapshotRevision) return false;
  watchState.lastSentSnapshotRevision = revision;
  broadcastSseJson(watchState.watchers, buildProjectsSnapshotEvent(snapshot), {
    onWatcherRemoved: (watcher) => stopProjectsWatchPoller(watcher.ctx, watchState)
  });
  return true;
}

async function refreshProjectsRuntime(ctx, watchState) {
  const now = Date.now();

  let projects = [];
  try {
    const snapshot = await getProjectsSnapshot(ctx);
    projects = Array.isArray(snapshot.projects) ? snapshot.projects : [];
    emitProjectsSnapshot(watchState, snapshot);
  } catch (_error) {
    projects = [];
  }

  applyRuntimeIndex(watchState, projects);
  refreshPersistentRuntimeKeys(ctx, watchState, projects, now);

  const stopEvents = readCodexStopEvents(watchState);
  for (const event of stopEvents) {
    const sessionId = extractCodexStopEventSessionId(event);
    const projectPath = extractCodexStopEventProjectPath(event);

    if (sessionId) {
      for (const key of [...watchState.runningUntilByKey.keys()]) {
        if (key.startsWith(`codex:${sessionId}:`)) {
          watchState.runningUntilByKey.delete(key);
        }
      }
    }

    if (projectPath) {
      for (const [key, currentProjectPath] of watchState.projectPathByKey.entries()) {
        if (currentProjectPath === projectPath) {
          watchState.runningUntilByKey.delete(key);
        }
      }
    }
  }

  const nextRunningKeys = collectVisibleRunningKeys(watchState, now);
  if (!setsEqual(watchState.lastSentRunningKeys, nextRunningKeys)) {
    emitProjectsRuntime(watchState, nextRunningKeys);
  }
}

function ensureProjectsWatchPoller(ctx, watchState) {
  if (watchState.poller) return;
  ensureSessionEventBridge(ctx, watchState);
  refreshProjectsRuntime(ctx, watchState).catch(() => {});
  watchState.bootstrapTimer = setTimeout(() => {
    watchState.bootstrapTimer = null;
    refreshProjectsRuntime(ctx, watchState).catch(() => {});
  }, 250);
  if (watchState.bootstrapTimer && typeof watchState.bootstrapTimer.unref === 'function') {
    watchState.bootstrapTimer.unref();
  }
  watchState.poller = setInterval(() => {
    refreshProjectsRuntime(ctx, watchState).catch(() => {});
  }, PROJECTS_WATCH_POLL_MS);
  if (typeof watchState.poller.unref === 'function') watchState.poller.unref();
}

function stopProjectsWatchPoller(ctx, watchState) {
  if (!watchState.poller || watchState.watchers.size > 0) return;
  clearInterval(watchState.poller);
  watchState.poller = null;
  clearSessionEventBridge(watchState);
  watchState.runningUntilByKey.clear();
  watchState.persistentRunningKeys = new Set();
  watchState.persistentRuntimeScannedAt = 0;
  watchState.lastSentRunningKeys = new Set();
  if (watchState.bootstrapTimer) {
    clearTimeout(watchState.bootstrapTimer);
    watchState.bootstrapTimer = null;
  }
  closeProjectsSnapshotScheduler(ctx);
}

function handleWebUiProjectsWatchRequest(ctx) {
  const {
    req,
    res,
    state
  } = ctx;

  const watchState = getProjectsWatchState(state);
  ensureProjectsSnapshotScheduler(ctx);

  openSseStream(res);
  writeSseJson(res, { type: 'connected' });

  attachSseWatcher(watchState.watchers, req, res, {
    heartbeatMs: PROJECTS_WATCH_HEARTBEAT_MS,
    context: ctx,
    onWatcherRemoved: (watcher) => {
      stopProjectsWatchPoller(watcher.ctx, watchState);
    }
  });
  ensureProjectsWatchPoller(ctx, watchState);

  getProjectsSnapshot(ctx)
    .then((snapshot) => {
      writeSseJson(res, buildProjectsSnapshotEvent(snapshot));
      watchState.lastSentSnapshotRevision = Number(snapshot && snapshot.revision) || 0;
    })
    .catch(() => {});

  writeSseJson(res, {
    type: 'runtime',
    runningSessionKeys: [...watchState.lastSentRunningKeys]
  });

  return true;
}

async function notifyWebUiProjectWatchers(ctx, options = {}) {
  const watchState = getProjectsWatchState(ctx.state);
  if (watchState.watchers.size === 0) return false;
  const snapshot = await getProjectsSnapshot(ctx, {
    forceRefresh: Boolean(options.forceRefresh),
    waitForRefresh: Boolean(options.waitForRefresh)
  });
  return emitProjectsSnapshot(watchState, snapshot, {
    force: options.force !== false
  });
}

async function handleWebUiProjectsSnapshotRequest(ctx) {
  const broadcasted = await notifyWebUiProjectWatchers(ctx, { force: true });
  ctx.writeJson(ctx.res, 202, {
    ok: true,
    accepted: true,
    broadcasted,
    requestedAt: Date.now()
  });
  return true;
}

module.exports = {
  handleWebUiProjectsWatchRequest,
  handleWebUiProjectsSnapshotRequest,
  notifyWebUiProjectWatchers
};
