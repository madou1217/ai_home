'use strict';

const {
  canonicalPartsToGeminiParts,
  canonicalPartsToOpenAIContent
} = require('./protocol-canonical');
const {
  resolveToolResultId,
  resolveToolResultRef
} = require('../protocol/tool-call-pairing');

function toPlainText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function normalizeAnthropicSystem(system) {
  if (typeof system === 'string') return system.trim();
  if (!Array.isArray(system)) return '';
  return system
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text') return toPlainText(part.text || '');
      return '';
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function createGeminiSystemInstruction(text) {
  const safeText = toPlainText(text || '').trim();
  return safeText ? { parts: [{ text: safeText }] } : null;
}

function createGeminiGenerationConfig(values = {}) {
  const config = {};
  const maxOutputTokens = Number(values.maxOutputTokens);
  if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
    config.maxOutputTokens = Math.round(maxOutputTokens);
  }
  const temperature = Number(values.temperature);
  if (Number.isFinite(temperature)) config.temperature = temperature;
  const topP = Number(values.topP);
  if (Number.isFinite(topP)) config.topP = topP;
  const topK = Number(values.topK);
  if (Number.isFinite(topK)) config.topK = topK;
  if (Array.isArray(values.stopSequences) && values.stopSequences.length > 0) {
    config.stopSequences = values.stopSequences.map((item) => toPlainText(item).trim()).filter(Boolean);
  } else if (typeof values.stopSequences === 'string' && values.stopSequences.trim()) {
    config.stopSequences = [values.stopSequences.trim()];
  }
  return Object.keys(config).length > 0 ? config : null;
}

function orderGeminiModelParts(parts) {
  const thoughtParts = [];
  const regularParts = [];
  const functionCallParts = [];
  (Array.isArray(parts) ? parts : []).forEach((part) => {
    if (!part || typeof part !== 'object') return;
    if (part.thought === true) {
      thoughtParts.push(part);
      return;
    }
    if (part.functionCall || part.function_call) {
      functionCallParts.push(part);
      return;
    }
    regularParts.push(part);
  });
  return [...thoughtParts, ...regularParts, ...functionCallParts];
}

function orderGeminiPartsForRole(role, parts) {
  const normalizedParts = Array.isArray(parts) ? parts : [];
  const normalizedRole = String(role || '').trim().toLowerCase();
  if (normalizedRole !== 'model') return normalizedParts;
  if (!normalizedParts.some((part) => part && (part.functionCall || part.function_call))) return normalizedParts;
  return orderGeminiModelParts(normalizedParts);
}

function removeEmptyGeminiTextParts(parts) {
  return (Array.isArray(parts) ? parts : []).filter((part) => {
    if (!part || typeof part !== 'object') return false;
    if (Object.prototype.hasOwnProperty.call(part, 'text')) {
      return toPlainText(part.text).length > 0;
    }
    return true;
  });
}

function addGeminiContent(contents, role, parts, options = {}) {
  const geminiParts = orderGeminiPartsForRole(role, removeEmptyGeminiTextParts(canonicalPartsToGeminiParts(parts)));
  if (geminiParts.length === 0) return;
  if (options.mergeAdjacent === true) {
    const last = contents[contents.length - 1];
    if (last && last.role === role && Array.isArray(last.parts)) {
      last.parts = orderGeminiPartsForRole(role, [...last.parts, ...geminiParts]);
      return;
    }
  }
  contents.push({ role, parts: geminiParts });
}

function hasGeminiFunctionCallPart(part) {
  return Boolean(part && typeof part === 'object' && (part.functionCall || part.function_call));
}

function removeTrailingUnansweredGeminiFunctionCallTurn(contents) {
  const list = Array.isArray(contents) ? contents : [];
  const last = list[list.length - 1];
  if (!last || last.role !== 'model' || !Array.isArray(last.parts)) return list;
  if (!last.parts.some(hasGeminiFunctionCallPart)) return list;
  const parts = last.parts.filter((part) => !hasGeminiFunctionCallPart(part));
  if (parts.length === 0) return list.slice(0, -1);
  return [
    ...list.slice(0, -1),
    { ...last, parts }
  ];
}

function addAnthropicMessage(messages, role, content, options = {}) {
  const parts = Array.isArray(content) ? content.filter(Boolean) : [];
  if (parts.length === 0) return;
  if (options.mergeAdjacent === true) {
    const last = messages[messages.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) {
      // Anthropic API: assistant 消息中 text 必须在 tool_use 之前。
      // 如果当前要合并的是纯文本且已有 tool_use 块，插入到第一个 tool_use 之前
      if (role === 'assistant' && parts.every(function (p) { return p && p.type === 'text'; })) {
        var toolIdx = last.content.findIndex(function (p) { return p && p.type === 'tool_use'; });
        if (toolIdx >= 0) {
          last.content.splice.apply(last.content, [toolIdx, 0].concat(parts));
          return;
        }
      }
      last.content.push.apply(last.content, parts);
      return;
    }
  }
  messages.push({ role, content: parts });
}

function enrichGeminiToolResultPart(part, pendingToolCalls) {
  if (!part || part.type !== 'tool_result') return part;
  const ref = resolveToolResultRef(part, pendingToolCalls);
  return {
    ...part,
    ...(ref.id ? { toolCallId: ref.id } : {}),
    ...(ref.name ? { name: ref.name } : {})
  };
}

function mapCanonicalPartToOpenAIResponseContent(part, role) {
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'text') {
    return {
      type: role === 'assistant' ? 'output_text' : 'input_text',
      text: toPlainText(part.text || '')
    };
  }
  if (part.type !== 'image') return null;
  const content = canonicalPartsToOpenAIContent([part], { preferString: false })[0];
  if (!content || content.type !== 'image_url') return null;
  const imageUrl = content.image_url && typeof content.image_url === 'object'
    ? content.image_url.url
    : content.image_url;
  const safeUrl = toPlainText(imageUrl || '').trim();
  return safeUrl ? { type: 'input_image', image_url: safeUrl } : null;
}

function appendOpenAIResponseMessageInput(input, role, parts) {
  const content = (Array.isArray(parts) ? parts : [])
    .map((part) => mapCanonicalPartToOpenAIResponseContent(part, role))
    .filter(Boolean);
  if (content.length === 0) return;
  input.push({
    type: 'message',
    role,
    content
  });
}

function appendOpenAIResponseFunctionCallInput(input, part, fallbackId) {
  const name = toPlainText(part && part.name || '').trim();
  if (!name) return;
  input.push({
    type: 'function_call',
    call_id: toPlainText(part && part.id || '').trim() || fallbackId,
    name,
    arguments: toPlainText(part && part.arguments || '{}').trim() || '{}'
  });
}

function appendOpenAIResponseFunctionOutputInput(input, part, pendingToolCalls) {
  const explicitId = toPlainText(part && part.toolCallId || '').trim();
  const name = toPlainText(part && part.name || '').trim();
  const toolCallId = resolveToolResultId(part, pendingToolCalls) || explicitId || name;
  if (!toolCallId) return;
  input.push({
    type: 'function_call_output',
    call_id: toolCallId,
    output: toPlainText(part && part.content || '').trim()
  });
}

module.exports = {
  addAnthropicMessage,
  addGeminiContent,
  appendOpenAIResponseFunctionCallInput,
  appendOpenAIResponseFunctionOutputInput,
  appendOpenAIResponseMessageInput,
  createGeminiGenerationConfig,
  createGeminiSystemInstruction,
  enrichGeminiToolResultPart,
  normalizeAnthropicSystem,
  removeTrailingUnansweredGeminiFunctionCallTurn,
  toPlainText,
  __private: {
    hasGeminiFunctionCallPart,
    mapCanonicalPartToOpenAIResponseContent,
    orderGeminiModelParts,
    orderGeminiPartsForRole,
    removeEmptyGeminiTextParts
  }
};
