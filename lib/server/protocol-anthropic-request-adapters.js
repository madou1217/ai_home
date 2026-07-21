'use strict';

const {
  normalizeAnthropicContentParts,
  canonicalPartsToOpenAIContent
} = require('./protocol-canonical');
const {
  addGeminiContent,
  appendOpenAIResponseFunctionCallInput,
  appendOpenAIResponseFunctionOutputInput,
  appendOpenAIResponseMessageInput,
  createGeminiGenerationConfig,
  createGeminiSystemInstruction,
  enrichGeminiToolResultPart,
  normalizeAnthropicSystem,
  removeTrailingUnansweredGeminiFunctionCallTurn,
  toPlainText
} = require('./protocol-request-helpers');
const {
  sanitizeAnthropicToolHistory
} = require('../protocol/anthropic-tool-history');
const {
  mapAnthropicToolChoiceToGemini,
  mapAnthropicToolsToGemini
} = require('../protocol/gemini-tools');
const {
  rememberToolCallRefs
} = require('../protocol/tool-call-pairing');

function mapAnthropicToolsToOpenAI(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((tool) => {
      if (!tool || typeof tool !== 'object') return null;
      const name = toPlainText(tool.name || '').trim();
      if (!name) return null;
      return {
        type: 'function',
        function: {
          name,
          description: toPlainText(tool.description || ''),
          parameters: tool.input_schema && typeof tool.input_schema === 'object'
            ? tool.input_schema
            : { type: 'object', properties: {} }
        }
      };
    })
    .filter(Boolean);
}

function mapAnthropicToolChoiceToOpenAI(toolChoice) {
  if (!toolChoice || typeof toolChoice !== 'object') return undefined;
  const type = String(toolChoice.type || '').trim();
  if (type === 'auto') return 'auto';
  if (type === 'any') return 'required';
  if (type === 'tool') {
    const name = toPlainText(toolChoice.name || '').trim();
    if (!name) return undefined;
    return {
      type: 'function',
      function: { name }
    };
  }
  return undefined;
}

function mapAnthropicToolsToOpenAIResponses(tools) {
  return mapAnthropicToolsToOpenAI(tools).map((tool) => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters
  }));
}

function mapAnthropicToolChoiceToOpenAIResponses(toolChoice) {
  if (!toolChoice || typeof toolChoice !== 'object') return undefined;
  const type = String(toolChoice.type || '').trim();
  if (type === 'auto' || type === 'none') return type;
  if (type === 'any') return 'required';
  if (type === 'tool') {
    const name = toPlainText(toolChoice.name || '').trim();
    return name ? { type: 'function', name } : undefined;
  }
  return undefined;
}

function convertAnthropicMessagesToGeminiGenerateContent(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const contents = [];
  const pendingToolCalls = [];
  sanitizeAnthropicToolHistory(source.messages).forEach((message, messageIndex) => {
    if (!message || typeof message !== 'object') return;
    const role = String(message.role || '').trim().toLowerCase() === 'assistant' ? 'model' : 'user';
    const rawParts = normalizeAnthropicContentParts(message.content);
    const toolCalls = rawParts.filter((part) => part.type === 'tool_call');
    const rememberedToolCalls = rememberToolCallRefs(toolCalls, pendingToolCalls, {
      createFallbackId: (_part, index) => `toolu_${messageIndex + 1}_${index + 1}`
    });
    const parts = rawParts.map((part) => {
      if (part.type === 'tool_call') {
        return rememberedToolCalls.shift() || part;
      }
      return enrichGeminiToolResultPart(part, pendingToolCalls);
    });
    addGeminiContent(contents, role, parts);
  });

  const out = {
    model: toPlainText(source.model || '').trim(),
    contents: removeTrailingUnansweredGeminiFunctionCallTurn(contents)
  };
  const systemInstruction = createGeminiSystemInstruction(normalizeAnthropicSystem(source.system));
  if (systemInstruction) out.systemInstruction = systemInstruction;
  const generationConfig = createGeminiGenerationConfig({
    maxOutputTokens: source.max_tokens,
    temperature: source.temperature,
    topP: source.top_p,
    topK: source.top_k,
    stopSequences: source.stop_sequences
  });
  if (generationConfig) out.generationConfig = generationConfig;
  const tools = mapAnthropicToolsToGemini(source.tools);
  if (tools.length > 0) out.tools = tools;
  const toolConfig = mapAnthropicToolChoiceToGemini(source.tool_choice);
  if (toolConfig) out.toolConfig = toolConfig;
  return out;
}

function convertAnthropicMessagesToOpenAIChat(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const messages = [];
  const system = normalizeAnthropicSystem(source.system);
  if (system) {
    messages.push({ role: 'system', content: system });
  }
  sanitizeAnthropicToolHistory(source.messages).forEach((message) => {
    if (!message || typeof message !== 'object') return;
    const role = String(message.role || '').trim().toLowerCase() === 'assistant' ? 'assistant' : 'user';
    const parts = normalizeAnthropicContentParts(message.content);
    const contentParts = parts.filter((part) => part.type === 'text' || part.type === 'image');
    const toolCalls = parts.filter((part) => part.type === 'tool_call');
    const toolResults = parts.filter((part) => part.type === 'tool_result');
    if (role === 'assistant') {
      const content = canonicalPartsToOpenAIContent(contentParts, { preferString: true });
      const outMessage = { role, content };
      if (toolCalls.length > 0) {
        outMessage.tool_calls = toolCalls.map((part, index) => ({
          id: part.id || `call_${index + 1}`,
          type: 'function',
          function: {
            name: part.name,
            arguments: part.arguments || '{}'
          }
        }));
      }
      if (contentParts.length > 0 || toolCalls.length > 0) messages.push(outMessage);
      return;
    }
    if (contentParts.length > 0) {
      messages.push({ role: 'user', content: canonicalPartsToOpenAIContent(contentParts, { preferString: true }) });
    }
    toolResults.forEach((part) => {
      messages.push({
        role: 'tool',
        tool_call_id: part.toolCallId,
        content: part.content || ''
      });
    });
  });

  const out = {
    model: toPlainText(source.model || '').trim(),
    messages,
    stream: Boolean(source.stream)
  };
  const maxTokens = Number(source.max_tokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) out.max_tokens = Math.round(maxTokens);
  const temperature = Number(source.temperature);
  if (Number.isFinite(temperature)) out.temperature = temperature;
  const topP = Number(source.top_p);
  if (Number.isFinite(topP)) out.top_p = topP;
  const stop = source.stop_sequences;
  if (Array.isArray(stop) && stop.length > 0) out.stop = stop.map((item) => toPlainText(item).trim()).filter(Boolean);
  const tools = mapAnthropicToolsToOpenAI(source.tools);
  if (tools.length > 0) out.tools = tools;
  const toolChoice = mapAnthropicToolChoiceToOpenAI(source.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  return out;
}

function convertAnthropicMessagesToOpenAIResponses(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const input = [];
  const pendingToolCalls = [];
  sanitizeAnthropicToolHistory(source.messages).forEach((message, messageIndex) => {
    if (!message || typeof message !== 'object') return;
    const role = String(message.role || '').trim().toLowerCase() === 'assistant' ? 'assistant' : 'user';
    const parts = normalizeAnthropicContentParts(message.content);
    appendOpenAIResponseMessageInput(input, role, parts.filter((part) => part.type === 'text' || part.type === 'image'));
    const rememberedToolCalls = rememberToolCallRefs(
      parts.filter((part) => part.type === 'tool_call'),
      pendingToolCalls,
      { createFallbackId: (_part, index) => `call_${messageIndex + 1}_${index + 1}` }
    );
    rememberedToolCalls.forEach((part, index) => (
      appendOpenAIResponseFunctionCallInput(input, part, `call_${messageIndex + 1}_${index + 1}`)
    ));
    parts
      .filter((part) => part.type === 'tool_result')
      .forEach((part) => appendOpenAIResponseFunctionOutputInput(input, part, pendingToolCalls));
  });

  const out = {
    model: toPlainText(source.model || '').trim(),
    input,
    stream: Boolean(source.stream)
  };
  const instructions = normalizeAnthropicSystem(source.system);
  if (instructions) out.instructions = instructions;
  const maxTokens = Number(source.max_tokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) out.max_output_tokens = Math.round(maxTokens);
  const temperature = Number(source.temperature);
  if (Number.isFinite(temperature)) out.temperature = temperature;
  const topP = Number(source.top_p);
  if (Number.isFinite(topP)) out.top_p = topP;
  if (Array.isArray(source.stop_sequences) && source.stop_sequences.length > 0) {
    out.stop = source.stop_sequences.map((item) => toPlainText(item).trim()).filter(Boolean);
  }
  const tools = mapAnthropicToolsToOpenAIResponses(source.tools);
  if (tools.length > 0) out.tools = tools;
  const toolChoice = mapAnthropicToolChoiceToOpenAIResponses(source.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  return out;
}

module.exports = {
  convertAnthropicMessagesToGeminiGenerateContent,
  convertAnthropicMessagesToOpenAIChat,
  convertAnthropicMessagesToOpenAIResponses,
  __private: {
    mapAnthropicToolChoiceToOpenAI,
    mapAnthropicToolChoiceToOpenAIResponses,
    mapAnthropicToolsToOpenAI,
    mapAnthropicToolsToOpenAIResponses
  }
};
