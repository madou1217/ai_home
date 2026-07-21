interface InteractionIdentity {
  readonly interactionId: string;
  readonly revision: number;
}

export type InteractionAnswerValue = string | number | boolean | readonly string[];
export type InteractionAnswer = Readonly<Record<string, InteractionAnswerValue>>;

export interface TurnSubmitPayload {
  readonly content: string;
  readonly attachmentIds?: readonly string[];
  readonly model?: string;
  readonly reasoningEffort?: string;
}

export type InteractionAnswerPayload = InteractionIdentity & (
  | { readonly action: 'submit'; readonly answer: InteractionAnswer }
  | { readonly action: 'decline' | 'cancel'; readonly answer?: never }
);

export type ApprovalDecisionPayload = InteractionIdentity & {
  readonly choiceId: string;
};
