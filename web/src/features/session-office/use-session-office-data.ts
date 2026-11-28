import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { message } from 'antd';
import {
  sessionsAPI,
  terminalAPI,
  type TerminalDirectorySession,
} from '@/services/api';
import { useWebTerminalManager, type WebTerminalTab } from '@/features/web-terminal/web-terminal-context';
import { useOpenProjectTerminal } from '@/features/web-terminal/use-open-project-terminal';
import { writeClipboardText } from '@/utils/clipboard';
import {
  buildOfficeWorkspaceModel,
  buildPreviewCacheKey,
  type SessionPreviewCacheEntry,
} from './session-office-model';
import type {
  OfficeSessionItem,
  SessionOfficeDataState,
  TerminateSessionResult,
} from './session-office-types';

const HIDDEN_STORAGE_PREFIX = 'aih:terminal-overview:hidden:';
const PREVIEW_BATCH_SIZE = 32;
const CLOSE_DIRECTORY_RESYNC_MS = 320;

interface PreviewTarget {
  cacheKey: string;
  provider: string;
  nativeSessionId: string;
  isRunning: boolean;
}

function readHiddenKeys(serverId: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(`${HIDDEN_STORAGE_PREFIX}${serverId}`) || '[]';
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === 'string' && key.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function extractRequestErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const errObj = error as {
      response?: { data?: { error?: unknown; message?: unknown } };
      message?: unknown;
    };
    const serverMsg = errObj.response?.data?.message ?? errObj.response?.data?.error;
    if (typeof serverMsg === 'string' && serverMsg.trim()) return serverMsg.trim();
    if (typeof errObj.message === 'string' && errObj.message.trim()) return errObj.message.trim();
  }
  return fallback;
}

function formatTerminalCloseError(rawError?: string): string {
  const code = String(rawError ?? '').trim();
  switch (code) {
    case 'unauthorized':
    case 'terminal_http_401':
    case 'terminal_http_403':
      return `当前认证无权限关闭该终端会话 (${code})`;
    case 'terminal_identity_mismatch':
      return '终端会话标识校验不匹配，已拒绝关闭以防误停其他会话 (terminal_identity_mismatch)';
    case 'terminal_not_found':
      return '服务端未确认关闭目标终端，会话仍可能在线或状态未同步 (terminal_not_found)';
    case 'terminal_request_failed':
      return '连接服务端失败，未能终止该终端会话 (terminal_request_failed)';
    default:
      return code ? `关闭终端会话失败：${code}` : '关闭终端会话失败（服务端未返回成功确认）';
  }
}

function buildEvidencedSessionStubs(
  serverId: string,
  directorySessions: TerminalDirectorySession[],
  interactiveTabs: WebTerminalTab[],
  excludedKeys: ReadonlySet<string>,
): OfficeSessionItem[] {
  const seen = new Set<string>();
  const stubs: OfficeSessionItem[] = [];
  const pushStub = (sessionKey: string, provider: string, nativeSessionId?: string) => {
    if (!sessionKey || excludedKeys.has(sessionKey) || seen.has(sessionKey)) return;
    seen.add(sessionKey);
    stubs.push({
      id: `web-terminal:${sessionKey}`,
      sessionKey,
      serverId,
      label: sessionKey,
      shortLabel: sessionKey,
      cwd: '',
      projectKey: '',
      projectName: '',
      kind: sessionKey.startsWith('native:') ? 'account-cli' : 'shell',
      provider,
      nativeSessionId,
      source: sessionKey.startsWith('native:') ? 'native' : 'web',
      availability: 'interactive',
      canAttachTerminal: false,
      persona: {
        avatarTone: '',
        visorStyle: 'visor',
        posture: 'monitoring',
        deskAccent: '',
        badgeCode: '',
        seatIndex: 0,
      },
      });
  };

  for (const dir of directorySessions) {
    pushStub(
      String(dir.sessionKey || '').trim(),
      String(dir.provider || '').trim(),
      String(dir.nativeSessionId || '').trim() || undefined,
    );
  }
  for (const tab of interactiveTabs) {
    pushStub(tab.sessionKey, tab.harness || '', tab.nativeSessionId);
  }
  return stubs;
}

export function useSessionOfficeData(): SessionOfficeDataState {
  const manager = useWebTerminalManager();
  const openProjectTerminal = useOpenProjectTerminal();
  const directory = manager.directory;

  useLayoutEffect(() => {
    manager.setOverviewVisible(true);
    return () => manager.setOverviewVisible(false);
  }, [manager.setOverviewVisible]);

  const [hiddenState, setHiddenState] = useState<{ serverId: string; keys: string[] }>(() => ({
    serverId: manager.serverId,
    keys: readHiddenKeys(manager.serverId),
  }));

  const [terminatedState, setTerminatedState] = useState<{ serverId: string; keys: string[] }>(() => ({
    serverId: manager.serverId,
    keys: [],
  }));

  const [canonicalOverride, setCanonicalOverride] = useState<{
    serverId: string;
    sessions: TerminalDirectorySession[];
  } | null>(null);

  const [terminatingKeysList, setTerminatingKeysList] = useState<string[]>([]);
  const terminatingKeysRef = useRef<Set<string>>(new Set());

  const hiddenKeysList = useMemo(
    () => (hiddenState.serverId === manager.serverId ? hiddenState.keys : readHiddenKeys(manager.serverId)),
    [hiddenState, manager.serverId],
  );

  const terminatedKeysList = useMemo(
    () => (terminatedState.serverId === manager.serverId ? terminatedState.keys : []),
    [manager.serverId, terminatedState],
  );

  const terminatedSessionKeys = useMemo(() => new Set(terminatedKeysList), [terminatedKeysList]);
  const terminatingSessionKeys = useMemo(() => new Set(terminatingKeysList), [terminatingKeysList]);

  const excludedSessionKeys = useMemo(() => {
    const merged = new Set<string>(hiddenKeysList);
    for (const key of terminatedKeysList) {
      merged.add(key);
    }
    // 服务端已连续两次确认不存在的 project-shell：不作为工位保留。
    for (const key of manager.goneShellKeys) {
      merged.add(key);
    }
    return merged;
  }, [hiddenKeysList, terminatedKeysList, manager.goneShellKeys]);

  useEffect(() => {
    setHiddenState((current) => (
      current.serverId === manager.serverId
        ? current
        : { serverId: manager.serverId, keys: readHiddenKeys(manager.serverId) }
    ));
    setTerminatedState((current) => (
      current.serverId === manager.serverId
        ? current
        : { serverId: manager.serverId, keys: [] }
    ));
    setCanonicalOverride((current) => (
      current && current.serverId === manager.serverId ? current : null
    ));
  }, [manager.serverId]);

  // Once the shared directory poll catches up and confirms closed sessions are gone,
  // release the temporary canonical override snapshot so live polling stays primary.
  useEffect(() => {
    setCanonicalOverride((current) => {
      if (!current || current.serverId !== manager.serverId) return null;
      const stillHasTerminatedRunning = directory.sessions.some(
        (item) => item.status === 'running' && terminatedSessionKeys.has(item.sessionKey),
      );
      return stillHasTerminatedRunning ? current : null;
    });
  }, [directory.sessions, manager.serverId, terminatedSessionKeys]);

  const effectiveDirectorySessions = useMemo<TerminalDirectorySession[]>(() => {
    const base = canonicalOverride && canonicalOverride.serverId === manager.serverId
      ? canonicalOverride.sessions
      : directory.sessions;
    if (terminatedSessionKeys.size === 0) return base;
    return base.filter((session) => !terminatedSessionKeys.has(session.sessionKey));
  }, [canonicalOverride, directory.sessions, manager.serverId, terminatedSessionKeys]);

  const effectiveInteractiveTabs = useMemo<WebTerminalTab[]>(() => {
    if (terminatedSessionKeys.size === 0) return manager.tabs;
    return manager.tabs.filter((tab) => !terminatedSessionKeys.has(tab.sessionKey));
  }, [manager.tabs, terminatedSessionKeys]);

  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState('all');

  // Guard adoptSessions against hidden, closing, or terminated keys so a closed
  // web shell is never re-adopted or resurrected from a stale directory poll.
  useEffect(() => {
    manager.adoptSessions(
      effectiveDirectorySessions
        .filter(
          (session) =>
            session.status === 'running'
            && !excludedSessionKeys.has(session.sessionKey)
            && !terminatingSessionKeys.has(session.sessionKey),
        )
        .map((session) => ({
          sessionKey: session.sessionKey,
          label: session.label,
          cwd: session.cwd,
          kind: session.source === 'native' ? 'account-cli' : 'shell',
          harness: session.provider,
          nativeSessionId: session.nativeSessionId,
        })),
    );
  }, [effectiveDirectorySessions, excludedSessionKeys, manager.adoptSessions, terminatingSessionKeys]);

  const [previewCache, setPreviewCache] = useState<Map<string, SessionPreviewCacheEntry>>(() => new Map());

  const mountedRef = useRef(true);
  const closeResyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (closeResyncTimerRef.current !== null) {
        clearTimeout(closeResyncTimerRef.current);
        closeResyncTimerRef.current = null;
      }
    };
  }, []);

  const activeServerRef = useRef(manager.serverId);
  activeServerRef.current = manager.serverId;

  const managerTabsRef = useRef(manager.tabs);
  managerTabsRef.current = manager.tabs;

  const sessionStubsRef = useRef<OfficeSessionItem[]>([]);
  sessionStubsRef.current = useMemo(
    () => buildEvidencedSessionStubs(
      manager.serverId,
      effectiveDirectorySessions,
      effectiveInteractiveTabs,
      excludedSessionKeys,
    ),
    [
      effectiveDirectorySessions,
      effectiveInteractiveTabs,
      excludedSessionKeys,
      manager.serverId,
    ],
  );

  const inFlightPreviewKeysRef = useRef<Set<string>>(new Set());
  const previewEpochRef = useRef(0);

  useEffect(() => {
    inFlightPreviewKeysRef.current.clear();
    previewEpochRef.current += 1;
  }, [manager.serverId]);

  const previewTargets = useMemo<PreviewTarget[]>(() => {
    const targetsByKey = new Map<string, PreviewTarget>();
    const dirByKey = new Map<string, TerminalDirectorySession>();
    for (const dir of effectiveDirectorySessions) {
      dirByKey.set(dir.sessionKey, dir);
    }

    const consider = (
      sessionKey: string,
      providerRaw: string | undefined,
      nativeSessionIdRaw: string | undefined,
      cwdRaw: string | undefined,
      isRunning: boolean,
    ) => {
      if (!sessionKey || excludedSessionKeys.has(sessionKey)) return;
      const provider = String(providerRaw || '').trim();
      const nativeSessionId = String(nativeSessionIdRaw || '').trim();
      if (!provider || provider === 'shell' || !nativeSessionId) return;
      const cwd = String(cwdRaw || '').trim();
      const cacheKey = buildPreviewCacheKey(manager.serverId, provider, nativeSessionId, cwd);
      if (targetsByKey.has(cacheKey)) return;
      targetsByKey.set(cacheKey, {
        cacheKey,
        provider,
        nativeSessionId,
        isRunning,
      });
    };

    for (const dir of effectiveDirectorySessions) {
      consider(
        dir.sessionKey,
        dir.provider,
        dir.nativeSessionId,
        dir.cwd,
        dir.status === 'running',
      );
    }
    for (const tab of effectiveInteractiveTabs) {
      const dir = dirByKey.get(tab.sessionKey);
      consider(
        tab.sessionKey,
        dir?.provider || tab.harness,
        dir?.nativeSessionId || tab.nativeSessionId,
        dir?.cwd ?? tab.cwd,
        dir ? dir.status === 'running' : true,
      );
    }
    const allTargets = [...targetsByKey.values()];
    allTargets.sort((a, b) => Number(b.isRunning) - Number(a.isRunning));
    return allTargets;
  }, [
    effectiveDirectorySessions,
    effectiveInteractiveTabs,
    excludedSessionKeys,
    manager.serverId,
  ]);

  useEffect(() => {
    const missing = previewTargets.filter(
      (item) => !previewCache.has(item.cacheKey) && !inFlightPreviewKeysRef.current.has(item.cacheKey),
    );
    if (missing.length === 0) return;

    const requestServerId = manager.serverId;
    const requestEpoch = previewEpochRef.current;
    for (const item of missing) {
      inFlightPreviewKeysRef.current.add(item.cacheKey);
    }

    const chunks: PreviewTarget[][] = [];
    for (let i = 0; i < missing.length; i += PREVIEW_BATCH_SIZE) {
      chunks.push(missing.slice(i, i + PREVIEW_BATCH_SIZE));
    }

    void (async () => {
      for (const chunk of chunks) {
        if (!mountedRef.current || activeServerRef.current !== requestServerId || previewEpochRef.current !== requestEpoch) {
          for (const item of chunk) inFlightPreviewKeysRef.current.delete(item.cacheKey);
          return;
        }
        const entries = new Map<string, SessionPreviewCacheEntry>();
        try {
          const results = await sessionsAPI.getSessionPreviews(
            chunk.map((item) => ({
              provider: item.provider,
              id: item.nativeSessionId,
            })),
          );
          for (const item of chunk) {
            const matched = results.find(
              (res) => res.id === item.nativeSessionId
                && (!res.provider || String(res.provider).toLowerCase() === item.provider.toLowerCase()),
            );
            entries.set(item.cacheKey, {
              model: matched?.model?.trim() || undefined,
              preview: matched?.preview?.trim() || undefined,
            });
          }
        } catch {
          for (const item of chunk) {
            entries.set(item.cacheKey, {});
          }
        } finally {
          for (const item of chunk) {
            inFlightPreviewKeysRef.current.delete(item.cacheKey);
          }
        }

        if (!mountedRef.current || activeServerRef.current !== requestServerId || previewEpochRef.current !== requestEpoch) {
          return;
        }
        if (entries.size > 0) {
          setPreviewCache((current) => {
            const next = new Map(current);
            for (const [key, val] of entries.entries()) {
              next.set(key, val);
            }
            return next;
          });
        }
      }
    })();
  }, [manager.serverId, previewCache, previewTargets]);

  const workspace = useMemo(
    () => buildOfficeWorkspaceModel({
      serverId: manager.serverId,
      directorySessions: effectiveDirectorySessions,
      interactiveTabs: effectiveInteractiveTabs,
      hiddenSessionKeys: excludedSessionKeys,
      previewsByCacheKey: previewCache,
      query,
      providerFilter,
    }),
    [
      effectiveDirectorySessions,
      effectiveInteractiveTabs,
      excludedSessionKeys,
      manager.serverId,
      previewCache,
      providerFilter,
      query,
    ],
  );

  const syncCanonicalDirectory = useCallback(async (targetServerId: string): Promise<TerminalDirectorySession[] | null> => {
    if (!mountedRef.current || activeServerRef.current !== targetServerId) {
      return null;
    }

    let directSessions: TerminalDirectorySession[] | null = null;
    try {
      const listed = await terminalAPI.listSessions();
      if (!mountedRef.current || activeServerRef.current !== targetServerId) {
        return null;
      }
      if (listed?.ok && Array.isArray(listed.sessions)) {
        directSessions = listed.sessions;
        setCanonicalOverride({
          serverId: targetServerId,
          sessions: listed.sessions,
        });
      }
    } catch {
      // Fall back to directory.refresh() below if direct fetch fails.
    }

    if (!mountedRef.current || activeServerRef.current !== targetServerId) {
      return null;
    }

    await directory.refresh();

    if (closeResyncTimerRef.current !== null) {
      clearTimeout(closeResyncTimerRef.current);
    }
    closeResyncTimerRef.current = setTimeout(() => {
      closeResyncTimerRef.current = null;
      if (mountedRef.current && activeServerRef.current === targetServerId) {
        void directory.refresh();
      }
    }, CLOSE_DIRECTORY_RESYNC_MS);

    return directSessions;
  }, [directory.refresh]);

  const refreshDirectory = useCallback(async () => {
    await syncCanonicalDirectory(manager.serverId);
  }, [manager.serverId, syncCanonicalDirectory]);

  const refreshAll = useCallback(async () => {
    previewEpochRef.current += 1;
    inFlightPreviewKeysRef.current.clear();
    const serverPrefix = `${manager.serverId}:`;
    setPreviewCache((current) => {
      let removed = false;
      const next = new Map<string, SessionPreviewCacheEntry>();
      for (const [key, value] of current.entries()) {
        if (key.startsWith(serverPrefix)) {
          removed = true;
        } else {
          next.set(key, value);
        }
      }
      return removed ? next : current;
    });
    await syncCanonicalDirectory(manager.serverId);
  }, [manager.serverId, syncCanonicalDirectory]);

  const openNewProjectTerminal = useCallback(async (cwd?: string) => {
    await openProjectTerminal(cwd);
  }, [openProjectTerminal]);

  const finalizeClosedWebSession = useCallback(
    (targetServerId: string, sessionKey: string, sessionId: string) => {
      setTerminatedState((current) => {
        const existing = current.serverId === targetServerId ? current.keys : [];
        const nextKeys = existing.includes(sessionKey) ? existing : [...existing, sessionKey];
        return { serverId: targetServerId, keys: nextKeys };
      });

      // Remove any persisted or minimized WebTerminalManager tabs for this session
      // so GlobalWebTerminalHost / SessionDesktop will never re-attach or resurrect it.
      const candidateTabIds = new Set<string>([sessionId, `web-terminal:${sessionKey}`]);
      for (const tab of managerTabsRef.current) {
        if (tab.sessionKey === sessionKey || tab.id === sessionId) {
          candidateTabIds.add(tab.id);
        }
      }
      for (const tabId of candidateTabIds) {
        manager.closeTab(tabId);
      }

      // Clean up hidden-view storage if this session key had been previously hidden.
      setHiddenState((current) => {
        const existing = current.serverId === targetServerId ? current.keys : readHiddenKeys(targetServerId);
        if (!existing.includes(sessionKey)) return current;
        const nextKeys = existing.filter((item) => item !== sessionKey);
        try {
          if (nextKeys.length > 0) {
            window.localStorage.setItem(
              `${HIDDEN_STORAGE_PREFIX}${targetServerId}`,
              JSON.stringify(nextKeys),
            );
          } else {
            window.localStorage.removeItem(`${HIDDEN_STORAGE_PREFIX}${targetServerId}`);
          }
        } catch {
          // Ignore localStorage write errors.
        }
        return { serverId: targetServerId, keys: nextKeys };
      });
    },
    [manager],
  );

  const terminateWebSession = useCallback(
    async (
      target: Pick<
        OfficeSessionItem,
        'id' | 'serverId' | 'sessionKey' | 'termId' | 'source' | 'label' | 'cwd' | 'availability'
      >,
    ): Promise<TerminateSessionResult> => {
      const sessionKey = String(target.sessionKey || '').trim();
      const originServerId = String(target.serverId || '').trim();
      if (!sessionKey) {
        return { ok: false, error: '缺少有效的会话标识 (sessionKey)' };
      }
      if (!originServerId) {
        return { ok: false, error: '缺少原会话所属服务器标识 (serverId)，已拒绝执行关闭' };
      }
      if (target.source !== 'web' || sessionKey.startsWith('native:')) {
        return {
          ok: false,
          error: '原生 CLI 会话由独立进程托管，终端 close 接口仅断开借用连接，不支持在此终止原进程。',
        };
      }
      if (terminatingKeysRef.current.has(sessionKey)) {
        return { ok: false, error: '该会话正在关闭中，请勿重复提交' };
      }

      if (originServerId !== manager.serverId || originServerId !== activeServerRef.current) {
        return {
          ok: false,
          error: '当前激活服务器已切换，已取消关闭原服务器上的终端会话以防误操作其他节点。',
        };
      }

      const requestServerId = originServerId;
      terminatingKeysRef.current.add(sessionKey);
      setTerminatingKeysList([...terminatingKeysRef.current]);

      try {
        if (requestServerId !== manager.serverId || requestServerId !== activeServerRef.current) {
          return {
            ok: false,
            error: '当前激活服务器已切换，已取消关闭原服务器上的终端会话以防误操作其他节点。',
          };
        }

        const closeResult = await terminalAPI.close(target.termId || '', sessionKey);

        if (closeResult.ok) {
          if (mountedRef.current && activeServerRef.current === requestServerId) {
            finalizeClosedWebSession(requestServerId, sessionKey, target.id);
            await syncCanonicalDirectory(requestServerId);
          }
          return { ok: true };
        }

        // 服务端重启/网络抖动时 close 可能拿不到响应（terminal_request_failed）或 5xx；
        // 只要目录核对证明会话已不在服务端，就按「已关闭」收尾，不把幽灵工位留给用户。
        const reconcilableClose =
          closeResult.error === 'terminal_not_found'
          || closeResult.error === 'terminal_request_failed'
          || /^terminal_http_5\d\d$/.test(closeResult.error || '');
        if (
          reconcilableClose
          && mountedRef.current
          && activeServerRef.current === requestServerId
        ) {
          const latestSessions = await syncCanonicalDirectory(requestServerId);
          const stillRunningOnServer = latestSessions
            ? latestSessions.some((item) => item.sessionKey === sessionKey && item.status === 'running')
            : true;
          if (latestSessions && !stillRunningOnServer) {
            if (mountedRef.current && activeServerRef.current === requestServerId) {
              finalizeClosedWebSession(requestServerId, sessionKey, target.id);
            }
            return { ok: true, alreadyGone: true };
          }
        }

        return {
          ok: false,
          error: formatTerminalCloseError(closeResult.error),
        };
      } catch (error: unknown) {
        return {
          ok: false,
          error: extractRequestErrorMessage(error, '关闭终端会话请求异常'),
        };
      } finally {
        terminatingKeysRef.current.delete(sessionKey);
        if (mountedRef.current) {
          setTerminatingKeysList([...terminatingKeysRef.current]);
        }
      }
    },
    [finalizeClosedWebSession, manager.serverId, syncCanonicalDirectory],
  );

  const isSessionTerminating = useCallback(
    (sessionKey: string) => terminatingSessionKeys.has(sessionKey),
    [terminatingSessionKeys],
  );

  const terminatingSessionKey = terminatingKeysList.length > 0
    ? terminatingKeysList[terminatingKeysList.length - 1]
    : null;

  const hideSession = useCallback((sessionId: string) => {
    const tab = effectiveInteractiveTabs.find((item) => item.id === sessionId || item.sessionKey === sessionId);
    const dirSession = effectiveDirectorySessions.find(
      (item) => `web-terminal:${item.sessionKey}` === sessionId || item.sessionKey === sessionId,
    );
    const targetSessionKey = tab?.sessionKey || dirSession?.sessionKey;
    if (!targetSessionKey) return;

    setHiddenState((current) => {
      const existing = current.serverId === manager.serverId ? current.keys : readHiddenKeys(manager.serverId);
      const nextKeys = [...new Set([...existing, targetSessionKey])];
      try {
        window.localStorage.setItem(
          `${HIDDEN_STORAGE_PREFIX}${manager.serverId}`,
          JSON.stringify(nextKeys),
        );
      } catch {
        // Keep session management usable even when localStorage is blocked.
      }
      return { serverId: manager.serverId, keys: nextKeys };
    });

    if (tab) {
      manager.closeTab(tab.id);
    }
  }, [effectiveDirectorySessions, effectiveInteractiveTabs, manager]);

  const restoreHiddenSessions = useCallback(() => {
    setHiddenState({ serverId: manager.serverId, keys: [] });
    try {
      window.localStorage.removeItem(`${HIDDEN_STORAGE_PREFIX}${manager.serverId}`);
    } catch {
      // Ignore storage cleanup errors.
    }
  }, [manager.serverId]);

  const copySessionIdentity = useCallback(async (
    session: Pick<OfficeSessionItem, 'label' | 'sessionKey' | 'nativeSessionId'>,
  ) => {
    const text = [session.label, session.nativeSessionId, session.sessionKey]
      .filter((part): part is string => Boolean(part && String(part).trim()))
      .join('\n');
    try {
      await writeClipboardText(text);
      message.success('已复制原会话标识；不会自动重启任务');
    } catch {
      message.error('复制失败，请手动选择下方原会话标识');
    }
  }, []);

  const activateManagerSession = useCallback((sessionId: string) => {
    const tab = effectiveInteractiveTabs.find((item) => item.id === sessionId || item.sessionKey === sessionId);
    if (tab) {
      manager.setActiveTab(tab.id);
    }
  }, [effectiveInteractiveTabs, manager.setActiveTab]);

  return {
    serverId: manager.serverId,
    rooms: workspace.rooms,
    filteredRooms: workspace.filteredRooms,
    allSessions: workspace.allSessions,
    hiddenCount: hiddenKeysList.length,
    providerOptions: workspace.providerOptions,
    query,
    setQuery,
    providerFilter,
    setProviderFilter,
    directoryLoading: directory.loading,
    directoryError: directory.error,
    terminatingSessionKey,
    isSessionTerminating,
    refreshAll,
    refreshDirectory,
    openNewProjectTerminal,
    terminateWebSession,
    hideSession,
    restoreHiddenSessions,
    copySessionIdentity,
    activateManagerSession,
  };
}
