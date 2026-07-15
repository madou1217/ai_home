'use strict';

const {
  canonicalPartsToAnthropicContent,
  readTextFromCanonicalParts,
  normalizeGeminiContentParts
} = require('./protocol-canonical');
const {
  resolveOpenAIChatFinishReason,
  resolveAnthropicStopReason
} = require('./protocol-finish-reason');
const {
  mapGeminiResponseUsageToAnthropic,
  mapGeminiResponseUsageToOpenAIChat,
  mapGeminiResponseUsageToOpenAIResponse
} = require('../protocol/token-usage');

function toPlainText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function readGeminiResponseCandidate(payload) {
  // cloudcode-pa(agy/antigravity) 把候选包在 { response: { candidates: [...] } } 里，
  // 而 Gemini 公有 API 直接给 { candidates: [...] }。两种形状都要认，否则 agy 走 generateContent
  // 时候选读不到 → 输出空 text block（0 token）。与 http-utils.extractGeminiCandidates 保持一致。
  const direct = payload && Array.isArray(payload.candidates) ? payload.candidates : null;
  const wrapped = payload && payload.response && Array.isArray(payload.response.candidates)
    ? payload.response.candidates
    : null;
  const candidates = direct || wrapped || [];
  return candidates[0] && typeof candidates[0] === 'object' ? candidates[0] : {};
}

function readGeminiResponseParts(payload) {
  const candidate = readGeminiResponseCandidate(payload);
  const content = candidate.content && typeof candidate.content === 'object' ? candidate.content : {};
  return normalizeGeminiContentParts(content.parts);
}

function readGeminiResponseUsageMetadata(payload) {
  // 同候选一样，usageMetadata 在 cloudcode-pa 形状里位于 payload.response.usageMetadata。
  if (payload && payload.usageMetadata && typeof payload.usageMetadata === 'object') {
    return payload.usageMetadata;
  }
  if (payload && payload.response && payload.response.usageMetadata && typeof payload.response.usageMetadata === 'object') {
    return payload.response.usageMetadata;
  }
  return undefined;
}

function readGeminiResponseModel(payload, fallbackModel) {
  return toPlainText(
    payload && (payload.modelVersion || payload.model || payload.model_version)
    || fallbackModel
    || ''
  ).trim();
}

function convertGeminiGenerateContentResponseToAnthropicMessage(payload, fallbackModel) {
  const candidate = readGeminiResponseCandidate(payload);
  const parts = readGeminiResponseParts(payload);
  const content = canonicalPartsToAnthropicContent(parts, { normalizeToolInputs: true });
  const hasToolUse = parts.some((part) => part && part.type === 'tool_call');
  if (content.length === 0) content.push({ type: 'text', text: '' });
  return {
    id: toPlainText(payload && payload.id || '').trim() || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: readGeminiResponseModel(payload, fallbackModel),
    content,
    stop_reason: resolveAnthropicStopReason(candidate.finishReason, { hasToolUse }),
    stop_sequence: null,
    usage: mapGeminiResponseUsageToAnthropic(readGeminiResponseUsageMetadata(payload))
  };
}

function convertGeminiGenerateContentResponseToOpenAIChatCompletion(payload, fallbackModel) {
  const candidate = readGeminiResponseCandidate(payload);
  const parts = readGeminiResponseParts(payload);
  const contentParts = parts.filter((part) => part.type === 'text');
  const toolCallParts = parts.filter((part) => part.type === 'tool_call');
  const message = {
    role: 'assistant',
    content: readTextFromCanonicalParts(contentParts)
  };
  if (toolCallParts.length > 0) {
    message.tool_calls = toolCallParts.map((part, index) => ({
      id: toPlainText(part.id || '').trim() || `call_${index + 1}`,
      type: 'function',
      function: {
        name: toPlainText(part.name || '').trim(),
        arguments: toPlainText(part.arguments || '{}').trim() || '{}'
      }
    }));
  }
  return {
    id: toPlainText(payload && payload.id || '').trim() || `chatcmpl_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: readGeminiResponseModel(payload, fallbackModel),
    choices: [{
      index: Number(candidate.index || 0),
      message,
      finish_reason: resolveOpenAIChatFinishReason(candidate.finishReason, {
        hasToolCalls: toolCallParts.length > 0
      })
    }],
    usage: mapGeminiResponseUsageToOpenAIChat(readGeminiResponseUsageMetadata(payload))
  };
}

function convertGeminiGenerateContentResponseToOpenAIResponse(payload, fallbackModel) {
  const candidate = readGeminiResponseCandidate(payload);
  const parts = readGeminiResponseParts(payload);
  const output = [];
  const text = readTextFromCanonicalParts(parts.filter((part) => part.type === 'text'));
  if (text || parts.every((part) => part && part.type !== 'tool_call')) {
    output.push({
      id: `msg_${Date.now()}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text,
        annotations: []
      }]
    });
  }
  parts.forEach((part, index) => {
    if (!part || part.type !== 'tool_call') return;
    const name = toPlainText(part.name || '').trim();
    if (!name) return;
    const callId = toPlainText(part.id || '').trim() || `call_${index + 1}`;
    output.push({
      id: `fc_${callId}`,
      type: 'function_call',
      status: 'completed',
      call_id: callId,
      name,
      arguments: toPlainText(part.arguments || '{}').trim() || '{}'
    });
  });
  const usage = mapGeminiResponseUsageToOpenAIResponse(readGeminiResponseUsageMetadata(payload));
  return {
    id: toPlainText(payload && payload.id || '').trim() || `resp_${Date.now()}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: readGeminiResponseModel(payload, fallbackModel),
    output,
    incomplete_details: null,
    usage,
    finish_reason: resolveOpenAIChatFinishReason(candidate.finishReason, {
      hasToolCalls: parts.some((part) => part && part.type === 'tool_call')
    })
  };
}

module.exports = {
  convertGeminiGenerateContentResponseToAnthropicMessage,
  convertGeminiGenerateContentResponseToOpenAIChatCompletion,
  convertGeminiGenerateContentResponseToOpenAIResponse,
  readGeminiResponseCandidate,
  readGeminiResponseModel,
  readGeminiResponseParts
};
