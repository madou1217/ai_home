'use strict';

const {
  normalizeOpenAIContentParts,
  canonicalPartsToOpenAIContent,
  canonicalPartsToAnthropicContent,
  readTextFromCanonicalParts
} = require('./protocol-canonical');
const {
  resolveOpenAIChatFinishReason,
  resolveAnthropicStopReason,
  resolveGeminiFinishReason
} = require('./protocol-finish-reason');
const { detectClientProtocol } = require('./protocol-registry');
const { convertSseViaCanonical } = require('./protocol-stream-pipeline');
const {
  normalizeProtocolId,
  PROTOCOL_REQUEST_ADAPTERS,
  listProtocolRequestAdapters,
  resolveProtocolRequestAdapter,
  resolveProtocolRequestAdapterPath
} = require('./protocol-request-adapter-registry');
const {
  sanitizeAnthropicToolHistory
} = require('../protocol/anthropic-tool-history');
const {
  mapOpenAIToolChoiceToGemini,
  mapOpenAIToolsToGemini
} = require('../protocol/gemini-tools');
const {
  readOpenAIResponseFunctionCallId,
  rememberToolCallRefs,
  resolveOpenAIResponseFunctionOutputId
} = require('../protocol/tool-call-pairing');
const {
  parseToolArguments
} = require('../protocol/tool-arguments');
const {
  parseAnthropicSseEvents,
  parseOpenAISseChunks
} = require('../protocol/sse-parser');
const {
  convertAnthropicMessageToGeminiGenerateContent,
  convertAnthropicMessageToOpenAIChatCompletion,
  convertAnthropicMessageToOpenAIResponse
} = require('./protocol-anthropic-response-adapters');
const {
  convertGeminiGenerateContentResponseToAnthropicMessage,
  convertGeminiGenerateContentResponseToOpenAIChatCompletion,
  convertGeminiGenerateContentResponseToOpenAIResponse
} = require('./protocol-gemini-response-adapters');
const {
  convertOpenAIChatCompletionToAnthropicMessage,
  convertOpenAIChatCompletionToGeminiGenerateContent,
  convertOpenAIChatCompletionToOpenAIResponse
} = require('./protocol-openai-chat-response-adapters');
const {
  convertOpenAIResponseToAnthropicMessage,
  convertOpenAIResponseToGeminiGenerateContent
} = require('./protocol-openai-response-adapters');
const {
  convertAnthropicMessagesToGeminiGenerateContent,
  convertAnthropicMessagesToOpenAIChat,
  convertAnthropicMessagesToOpenAIResponses
} = require('./protocol-anthropic-request-adapters');
const {
  convertOpenAIChatToAnthropicMessages,
  convertOpenAIChatToGeminiGenerateContent,
  mapOpenAIToolChoiceToAnthropic,
  mapOpenAIToolsToAnthropic
} = require('./protocol-openai-chat-request-adapters');
const {
  extractGeminiModelFromPath,
  convertGeminiGenerateContentToAnthropicMessages,
  convertGeminiGenerateContentToOpenAIChat,
  convertGeminiGenerateContentToOpenAIResponses
} = require('./protocol-gemini-request-adapters');
const {
  addAnthropicMessage,
  addGeminiContent,
  appendOpenAIResponseFunctionCallInput,
  appendOpenAIResponseFunctionOutputInput,
  appendOpenAIResponseMessageInput,
  createGeminiGenerationConfig,
  createGeminiSystemInstruction,
  enrichGeminiToolResultPart,
  removeTrailingUnansweredGeminiFunctionCallTurn,
  toPlainText
} = require('./protocol-request-helpers');

function mapResponsesToolsToOpenAI(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((tool) => {
      if (!tool || typeof tool !== 'object') return null;
      if (tool.type !== 'function') return null;
      if (tool.function && typeof tool.function === 'object') return tool;
      const name = toPlainText(tool.name || '').trim();
      if (!name) return null;
      return {
        type: 'function',
        function: {
          name,
          description: toPlainText(tool.description || ''),
          parameters: tool.parameters && typeof tool.parameters === 'object'
            ? tool.parameters
            : { type: 'object', properties: {} }
        }
      };
    })
    .filter(Boolean);
}

function mapResponsesToolChoiceToOpenAI(toolChoice) {
  if (toolChoice === undefined) return undefined;
  if (typeof toolChoice === 'string') return toolChoice;
  if (!toolChoice || typeof toolChoice !== 'object') return undefined;
  const type = toPlainText(toolChoice.type || '').trim().toLowerCase();
  if (type === 'auto' || type === 'none' || type === 'required') return type;
  if (type === 'any') return 'required';
  if (toolChoice.type === 'function' && toolChoice.function && typeof toolChoice.function === 'object') {
    return toolChoice;
  }
  if (type === 'function') {
    const name = toPlainText(toolChoice.name || '').trim();
    if (!name) return undefined;
    return { type: 'function', function: { name } };
  }
  return undefined;
}

function mapResponsesToolsToGemini(tools) {
  return mapOpenAIToolsToGemini(mapResponsesToolsToOpenAI(tools));
}

function mapResponsesToolChoiceToGemini(toolChoice) {
  return mapOpenAIToolChoiceToGemini(mapResponsesToolChoiceToOpenAI(toolChoice));
}

function convertOpenAIResponsesToOpenAIChat(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const messages = [];
  const pendingToolCallIds = [];
  const instructions = toPlainText(source.instructions || '').trim();
  if (instructions) messages.push({ role: 'system', content: instructions });
  if (typeof source.input === 'string') {
    const text = source.input.trim();
    if (text) messages.push({ role: 'user', content: text });
  } else if (Array.isArray(source.input)) {
    source.input.forEach((item, itemIndex) => {
      if (typeof item === 'string') {
        const text = item.trim();
        if (text) messages.push({ role: 'user', content: text });
        return;
      }
      if (!item || typeof item !== 'object') return;
      const itemType = String(item.type || '').trim();
      if (itemType === 'function_call') {
        const name = toPlainText(item.name || '').trim();
        if (!name) return;
        const callId = readOpenAIResponseFunctionCallId(item, itemIndex);
        pendingToolCallIds.push(callId);
        messages.push({
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: callId,
            type: 'function',
            function: {
              name,
              arguments: toPlainText(item.arguments || '{}').trim() || '{}'
            }
          }]
        });
        return;
      }
      if (itemType === 'function_call_output') {
        const toolCallId = resolveOpenAIResponseFunctionOutputId(item, pendingToolCallIds);
        if (!toolCallId) return;
        messages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: toPlainText(item.output || '').trim()
        });
        return;
      }
      const rawRole = String(item.role || '').trim().toLowerCase();
      const role = rawRole === 'assistant' || rawRole === 'system' ? rawRole : 'user';
      const parts = normalizeOpenAIContentParts(item.content);
      if (parts.length > 0) messages.push({ role, content: canonicalPartsToOpenAIContent(parts, { preferString: true }) });
    });
  }
  const out = {
    model: toPlainText(source.model || '').trim(),
    messages,
    stream: Boolean(source.stream)
  };
  const maxTokens = Number(source.max_output_tokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) out.max_tokens = Math.round(maxTokens);
  const temperature = Number(source.temperature);
  if (Number.isFinite(temperature)) out.temperature = temperature;
  const topP = Number(source.top_p);
  if (Number.isFinite(topP)) out.top_p = topP;
  const tools = mapResponsesToolsToOpenAI(source.tools);
  if (tools.length > 0) out.tools = tools;
  const toolChoice = mapResponsesToolChoiceToOpenAI(source.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  return out;
}

function convertOpenAIResponsesToGeminiGenerateContent(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const contents = [];
  const pendingToolCalls = [];
  const systemParts = [];
  if (typeof source.input === 'string') {
    const text = source.input.trim();
    if (text) addGeminiContent(contents, 'user', [{ type: 'text', text }]);
  } else if (Array.isArray(source.input)) {
    source.input.forEach((item, itemIndex) => {
      if (typeof item === 'string') {
        const text = item.trim();
        if (text) addGeminiContent(contents, 'user', [{ type: 'text', text }], { mergeAdjacent: true });
        return;
      }
      if (!item || typeof item !== 'object') return;
      const itemType = String(item.type || '').trim();
      if (itemType === 'function_call') {
        const name = toPlainText(item.name || '').trim();
        if (!name) return;
        const part = {
          type: 'tool_call',
          id: readOpenAIResponseFunctionCallId(item, itemIndex),
          name,
          arguments: toPlainText(item.arguments || '{}').trim() || '{}'
        };
        addGeminiContent(contents, 'model', rememberToolCallRefs([part], pendingToolCalls), { mergeAdjacent: true });
        return;
      }
      if (itemType === 'function_call_output') {
        const part = enrichGeminiToolResultPart({
          type: 'tool_result',
          toolCallId: toPlainText(item.call_id || item.id || '').trim(),
          name: toPlainText(item.name || '').trim(),
          content: toPlainText(item.output || '').trim()
        }, pendingToolCalls);
        addGeminiContent(contents, 'user', [part], { mergeAdjacent: true });
        return;
      }
      const rawRole = String(item.role || '').trim().toLowerCase();
      if (rawRole === 'system') {
        const content = readTextFromCanonicalParts(normalizeOpenAIContentParts(item.content)).trim();
        if (content) systemParts.push(content);
        return;
      }
      const role = rawRole === 'assistant' ? 'model' : 'user';
      const parts = normalizeOpenAIContentParts(item.content);
      addGeminiContent(contents, role, parts, { mergeAdjacent: true });
    });
  }

  const out = {
    model: toPlainText(source.model || '').trim(),
    contents: removeTrailingUnansweredGeminiFunctionCallTurn(contents)
  };
  const instructions = [toPlainText(source.instructions || '').trim(), ...systemParts].filter(Boolean).join('\n\n');
  const systemInstruction = createGeminiSystemInstruction(instructions);
  if (systemInstruction) out.systemInstruction = systemInstruction;
  const generationConfig = createGeminiGenerationConfig({
    maxOutputTokens: source.max_output_tokens,
    temperature: source.temperature,
    topP: source.top_p,
    stopSequences: source.stop
  });
  if (generationConfig) out.generationConfig = generationConfig;
  const tools = mapResponsesToolsToGemini(source.tools);
  if (tools.length > 0) out.tools = tools;
  const toolConfig = mapResponsesToolChoiceToGemini(source.tool_choice);
  if (toolConfig) out.toolConfig = toolConfig;
  return out;
}

function convertOpenAIResponsesToAnthropicMessages(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const messages = [];
  const systemParts = [];
  const pendingToolCallIds = [];
  if (typeof source.input === 'string') {
    const text = source.input.trim();
    if (text) messages.push({ role: 'user', content: [{ type: 'text', text }] });
  } else if (Array.isArray(source.input)) {
    source.input.forEach((item, itemIndex) => {
      if (typeof item === 'string') {
        const text = item.trim();
        if (text) messages.push({ role: 'user', content: [{ type: 'text', text }] });
        return;
      }
      if (!item || typeof item !== 'object') return;
      const itemType = String(item.type || '').trim();
      if (itemType === 'function_call_output') {
        const toolCallId = resolveOpenAIResponseFunctionOutputId(item, pendingToolCallIds);
        if (!toolCallId) return;
        addAnthropicMessage(messages, 'user', [{
          type: 'tool_result',
          tool_use_id: toolCallId,
          content: toPlainText(item.output || '').trim()
        }], { mergeAdjacent: true });
        return;
      }
      if (itemType === 'function_call') {
        const name = toPlainText(item.name || '').trim();
        if (!name) return;
        const callId = readOpenAIResponseFunctionCallId(item, itemIndex);
        pendingToolCallIds.push(callId);
        addAnthropicMessage(messages, 'assistant', [{
          type: 'tool_use',
          id: callId,
          name,
          input: parseToolArguments(item.arguments || '{}')
        }], { mergeAdjacent: true });
        return;
      }
      const rawRole = String(item.role || '').trim().toLowerCase();
      if (rawRole === 'system') {
        const content = readTextFromCanonicalParts(normalizeOpenAIContentParts(item.content)).trim();
        if (content) systemParts.push(content);
        return;
      }
      const role = rawRole === 'assistant' ? 'assistant' : 'user';
      const content = canonicalPartsToAnthropicContent(normalizeOpenAIContentParts(item.content));
      addAnthropicMessage(messages, role, content, { mergeAdjacent: true });
    });
  }

  const out = {
    model: toPlainText(source.model || '').trim(),
    max_tokens: Math.max(1, Math.round(Number(source.max_output_tokens || 4096))),
    messages: sanitizeAnthropicToolHistory(messages),
    stream: Boolean(source.stream)
  };
  const instructions = [toPlainText(source.instructions || '').trim(), ...systemParts]
    .filter(Boolean)
    .join('\n\n');
  if (instructions) out.system = instructions;
  const temperature = Number(source.temperature);
  if (Number.isFinite(temperature)) out.temperature = temperature;
  const topP = Number(source.top_p);
  if (Number.isFinite(topP)) out.top_p = topP;
  const tools = mapOpenAIToolsToAnthropic(mapResponsesToolsToOpenAI(source.tools));
  if (tools.length > 0) out.tools = tools;
  const toolChoice = mapOpenAIToolChoiceToAnthropic(mapResponsesToolChoiceToOpenAI(source.tool_choice));
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  return out;
}

function mapOpenAIFinishReasonToAnthropic(reason) {
  return resolveAnthropicStopReason(reason);
}

function mapAnthropicStopReasonToOpenAI(reason) {
  return resolveOpenAIChatFinishReason(reason);
}

function mapOpenAIFinishReasonToGemini(reason) {
  return resolveGeminiFinishReason(reason);
}

function convertOpenAIChatSseToAnthropicSse(rawText, fallbackModel) {
  return convertSseViaCanonical('openai_chat', 'anthropic_messages', rawText, fallbackModel);
}

function convertAnthropicSseToOpenAIChatSse(rawText, fallbackModel) {
  return convertSseViaCanonical('anthropic_messages', 'openai_chat', rawText, fallbackModel);
}

function convertOpenAIChatSseToGeminiSse(rawText, fallbackModel) {
  return convertSseViaCanonical('openai_chat', 'gemini_stream_generate_content', rawText, fallbackModel);
}

function convertOpenAIChatSseToOpenAIResponseSse(rawText, fallbackModel) {
  return convertSseViaCanonical('openai_chat', 'openai_responses', rawText, fallbackModel);
}

function passThroughProtocolPayload(payload) {
  return payload;
}

const PROTOCOL_REQUEST_ADAPTER_FUNCTIONS = Object.freeze({
  claude2codexAdapter: (payload) => convertAnthropicMessagesToOpenAIResponses(payload),
  claude2geminiAdapter: (payload) => convertAnthropicMessagesToGeminiGenerateContent(payload),
  claude2geminiStreamAdapter: (payload) => convertAnthropicMessagesToGeminiGenerateContent(payload),
  claude2openaiChatAdapter: (payload) => convertAnthropicMessagesToOpenAIChat(payload),
  codex2claudeAdapter: (payload) => convertOpenAIResponsesToAnthropicMessages(payload),
  codex2geminiAdapter: (payload) => convertOpenAIResponsesToGeminiGenerateContent(payload),
  codex2geminiStreamAdapter: (payload) => convertOpenAIResponsesToGeminiGenerateContent(payload),
  codex2openaiChatAdapter: (payload) => convertOpenAIResponsesToOpenAIChat(payload),
  gemini2claudeAdapter: (payload, context = {}) => convertGeminiGenerateContentToAnthropicMessages(
    payload,
    context.pathname || context.requestPathname || '',
    Boolean(context.stream)
  ),
  gemini2codexAdapter: (payload, context = {}) => convertGeminiGenerateContentToOpenAIResponses(
    payload,
    context.pathname || context.requestPathname || '',
    Boolean(context.stream)
  ),
  gemini2geminiStreamAdapter: (payload) => passThroughProtocolPayload(payload),
  gemini2openaiChatAdapter: (payload, context = {}) => convertGeminiGenerateContentToOpenAIChat(
    payload,
    context.pathname || context.requestPathname || '',
    Boolean(context.stream)
  ),
  geminiStream2claudeAdapter: (payload, context = {}) => convertGeminiGenerateContentToAnthropicMessages(
    payload,
    context.pathname || context.requestPathname || '',
    Boolean(context.stream)
  ),
  geminiStream2codexAdapter: (payload, context = {}) => convertGeminiGenerateContentToOpenAIResponses(
    payload,
    context.pathname || context.requestPathname || '',
    Boolean(context.stream)
  ),
  geminiStream2geminiAdapter: (payload) => passThroughProtocolPayload(payload),
  geminiStream2openaiChatAdapter: (payload, context = {}) => convertGeminiGenerateContentToOpenAIChat(
    payload,
    context.pathname || context.requestPathname || '',
    Boolean(context.stream)
  ),
  openaiChat2claudeAdapter: (payload) => convertOpenAIChatToAnthropicMessages(payload),
  openaiChat2geminiAdapter: (payload) => convertOpenAIChatToGeminiGenerateContent(payload),
  openaiChat2geminiStreamAdapter: (payload) => convertOpenAIChatToGeminiGenerateContent(payload)
});

const PROTOCOL_RESPONSE_ADAPTER_FUNCTIONS = Object.freeze({
  claude2codexAdapter: (payload, context = {}) => convertAnthropicMessageToOpenAIResponse(
    payload,
    context.fallbackModel || context.model
  ),
  claude2geminiAdapter: (payload, context = {}) => convertAnthropicMessageToGeminiGenerateContent(
    payload,
    context.fallbackModel || context.model
  ),
  claude2geminiStreamAdapter: (payload, context = {}) => convertAnthropicMessageToGeminiGenerateContent(
    payload,
    context.fallbackModel || context.model
  ),
  claude2openaiChatAdapter: (payload, context = {}) => convertAnthropicMessageToOpenAIChatCompletion(
    payload,
    context.fallbackModel || context.model
  ),
  codex2claudeAdapter: (payload, context = {}) => convertOpenAIResponseToAnthropicMessage(
    payload,
    context.fallbackModel || context.model
  ),
  codex2geminiAdapter: (payload, context = {}) => convertOpenAIResponseToGeminiGenerateContent(
    payload,
    context.fallbackModel || context.model
  ),
  codex2geminiStreamAdapter: (payload, context = {}) => convertOpenAIResponseToGeminiGenerateContent(
    payload,
    context.fallbackModel || context.model
  ),
  gemini2claudeAdapter: (payload, context = {}) => convertGeminiGenerateContentResponseToAnthropicMessage(
    payload,
    context.fallbackModel || context.model
  ),
  gemini2codexAdapter: (payload, context = {}) => convertGeminiGenerateContentResponseToOpenAIResponse(
    payload,
    context.fallbackModel || context.model
  ),
  gemini2geminiStreamAdapter: (payload) => passThroughProtocolPayload(payload),
  gemini2openaiChatAdapter: (payload, context = {}) => convertGeminiGenerateContentResponseToOpenAIChatCompletion(
    payload,
    context.fallbackModel || context.model
  ),
  geminiStream2claudeAdapter: (payload, context = {}) => convertGeminiGenerateContentResponseToAnthropicMessage(
    payload,
    context.fallbackModel || context.model
  ),
  geminiStream2codexAdapter: (payload, context = {}) => convertGeminiGenerateContentResponseToOpenAIResponse(
    payload,
    context.fallbackModel || context.model
  ),
  geminiStream2geminiAdapter: (payload) => passThroughProtocolPayload(payload),
  geminiStream2openaiChatAdapter: (payload, context = {}) => convertGeminiGenerateContentResponseToOpenAIChatCompletion(
    payload,
    context.fallbackModel || context.model
  ),
  openaiChat2codexAdapter: (payload, context = {}) => convertOpenAIChatCompletionToOpenAIResponse(
    payload,
    context.fallbackModel || context.model
  ),
  openaiChat2claudeAdapter: (payload, context = {}) => convertOpenAIChatCompletionToAnthropicMessage(
    payload,
    context.fallbackModel || context.model
  ),
  openaiChat2geminiAdapter: (payload, context = {}) => convertOpenAIChatCompletionToGeminiGenerateContent(
    payload,
    context.fallbackModel || context.model
  ),
  openaiChat2geminiStreamAdapter: (payload, context = {}) => convertOpenAIChatCompletionToGeminiGenerateContent(
    payload,
    context.fallbackModel || context.model
  )
});

function resolveNamedProtocolAdapter(adapterName, functionsByName) {
  const name = normalizeProtocolId(adapterName);
  return name ? functionsByName[name] || null : null;
}

function applyProtocolAdapterPath(input = {}, direction) {
  const sourceProtocol = normalizeProtocolId(input.sourceProtocol);
  const targetProtocol = normalizeProtocolId(input.targetProtocol);
  const path = resolveProtocolRequestAdapterPath(sourceProtocol, targetProtocol);
  if (!path) return null;
  const context = input.context && typeof input.context === 'object' ? input.context : {};
  const adapters = direction === 'response' ? [...path].reverse() : path;
  const functionsByName = direction === 'response'
    ? PROTOCOL_RESPONSE_ADAPTER_FUNCTIONS
    : PROTOCOL_REQUEST_ADAPTER_FUNCTIONS;
  const adapterKey = direction === 'response' ? 'responseAdapter' : 'requestAdapter';
  const payload = adapters.reduce((currentPayload, adapter) => {
    const fn = resolveNamedProtocolAdapter(adapter[adapterKey], functionsByName);
    if (typeof fn !== 'function') {
      throw new Error(`unsupported_protocol_${direction}_adapter:${adapter[adapterKey] || adapter.id}`);
    }
    return fn(currentPayload, { ...context, adapter });
  }, input.payload);
  return {
    sourceProtocol,
    targetProtocol,
    protocol: direction === 'response' ? sourceProtocol : targetProtocol,
    payload,
    adapters: adapters.map((adapter) => adapter.id)
  };
}

function applyProtocolRequestAdapterPath(input = {}) {
  return applyProtocolAdapterPath(input, 'request');
}

function applyProtocolResponseAdapterPath(input = {}) {
  return applyProtocolAdapterPath(input, 'response');
}

module.exports = {
  detectClientProtocol,
  extractGeminiModelFromPath,
  applyProtocolRequestAdapterPath,
  applyProtocolResponseAdapterPath,
  listProtocolRequestAdapters,
  resolveProtocolRequestAdapter,
  resolveProtocolRequestAdapterPath,
  convertAnthropicMessagesToOpenAIChat,
  convertAnthropicMessagesToOpenAIResponses,
  convertAnthropicMessagesToGeminiGenerateContent,
  convertOpenAIChatToAnthropicMessages,
  convertOpenAIChatToGeminiGenerateContent,
  convertGeminiGenerateContentToOpenAIChat,
  convertGeminiGenerateContentToOpenAIResponses,
  convertGeminiGenerateContentToAnthropicMessages,
  convertOpenAIResponsesToOpenAIChat,
  convertOpenAIResponsesToGeminiGenerateContent,
  convertOpenAIResponsesToAnthropicMessages,
  convertOpenAIChatCompletionToAnthropicMessage,
  convertOpenAIResponseToAnthropicMessage,
  convertOpenAIChatSseToAnthropicSse,
  convertAnthropicMessageToOpenAIChatCompletion,
  convertAnthropicMessageToOpenAIResponse,
  convertAnthropicSseToOpenAIChatSse,
  convertOpenAIChatCompletionToGeminiGenerateContent,
  convertOpenAIResponseToGeminiGenerateContent,
  convertAnthropicMessageToGeminiGenerateContent,
  convertGeminiGenerateContentResponseToAnthropicMessage,
  convertGeminiGenerateContentResponseToOpenAIChatCompletion,
  convertGeminiGenerateContentResponseToOpenAIResponse,
  convertOpenAIChatSseToGeminiSse,
  convertOpenAIChatCompletionToOpenAIResponse,
  convertOpenAIChatSseToOpenAIResponseSse,
  __private: {
    mapOpenAIFinishReasonToAnthropic,
    mapAnthropicStopReasonToOpenAI,
    mapOpenAIFinishReasonToGemini,
    normalizeProtocolId,
    parseOpenAISseChunks,
    parseAnthropicSseEvents,
    PROTOCOL_REQUEST_ADAPTER_FUNCTIONS,
    PROTOCOL_RESPONSE_ADAPTER_FUNCTIONS,
    PROTOCOL_REQUEST_ADAPTERS
  }
};
