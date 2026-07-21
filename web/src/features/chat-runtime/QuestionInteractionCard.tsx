import type { PendingInteraction } from '@/chat-runtime';
import QuestionFields from './QuestionFields';
import {
  AutoResolutionStatus,
  QuestionButtons,
  UnansweredConfirmation,
} from './QuestionInteractionControls';
import type { SessionRuntimeActions } from './session-runtime-actions';
import { useQuestionInteractionController } from './use-question-interaction-controller';
import styles from './session-runtime.module.css';

interface Props {
  readonly interaction: Extract<
    PendingInteraction,
    { kind: 'question' | 'plan_confirmation' }
  >;
  readonly actions: SessionRuntimeActions;
  readonly ready: boolean;
}

export default function QuestionInteractionCard({ interaction, actions, ready }: Props) {
  const controller = useQuestionInteractionController(interaction, actions, ready);
  return (
    <>
      <article
        className={styles.interactionCard}
        data-kind="question"
        data-state={interaction.state}
        aria-busy={controller.disabled || controller.busy}
        onKeyDownCapture={controller.autoResolution.snooze}
        onPasteCapture={controller.autoResolution.snooze}
        onPointerDownCapture={controller.autoResolution.snooze}
      >
        <header>
          <strong>{controller.view.title}</strong>
          {controller.view.message ? <span>{controller.view.message}</span> : null}
          {controller.view.link ? (
            <a href={controller.view.link.url} target="_blank" rel="noreferrer">
              {controller.view.link.label}
            </a>
          ) : null}
        </header>
        <QuestionFields
          fields={controller.fields}
          values={controller.values}
          disabled={controller.disabled || controller.busy}
          onChange={controller.setValues}
        />
        <AutoResolutionStatus
          phase={controller.autoResolution.state.phase}
          remainingSeconds={controller.autoResolution.remainingSeconds}
        />
        <QuestionButtons
          view={controller.view}
          busy={controller.busy}
          disabled={controller.disabled}
          onAction={controller.act}
        />
      </article>
      <UnansweredConfirmation
        fields={controller.unanswered}
        busy={controller.busy}
        disabled={controller.disabled}
        onCancel={controller.cancelUnanswered}
        onConfirm={controller.confirmUnanswered}
      />
    </>
  );
}
