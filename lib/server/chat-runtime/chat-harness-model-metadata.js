'use strict';

const { CHAT_INSTRUCTIONS } = require('./chat-harness-policy');

// Provider capabilities come from the pinned catalog. Tool/prompt defaults are
// Harness policy, not borrowed capabilities or instructions from a GPT model.
function projectHarnessModelMetadata(model, metadata = {}) {
  const contextWindow = metadata.limits && (metadata.limits.input || metadata.limits.context);
  // 目录明确声明的模态从其声明（text-only 模型保持 text-only）；目录查不到的
  // provider 自定义 id（如 claude-opus-4-6-thinking）不能默认 text-only——否则
  // harness 会在本地拦掉图片/视频帧附件，而网关侧 vision-image-guard 本就负责
  // 给真正的非视觉模型降级。未知模型按 text+image 放行，由上游/网关裁决。
  const declared = metadata.modalities && metadata.modalities.input;
  const inputModalities = (Array.isArray(declared) && declared.length ? declared : ['text', 'image'])
    .filter((modality) => modality === 'text' || modality === 'image');
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
    input_modalities: inputModalities.length ? inputModalities : ['text'],
    ...(contextWindow ? { context_window: contextWindow, max_context_window: contextWindow } : {})
  };
}

module.exports = { projectHarnessModelMetadata };
