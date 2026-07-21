import type { MutableRefObject } from 'react';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  getSessionRunKey,
} from '@/components/chat/active-run-state.js';
import type { InteractivePrompt, Session } from '@/types';
import type { ActiveSessionRun } from './runtime-types';
import { legacyActiveRunStore } from './legacy-active-run-store.js';

interface LegacyActiveRunOptions {
  readonly selectedSession: Session;
  readonly selectedSessionRef: MutableRefObject<Session | null>;
  readonly onRunningSessionKeysChange: (keys: Set<string>) => void;
}

export interface LegacyActiveRuns {
  readonly activeRunsRef: MutableRefObject<Map<string, ActiveSessionRun>>;
  readonly runningSessionKeys: Set<string>;
  readonly selectedRunKey: string;
  readonly selectedPrompt: InteractivePrompt | null;
  readonly selectedStatusText?: string;
  readonly loading: boolean;
  readonly find: (session: Session | null) => string;
  readonly register: (run: ActiveSessionRun) => void;
  readonly rename: (
    previousRunKey: string,
    nextRunKey: string,
    patch?: Partial<ActiveSessionRun>,
  ) => string;
  readonly update: (runKey: string, patch: Partial<ActiveSessionRun>) => void;
  readonly unregister: (runKey: string) => void;
  readonly updateStatus: (runKey: string, statusText: string) => void;
  readonly setPrompt: (runKey: string, prompt: InteractivePrompt) => void;
  readonly restorePrompt: (runKey: string, prompt: InteractivePrompt) => void;
  readonly clearPrompt: (runKey: string, promptId?: string) => void;
  readonly promptForKey: (runKey: string) => InteractivePrompt | null;
}

export function useLegacyActiveRuns({
  selectedSession,
  selectedSessionRef,
  onRunningSessionKeysChange,
}: LegacyActiveRunOptions): LegacyActiveRuns {
  const snapshot = useSyncExternalStore(
    legacyActiveRunStore.subscribe,
    legacyActiveRunStore.getSnapshot,
    legacyActiveRunStore.getSnapshot,
  );
  const activeRunsRef = legacyActiveRunStore.activeRunsRef;
  const find = useCallback(legacyActiveRunStore.find, []);

  useEffect(() => {
    onRunningSessionKeysChange(snapshot.runningSessionKeys);
  }, [onRunningSessionKeysChange, snapshot.runningSessionKeys]);
  useEffect(() => () => onRunningSessionKeysChange(new Set()), [onRunningSessionKeysChange]);

  const selectedRunKey = find(selectedSession);
  const stableKey = selectedSession.draft ? '' : getSessionRunKey(selectedSession);
  const selectedPrompt = (selectedRunKey && snapshot.promptsByKey[selectedRunKey])
    || (stableKey && snapshot.promptsByKey[stableKey])
    || null;

  return {
    activeRunsRef,
    runningSessionKeys: snapshot.runningSessionKeys,
    selectedRunKey,
    selectedPrompt,
    selectedStatusText: selectedRunKey ? snapshot.statusByKey[selectedRunKey] : undefined,
    loading: Boolean(find(selectedSessionRef.current)),
    find,
    register: legacyActiveRunStore.register,
    rename: legacyActiveRunStore.rename,
    update: legacyActiveRunStore.update,
    unregister: legacyActiveRunStore.unregister,
    updateStatus: legacyActiveRunStore.updateStatus,
    setPrompt: legacyActiveRunStore.setPrompt,
    restorePrompt: legacyActiveRunStore.restorePrompt,
    clearPrompt: legacyActiveRunStore.clearPrompt,
    promptForKey: legacyActiveRunStore.promptForKey,
  };
}
