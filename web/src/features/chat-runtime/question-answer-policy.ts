import type {
  InteractionAnswer,
  InteractionAnswerValue,
  QuestionAnswerShape,
} from '@/chat-runtime';
import type { InteractionField } from './interaction-view-model';

export type FieldAnswer =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'option'; readonly value: string }
  | { readonly kind: 'other'; readonly value: string }
  | {
    readonly kind: 'multi';
    readonly values: readonly string[];
  };

export type AnswerValues = Readonly<Record<string, FieldAnswer | undefined>>;

export function firstMissingRequiredField(
  fields: readonly InteractionField[],
  values: AnswerValues,
): InteractionField | undefined {
  return fields.find((field) => field.required && fieldAnswerValue(field, values[field.id]) === undefined);
}

export function unansweredQuestionFields(
  fields: readonly InteractionField[],
  values: AnswerValues,
): readonly InteractionField[] {
  return fields.filter((field) => fieldAnswerValue(field, values[field.id]) === undefined);
}

export function buildQuestionAnswer(
  shape: QuestionAnswerShape,
  fields: readonly InteractionField[],
  values: AnswerValues,
): InteractionAnswer {
  if (shape === 'none') return {};
  return Object.fromEntries(fields.flatMap((field) => {
    const value = fieldAnswerValue(field, values[field.id]);
    if (shape === 'answers') return [[field.id, answersValue(value)]];
    return value === undefined ? [] : [[field.id, value]];
  }));
}

function fieldAnswerValue(
  field: InteractionField,
  answer: FieldAnswer | undefined,
): InteractionAnswerValue | undefined {
  if (!answer) return undefined;
  if (field.type === 'text') {
    return answer.kind === 'text' ? nonEmptyText(answer.value) : undefined;
  }
  if (field.type === 'number' || field.type === 'integer') {
    if (answer.kind !== 'number' || !Number.isFinite(answer.value)) return undefined;
    return field.type === 'integer' && !Number.isInteger(answer.value) ? undefined : answer.value;
  }
  if (field.type === 'boolean') {
    return answer.kind === 'boolean' ? answer.value : undefined;
  }
  if (field.type === 'single_select') {
    if (answer.kind === 'option') return answer.value;
    return answer.kind === 'other' ? nonEmptyText(answer.value) : undefined;
  }
  if (answer.kind !== 'multi') return undefined;
  const values = [...new Set(answer.values.filter(Boolean))];
  return values.length === 0 ? undefined : values;
}

function answersValue(value: InteractionAnswerValue | undefined): readonly string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  return [String(value)];
}

function nonEmptyText(value: string): string | undefined {
  const normalized = value.trim();
  return normalized || undefined;
}
