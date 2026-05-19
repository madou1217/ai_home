export function getActualSessionRunKey(provider, sessionId, projectDirName) {
  return `${provider}:${sessionId}:${projectDirName || ''}`;
}

export function getSessionRunKey(session) {
  if (!session) return '';
  return session.draft
    ? `draft:${session.id}`
    : getActualSessionRunKey(session.provider, session.id, session.projectDirName);
}

export function findActiveRunKeyForSession(session, activeRuns) {
  if (!session) return '';
  const runs = Array.isArray(activeRuns)
    ? activeRuns
    : Array.from(activeRuns || []);
  const targetActualKey = session.draft
    ? ''
    : getActualSessionRunKey(session.provider, session.id, session.projectDirName);

  for (const run of runs) {
    if (!run) continue;
    if (session.draft) {
      if (run.draftSessionId && run.draftSessionId === session.id) {
        return run.runKey || '';
      }
      continue;
    }
    if (run.runKey === targetActualKey) {
      return run.runKey || '';
    }
    if (
      run.provider === session.provider
      && run.sessionId === session.id
      && String(run.projectDirName || '') === String(session.projectDirName || '')
    ) {
      return run.runKey || '';
    }
  }

  return '';
}

export function collectRunningSessionKeys(activeRuns) {
  const runs = Array.isArray(activeRuns)
    ? activeRuns
    : Array.from(activeRuns || []);
  const nextKeys = new Set();
  for (const run of runs) {
    if (!run || !run.sessionId) continue;
    nextKeys.add(getActualSessionRunKey(run.provider, run.sessionId, run.projectDirName));
  }
  return nextKeys;
}

export function resolveSelectedSessionQueueKey(selectedSession, selectedSessionRunKey) {
  if (selectedSessionRunKey) return selectedSessionRunKey;
  if (!selectedSession) return '';
  return getSessionRunKey(selectedSession);
}
