'use strict';

const {
  normalizeOpenAIContentParts,
  normalizeAnthropicContentParts,
  normalizeGeminiContentParts,
  canonicalPartsToOpenAIContent,
  canonicalPartsToAnthropicContent,
  readTextFromCanonicalParts
} = require('./protocol-canonical');
const { detectClientProtocol } = require('./protocol-registry');
const { convertSseViaCanonical } = require('./protocol-stream-pipeline');

function toPlainText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function extractGeminiModelFromPath(pathname) {
  const match = String(pathname || '').match(/^\/v1(?:beta)?\/models\/([^/]+):(?:generateContent|streamGenerateContent)$/);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch (_error) {
    return match[1];
  }
}

function readAnthropicText(content) {
  return readTextFromCanonicalParts(normalizeAnthropicContentParts(content));
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

function convertAnthropicMessagesToOpenAIChat(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const messages = [];
  const system = normalizeAnthropicSystem(source.system);
  if (system) {
    messages.push({ role: 'system', content: system });
  }
  (Array.isArray(source.messages) ? source.messages : []).forEach((message) => {
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
          content: readResponsesContentText(message.content).trim()
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
        let input = {};
        try {
          input = JSON.parse(toPlainText(fn.arguments || '{}') || '{}');
        } catch (_error) {
          input = {};
        }
        content.push({
          type: 'tool_use',
          id: toPlainText(toolCall.id || '').trim() || `toolu_${index + 1}`,
          name,
          input
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
    messages,
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
  return out;
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
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: toolCalls.map((part, index) => ({
          id: part.id || `call_${index + 1}`,
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
        messages.push({
          role: 'tool',
          tool_call_id: part.toolCallId || part.name || '',
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

function mapGeminiToolsToOpenAI(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  tools.forEach((tool) => {
    const declarations = Array.isArray(tool && tool.functionDeclarations)
      ? tool.functionDeclarations
      : Array.isArray(tool && tool.function_declarations)
        ? tool.function_declarations
        : [];
    declarations.forEach((declaration) => {
      if (!declaration || typeof declaration !== 'object') return;
      const name = toPlainText(declaration.name || '').trim();
      if (!name) return;
      out.push({
        type: 'function',
        function: {
          name,
          description: toPlainText(declaration.description || ''),
          parameters: declaration.parameters && typeof declaration.parameters === 'object'
            ? declaration.parameters
            : { type: 'object', properties: {} }
        }
      });
    });
  });
  return out;
}

function mapGeminiToolConfigToOpenAI(toolConfig) {
  const cfg = toolConfig && typeof toolConfig === 'object'
    ? (toolConfig.functionCallingConfig || toolConfig.function_calling_config || null)
    : null;
  if (!cfg || typeof cfg !== 'object') return undefined;
  const mode = String(cfg.mode || '').trim().toUpperCase();
  if (mode === 'NONE') return 'none';
  if (mode === 'ANY') {
    const allowed = Array.isArray(cfg.allowedFunctionNames)
      ? cfg.allowedFunctionNames
      : Array.isArray(cfg.allowed_function_names)
        ? cfg.allowed_function_names
        : [];
    const name = toPlainText(allowed[0] || '').trim();
    if (name) return { type: 'function', function: { name } };
    return 'required';
  }
  if (mode === 'AUTO') return 'auto';
  return undefined;
}

function readResponsesContentText(content) {
  return readTextFromCanonicalParts(normalizeOpenAIContentParts(content));
}

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
  if (toolChoice.type === 'function' && toolChoice.function && typeof toolChoice.function === 'object') {
    return toolChoice;
  }
  if (toolChoice.type === 'function') {
    const name = toPlainText(toolChoice.name || '').trim();
    if (!name) return undefined;
    return { type: 'function', function: { name } };
  }
  return undefined;
}

function convertOpenAIResponsesToOpenAIChat(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const messages = [];
  const instructions = toPlainText(source.instructions || '').trim();
  if (instructions) messages.push({ role: 'system', content: instructions });
  if (typeof source.input === 'string') {
    const text = source.input.trim();
    if (text) messages.push({ role: 'user', content: text });
  } else if (Array.isArray(source.input)) {
    source.input.forEach((item) => {
      if (typeof item === 'string') {
        const text = item.trim();
        if (text) messages.push({ role: 'user', content: text });
        return;
      }
      if (!item || typeof item !== 'object') return;
      const itemType = String(item.type || '').trim();
      if (itemType === 'function_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: toPlainText(item.call_id || item.id || '').trim(),
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

function parseToolArguments(raw) {
  const text = toPlainText(raw || '').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function mapOpenAIFinishReasonToAnthropic(reason) {
  const value = String(reason || '').trim();
  if (value === 'length') return 'max_tokens';
  if (value === 'tool_calls') return 'tool_use';
  if (value === 'stop') return 'end_turn';
  return value || 'end_turn';
}

function mapAnthropicStopReasonToOpenAI(reason) {
  const value = String(reason || '').trim();
  if (value === 'max_tokens') return 'length';
  if (value === 'tool_use') return 'tool_calls';
  return 'stop';
}

function mapOpenAIUsageToAnthropic(usage) {
  const inputTokens = Number(usage && usage.prompt_tokens || 0);
  const outputTokens = Number(usage && usage.completion_tokens || 0);
  return {
    input_tokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    output_tokens: Number.isFinite(outputTokens) ? outputTokens : 0
  };
}

function mapAnthropicUsageToOpenAI(usage) {
  const inputTokens = Number(usage && usage.input_tokens || 0);
  const outputTokens = Number(usage && usage.output_tokens || 0);
  return {
    prompt_tokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    completion_tokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    total_tokens: (Number.isFinite(inputTokens) ? inputTokens : 0) + (Number.isFinite(outputTokens) ? outputTokens : 0)
  };
}

function convertOpenAIChatCompletionToAnthropicMessage(payload, fallbackModel) {
  const choice = payload
    && Array.isArray(payload.choices)
    && payload.choices[0]
    ? payload.choices[0]
    : null;
  const message = choice && choice.message && typeof choice.message === 'object' ? choice.message : {};
  const content = [];
  const text = toPlainText(message.content || '').trim();
  if (text) {
    content.push({ type: 'text', text });
  }
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  toolCalls.forEach((toolCall) => {
    if (!toolCall || toolCall.type !== 'function') return;
    const fn = toolCall.function && typeof toolCall.function === 'object' ? toolCall.function : {};
    const name = toPlainText(fn.name || '').trim();
    if (!name) return;
    content.push({
      type: 'tool_use',
      id: toPlainText(toolCall.id || '').trim() || `toolu_${Date.now()}`,
      name,
      input: parseToolArguments(fn.arguments)
    });
  });
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }
  return {
    id: toPlainText(payload && payload.id || '').trim() || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: toPlainText(payload && payload.model || fallbackModel || '').trim(),
    content,
    stop_reason: mapOpenAIFinishReasonToAnthropic(choice && choice.finish_reason),
    stop_sequence: null,
    usage: mapOpenAIUsageToAnthropic(payload && payload.usage)
  };
}

function convertAnthropicMessageToOpenAIChatCompletion(payload, fallbackModel) {
  const content = Array.isArray(payload && payload.content) ? payload.content : [];
  const text = content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text') return toPlainText(part.text || '');
      return '';
    })
    .filter(Boolean)
    .join('');
  const toolCalls = content
    .map((part) => {
      if (!part || part.type !== 'tool_use') return null;
      const name = toPlainText(part.name || '').trim();
      if (!name) return null;
      return {
        id: toPlainText(part.id || '').trim() || `call_${Date.now()}`,
        type: 'function',
        function: {
          name,
          arguments: JSON.stringify(part.input && typeof part.input === 'object' ? part.input : {})
        }
      };
    })
    .filter(Boolean);
  const message = { role: 'assistant', content: text };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return {
    id: toPlainText(payload && payload.id || '').trim() || `chatcmpl_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: toPlainText(payload && payload.model || fallbackModel || '').trim(),
    choices: [{
      index: 0,
      message,
      finish_reason: mapAnthropicStopReasonToOpenAI(payload && payload.stop_reason)
    }],
    usage: mapAnthropicUsageToOpenAI(payload && payload.usage)
  };
}

function mapOpenAIFinishReasonToGemini(reason) {
  const value = String(reason || '').trim();
  if (value === 'length') return 'MAX_TOKENS';
  if (value === 'tool_calls') return 'STOP';
  return 'STOP';
}

function convertOpenAIChatCompletionToGeminiGenerateContent(payload, fallbackModel) {
  const choice = payload
    && Array.isArray(payload.choices)
    && payload.choices[0]
    ? payload.choices[0]
    : null;
  const message = choice && choice.message && typeof choice.message === 'object' ? choice.message : {};
  const text = toPlainText(message.content || '');
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const parts = [];
  if (text) parts.push({ text });
  toolCalls.forEach((toolCall) => {
    if (!toolCall || toolCall.type !== 'function') return;
    const fn = toolCall.function && typeof toolCall.function === 'object' ? toolCall.function : {};
    const name = toPlainText(fn.name || '').trim();
    if (!name) return;
    let args = {};
    try {
      args = JSON.parse(toPlainText(fn.arguments || '{}') || '{}');
    } catch (_error) {
      args = {};
    }
    parts.push({ functionCall: { name, args } });
  });
  const usage = payload && payload.usage && typeof payload.usage === 'object' ? payload.usage : {};
  return {
    candidates: [{
      content: {
        role: 'model',
        parts: parts.length > 0 ? parts : [{ text: '' }]
      },
      finishReason: mapOpenAIFinishReasonToGemini(choice && choice.finish_reason),
      index: 0
    }],
    usageMetadata: {
      promptTokenCount: Number(usage.prompt_tokens || 0),
      candidatesTokenCount: Number(usage.completion_tokens || 0),
      totalTokenCount: Number(usage.total_tokens || 0)
    },
    modelVersion: toPlainText(payload && payload.model || fallbackModel || '').trim()
  };
}

function convertOpenAIChatCompletionToOpenAIResponse(payload, fallbackModel) {
  const choice = payload
    && Array.isArray(payload.choices)
    && payload.choices[0]
    ? payload.choices[0]
    : null;
  const message = choice && choice.message && typeof choice.message === 'object' ? choice.message : {};
  const text = toPlainText(message.content || '');
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const usage = payload && payload.usage && typeof payload.usage === 'object' ? payload.usage : {};
  const output = [];
  if (text || toolCalls.length === 0) {
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
  toolCalls.forEach((toolCall, index) => {
    if (!toolCall || toolCall.type !== 'function') return;
    const fn = toolCall.function && typeof toolCall.function === 'object' ? toolCall.function : {};
    const name = toPlainText(fn.name || '').trim();
    if (!name) return;
    const callId = toPlainText(toolCall.id || '').trim() || `call_${index + 1}`;
    output.push({
      id: `fc_${callId}`,
      type: 'function_call',
      status: 'completed',
      call_id: callId,
      name,
      arguments: toPlainText(fn.arguments || '{}')
    });
  });
  return {
    id: toPlainText(payload && payload.id || '').trim() || `resp_${Date.now()}`,
    object: 'response',
    created_at: Number(payload && payload.created || Math.floor(Date.now() / 1000)),
    status: 'completed',
    model: toPlainText(payload && payload.model || fallbackModel || '').trim(),
    output,
    usage: {
      input_tokens: Number(usage.prompt_tokens || 0),
      output_tokens: Number(usage.completion_tokens || 0),
      total_tokens: Number(usage.total_tokens || 0)
    }
  };
}

function parseOpenAISseChunks(rawText) {
  const chunks = [];
  let dataLines = [];
  const flush = () => {
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n').trim();
    dataLines = [];
    if (!data || data === '[DONE]') return;
    try {
      chunks.push(JSON.parse(data));
    } catch (_error) {}
  };
  String(rawText || '').split(/\r?\n/).forEach((line) => {
    if (!line.trim()) {
      flush();
      return;
    }
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  });
  flush();
  return chunks;
}

function convertOpenAIChatSseToAnthropicSse(rawText, fallbackModel) {
  return convertSseViaCanonical('openai_chat', 'anthropic_messages', rawText, fallbackModel);
}

function parseAnthropicSseEvents(rawText) {
  const events = [];
  let eventName = '';
  let dataLines = [];
  const flush = () => {
    if (dataLines.length === 0) {
      eventName = '';
      return;
    }
    const data = dataLines.join('\n').trim();
    dataLines = [];
    const name = eventName;
    eventName = '';
    if (!data) return;
    try {
      events.push({ event: name, data: JSON.parse(data) });
    } catch (_error) {}
  };
  String(rawText || '').split(/\r?\n/).forEach((line) => {
    if (!line.trim()) {
      flush();
      return;
    }
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  });
  flush();
  return events;
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

module.exports = {
  detectClientProtocol,
  extractGeminiModelFromPath,
  convertAnthropicMessagesToOpenAIChat,
  convertOpenAIChatToAnthropicMessages,
  convertGeminiGenerateContentToOpenAIChat,
  convertOpenAIResponsesToOpenAIChat,
  convertOpenAIChatCompletionToAnthropicMessage,
  convertOpenAIChatSseToAnthropicSse,
  convertAnthropicMessageToOpenAIChatCompletion,
  convertAnthropicSseToOpenAIChatSse,
  convertOpenAIChatCompletionToGeminiGenerateContent,
  convertOpenAIChatSseToGeminiSse,
  convertOpenAIChatCompletionToOpenAIResponse,
  convertOpenAIChatSseToOpenAIResponseSse,
  __private: {
    mapOpenAIFinishReasonToAnthropic,
    mapAnthropicStopReasonToOpenAI,
    mapOpenAIFinishReasonToGemini,
    parseOpenAISseChunks,
    parseAnthropicSseEvents
  }
};
