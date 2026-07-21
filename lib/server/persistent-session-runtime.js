'use strict';

const { spawnSync: defaultSpawnSync } = require('node:child_process');
const persistentSession = require('../runtime/persistent-session');
const { listAccountRefRecords } = require('./account-ref-store');
const { resolveAgentSessionTitles: defaultResolveAgentSessionTitles } = require('../cli/services/ai-cli/session-title-resolver');

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeProvider(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeProjectPath(value) {
  return normalizeText(value).replace(/\/+$/, '');
}

function buildRuntimeKey(provider, sessionId, projectDirName) {
  return `${normalizeProvider(provider)}:${normalizeText(sessionId)}:${normalizeText(projectDirName)}`;
}

function buildSessionIdentity(provider, sessionId) {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedSessionId = normalizeText(sessionId);
  if (!normalizedProvider || !normalizedSessionId) return '';
  return `${normalizedProvider}:${normalizedSessionId}`;
}

function indexProjectSessions(projects) {
  const byIdentity = new Map();
  for (const project of Array.isArray(projects) ? projects : []) {
    const projectPath = normalizeProjectPath(project && project.path);
    const fallbackProvider = normalizeProvider(project && project.provider);
    const fallbackProjectDirName = normalizeText(project && project.id);
    for (const session of Array.isArray(project && project.sessions) ? project.sessions : []) {
      const provider = normalizeProvider(session && (session.provider || fallbackProvider));
      const sessionId = normalizeText(session && session.id);
      if (!provider || !sessionId) continue;
      const projectDirName = normalizeText(session && session.projectDirName) || fallbackProjectDirName;
      const entry = {
        provider,
        sessionId,
        projectPath: normalizeProjectPath(session && session.projectPath) || projectPath,
        key: buildRuntimeKey(provider, sessionId, projectDirName)
      };
      const identity = buildSessionIdentity(provider, sessionId);
      if (!byIdentity.has(identity)) byIdentity.set(identity, []);
      byIdentity.get(identity).push(entry);
    }
  }
  return byIdentity;
}

function listProviderAccountScopes(fsImpl, aiHomeDir, provider) {
  const root = normalizeText(aiHomeDir);
  const normalizedProvider = normalizeProvider(provider);
  if (!root || !normalizedProvider) return [];
  return listAccountRefRecords(fsImpl, root, normalizedProvider, { bestEffort: true })
    .map((record) => normalizeText(record && record.accountRef))
    .filter(Boolean);
}

function collectProjectProviders(projects) {
  const providers = new Set();
  for (const project of Array.isArray(projects) ? projects : []) {
    for (const provider of Array.isArray(project && project.providers) ? project.providers : []) {
      const normalized = normalizeProvider(provider);
      if (normalized) providers.add(normalized);
    }
    for (const session of Array.isArray(project && project.sessions) ? project.sessions : []) {
      const normalized = normalizeProvider(session && session.provider);
      if (normalized) providers.add(normalized);
    }
  }
  return [...providers].sort();
}

function detectPersistentTmux(options = {}) {
  const spawnSyncImpl = options.spawnSync || defaultSpawnSync;
  return persistentSession.detectTmux({
    platform: options.platform || process.platform,
    env: options.env || process.env,
    spawnSync: spawnSyncImpl,
    resolveCommandPath: options.resolveCommandPath,
    existsSync: options.fs && options.fs.existsSync
  });
}

function listPersistentSessionsForAccount(provider, accountRef, tmux, options = {}) {
  const spawnSyncImpl = options.spawnSync || defaultSpawnSync;
  if (!tmux.available) return [];

  const command = persistentSession.buildListSessionsCommand({
    cliName: provider,
    runtimeScope: accountRef,
    tmuxCommand: tmux.command
  });
  try {
    const result = spawnSyncImpl(command.command, command.args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: Math.max(200, Number(options.timeoutMs) || 1000)
    });
    return persistentSession.parseSessionList(result && result.stdout)
      .filter((session) => session.attached);
  } catch (_error) {
    return [];
  }
}

function resolvePersistentSessions(provider, sessions, options = {}) {
  const resolver = typeof options.resolveAgentSessionTitles === 'function'
    ? options.resolveAgentSessionTitles
    : defaultResolveAgentSessionTitles;
  if (normalizeProvider(provider) !== 'codex') return sessions;
  try {
    return resolver(provider, sessions, {
      fs: options.fs,
      hostHomeDir: options.hostHomeDir,
      platform: options.platform || process.platform,
      execFileSync: options.execFileSync,
      listOpenFilesForPid: options.listOpenFilesForPid,
      readProcessParentRows: options.readProcessParentRows,
      readCodexActiveSessionRecords: options.readCodexActiveSessionRecords,
      readCodexThreadRecords: options.readCodexThreadRecords || (() => [])
    });
  } catch (_error) {
    return sessions;
  }
}

function collectPersistentSessionRunKeys(projects, options = {}) {
  const fsImpl = options.fs || require('node:fs');
  const aiHomeDir = normalizeText(options.aiHomeDir);
  if (!aiHomeDir) return new Set();

  const sessionIndex = indexProjectSessions(projects);
  const runningKeys = new Set();
  const tmux = detectPersistentTmux(options);
  if (!tmux.available) return runningKeys;

  for (const provider of collectProjectProviders(projects)) {
    const accountScopes = listProviderAccountScopes(fsImpl, aiHomeDir, provider);
    for (const accountRef of accountScopes) {
      const rawSessions = listPersistentSessionsForAccount(provider, accountRef, tmux, {
        ...options,
        fs: fsImpl
      });
      const resolvedSessions = resolvePersistentSessions(provider, rawSessions, {
        ...options,
        fs: fsImpl
      });
      for (const session of resolvedSessions) {
        const agentSessionId = normalizeText(session && session.agentSessionId);
        if (!agentSessionId) continue;
        const identity = buildSessionIdentity(provider, agentSessionId);
        let candidates = Array.from(sessionIndex.get(identity) || []);
        const sessionPath = normalizeProjectPath(session && session.path);
        if (sessionPath && candidates.length > 1) {
          const projectMatches = candidates.filter((candidate) => candidate.projectPath === sessionPath);
          if (projectMatches.length > 0) candidates = projectMatches;
        }
        candidates.forEach((candidate) => runningKeys.add(candidate.key));
      }
    }
  }
  return runningKeys;
}

module.exports = {
  collectPersistentSessionRunKeys,
  detectPersistentTmux,
  indexProjectSessions,
  listProviderAccountScopes
};
