import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from 'react';
import { useCallback, useEffect, useRef } from 'react';
import { message } from 'antd';
import { sessionsAPI } from '@/services/api';
import {
  CHAT_PROJECT_LIST_LOAD_MESSAGE_KEY,
  clearLoadFailureMessage,
  showLoadFailureMessage,
} from '@/services/load-failure-message.js';
import type { AggregatedProject } from '@/types';
import { readCachedProjects } from './chat-cache';
import type { PersistedChatSelection } from './runtime-types';

type ProjectWatch = ReturnType<typeof sessionsAPI.watchProjects>;
type ApplyProjectSnapshot = (
  projects: AggregatedProject[],
  selection?: PersistedChatSelection,
  skipHydration?: boolean,
) => AggregatedProject[];

interface ProjectCatalogTransportOptions {
  readonly activeRef: MutableRefObject<boolean>;
  readonly initialSelection: PersistedChatSelection;
  readonly applyProjectSnapshot: ApplyProjectSnapshot;
  readonly setLoadingProjects: Dispatch<SetStateAction<boolean>>;
  readonly setPassiveRunningSessionKeys: Dispatch<SetStateAction<Set<string>>>;
}

export interface ProjectCatalogTransport {
  readonly loadProjects: (selection?: PersistedChatSelection) => Promise<void>;
  readonly pauseProjectWatch: () => void;
  readonly resumeProjectWatch: () => void;
}

export function useProjectCatalogTransport({
  activeRef,
  initialSelection,
  applyProjectSnapshot,
  setLoadingProjects,
  setPassiveRunningSessionKeys,
}: ProjectCatalogTransportOptions): ProjectCatalogTransport {
  const pendingSelectionRef = useRef<PersistedChatSelection>(initialSelection);
  const snapshotReceivedAtRef = useRef(0);
  const httpRequestRef = useRef(0);
  const refreshFallbackTimerRef = useRef<number | null>(null);
  const watchRef = useRef<ProjectWatch | null>(null);
  const watchReconnectTimerRef = useRef<number | null>(null);
  const loadProjectsRef = useRef<ProjectCatalogTransport['loadProjects']>(async () => {});
  const resumeWatchRef = useRef<ProjectCatalogTransport['resumeProjectWatch']>(() => {});

  const clearRefreshFallbackTimer = useCallback((): void => {
    if (refreshFallbackTimerRef.current === null) return;
    window.clearTimeout(refreshFallbackTimerRef.current);
    refreshFallbackTimerRef.current = null;
  }, []);
  const loadProjectsFromHttp = useCallback(async (
    selection: PersistedChatSelection = {},
  ): Promise<void> => {
    const requestId = ++httpRequestRef.current;
    const snapshotReceivedAt = snapshotReceivedAtRef.current;
    setLoadingProjects(true);
    try {
      const projects = await sessionsAPI.getAllProjects();
      if (requestId !== httpRequestRef.current
        || snapshotReceivedAt !== snapshotReceivedAtRef.current) return;
      snapshotReceivedAtRef.current = Date.now();
      clearLoadFailureMessage(message, CHAT_PROJECT_LIST_LOAD_MESSAGE_KEY);
      applyProjectSnapshot(projects, selection);
    } catch (_error) {
      if (requestId === httpRequestRef.current
        && snapshotReceivedAt === snapshotReceivedAtRef.current) {
        showLoadFailureMessage(message, CHAT_PROJECT_LIST_LOAD_MESSAGE_KEY, '加载项目失败');
      }
    } finally {
      if (requestId === httpRequestRef.current) {
        setLoadingProjects(false);
        clearRefreshFallbackTimer();
      }
    }
  }, [applyProjectSnapshot, clearRefreshFallbackTimer, setLoadingProjects]);
  const loadProjects = useCallback(async (
    selection: PersistedChatSelection = {},
  ): Promise<void> => {
    pendingSelectionRef.current = selection;
    clearRefreshFallbackTimer();
    if (watchRef.current && snapshotReceivedAtRef.current > 0) {
      const previousSnapshotAt = snapshotReceivedAtRef.current;
      setLoadingProjects(true);
      try {
        await sessionsAPI.requestProjectsSnapshot();
        refreshFallbackTimerRef.current = window.setTimeout(() => {
          if (snapshotReceivedAtRef.current <= previousSnapshotAt) {
            void loadProjectsFromHttp(selection);
          }
        }, 2000);
        return;
      } catch (_error) {}
    }
    await loadProjectsFromHttp(selection);
  }, [clearRefreshFallbackTimer, loadProjectsFromHttp, setLoadingProjects]);
  loadProjectsRef.current = loadProjects;

  const pauseProjectWatch = useCallback((): void => {
    if (watchReconnectTimerRef.current !== null) {
      window.clearTimeout(watchReconnectTimerRef.current);
      watchReconnectTimerRef.current = null;
    }
    clearRefreshFallbackTimer();
    const watch = watchRef.current;
    watchRef.current = null;
    watch?.close();
  }, [clearRefreshFallbackTimer]);
  const resumeProjectWatch = useCallback((): void => {
    if (typeof window === 'undefined') return;
    pauseProjectWatch();
    const watch = sessionsAPI.watchProjects({
      onSnapshot: ({ projects }) => {
        if (!activeRef.current || watchRef.current !== watch) return;
        snapshotReceivedAtRef.current = Date.now();
        clearLoadFailureMessage(message, CHAT_PROJECT_LIST_LOAD_MESSAGE_KEY);
        setLoadingProjects(false);
        clearRefreshFallbackTimer();
        const selection = pendingSelectionRef.current;
        pendingSelectionRef.current = {};
        applyProjectSnapshot(projects, selection);
      },
      onRuntime: (runningSessionKeys) => {
        if (activeRef.current && watchRef.current === watch) {
          setPassiveRunningSessionKeys(runningSessionKeys);
        }
      },
      onConnected: () => {
        if (!activeRef.current || watchRef.current !== watch) return;
        if (snapshotReceivedAtRef.current === 0) setLoadingProjects(true);
      },
      onError: () => {
        if (!activeRef.current || watchRef.current !== watch) {
          watch.close();
          return;
        }
        watch.close();
        if (watchRef.current === watch) watchRef.current = null;
        if (watchReconnectTimerRef.current !== null) {
          window.clearTimeout(watchReconnectTimerRef.current);
        }
        watchReconnectTimerRef.current = window.setTimeout(() => {
          watchReconnectTimerRef.current = null;
          if (document.visibilityState !== 'hidden') resumeWatchRef.current();
        }, 1500);
        if (snapshotReceivedAtRef.current === 0) {
          void loadProjectsRef.current(pendingSelectionRef.current);
        }
      },
    });
    watchRef.current = watch;
  }, [
    activeRef,
    applyProjectSnapshot,
    clearRefreshFallbackTimer,
    pauseProjectWatch,
    setLoadingProjects,
    setPassiveRunningSessionKeys,
  ]);
  resumeWatchRef.current = resumeProjectWatch;

  useEffect(() => {
    activeRef.current = true;
    pendingSelectionRef.current = initialSelection;
    const cachedProjects = readCachedProjects();
    if (cachedProjects.length > 0) {
      applyProjectSnapshot(cachedProjects, initialSelection);
      setLoadingProjects(false);
    } else {
      setLoadingProjects(true);
    }
    resumeProjectWatch();
    refreshFallbackTimerRef.current = window.setTimeout(() => {
      if (snapshotReceivedAtRef.current === 0) {
        void loadProjectsFromHttp(initialSelection);
      }
    }, cachedProjects.length > 0 ? 800 : 2500);
    return () => {
      activeRef.current = false;
      httpRequestRef.current += 1;
      pauseProjectWatch();
    };
  }, [
    activeRef,
    applyProjectSnapshot,
    initialSelection,
    loadProjectsFromHttp,
    pauseProjectWatch,
    resumeProjectWatch,
    setLoadingProjects,
  ]);

  return { loadProjects, pauseProjectWatch, resumeProjectWatch };
}
