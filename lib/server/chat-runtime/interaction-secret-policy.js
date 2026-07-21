'use strict';

const REDACTED_SECRET_ANSWER = '[secret]';

function projectInteractionCommandForPersistence(command = {}, interaction) {
  if (
    command.type !== 'interaction.answer'
    || !command.payload
    || command.payload.action !== 'submit'
  ) {
    return command;
  }
  const answer = projectSecretAnswer(interaction, command.payload.answer);
  if (answer === command.payload.answer) return command;
  return { ...command, payload: { ...command.payload, answer } };
}

function projectInteractionResolutionForPersistence(interaction, resolution = {}) {
  if (resolution.action !== 'submit') return resolution;
  const answer = projectSecretAnswer(interaction, resolution.answer);
  return answer === resolution.answer ? resolution : { ...resolution, answer };
}

function projectSecretAnswer(interaction, answer) {
  const secretIds = secretQuestionIds(interaction);
  if (secretIds.size === 0) return answer;
  const source = asRecord(answer);
  if (!source) return REDACTED_SECRET_ANSWER;
  const projected = structuredClone(source);
  for (const id of secretIds) {
    if (!Object.prototype.hasOwnProperty.call(projected, id)) continue;
    projected[id] = maskAnswerValue(projected[id]);
  }
  return projected;
}

function secretQuestionIds(interaction) {
  const payload = interaction && interaction.payload;
  const fields = payload && Array.isArray(payload.fields) ? payload.fields : [];
  return new Set(fields.flatMap((value) => {
    const field = asRecord(value);
    const id = field && String(field.id || '').trim();
    return field && field.secret === true && id ? [id] : [];
  }));
}

function maskAnswerValue(value) {
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : [REDACTED_SECRET_ANSWER];
  }
  const source = asRecord(value);
  if (source && Array.isArray(source.answers)) {
    return {
      ...source,
      answers: source.answers.length === 0 ? [] : [REDACTED_SECRET_ANSWER]
    };
  }
  if (value === undefined || value === null || value === '') return value;
  return REDACTED_SECRET_ANSWER;
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

module.exports = {
  REDACTED_SECRET_ANSWER,
  projectInteractionCommandForPersistence,
  projectInteractionResolutionForPersistence
};
