import { useMemo, useState } from 'react';
import { message as toast } from 'antd';
import Button from '@/components/ui/AppButton';
import type { PendingInteraction } from '@/chat-runtime';
import { interactionControlsDisabled } from './interaction-view-model';
import { approvalInteractionViewModel } from './approval-interaction-policy';
import type { ApprovalDecisionOption } from './approval-interaction-policy';
import type { SessionRuntimeActions } from './session-runtime-actions';
import styles from './session-runtime.module.css';

interface Props {
  readonly interaction: Extract<PendingInteraction, { kind: 'approval' }>;
  readonly actions: SessionRuntimeActions;
}

export default function ApprovalInteractionCard({ interaction, actions }: Props) {
  const view = useMemo(() => approvalInteractionViewModel(interaction), [interaction]);
  const [submittingId, setSubmittingId] = useState<string>();
  const disabled = interactionControlsDisabled(interaction);

  const decide = async (option: ApprovalDecisionOption): Promise<void> => {
    if (disabled || submittingId) return;
    setSubmittingId(option.id);
    try {
      await actions.decide({
        interactionId: interaction.interactionId,
        revision: interaction.revision,
        choiceId: option.id,
      });
    } catch (error) {
      toast.error(errorText(error, '审批提交失败'));
    } finally {
      setSubmittingId(undefined);
    }
  };

  return (
    <article
      className={styles.interactionCard}
      data-kind="approval"
      data-state={interaction.state}
      aria-busy={disabled || Boolean(submittingId)}
    >
      <header>
        <strong>{view.title}</strong>
        {view.description ? <span>{view.description}</span> : null}
      </header>
      {view.detail ? <pre className={styles.interactionDetail}>{view.detail}</pre> : null}
      {view.annotations.length > 0 ? (
        <ul className={styles.approvalContext}>
          {view.annotations.map((item) => (
            <li key={`${item.label}:${item.value}`}>{item.label}：{item.value}</li>
          ))}
        </ul>
      ) : null}
      <footer className={styles.approvalOptions}>
        {view.options.map((option) => (
          <Button
            key={option.id}
            type={option.tone === 'primary' ? 'primary' : 'default'}
            danger={option.tone === 'danger'}
            title={option.description}
            disabled={disabled || Boolean(submittingId)}
            loading={submittingId === option.id}
            onClick={() => void decide(option)}
          >
            {option.label}
          </Button>
        ))}
      </footer>
    </article>
  );
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
