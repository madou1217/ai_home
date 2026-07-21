import type { MutableRefObject } from 'react';
import { useCallback, useRef } from 'react';
import { getSessionRunKey } from '@/components/chat/active-run-state.js';
import { supportsToolBoundaryQueue } from '@/components/chat/provider-capabilities.js';
import { formatRetryStatusText } from '@/components/chat/provider-pending-policy.js';
import type { RetryStatus } from '@/components/chat/provider-pending-policy.js';
import { chatAPI } from '@/services/api';
import type { InteractivePrompt, Session } from '@/types';
import { resolveQueuedAccount } from './account-selection-policy';
import type {
  LegacyChatCatalogPort,
  LegacyChatSelectionPort,
} from './legacy-runtime-ports';
import type {
  DetachedRunBinding,
  LegacyApprovalMode,
} from './runtime-types';
import { useDetachedRunRecovery } from './use-detached-run-recovery';
import {
  useLegacyActiveRuns,
  type LegacyActiveRuns,
} from './use-legacy-active-runs';
import { useLegacyBackgroundRunWatch } from './use-legacy-background-run-watch';
import {
  useLegacyMessageQueue,
  type LegacyMessageQueue,
} from './use-legacy-message-queue';
import {
  useLegacyMessageRunner,
  type LegacyRunMessageInput,
} from './use-legacy-message-runner';
import {
  useLegacySessionHistory,
  type LegacySessionHistoryController,
  type LegacySessionWatchDisposition,
  type LegacySessionWatchPayload,
} from './use-legacy-session-history';
import {
  useLegacyTerminalBridge,
  type LegacyTerminalBridge,
} from './use-legacy-terminal-bridge';

interface LegacySessionOrchestrationOptions {
  readonly selection: Pick<
    LegacyChatSelectionPort,
    | 'approvalMode'
    | 'changeProject'
    | 'changeSession'
    | 'project'
    | 'session'
    | 'sessionRef'
  >;
  readonly catalog: Omit<LegacyChatCatalogPort, 'projects'>;
  readonly onRunningSessionKeysChange: (keys: Set<string>) => void;
}

export interface LegacySessionRuntime {
  readonly detachedRunRef: MutableRefObject<DetachedRunBinding | null>;
  readonly runs: LegacyActiveRuns;
  readonly queue: LegacyMessageQueue;
  readonly history: LegacySessionHistoryController;
  readonly terminal: LegacyTerminalBridge;
  readonly runSessionMessage: (input: LegacyRunMessageInput) => Promise<void>;
}

export function useLegacySessionOrchestration({
  selection,
  catalog,
  onRunningSessionKeysChange,
}: LegacySessionOrchestrationOptions): LegacySessionRuntime {
  const detachedRunRef = useRef<DetachedRunBinding | null>(null);
  const approvalModeRef = useRef<LegacyApprovalMode>(selection.approvalMode);
  const runSessionMessageRef = useRef<LegacySessionRuntime['runSessionMessage'] | null>(null);
  approvalModeRef.current = selection.approvalMode;

  const terminal = useLegacyTerminalBridge();
  const runs = useLegacyActiveRuns({
    selectedSession: selection.session,
    selectedSessionRef: selection.sessionRef,
    onRunningSessionKeysChange,
  });
  const queue = useLegacyMessageQueue(selection.session, runs.selectedRunKey);
  const findRun = runs.find;
  const activeRunsRef = runs.activeRunsRef;
  const setRunPrompt = runs.setPrompt;
  const clearRunPrompt = runs.clearPrompt;
  const updateRunStatus = runs.updateStatus;
  const enqueueMessage = queue.enqueue;
  const shiftMessage = queue.shift;
  const shiftToolMessage = queue.shiftByMode;

  const flushQueuedToolCallMessage = useCallback((session: Session): void => {
    const runKey = findRun(session);
    if (!runKey) return;
    const activeRun = activeRunsRef.current.get(runKey);
    if (!activeRun?.runId) return;
    const queued = shiftToolMessage(runKey, 'after_tool_call');
    if (!queued) return;
    chatAPI.sendRunInput(activeRun.runId, queued.content, true).catch(() => {
      enqueueMessage(runKey, queued);
    });
  }, [activeRunsRef, enqueueMessage, findRun, shiftToolMessage]);

  useLegacyBackgroundRunWatch({
    activeRunsRef,
    runningSessionKeys: runs.runningSessionKeys,
    selectedSession: selection.session,
    selectedSessionRef: selection.sessionRef,
    onToolCallBoundary: flushQueuedToolCallMessage,
  });

  const handleWatchEvent = useCallback((
    session: Session,
    payload: LegacySessionWatchPayload,
  ): LegacySessionWatchDisposition => {
    const stableKey = getSessionRunKey(session);
    const eventType = String(payload.eventType || '');
    const prompt = payload.prompt as InteractivePrompt | undefined;
    const runId = String(payload.runId || '');

    if (eventType === 'session:approval-request' && prompt && stableKey) {
      if (runId) detachedRunRef.current = { sessionKey: stableKey, runId };
      setRunPrompt(stableKey, prompt);
      return { handled: true };
    }
    if (eventType === 'session:approval-resolved' && stableKey) {
      clearRunPrompt(stableKey, String(payload.promptId || ''));
      return { handled: true };
    }
    if (eventType === 'session:retry-status' && payload.retryStatus) {
      const retryStatus = payload.retryStatus as RetryStatus;
      const retryStatusText = formatRetryStatusText(retryStatus, session.provider);
      const activeRunKey = findRun(session);
      if (activeRunKey) updateRunStatus(activeRunKey, retryStatusText);
      return {
        handled: true,
        pendingRetry: retryStatus,
      };
    }
    if (findRun(session)) return { handled: true };
    if (runId && stableKey) detachedRunRef.current = { sessionKey: stableKey, runId };
    if (eventType === 'session:interactive-prompt' && prompt && stableKey) {
      setRunPrompt(stableKey, prompt);
      return { handled: true, pendingStatus: '等待你的选择…' };
    }
    if (eventType === 'session:interactive-prompt-cleared' && stableKey) {
      clearRunPrompt(stableKey);
      return { handled: true };
    }
    if (eventType === 'session:turn-failed') {
      return {
        handled: true,
        failureText: `${session.provider === 'claude' ? 'Claude' : '模型'} 重试结束，未能完成本次回复`,
      };
    }
    return { handled: false };
  }, [clearRunPrompt, findRun, setRunPrompt, updateRunStatus]);

  const handleWatchSettled = useCallback((session: Session): void => {
    const stableKey = getSessionRunKey(session);
    if (detachedRunRef.current?.sessionKey === stableKey) detachedRunRef.current = null;
    if (!stableKey) return;
    clearRunPrompt(stableKey);
    const queued = shiftMessage(stableKey);
    if (!queued || session.draft) return;
    window.setTimeout(() => {
      const account = resolveQueuedAccount(queued, catalog.accountsRef.current);
      if (!account) return;
      runSessionMessageRef.current?.({
        session,
        account,
        model: queued.model,
        content: queued.content,
        imageList: Array.isArray(queued.images) ? queued.images : [],
      })?.catch(() => {});
    }, 0);
  }, [catalog.accountsRef, clearRunPrompt, shiftMessage]);

  const handleHistoryHydrated = useCallback((session: Session): void => {
    catalog.selectAccountForProvider(session.provider);
    const ownerProject = catalog.findProjectByPath(session.projectPath);
    if (ownerProject) selection.changeProject(ownerProject);
  }, [catalog.findProjectByPath, catalog.selectAccountForProvider, selection.changeProject]);
  const isSessionRunning = useCallback(
    (session: Session): boolean => Boolean(findRun(session)),
    [findRun],
  );
  const handleHistoryToolCallBoundary = useCallback((session: Session): void => {
    if (supportsToolBoundaryQueue(session.provider, false)) flushQueuedToolCallMessage(session);
  }, [flushQueuedToolCallMessage]);
  const refreshProjectCatalog = useCallback(
    () => catalog.refreshProjects({}),
    [catalog.refreshProjects],
  );
  const history = useLegacySessionHistory({
    enabled: true,
    selectedSession: selection.session,
    selectedSessionRef: selection.sessionRef,
    isSessionRunning,
    onToolCallBoundary: handleHistoryToolCallBoundary,
    onWatchEvent: handleWatchEvent,
    onWatchSettled: handleWatchSettled,
    onHistoryHydrated: handleHistoryHydrated,
    pauseProjectWatch: catalog.pauseProjectWatch,
    resumeProjectWatch: catalog.resumeProjectWatch,
    refreshProjects: refreshProjectCatalog,
  });
  const runSessionMessage = useLegacyMessageRunner({
    accounts: catalog.accounts,
    selectedProjectPath: selection.project?.path,
    selectedSessionRef: selection.sessionRef,
    approvalModeRef,
    runs,
    history,
    queue,
    terminal,
    onSessionChange: selection.changeSession,
    refreshProjects: catalog.refreshProjects,
  });
  runSessionMessageRef.current = runSessionMessage;

  useDetachedRunRecovery({
    session: selection.session,
    sessionRef: selection.sessionRef,
    detachedRunRef,
    findRun,
    setRunPrompt,
    markWatchPending: history.markWatchPending,
  });

  return { detachedRunRef, runs, queue, history, terminal, runSessionMessage };
}
