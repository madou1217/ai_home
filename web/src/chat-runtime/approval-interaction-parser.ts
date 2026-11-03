import {
  optionalText,
  protocolFailure,
  record,
  records,
  text,
} from './dto-guards';
import { APPROVAL_CHOICE_INTENTS } from './interaction-types';
import { assertExactFields } from './interaction-parser-fields';
import type {
  ApprovalChoice,
  ApprovalChoiceIntent,
  ApprovalInteractionPayload,
  ApprovalInteractionPresentation,
} from './interaction-types';

const CHOICE_INTENTS = new Set<ApprovalChoiceIntent>(APPROVAL_CHOICE_INTENTS);

export function parseApprovalInteractionPayload(value: unknown): ApprovalInteractionPayload {
  const source = record(value, 'chat_runtime_approval_payload_invalid');
  assertExactFields(source, ['presentation', 'choices'], 'chat_runtime_approval_payload_invalid');
  const choices = records(source.choices, 'chat_runtime_approval_choices_invalid')
    .map(parseChoice);
  if (choices.length === 0) protocolFailure('chat_runtime_approval_choices_invalid');
  requireUnique(choices.map((choice) => choice.id), 'chat_runtime_approval_choice_duplicate');
  return {
    presentation: parsePresentation(source.presentation),
    choices,
  };
}

function parsePresentation(value: unknown): ApprovalInteractionPresentation {
  const source = record(value, 'chat_runtime_approval_presentation_invalid');
  assertExactFields(
    source,
    ['title', 'description', 'detail', 'annotations'],
    'chat_runtime_approval_presentation_invalid',
  );
  return {
    title: text(source.title, 'chat_runtime_approval_title_invalid'),
    ...optionalTextProperty(source, 'description', 'chat_runtime_approval_description_invalid'),
    ...optionalTextProperty(source, 'detail', 'chat_runtime_approval_detail_invalid'),
    ...(source.annotations === undefined ? {} : {
      annotations: records(source.annotations, 'chat_runtime_approval_annotations_invalid')
        .map((annotation) => {
          assertExactFields(
            annotation,
            ['label', 'value'],
            'chat_runtime_approval_annotation_invalid',
          );
          return {
            label: text(annotation.label, 'chat_runtime_approval_annotation_label_invalid'),
            value: text(annotation.value, 'chat_runtime_approval_annotation_value_invalid'),
          };
        }),
    }),
  };
}

function parseChoice(source: Record<string, unknown>): ApprovalChoice {
  assertExactFields(
    source,
    ['id', 'label', 'description', 'intent'],
    'chat_runtime_approval_choice_invalid',
  );
  const intent = text(
    source.intent,
    'chat_runtime_approval_choice_intent_invalid',
  ) as ApprovalChoiceIntent;
  if (!CHOICE_INTENTS.has(intent)) protocolFailure('chat_runtime_approval_choice_intent_invalid');
  return {
    id: text(source.id, 'chat_runtime_approval_choice_id_invalid'),
    label: text(source.label, 'chat_runtime_approval_choice_label_invalid'),
    ...optionalTextProperty(source, 'description', 'chat_runtime_approval_choice_description_invalid'),
    intent,
  };
}

function optionalTextProperty(
  source: Record<string, unknown>,
  field: string,
  code: string,
) {
  const value = optionalText(source[field], code);
  return value === undefined ? {} : { [field]: value };
}

function requireUnique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) protocolFailure(code);
}
