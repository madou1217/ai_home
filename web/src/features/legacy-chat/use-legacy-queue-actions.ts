import { useCallback } from 'react';
import { message } from 'antd';
import type { Account, Session } from '@/types';
import { chatAPI } from '@/services/api';
import { resolveQueuedAccount } from './account-selection-policy';
import { humanizeChatError } from './chat-error-policy';
import {
  resolveDetachedRunId,
  toRunInput,
} from './legacy-runtime-policy';
import type { LegacyComposerActions } from './use-legacy-composer-actions';
import type { LegacySessionRuntime } from './use-legacy-session-orchestration';

interface LegacyQueueActionOptions {
  readonly session: Session;
  readonly accounts: Account[];
  readonly runtime: LegacyQueueRuntime;
  readonly composer: Pick<
    LegacyComposerActions,
    'replaceDraft' | 'suppressNextAbortToast'
  >;
}

interface LegacyQueueRuntime {
  readonly detachedRunRef: LegacySessionRuntime['detachedRunRef'];
  readonly history: Pick<
    LegacySessionRuntime['history'],
    'appendVisibleMessage' | 'dropPendingAssistantPlaceholder'
  >;
  readonly queue: Pick<
    LegacySessionRuntime['queue'],
    'prepend' | 'prioritize' | 'remove' | 'selectedKey' | 'selectedMessages'
  >;
  readonly runSessionMessage: LegacySessionRuntime['runSessionMessage'];
  readonly runs: Pick<LegacySessionRuntime['runs'], 'activeRunsRef' | 'find'>;
}

export interface LegacyQueueActions {
  readonly edit: (messageId: string) => void;
  readonly remove: (messageId: string) => void;
  readonly sendNow: (messageId: string) => void;
  readonly steer: (messageId: string) => Promise<void>;
}

export function useLegacyQueueActions({
  session,
  accounts,
  runtime,
  composer,
}: LegacyQueueActionOptions): LegacyQueueActions {
  const { detachedRunRef, history, queue, runSessionMessage, runs } = runtime;
  const findRun = runs.find;
  const activeRunsRef = runs.activeRunsRef;
  const selectedKey = queue.selectedKey;
  const selectedMessages = queue.selectedMessages;
  const prependMessage = queue.prepend;
  const prioritizeMessage = queue.prioritize;
  const removeMessage = queue.remove;
  const appendVisibleMessage = history.appendVisibleMessage;
  const dropPendingAssistantPlaceholder = history.dropPendingAssistantPlaceholder;
  const replaceDraft = composer.replaceDraft;
  const suppressNextAbortToast = composer.suppressNextAbortToast;

  const edit = useCallback((messageId: string): void => {
    if (!selectedKey) return;
    const queued = selectedMessages.find((item) => item.id === messageId);
    if (!queued) return;
    replaceDraft(
      queued.content,
      Array.isArray(queued.images) ? queued.images : [],
    );
    removeMessage(selectedKey, messageId);
  }, [removeMessage, replaceDraft, selectedKey, selectedMessages]);

  const remove = useCallback((messageId: string): void => {
    if (selectedKey) removeMessage(selectedKey, messageId);
  }, [removeMessage, selectedKey]);

  const sendNow = useCallback((messageId: string): void => {
    if (!selectedKey) return;
    const queued = selectedMessages.find((item) => item.id === messageId);
    if (!queued) return;
    const currentRunKey = findRun(session);
    if (currentRunKey) {
      prioritizeMessage(selectedKey, messageId);
      const currentRun = activeRunsRef.current.get(currentRunKey);
      if (!currentRun) return;
      suppressNextAbortToast();
      currentRun.controller.abort();
      dropPendingAssistantPlaceholder();
      message.success('已切换为立即介入，这条需求会在当前轮停止后优先发送');
      return;
    }
    const account = resolveQueuedAccount(queued, accounts);
    if (!account) {
      message.error('找不到对应账号，无法立即发送这条队列消息');
      return;
    }
    removeMessage(selectedKey, messageId);
    runSessionMessage(toRunInput(session, account, queued)).catch((error) => {
      prependMessage(selectedKey, queued);
      message.error(humanizeChatError(error, '立即发送失败'));
    });
  }, [
    accounts,
    activeRunsRef,
    dropPendingAssistantPlaceholder,
    findRun,
    prependMessage,
    prioritizeMessage,
    removeMessage,
    runSessionMessage,
    selectedKey,
    selectedMessages,
    session,
    suppressNextAbortToast,
  ]);

  const steer = useCallback(async (messageId: string): Promise<void> => {
    if (!selectedKey) return;
    const queued = selectedMessages.find((item) => item.id === messageId);
    if (!queued) return;
    const currentRunKey = findRun(session);
    const activeRun = currentRunKey ? activeRunsRef.current.get(currentRunKey) : null;
    const runId = activeRun?.runId || resolveDetachedRunId(session, detachedRunRef.current);
    if (!runId) {
      message.warning('当前没有可插话的运行');
      return;
    }
    removeMessage(selectedKey, messageId);
    try {
      await chatAPI.steerRun(runId, queued.content);
      appendVisibleMessage({
        role: 'user',
        content: queued.content,
        timestamp: Date.now(),
      });
      message.success('已插话,将在当前动作后处理');
    } catch (error) {
      prependMessage(selectedKey, queued);
      message.error(humanizeChatError(error, '插话失败(该运行可能不支持)'));
    }
  }, [
    activeRunsRef,
    appendVisibleMessage,
    detachedRunRef,
    findRun,
    prependMessage,
    removeMessage,
    selectedKey,
    selectedMessages,
    session,
  ]);

  return { edit, remove, sendNow, steer };
}
