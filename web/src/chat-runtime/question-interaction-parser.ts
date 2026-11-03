import {
  booleanValue,
  nonNegativeInteger,
  optionalText,
  positiveInteger,
  protocolFailure,
  record,
  records,
  text,
} from './dto-guards';
import {
  QUESTION_ACTIONS,
  QUESTION_ANSWER_SHAPES,
  QUESTION_AUTO_RESOLUTION_EXPIRATIONS,
  QUESTION_AUTO_RESOLUTION_SNOOZE_POLICIES,
  QUESTION_FIELD_TYPES,
} from './interaction-types';
import { assertExactFields } from './interaction-parser-fields';
import type {
  QuestionAction,
  QuestionAnswerShape,
  QuestionAutoResolution,
  QuestionAutoResolutionExpiration,
  QuestionAutoResolutionSnooze,
  QuestionField,
  QuestionFieldType,
  QuestionInteractionPayload,
  QuestionInteractionPresentation,
  QuestionOption,
} from './interaction-types';

const ACTIONS = new Set<QuestionAction>(QUESTION_ACTIONS);
const ANSWER_SHAPES = new Set<QuestionAnswerShape>(QUESTION_ANSWER_SHAPES);
const FIELD_TYPES = new Set<QuestionFieldType>(QUESTION_FIELD_TYPES);
const AUTO_RESOLUTION_EXPIRATIONS = new Set<QuestionAutoResolutionExpiration>(
  QUESTION_AUTO_RESOLUTION_EXPIRATIONS,
);
const AUTO_RESOLUTION_SNOOZE = new Set<QuestionAutoResolutionSnooze>(
  QUESTION_AUTO_RESOLUTION_SNOOZE_POLICIES,
);
const AUTO_RESOLUTION_MODES = new Set(['inactivity_countdown', 'countdown'] as const);

export function parseQuestionInteractionPayload(value: unknown): QuestionInteractionPayload {
  const source = record(value, 'chat_runtime_question_payload_invalid');
  assertExactFields(
    source,
    ['presentation', 'fields', 'actions', 'answerShape', 'confirmUnanswered', 'autoResolution'],
    'chat_runtime_question_payload_invalid',
  );
  const fields = records(source.fields, 'chat_runtime_question_fields_invalid').map(parseField);
  const answerShape = enumValue(
    source.answerShape,
    ANSWER_SHAPES,
    'chat_runtime_question_answer_shape_invalid',
  );
  validateFieldPopulation(fields, answerShape);
  requireUnique(fields.map((field) => field.id), 'chat_runtime_question_field_duplicate');
  return {
    presentation: parsePresentation(source.presentation),
    fields,
    actions: parseActions(source.actions),
    answerShape,
    confirmUnanswered: booleanValue(
      source.confirmUnanswered,
      'chat_runtime_question_confirm_unanswered_invalid',
    ),
    ...(source.autoResolution === undefined ? {} : {
      autoResolution: parseAutoResolution(source.autoResolution),
    }),
  };
}

function parsePresentation(value: unknown): QuestionInteractionPresentation {
  const source = record(value, 'chat_runtime_question_presentation_invalid');
  assertExactFields(
    source,
    ['title', 'message', 'link'],
    'chat_runtime_question_presentation_invalid',
  );
  return {
    title: text(source.title, 'chat_runtime_question_title_invalid'),
    ...optionalTextProperty(source, 'message', 'chat_runtime_question_message_invalid'),
    ...(source.link === undefined ? {} : { link: parseLink(source.link) }),
  };
}

function parseLink(value: unknown) {
  const source = record(value, 'chat_runtime_question_link_invalid');
  assertExactFields(source, ['label', 'url'], 'chat_runtime_question_link_invalid');
  return {
    label: text(source.label, 'chat_runtime_question_link_label_invalid'),
    url: safeHttpUrl(source.url),
  };
}

function safeHttpUrl(value: unknown): string {
  const url = text(value, 'chat_runtime_question_link_url_invalid').trim();
  try {
    const protocol = new URL(url).protocol;
    if (protocol !== 'http:' && protocol !== 'https:') {
      protocolFailure('chat_runtime_question_link_url_invalid');
    }
  } catch (_error) {
    protocolFailure('chat_runtime_question_link_url_invalid');
  }
  return url;
}

function parseField(source: Record<string, unknown>): QuestionField {
  assertExactFields(
    source,
    [
      'id', 'label', 'header', 'description', 'type',
      'required', 'allowOther', 'secret', 'options',
    ],
    'chat_runtime_question_field_invalid',
  );
  const type = enumValue(
    source.type,
    FIELD_TYPES,
    'chat_runtime_question_field_type_invalid',
  );
  const allowOther = booleanValue(
    source.allowOther,
    'chat_runtime_question_field_allow_other_invalid',
  );
  const options = source.options === undefined ? undefined : parseOptions(source.options);
  validateFieldOptions(type, allowOther, options);
  return {
    id: text(source.id, 'chat_runtime_question_field_id_invalid'),
    label: text(source.label, 'chat_runtime_question_field_label_invalid'),
    ...optionalTextProperty(source, 'header', 'chat_runtime_question_field_header_invalid'),
    ...optionalTextProperty(
      source,
      'description',
      'chat_runtime_question_field_description_invalid',
    ),
    type,
    required: booleanValue(source.required, 'chat_runtime_question_field_required_invalid'),
    allowOther,
    secret: booleanValue(source.secret, 'chat_runtime_question_field_secret_invalid'),
    ...(options === undefined ? {} : { options }),
  };
}

function parseOptions(value: unknown): readonly QuestionOption[] {
  const options = records(value, 'chat_runtime_question_options_invalid').map((source) => {
    assertExactFields(
      source,
      ['value', 'label', 'description'],
      'chat_runtime_question_option_invalid',
    );
    return {
      value: text(source.value, 'chat_runtime_question_option_value_invalid'),
      label: text(source.label, 'chat_runtime_question_option_label_invalid'),
      ...optionalTextProperty(
        source,
        'description',
        'chat_runtime_question_option_description_invalid',
      ),
    };
  });
  requireUnique(options.map((option) => option.value), 'chat_runtime_question_option_duplicate');
  return options;
}

function parseActions(value: unknown): readonly QuestionAction[] {
  if (!Array.isArray(value) || value.length === 0) {
    protocolFailure('chat_runtime_question_actions_invalid');
  }
  const actions = value.map((action) => enumValue(
    action,
    ACTIONS,
    'chat_runtime_question_action_invalid',
  ));
  requireUnique(actions, 'chat_runtime_question_action_duplicate');
  return actions;
}

function parseAutoResolution(value: unknown): QuestionAutoResolution {
  const source = record(value, 'chat_runtime_question_auto_resolution_invalid');
  assertExactFields(
    source,
    ['mode', 'inactivityMs', 'countdownMs', 'onExpire', 'snooze'],
    'chat_runtime_question_auto_resolution_invalid',
  );
  const mode = enumValue(
    source.mode,
    AUTO_RESOLUTION_MODES,
    'chat_runtime_question_auto_resolution_mode_invalid',
  );
  const countdownMs = positiveInteger(
    source.countdownMs,
    'chat_runtime_question_auto_resolution_countdown_invalid',
  );
  const onExpire = enumValue(
    source.onExpire,
    AUTO_RESOLUTION_EXPIRATIONS,
    'chat_runtime_question_auto_resolution_expiration_invalid',
  );
  const snooze = enumValue(
    source.snooze,
    AUTO_RESOLUTION_SNOOZE,
    'chat_runtime_question_auto_resolution_snooze_invalid',
  );
  if (mode === 'countdown') {
    if (source.inactivityMs !== undefined) {
      protocolFailure('chat_runtime_question_auto_resolution_inactivity_invalid');
    }
    return { mode, countdownMs, onExpire, snooze };
  }
  return {
    mode,
    inactivityMs: nonNegativeInteger(
      source.inactivityMs,
      'chat_runtime_question_auto_resolution_inactivity_invalid',
    ),
    countdownMs,
    onExpire,
    snooze,
  };
}

function validateFieldPopulation(
  fields: readonly QuestionField[],
  answerShape: QuestionAnswerShape,
): void {
  if (answerShape === 'none') {
    if (fields.length > 0) protocolFailure('chat_runtime_question_fields_invalid');
    return;
  }
  if (fields.length === 0) protocolFailure('chat_runtime_question_fields_invalid');
}

function validateFieldOptions(
  type: QuestionFieldType,
  allowOther: boolean,
  options: readonly QuestionOption[] | undefined,
): void {
  const select = type === 'single_select' || type === 'multi_select';
  if (!select && options !== undefined) {
    protocolFailure('chat_runtime_question_field_options_invalid');
  }
  if (select && (!options || options.length === 0)) {
    protocolFailure('chat_runtime_question_field_options_invalid');
  }
  if (type !== 'single_select' && allowOther) {
    protocolFailure('chat_runtime_question_field_allow_other_invalid');
  }
}

function enumValue<T extends string>(
  value: unknown,
  values: ReadonlySet<T>,
  code: string,
): T {
  const result = text(value, code) as T;
  if (!values.has(result)) protocolFailure(code);
  return result;
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
