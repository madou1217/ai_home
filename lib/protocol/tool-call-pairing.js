'use strict';

function toPlainText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function readValue(input, reader) {
  if (typeof reader !== 'function') return '';
  return reader(input);
}

function rememberToolCallRefs(toolCalls, pendingToolCalls, options = {}) {
  const readId = typeof options.readId === 'function'
    ? options.readId
    : (part) => part && part.id;
  const readName = typeof options.readName === 'function'
    ? options.readName
    : (part) => part && part.name;
  const createFallbackId = options.createFallbackId;
  return (Array.isArray(toolCalls) ? toolCalls : []).map((part, index) => {
    if (!part || typeof part !== 'object') return null;
    const name = toPlainText(readValue(part, readName)).trim();
    const rawId = readValue(part, readId) || (typeof createFallbackId === 'function' ? createFallbackId(part, index) : '');
    const id = toPlainText(rawId).trim();
    if (Array.isArray(pendingToolCalls) && (name || id)) pendingToolCalls.push({ name, id });
    return { ...part, name, id };
  }).filter(Boolean);
}

function takePendingToolCallRef(pendingToolCalls, predicate) {
  if (!Array.isArray(pendingToolCalls) || pendingToolCalls.length === 0) return null;
  const index = pendingToolCalls.findIndex(predicate);
  if (index < 0) return null;
  const match = pendingToolCalls[index];
  pendingToolCalls.splice(index, 1);
  return match || null;
}

function resolveToolResultRef(part, pendingToolCalls, options = {}) {
  const explicitId = toPlainText(readValue(part, options.readId || ((value) => value && value.toolCallId))).trim();
  const explicitName = toPlainText(readValue(part, options.readName || ((value) => value && (value.name || value.toolName)))).trim();
  if (explicitId) {
    const match = takePendingToolCallRef(pendingToolCalls, (call) => call && call.id === explicitId);
    return {
      id: explicitId,
      name: explicitName || toPlainText(match && match.name || '').trim() || explicitId
    };
  }
  if (explicitName) {
    const match = takePendingToolCallRef(pendingToolCalls, (call) => call && call.name === explicitName);
    return {
      id: toPlainText(match && match.id || '').trim(),
      name: explicitName
    };
  }
  const next = takePendingToolCallRef(pendingToolCalls, (call) => call && (call.id || call.name));
  return {
    id: toPlainText(next && next.id || '').trim(),
    name: toPlainText(next && next.name || '').trim()
  };
}

function resolveToolResultId(part, pendingToolCalls, options = {}) {
  const ref = resolveToolResultRef(part, pendingToolCalls, options);
  return ref.id || ref.name || '';
}

function readOpenAIResponseFunctionCallId(item, itemIndex) {
  return toPlainText(item && (item.call_id || item.id) || '').trim() || `call_${itemIndex + 1}`;
}

function resolveOpenAIResponseFunctionOutputId(item, pendingToolCallIds) {
  const explicitId = toPlainText(item && (item.call_id || item.id) || '').trim();
  if (explicitId) {
    if (Array.isArray(pendingToolCallIds)) {
      const index = pendingToolCallIds.indexOf(explicitId);
      if (index >= 0) pendingToolCallIds.splice(index, 1);
    }
    return explicitId;
  }
  if (!Array.isArray(pendingToolCallIds) || pendingToolCallIds.length === 0) return '';
  return pendingToolCallIds.shift();
}

module.exports = {
  readOpenAIResponseFunctionCallId,
  rememberToolCallRefs,
  resolveOpenAIResponseFunctionOutputId,
  resolveToolResultId,
  resolveToolResultRef,
  takePendingToolCallRef
};
