import type {
  PendingInteraction,
  QuestionAction,
  QuestionAnswerShape,
  QuestionAutoResolution,
  QuestionFieldType,
  QuestionPresentationLink,
} from '@/chat-runtime';

type QuestionInteraction = Extract<
  PendingInteraction,
  { kind: 'question' | 'plan_confirmation' }
>;

export interface InteractionOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface InteractionField {
  readonly id: string;
  readonly header?: string;
  readonly label: string;
  readonly description?: string;
  readonly type: QuestionFieldType;
  readonly options: readonly InteractionOption[];
  readonly required: boolean;
  readonly allowOther: boolean;
  readonly secret: boolean;
}

export interface QuestionViewModel {
  readonly title: string;
  readonly message?: string;
  readonly link?: QuestionPresentationLink;
  readonly fields: readonly InteractionField[];
  readonly actions: readonly QuestionAction[];
  readonly answerShape: QuestionAnswerShape;
  readonly confirmUnanswered: boolean;
  readonly autoResolution?: QuestionAutoResolution;
}

export function interactionControlsDisabled(interaction: PendingInteraction): boolean {
  return interaction.state === 'resolving';
}

export function interactionCommandDisabled(
  interaction: PendingInteraction,
  ready: boolean,
): boolean {
  return !ready || interactionControlsDisabled(interaction);
}

export function interactionLifecycleKey(interaction: PendingInteraction): string {
  return `${interaction.interactionId}:${interaction.revision}`;
}

export function questionViewModel(interaction: QuestionInteraction): QuestionViewModel {
  const payload = interaction.payload;
  return {
    title: payload.presentation.title,
    message: payload.presentation.message,
    link: payload.presentation.link,
    fields: payload.fields.map((field) => ({
      ...field,
      options: field.options ?? [],
    })),
    actions: payload.actions,
    answerShape: payload.answerShape,
    confirmUnanswered: payload.confirmUnanswered,
    autoResolution: payload.autoResolution,
  };
}
