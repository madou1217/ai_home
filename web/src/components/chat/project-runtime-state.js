export function getSessionRunKey(session) {
  return `${session.provider}:${session.id}:${session.projectDirName || ''}`;
}

export function isSameSession(left, right) {
  return Boolean(left && right && getSessionRunKey(left) === getSessionRunKey(right));
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

/** 项目行 provider / agent / harness 图标最多展示数量，多余收进 +N。 */
export const PROJECT_PROVIDER_BADGE_LIMIT = 6;

/**
 * 按「活跃会话」给项目的 provider / agent / harness 排序：
 *   1. 有正在运行会话的 provider 排前面；
 *   2. 同一活跃等级内，按该 provider 最近一条会话的 updatedAt 倒序（越新越靠左）；
 *   3. 其余保持项目原有 provider 顺序（sort 稳定）。
 */
export function sortProjectProvidersByActivity(projectProviders, runningProviders, projectSessions) {
  const providers = Array.isArray(projectProviders) ? projectProviders : [];
  const activeProviders = runningProviders instanceof Set ? runningProviders : new Set();
  const sessions = Array.isArray(projectSessions) ? projectSessions : [];
  const lastActivity = new Map();
  sessions.forEach((session) => {
    const provider = session?.provider;
    if (!provider) return;
    const updatedAt = Number(session.updatedAt) || 0;
    lastActivity.set(provider, Math.max(lastActivity.get(provider) || 0, updatedAt));
  });
  return [...providers].sort((left, right) => {
    const leftRunning = activeProviders.has(left) ? 1 : 0;
    const rightRunning = activeProviders.has(right) ? 1 : 0;
    if (leftRunning !== rightRunning) return rightRunning - leftRunning;
    return (lastActivity.get(right) || 0) - (lastActivity.get(left) || 0);
  });
}

export function getProjectProviderBadges(projectProviders, runningProviders, projectSessions) {
  const providers = sortProjectProvidersByActivity(projectProviders, runningProviders, projectSessions);
  const activeProviders = runningProviders instanceof Set ? runningProviders : new Set();
  return providers.map((provider) => ({
    provider,
    running: activeProviders.has(provider)
  }));
}
