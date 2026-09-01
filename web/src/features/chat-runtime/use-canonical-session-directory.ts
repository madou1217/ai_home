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
import {
  readCachedSessionDirectory,
  writeCachedSessionDirectory,
} from '@/services/session-offline-cache';
import type { AggregatedProject } from '@/types';
import {
  buildCanonicalSessionDirectoryQueries,
  combineCanonicalSessionDirectoryResults,
  createCanonicalSessionDirectoryRequestState,
  loadCanonicalSessionDirectory,
  mergeCanonicalSessionDirectory,
  overlayCanonicalSessionDirectoryFocus,
  reduceCanonicalSessionDirectoryRequest,
} from './canonical-session-directory';
import type {
  CanonicalSessionDirectoryFocus,
  CanonicalSessionDirectoryQuery,
  CanonicalSessionDirectoryRequestState,
} from './canonical-session-directory';
import { chatRuntimeProviders } from './runtime-provider-registry';

const browserApi = createBrowserChatRuntimeApiClient();

export interface CanonicalSessionDirectory {
  readonly projects: AggregatedProject[];
  readonly ready: boolean;
  readonly status: 'loading' | 'ready' | 'failed';
  /** true 表示列表展示的是上一份成功数据（key 变化/刷新期间保留）。 */
  readonly stale: boolean;
  /** true 表示列表展示的是离线缓存回退数据（服务端不可达）。 */
  readonly offlineCached: boolean;
  readonly refresh: () => Promise<void>;
}

export interface UseCanonicalSessionDirectoryOptions {
  /** 项目目录尚未加载完成时为 true，用于区分"加载中"与"确实无项目"。 */
  readonly catalogLoading?: boolean;
}

export function useCanonicalSessionDirectory(
  projects: readonly AggregatedProject[],
  focus: CanonicalSessionDirectoryFocus = {},
  api: Pick<ChatRuntimeApi, 'listSessions'> = browserApi,
  options: UseCanonicalSessionDirectoryOptions = {},
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
  // 仅基础目录接入离线缓存：focus 是单会话覆盖查询，缓存价值低，不为它增加条目。
  const base = useDirectoryRequest(baseKey, baseQueries, api, Boolean(options.catalogLoading), serverKey);
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
  const stale = focusQuery ? focused.stale : base.stale;
  const offlineCached = focusQuery ? focused.offlineCached : base.offlineCached;
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
    stale,
    offlineCached,
    refresh,
  };
}

function useDirectoryRequest(
  key: string,
  queries: readonly CanonicalSessionDirectoryQuery[],
  api: Pick<ChatRuntimeApi, 'listSessions'>,
  catalogPending: boolean,
  cacheScope?: string,
) {
  const enabled = Boolean(key && queries.length > 0);
  const [state, setState] = useState<CanonicalSessionDirectoryRequestState>(() => (
    createCanonicalSessionDirectoryRequestState(enabled || catalogPending)
  ));
  const mountedRef = useRef(false);
  const requestSequenceRef = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const requestId = ++requestSequenceRef.current;
    if (!enabled) {
      if (mountedRef.current) {
        setState((current) => reduceCanonicalSessionDirectoryRequest(
          current,
          catalogPending ? { type: 'pending', key } : { type: 'empty' },
        ));
      }
      return;
    }
    // 后台刷新：保留上一份成功数据，仅在展示其他 key 的旧数据时标 stale。
    if (mountedRef.current) {
      setState((current) => reduceCanonicalSessionDirectoryRequest(current, { type: 'begin', key }));
    }
    try {
      const result = await loadCanonicalSessionDirectory(queries, api);
      if (mountedRef.current && requestId === requestSequenceRef.current) {
        if (cacheScope) writeCachedSessionDirectory(cacheScope, key, result.sessions);
        setState((current) => reduceCanonicalSessionDirectoryRequest(
          current,
          { type: 'succeed', key, result },
        ));
      }
    } catch (_error) {
      if (!mountedRef.current || requestId !== requestSequenceRef.current) return;
      // 失败保留旧数据，仅置 failed 状态；内存无旧数据时回退磁盘离线缓存。
      const cachedSessions = cacheScope ? readCachedSessionDirectory(cacheScope, key) : [];
      setState((current) => {
        const failed = reduceCanonicalSessionDirectoryRequest(current, { type: 'fail', key });
        if (failed.result.sessions.length > 0 || cachedSessions.length === 0) return failed;
        return reduceCanonicalSessionDirectoryRequest(
          failed,
          { type: 'restore', key, result: { sessions: cachedSessions } },
        );
      });
    }
  }, [api, cacheScope, catalogPending, enabled, key, queries]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestSequenceRef.current += 1;
    };
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  return {
    result: state.result,
    status: state.status,
    stale: state.stale,
    offlineCached: state.offlineCached,
    refresh,
  };
}

function activeServerKey(): string {
  const server = resolveActiveServer();
  return `${server.serverId || 'local'}:${server.isRemote ? 'remote' : 'same-origin'}`;
}
