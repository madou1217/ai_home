import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { message } from 'antd';
import api, { sessionsAPI, watchPeerMessages, type TerminalDirectorySession } from '@/services/api';
import { useWebTerminalManager, type WebTerminalTab } from '@/features/web-terminal/web-terminal-context';
import { useOpenProjectTerminal } from '@/features/web-terminal/use-open-project-terminal';
import { writeClipboardText } from '@/utils/clipboard';
import {
  buildOfficeWorkspaceModel,
  buildPreviewCacheKey,
  computePeerCounts,
  normalizePeerMessageRecord,
  resolveEvidencedSessionKeysForMessage,
  type SessionPreviewCacheEntry
} from './session-office-model';
import type {
  OfficeSessionItem,
  PeerCounts,
  PeerMessageRecord,
  SessionOfficeDataState
} from './session-office-types';

const HIDDEN_STORAGE_PREFIX = 'aih:terminal-overview:hidden:';
const PREVIEW_BATCH_SIZE = 32;
const PULSE_DURATION_MS = 4500;
const WATCH_DEBOUNCE_MS = 180;

const EMPTY_COUNTS: PeerCounts = {
  total: 0,
  pending: 0,
  delivered: 0,
  read: 0,
  failed: 0
};

interface MessageSnapshotEntry {
  state: string;
  deliveredAt: number;
  readAt: number;
}

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

function buildEvidencedSessionStubs(
  serverId: string,
  directorySessions: TerminalDirectorySession[],
  interactiveTabs: WebTerminalTab[],
  unavailableTabs: WebTerminalTab[],
  hiddenKeys: ReadonlySet<string>
): OfficeSessionItem[] {
  const seen = new Set<string>();
  const stubs: OfficeSessionItem[] = [];
  const pushStub = (sessionKey: string, provider: string, nativeSessionId?: string) => {
    if (!sessionKey || hiddenKeys.has(sessionKey) || seen.has(sessionKey)) return;
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
        seatIndex: 0
      },
      activity: {
        kind: 'idle',
        pendingCount: 0,
        unreadOrDeliveredCount: 0,
        failedCount: 0,
        lastMessageAt: 0,
        recentPulse: false,
        latestSnippet: ''
      },
      inboxCount: 0,
      sentCount: 0,
      pendingCount: 0,
      crossProjectCount: 0
    });
  };

  for (const dir of directorySessions) {
    pushStub(
      String(dir.sessionKey || '').trim(),
      String(dir.provider || '').trim(),
      String(dir.nativeSessionId || '').trim() || undefined
    );
  }
  for (const tab of interactiveTabs) {
    pushStub(tab.sessionKey, tab.harness || '', tab.nativeSessionId);
  }
  for (const tab of unavailableTabs) {
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
    keys: readHiddenKeys(manager.serverId)
  }));

  const hiddenKeysList = useMemo(
    () => (hiddenState.serverId === manager.serverId ? hiddenState.keys : readHiddenKeys(manager.serverId)),
    [hiddenState, manager.serverId]
  );

  const hiddenSessionKeys = useMemo(() => new Set(hiddenKeysList), [hiddenKeysList]);

  useEffect(() => {
    setHiddenState((current) => (
      current.serverId === manager.serverId
        ? current
        : { serverId: manager.serverId, keys: readHiddenKeys(manager.serverId) }
    ));
  }, [manager.serverId]);

  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState('all');

  useEffect(() => {
    manager.adoptSessions(
      directory.sessions
        .filter((session) => session.status === 'running' && !hiddenSessionKeys.has(session.sessionKey))
        .map((session) => ({
          sessionKey: session.sessionKey,
          label: session.label,
          cwd: session.cwd,
          kind: session.source === 'native' ? 'account-cli' : 'shell',
          harness: session.provider,
          nativeSessionId: session.nativeSessionId
        }))
    );
  }, [directory.sessions, hiddenSessionKeys, manager.adoptSessions]);

  const [rawMessages, setRawMessages] = useState<PeerMessageRecord[]>([]);
  const [peerCounts, setPeerCounts] = useState<PeerCounts>(EMPTY_COUNTS);
  const [peerLoading, setPeerLoading] = useState(false);
  const [peerError, setPeerError] = useState('');
  const [recentPulseSessionKeys, setRecentPulseSessionKeys] = useState<ReadonlySet<string>>(() => new Set());

  const [previewCache, setPreviewCache] = useState<Map<string, SessionPreviewCacheEntry>>(() => new Map());

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const activeServerRef = useRef(manager.serverId);
  activeServerRef.current = manager.serverId;

  const sessionStubsRef = useRef<OfficeSessionItem[]>([]);
  sessionStubsRef.current = useMemo(
    () => buildEvidencedSessionStubs(
      manager.serverId,
      directory.sessions,
      manager.tabs,
      manager.unavailableTabs,
      hiddenSessionKeys
    ),
    [directory.sessions, hiddenSessionKeys, manager.serverId, manager.tabs, manager.unavailableTabs]
  );

  const peerGenerationRef = useRef(0);
  const hasInitialPeerLoadRef = useRef(false);
  const prevMessageSnapshotsRef = useRef<Map<string, MessageSnapshotEntry>>(new Map());
  const pulseExpiryRef = useRef<Map<string, number>>(new Map());
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPulseTimer = useCallback(() => {
    if (pulseTimerRef.current !== null) {
      clearTimeout(pulseTimerRef.current);
      pulseTimerRef.current = null;
    }
  }, []);

  const syncPulseState = useCallback(() => {
    clearPulseTimer();
    const now = Date.now();
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const [key, expiresAt] of pulseExpiryRef.current.entries()) {
      if (expiresAt <= now) {
        pulseExpiryRef.current.delete(key);
      } else if (expiresAt < nextExpiry) {
        nextExpiry = expiresAt;
      }
    }
    setRecentPulseSessionKeys(new Set(pulseExpiryRef.current.keys()));
    if (Number.isFinite(nextExpiry)) {
      const waitMs = Math.max(50, nextExpiry - now + 20);
      pulseTimerRef.current = setTimeout(() => {
        if (mountedRef.current) syncPulseState();
      }, waitMs);
    }
  }, [clearPulseTimer]);

  const triggerSessionPulses = useCallback((sessionKeys: string[]) => {
    if (sessionKeys.length === 0) return;
    const expiresAt = Date.now() + PULSE_DURATION_MS;
    for (const key of sessionKeys) {
      pulseExpiryRef.current.set(key, expiresAt);
    }
    syncPulseState();
  }, [syncPulseState]);

  useEffect(() => {
    return () => {
      clearPulseTimer();
      if (watchDebounceTimerRef.current !== null) {
        clearTimeout(watchDebounceTimerRef.current);
        watchDebounceTimerRef.current = null;
      }
    };
  }, [clearPulseTimer]);

  const loadPeerMessages = useCallback(async (detectPulse: boolean) => {
    const requestServerId = manager.serverId;
    const requestGeneration = ++peerGenerationRef.current;
    setPeerLoading(true);
    try {
      const response = await api.get<{
        ok?: boolean;
        messages?: unknown[];
        counts?: Partial<PeerCounts>;
      }>('/webui/peer/messages');
      if (!mountedRef.current || activeServerRef.current !== requestServerId || peerGenerationRef.current !== requestGeneration) {
        return;
      }
      const payload = response.data || {};
      const normalized = Array.isArray(payload.messages)
        ? payload.messages
          .map((item) => normalizePeerMessageRecord(item))
          .filter((item): item is PeerMessageRecord => item !== null)
        : [];

      const computedCounts = computePeerCounts(normalized);
      const serverCounts = payload.counts;
      const resolvedCounts: PeerCounts = serverCounts && typeof serverCounts.total === 'number'
        ? {
            total: Number(serverCounts.total) || 0,
            pending: Number(serverCounts.pending) || 0,
            delivered: Number(serverCounts.delivered) || 0,
            read: Number(serverCounts.read) || 0,
            failed: Number(serverCounts.failed) || 0
          }
        : computedCounts;

      const nextSnapshot = new Map<string, MessageSnapshotEntry>();
      const changedMessages: PeerMessageRecord[] = [];
      for (const msg of normalized) {
        nextSnapshot.set(msg.id, {
          state: msg.state,
          deliveredAt: msg.deliveredAt,
          readAt: msg.readAt
        });
        if (detectPulse && hasInitialPeerLoadRef.current) {
          const prev = prevMessageSnapshotsRef.current.get(msg.id);
          if (
            !prev
            || prev.state !== msg.state
            || prev.deliveredAt !== msg.deliveredAt
            || prev.readAt !== msg.readAt
          ) {
            changedMessages.push(msg);
          }
        }
      }

      prevMessageSnapshotsRef.current = nextSnapshot;
      hasInitialPeerLoadRef.current = true;

      setRawMessages(normalized);
      setPeerCounts(resolvedCounts);
      setPeerError('');

      if (changedMessages.length > 0) {
        const keysToPulse = new Set<string>();
        const stubs = sessionStubsRef.current;
        for (const msg of changedMessages) {
          for (const key of resolveEvidencedSessionKeysForMessage(msg, stubs)) {
            keysToPulse.add(key);
          }
        }
        if (keysToPulse.size > 0) {
          triggerSessionPulses([...keysToPulse]);
        }
      }
    } catch (error: unknown) {
      if (!mountedRef.current || activeServerRef.current !== requestServerId || peerGenerationRef.current !== requestGeneration) {
        return;
      }
      setPeerError(extractRequestErrorMessage(error, '读取 Peer 收件箱失败'));
    } finally {
      if (mountedRef.current && activeServerRef.current === requestServerId && peerGenerationRef.current === requestGeneration) {
        setPeerLoading(false);
      }
    }
  }, [manager.serverId, triggerSessionPulses]);

  const refreshPeerMessages = useCallback(async () => {
    await loadPeerMessages(true);
  }, [loadPeerMessages]);

  // Initial load & server switch reset
  useEffect(() => {
    peerGenerationRef.current += 1;
    hasInitialPeerLoadRef.current = false;
    prevMessageSnapshotsRef.current = new Map();
    pulseExpiryRef.current.clear();
    clearPulseTimer();
    setRecentPulseSessionKeys(new Set());
    setRawMessages([]);
    setPeerCounts(EMPTY_COUNTS);
    setPeerError('');
    void loadPeerMessages(false);
  }, [clearPulseTimer, loadPeerMessages, manager.serverId]);

  // Live SSE watch for peer directory mutations with debounced reload and clean close()
  useEffect(() => {
    const source = watchPeerMessages();
    const scheduleReload = () => {
      if (watchDebounceTimerRef.current !== null) {
        clearTimeout(watchDebounceTimerRef.current);
      }
      watchDebounceTimerRef.current = setTimeout(() => {
        watchDebounceTimerRef.current = null;
        if (mountedRef.current) {
          void loadPeerMessages(true);
        }
      }, WATCH_DEBOUNCE_MS);
    };

    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(String(event?.data || '{}')) as { type?: string };
        if (parsed.type === 'ready' || parsed.type === 'peer-unavailable') return;
      } catch {
        // Non-JSON or malformed frame still triggers safe debounced refresh.
      }
      scheduleReload();
    };

    return () => {
      source.close();
      if (watchDebounceTimerRef.current !== null) {
        clearTimeout(watchDebounceTimerRef.current);
        watchDebounceTimerRef.current = null;
      }
    };
  }, [loadPeerMessages, manager.serverId]);

  // Bounded session preview fetching (cached by serverId:provider:nativeSessionId:cwd, <= 32 per batch)
  const inFlightPreviewKeysRef = useRef<Set<string>>(new Set());
  const previewEpochRef = useRef(0);

  useEffect(() => {
    inFlightPreviewKeysRef.current.clear();
    previewEpochRef.current += 1;
  }, [manager.serverId]);

  const previewTargets = useMemo<PreviewTarget[]>(() => {
    const targetsByKey = new Map<string, PreviewTarget>();
    const dirByKey = new Map<string, TerminalDirectorySession>();
    for (const dir of directory.sessions) {
      dirByKey.set(dir.sessionKey, dir);
    }

    const consider = (
      sessionKey: string,
      providerRaw: string | undefined,
      nativeSessionIdRaw: string | undefined,
      cwdRaw: string | undefined,
      isRunning: boolean
    ) => {
      if (!sessionKey || hiddenSessionKeys.has(sessionKey)) return;
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
        isRunning
      });
    };

    for (const dir of directory.sessions) {
      consider(
        dir.sessionKey,
        dir.provider,
        dir.nativeSessionId,
        dir.cwd,
        dir.status === 'running'
      );
    }
    for (const tab of manager.tabs) {
      const dir = dirByKey.get(tab.sessionKey);
      consider(
        tab.sessionKey,
        dir?.provider || tab.harness,
        dir?.nativeSessionId || tab.nativeSessionId,
        dir?.cwd ?? tab.cwd,
        dir ? dir.status === 'running' : true
      );
    }
    for (const tab of manager.unavailableTabs) {
      const dir = dirByKey.get(tab.sessionKey);
      consider(
        tab.sessionKey,
        dir?.provider || tab.harness,
        dir?.nativeSessionId || tab.nativeSessionId,
        dir?.cwd ?? tab.cwd,
        false
      );
    }

    const allTargets = [...targetsByKey.values()];
    allTargets.sort((a, b) => Number(b.isRunning) - Number(a.isRunning));
    return allTargets;
  }, [directory.sessions, hiddenSessionKeys, manager.serverId, manager.tabs, manager.unavailableTabs]);

  useEffect(() => {
    const missing = previewTargets.filter(
      (item) => !previewCache.has(item.cacheKey) && !inFlightPreviewKeysRef.current.has(item.cacheKey)
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
              id: item.nativeSessionId
            }))
          );
          for (const item of chunk) {
            const matched = results.find(
              (res) => res.id === item.nativeSessionId
                && (!res.provider || String(res.provider).toLowerCase() === item.provider.toLowerCase())
            );
            entries.set(item.cacheKey, {
              model: matched?.model?.trim() || undefined,
              preview: matched?.preview?.trim() || undefined
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
      directorySessions: directory.sessions,
      interactiveTabs: manager.tabs,
      unavailableTabs: manager.unavailableTabs,
      hiddenSessionKeys,
      rawMessages,
      previewsByCacheKey: previewCache,
      recentPulseSessionKeys,
      query,
      providerFilter
    }),
    [
      directory.sessions,
      hiddenSessionKeys,
      manager.serverId,
      manager.tabs,
      manager.unavailableTabs,
      previewCache,
      providerFilter,
      query,
      rawMessages,
      recentPulseSessionKeys
    ]
  );

  const refreshDirectory = useCallback(async () => {
    await directory.refresh();
  }, [directory.refresh]);

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
    await Promise.all([directory.refresh(), loadPeerMessages(true)]);
  }, [directory.refresh, loadPeerMessages, manager.serverId]);

  const openNewProjectTerminal = useCallback(async (cwd?: string) => {
    await openProjectTerminal(cwd);
  }, [openProjectTerminal]);

  const hideSession = useCallback((sessionId: string) => {
    const tab = manager.tabs.find((item) => item.id === sessionId || item.sessionKey === sessionId);
    const unavailableTab = manager.unavailableTabs.find(
      (item) => item.id === sessionId || item.sessionKey === sessionId
    );
    const dirSession = directory.sessions.find(
      (item) => `web-terminal:${item.sessionKey}` === sessionId || item.sessionKey === sessionId
    );
    const targetSessionKey = tab?.sessionKey || unavailableTab?.sessionKey || dirSession?.sessionKey;
    if (!targetSessionKey) return;

    setHiddenState((current) => {
      const existing = current.serverId === manager.serverId ? current.keys : readHiddenKeys(manager.serverId);
      const nextKeys = [...new Set([...existing, targetSessionKey])];
      try {
        window.localStorage.setItem(
          `${HIDDEN_STORAGE_PREFIX}${manager.serverId}`,
          JSON.stringify(nextKeys)
        );
      } catch {
        // Keep session management usable even when localStorage is blocked.
      }
      return { serverId: manager.serverId, keys: nextKeys };
    });

    if (tab) {
      manager.closeTab(tab.id);
    }
  }, [directory.sessions, manager]);

  const restoreHiddenSessions = useCallback(() => {
    setHiddenState({ serverId: manager.serverId, keys: [] });
    try {
      window.localStorage.removeItem(`${HIDDEN_STORAGE_PREFIX}${manager.serverId}`);
    } catch {
      // Ignore storage cleanup errors.
    }
  }, [manager.serverId]);

  const copySessionIdentity = useCallback(async (
    session: Pick<OfficeSessionItem, 'label' | 'sessionKey' | 'nativeSessionId'>
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
    const tab = manager.tabs.find((item) => item.id === sessionId || item.sessionKey === sessionId);
    if (tab) {
      manager.setActiveTab(tab.id);
    }
  }, [manager.setActiveTab, manager.tabs]);

  return {
    serverId: manager.serverId,
    rooms: workspace.rooms,
    filteredRooms: workspace.filteredRooms,
    allSessions: workspace.allSessions,
    unavailableSessions: workspace.unavailableSessions,
    hiddenCount: hiddenKeysList.length,
    providerOptions: workspace.providerOptions,
    query,
    setQuery,
    providerFilter,
    setProviderFilter,
    directoryLoading: directory.loading,
    directoryError: directory.error,
    peerMessages: workspace.peerMessages,
    unassignedMessages: workspace.unassignedMessages,
    fullyUnassignedCount: workspace.fullyUnassignedCount,
    peerCounts,
    peerLoading,
    peerError,
    recentPulseSessionKeys,
    refreshAll,
    refreshDirectory,
    refreshPeerMessages,
    openNewProjectTerminal,
    hideSession,
    restoreHiddenSessions,
    copySessionIdentity,
    activateManagerSession
  };
}
