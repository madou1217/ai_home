'use strict';

const {
  canonicalPartsToAnthropicContent,
  canonicalPartsToGeminiParts,
  normalizeAnthropicContentParts,
  normalizeGeminiContentParts,
  normalizeOpenAIContentParts
} = require('./protocol-canonical');
const {
  resolveCanonicalFinishReason,
  resolveOpenAIChatFinishReason,
  resolveAnthropicStopReason,
  resolveGeminiFinishReason
} = require('./protocol-finish-reason');

const CANONICAL_RESPONSE_PROTOCOL = 'aih_canonical_response';

function toText(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function createUsage(inputTokens, outputTokens, totalTokens) {
  const input = toNumber(inputTokens);
  const output = toNumber(outputTokens);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: toNumber(totalTokens) || input + output
  };
}

function ensureParts(parts) {
  const normalized = Array.isArray(parts) ? parts.filter(Boolean) : [];
  return normalized.length > 0 ? normalized : [{ type: 'text', text: '' }];
}

function readModel(payload, fallbackModel) {
  return toText(
    payload && (payload.model || payload.modelVersion || payload.model_version)
    || payload && payload.response && (
      payload.response.model
      || payload.response.modelVersion
      || payload.response.model_version
    )
    || fallbackModel
    || ''
  ).trim();
}

function readFirstOpenAIChatChoice(payload) {
  return payload
    && Array.isArray(payload.choices)
    && payload.choices[0]
    ? payload.choices[0]
    : null;
}

function readOpenAIChatChoiceMessage(choice) {
  return choice && choice.message && typeof choice.message === 'object'
    ? choice.message
    : {};
}

function readAnthropicMessageContent(payload) {
  return Array.isArray(payload && payload.content) ? payload.content : [];
}

function readGeminiResponseCandidate(payload) {
  const direct = payload && Array.isArray(payload.candidates) ? payload.candidates : null;
  const wrapped = payload && payload.response && Array.isArray(payload.response.candidates)
    ? payload.response.candidates
    : null;
  const candidates = direct || wrapped || [];
  return candidates[0] && typeof candidates[0] === 'object' ? candidates[0] : {};
}

function readOpenAIResponseOutputItems(payload) {
  const output = Array.isArray(payload && payload.output) ? payload.output.slice() : [];
  const outputText = toText(payload && payload.output_text || '').trim();
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
  const incompleteReason = toText(
    payload
    && payload.incomplete_details
    && payload.incomplete_details.reason
    || payload
    && payload.incomplete_reason
    || ''
  ).trim();
  return payload && payload.status === 'incomplete' && incompleteReason
    ? incompleteReason
    : toText(payload && payload.status || '');
}

function parseOpenAIChatResponse(payload, context = {}) {
  const choice = readFirstOpenAIChatChoice(payload);
  const message = readOpenAIChatChoiceMessage(choice);
  const parts = [];
  const reasoning = toText(message.reasoning_content || '');
  if (reasoning) parts.push({ type: 'thinking', text: reasoning });
  parts.push(...normalizeOpenAIContentParts(message.content));
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  toolCalls.forEach((toolCall, index) => {
    if (!toolCall || toolCall.type !== 'function') return;
    const fn = toolCall.function && typeof toolCall.function === 'object'
      ? toolCall.function
      : {};
    const name = toText(fn.name || '').trim();
    if (!name) return;
    parts.push({
      type: 'tool_call',
      id: toText(toolCall.id || '').trim() || `call_${index + 1}`,
      name,
      arguments: toText(fn.arguments || '{}').trim() || '{}'
    });
  });
  const usage = payload && payload.usage && typeof payload.usage === 'object'
    ? payload.usage
    : {};
  return {
    id: toText(payload && payload.id || '').trim(),
    createdAt: toNumber(payload && payload.created),
    model: readModel(payload, context.fallbackModel),
    candidateIndex: toNumber(choice && choice.index),
    parts: ensureParts(parts),
    finishReason: resolveCanonicalFinishReason(choice && choice.finish_reason, {
      hasToolCalls: toolCalls.length > 0
    }),
    status: 'completed',
    usage: createUsage(
      usage.prompt_tokens,
      usage.completion_tokens,
      usage.total_tokens
    )
  };
}

function parseAnthropicResponse(payload, context = {}) {
  const parts = [];
  readAnthropicMessageContent(payload).forEach((part) => {
    if (!part || typeof part !== 'object') return;
    if (part.type === 'thinking') {
      parts.push({
        type: 'thinking',
        text: toText(part.thinking || part.text || ''),
        signature: toText(part.signature || '').trim()
      });
      return;
    }
    parts.push(...normalizeAnthropicContentParts([part]));
  });
  const usage = payload && payload.usage && typeof payload.usage === 'object'
    ? payload.usage
    : {};
  const hasToolCalls = parts.some((part) => part.type === 'tool_call');
  return {
    id: toText(payload && payload.id || '').trim(),
    createdAt: 0,
    model: readModel(payload, context.fallbackModel),
    candidateIndex: 0,
    parts: ensureParts(parts),
    finishReason: resolveCanonicalFinishReason(payload && payload.stop_reason, {
      hasToolCalls
    }),
    status: 'completed',
    usage: createUsage(usage.input_tokens, usage.output_tokens)
  };
}

function readGeminiParts(payload) {
  const candidate = readGeminiResponseCandidate(payload);
  const content = candidate.content && typeof candidate.content === 'object'
    ? candidate.content
    : {};
  return (Array.isArray(content.parts) ? content.parts : []).flatMap((part) => {
    if (part && part.thought && typeof part.text === 'string') {
      return [{
        type: 'thinking',
        text: part.text,
        signature: toText(part.thoughtSignature || part.thought_signature || '').trim()
      }];
    }
    return normalizeGeminiContentParts([part]);
  });
}

function readGeminiUsage(payload) {
  if (payload && payload.usageMetadata && typeof payload.usageMetadata === 'object') {
    return payload.usageMetadata;
  }
  if (payload && payload.response
    && payload.response.usageMetadata
    && typeof payload.response.usageMetadata === 'object') {
    return payload.response.usageMetadata;
  }
  return {};
}

function parseGeminiResponse(payload, context = {}) {
  const candidate = readGeminiResponseCandidate(payload);
  const parts = ensureParts(readGeminiParts(payload));
  const usage = readGeminiUsage(payload);
  return {
    id: toText(payload && payload.id || '').trim(),
    createdAt: 0,
    model: readModel(payload, context.fallbackModel),
    candidateIndex: toNumber(candidate.index),
    parts,
    finishReason: resolveCanonicalFinishReason(candidate.finishReason, {
      hasToolCalls: parts.some((part) => part.type === 'tool_call')
    }),
    status: 'completed',
    usage: createUsage(
      usage.promptTokenCount || usage.prompt_token_count,
      usage.candidatesTokenCount || usage.candidates_token_count,
      usage.totalTokenCount || usage.total_token_count
    )
  };
}

function parseOpenAIResponse(payload, context = {}) {
  const parts = [];
  readOpenAIResponseOutputItems(payload).forEach((item, itemIndex) => {
    if (!item || typeof item !== 'object') return;
    const type = toText(item.type || '').trim();
    if (type === 'message') {
      parts.push(...normalizeOpenAIContentParts(item.content));
      return;
    }
    if (type === 'reasoning') {
      const summary = Array.isArray(item.summary) ? item.summary : [];
      summary.forEach((entry) => {
        const text = toText(entry && entry.text || '');
        if (text) parts.push({ type: 'thinking', text });
      });
      return;
    }
    if (type !== 'function_call') return;
    const name = toText(item.name || '').trim();
    if (!name) return;
    parts.push({
      type: 'tool_call',
      id: toText(item.call_id || item.id || '').trim() || `call_${itemIndex + 1}`,
      name,
      arguments: toText(item.arguments || '{}').trim() || '{}'
    });
  });
  const usage = payload && payload.usage && typeof payload.usage === 'object'
    ? payload.usage
    : {};
  const incompleteDetails = payload
    && payload.incomplete_details
    && typeof payload.incomplete_details === 'object'
    ? { ...payload.incomplete_details }
    : null;
  const hasToolCalls = parts.some((part) => part.type === 'tool_call');
  return {
    id: toText(payload && payload.id || '').trim(),
    createdAt: toNumber(payload && payload.created_at),
    model: readModel(payload, context.fallbackModel),
    candidateIndex: 0,
    parts: ensureParts(parts),
    finishReason: resolveCanonicalFinishReason(resolveOpenAIResponseFinishReason(payload), {
      hasToolCalls
    }),
    status: payload && payload.status === 'incomplete' ? 'incomplete' : 'completed',
    incompleteDetails,
    usage: createUsage(
      usage.input_tokens || usage.prompt_tokens,
      usage.output_tokens || usage.completion_tokens,
      usage.total_tokens
    )
  };
}

const RESPONSE_PARSERS = Object.freeze({
  anthropic_messages: parseAnthropicResponse,
  gemini_generate_content: parseGeminiResponse,
  gemini_stream_generate_content: parseGeminiResponse,
  openai_chat: parseOpenAIChatResponse,
  openai_responses: parseOpenAIResponse
});

function parseProtocolResponseToCanonical(protocol, payload, context = {}) {
  const parser = RESPONSE_PARSERS[toText(protocol).trim()];
  return typeof parser === 'function' ? parser(payload || {}, context) : null;
}

function textFromParts(parts) {
  return (Array.isArray(parts) ? parts : [])
    .filter((part) => part && part.type === 'text')
    .map((part) => toText(part.text || ''))
    .join('');
}

function thinkingFromParts(parts) {
  return (Array.isArray(parts) ? parts : [])
    .filter((part) => part && part.type === 'thinking')
    .map((part) => toText(part.text || ''))
    .join('');
}

function toolCallParts(parts) {
  return (Array.isArray(parts) ? parts : [])
    .filter((part) => part && part.type === 'tool_call' && toText(part.name).trim());
}

function renderOpenAIChatResponse(canonical, context = {}) {
  const toolCalls = toolCallParts(canonical.parts);
  const message = {
    role: 'assistant',
    content: textFromParts(canonical.parts)
  };
  const reasoning = thinkingFromParts(canonical.parts);
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((part, index) => ({
      id: toText(part.id || '').trim() || `call_${index + 1}`,
      type: 'function',
      function: {
        name: toText(part.name).trim(),
        arguments: toText(part.arguments || '{}').trim() || '{}'
      }
    }));
  }
  const now = typeof context.clock === 'function' ? context.clock() : Date.now();
  return {
    id: canonical.id || `chatcmpl_${now}`,
    object: 'chat.completion',
    created: canonical.createdAt || Math.floor(now / 1000),
    model: canonical.model,
    choices: [{
      index: canonical.candidateIndex || 0,
      message,
      finish_reason: resolveOpenAIChatFinishReason(canonical.finishReason, {
        hasToolCalls: toolCalls.length > 0
      })
    }],
    usage: {
      prompt_tokens: canonical.usage.inputTokens,
      completion_tokens: canonical.usage.outputTokens,
      total_tokens: canonical.usage.totalTokens
    }
  };
}

function renderAnthropicResponse(canonical, context = {}) {
  const content = [];
  canonical.parts.forEach((part) => {
    if (part.type === 'thinking') {
      const signature = toText(part.signature || '').trim();
      if (signature) {
        content.push({
          type: 'thinking',
          thinking: toText(part.text || ''),
          signature
        });
      }
      return;
    }
    content.push(...canonicalPartsToAnthropicContent([part], {
      normalizeToolInputs: true
    }));
  });
  if (content.length === 0) content.push({ type: 'text', text: '' });
  const now = typeof context.clock === 'function' ? context.clock() : Date.now();
  const hasToolUse = content.some((part) => part.type === 'tool_use');
  return {
    id: canonical.id || `msg_${now}`,
    type: 'message',
    role: 'assistant',
    model: canonical.model,
    content,
    stop_reason: resolveAnthropicStopReason(canonical.finishReason, { hasToolUse }),
    stop_sequence: null,
    usage: {
      input_tokens: canonical.usage.inputTokens,
      output_tokens: canonical.usage.outputTokens
    }
  };
}

function renderGeminiResponse(canonical) {
  const parts = canonical.parts.flatMap((part) => {
    if (part.type === 'thinking') {
      const signature = toText(part.signature || '').trim();
      return [{
        thought: true,
        text: toText(part.text || ''),
        ...(signature ? { thoughtSignature: signature } : {})
      }];
    }
    return canonicalPartsToGeminiParts([part]);
  });
  const hasToolCalls = canonical.parts.some((part) => part.type === 'tool_call');
  return {
    candidates: [{
      content: {
        role: 'model',
        parts: parts.length > 0 ? parts : [{ text: '' }]
      },
      finishReason: resolveGeminiFinishReason(canonical.finishReason, { hasToolCalls }),
      index: canonical.candidateIndex || 0
    }],
    usageMetadata: {
      promptTokenCount: canonical.usage.inputTokens,
      candidatesTokenCount: canonical.usage.outputTokens,
      totalTokenCount: canonical.usage.totalTokens
    },
    modelVersion: canonical.model
  };
}

function renderOpenAIResponse(canonical, context = {}) {
  const output = [];
  const text = textFromParts(canonical.parts);
  const toolCalls = toolCallParts(canonical.parts);
  const now = typeof context.clock === 'function' ? context.clock() : Date.now();
  if (text || toolCalls.length === 0) {
    output.push({
      id: `msg_${now}`,
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
  toolCalls.forEach((part, index) => {
    const callId = toText(part.id || '').trim() || `call_${index + 1}`;
    output.push({
      id: `fc_${callId}`,
      type: 'function_call',
      status: 'completed',
      call_id: callId,
      name: toText(part.name).trim(),
      arguments: toText(part.arguments || '{}').trim() || '{}'
    });
  });
  return {
    id: canonical.id || `resp_${now}`,
    object: 'response',
    created_at: canonical.createdAt || Math.floor(now / 1000),
    status: canonical.status,
    model: canonical.model,
    output,
    incomplete_details: canonical.incompleteDetails || null,
    usage: {
      input_tokens: canonical.usage.inputTokens,
      output_tokens: canonical.usage.outputTokens,
      total_tokens: canonical.usage.totalTokens
    }
  };
}

const RESPONSE_RENDERERS = Object.freeze({
  anthropic_messages: renderAnthropicResponse,
  gemini_generate_content: renderGeminiResponse,
  gemini_stream_generate_content: renderGeminiResponse,
  openai_chat: renderOpenAIChatResponse,
  openai_responses: renderOpenAIResponse
});

function renderCanonicalResponse(protocol, canonical, context = {}) {
  const renderer = RESPONSE_RENDERERS[toText(protocol).trim()];
  return typeof renderer === 'function' ? renderer(canonical, context) : null;
}

function convertProtocolResponseViaCanonical(input = {}) {
  const sourceProtocol = toText(input.sourceProtocol).trim();
  const targetProtocol = toText(input.targetProtocol).trim();
  const context = input.context && typeof input.context === 'object' ? input.context : {};
  const canonical = parseProtocolResponseToCanonical(
    sourceProtocol,
    input.payload,
    context
  );
  if (!canonical) return null;
  const payload = renderCanonicalResponse(targetProtocol, canonical, context);
  if (!payload) return null;
  return {
    sourceProtocol,
    targetProtocol,
    canonicalProtocol: CANONICAL_RESPONSE_PROTOCOL,
    canonical,
    payload,
    adapters: [
      `${sourceProtocol}->${CANONICAL_RESPONSE_PROTOCOL}`,
      `${CANONICAL_RESPONSE_PROTOCOL}->${targetProtocol}`
    ]
  };
}

module.exports = {
  CANONICAL_RESPONSE_PROTOCOL,
  convertProtocolResponseViaCanonical,
  parseProtocolResponseToCanonical,
  renderCanonicalResponse
};
