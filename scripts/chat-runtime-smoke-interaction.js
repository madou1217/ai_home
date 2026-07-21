'use strict';

function selectSafeApprovalChoiceId(interaction = {}) {
  const payload = interaction.payload || {};
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const safe = choices.find((choice) => choice && choice.intent === 'deny')
    || choices.find((choice) => choice && choice.intent === 'cancel');
  if (safe && typeof safe.id === 'string' && safe.id.trim()) return safe.id.trim();
  throw new Error('approval_smoke_safe_decision_unavailable');
}

function buildQuestionSettlement(payload = {}) {
  const actions = new Set(Array.isArray(payload.actions) ? payload.actions : []);
  if (actions.has('cancel')) return { action: 'cancel' };
  if (actions.has('decline')) return { action: 'decline' };
  if (actions.has('submit')) {
    return { action: 'submit', answer: buildSmokeQuestionAnswers(payload) };
  }
  throw new Error('smoke_question_action_unsupported');
}

function buildSmokeQuestionAnswers(payload = {}) {
  if (payload.answerShape === 'none') return {};
  const fields = Array.isArray(payload.fields) ? payload.fields : [];
  if (fields.length === 0) throw new Error('smoke_question_shape_unsupported');
  const entries = fields.map((field) => [field.id, smokeFieldValue(field)]);
  if (payload.answerShape === 'object') return Object.fromEntries(entries);
  if (payload.answerShape === 'answers') {
    return Object.fromEntries(entries.map(([id, value]) => [
      id,
      Array.isArray(value) ? value.map(String) : [String(value)]
    ]));
  }
  throw new Error('smoke_question_shape_unsupported');
}

function smokeFieldValue(field = {}) {
  const options = Array.isArray(field.options) ? field.options : [];
  if (field.type === 'single_select') return requiredSmokeOption(options);
  if (field.type === 'multi_select') return [requiredSmokeOption(options)];
  if (field.type === 'boolean') return false;
  if (field.type === 'number' || field.type === 'integer') return 1;
  return 'smoke';
}

function requiredSmokeOption(options) {
  const value = options[0] && String(options[0].value || '').trim();
  if (!value) throw new Error('smoke_question_option_unavailable');
  return value;
}

module.exports = {
  buildQuestionSettlement,
  buildSmokeQuestionAnswers,
  selectSafeApprovalChoiceId
};
