export function getSessionRunKey(session) {
  return `${session.provider}:${session.id}:${session.projectDirName || ''}`;
}

export function isSessionRunning(session, runningSessionKeys) {
  if (!session) return false;
  const activeRunKeys = runningSessionKeys instanceof Set ? runningSessionKeys : new Set();
  const exactKey = getSessionRunKey(session);
  if (activeRunKeys.has(exactKey)) return true;

  const providerPrefix = `${session.provider}:${session.id}:`;
  for (const key of activeRunKeys) {
    if (String(key || '').startsWith(providerPrefix)) {
      return true;
    }
  }
  return false;
}

export function getRunningProviders(projectSessions, runningSessionKeys) {
  return new Set(
    (Array.isArray(projectSessions) ? projectSessions : [])
      .filter((session) => isSessionRunning(session, runningSessionKeys))
      .map((session) => session.provider)
  );
}

export function getVisibleProjectSessions(projectSessions, isExpanded, isSessionsExpanded, collapsedLimit = 10, expandedLimit = 15) {
  if (!isExpanded) return [];
  const sessions = Array.isArray(projectSessions) ? projectSessions : [];
  const maxShow = isSessionsExpanded ? expandedLimit : collapsedLimit;
  return sessions.slice(0, maxShow);
}

export function getProjectProviderBadges(projectProviders, runningProviders, isExpanded) {
  const providers = Array.isArray(projectProviders) ? projectProviders : [];
  const activeProviders = runningProviders instanceof Set ? runningProviders : new Set();
  return providers.map((provider) => ({
    provider,
    spinning: !isExpanded && activeProviders.has(provider)
  }));
}
