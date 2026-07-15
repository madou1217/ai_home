function normalizeSessions(project) {
  return Array.isArray(project?.sessions) ? project.sessions : [];
}

function normalizeSessionTotal(project) {
  const total = Number(project?.sessionTotal);
  return Number.isInteger(total) && total >= 0 ? total : null;
}

function sessionIdentity(session) {
  return [
    String(session?.provider || ''),
    String(session?.id || ''),
    String(session?.projectDirName || '')
  ].join('\u0000');
}

function sortSessionsByUpdatedAtDesc(sessions) {
  return [...sessions].sort((left, right) => (
    (Number(right?.updatedAt) || 0) - (Number(left?.updatedAt) || 0)
  ));
}

function containsSelectedSession(project, selection) {
  const sessionId = String(selection?.sessionId || '');
  if (!sessionId) return true;
  return normalizeSessions(project).some((session) => (
    session?.id === sessionId
    && (!selection?.provider || session?.provider === selection.provider)
    && (!selection?.projectDirName || session?.projectDirName === selection.projectDirName)
  ));
}

export function isProjectSessionSnapshotComplete(project) {
  const total = normalizeSessionTotal(project);
  return total === null || normalizeSessions(project).length >= total;
}

export function shouldHydrateProjectSessions(project, selection = {}) {
  if (!project?.path) return false;
  if (!containsSelectedSession(project, selection)) return true;
  return !isProjectSessionSnapshotComplete(project);
}

export function isHydratedProjectSessionsStale(compactProject, hydratedProject) {
  if (!compactProject?.path || compactProject.path !== hydratedProject?.path) return false;
  if (isProjectSessionSnapshotComplete(compactProject)) return false;

  const compactTotal = normalizeSessionTotal(compactProject);
  const hydratedTotal = normalizeSessionTotal(hydratedProject);
  if (compactTotal !== null && hydratedTotal !== null && compactTotal !== hydratedTotal) {
    return true;
  }

  const hydratedIdentities = new Set(normalizeSessions(hydratedProject).map(sessionIdentity));
  return normalizeSessions(compactProject).some((session) => (
    !hydratedIdentities.has(sessionIdentity(session))
  ));
}

// The compact SSE snapshot is authoritative for current project/session metadata,
// while the hydrated project owns the older tail that the compact snapshot omits.
// Overlay the former on the latter. When membership changed, callers keep this
// complete transitional union visible while a new full response is requested.
export function mergeHydratedProjectSessions(snapshotProject, hydratedProject) {
  if (!snapshotProject?.path) return hydratedProject;
  if (!hydratedProject?.path || hydratedProject.path !== snapshotProject.path) {
    return snapshotProject;
  }
  if (isProjectSessionSnapshotComplete(snapshotProject)) return snapshotProject;

  const sessionsByIdentity = new Map();
  normalizeSessions(hydratedProject).forEach((session) => {
    sessionsByIdentity.set(sessionIdentity(session), session);
  });
  normalizeSessions(snapshotProject).forEach((session) => {
    const identity = sessionIdentity(session);
    sessionsByIdentity.set(identity, {
      ...(sessionsByIdentity.get(identity) || {}),
      ...session
    });
  });

  const snapshotTotal = normalizeSessionTotal(snapshotProject);
  const hydratedTotal = normalizeSessionTotal(hydratedProject);
  const mergedSessions = sortSessionsByUpdatedAtDesc([...sessionsByIdentity.values()]);
  const sessionTotal = snapshotTotal ?? hydratedTotal ?? mergedSessions.length;

  return {
    ...hydratedProject,
    ...snapshotProject,
    providers: Array.isArray(snapshotProject.providers) && snapshotProject.providers.length > 0
      ? snapshotProject.providers
      : hydratedProject.providers,
    sessions: mergedSessions,
    sessionTotal
  };
}

// A successful full response is the membership source of truth. The latest
// compact snapshot may still carry fresher title/preview timestamps, so only
// overlay metadata for identities that the full response actually contains.
export function applyProjectSessionHydrationResponse(latestProject, hydratedProject) {
  if (!hydratedProject?.path || hydratedProject.path !== latestProject?.path) {
    return hydratedProject;
  }

  const latestSessionsByIdentity = new Map(
    normalizeSessions(latestProject).map((session) => [sessionIdentity(session), session])
  );
  const sessions = sortSessionsByUpdatedAtDesc(
    normalizeSessions(hydratedProject).map((session) => ({
      ...session,
      ...(latestSessionsByIdentity.get(sessionIdentity(session)) || {})
    }))
  );

  return {
    ...hydratedProject,
    ...latestProject,
    sessions,
    sessionTotal: normalizeSessionTotal(hydratedProject) ?? sessions.length
  };
}

export function preserveHydratedProjectSessions(projects, hydratedProjectsByPath) {
  const items = Array.isArray(projects) ? projects : [];
  if (!(hydratedProjectsByPath instanceof Map) || hydratedProjectsByPath.size === 0) {
    return items;
  }
  return items.map((project) => mergeHydratedProjectSessions(
    project,
    hydratedProjectsByPath.get(project.path)
  ));
}

export function canApplyProjectSessionHydration({
  requestId,
  latestRequestId,
  serverKey,
  currentServerKey,
  projectPath,
  responseProjectPath,
  currentProjectPaths
}) {
  return requestId === latestRequestId
    && serverKey === currentServerKey
    && projectPath === responseProjectPath
    && currentProjectPaths instanceof Set
    && currentProjectPaths.has(projectPath);
}
