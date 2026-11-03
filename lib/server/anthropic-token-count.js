'use strict';

function estimateTextTokens(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return 0;
  return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 4));
}

function estimateJsonTokens(value) {
  if (value === undefined || value === null) return 0;
  try {
    return estimateTextTokens(JSON.stringify(value));
  } catch (_error) {
    return 0;
  }
}

function estimateContentBlockTokens(block) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    return estimateContentTokens(block);
  }
  const type = String(block.type || '').trim();
  if (type === 'text' || type === 'input_text') return estimateTextTokens(block.text);
  if (type === 'tool_result') return estimateContentTokens(block.content) + estimateTextTokens(block.tool_use_id);
  if (type === 'tool_use') return estimateTextTokens(block.name) + estimateJsonTokens(block.input);
  if (type === 'image' || type === 'document') return 85;
  return estimateJsonTokens(block);
}

function estimateContentTokens(content) {
  if (Array.isArray(content)) {
    return content.reduce((sum, item) => sum + estimateContentBlockTokens(item), 0);
  }
  if (content && typeof content === 'object') return estimateContentBlockTokens(content);
  return estimateTextTokens(content);
}

function estimateMessageTokens(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return estimateContentTokens(message);
  }
  return 4
    + estimateTextTokens(message.role)
    + estimateTextTokens(message.name)
    + estimateContentTokens(message.content);
}

function estimateAnthropicInputTokens(payload = {}) {
  const request = payload && typeof payload === 'object' ? payload : {};
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const messageTokens = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  const systemTokens = request.system ? estimateContentTokens(request.system) + 4 : 0;
  const toolsTokens = Array.isArray(request.tools) && request.tools.length > 0
    ? estimateJsonTokens(request.tools) + 4
    : 0;
  const toolChoiceTokens = request.tool_choice ? estimateJsonTokens(request.tool_choice) : 0;
  return Math.max(1, messageTokens + systemTokens + toolsTokens + toolChoiceTokens);
}

function createAnthropicTokenCountResponse(payload = {}) {
  return {
    input_tokens: estimateAnthropicInputTokens(payload)
  };
}

module.exports = {
  createAnthropicTokenCountResponse,
  estimateAnthropicInputTokens,
  __private: {
    estimateContentBlockTokens,
    estimateContentTokens,
    estimateJsonTokens,
    estimateMessageTokens,
    estimateTextTokens
  }
};
