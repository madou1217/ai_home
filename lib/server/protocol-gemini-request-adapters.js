'use strict';

const {
  normalizeGeminiContentParts,
  canonicalPartsToOpenAIContent,
  canonicalPartsToAnthropicContent,
  readTextFromCanonicalParts
} = require('./protocol-canonical');
const {
  sanitizeAnthropicToolHistory
} = require('../protocol/anthropic-tool-history');
const {
  mapGeminiToolConfigToAnthropic,
  mapGeminiToolConfigToOpenAI,
  mapGeminiToolConfigToOpenAIResponses,
  mapGeminiToolsToAnthropic,
  mapGeminiToolsToOpenAI,
  mapGeminiToolsToOpenAIResponses
} = require('../protocol/gemini-tools');
const {
  rememberToolCallRefs,
  resolveToolResultId
} = require('../protocol/tool-call-pairing');
const {
  parseToolArguments
} = require('../protocol/tool-arguments');
const {
  appendOpenAIResponseFunctionCallInput,
  appendOpenAIResponseFunctionOutputInput,
  appendOpenAIResponseMessageInput,
  toPlainText
} = require('./protocol-request-helpers');

function extractGeminiModelFromPath(pathname) {
  const match = String(pathname || '').match(/^\/v1(?:beta)?\/models\/([^/]+):(?:generateContent|streamGenerateContent)$/);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch (_error) {
    return match[1];
  }
}

function readGeminiPartText(parts) {
  return readTextFromCanonicalParts(normalizeGeminiContentParts(parts));
}

function normalizeGeminiSystemInstruction(systemInstruction) {
  if (!systemInstruction || typeof systemInstruction !== 'object') return '';
  return readGeminiPartText(systemInstruction.parts).trim();
}

function convertGeminiGenerateContentToOpenAIChat(payload, pathname, stream = false) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const messages = [];
  const pendingToolCalls = [];
  let nextToolCallIndex = 1;
  const system = normalizeGeminiSystemInstruction(source.systemInstruction);
  if (system) messages.push({ role: 'system', content: system });
  (Array.isArray(source.contents) ? source.contents : []).forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const role = String(item.role || '').trim().toLowerCase() === 'model' ? 'assistant' : 'user';
    const parts = normalizeGeminiContentParts(item.parts);
    const contentParts = parts.filter((part) => part.type === 'text' || part.type === 'image');
    const toolCalls = parts.filter((part) => part.type === 'tool_call');
    const toolResults = parts.filter((part) => part.type === 'tool_result');
    if (contentParts.length > 0) {
      messages.push({ role, content: canonicalPartsToOpenAIContent(contentParts, { preferString: true }) });
    }
    if (role === 'assistant' && toolCalls.length > 0) {
      const rememberedToolCalls = rememberToolCallRefs(toolCalls, pendingToolCalls, {
        createFallbackId: () => `call_${nextToolCallIndex++}`
      });
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: rememberedToolCalls.map((part) => ({
          id: part.id,
          type: 'function',
          function: {
            name: part.name,
            arguments: part.arguments || '{}'
          }
        }))
      });
    }
    if (role === 'user') {
      toolResults.forEach((part) => {
        const toolCallId = resolveToolResultId(part, pendingToolCalls);
        messages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: part.content || '{}'
        });
      });
    }
  });
  const generationConfig = source.generationConfig && typeof source.generationConfig === 'object'
    ? source.generationConfig
    : {};
  const out = {
    model: extractGeminiModelFromPath(pathname),
    messages,
    stream: Boolean(stream)
  };
  const maxTokens = Number(generationConfig.maxOutputTokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) out.max_tokens = Math.round(maxTokens);
  const temperature = Number(generationConfig.temperature);
  if (Number.isFinite(temperature)) out.temperature = temperature;
  const topP = Number(generationConfig.topP);
  if (Number.isFinite(topP)) out.top_p = topP;
  const stop = generationConfig.stopSequences;
  if (Array.isArray(stop) && stop.length > 0) out.stop = stop.map((item) => toPlainText(item).trim()).filter(Boolean);
  const tools = mapGeminiToolsToOpenAI(source.tools);
  if (tools.length > 0) out.tools = tools;
  const toolChoice = mapGeminiToolConfigToOpenAI(source.toolConfig);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  return out;
}

function convertGeminiGenerateContentToAnthropicMessages(payload, pathname, stream = false) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const messages = [];
  const pendingToolCalls = [];
  let nextToolUseIndex = 1;
  (Array.isArray(source.contents) ? source.contents : []).forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const role = String(item.role || '').trim().toLowerCase() === 'model' ? 'assistant' : 'user';
    const parts = normalizeGeminiContentParts(item.parts);
    const content = [];
    const contentParts = parts.filter((part) => part.type === 'text' || part.type === 'image');
    const toolCalls = parts.filter((part) => part.type === 'tool_call');
    const toolResults = parts.filter((part) => part.type === 'tool_result');
    content.push(...canonicalPartsToAnthropicContent(contentParts));
    if (role === 'assistant') {
      const rememberedToolCalls = rememberToolCallRefs(toolCalls, pendingToolCalls, {
        createFallbackId: () => `toolu_${nextToolUseIndex++}`
      });
      rememberedToolCalls.forEach((part) => {
        const name = toPlainText(part.name || '').trim();
        if (!name) return;
        content.push({
          type: 'tool_use',
          id: part.id,
          name,
          input: parseToolArguments(part.arguments || '{}')
        });
      });
    } else {
      toolResults.forEach((part) => {
        const toolCallId = resolveToolResultId(part, pendingToolCalls);
        if (!toolCallId) return;
        content.push({
          type: 'tool_result',
          tool_use_id: toolCallId,
          content: toPlainText(part.content || '').trim()
        });
      });
    }
    if (content.length > 0) messages.push({ role, content });
  });

  const generationConfig = source.generationConfig && typeof source.generationConfig === 'object'
    ? source.generationConfig
    : {};
  const out = {
    model: extractGeminiModelFromPath(pathname),
    max_tokens: Math.max(1, Math.round(Number(generationConfig.maxOutputTokens || 4096))),
    messages: sanitizeAnthropicToolHistory(messages),
    stream: Boolean(stream)
  };
  const system = normalizeGeminiSystemInstruction(source.systemInstruction);
  if (system) out.system = system;
  const temperature = Number(generationConfig.temperature);
  if (Number.isFinite(temperature)) out.temperature = temperature;
  const topP = Number(generationConfig.topP);
  if (Number.isFinite(topP)) out.top_p = topP;
  const topK = Number(generationConfig.topK);
  if (Number.isFinite(topK)) out.top_k = topK;
  const stop = generationConfig.stopSequences;
  if (Array.isArray(stop) && stop.length > 0) {
    out.stop_sequences = stop.map((item) => toPlainText(item).trim()).filter(Boolean);
  }
  const tools = mapGeminiToolsToAnthropic(source.tools);
  if (tools.length > 0) out.tools = tools;
  const toolChoice = mapGeminiToolConfigToAnthropic(source.toolConfig);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  return out;
}

function convertGeminiGenerateContentToOpenAIResponses(payload, pathname, stream = false) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const input = [];
  const pendingToolCalls = [];
  let nextToolCallIndex = 1;
  (Array.isArray(source.contents) ? source.contents : []).forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const role = String(item.role || '').trim().toLowerCase() === 'model' ? 'assistant' : 'user';
    const parts = normalizeGeminiContentParts(item.parts);
    appendOpenAIResponseMessageInput(input, role, parts.filter((part) => part.type === 'text' || part.type === 'image'));
    if (role === 'assistant') {
      rememberToolCallRefs(
        parts.filter((part) => part.type === 'tool_call'),
        pendingToolCalls,
        { createFallbackId: () => `call_${nextToolCallIndex++}` }
      ).forEach((part) => appendOpenAIResponseFunctionCallInput(input, part, part.id || `call_${nextToolCallIndex++}`));
    } else {
      parts
        .filter((part) => part.type === 'tool_result')
        .forEach((part) => appendOpenAIResponseFunctionOutputInput(input, part, pendingToolCalls));
    }
  });

  const generationConfig = source.generationConfig && typeof source.generationConfig === 'object'
    ? source.generationConfig
    : {};
  const out = {
    model: extractGeminiModelFromPath(pathname),
    input,
    stream: Boolean(stream)
  };
  const instructions = normalizeGeminiSystemInstruction(source.systemInstruction);
  if (instructions) out.instructions = instructions;
  const maxTokens = Number(generationConfig.maxOutputTokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) out.max_output_tokens = Math.round(maxTokens);
  const temperature = Number(generationConfig.temperature);
  if (Number.isFinite(temperature)) out.temperature = temperature;
  const topP = Number(generationConfig.topP);
  if (Number.isFinite(topP)) out.top_p = topP;
  const stop = generationConfig.stopSequences;
  if (Array.isArray(stop) && stop.length > 0) {
    out.stop = stop.map((item) => toPlainText(item).trim()).filter(Boolean);
  }
  const tools = mapGeminiToolsToOpenAIResponses(source.tools);
  if (tools.length > 0) out.tools = tools;
  const toolChoice = mapGeminiToolConfigToOpenAIResponses(source.toolConfig);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  return out;
}

module.exports = {
  extractGeminiModelFromPath,
  convertGeminiGenerateContentToAnthropicMessages,
  convertGeminiGenerateContentToOpenAIChat,
  convertGeminiGenerateContentToOpenAIResponses,
  __private: {
    normalizeGeminiSystemInstruction
  }
};
