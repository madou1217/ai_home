export const APPROVAL_CHOICE_INTENTS = [
  'accept', 'deny', 'cancel', 'neutral',
] as const;
export type ApprovalChoiceIntent = typeof APPROVAL_CHOICE_INTENTS[number];

export interface InteractionAnnotation {
  readonly label: string;
  readonly value: string;
}

export interface ApprovalInteractionPresentation {
  readonly title: string;
  readonly description?: string;
  readonly detail?: string;
  readonly annotations?: readonly InteractionAnnotation[];
}

export interface ApprovalChoice {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly intent: ApprovalChoiceIntent;
}

export interface ApprovalInteractionPayload {
  readonly presentation: ApprovalInteractionPresentation;
  readonly choices: readonly ApprovalChoice[];
}

export const QUESTION_ACTIONS = ['submit', 'decline', 'cancel'] as const;
export type QuestionAction = typeof QUESTION_ACTIONS[number];

export const QUESTION_FIELD_TYPES = [
  'text', 'number', 'integer', 'boolean', 'single_select', 'multi_select',
] as const;
export type QuestionFieldType = typeof QUESTION_FIELD_TYPES[number];

export interface QuestionOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface QuestionField {
  readonly id: string;
  readonly label: string;
  readonly header?: string;
  readonly description?: string;
  readonly type: QuestionFieldType;
  readonly required: boolean;
  readonly allowOther: boolean;
  readonly secret: boolean;
  readonly options?: readonly QuestionOption[];
}

export interface QuestionPresentationLink {
  readonly label: string;
  readonly url: string;
}

export interface QuestionInteractionPresentation {
  readonly title: string;
  readonly message?: string;
  readonly link?: QuestionPresentationLink;
}

export const QUESTION_ANSWER_SHAPES = ['answers', 'object', 'none'] as const;
export type QuestionAnswerShape = typeof QUESTION_ANSWER_SHAPES[number];

export const QUESTION_AUTO_RESOLUTION_EXPIRATIONS = ['submit_empty', 'decline'] as const;
export type QuestionAutoResolutionExpiration =
  typeof QUESTION_AUTO_RESOLUTION_EXPIRATIONS[number];

export const QUESTION_AUTO_RESOLUTION_SNOOZE_POLICIES = ['disable', 'restart'] as const;
export type QuestionAutoResolutionSnooze =
  typeof QUESTION_AUTO_RESOLUTION_SNOOZE_POLICIES[number];

interface QuestionAutoResolutionBase {
  readonly countdownMs: number;
  readonly onExpire: QuestionAutoResolutionExpiration;
  readonly snooze: QuestionAutoResolutionSnooze;
}

export type QuestionAutoResolution =
  | (QuestionAutoResolutionBase & {
    readonly mode: 'inactivity_countdown';
    readonly inactivityMs: number;
  })
  | (QuestionAutoResolutionBase & {
    readonly mode: 'countdown';
    readonly inactivityMs?: never;
  });

export interface QuestionInteractionPayload {
  readonly presentation: QuestionInteractionPresentation;
  readonly fields: readonly QuestionField[];
  readonly actions: readonly QuestionAction[];
  readonly answerShape: QuestionAnswerShape;
  readonly confirmUnanswered: boolean;
  readonly autoResolution?: QuestionAutoResolution;
}
