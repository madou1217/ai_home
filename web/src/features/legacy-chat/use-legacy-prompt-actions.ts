import type { MutableRefObject } from 'react';
import { useCallback } from 'react';
import { message } from 'antd';
import { getSessionRunKey } from '@/components/chat/active-run-state.js';
import { chatAPI } from '@/services/api';
import type { InteractivePrompt, Session } from '@/types';
import { humanizeChatError } from './chat-error-policy';
import {
  isApprovalPrompt,
  normalizePromptChoice,
  resolveDetachedRunId,
} from './legacy-runtime-policy';
import type { LegacySessionRuntime } from './use-legacy-session-orchestration';

interface LegacyPromptActionOptions {
  readonly sessionRef: MutableRefObject<Session | null>;
  readonly runtime: LegacyPromptRuntime;
}

interface LegacyPromptRuntime {
  readonly detachedRunRef: LegacySessionRuntime['detachedRunRef'];
  readonly runs: Pick<
    LegacySessionRuntime['runs'],
    | 'activeRunsRef'
    | 'clearPrompt'
    | 'find'
    | 'promptForKey'
    | 'restorePrompt'
    | 'updateStatus'
  >;
}

export function useLegacyPromptActions({
  sessionRef,
  runtime,
}: LegacyPromptActionOptions): (
  choice: string,
  prompt: InteractivePrompt,
) => Promise<void> {
  const { detachedRunRef, runs } = runtime;
  const findRun = runs.find;
  const activeRunsRef = runs.activeRunsRef;
  const promptForKey = runs.promptForKey;
  const clearPrompt = runs.clearPrompt;
  const restorePrompt = runs.restorePrompt;
  const updateStatus = runs.updateStatus;

  return useCallback(async (
    choice: string,
    prompt: InteractivePrompt,
  ): Promise<void> => {
    const normalizedChoice = normalizePromptChoice(choice);
    if (!normalizedChoice) return;
    const session = sessionRef.current;
    const currentRunKey = findRun(session);
    const stableKey = session && !session.draft ? getSessionRunKey(session) : '';
    const activeRun = currentRunKey ? activeRunsRef.current.get(currentRunKey) : null;
    const detachedRunId = resolveDetachedRunId(session, detachedRunRef.current);
    const promptKey = promptForKey(currentRunKey) ? currentRunKey : stableKey;

    if (isApprovalPrompt(prompt)) {
      if (promptKey) clearPrompt(promptKey, prompt.promptId);
      try {
        await chatAPI.decideApproval(
          String(prompt.runId || activeRun?.runId || detachedRunId || ''),
          prompt.approvalId,
          normalizedChoice === '1' ? 'allow' : 'deny',
        );
        message.success(normalizedChoice === '1' ? '已允许,继续执行' : '已拒绝该操作');
      } catch (error) {
        message.error(humanizeChatError(error, '审批提交失败'));
      }
      return;
    }

    const runId = activeRun?.runId || detachedRunId;
    const activePrompt = promptForKey(promptKey);
    if (!promptKey || !runId || activePrompt?.promptId !== prompt.promptId) {
      message.warning('当前计划选择已过期');
      return;
    }
    clearPrompt(promptKey, prompt.promptId);
    try {
      await chatAPI.sendRunInput(runId, normalizedChoice, true, prompt.promptId);
      if (currentRunKey) updateStatus(currentRunKey, '已提交计划选择');
    } catch (error: unknown) {
      restorePrompt(promptKey, prompt);
      message.error(readPlanChoiceError(error));
    }
  }, [
    activeRunsRef,
    clearPrompt,
    detachedRunRef,
    findRun,
    promptForKey,
    restorePrompt,
    sessionRef,
    updateStatus,
  ]);
}

function readPlanChoiceError(error: unknown): string {
  const value = error as {
    message?: string;
    response?: { data?: { message?: string } };
  };
  return value?.response?.data?.message || value?.message || '发送计划选择失败';
}
