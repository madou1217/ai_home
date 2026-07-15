'use strict';

const {
  normalizeOpenAIContentParts,
  canonicalPartsToAnthropicContent,
  readTextFromCanonicalParts
} = require('./protocol-canonical');
const {
  addGeminiContent,
  createGeminiGenerationConfig,
  createGeminiSystemInstruction,
  enrichGeminiToolResultPart,
  removeTrailingUnansweredGeminiFunctionCallTurn,
  toPlainText
} = require('./protocol-request-helpers');
const {
  sanitizeAnthropicToolHistory
} = require('../protocol/anthropic-tool-history');
const {
  mapOpenAIToolChoiceToGemini,
  mapOpenAIToolsToGemini
} = require('../protocol/gemini-tools');
const {
  rememberToolCallRefs
} = require('../protocol/tool-call-pairing');
const {
  parseToolArguments
} = require('../protocol/tool-arguments');

function readOpenAIContentText(content) {
  return readTextFromCanonicalParts(normalizeOpenAIContentParts(content));
}

function mapOpenAIToolsToAnthropic(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((tool) => {
      if (!tool || tool.type !== 'function') return null;
      const fn = tool.function && typeof tool.function === 'object' ? tool.function : {};
      const name = toPlainText(fn.name || '').trim();
      if (!name) return null;
      return {
        name,
        description: toPlainText(fn.description || ''),
        input_schema: fn.parameters && typeof fn.parameters === 'object'
          ? fn.parameters
          : { type: 'object', properties: {} }
      };
    })
    .filter(Boolean);
}

function mapOpenAIToolChoiceToAnthropic(toolChoice) {
  if (toolChoice === undefined) return undefined;
  if (typeof toolChoice === 'string') {
    const type = toolChoice.trim().toLowerCase();
    if (!type || type === 'auto') return { type: 'auto' };
    if (type === 'required' || type === 'any') return { type: 'any' };
    if (type === 'none') return { type: 'none' };
    return undefined;
  }
  if (!toolChoice || typeof toolChoice !== 'object') return undefined;
  const type = toPlainText(toolChoice.type || '').trim().toLowerCase();
  if (!type || type === 'auto') return { type: 'auto' };
  if (type === 'required' || type === 'any') return { type: 'any' };
  if (type === 'none') return { type: 'none' };
  if (type === 'function' || type === 'tool') {
    const fn = toolChoice.function && typeof toolChoice.function === 'object'
      ? toolChoice.function
      : toolChoice;
    const name = toPlainText(fn.name || '').trim();
    return name ? { type: 'tool', name } : undefined;
  }
  return undefined;
}

function convertOpenAIChatToGeminiGenerateContent(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const systemParts = [];
  const contents = [];
  const pendingToolCalls = [];
  (Array.isArray(source.messages) ? source.messages : []).forEach((message, messageIndex) => {
    if (!message || typeof message !== 'object') return;
    const rawRole = String(message.role || '').trim().toLowerCase();
    if (rawRole === 'system') {
      const content = readTextFromCanonicalParts(normalizeOpenAIContentParts(message.content)).trim();
      if (content) systemParts.push(content);
      return;
    }
    if (rawRole === 'tool') {
      const toolResult = enrichGeminiToolResultPart({
        type: 'tool_result',
        toolCallId: toPlainText(message.tool_call_id || '').trim(),
        name: toPlainText(message.name || '').trim(),
        content: readOpenAIContentText(message.content).trim()
      }, pendingToolCalls);
      addGeminiContent(contents, 'user', [toolResult], { mergeAdjacent: true });
      return;
    }

    const role = rawRole === 'assistant' ? 'model' : 'user';
    const parts = normalizeOpenAIContentParts(message.content);
    if (rawRole === 'assistant' && Array.isArray(message.tool_calls)) {
      const toolParts = message.tool_calls
        .map((toolCall, index) => {
          if (!toolCall || toolCall.type !== 'function') return null;
          const fn = toolCall.function && typeof toolCall.function === 'object' ? toolCall.function : {};
          const name = toPlainText(fn.name || '').trim();
          if (!name) return null;
          return {
            type: 'tool_call',
            id: toPlainText(toolCall.id || '').trim() || `call_${messageIndex + 1}_${index + 1}`,
            name,
            arguments: toPlainText(fn.arguments || '{}').trim() || '{}'
          };
        })
        .filter(Boolean);
      parts.push(...rememberToolCallRefs(toolParts, pendingToolCalls));
    }
    addGeminiContent(contents, role, parts, { mergeAdjacent: true });
  });

  const out = {
    model: toPlainText(source.model || '').trim(),
    contents: removeTrailingUnansweredGeminiFunctionCallTurn(contents)
  };
  const systemInstruction = createGeminiSystemInstruction(systemParts.join('\n\n'));
  if (systemInstruction) out.systemInstruction = systemInstruction;
  const stopSequences = Array.isArray(source.stop)
    ? source.stop
    : typeof source.stop === 'string' && source.stop.trim()
      ? [source.stop]
      : [];
  const generationConfig = createGeminiGenerationConfig({
    maxOutputTokens: source.max_tokens || source.max_completion_tokens,
    temperature: source.temperature,
    topP: source.top_p,
    stopSequences
  });
  if (generationConfig) out.generationConfig = generationConfig;
  const tools = mapOpenAIToolsToGemini(source.tools);
  if (tools.length > 0) out.tools = tools;
  const toolConfig = mapOpenAIToolChoiceToGemini(source.tool_choice);
  if (toolConfig) out.toolConfig = toolConfig;
  return out;
}

function convertOpenAIChatToAnthropicMessages(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const systemParts = [];
  const messages = [];
  (Array.isArray(source.messages) ? source.messages : []).forEach((message) => {
    if (!message || typeof message !== 'object') return;
    const rawRole = String(message.role || '').trim().toLowerCase();
    if (rawRole === 'tool') {
      const toolCallId = toPlainText(message.tool_call_id || '').trim();
      if (!toolCallId) return;
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolCallId,
          content: readOpenAIContentText(message.content).trim()
        }]
      });
      return;
    }
    const parts = normalizeOpenAIContentParts(message.content)
      .filter((part) => part.type !== 'text' || toPlainText(part.text || '').trim());
    if (rawRole === 'system') {
      const content = readTextFromCanonicalParts(parts).trim();
      if (content) systemParts.push(content);
      return;
    }
    const content = canonicalPartsToAnthropicContent(parts);
    if (rawRole === 'assistant' && Array.isArray(message.tool_calls)) {
      message.tool_calls.forEach((toolCall, index) => {
        if (!toolCall || toolCall.type !== 'function') return;
        const fn = toolCall.function && typeof toolCall.function === 'object' ? toolCall.function : {};
        const name = toPlainText(fn.name || '').trim();
        if (!name) return;
        content.push({
          type: 'tool_use',
          id: toPlainText(toolCall.id || '').trim() || `toolu_${index + 1}`,
          name,
          input: parseToolArguments(fn.arguments || '{}')
        });
      });
    }
    if (content.length === 0) return;
    messages.push({
      role: rawRole === 'assistant' ? 'assistant' : 'user',
      content
    });
  });
  const out = {
    model: toPlainText(source.model || '').trim(),
    max_tokens: Math.max(1, Math.round(Number(source.max_tokens || source.max_completion_tokens || 4096))),
    messages: sanitizeAnthropicToolHistory(messages),
    stream: Boolean(source.stream)
  };
  if (systemParts.length > 0) out.system = systemParts.join('\n\n');
  const temperature = Number(source.temperature);
  if (Number.isFinite(temperature)) out.temperature = temperature;
  const topP = Number(source.top_p);
  if (Number.isFinite(topP)) out.top_p = topP;
  if (Array.isArray(source.stop) && source.stop.length > 0) {
    out.stop_sequences = source.stop.map((item) => toPlainText(item).trim()).filter(Boolean);
  } else if (typeof source.stop === 'string' && source.stop.trim()) {
    out.stop_sequences = [source.stop.trim()];
  }
  const tools = mapOpenAIToolsToAnthropic(source.tools);
  if (tools.length > 0) out.tools = tools;
  const toolChoice = mapOpenAIToolChoiceToAnthropic(source.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  return out;
}

module.exports = {
  convertOpenAIChatToAnthropicMessages,
  convertOpenAIChatToGeminiGenerateContent,
  mapOpenAIToolChoiceToAnthropic,
  mapOpenAIToolsToAnthropic,
  __private: {
    readOpenAIContentText
  }
};
