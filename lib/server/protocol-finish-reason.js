'use strict';

function normalizeReason(value) {
  return String(value || '').trim();
}

function isLengthReason(value) {
  const reason = normalizeReason(value);
  return reason === 'length' || reason === 'max_tokens' || reason === 'MAX_TOKENS';
}

function isToolReason(value) {
  const reason = normalizeReason(value);
  return reason === 'tool_calls' || reason === 'tool_use' || reason === 'UNEXPECTED_TOOL_CALL';
}

function hasToolSignal(options = {}) {
  return Boolean(options.hasToolCalls || options.hasToolUse || options.hasToolRequest);
}

function resolveCanonicalFinishReason(reason, options = {}) {
  if (hasToolSignal(options) || isToolReason(reason)) return 'tool_calls';
  if (isLengthReason(reason)) return 'length';
  return 'stop';
}

function resolveOpenAIChatFinishReason(reason, options = {}) {
  const resolved = resolveCanonicalFinishReason(reason, options);
  if (resolved === 'length') return 'length';
  if (resolved === 'tool_calls') return 'tool_calls';
  return 'stop';
}

function resolveAnthropicStopReason(reason, options = {}) {
  const resolved = resolveCanonicalFinishReason(reason, options);
  if (resolved === 'length') return 'max_tokens';
  if (resolved === 'tool_calls') return 'tool_use';
  return 'end_turn';
}

function resolveGeminiFinishReason(reason, options = {}) {
  const resolved = resolveCanonicalFinishReason(reason, options);
  if (resolved === 'length') return 'MAX_TOKENS';
  return 'STOP';
}

module.exports = {
  hasToolSignal,
  resolveCanonicalFinishReason,
  resolveOpenAIChatFinishReason,
  resolveAnthropicStopReason,
  resolveGeminiFinishReason
};
