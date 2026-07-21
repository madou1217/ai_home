'use strict';

const { ChatRuntimeError } = require('./chat-runtime/contracts');
const { createNativeInteractionId } = require('./chat-runtime/native-interaction-id');

const CHOICE_FIELD_ID = 'choice';
const PROMPT_KINDS = new Set(['plan-choice', 'choice', 'confirm', 'acknowledge']);

function adaptCliPrompt(input = {}) {
  const prompt = strictPrompt(input.prompt);
  const sessionId = requiredText(input.sessionId, 'cli_interaction_session_required');
  const nativeSessionId = requiredText(input.nativeSessionId, 'cli_interaction_native_session_required');
  const correlationId = requiredText(input.correlationId, 'cli_interaction_correlation_required');
  const revision = positiveInteger(input.promptRevision, 'cli_interaction_revision_invalid');
  const interactionId = createNativeInteractionId({
    provider: 'codex',
    sessionId,
    nativeThreadId: nativeSessionId,
    nativeRequestId: `${correlationId}:${prompt.promptId}:${revision}`
  });
  return {
    interaction: {
      interactionId,
      sessionId,
      itemId: `cli-prompt:${prompt.promptId}:${revision}`,
      kind: prompt.kind === 'plan-choice' ? 'plan_confirmation' : 'question',
      revision: 1,
      payload: {
        presentation: {
          title: prompt.kind === 'plan-choice' ? 'CLI 计划确认' : 'CLI 需要你的选择',
          message: prompt.question
        },
        fields: [{
          id: CHOICE_FIELD_ID,
          label: prompt.question,
          type: 'single_select',
          required: true,
          allowOther: false,
          secret: false,
          options: prompt.options.map((option) => ({
            value: option.value,
            label: option.title,
            ...(option.description ? { description: option.description } : {})
          }))
        }],
        actions: ['submit'],
        answerShape: 'answers',
        confirmUnanswered: false
      }
    },
    route: {
      interactionId,
      promptId: prompt.promptId,
      promptRevision: revision,
      choices: new Set(prompt.options.map((option) => option.value))
    }
  };
}

function extractCliChoice(command, route) {
  const payload = command && command.payload || {};
  if (command.type !== 'interaction.answer' || payload.action !== 'submit') {
    throw new ChatRuntimeError('cli_interaction_action_unsupported', 422);
  }
  const answer = payload.answer;
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
    throw new ChatRuntimeError('cli_interaction_answer_invalid', 422);
  }
  const raw = answer[CHOICE_FIELD_ID];
  const values = Array.isArray(raw) ? raw : [raw];
  if (values.length !== 1) throw new ChatRuntimeError('cli_interaction_answer_invalid', 422);
  const choice = requiredText(values[0], 'cli_interaction_answer_invalid');
  if (!route.choices.has(choice)) {
    throw new ChatRuntimeError('cli_interaction_choice_not_available', 422);
  }
  return choice;
}

function strictPrompt(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ChatRuntimeError('cli_interaction_prompt_invalid', 422);
  }
  const provider = requiredText(input.provider, 'cli_interaction_prompt_invalid').toLowerCase();
  const kind = requiredText(input.kind, 'cli_interaction_prompt_invalid');
  if (provider !== 'codex' || !PROMPT_KINDS.has(kind)) {
    throw new ChatRuntimeError('cli_interaction_prompt_invalid', 422);
  }
  const options = Array.isArray(input.options)
    ? input.options.map(strictOption)
    : [];
  if (options.length === 0 || options.length > 20) {
    throw new ChatRuntimeError('cli_interaction_prompt_invalid', 422);
  }
  if (new Set(options.map((option) => option.value)).size !== options.length) {
    throw new ChatRuntimeError('cli_interaction_prompt_invalid', 422);
  }
  return {
    provider,
    kind,
    promptId: boundedText(input.promptId, 256, 'cli_interaction_prompt_invalid'),
    question: boundedText(input.question, 2000, 'cli_interaction_prompt_invalid'),
    options
  };
}

function strictOption(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ChatRuntimeError('cli_interaction_prompt_invalid', 422);
  }
  const option = {
    value: boundedText(input.value, 128, 'cli_interaction_prompt_invalid'),
    title: boundedText(input.title, 500, 'cli_interaction_prompt_invalid')
  };
  const description = String(input.description || '').trim();
  if (description) option.description = description.slice(0, 2000);
  return option;
}

function boundedText(value, maxLength, code) {
  const text = requiredText(value, code);
  if (text.length > maxLength) throw new ChatRuntimeError(code, 422);
  return text;
}

function requiredText(value, code) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new ChatRuntimeError(code, 422);
  return text;
}

function positiveInteger(value, code) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new ChatRuntimeError(code, 422);
  return number;
}

module.exports = {
  CHOICE_FIELD_ID,
  adaptCliPrompt,
  extractCliChoice
};
