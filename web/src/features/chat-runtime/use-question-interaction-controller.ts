import { useEffect, useMemo, useState } from 'react';
import { message as toast } from 'antd';
import type {
  InteractionAnswer,
  InteractionAnswerPayload,
  PendingInteraction,
  QuestionAction,
} from '@/chat-runtime';
import { interactionCommandDisabled, questionViewModel } from './interaction-view-model';
import type { InteractionField, QuestionViewModel } from './interaction-view-model';
import {
  buildQuestionAnswer,
  firstMissingRequiredField,
  unansweredQuestionFields,
} from './question-answer-policy';
import type { AnswerValues } from './question-answer-policy';
import type { SessionRuntimeActions } from './session-runtime-actions';
import { useQuestionAutoResolution } from './use-question-auto-resolution';
import { autoResolutionSubmission } from './question-auto-resolution-policy';
import { runCommandOperation } from './command-operation';

type QuestionInteraction = Extract<
  PendingInteraction,
  { kind: 'question' | 'plan_confirmation' }
>;

interface QuestionActionExecution {
  readonly answer?: InteractionAnswer;
  readonly onSuccess?: () => void;
}

export interface QuestionInteractionController {
  readonly view: QuestionViewModel;
  readonly fields: readonly InteractionField[];
  readonly values: AnswerValues;
  readonly unanswered: readonly InteractionField[];
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly autoResolution: ReturnType<typeof useQuestionAutoResolution>;
  readonly setValues: (values: AnswerValues) => void;
  readonly act: (action: QuestionAction) => Promise<void>;
  readonly cancelUnanswered: () => void;
  readonly confirmUnanswered: () => Promise<void>;
}

export function useQuestionInteractionController(
  interaction: QuestionInteraction,
  actions: SessionRuntimeActions,
  ready: boolean,
): QuestionInteractionController {
  const view = useMemo(() => questionViewModel(interaction), [interaction]);
  const [values, setValues] = useState<AnswerValues>({});
  const [busy, setBusy] = useState(false);
  const [unanswered, setUnanswered] = useState<readonly InteractionField[]>([]);
  const fields = view.fields;
  const disabled = interactionCommandDisabled(interaction, ready);

  const performAction = async (
    action: QuestionAction,
    execution: QuestionActionExecution = {},
  ): Promise<boolean> => {
    if (disabled) return false;
    const answer = execution.answer
      ?? buildQuestionAnswer(view.answerShape, fields, values);
    setBusy(true);
    try {
      const result = await runCommandOperation({
        execute: () => actions.answer(answerPayload(interaction, action, answer)),
        onSuccess: execution.onSuccess,
      });
      if (result.ok) return true;
      toast.error(errorText(result.error, '回答提交失败'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const autoResolution = useQuestionAutoResolution({
    policy: view.autoResolution,
    ready,
    requestKey: `${interaction.interactionId}:${interaction.revision}`,
    onExpire: async (outcome) => {
      if (disabled || busy) return false;
      const submission = autoResolutionSubmission(outcome);
      if (submission.action === 'submit') {
        return performAction(submission.action, { answer: submission.answer });
      }
      return performAction(submission.action);
    },
  });

  useEffect(() => {
    setValues({});
    setBusy(false);
    setUnanswered([]);
  }, [interaction.interactionId, interaction.revision]);

  const act = async (action: QuestionAction): Promise<void> => {
    if (disabled || busy) return;
    autoResolution.snooze();
    const missing = action === 'submit' ? firstMissingRequiredField(fields, values) : undefined;
    if (missing) {
      toast.warning(`请填写：${missing.label}`);
      return;
    }
    const skipped = action === 'submit' && view.confirmUnanswered
      ? unansweredQuestionFields(fields, values)
      : [];
    if (skipped.length > 0) {
      setUnanswered(skipped);
      return;
    }
    await performAction(action);
  };

  const confirmUnanswered = async (): Promise<void> => {
    await performAction('submit', { onSuccess: () => setUnanswered([]) });
  };
  return {
    view,
    fields,
    values,
    unanswered,
    busy,
    disabled,
    autoResolution,
    setValues,
    act,
    cancelUnanswered: () => setUnanswered([]),
    confirmUnanswered,
  };
}

function answerPayload(
  interaction: QuestionInteraction,
  action: QuestionAction,
  answer: InteractionAnswer,
): InteractionAnswerPayload {
  const identity = { interactionId: interaction.interactionId, revision: interaction.revision };
  return action === 'submit'
    ? { ...identity, action, answer }
    : { ...identity, action };
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
