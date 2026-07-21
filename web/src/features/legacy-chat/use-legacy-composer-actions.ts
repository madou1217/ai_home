import { useCallback, useEffect, useRef, useState } from 'react';
import { message } from 'antd';
import { providerNames } from '@/components/chat/ProviderIcon';
import { chatAPI } from '@/services/api';
import type { PersistedChatSelection } from './runtime-types';
import type { LegacyChatSelectionPort } from './legacy-runtime-ports';
import {
  createQueuedMessage,
  resolveDetachedRunId,
  resolveQueueTargetKey,
} from './legacy-runtime-policy';
import { humanizeChatError } from './chat-error-policy';
import type { LegacySessionRuntime } from './use-legacy-session-orchestration';

interface LegacyComposerActionOptions {
  readonly selection: Pick<
    LegacyChatSelectionPort,
    'account' | 'model' | 'project' | 'session' | 'sessionRef'
  >;
  readonly refreshProjects: (selection?: PersistedChatSelection) => Promise<void>;
  readonly runtime: LegacyComposerRuntime;
}

interface LegacyComposerRuntime {
  readonly detachedRunRef: LegacySessionRuntime['detachedRunRef'];
  readonly history: Pick<
    LegacySessionRuntime['history'],
    'clearWatchPending' | 'dropPendingAssistantPlaceholder' | 'reloadSessionHistory'
  >;
  readonly queue: Pick<LegacySessionRuntime['queue'], 'enqueue'>;
  readonly runSessionMessage: LegacySessionRuntime['runSessionMessage'];
  readonly runs: Pick<LegacySessionRuntime['runs'], 'activeRunsRef' | 'find'>;
}

export interface LegacyComposerActions {
  readonly input: string;
  readonly images: string[];
  readonly changeInput: (value: string) => void;
  readonly changeImages: (images: string[]) => void;
  readonly replaceDraft: (content: string, images: string[]) => void;
  readonly suppressNextAbortToast: () => void;
  readonly send: () => Promise<void>;
  readonly stop: () => void;
}

export function useLegacyComposerActions({
  selection,
  refreshProjects,
  runtime,
}: LegacyComposerActionOptions): LegacyComposerActions {
  const [input, setInput] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const suppressAbortToastRef = useRef(false);
  const { detachedRunRef, history, queue, runSessionMessage, runs } = runtime;
  const findRun = runs.find;
  const activeRunsRef = runs.activeRunsRef;
  const enqueueMessage = queue.enqueue;
  const reloadSessionHistory = history.reloadSessionHistory;
  const dropPendingAssistantPlaceholder = history.dropPendingAssistantPlaceholder;
  const clearWatchPending = history.clearWatchPending;

  useEffect(() => {
    if (selection.session.draft) setInput('');
  }, [selection.session.draft, selection.session.id]);

  const replaceDraft = useCallback((content: string, nextImages: string[]): void => {
    setInput(content);
    setImages(nextImages);
  }, []);
  const suppressNextAbortToast = useCallback((): void => {
    suppressAbortToastRef.current = true;
  }, []);

  const send = useCallback(async (): Promise<void> => {
    if (!input.trim()) return void message.warning('请输入消息');
    if (!selection.account) return void message.warning('请先选择一个账号');
    if (!selection.session.draft && selection.account.provider !== selection.session.provider) {
      return void message.error(
        `当前会话来自 ${providerNames[selection.session.provider]}，请选择对应的账号`,
      );
    }
    const projectPath = selection.project?.path || selection.session.projectPath;
    if (!projectPath) return void message.error('当前会话缺少项目路径');
    const content = input.trim();
    const imageList = images.slice();
    setInput('');
    setImages([]);

    const currentRunKey = findRun(selection.session);
    const queueKey = resolveQueueTargetKey(
      selection.session,
      currentRunKey,
      detachedRunRef.current,
    );
    if (queueKey) {
      enqueueMessage(queueKey, createQueuedMessage(
        selection.account,
        selection.model,
        content,
        imageList,
      ));
      message.info('已入队,本轮结束后自动发送');
      return;
    }
    try {
      await runSessionMessage({
        session: selection.session,
        account: selection.account,
        model: selection.model || undefined,
        content,
        imageList,
      });
    } catch (error: unknown) {
      const aborted = isAbortError(error);
      if (aborted) {
        if (suppressAbortToastRef.current) suppressAbortToastRef.current = false;
        else message.info('已停止生成');
      } else {
        suppressAbortToastRef.current = false;
        message.error(humanizeChatError(error, '发送失败'));
      }
      if (selection.session.draft) {
        await refreshProjects({ projectPath }).catch(() => {});
      } else if (aborted) {
        await reloadSessionHistory(selection.session).catch(() => {});
      }
    } finally {
      suppressAbortToastRef.current = false;
    }
  }, [
    detachedRunRef,
    findRun,
    enqueueMessage,
    images,
    input,
    reloadSessionHistory,
    refreshProjects,
    runSessionMessage,
    selection.account,
    selection.model,
    selection.project?.path,
    selection.session,
  ]);

  const stop = useCallback((): void => {
    const session = selection.sessionRef.current;
    const currentRunKey = findRun(session);
    if (currentRunKey) {
      const activeRun = activeRunsRef.current.get(currentRunKey);
      if (activeRun?.runId) chatAPI.abortRun(activeRun.runId);
      activeRun?.controller.abort();
      dropPendingAssistantPlaceholder();
      return;
    }
    const detachedRunId = resolveDetachedRunId(session, detachedRunRef.current);
    if (!detachedRunId) return;
    chatAPI.abortRun(detachedRunId);
    detachedRunRef.current = null;
    clearWatchPending();
  }, [
    activeRunsRef,
    clearWatchPending,
    detachedRunRef,
    dropPendingAssistantPlaceholder,
    findRun,
    selection.sessionRef,
  ]);

  return {
    input,
    images,
    changeInput: setInput,
    changeImages: setImages,
    replaceDraft,
    suppressNextAbortToast,
    send,
    stop,
  };
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: unknown } | null | undefined)?.name === 'AbortError';
}
