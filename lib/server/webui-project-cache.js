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
const HOST_PROJECTS_INDEX_FILE = 'webui-host-projects-index.json';
const HOST_PROJECTS_INDEX_TTL_MS = 15_000;
const HOST_PROJECTS_WATCH_REFRESH_DELAY_MS = 250;

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

function cloneHostProjects(projects) {
  return (Array.isArray(projects) ? projects : []).map((project) => ({
    ...project,
    sessions: Array.isArray(project.sessions)
      ? project.sessions.map((session) => ({ ...session }))
      : []
  }));
}

function sanitizeClaudeProjectPath(projectPath) {
  return String(projectPath || '').trim().replace(/[^a-zA-Z0-9]/g, '-');
}

function projectPathExists(fsImpl, projectPath) {
  const normalizedProjectPath = normalizeProjectPath(projectPath);
  if (!normalizedProjectPath || !fsImpl || typeof fsImpl.existsSync !== 'function') {
    return false;
  }
  try {
    return fsImpl.existsSync(normalizedProjectPath)
      && typeof fsImpl.statSync === 'function'
      && fsImpl.statSync(normalizedProjectPath).isDirectory();
  } catch (_error) {
    return false;
  }
}

function resolveHostProjectPath(project, fsImpl, openedProjectPathByClaudeDirName) {
  const directPath = normalizeProjectPath(project && project.path);
  if (projectPathExists(fsImpl, directPath)) {
    return directPath;
  }

  if (String(project && project.provider || '').trim().toLowerCase() !== 'claude') {
    return '';
  }

  const sessions = Array.isArray(project && project.sessions) ? project.sessions : [];
  const projectDirName = String(
    (sessions.find((session) => session && session.projectDirName) || {}).projectDirName
    || project && project.id
    || ''
  ).trim();
  if (!projectDirName) {
    return '';
  }

  const openedProjectPath = openedProjectPathByClaudeDirName.get(projectDirName);
  if (projectPathExists(fsImpl, openedProjectPath)) {
    return normalizeProjectPath(openedProjectPath);
  }

  return '';
}

function filterHiddenProjects(projects, deps = {}) {
  const { fs, aiHomeDir } = resolveCacheDeps(deps);
  const hiddenPaths = new Set(readHiddenProjectPaths({ fs, aiHomeDir: aiHomeDir || '' }));
  return (Array.isArray(projects) ? projects : []).filter((project) => {
    const normalizedProjectPath = normalizeProjectPath(project && project.path);
    if (!normalizedProjectPath || !projectPathExists(fs, normalizedProjectPath)) {
      return false;
    }
    return !hiddenPaths.has(normalizedProjectPath);
  });
}

function buildProjectsSnapshot(hostProjects, deps = {}) {
  const { fs, aiHomeDir } = resolveCacheDeps(deps);
  const projectMap = new Map();
  const allProjects = Array.isArray(hostProjects) ? hostProjects : [];
  const openedProjects = readOpenedProjects({ fs, aiHomeDir: aiHomeDir || '' });
  const hiddenPaths = new Set(readHiddenProjectPaths({ fs, aiHomeDir: aiHomeDir || '' }));
  const openedProjectPathByClaudeDirName = new Map(
    openedProjects
      .map((opened) => [sanitizeClaudeProjectPath(opened.path), normalizeProjectPath(opened.path)])
      .filter((entry) => entry[0] && entry[1])
  );

  for (const project of allProjects) {
    const resolvedProjectPath = resolveHostProjectPath(project, fs, openedProjectPathByClaudeDirName);
    if (!resolvedProjectPath || hiddenPaths.has(resolvedProjectPath)) continue;
    const key = resolvedProjectPath;
    if (!projectMap.has(key)) {
      projectMap.set(key, {
        id: project.id,
        name: project.name,
        path: resolvedProjectPath,
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
        projectPath: resolvedProjectPath
      });
    }
  }

  for (const opened of openedProjects) {
    const key = normalizeProjectPath(opened.path);
    if (!key || hiddenPaths.has(key) || !projectPathExists(fs, key)) continue;
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

  return sortProjectsByLastActivityDesc(filterHiddenProjects(Array.from(projectMap.values()), { fs, aiHomeDir })
    .map((project) => ({
      ...project,
      sessions: sortProjectSessionsByUpdatedAtDesc(project.sessions)
    })));
}

function getProjectsCacheState(state) {
  return ensureCacheStateBucket(state, '__webUiProjectsCache', createSnapshotCacheState);
}

function getHostProjectsIndexState(state) {
  const cacheState = ensureCacheStateBucket(state, '__webUiHostProjectsIndex', createSnapshotCacheState);
  if (!(cacheState.dirtyProviders instanceof Set)) {
    cacheState.dirtyProviders = new Set();
  }
  if (!cacheState.dirtyProjectHints || typeof cacheState.dirtyProjectHints !== 'object') {
    cacheState.dirtyProjectHints = {
      claudeProjectDirs: new Set(),
      codexProjectPaths: new Set(),
      geminiProjectNames: new Set()
    };
  }
  if (!(cacheState.dirtyProjectHints.claudeProjectDirs instanceof Set)) {
    cacheState.dirtyProjectHints.claudeProjectDirs = new Set();
  }
  if (!(cacheState.dirtyProjectHints.codexProjectPaths instanceof Set)) {
    cacheState.dirtyProjectHints.codexProjectPaths = new Set();
  }
  if (!(cacheState.dirtyProjectHints.geminiProjectNames instanceof Set)) {
    cacheState.dirtyProjectHints.geminiProjectNames = new Set();
  }
  return cacheState;
}

function createHostProjectsWatchState() {
  return {
    hostHome: '',
    handlesByPath: new Map()
  };
}

function getHostProjectsWatchState(state) {
  return ensureCacheStateBucket(state, '__webUiHostProjectsWatch', createHostProjectsWatchState);
}

function cloneDirtyProjectHints(projectHints) {
  return {
    claudeProjectDirs: Array.from(projectHints && projectHints.claudeProjectDirs || []),
    codexProjectPaths: Array.from(projectHints && projectHints.codexProjectPaths || []),
    geminiProjectNames: Array.from(projectHints && projectHints.geminiProjectNames || [])
  };
}

function clearDirtyProjectHints(cacheState) {
  cacheState.dirtyProjectHints.claudeProjectDirs.clear();
  cacheState.dirtyProjectHints.codexProjectPaths.clear();
  cacheState.dirtyProjectHints.geminiProjectNames.clear();
}

function hasDirtyProjectHints(projectHints) {
  return Boolean(
    (projectHints && projectHints.claudeProjectDirs && projectHints.claudeProjectDirs.length > 0)
    || (projectHints && projectHints.codexProjectPaths && projectHints.codexProjectPaths.length > 0)
    || (projectHints && projectHints.geminiProjectNames && projectHints.geminiProjectNames.length > 0)
  );
}

function getHintedProviders(projectHints) {
  const providers = [];
  if (projectHints && projectHints.claudeProjectDirs && projectHints.claudeProjectDirs.length > 0) {
    providers.push('claude');
  }
  if (projectHints && projectHints.codexProjectPaths && projectHints.codexProjectPaths.length > 0) {
    providers.push('codex');
  }
  if (projectHints && projectHints.geminiProjectNames && projectHints.geminiProjectNames.length > 0) {
    providers.push('gemini');
  }
  return providers;
}

function filterProjectHintsByProviders(projectHints, providers) {
  const providerSet = new Set(Array.isArray(providers) ? providers : []);
  return {
    claudeProjectDirs: providerSet.has('claude')
      ? [...(projectHints && projectHints.claudeProjectDirs || [])]
      : [],
    codexProjectPaths: providerSet.has('codex')
      ? [...(projectHints && projectHints.codexProjectPaths || [])]
      : [],
    geminiProjectNames: providerSet.has('gemini')
      ? [...(projectHints && projectHints.geminiProjectNames || [])]
      : []
  };
}

function getHostProjectIdentity(project) {
  const provider = String(project && project.provider || '').trim().toLowerCase();
  if (provider === 'claude') {
    return `claude:${String(project && project.id || '').trim()}`;
  }
  if (provider === 'gemini') {
    return `gemini:${String(project && project.id || '').trim()}`;
  }
  if (provider === 'codex') {
    return `codex:${normalizeProjectPath(project && project.path)}`;
  }
  return `${provider}:${normalizeProjectPath(project && project.path) || String(project && project.id || '').trim()}`;
}

function buildReplacementIdentitiesFromProjectHints(projectHints) {
  const identities = new Set();
  for (const projectDirName of projectHints && projectHints.claudeProjectDirs || []) {
    identities.add(`claude:${String(projectDirName || '').trim()}`);
  }
  for (const projectPath of projectHints && projectHints.codexProjectPaths || []) {
    identities.add(`codex:${normalizeProjectPath(projectPath)}`);
  }
  for (const projectName of projectHints && projectHints.geminiProjectNames || []) {
    identities.add(`gemini:gemini-${String(projectName || '').trim()}`);
  }
  return identities;
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

function readHostProjectsIndexFromDisk(deps = {}) {
  const parsed = readCacheJson(deps, HOST_PROJECTS_INDEX_FILE);
  if (!parsed) return null;
  return {
    revision: Number(parsed && parsed.revision) || 0,
    updatedAt: Number(parsed && parsed.updatedAt) || 0,
    snapshot: cloneHostProjects(parsed && parsed.projects)
  };
}

function writeHostProjectsIndexToDisk(cacheState, deps = {}) {
  writeCacheJson(deps, HOST_PROJECTS_INDEX_FILE, {
    revision: Number(cacheState.revision) || 0,
    updatedAt: Number(cacheState.updatedAt) || 0,
    projects: cacheState.snapshot
  });
}

function ensureProjectsSnapshotLoaded(ctx) {
  const cacheState = getProjectsCacheState(ctx.state);
  return ensureSnapshotLoaded(cacheState, () => readProjectsSnapshotFromDisk(ctx));
}

function ensureHostProjectsIndexLoaded(ctx) {
  const cacheState = getHostProjectsIndexState(ctx.state);
  return ensureSnapshotLoaded(cacheState, () => readHostProjectsIndexFromDisk(ctx));
}

function closeWatchHandle(handle) {
  if (!handle || typeof handle.close !== 'function') return;
  try {
    handle.close();
  } catch (_error) {}
}

function resetHostProjectsWatchState(watchState) {
  for (const handle of watchState.handlesByPath.values()) {
    closeWatchHandle(handle);
  }
  watchState.handlesByPath.clear();
}

function addWatchTarget(targets, targetPath) {
  const normalized = String(targetPath || '').trim();
  if (!normalized) return;
  targets.add(normalized);
}

function collectDirectoryWatchTargets(fs, rootPath, maxDepth, targets, currentDepth = 0) {
  if (!rootPath || !fs || !fs.existsSync(rootPath)) return;
  addWatchTarget(targets, rootPath);
  if (currentDepth >= maxDepth) return;

  let entries = [];
  try {
    entries = fs.readdirSync(rootPath, { withFileTypes: true });
  } catch (_error) {
    return;
  }

  for (const entry of entries) {
    if (!entry || !entry.isDirectory()) continue;
    collectDirectoryWatchTargets(
      fs,
      path.join(rootPath, entry.name),
      maxDepth,
      targets,
      currentDepth + 1
    );
  }
}

function collectHostProjectsWatchTargets(ctx) {
  const { fs } = resolveCacheDeps(ctx);
  const { getRealHome } = require('../sessions/session-reader');
  const hostHome = getRealHome();
  const targets = new Set();

  if (!hostHome || !fs || !fs.existsSync(hostHome)) {
    return { hostHome, targets };
  }

  addWatchTarget(targets, hostHome);

  const codexDir = path.join(hostHome, '.codex');
  const claudeDir = path.join(hostHome, '.claude');
  const geminiDir = path.join(hostHome, '.gemini');
  const codexSessionsDir = path.join(codexDir, 'sessions');
  const claudeProjectsDir = path.join(claudeDir, 'projects');
  const geminiHistoryDir = path.join(geminiDir, 'history');
  const geminiTmpDir = path.join(geminiDir, 'tmp');

  [
    codexDir,
    claudeDir,
    geminiDir,
    path.join(codexDir, 'config.toml'),
    path.join(codexDir, '.codex-global-state.json'),
    path.join(codexDir, 'session_index.jsonl'),
    path.join(geminiDir, 'trustedFolders.json'),
    path.join(geminiDir, 'projects.json')
  ].forEach((targetPath) => {
    if (fs.existsSync(targetPath)) addWatchTarget(targets, targetPath);
  });

  collectDirectoryWatchTargets(fs, codexSessionsDir, 3, targets);
  collectDirectoryWatchTargets(fs, claudeProjectsDir, 1, targets);
  collectDirectoryWatchTargets(fs, geminiHistoryDir, 2, targets);
  collectDirectoryWatchTargets(fs, geminiTmpDir, 3, targets);

  return { hostHome, targets };
}

function mergeHostProjectsByIdentity(currentProjects, nextProjects, identities) {
  const replacementIdentities = identities instanceof Set
    ? identities
    : new Set(Array.isArray(identities) ? identities : []);
  const merged = (Array.isArray(currentProjects) ? currentProjects : [])
    .filter((project) => !replacementIdentities.has(getHostProjectIdentity(project)));
  return merged.concat(Array.isArray(nextProjects) ? nextProjects : []);
}

function resolveChangedWatchPath(targetPath, fileName) {
  const normalizedTargetPath = String(targetPath || '').trim();
  const normalizedFileName = Buffer.isBuffer(fileName)
    ? fileName.toString('utf8').trim()
    : String(fileName || '').trim();

  if (!normalizedTargetPath || !normalizedFileName) {
    return normalizedTargetPath;
  }
  if (path.basename(normalizedTargetPath) === normalizedFileName) {
    return normalizedTargetPath;
  }
  return path.join(normalizedTargetPath, normalizedFileName);
}

function inferProvidersFromWatchPath(hostHome, targetPath) {
  const normalizedHostHome = String(hostHome || '').trim();
  const normalizedTargetPath = String(targetPath || '').trim();
  if (!normalizedHostHome || !normalizedTargetPath) {
    return ['claude', 'codex', 'gemini'];
  }

  const relativePath = path.relative(normalizedHostHome, normalizedTargetPath);
  if (!relativePath || relativePath === '') {
    return ['claude', 'codex', 'gemini'];
  }

  if (relativePath === '.codex' || relativePath.startsWith(`.codex${path.sep}`)) {
    return ['codex'];
  }
  if (relativePath === '.claude' || relativePath.startsWith(`.claude${path.sep}`)) {
    return ['claude'];
  }
  if (relativePath === '.gemini' || relativePath.startsWith(`.gemini${path.sep}`)) {
    return ['gemini'];
  }
  return ['claude', 'codex', 'gemini'];
}

function inferProjectHintFromWatchPath(ctx, targetPath) {
  const watchState = getHostProjectsWatchState(ctx.state);
  const hostHome = String(watchState.hostHome || '').trim();
  const normalizedTargetPath = String(targetPath || '').trim();
  if (!hostHome || !normalizedTargetPath) {
    return null;
  }

  const relativePath = path.relative(hostHome, normalizedTargetPath);
  if (!relativePath || relativePath.startsWith('..')) {
    return null;
  }

  const parts = relativePath.split(path.sep).filter(Boolean);
  if (parts[0] === '.claude' && parts[1] === 'projects' && parts[2]) {
    return {
      provider: 'claude',
      key: parts[2]
    };
  }
  if (parts[0] === '.gemini' && (parts[1] === 'tmp' || parts[1] === 'history') && parts[2]) {
    return {
      provider: 'gemini',
      key: parts[2]
    };
  }
  if (parts[0] === '.codex' && parts[1] === 'sessions' && normalizedTargetPath.endsWith('.jsonl')) {
    const { readCodexSessionProjectPath } = require('../sessions/session-reader');
    const projectPath = readCodexSessionProjectPath(normalizedTargetPath);
    if (!projectPath) return null;
    return {
      provider: 'codex',
      key: projectPath
    };
  }
  return null;
}

function addDirtyProjectHint(cacheState, hint) {
  if (!hint || !hint.provider || !hint.key) return;
  if (hint.provider === 'claude') {
    cacheState.dirtyProjectHints.claudeProjectDirs.add(String(hint.key).trim());
    return;
  }
  if (hint.provider === 'codex') {
    cacheState.dirtyProjectHints.codexProjectPaths.add(normalizeProjectPath(hint.key));
    return;
  }
  if (hint.provider === 'gemini') {
    cacheState.dirtyProjectHints.geminiProjectNames.add(String(hint.key).trim());
  }
}

function markHostProjectsChangedByPath(ctx, targetPath) {
  const hostIndexState = ensureHostProjectsIndexLoaded(ctx);
  const projectHint = inferProjectHintFromWatchPath(ctx, targetPath);
  if (projectHint) {
    addDirtyProjectHint(hostIndexState, projectHint);
  } else {
    const watchState = getHostProjectsWatchState(ctx.state);
    for (const provider of inferProvidersFromWatchPath(watchState.hostHome, targetPath)) {
      hostIndexState.dirtyProviders.add(provider);
    }
  }
  hostIndexState.dirty = true;
  scheduleProjectsSnapshotRefresh(ctx, {
    delayMs: HOST_PROJECTS_WATCH_REFRESH_DELAY_MS
  });
}

function syncHostProjectsWatchers(ctx) {
  const { fs } = resolveCacheDeps(ctx);
  if (!fs || typeof fs.watch !== 'function') return;

  const watchState = getHostProjectsWatchState(ctx.state);
  const { hostHome, targets } = collectHostProjectsWatchTargets(ctx);

  if (watchState.hostHome && watchState.hostHome !== hostHome) {
    resetHostProjectsWatchState(watchState);
  }
  watchState.hostHome = hostHome;

  for (const watchedPath of [...watchState.handlesByPath.keys()]) {
    if (targets.has(watchedPath)) continue;
    closeWatchHandle(watchState.handlesByPath.get(watchedPath));
    watchState.handlesByPath.delete(watchedPath);
  }

  for (const targetPath of targets) {
    if (watchState.handlesByPath.has(targetPath)) continue;
    try {
      const handle = fs.watch(targetPath, (_eventType, fileName) => {
        markHostProjectsChangedByPath(ctx, resolveChangedWatchPath(targetPath, fileName));
      });
      if (handle && typeof handle.unref === 'function') {
        handle.unref();
      }
      if (handle && typeof handle.on === 'function') {
        handle.on('error', () => {
          closeWatchHandle(handle);
          watchState.handlesByPath.delete(targetPath);
        });
      }
      watchState.handlesByPath.set(targetPath, handle);
    } catch (_error) {
      // Ignore unsupported targets and keep TTL refresh as fallback.
    }
  }
}

function mergeHostProjectsByProvider(currentProjects, nextProjects, providers) {
  const providerSet = new Set(Array.isArray(providers) ? providers : []);
  const merged = (Array.isArray(currentProjects) ? currentProjects : [])
    .filter((project) => !providerSet.has(String(project && project.provider || '').trim().toLowerCase()));
  return merged.concat(Array.isArray(nextProjects) ? nextProjects : []);
}

async function refreshHostProjectsIndex(ctx, options = {}) {
  const cacheState = ensureHostProjectsIndexLoaded(ctx);
  return runSingleFlightRefresh(cacheState, async () => {
    const { readAllProjectsFromHost, readProjectsFromHostByProviders } = require('../sessions/session-reader');
    const dirtyProviders = Array.from(cacheState.dirtyProviders || []);
    const dirtyProjectHints = cloneDirtyProjectHints(cacheState.dirtyProjectHints);
    const canUseIncrementalRefresh = !options.forceRefresh
      && !cacheState.forceFullRefresh
      && Array.isArray(cacheState.snapshot)
      && cacheState.snapshot.length > 0;
    let hostProjects = null;

    if (canUseIncrementalRefresh && dirtyProviders.length > 0 && dirtyProviders.length < 3) {
      hostProjects = mergeHostProjectsByProvider(
        cacheState.snapshot,
        readProjectsFromHostByProviders(dirtyProviders),
        dirtyProviders
      );
    }

    const hintedProviders = getHintedProviders(dirtyProjectHints)
      .filter((provider) => !dirtyProviders.includes(provider));
    if (canUseIncrementalRefresh && hintedProviders.length > 0) {
      const filteredProjectHints = filterProjectHintsByProviders(dirtyProjectHints, hintedProviders);
      const nextProjects = readProjectsFromHostByProviders(hintedProviders, {
        projectHints: filteredProjectHints
      });
      hostProjects = mergeHostProjectsByIdentity(
        hostProjects || cacheState.snapshot,
        nextProjects,
        buildReplacementIdentitiesFromProjectHints(filteredProjectHints)
      );
    }

    if (!hostProjects) {
      hostProjects = readAllProjectsFromHost();
    }

    cacheState.dirtyProviders.clear();
    clearDirtyProjectHints(cacheState);
    cacheState.forceFullRefresh = false;
    commitSnapshot(cacheState, cloneHostProjects(hostProjects), (nextState) => {
      writeHostProjectsIndexToDisk(nextState, ctx);
    });
    syncHostProjectsWatchers(ctx);
    return cacheState;
  });
}

function shouldRefreshHostProjectsIndex(cacheState, options = {}) {
  if (options.forceRefresh) return true;
  if (!cacheState.updatedAt) return true;
  if (cacheState.dirty) return true;
  return (Date.now() - Number(cacheState.lastRefreshAt || 0)) >= HOST_PROJECTS_INDEX_TTL_MS;
}

async function getHostProjectsIndex(ctx, options = {}) {
  const cacheState = ensureHostProjectsIndexLoaded(ctx);
  await getSnapshotWithRefresh(cacheState, options, {
    shouldRefresh: shouldRefreshHostProjectsIndex,
    refresh: () => refreshHostProjectsIndex(ctx, { forceRefresh: Boolean(options.forceRefresh) })
  });

  return {
    revision: Number(cacheState.revision) || 0,
    updatedAt: Number(cacheState.updatedAt) || 0,
    projects: cloneHostProjects(cacheState.snapshot)
  };
}

async function refreshProjectsSnapshot(ctx, options = {}) {
  const cacheState = ensureProjectsSnapshotLoaded(ctx);
  return runSingleFlightRefresh(cacheState, async () => {
    const hostProjects = await getHostProjectsIndex(ctx, {
      forceRefresh: Boolean(options.forceRefresh),
      waitForRefresh: true
    });
    const nextSnapshot = buildProjectsSnapshot(hostProjects.projects, ctx);
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
    refresh: () => refreshProjectsSnapshot(ctx, { forceRefresh: Boolean(options.forceRefresh) })
  });
  const filteredSnapshot = filterHiddenProjects(cacheState.snapshot, ctx);
  if (filteredSnapshot.length !== cacheState.snapshot.length) {
    setProjectsSnapshot(ctx, filteredSnapshot);
  }

  return {
    revision: Number(cacheState.revision) || 0,
    updatedAt: Number(cacheState.updatedAt) || 0,
    projects: cloneSnapshotProjects(filteredSnapshot)
  };
}

function scheduleProjectsSnapshotRefresh(ctx, options = {}) {
  const cacheState = ensureProjectsSnapshotLoaded(ctx);
  scheduleDirtyRefresh(cacheState, () => (
    refreshProjectsSnapshot(ctx, { forceRefresh: Boolean(options.immediate) })
  ), options);
}

function setProjectsSnapshot(ctx, nextProjects) {
  const cacheState = ensureProjectsSnapshotLoaded(ctx);
  const filteredProjects = filterHiddenProjects(nextProjects, ctx);
  commitSnapshot(cacheState, cloneSnapshotProjects(filteredProjects), (nextState) => {
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
  ensureHostProjectsIndexLoaded(ctx);
  syncHostProjectsWatchers(ctx);
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
  getHostProjectsIndex,
  refreshHostProjectsIndex,
  refreshProjectsSnapshot,
  scheduleProjectsSnapshotRefresh,
  updateProjectsSnapshot,
  ensureProjectsSnapshotScheduler
};
