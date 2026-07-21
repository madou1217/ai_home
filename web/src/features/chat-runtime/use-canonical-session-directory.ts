import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  createBrowserChatRuntimeApiClient,
  type ChatRuntimeApi,
} from '@/chat-runtime';
import { resolveActiveServer } from '@/services/webui-auth-transport';
import type { AggregatedProject } from '@/types';
import {
  buildCanonicalSessionDirectoryQueries,
  combineCanonicalSessionDirectoryResults,
  loadCanonicalSessionDirectory,
  mergeCanonicalSessionDirectory,
  overlayCanonicalSessionDirectoryFocus,
} from './canonical-session-directory';
import type {
  CanonicalSessionDirectoryFocus,
  CanonicalSessionDirectoryQuery,
  CanonicalSessionDirectoryResult,
} from './canonical-session-directory';
import { chatRuntimeProviders } from './runtime-provider-registry';

const browserApi = createBrowserChatRuntimeApiClient();
const EMPTY_DIRECTORY: CanonicalSessionDirectoryResult = Object.freeze({
  sessions: Object.freeze([]),
});

export interface CanonicalSessionDirectory {
  readonly projects: AggregatedProject[];
  readonly ready: boolean;
  readonly status: 'loading' | 'ready' | 'failed';
  readonly refresh: () => Promise<void>;
}

export function useCanonicalSessionDirectory(
  projects: readonly AggregatedProject[],
  focus: CanonicalSessionDirectoryFocus = {},
  api: Pick<ChatRuntimeApi, 'listSessions'> = browserApi,
): CanonicalSessionDirectory {
  const providers = chatRuntimeProviders.providers();
  const providerKey = providers.join(',');
  const serverKey = activeServerKey();
  const baseKey = [
    serverKey,
    providerKey,
    ...projects.map((project) => project.path.trim()).filter(Boolean).sort(),
  ].join('\u0000');
  const focusDescriptorKey = [
    serverKey,
    providerKey,
    String(focus.provider || '').trim(),
    String(focus.projectPath || '').trim(),
    String(focus.nativeSessionId || '').trim(),
  ].join('\u0000');
  const baseQueries = useMemo(
    () => buildCanonicalSessionDirectoryQueries(projects, providers),
    [baseKey],
  );
  const focusQuery = useMemo(
    () => buildCanonicalSessionDirectoryQueries([], providers, focus)[0] || null,
    [focusDescriptorKey],
  );
  const focusQueries = useMemo(
    () => focusQuery ? [focusQuery] : [],
    [focusQuery],
  );
  const focusKey = focusQuery ? focusDescriptorKey : '';
  const base = useDirectoryRequest(baseKey, baseQueries, api, true);
  const focused = useDirectoryRequest(
    focusKey,
    focusQueries,
    api,
    false,
  );
  const directory = useMemo(() => {
    if (focusQuery && focused.status === 'ready') {
      return overlayCanonicalSessionDirectoryFocus(base.result, focused.result, focusQuery);
    }
    return combineCanonicalSessionDirectoryResults([base.result]);
  }, [base.result, focusQuery, focused.result, focused.status]);
  const status = focusQuery ? focused.status : base.status;
  const refresh = useCallback(async (): Promise<void> => {
    await Promise.all([base.refresh(), focused.refresh()]);
  }, [base.refresh, focused.refresh]);

  return {
    projects: useMemo(
      () => mergeCanonicalSessionDirectory(projects, directory.sessions),
      [directory.sessions, projects],
    ),
    ready: status === 'ready',
    status,
    refresh,
  };
}

interface DirectoryRequestState {
  readonly key: string;
  readonly result: CanonicalSessionDirectoryResult;
  readonly status: 'loading' | 'ready' | 'failed';
}

function useDirectoryRequest(
  key: string,
  queries: readonly CanonicalSessionDirectoryQuery[],
  api: Pick<ChatRuntimeApi, 'listSessions'>,
  retainReadyWhileRefreshing: boolean,
) {
  const enabled = Boolean(key && queries.length > 0);
  const [state, setState] = useState<DirectoryRequestState>({
    key: '',
    result: EMPTY_DIRECTORY,
    status: enabled ? 'loading' : 'ready',
  });
  const stateRef = useRef(state);
  const mountedRef = useRef(false);
  const requestSequenceRef = useRef(0);
  stateRef.current = state;

  const refresh = useCallback(async (): Promise<void> => {
    const requestId = ++requestSequenceRef.current;
    if (!enabled) {
      if (mountedRef.current) setState({ key: '', result: EMPTY_DIRECTORY, status: 'ready' });
      return;
    }
    const current = stateRef.current;
    const retainCurrent = retainReadyWhileRefreshing
      && current.key === key
      && current.status === 'ready';
    if (!retainCurrent && mountedRef.current) {
      setState({ key, result: EMPTY_DIRECTORY, status: 'loading' });
    }
    try {
      const result = await loadCanonicalSessionDirectory(queries, api);
      if (mountedRef.current && requestId === requestSequenceRef.current) {
        setState({ key, result, status: 'ready' });
      }
    } catch (_error) {
      if (!mountedRef.current || requestId !== requestSequenceRef.current) return;
      if (!retainCurrent) setState({ key, result: EMPTY_DIRECTORY, status: 'failed' });
    }
  }, [api, enabled, key, queries, retainReadyWhileRefreshing]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestSequenceRef.current += 1;
    };
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const current = state.key === key
    ? state
    : { key, result: EMPTY_DIRECTORY, status: enabled ? 'loading' as const : 'ready' as const };
  return { result: current.result, status: current.status, refresh };
}

function activeServerKey(): string {
  const server = resolveActiveServer();
  return `${server.serverId || 'local'}:${server.isRemote ? 'remote' : 'same-origin'}`;
}
