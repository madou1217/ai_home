'use strict';

const path = require('node:path');
const { readOpenedProjects, readHiddenProjectPaths } = require('./webui-project-store');
const {
  resolveCacheDeps,
  ensureCacheStateBucket,
  readCacheJson,
  writeCacheJson
} = require('./webui-cache-store');
const {
  createSnapshotCacheState,
  ensureSnapshotLoaded,
  commitSnapshot
} = require('./webui-snapshot-state');
const {
  runSingleFlightRefresh,
  getSnapshotWithRefresh,
  scheduleDirtyRefresh,
  ensurePeriodicRefresh
} = require('./webui-cache-scheduler');

const PROJECTS_SNAPSHOT_TTL_MS = 30_000;
const PROJECTS_REFRESH_INTERVAL_MS = 15_000;
const PROJECTS_SNAPSHOT_FILE = 'webui-projects-snapshot.json';

function normalizeProjectPath(projectPath) {
  return String(projectPath || '').trim().replace(/\/+$/, '');
}

function getProjectLastActivityAt(project) {
  if (!project || !Array.isArray(project.sessions) || project.sessions.length === 0) {
    return Number(project && project.addedAt) || 0;
  }
  return Math.max(
    ...project.sessions.map((session) => Number(session && session.updatedAt) || 0),
    Number(project.addedAt) || 0
  );
}

function sortProjectSessionsByUpdatedAtDesc(sessions) {
  return [...(Array.isArray(sessions) ? sessions : [])].sort((left, right) => {
    const rightUpdatedAt = Number(right && right.updatedAt) || 0;
    const leftUpdatedAt = Number(left && left.updatedAt) || 0;
    return rightUpdatedAt - leftUpdatedAt;
  });
}

function sortProjectsByLastActivityDesc(projects) {
  return [...(Array.isArray(projects) ? projects : [])].sort((left, right) => {
    const rightUpdatedAt = getProjectLastActivityAt(right);
    const leftUpdatedAt = getProjectLastActivityAt(left);
    return rightUpdatedAt - leftUpdatedAt;
  });
}

function cloneSnapshotProjects(projects) {
  return (Array.isArray(projects) ? projects : []).map((project) => ({
    ...project,
    providers: Array.isArray(project.providers) ? project.providers.slice() : [],
    sessions: Array.isArray(project.sessions)
      ? project.sessions.map((session) => ({ ...session }))
      : []
  }));
}

function buildProjectsSnapshot(hostProjects, deps = {}) {
  const { fs, aiHomeDir } = resolveCacheDeps(deps);
  const projectMap = new Map();
  const allProjects = Array.isArray(hostProjects) ? hostProjects : [];

  for (const project of allProjects) {
    const key = normalizeProjectPath(project && project.path);
    if (!key) continue;
    if (!projectMap.has(key)) {
      projectMap.set(key, {
        id: project.id,
        name: project.name,
        path: project.path,
        providers: [project.provider],
        sessions: []
      });
    } else {
      const existing = projectMap.get(key);
      if (!existing.providers.includes(project.provider)) {
        existing.providers.push(project.provider);
      }
    }

    const projectData = projectMap.get(key);
    const sessions = Array.isArray(project && project.sessions) ? project.sessions : [];
    for (const session of sessions) {
      projectData.sessions.push({
        ...session,
        provider: project.provider,
        projectDirName: session.projectDirName || project.id,
        projectPath: project.path
      });
    }
  }

  const openedProjects = readOpenedProjects({ fs, aiHomeDir: aiHomeDir || '' });
  const hiddenPaths = new Set(readHiddenProjectPaths({ fs, aiHomeDir: aiHomeDir || '' }));

  for (const opened of openedProjects) {
    const key = normalizeProjectPath(opened.path);
    if (!key || hiddenPaths.has(key)) continue;
    if (projectMap.has(key)) {
      const existing = projectMap.get(key);
      if (!existing.name || existing.name === path.basename(existing.path || '')) {
        existing.name = opened.name || existing.name;
      }
      existing.manual = true;
      existing.addedAt = Number(opened.addedAt) || existing.addedAt || 0;
      continue;
    }
    projectMap.set(key, {
      id: Buffer.from(opened.path).toString('base64').replace(/[/+=]/g, '_'),
      name: opened.name || path.basename(opened.path),
      path: opened.path,
      providers: [],
      sessions: [],
      manual: true,
      addedAt: Number(opened.addedAt) || 0
    });
  }

  return sortProjectsByLastActivityDesc(Array.from(projectMap.values())
    .filter((project) => {
      const normalizedProjectPath = normalizeProjectPath(project.path);
      if (!hiddenPaths.has(normalizedProjectPath)) return true;
      return Array.isArray(project.sessions) && project.sessions.length > 0;
    })
    .map((project) => ({
      ...project,
      sessions: sortProjectSessionsByUpdatedAtDesc(project.sessions)
    })));
}

function getProjectsCacheState(state) {
  return ensureCacheStateBucket(state, '__webUiProjectsCache', createSnapshotCacheState);
}

function readProjectsSnapshotFromDisk(deps = {}) {
  const parsed = readCacheJson(deps, PROJECTS_SNAPSHOT_FILE);
  if (!parsed) return null;
  return {
    revision: Number(parsed && parsed.revision) || 0,
    updatedAt: Number(parsed && parsed.updatedAt) || 0,
    snapshot: cloneSnapshotProjects(parsed && parsed.projects)
  };
}

function writeProjectsSnapshotToDisk(cacheState, deps = {}) {
  writeCacheJson(deps, PROJECTS_SNAPSHOT_FILE, {
    revision: Number(cacheState.revision) || 0,
    updatedAt: Number(cacheState.updatedAt) || 0,
    projects: cacheState.snapshot
  });
}

function ensureProjectsSnapshotLoaded(ctx) {
  const cacheState = getProjectsCacheState(ctx.state);
  return ensureSnapshotLoaded(cacheState, () => readProjectsSnapshotFromDisk(ctx));
}

async function refreshProjectsSnapshot(ctx, options = {}) {
  const cacheState = ensureProjectsSnapshotLoaded(ctx);
  return runSingleFlightRefresh(cacheState, async () => {
    const { readAllProjectsFromHost } = require('../sessions/session-reader');
    const hostProjects = readAllProjectsFromHost();
    const nextSnapshot = buildProjectsSnapshot(hostProjects, ctx);
    commitSnapshot(cacheState, cloneSnapshotProjects(nextSnapshot), (nextState) => {
      writeProjectsSnapshotToDisk(nextState, ctx);
    });
    return cacheState;
  });
}

function shouldRefreshProjectsSnapshot(cacheState, options = {}) {
  if (options.forceRefresh) return true;
  if (!cacheState.updatedAt) return true;
  if (cacheState.dirty) return true;
  return (Date.now() - Number(cacheState.lastRefreshAt || 0)) >= PROJECTS_SNAPSHOT_TTL_MS;
}

async function getProjectsSnapshot(ctx, options = {}) {
  const cacheState = ensureProjectsSnapshotLoaded(ctx);
  await getSnapshotWithRefresh(cacheState, options, {
    shouldRefresh: shouldRefreshProjectsSnapshot,
    refresh: () => refreshProjectsSnapshot(ctx, { force: Boolean(options.forceRefresh) })
  });

  return {
    revision: Number(cacheState.revision) || 0,
    updatedAt: Number(cacheState.updatedAt) || 0,
    projects: cloneSnapshotProjects(cacheState.snapshot)
  };
}

function scheduleProjectsSnapshotRefresh(ctx, options = {}) {
  const cacheState = ensureProjectsSnapshotLoaded(ctx);
  scheduleDirtyRefresh(cacheState, () => (
    refreshProjectsSnapshot(ctx, { force: Boolean(options.immediate) })
  ), options);
}

function setProjectsSnapshot(ctx, nextProjects) {
  const cacheState = ensureProjectsSnapshotLoaded(ctx);
  commitSnapshot(cacheState, cloneSnapshotProjects(nextProjects), (nextState) => {
    writeProjectsSnapshotToDisk(nextState, ctx);
  });
  return {
    revision: cacheState.revision,
    updatedAt: cacheState.updatedAt,
    projects: cloneSnapshotProjects(cacheState.snapshot)
  };
}

function updateProjectsSnapshot(ctx, updater) {
  const cacheState = ensureProjectsSnapshotLoaded(ctx);
  const currentProjects = cloneSnapshotProjects(cacheState.snapshot);
  const nextProjects = typeof updater === 'function' ? updater(currentProjects) : currentProjects;
  return setProjectsSnapshot(ctx, nextProjects);
}

function ensureProjectsSnapshotScheduler(ctx) {
  const cacheState = ensureProjectsSnapshotLoaded(ctx);
  ensurePeriodicRefresh(cacheState, {
    shouldRefresh: shouldRefreshProjectsSnapshot,
    refresh: () => refreshProjectsSnapshot(ctx),
    intervalMs: PROJECTS_REFRESH_INTERVAL_MS,
    warmupMs: 1000
  });
}

module.exports = {
  buildProjectsSnapshot,
  getProjectsSnapshot,
  refreshProjectsSnapshot,
  scheduleProjectsSnapshotRefresh,
  updateProjectsSnapshot,
  ensureProjectsSnapshotScheduler
};
