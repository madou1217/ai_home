import type {
  ApprovalChoiceIntent,
  InteractionAnnotation,
  PendingInteraction,
} from '@/chat-runtime';

type ApprovalInteraction = Extract<PendingInteraction, { kind: 'approval' }>;

export interface ApprovalDecisionOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly intent: ApprovalChoiceIntent;
  readonly tone: 'primary' | 'default' | 'danger';
}

export interface ApprovalInteractionViewModel {
  readonly title: string;
  readonly description?: string;
  readonly detail?: string;
  readonly annotations: readonly InteractionAnnotation[];
  readonly options: readonly ApprovalDecisionOption[];
}

export function approvalInteractionViewModel(
  interaction: ApprovalInteraction,
): ApprovalInteractionViewModel {
  const { presentation, choices } = interaction.payload;
  return {
    title: presentation.title,
    description: presentation.description,
    detail: presentation.detail,
    annotations: presentation.annotations ?? [],
    options: choices.map((choice) => ({
      ...choice,
      tone: choiceTone(choice.intent),
    })),
  };
}

function choiceTone(intent: ApprovalChoiceIntent): ApprovalDecisionOption['tone'] {
  if (intent === 'accept') return 'primary';
  if (intent === 'cancel') return 'danger';
  return 'default';
}
