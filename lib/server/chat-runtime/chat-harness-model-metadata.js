'use strict';

const { CHAT_INSTRUCTIONS } = require('./chat-harness-policy');

// Provider capabilities come from the pinned catalog. Tool/prompt defaults are
// Harness policy, not borrowed capabilities or instructions from a GPT model.
function projectHarnessModelMetadata(model, metadata = {}) {
  const contextWindow = metadata.limits && (metadata.limits.input || metadata.limits.context);
  return {
    slug: model.model,
    display_name: metadata.name || model.displayName,
    description: `AIH gateway model ${model.model}`,
    default_reasoning_level: model.defaultReasoningEffort || null,
    supported_reasoning_levels: model.supportedReasoningEfforts.map((effort) => ({ effort, description: effort })),
    shell_type: 'disabled',
    visibility: 'list',
    supported_in_api: true,
    priority: 0,
    availability_nux: null,
    upgrade: null,
    model_messages: { instructions_template: CHAT_INSTRUCTIONS },
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    truncation_policy: { mode: 'tokens', limit: 10000 },
    experimental_supported_tools: [],
    input_modalities: (metadata.modalities && metadata.modalities.input || ['text'])
      .filter((modality) => modality === 'text' || modality === 'image'),
    ...(contextWindow ? { context_window: contextWindow, max_context_window: contextWindow } : {})
  };
}

module.exports = { projectHarnessModelMetadata };
