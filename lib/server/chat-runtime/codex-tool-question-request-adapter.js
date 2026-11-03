'use strict';

const {
  array,
  codexError,
  optionalText,
  record,
  requiredText,
  requireUniqueIds,
  safeFieldId
} = require('./codex-interaction-adapter-support');

const AUTO_RESOLUTION = Object.freeze({
  mode: 'inactivity_countdown',
  inactivityMs: 60_000,
  countdownMs: 60_000,
  onExpire: 'submit_empty',
  snooze: 'disable'
});
const AUTO_MIN_MS = 60_000;
const AUTO_MAX_MS = 240_000;

function adaptToolQuestion(params) {
  const questions = array(params.questions, 'invalid_codex_tool_question');
  if (questions.length === 0) throw codexError('invalid_codex_tool_question');
  const fields = questions.map(projectToolQuestion);
  requireUniqueIds(fields, 'invalid_codex_tool_question');
  const payload = {
    presentation: { title: 'Input required' },
    fields,
    actions: ['submit'],
    answerShape: 'answers',
    confirmUnanswered: true
  };
  if (validAutoResolution(params.autoResolutionMs)) {
    payload.autoResolution = { ...AUTO_RESOLUTION };
  }
  return {
    kind: 'question',
    itemId: requiredText(params.itemId, 'invalid_codex_interaction_item'),
    payload
  };
}

function projectToolQuestion(input) {
  const question = record(input, 'invalid_codex_tool_question');
  const id = safeFieldId(question.id, 'invalid_codex_tool_question');
  const options = question.options === null || question.options === undefined
    ? null
    : projectToolOptions(question.options);
  const header = optionalText(question.header);
  return {
    id,
    label: requiredText(question.question, 'invalid_codex_tool_question'),
    ...(header ? { header } : {}),
    type: options ? 'single_select' : 'text',
    required: false,
    allowOther: options ? question.isOther === true : false,
    secret: question.isSecret === true,
    ...(options ? { options } : {})
  };
}

function projectToolOptions(input) {
  const options = array(input, 'invalid_codex_tool_question').map((value) => {
    const option = record(value, 'invalid_codex_tool_question');
    const label = requiredText(option.label, 'invalid_codex_tool_question');
    const description = optionalText(option.description);
    return { value: label, label, ...(description ? { description } : {}) };
  });
  if (options.length === 0) throw codexError('invalid_codex_tool_question');
  requireUniqueIds(options, 'invalid_codex_tool_question', 'value');
  return options;
}

function validAutoResolution(value) {
  return Number.isSafeInteger(value) && value >= AUTO_MIN_MS && value <= AUTO_MAX_MS;
}

module.exports = { adaptToolQuestion };
