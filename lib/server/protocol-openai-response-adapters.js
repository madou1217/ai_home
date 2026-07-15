'use strict';

const {
  canonicalPartsToAnthropicContent,
  normalizeOpenAIContentParts
} = require('./protocol-canonical');
const {
  resolveAnthropicStopReason,
  resolveGeminiFinishReason
} = require('./protocol-finish-reason');
const {
  mapOpenAIResponseUsageToAnthropic,
  mapOpenAIResponseUsageToGemini
} = require('../protocol/token-usage');
const {
  parseToolArguments
} = require('../protocol/tool-arguments');

function toPlainText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function readOpenAIResponseOutputItems(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const output = Array.isArray(source.output) ? source.output.slice() : [];
  const outputText = toPlainText(source.output_text || '').trim();
  if (output.length === 0 && outputText) {
    output.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: outputText }]
    });
  }
  return output;
}

function resolveOpenAIResponseFinishReason(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const incompleteReason = String(
    source.incomplete_details && source.incomplete_details.reason
    || source.incomplete_reason
    || ''
  ).trim();
  if (source.status === 'incomplete' && incompleteReason) return incompleteReason;
  return source.status || '';
}

function readOpenAIResponseModel(payload, fallbackModel) {
  return toPlainText(payload && payload.model || fallbackModel || '').trim();
}

function convertOpenAIResponseToAnthropicMessage(payload, fallbackModel) {
  const content = [];
  readOpenAIResponseOutputItems(payload).forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const type = String(item.type || '').trim();
    if (type === 'message') {
      content.push(...canonicalPartsToAnthropicContent(normalizeOpenAIContentParts(item.content)));
      return;
    }
    if (type !== 'function_call') return;
    const name = toPlainText(item.name || '').trim();
    if (!name) return;
    content.push({
      type: 'tool_use',
      id: toPlainText(item.call_id || item.id || '').trim() || `toolu_${content.length + 1}`,
      name,
      input: parseToolArguments(item.arguments || '{}')
    });
  });
  const hasToolUse = content.some((part) => part && part.type === 'tool_use');
  if (content.length === 0) content.push({ type: 'text', text: '' });
  return {
    id: toPlainText(payload && payload.id || '').trim() || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: readOpenAIResponseModel(payload, fallbackModel),
    content,
    stop_reason: resolveAnthropicStopReason(resolveOpenAIResponseFinishReason(payload), { hasToolUse }),
    stop_sequence: null,
    usage: mapOpenAIResponseUsageToAnthropic(payload && payload.usage)
  };
}

function convertOpenAIResponseToGeminiGenerateContent(payload, fallbackModel) {
  const parts = [];
  readOpenAIResponseOutputItems(payload).forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const type = String(item.type || '').trim();
    if (type === 'message') {
      normalizeOpenAIContentParts(item.content).forEach((part) => {
        if (!part || part.type !== 'text') return;
        parts.push({ text: toPlainText(part.text || '') });
      });
      return;
    }
    if (type !== 'function_call') return;
    const name = toPlainText(item.name || '').trim();
    if (!name) return;
    parts.push({
      functionCall: {
        ...(item.call_id || item.id ? { id: toPlainText(item.call_id || item.id).trim() } : {}),
        name,
        args: parseToolArguments(item.arguments || '{}')
      }
    });
  });
  const usageMetadata = mapOpenAIResponseUsageToGemini(payload && payload.usage);
  return {
    candidates: [{
      content: {
        role: 'model',
        parts: parts.length > 0 ? parts : [{ text: '' }]
      },
      finishReason: resolveGeminiFinishReason(resolveOpenAIResponseFinishReason(payload), {
        hasToolCalls: parts.some((part) => part && part.functionCall)
      }),
      index: 0
    }],
    usageMetadata,
    modelVersion: readOpenAIResponseModel(payload, fallbackModel)
  };
}

module.exports = {
  convertOpenAIResponseToAnthropicMessage,
  convertOpenAIResponseToGeminiGenerateContent,
  readOpenAIResponseModel,
  readOpenAIResponseOutputItems,
  resolveOpenAIResponseFinishReason
};
