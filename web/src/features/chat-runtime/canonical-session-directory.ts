import type {
  ChatRuntimeApi,
  ChatRuntimeSession,
} from '@/chat-runtime';
import type { AggregatedProject, Provider, Session } from '@/types';

export interface CanonicalSessionDirectoryQuery {
  readonly provider: Provider;
  readonly projectPath: string;
  readonly nativeSessionId?: string;
}

export interface CanonicalSessionDirectoryFocus {
  readonly provider?: string;
  readonly projectPath?: string;
  readonly nativeSessionId?: string;
}

export interface CanonicalSessionDirectoryResult {
  readonly sessions: readonly Session[];
}

export function combineCanonicalSessionDirectoryResults(
  results: readonly CanonicalSessionDirectoryResult[],
): CanonicalSessionDirectoryResult {
  const sessions = new Map<string, Session>();
  results.flatMap((result) => result.sessions).forEach((session) => {
    const identity = sessionIdentity(session);
    const current = sessions.get(identity);
    if (!current || session.updatedAt > current.updatedAt) sessions.set(identity, session);
  });
  return { sessions: sortSessionsByActivity([...sessions.values()]) };
}

export function overlayCanonicalSessionDirectoryFocus(
  base: CanonicalSessionDirectoryResult,
  exact: CanonicalSessionDirectoryResult,
  focus: CanonicalSessionDirectoryQuery,
): CanonicalSessionDirectoryResult {
  const nativeSessionId = String(focus.nativeSessionId || '').trim();
  if (!nativeSessionId) {
    return combineCanonicalSessionDirectoryResults([base, exact]);
  }
  const focusedIdentity = nativeIdentity(focus.provider, nativeSessionId);
  const baseWithoutFocusedIdentity = {
    sessions: base.sessions.filter((session) => sessionIdentity(session) !== focusedIdentity),
  };
  return combineCanonicalSessionDirectoryResults([baseWithoutFocusedIdentity, exact]);
}

export function resolveCanonicalSessionDirectoryFocus(
  session: Session | null,
  persisted: CanonicalSessionDirectoryFocus,
): CanonicalSessionDirectoryFocus {
  if (session?.draft) return {};
  return {
    provider: session?.provider || persisted.provider,
    projectPath: session?.projectPath || persisted.projectPath,
    nativeSessionId: session?.id || persisted.nativeSessionId,
  };
}

export function buildCanonicalSessionDirectoryQueries(
  projects: readonly AggregatedProject[],
  providers: readonly Provider[],
  focus: CanonicalSessionDirectoryFocus = {},
): CanonicalSessionDirectoryQuery[] {
  const queries = new Map<string, CanonicalSessionDirectoryQuery>();
  projects.forEach((project) => {
    const projectPath = project.path.trim();
    if (!projectPath) return;
    providers.forEach((provider) => {
      const query = { provider, projectPath };
      queries.set(directoryQueryIdentity(query), query);
    });
  });
  const focusProvider = providers.find((provider) => provider === focus.provider);
  const focusProjectPath = String(focus.projectPath || '').trim();
  const nativeSessionId = String(focus.nativeSessionId || '').trim();
  if (focusProvider && focusProjectPath && nativeSessionId) {
    const query = { provider: focusProvider, projectPath: focusProjectPath, nativeSessionId };
    queries.set(directoryQueryIdentity(query), query);
  }
  return [...queries.values()];
}

export async function loadCanonicalSessionDirectory(
  queries: readonly CanonicalSessionDirectoryQuery[],
  api: Pick<ChatRuntimeApi, 'listSessions'>,
): Promise<CanonicalSessionDirectoryResult> {
  const responses = await Promise.all(queries.map(async (query) => {
    const sessions = await api.listSessions(query);
    return sessions.flatMap((session) => projectRuntimeSession(session, query));
  }));
  return combineCanonicalSessionDirectoryResults(
    responses.flat().map((session) => ({ sessions: [session] })),
  );
}

export function mergeCanonicalSessionDirectory(
  projects: readonly AggregatedProject[],
  canonicalSessions: readonly Session[],
): AggregatedProject[] {
  const sessionsByProject = groupSessionsByProject(canonicalSessions);
  return sortProjectsByActivity(projects.map((project) => {
    const canonical = sessionsByProject.get(project.path);
    if (!canonical?.length) return project;
    return mergeProjectSessions(project, canonical);
  }));
}

function projectRuntimeSession(
  session: ChatRuntimeSession,
  query: CanonicalSessionDirectoryQuery,
): Session[] {
  const nativeSessionId = typeof session.runtimeBinding.nativeSessionId === 'string'
    ? session.runtimeBinding.nativeSessionId.trim()
    : '';
  if (!nativeSessionId
    || session.provider !== query.provider
    || session.projectPath !== query.projectPath
    || (query.nativeSessionId && nativeSessionId !== query.nativeSessionId)) return [];
  return [{
    id: nativeSessionId,
    title: '新会话',
    updatedAt: session.updatedAt,
    provider: query.provider,
    projectPath: query.projectPath,
    status: session.state,
  }];
}

function groupSessionsByProject(sessions: readonly Session[]): Map<string, Session[]> {
  const grouped = new Map<string, Session[]>();
  sessions.forEach((session) => {
    const projectPath = String(session.projectPath || '').trim();
    if (!projectPath) return;
    const current = grouped.get(projectPath) || [];
    current.push(session);
    grouped.set(projectPath, current);
  });
  return grouped;
}

function mergeProjectSessions(
  project: AggregatedProject,
  canonicalSessions: readonly Session[],
): AggregatedProject {
  const sessions = new Map<string, Session>();
  project.sessions.forEach((session) => sessions.set(sessionIdentity(session), session));
  canonicalSessions.forEach((canonical) => {
    const identity = sessionIdentity(canonical);
    const history = sessions.get(identity);
    sessions.set(identity, history ? mergeSessionHistory(history, canonical) : canonical);
  });
  const mergedSessions = sortSessionsByActivity([...sessions.values()]);
  return {
    ...project,
    providers: [...new Set([
      ...project.providers,
      ...canonicalSessions.map((session) => session.provider),
    ])],
    sessions: mergedSessions,
    ...(project.sessionTotal === undefined ? {} : {
      sessionTotal: Math.max(project.sessionTotal, mergedSessions.length),
    }),
  };
}

function mergeSessionHistory(history: Session, canonical: Session): Session {
  return {
    ...canonical,
    ...history,
    updatedAt: Math.max(history.updatedAt, canonical.updatedAt),
    status: canonical.status,
  };
}

function sessionIdentity(value: Pick<Session, 'provider' | 'id'> | CanonicalSessionDirectoryQuery): string {
  const identity = 'id' in value ? value.id : value.projectPath;
  return nativeIdentity(value.provider, identity);
}

function nativeIdentity(provider: Provider, nativeSessionId: string): string {
  return `${provider}\u0000${nativeSessionId}`;
}

function directoryQueryIdentity(query: CanonicalSessionDirectoryQuery): string {
  return `${query.provider}\u0000${query.projectPath}\u0000${query.nativeSessionId || ''}`;
}

function sortSessionsByActivity(sessions: Session[]): Session[] {
  return [...sessions].sort((left, right) => right.updatedAt - left.updatedAt);
}

function sortProjectsByActivity(projects: readonly AggregatedProject[]): AggregatedProject[] {
  return [...projects].sort((left, right) => projectActivity(right) - projectActivity(left));
}

function projectActivity(project: AggregatedProject): number {
  return Math.max(
    Number(project.addedAt) || 0,
    ...project.sessions.map((session) => Number(session.updatedAt) || 0),
  );
}
