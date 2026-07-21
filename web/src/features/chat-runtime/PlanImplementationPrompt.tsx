import { useState } from 'react';
import { message as toast } from 'antd';
import Button from '@/components/ui/AppButton';
import { useSessionSelector } from '@/chat-runtime';
import type { SessionProjectionStore } from '@/chat-runtime';
import { resolvePlanImplementationPrompt } from './plan-implementation-policy';
import { FreshPlanImplementationError } from './fresh-plan-implementation-workflow';
import type { SessionRuntimeActions } from './session-runtime-actions';
import styles from './session-runtime.module.css';

type Action = 'implement' | 'fresh' | 'stay';

interface Props {
  readonly store: SessionProjectionStore;
  readonly actions: SessionRuntimeActions;
  readonly onImplementCurrent: (sourceTurnId: string) => Promise<void>;
  readonly onImplementFresh: (
    sourceTurnId: string,
    planMarkdown: string,
  ) => Promise<void>;
}

interface FreshRecoveryState {
  readonly sourceTurnId: string;
  readonly canonicalSessionId?: string;
  readonly retryable: boolean;
}

export default function PlanImplementationPrompt(props: Props) {
  const prompt = useSessionSelector(props.store, resolvePlanImplementationPrompt);
  const [busy, setBusy] = useState<Action>();
  const [freshRecovery, setFreshRecovery] = useState<FreshRecoveryState>();
  if (!prompt) return null;
  const currentRecovery = freshRecovery?.sourceTurnId === prompt.turnId
    ? freshRecovery
    : undefined;

  const execute = async (action: Action): Promise<void> => {
    setBusy(action);
    try {
      if (action === 'stay') {
        await props.actions.setPolicy('planConfirmationDismissedTurnId', prompt.turnId);
      } else if (action === 'fresh') {
        if (!prompt.planMarkdown) throw new Error('chat_plan_markdown_required');
        await props.onImplementFresh(prompt.turnId, prompt.planMarkdown);
      } else {
        await props.onImplementCurrent(prompt.turnId);
      }
    } catch (error) {
      if (action === 'fresh' && error instanceof FreshPlanImplementationError) {
        setFreshRecovery({
          sourceTurnId: prompt.turnId,
          canonicalSessionId: error.canonicalSessionId,
          retryable: error.retryable,
        });
      }
      toast.error(errorText(error));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <article className={styles.interactionCard} data-kind="plan-confirmation">
      <header>
        <strong>实现这个计划？</strong>
        <span>计划已生成。可以在当前上下文继续，或用全新上下文开始实现。</span>
        {currentRecovery?.canonicalSessionId ? (
          <span>
            已保留 AIH 会话 {currentRecovery.canonicalSessionId}；再次操作只会恢复该会话。
          </span>
        ) : null}
      </header>
      <footer>
        <Button disabled={Boolean(busy)} onClick={() => void execute('stay')}>
          留在 Plan
        </Button>
        <Button
          disabled={Boolean(busy) || !prompt.planMarkdown || currentRecovery?.retryable === false}
          loading={busy === 'fresh'}
          onClick={() => void execute('fresh')}
        >
          {currentRecovery?.retryable ? '继续检查新会话' : '清空上下文并实现'}
        </Button>
        <Button
          type="primary"
          disabled={Boolean(busy)}
          loading={busy === 'implement'}
          onClick={() => void execute('implement')}
        >
          实现计划
        </Button>
      </footer>
    </article>
  );
}

function errorText(error: unknown): string {
  if (!(error instanceof Error) || !error.message) return '计划操作失败';
  return ({
    chat_fresh_native_session_pending: '新会话仍在运行或等待绑定；已保留 AIH 会话，重试不会新建任务',
    chat_fresh_plan_submission_pending: '提交结果尚未确认；已保留 AIH 会话，重试会复用同一命令',
    chat_fresh_session_initialization_pending: 'AIH 会话已创建但连接尚未恢复；重试只会重连该会话',
    chat_fresh_session_creation_indeterminate: '创建请求结果不确定，已停止自动重试以避免并行实现；请刷新会话列表确认',
    chat_fresh_session_recovery_unavailable: 'AIH 会话已创建，但当前客户端无法安全恢复；已停止自动重试',
    chat_fresh_session_identity_mismatch: '恢复结果与原 AIH 会话不一致；已停止操作以避免并行实现',
    chat_fresh_plan_attempt_conflict: '已有另一个新会话实现流程尚未结束',
    chat_plan_implementation_in_progress: '已有另一个计划实现流程尚未结束',
    chat_plan_markdown_required: '当前计划内容不可用于新会话',
  } as Record<string, string>)[error.message] || error.message;
}
