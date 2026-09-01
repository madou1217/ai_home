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

export type CanonicalSessionDirectoryRequestStatus = 'loading' | 'ready' | 'failed';

/**
 * 目录请求状态机：result 始终保留最近一次成功数据，
 * key 变化 / 刷新 / 失败期间不清空，仅以 status + stale 表达。
 */
export interface CanonicalSessionDirectoryRequestState {
  readonly key: string;
  readonly result: CanonicalSessionDirectoryResult;
  readonly status: CanonicalSessionDirectoryRequestStatus;
  /** true 表示当前展示的 result 来自其他 key（后台刷新中的旧数据）。 */
  readonly stale: boolean;
  /** true 表示当前展示的 result 来自离线缓存回退（服务端不可达时的磁盘数据）。 */
  readonly offlineCached: boolean;
}

export type CanonicalSessionDirectoryRequestAction =
  | { readonly type: 'begin'; readonly key: string }
  | { readonly type: 'succeed'; readonly key: string; readonly result: CanonicalSessionDirectoryResult }
  | { readonly type: 'fail'; readonly key: string }
  | { readonly type: 'restore'; readonly key: string; readonly result: CanonicalSessionDirectoryResult }
  | { readonly type: 'pending'; readonly key: string }
  | { readonly type: 'empty' };

export const EMPTY_CANONICAL_SESSION_DIRECTORY: CanonicalSessionDirectoryResult = Object.freeze({
  sessions: Object.freeze([]),
});

export function createCanonicalSessionDirectoryRequestState(
  pending: boolean,
): CanonicalSessionDirectoryRequestState {
  return {
    key: '',
    result: EMPTY_CANONICAL_SESSION_DIRECTORY,
    status: pending ? 'loading' : 'ready',
    stale: false,
    offlineCached: false,
  };
}

/** 仅当保留了其他 key 的旧数据时才标记 stale。 */
function retainingStaleData(
  state: CanonicalSessionDirectoryRequestState,
  key: string,
): boolean {
  return state.stale || (state.result.sessions.length > 0 && state.key !== key);
}

export function reduceCanonicalSessionDirectoryRequest(
  state: CanonicalSessionDirectoryRequestState,
  action: CanonicalSessionDirectoryRequestAction,
): CanonicalSessionDirectoryRequestState {
  switch (action.type) {
    case 'begin':
      // 后台刷新：保留上一份结果；key 变化期间旧数据标 stale，不清空列表。
      return { ...state, status: 'loading', stale: retainingStaleData(state, action.key) };
    case 'succeed':
      return { key: action.key, result: action.result, status: 'ready', stale: false, offlineCached: false };
    case 'fail':
      // 失败保留旧数据，仅置 failed 状态，交由 UI 展示重试入口。
      return { ...state, status: 'failed', stale: retainingStaleData(state, action.key) };
    case 'restore':
      // 离线回退：无内存旧数据时载入磁盘缓存，保持 failed 语义并标注来源。
      return { key: action.key, result: action.result, status: 'failed', stale: false, offlineCached: true };
    case 'pending':
      // 项目目录尚未加载完成：视为加载中并保留旧数据，不当作"确实无项目"。
      return { ...state, status: 'loading', stale: retainingStaleData(state, action.key) };
    case 'empty':
      // 目录已就绪但确实没有可查询的项目：回到空目录。
      return createCanonicalSessionDirectoryRequestState(false);
  }
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
