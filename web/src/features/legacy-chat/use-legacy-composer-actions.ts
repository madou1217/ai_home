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
import { resolveLegacyComposerSubmission } from './legacy-composer-submission-policy.js';
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
  // 重试等场景：绕过输入框直接发送指定内容（不清空当前草稿）
  readonly sendPrompt: (content: string) => Promise<void>;
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

  const runMessage = useCallback(async (submission: ReturnType<
    typeof resolveLegacyComposerSubmission
  > & { ok: true }): Promise<void> => {
    const {
      account, content, imageList, model, projectPath, session,
    } = submission;
    const currentRunKey = findRun(session);
    const queueKey = resolveQueueTargetKey(
      session,
      currentRunKey,
      detachedRunRef.current,
    );
    if (queueKey) {
      enqueueMessage(queueKey, createQueuedMessage(
        account,
        model,
        content,
        imageList,
      ));
      message.info('已入队,本轮结束后自动发送');
      return;
    }
    try {
      await runSessionMessage({
        session,
        account,
        model: model || undefined,
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
      if (session.draft) {
        await refreshProjects({ projectPath }).catch(() => {});
      } else if (aborted) {
        await reloadSessionHistory(session).catch(() => {});
      }
    } finally {
      suppressAbortToastRef.current = false;
    }
  }, [
    detachedRunRef,
    findRun,
    enqueueMessage,
    reloadSessionHistory,
    refreshProjects,
    runSessionMessage,
  ]);

  const submitContent = useCallback(async (
    content: string,
    contentImages: string[],
    beforeRun?: () => void,
  ): Promise<boolean> => {
    const submission = resolveLegacyComposerSubmission({
      account: selection.account,
      content,
      images: contentImages,
      model: selection.model,
      projectPath: selection.project?.path,
      session: selection.session,
    });
    if (!submission.ok) {
      if (submission.reason === 'empty_content') message.warning('请输入消息');
      else if (submission.reason === 'account_required') message.warning('请先选择一个账号');
      else if (submission.reason === 'provider_mismatch') {
        message.error(
          `当前会话来自 ${providerNames[submission.expectedProvider]}，请选择对应的账号`,
        );
      } else {
        message.error('当前会话缺少项目路径');
      }
      return false;
    }
    beforeRun?.();
    await runMessage(submission);
    return true;
  }, [
    runMessage,
    selection.account,
    selection.model,
    selection.project?.path,
    selection.session,
  ]);

  const send = useCallback(async (): Promise<void> => {
    // 先清草稿再跑：保持与原始实现一致的时序（输入框立即清空，不等 run 结束）
    await submitContent(input, images, () => {
      setInput('');
      setImages([]);
    });
  }, [images, input, submitContent]);

  const sendPrompt = useCallback(async (content: string): Promise<void> => {
    await submitContent(content, []);
  }, [submitContent]);

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
    sendPrompt,
    stop,
  };
}

function isAbortError(error: unknown): boolean {
  return (error as { name?: unknown } | null | undefined)?.name === 'AbortError';
}
