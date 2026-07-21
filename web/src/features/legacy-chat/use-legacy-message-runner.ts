import type { MutableRefObject } from 'react';
import { useCallback } from 'react';
import { chatAPI } from '@/services/api';
import {
  getActualSessionRunKey,
  getSessionRunKey,
} from '@/components/chat/active-run-state.js';
import { rememberSessionModel } from '@/components/chat/account-model-selection.js';
import { isAihServerAccount } from '@/components/chat/aih-server-account';
import { applyStreamingAssistantEvent } from '@/components/chat/assistant-event-adapter.js';
import {
  getGeneratingStatusText,
  getProcessingStatusText,
  getThinkingStatusText,
  formatRetryStatusText,
} from '@/components/chat/provider-pending-policy.js';
import type {
  Account,
  ChatMessage,
  ChatStreamEvent,
  Session,
} from '@/types';
import { resolveQueuedAccount } from './account-selection-policy';
import { resolveSessionProjectDirName } from './project-selection-policy';
import type { LegacyActiveRuns } from './use-legacy-active-runs';
import type { LegacySessionHistoryController } from './use-legacy-session-history';
import type { LegacyMessageQueue } from './use-legacy-message-queue';
import type { LegacyTerminalBridge } from './use-legacy-terminal-bridge';
import type {
  LegacyApprovalMode,
  LegacyRunMessageInput,
  PersistedChatSelection,
} from './runtime-types';
import {
  buildInitialRunMessages,
  buildStatelessRequestMessages,
  finalizePendingAssistantFailure,
  isSameVisibleSession,
  removePendingAssistant,
  usesNativeSession,
} from './legacy-run-message-policy';
import { humanizeChatError } from './chat-error-policy';
import { useAssistantCompletionNotification } from './use-assistant-completion-notification';

export type { LegacyRunMessageInput } from './runtime-types';

interface LegacyMessageRunnerOptions {
  readonly accounts: Account[];
  readonly selectedProjectPath?: string;
  readonly selectedSessionRef: MutableRefObject<Session | null>;
  readonly approvalModeRef: MutableRefObject<LegacyApprovalMode>;
  readonly runs: LegacyActiveRuns;
  readonly history: LegacySessionHistoryController;
  readonly queue: LegacyMessageQueue;
  readonly terminal: LegacyTerminalBridge;
  readonly onSessionChange: (session: Session) => void;
  readonly refreshProjects: (selection?: PersistedChatSelection) => Promise<void>;
}

export function useLegacyMessageRunner({
  accounts,
  selectedProjectPath,
  selectedSessionRef,
  approvalModeRef,
  runs,
  history,
  queue,
  terminal,
  onSessionChange,
  refreshProjects,
}: LegacyMessageRunnerOptions): (input: LegacyRunMessageInput) => Promise<void> {
  const {
    requestPermission,
    notify,
  } = useAssistantCompletionNotification();

  const runSessionMessage = useCallback(async ({
    session: requestSession,
    account,
    model,
    content,
    imageList,
  }: LegacyRunMessageInput): Promise<void> => {
    const requestProjectPath = requestSession.projectPath || selectedProjectPath;
    const resolvedProjectDirName = resolveSessionProjectDirName(
      account.provider,
      requestProjectPath,
      requestSession.projectDirName,
    );
    if (!requestProjectPath) throw new Error('当前会话缺少项目路径');

    const requestRunKey = runs.find(requestSession) || getSessionRunKey(requestSession);
    const controller = new AbortController();
    let activeRunKey = requestRunKey;
    let usedNativeSession = false;
    let createdSessionId = '';
    const baseMessages = history.readSessionMessages(requestSession)
      || (isSameVisibleSession(selectedSessionRef.current, requestSession) ? history.messages : []);
    let latestRunMessages = buildInitialRunMessages(baseMessages, content, imageList, { model });
    const useNativeSession = usesNativeSession(account);
    const requestMessages = useNativeSession
      ? [{ role: 'user' as const, content: content.trim() }]
      : buildStatelessRequestMessages(latestRunMessages);

    const syncVisibleMessages = (): void => {
      const currentSession = selectedSessionRef.current;
      if (!currentSession) return;
      const currentRunKey = runs.find(currentSession) || getSessionRunKey(currentSession);
      if (currentRunKey !== activeRunKey && !isSameVisibleSession(currentSession, requestSession)) return;
      history.replaceVisibleMessages(latestRunMessages);
    };
    const persistRunMessages = (resolvedSession: Session): void => {
      if (!history.replaceSessionMessages(resolvedSession, latestRunMessages)) syncVisibleMessages();
    };

    let resolvedSession = requestSession;
    persistRunMessages(resolvedSession);
    runs.register({
      runKey: activeRunKey,
      draftSessionId: requestSession.draft ? requestSession.id : undefined,
      provider: requestSession.provider,
      sessionId: requestSession.draft ? undefined : requestSession.id,
      projectDirName: requestSession.projectDirName,
      projectPath: requestProjectPath,
      controller,
    });
    runs.updateStatus(activeRunKey, '已发送，正在连接...');
    requestPermission();
    terminal.clearRun(activeRunKey);
    let isTerminalRun = false;

    const applyRunMessages = (updater: (current: ChatMessage[]) => ChatMessage[]): void => {
      latestRunMessages = updater([...latestRunMessages]);
      persistRunMessages(resolvedSession);
    };
    const updateSelectedPendingStatus = (statusText: string): void => {
      runs.updateStatus(activeRunKey, statusText);
      if (isSameVisibleSession(selectedSessionRef.current, resolvedSession)) {
        history.updatePendingAssistantStatus(statusText);
      }
    };

    try {
      const adoptCreatedSession = (nextSessionId: string): void => {
        if (!nextSessionId || createdSessionId === nextSessionId) return;
        createdSessionId = nextSessionId;
        const nextRunKey = getActualSessionRunKey(
          account.provider,
          nextSessionId,
          resolvedProjectDirName,
        );
        queue.move(activeRunKey, nextRunKey);
        terminal.moveRun(activeRunKey, nextRunKey);
        activeRunKey = runs.rename(activeRunKey, nextRunKey, {
          provider: account.provider,
          sessionId: nextSessionId,
          projectDirName: resolvedProjectDirName,
          projectPath: requestProjectPath,
        });
        resolvedSession = {
          ...requestSession,
          id: nextSessionId,
          draft: false,
          provider: account.provider,
          projectPath: requestProjectPath,
          projectDirName: resolvedProjectDirName,
        };
        persistRunMessages(resolvedSession);
        if (model) rememberSessionModel(resolvedSession, model);
        updateSelectedPendingStatus(`会话已创建，${getGeneratingStatusText()}`);
        const stillOnDraft = Boolean(
          selectedSessionRef.current?.draft
          && isSameVisibleSession(selectedSessionRef.current, requestSession),
        );
        if (stillOnDraft) onSessionChange(resolvedSession);
        refreshProjects(stillOnDraft ? {
          sessionId: nextSessionId,
          projectPath: requestProjectPath,
          provider: account.provider,
          projectDirName: resolvedProjectDirName,
        } : { projectPath: requestProjectPath }).catch(() => {});
      };

      const handleStreamEvent = (event: ChatStreamEvent): void => {
        if (event.mode === 'native-session') usedNativeSession = true;
        if (event.type === 'ready' && event.runId) {
          runs.update(activeRunKey, { runId: event.runId });
          if (event.interactionMode === 'terminal') {
            isTerminalRun = true;
            terminal.startRun(activeRunKey, event.runId, String(event.slashCommand || '').trim());
            history.dropPendingAssistantPlaceholder();
            runs.updateStatus(activeRunKey, '终端运行中');
            return;
          }
          updateSelectedPendingStatus('已连接，准备处理中...');
          return;
        }
        if (event.type === 'interactive-prompt' && event.prompt?.promptId) {
          runs.setPrompt(activeRunKey, {
            ...event.prompt,
            runId: event.runId || event.prompt.runId,
          });
          updateSelectedPendingStatus('等待选择计划处理方式...');
          return;
        }
        if (event.type === 'interactive-prompt-cleared') {
          runs.clearPrompt(activeRunKey, event.promptId || undefined);
          return;
        }
        if (event.type === 'session-created' && event.sessionId) {
          adoptCreatedSession(event.sessionId);
          return;
        }
        if (event.type === 'terminal-output' && event.text) {
          terminal.writeOutput(event.runId || '', event.text);
          if (!isTerminalRun) updateSelectedPendingStatus(getProcessingStatusText());
          return;
        }
        if (event.type === 'retry-status') {
          const statusText = formatRetryStatusText(event, requestSession.provider);
          updateSelectedPendingStatus(statusText);
          return;
        }
        if (event.type === 'thinking' && event.thinking) {
          updateSelectedPendingStatus(getThinkingStatusText(requestSession.provider));
          applyRunMessages((next) => applyStreamingAssistantEvent(next, event, {
            timestamp: Date.now(),
            provider: requestSession.provider,
            model,
            thinkingStatusText: getThinkingStatusText(requestSession.provider),
          }));
          return;
        }
        if (event.type === 'delta') {
          updateSelectedPendingStatus(getGeneratingStatusText());
          applyRunMessages((next) => applyStreamingAssistantEvent(next, event, {
            timestamp: Date.now(),
            provider: requestSession.provider,
            model,
            generatingStatusText: getGeneratingStatusText(),
          }));
          return;
        }
        if (event.type === 'assistant_tool_call' || event.type === 'assistant_tool_result') {
          applyRunMessages((next) => applyStreamingAssistantEvent(next, event, {
            timestamp: Date.now(),
            provider: requestSession.provider,
            model,
          }));
          return;
        }
        if (event.type !== 'result' && event.type !== 'done') return;
        if (requestSession.draft && event.sessionId && !createdSessionId) {
          adoptCreatedSession(event.sessionId);
        }
        if (typeof event.content === 'string' && event.content) {
          applyRunMessages((next) => applyStreamingAssistantEvent(next, event, {
            timestamp: Date.now(),
            provider: requestSession.provider,
            model,
          }));
          notify(requestSession.provider, event.content);
        } else if (event.type === 'done') {
          applyRunMessages((next) => applyStreamingAssistantEvent(next, event, {
            timestamp: Date.now(),
            provider: requestSession.provider,
            model,
          }));
          notify(requestSession.provider, '');
        }
      };

      await chatAPI.sendStream({
        messages: requestMessages,
        prompt: content.trim(),
        provider: account.provider,
        ...(isAihServerAccount(account)
          ? { gateway: true as const }
          : { accountRef: account.accountRef }),
        createSession: Boolean(requestSession.draft),
        sessionId: requestSession.draft ? undefined : requestSession.id,
        projectDirName: requestSession.draft ? undefined : requestSession.projectDirName,
        projectPath: requestProjectPath,
        model: model || undefined,
        images: imageList,
        approvalMode: approvalModeRef.current,
        stream: true,
      }, { signal: controller.signal, onEvent: handleStreamEvent });

      if (requestSession.draft) {
        const stillOnDraft = Boolean(
          selectedSessionRef.current?.draft
          && isSameVisibleSession(selectedSessionRef.current, requestSession),
        );
        if (createdSessionId) {
          await refreshProjects({
            sessionId: stillOnDraft ? createdSessionId : undefined,
            projectPath: requestProjectPath,
            provider: account.provider,
            projectDirName: resolvedProjectDirName,
          });
        } else if (usedNativeSession) {
          await refreshProjects({ projectPath: requestProjectPath });
        }
      } else if (usedNativeSession) {
        await history.reloadSessionHistory(resolvedSession);
      }
    } catch (error) {
      const aborted = (error as { name?: unknown } | null | undefined)?.name === 'AbortError';
      applyRunMessages(aborted
        ? removePendingAssistant
        : (messages) => finalizePendingAssistantFailure(
          messages,
          humanizeChatError(error, '模型未能完成本次回复'),
        ));
      if (aborted && isSameVisibleSession(selectedSessionRef.current, resolvedSession)) {
        history.dropPendingAssistantPlaceholder();
      }
      throw error;
    } finally {
      runs.unregister(activeRunKey);
      terminal.settleRun(activeRunKey);
      const nextQueued = queue.shift(activeRunKey);
      if (nextQueued && !resolvedSession.draft) {
        window.setTimeout(() => {
          const accountForQueue = resolveQueuedAccount(nextQueued, accounts);
          if (!accountForQueue) return;
          runSessionMessage({
            session: resolvedSession,
            account: accountForQueue,
            model: nextQueued.model,
            content: nextQueued.content,
            imageList: Array.isArray(nextQueued.images) ? nextQueued.images : [],
          }).catch(() => {});
        }, 0);
      }
    }
  }, [
    accounts,
    approvalModeRef,
    history,
    notify,
    onSessionChange,
    queue,
    refreshProjects,
    requestPermission,
    runs,
    selectedProjectPath,
    selectedSessionRef,
    terminal,
  ]);

  return runSessionMessage;
}
