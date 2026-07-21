'use strict';

const PROJECTED_INTERACTION_KINDS = new Set(['question', 'plan_confirmation']);
const HIDDEN_ANSWER = '[已隐藏]';
const SECRET_ANSWER_SUBMITTED = '已提交敏感回答';

function createInteractionAnswerTimelineEvent(interaction) {
  if (!shouldProject(interaction)) return null;
  const content = formatInteractionAnswer(interaction);
  if (!content) return null;
  const itemId = `interaction-answer:${interaction.interactionId}:${interaction.revision}`;
  const item = {
    id: itemId,
    kind: 'message',
    createdAt: interaction.updatedAt,
    updatedAt: interaction.updatedAt,
    status: 'completed',
    content,
    detail: { role: 'user', phase: 'interaction_answer' }
  };
  return {
    type: 'timeline.item.completed',
    itemId,
    source: { provider: 'aih', runtimeId: 'chat-runtime' },
    payload: { item }
  };
}

function shouldProject(interaction) {
  return interaction
    && PROJECTED_INTERACTION_KINDS.has(interaction.kind)
    && interaction.resolution
    && interaction.resolution.action === 'submit';
}

function formatInteractionAnswer(interaction) {
  const fields = interaction.payload && Array.isArray(interaction.payload.fields)
    ? interaction.payload.fields
    : [];
  const answer = asRecord(interaction.resolution.answer);
  if (!answer) {
    return fields.some((field) => field.secret === true)
      && interaction.resolution.answer === '[secret]'
      ? SECRET_ANSWER_SUBMITTED
      : '';
  }
  const entries = fields.flatMap((field) => {
    if (!Object.prototype.hasOwnProperty.call(answer, field.id)) return [];
    const value = formatFieldAnswer(field, answer[field.id]);
    return value ? [{ label: field.label, secret: field.secret === true, value }] : [];
  });
  if (entries.length === 0) return '';
  if (fields.length === 1) {
    return entries[0].secret ? SECRET_ANSWER_SUBMITTED : entries[0].value;
  }
  return entries.map(({ label, value }) => `${label}：${value}`).join('\n');
}

function formatFieldAnswer(field, input) {
  const values = answerValues(input);
  if (values.length === 0) return '';
  if (field.secret === true) return HIDDEN_ANSWER;
  const optionLabels = new Map((Array.isArray(field.options) ? field.options : [])
    .map((option) => [String(option.value), String(option.label)]));
  return values.map((value) => optionLabels.get(value) || value).join('、');
}

function answerValues(input) {
  const record = asRecord(input);
  const value = record && Array.isArray(record.answers) ? record.answers : input;
  return (Array.isArray(value) ? value : [value])
    .filter((entry) => entry !== undefined && entry !== null)
    .map((entry) => String(entry).trim())
    .filter(Boolean);
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

module.exports = {
  createInteractionAnswerTimelineEvent,
  formatInteractionAnswer
};
