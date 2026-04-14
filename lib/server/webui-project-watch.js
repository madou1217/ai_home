'use strict';

const fs = require('node:fs');
const sessionReader = require('../sessions/session-reader');
const { getCodexStopEventsPath } = require('./codex-project-registry');
const {
  getProjectsSnapshot,
  ensureProjectsSnapshotScheduler
} = require('./webui-project-cache');
const {
  openSseStream,
  writeSseJson,
  broadcastSseJson,
  attachSseWatcher
} = require('./webui-sse-broadcaster');

const PROJECTS_WATCH_POLL_MS = 1000;
const PROJECTS_WATCH_HEARTBEAT_MS = 30000;
const PROJECT_RUNTIME_TTL_MS = 15000;
const RECENT_SESSION_BOOTSTRAP_MS = 15000;

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
      cursorByKey: new Map(),
      runningUntilByKey: new Map(),
      lastSentRunningKeys: new Set(),
      stopEventsOffset: 0
    };
  }
  return state.__webUiProjectsWatch;
}

function normalizeProjectPath(projectPath) {
  return String(projectPath || '').trim().replace(/\/+$/, '');
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
    onWatcherRemoved: () => stopProjectsWatchPoller(watchState)
  });
}

async function refreshProjectsRuntime(ctx, watchState) {
  const now = Date.now();
  const nextKnownKeys = new Set();
  const projectPathByKey = new Map();

  let projects = [];
  try {
    const snapshot = await getProjectsSnapshot(ctx);
    projects = Array.isArray(snapshot.projects) ? snapshot.projects : [];
  } catch (_error) {
    projects = [];
  }

  for (const project of Array.isArray(projects) ? projects : []) {
    const projectSessions = Array.isArray(project.sessions) ? project.sessions : [];
    for (const session of projectSessions) {
      if (!session || !session.id) continue;
      const key = `${session.provider || project.provider}:${session.id}:${session.projectDirName || project.id || ''}`;
      nextKnownKeys.add(key);
      projectPathByKey.set(key, normalizeProjectPath(session.projectPath || project.path));

      let nextCursor = 0;
      try {
        nextCursor = Number(sessionReader.getSessionFileCursor(session.provider || project.provider, {
          sessionId: session.id,
          projectDirName: session.projectDirName || project.id || ''
        })) || 0;
      } catch (_error) {
        nextCursor = 0;
      }

      if (watchState.cursorByKey.has(key)) {
        const previousCursor = Number(watchState.cursorByKey.get(key)) || 0;
        if (nextCursor > previousCursor) {
          watchState.runningUntilByKey.set(key, now + PROJECT_RUNTIME_TTL_MS);
        }
      } else {
        const sessionUpdatedAt = Number(session.updatedAt) || 0;
        if (sessionUpdatedAt > 0 && (now - sessionUpdatedAt) <= RECENT_SESSION_BOOTSTRAP_MS) {
          watchState.runningUntilByKey.set(key, now + PROJECT_RUNTIME_TTL_MS);
        }
      }
      watchState.cursorByKey.set(key, nextCursor);
    }
  }

  for (const key of [...watchState.cursorByKey.keys()]) {
    if (nextKnownKeys.has(key)) continue;
    watchState.cursorByKey.delete(key);
    watchState.runningUntilByKey.delete(key);
  }

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
      for (const [key, currentProjectPath] of projectPathByKey.entries()) {
        if (currentProjectPath === projectPath) {
          watchState.runningUntilByKey.delete(key);
        }
      }
    }
  }

  const nextRunningKeys = new Set();
  for (const [key, until] of watchState.runningUntilByKey.entries()) {
    if (Number(until) > now) {
      nextRunningKeys.add(key);
      continue;
    }
    watchState.runningUntilByKey.delete(key);
  }

  if (!setsEqual(watchState.lastSentRunningKeys, nextRunningKeys)) {
    emitProjectsRuntime(watchState, nextRunningKeys);
  }
}

function ensureProjectsWatchPoller(ctx, watchState) {
  if (watchState.poller) return;
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

function stopProjectsWatchPoller(watchState) {
  if (!watchState.poller || watchState.watchers.size > 0) return;
  clearInterval(watchState.poller);
  watchState.poller = null;
  if (watchState.bootstrapTimer) {
    clearTimeout(watchState.bootstrapTimer);
    watchState.bootstrapTimer = null;
  }
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
    onWatcherRemoved: () => {
      stopProjectsWatchPoller(watchState);
    }
  });
  ensureProjectsWatchPoller(ctx, watchState);

  writeSseJson(res, {
    type: 'runtime',
    runningSessionKeys: [...watchState.lastSentRunningKeys]
  });

  return true;
}

module.exports = {
  handleWebUiProjectsWatchRequest
};
