'use strict';

function toPlainText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function stringifyJson(value, fallback = '{}') {
  if (typeof value === 'string') return value;
  if (value == null) return fallback;
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return fallback;
  }
}

function buildDataUrl(mimeType, data) {
  const safeMime = toPlainText(mimeType || 'application/octet-stream').trim() || 'application/octet-stream';
  const safeData = toPlainText(data || '').trim();
  if (!safeData) return '';
  return `data:${safeMime};base64,${safeData}`;
}

function parseDataUrl(url) {
  const match = toPlainText(url).trim().match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match) return null;
  return {
    mimeType: match[1],
    data: match[2]
  };
}

function createTextPart(text) {
  return { type: 'text', text: toPlainText(text || '') };
}

function createImagePart(input = {}) {
  const url = toPlainText(input.url || input.image_url || '').trim();
  const data = toPlainText(input.data || '').trim();
  const mimeType = toPlainText(input.mimeType || input.media_type || input.mime_type || '').trim();
  const fileUri = toPlainText(input.fileUri || input.file_uri || '').trim();
  if (url) return { type: 'image', url };
  if (data) return { type: 'image', data, mimeType: mimeType || 'application/octet-stream' };
  if (fileUri) return { type: 'image', fileUri, mimeType: mimeType || '' };
  return null;
}

function readTextFromCanonicalParts(parts) {
  return (Array.isArray(parts) ? parts : [])
    .map((part) => (part && part.type === 'text' ? toPlainText(part.text || '') : ''))
    .filter(Boolean)
    .join('\n');
}

function normalizeOpenAIContentParts(content) {
  if (typeof content === 'string') return [createTextPart(content)];
  if (!Array.isArray(content)) return [];
  return content
    .map((part) => {
      if (typeof part === 'string') return createTextPart(part);
      if (!part || typeof part !== 'object') return null;
      const type = toPlainText(part.type || '').trim();
      if (type === 'text' || type === 'input_text' || type === 'output_text') {
        return createTextPart(part.text || '');
      }
      if (type === 'image_url') {
        const imageUrl = part.image_url && typeof part.image_url === 'object'
          ? part.image_url.url
          : part.image_url;
        return createImagePart({ url: imageUrl });
      }
      if (type === 'input_image') {
        return createImagePart({
          url: part.image_url || part.url,
          data: part.image_data || part.data,
          mimeType: part.mime_type || part.media_type
        });
      }
      return null;
    })
    .filter(Boolean);
}

function normalizeAnthropicContentParts(content) {
  if (typeof content === 'string') return [createTextPart(content)];
  if (!Array.isArray(content)) return [];
  return content
    .map((part) => {
      if (typeof part === 'string') return createTextPart(part);
      if (!part || typeof part !== 'object') return null;
      const type = toPlainText(part.type || '').trim();
      if (type === 'text') return createTextPart(part.text || '');
      if (type === 'image') {
        const source = part.source && typeof part.source === 'object' ? part.source : {};
        if (source.type === 'base64') {
          return createImagePart({
            data: source.data,
            mimeType: source.media_type
          });
        }
        if (source.type === 'url') {
          return createImagePart({ url: source.url });
        }
      }
      if (type === 'tool_use') {
        return {
          type: 'tool_call',
          id: toPlainText(part.id || '').trim(),
          name: toPlainText(part.name || '').trim(),
          arguments: stringifyJson(part.input && typeof part.input === 'object' ? part.input : {})
        };
      }
      if (type === 'tool_result') {
        return {
          type: 'tool_result',
          toolCallId: toPlainText(part.tool_use_id || part.toolUseId || '').trim(),
          content: readTextFromCanonicalParts(normalizeAnthropicContentParts(part.content))
        };
      }
      return null;
    })
    .filter(Boolean);
}

function normalizeGeminiContentParts(parts) {
  if (!Array.isArray(parts)) return [];
  return parts
    .map((part) => {
      if (!part || typeof part !== 'object') return null;
      if (typeof part.text === 'string') return createTextPart(part.text);
      const inlineData = part.inlineData || part.inline_data;
      if (inlineData && typeof inlineData === 'object') {
        return createImagePart({
          data: inlineData.data,
          mimeType: inlineData.mimeType || inlineData.mime_type
        });
      }
      const fileData = part.fileData || part.file_data;
      if (fileData && typeof fileData === 'object') {
        return createImagePart({
          fileUri: fileData.fileUri || fileData.file_uri,
          mimeType: fileData.mimeType || fileData.mime_type
        });
      }
      const functionCall = part.functionCall || part.function_call;
      if (functionCall && typeof functionCall === 'object') {
        return {
          type: 'tool_call',
          id: '',
          name: toPlainText(functionCall.name || '').trim(),
          arguments: stringifyJson(functionCall.args && typeof functionCall.args === 'object' ? functionCall.args : {})
        };
      }
      const functionResponse = part.functionResponse || part.function_response;
      if (functionResponse && typeof functionResponse === 'object') {
        return {
          type: 'tool_result',
          toolCallId: toPlainText(functionResponse.name || '').trim(),
          content: stringifyJson(functionResponse.response && typeof functionResponse.response === 'object'
            ? functionResponse.response
            : {})
        };
      }
      return null;
    })
    .filter(Boolean);
}

function canonicalPartsToOpenAIContent(parts, options = {}) {
  const normalized = Array.isArray(parts) ? parts : [];
  const textOnly = normalized.every((part) => part && part.type === 'text');
  if (textOnly && options.preferString !== false) return readTextFromCanonicalParts(normalized);
  return normalized
    .map((part) => {
      if (!part || typeof part !== 'object') return null;
      if (part.type === 'text') return { type: options.output ? 'output_text' : 'text', text: toPlainText(part.text || '') };
      if (part.type === 'image') {
        const url = part.url || (part.data ? buildDataUrl(part.mimeType, part.data) : part.fileUri || '');
        if (!url) return null;
        return { type: 'image_url', image_url: { url } };
      }
      return null;
    })
    .filter(Boolean);
}

function canonicalPartsToAnthropicContent(parts) {
  return (Array.isArray(parts) ? parts : [])
    .map((part) => {
      if (!part || typeof part !== 'object') return null;
      if (part.type === 'text') return { type: 'text', text: toPlainText(part.text || '') };
      if (part.type === 'image') {
        if (part.data) {
          return {
            type: 'image',
            source: {
              type: 'base64',
              media_type: toPlainText(part.mimeType || 'application/octet-stream').trim() || 'application/octet-stream',
              data: toPlainText(part.data || '')
            }
          };
        }
        if (part.url) {
          const parsed = parseDataUrl(part.url);
          if (parsed) {
            return {
              type: 'image',
              source: {
                type: 'base64',
                media_type: parsed.mimeType,
                data: parsed.data
              }
            };
          }
          return { type: 'image', source: { type: 'url', url: part.url } };
        }
      }
      if (part.type === 'tool_call') {
        const argsText = toPlainText(part.arguments || '{}').trim() || '{}';
        let input = {};
        try {
          input = JSON.parse(argsText);
        } catch (_error) {
          input = {};
        }
        return {
          type: 'tool_use',
          id: toPlainText(part.id || '').trim() || `toolu_${Date.now()}`,
          name: toPlainText(part.name || '').trim(),
          input
        };
      }
      if (part.type === 'tool_result') {
        return {
          type: 'tool_result',
          tool_use_id: toPlainText(part.toolCallId || '').trim(),
          content: toPlainText(part.content || '')
        };
      }
      return null;
    })
    .filter(Boolean);
}

function canonicalPartsToGeminiParts(parts) {
  return (Array.isArray(parts) ? parts : [])
    .map((part) => {
      if (!part || typeof part !== 'object') return null;
      if (part.type === 'text') return { text: toPlainText(part.text || '') };
      if (part.type === 'image') {
        if (part.data) {
          return {
            inlineData: {
              mimeType: toPlainText(part.mimeType || 'application/octet-stream').trim() || 'application/octet-stream',
              data: toPlainText(part.data || '')
            }
          };
        }
        if (part.url) {
          const parsed = parseDataUrl(part.url);
          if (parsed) {
            return { inlineData: { mimeType: parsed.mimeType, data: parsed.data } };
          }
          return { fileData: { fileUri: part.url, mimeType: toPlainText(part.mimeType || '') } };
        }
        if (part.fileUri) {
          return { fileData: { fileUri: part.fileUri, mimeType: toPlainText(part.mimeType || '') } };
        }
      }
      if (part.type === 'tool_call') {
        let args = {};
        try {
          args = JSON.parse(toPlainText(part.arguments || '{}') || '{}');
        } catch (_error) {
          args = {};
        }
        return { functionCall: { name: toPlainText(part.name || '').trim(), args } };
      }
      if (part.type === 'tool_result') {
        let response = {};
        try {
          response = JSON.parse(toPlainText(part.content || '{}') || '{}');
        } catch (_error) {
          response = { result: toPlainText(part.content || '') };
        }
        return { functionResponse: { name: toPlainText(part.toolCallId || '').trim(), response } };
      }
      return null;
    })
    .filter(Boolean);
}

function parseSseJsonEvents(rawText) {
  const events = [];
  let eventName = '';
  let dataLines = [];
  const flush = () => {
    if (dataLines.length === 0) {
      eventName = '';
      return;
    }
    const data = dataLines.join('\n').trim();
    const name = eventName;
    dataLines = [];
    eventName = '';
    if (!data || data === '[DONE]') return;
    try {
      events.push({ event: name, data: JSON.parse(data) });
    } catch (_error) {}
  };
  String(rawText || '').split(/\r?\n/).forEach((line) => {
    if (!line.trim()) {
      flush();
      return;
    }
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
      return;
    }
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  });
  flush();
  return events;
}

function parseOpenAIChatSseToCanonicalEvents(rawText, fallbackModel) {
  const events = [];
  let dataLines = [];
  const toolCalls = new Map();
  const flush = () => {
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n').trim();
    dataLines = [];
    if (!data || data === '[DONE]') return;
    let chunk = null;
    try {
      chunk = JSON.parse(data);
    } catch (_error) {
      return;
    }
    const choice = Array.isArray(chunk && chunk.choices) ? chunk.choices[0] : null;
    if (!choice) return;
    const id = toPlainText(chunk.id || '').trim();
    const model = toPlainText(chunk.model || fallbackModel || '').trim();
    if (events.length === 0) {
      events.push({ type: 'message_start', id, model, created: Number(chunk.created || Math.floor(Date.now() / 1000)) });
    }
    const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta : {};
    const reasoningText = toPlainText(delta.reasoning_content || '');
    if (reasoningText) events.push({ type: 'content_delta', contentType: 'thinking', text: reasoningText });
    const text = toPlainText(delta.content || '');
    if (text) events.push({ type: 'content_delta', contentType: 'text', text });
    if (Array.isArray(delta.tool_calls)) {
      delta.tool_calls.forEach((toolCall) => {
        if (!toolCall || typeof toolCall !== 'object') return;
        const index = Number.isFinite(Number(toolCall.index)) ? Number(toolCall.index) : 0;
        const previous = toolCalls.get(index) || { id: '', name: '', arguments: '' };
        const fn = toolCall.function && typeof toolCall.function === 'object' ? toolCall.function : {};
        const next = {
          id: toPlainText(toolCall.id || previous.id || '').trim(),
          name: toPlainText(fn.name || previous.name || '').trim(),
          arguments: previous.arguments + toPlainText(fn.arguments || '')
        };
        if (!toolCalls.has(index)) {
          events.push({ type: 'tool_call_start', index, id: next.id, name: next.name });
        }
        if (fn.arguments) {
          events.push({ type: 'tool_call_delta', index, id: next.id, name: next.name, delta: toPlainText(fn.arguments || '') });
        }
        toolCalls.set(index, next);
      });
    }
    if (choice.finish_reason) {
      toolCalls.forEach((toolCall, index) => {
        events.push({ type: 'tool_call_done', index, ...toolCall });
      });
      events.push({ type: 'message_stop', finishReason: choice.finish_reason, usage: chunk.usage || null });
    }
  };
  String(rawText || '').split(/\r?\n/).forEach((line) => {
    if (!line.trim()) {
      flush();
      return;
    }
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  });
  flush();
  return events;
}

function parseAnthropicSseToCanonicalEvents(rawText, fallbackModel) {
  const events = [];
  const blocks = new Map();
  const toolCalls = new Map();
  const completedToolCalls = new Set();
  let started = false;
  let id = '';
  let model = toPlainText(fallbackModel || '').trim();
  let usage = null;
  let finishReason = 'end_turn';

  const ensureStarted = () => {
    if (started) return;
    started = true;
    events.push({
      type: 'message_start',
      id: id || `msg_${Date.now()}`,
      model,
      created: Math.floor(Date.now() / 1000)
    });
  };

  parseSseJsonEvents(rawText).forEach((item) => {
    const data = item && item.data && typeof item.data === 'object' ? item.data : {};
    if (item.event === 'message_start' || data.type === 'message_start') {
      const message = data.message && typeof data.message === 'object' ? data.message : {};
      id = toPlainText(message.id || id || '').trim();
      model = toPlainText(message.model || model || '').trim();
      if (message.usage) {
        usage = {
          input_tokens: Number(message.usage.input_tokens || 0),
          output_tokens: Number(message.usage.output_tokens || 0)
        };
      }
      ensureStarted();
      return;
    }
    if (item.event === 'content_block_start' || data.type === 'content_block_start') {
      ensureStarted();
      const index = Number.isFinite(Number(data.index)) ? Number(data.index) : 0;
      const block = data.content_block && typeof data.content_block === 'object' ? data.content_block : {};
      const blockType = toPlainText(block.type || '').trim();
      blocks.set(index, blockType);
      if (blockType === 'tool_use') {
        const input = block.input && typeof block.input === 'object' ? block.input : {};
        const call = {
          index,
          id: toPlainText(block.id || '').trim(),
          name: toPlainText(block.name || '').trim(),
          arguments: Object.keys(input).length > 0 ? stringifyJson(input, '') : ''
        };
        toolCalls.set(index, call);
        events.push({ type: 'tool_call_start', index, id: call.id, name: call.name });
      }
      return;
    }
    if (item.event === 'content_block_delta' || data.type === 'content_block_delta') {
      ensureStarted();
      const index = Number.isFinite(Number(data.index)) ? Number(data.index) : 0;
      const delta = data.delta && typeof data.delta === 'object' ? data.delta : {};
      if (delta.type === 'text_delta') {
        const text = toPlainText(delta.text || '');
        if (text) events.push({ type: 'content_delta', contentType: 'text', text });
        return;
      }
      if (delta.type === 'input_json_delta') {
        const call = toolCalls.get(index) || { index, id: '', name: '', arguments: '' };
        const partial = toPlainText(delta.partial_json || '');
        call.arguments += partial;
        toolCalls.set(index, call);
        if (partial) {
          events.push({
            type: 'tool_call_delta',
            index,
            id: call.id,
            name: call.name,
            delta: partial
          });
        }
      }
      return;
    }
    if (item.event === 'content_block_stop' || data.type === 'content_block_stop') {
      const index = Number.isFinite(Number(data.index)) ? Number(data.index) : 0;
      if (blocks.get(index) === 'tool_use') {
        const call = toolCalls.get(index) || { index, id: '', name: '', arguments: '' };
        events.push({ type: 'tool_call_done', index, ...call });
        completedToolCalls.add(index);
      }
      return;
    }
    if (item.event === 'message_delta' || data.type === 'message_delta') {
      const delta = data.delta && typeof data.delta === 'object' ? data.delta : {};
      if (delta.stop_reason) finishReason = toPlainText(delta.stop_reason || '').trim() || finishReason;
      if (data.usage) {
        usage = {
          input_tokens: Number(usage && usage.input_tokens || 0),
          output_tokens: Number(data.usage.output_tokens || usage && usage.output_tokens || 0)
        };
      }
      return;
    }
    if (item.event === 'message_stop' || data.type === 'message_stop') {
      ensureStarted();
      toolCalls.forEach((call, index) => {
        if (completedToolCalls.has(index)) return;
        events.push({ type: 'tool_call_done', index, ...call });
        completedToolCalls.add(index);
      });
      events.push({ type: 'message_stop', finishReason, usage });
    }
  });

  if (started && !events.some((event) => event && event.type === 'message_stop')) {
    toolCalls.forEach((call, index) => {
      if (completedToolCalls.has(index)) return;
      events.push({ type: 'tool_call_done', index, ...call });
    });
    events.push({ type: 'message_stop', finishReason, usage });
  }
  return events;
}

function normalizeCanonicalUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  }
  const inputTokens = Number(usage.input_tokens || usage.prompt_tokens || 0);
  const outputTokens = Number(usage.output_tokens || usage.completion_tokens || 0);
  const totalTokens = Number(usage.total_tokens || inputTokens + outputTokens);
  return {
    input_tokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    output_tokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    total_tokens: Number.isFinite(totalTokens) ? totalTokens : 0
  };
}

function mapCanonicalFinishReasonToOpenAI(reason) {
  const value = toPlainText(reason || '').trim();
  if (value === 'max_tokens' || value === 'length' || value === 'MAX_TOKENS') return 'length';
  if (value === 'tool_use' || value === 'tool_calls') return 'tool_calls';
  return 'stop';
}

function mapCanonicalFinishReasonToAnthropic(reason) {
  const value = toPlainText(reason || '').trim();
  if (value === 'length' || value === 'max_tokens' || value === 'MAX_TOKENS') return 'max_tokens';
  if (value === 'tool_calls' || value === 'tool_use') return 'tool_use';
  return 'end_turn';
}

function mapCanonicalFinishReasonToGemini(reason) {
  const value = toPlainText(reason || '').trim();
  if (value === 'length' || value === 'max_tokens' || value === 'MAX_TOKENS') return 'MAX_TOKENS';
  return 'STOP';
}

function renderOpenAIChatSseFromCanonicalEvents(events, fallbackModel) {
  const list = Array.isArray(events) ? events : [];
  const first = list.find((event) => event && event.type === 'message_start') || {};
  const id = toPlainText(first.id || '').trim() || `chatcmpl_${Date.now()}`;
  const model = toPlainText(first.model || fallbackModel || '').trim();
  const created = Number(first.created || Math.floor(Date.now() / 1000));
  let usage = null;
  let finishReason = 'stop';
  const lines = [];
  const emit = (payload) => {
    lines.push(`data: ${JSON.stringify(payload)}\n\n`);
  };

  emit({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
  });
  list.forEach((event) => {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'content_delta' && event.contentType === 'text') {
      const text = toPlainText(event.text || '');
      if (!text) return;
      emit({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
      });
      return;
    }
    if (event.type === 'content_delta' && event.contentType === 'thinking') {
      const text = toPlainText(event.text || '');
      if (!text) return;
      emit({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }]
      });
      return;
    }
    if (event.type === 'tool_call_start') {
      const index = Number.isFinite(Number(event.index)) ? Number(event.index) : 0;
      emit({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index,
              id: toPlainText(event.id || '').trim() || `call_${index + 1}`,
              type: 'function',
              function: { name: toPlainText(event.name || '').trim(), arguments: '' }
            }]
          },
          finish_reason: null
        }]
      });
      return;
    }
    if (event.type === 'tool_call_delta') {
      const index = Number.isFinite(Number(event.index)) ? Number(event.index) : 0;
      const delta = toPlainText(event.delta || '');
      if (!delta) return;
      emit({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index, function: { arguments: delta } }] },
          finish_reason: null
        }]
      });
      return;
    }
    if (event.type === 'message_stop') {
      finishReason = mapCanonicalFinishReasonToOpenAI(event.finishReason);
      if (event.usage) usage = normalizeCanonicalUsage(event.usage);
    }
  });
  emit({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    ...(usage ? {
      usage: {
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
        total_tokens: usage.total_tokens
      }
    } : {})
  });
  lines.push('data: [DONE]\n\n');
  return lines.join('');
}

function renderAnthropicSseFromCanonicalEvents(events, fallbackModel) {
  const list = Array.isArray(events) ? events : [];
  const first = list.find((event) => event && event.type === 'message_start') || {};
  const id = toPlainText(first.id || '').trim() || `msg_${Date.now()}`;
  const model = toPlainText(first.model || fallbackModel || '').trim();
  const lines = [];
  const emit = (event, data) => {
    lines.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  let usage = { input_tokens: 0, output_tokens: 0 };
  let finalReason = 'end_turn';
  let nextBlockIndex = 0;
  let textBlockIndex = null;
  const toolBlockIndexes = new Map();
  const toolCalls = new Map();
  const ensureTextBlock = () => {
    if (textBlockIndex !== null) return textBlockIndex;
    textBlockIndex = nextBlockIndex++;
    emit('content_block_start', {
      type: 'content_block_start',
      index: textBlockIndex,
      content_block: { type: 'text', text: '' }
    });
    return textBlockIndex;
  };

  emit('message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage
    }
  });
  list.forEach((event) => {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'content_delta' && event.contentType === 'text') {
      const text = toPlainText(event.text || '');
      if (!text) return;
      emit('content_block_delta', {
        type: 'content_block_delta',
        index: ensureTextBlock(),
        delta: { type: 'text_delta', text }
      });
      return;
    }
    if (event.type === 'tool_call_start') {
      const index = Number.isFinite(Number(event.index)) ? Number(event.index) : 0;
      const blockIndex = nextBlockIndex++;
      const idValue = toPlainText(event.id || '').trim() || `toolu_${index + 1}`;
      const name = toPlainText(event.name || '').trim();
      toolBlockIndexes.set(index, blockIndex);
      toolCalls.set(index, { id: idValue, name, arguments: '' });
      emit('content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'tool_use', id: idValue, name, input: {} }
      });
      return;
    }
    if (event.type === 'tool_call_delta') {
      const index = Number.isFinite(Number(event.index)) ? Number(event.index) : 0;
      const blockIndex = toolBlockIndexes.get(index);
      if (blockIndex === undefined) return;
      const delta = toPlainText(event.delta || '');
      const call = toolCalls.get(index) || { arguments: '' };
      call.arguments += delta;
      toolCalls.set(index, call);
      if (!delta) return;
      emit('content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'input_json_delta', partial_json: delta }
      });
      return;
    }
    if (event.type === 'tool_call_done') {
      const index = Number.isFinite(Number(event.index)) ? Number(event.index) : 0;
      const blockIndex = toolBlockIndexes.get(index);
      if (blockIndex === undefined) return;
      emit('content_block_stop', { type: 'content_block_stop', index: blockIndex });
      return;
    }
    if (event.type === 'message_stop') {
      finalReason = mapCanonicalFinishReasonToAnthropic(event.finishReason);
      const normalizedUsage = normalizeCanonicalUsage(event.usage);
      usage = {
        input_tokens: normalizedUsage.input_tokens,
        output_tokens: normalizedUsage.output_tokens
      };
    }
  });
  if (textBlockIndex !== null) {
    emit('content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
  }
  emit('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: finalReason, stop_sequence: null },
    usage
  });
  emit('message_stop', { type: 'message_stop' });
  return lines.join('');
}

function renderGeminiSseFromCanonicalEvents(events, fallbackModel) {
  const list = Array.isArray(events) ? events : [];
  const first = list.find((event) => event && event.type === 'message_start') || {};
  let modelVersion = toPlainText(first.model || fallbackModel || '').trim();
  let usage = null;
  let finishReason = 'STOP';
  const toolCalls = new Map();
  const lines = [];
  const emit = (payload) => {
    lines.push(`data: ${JSON.stringify(payload)}\n\n`);
  };

  list.forEach((event) => {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'message_start') {
      modelVersion = toPlainText(event.model || modelVersion || '').trim();
      return;
    }
    if (event.type === 'content_delta' && event.contentType === 'text') {
      const text = toPlainText(event.text || '');
      if (!text) return;
      emit({
        candidates: [{
          content: { role: 'model', parts: [{ text }] },
          index: 0
        }],
        modelVersion
      });
      return;
    }
    if (event.type === 'content_delta' && event.contentType === 'thinking') {
      const text = toPlainText(event.text || '');
      if (!text) return;
      emit({
        candidates: [{
          content: { role: 'model', parts: [{ thought: true, text }] },
          index: 0
        }],
        modelVersion
      });
      return;
    }
    if (event.type === 'tool_call_start') {
      const index = Number.isFinite(Number(event.index)) ? Number(event.index) : 0;
      toolCalls.set(index, {
        name: toPlainText(event.name || '').trim(),
        arguments: ''
      });
      return;
    }
    if (event.type === 'tool_call_delta') {
      const index = Number.isFinite(Number(event.index)) ? Number(event.index) : 0;
      const call = toolCalls.get(index) || { name: toPlainText(event.name || '').trim(), arguments: '' };
      call.arguments += toPlainText(event.delta || '');
      toolCalls.set(index, call);
      return;
    }
    if (event.type === 'tool_call_done') {
      const index = Number.isFinite(Number(event.index)) ? Number(event.index) : 0;
      const call = toolCalls.get(index) || {
        name: toPlainText(event.name || '').trim(),
        arguments: toPlainText(event.arguments || '')
      };
      let args = {};
      try {
        args = JSON.parse(toPlainText(call.arguments || event.arguments || '{}') || '{}');
      } catch (_error) {
        args = {};
      }
      emit({
        candidates: [{
          content: {
            role: 'model',
            parts: [{ functionCall: { name: call.name, args } }]
          },
          index: 0
        }],
        modelVersion
      });
      return;
    }
    if (event.type === 'message_stop') {
      finishReason = mapCanonicalFinishReasonToGemini(event.finishReason);
      if (event.usage) usage = normalizeCanonicalUsage(event.usage);
    }
  });

  const finalPayload = {
    candidates: [{
      content: { role: 'model', parts: [] },
      finishReason,
      index: 0
    }],
    modelVersion
  };
  if (usage) {
    finalPayload.usageMetadata = {
      promptTokenCount: usage.input_tokens,
      candidatesTokenCount: usage.output_tokens,
      totalTokenCount: usage.total_tokens
    };
  }
  emit(finalPayload);
  return lines.join('');
}

function renderOpenAIResponsesSseFromCanonicalEvents(events, fallbackModel) {
  const list = Array.isArray(events) ? events : [];
  const first = list.find((event) => event && event.type === 'message_start') || {};
  const responseId = toPlainText(first.id || '').trim() || `resp_${Date.now()}`;
  const messageId = `msg_${Date.now()}`;
  const model = toPlainText(first.model || fallbackModel || '').trim();
  const createdAt = Number(first.created || Math.floor(Date.now() / 1000));
  const responseBase = {
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status: 'in_progress',
    model,
    output: [],
    usage: null
  };
  const lines = [];
  const emit = (event, data) => {
    lines.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  emit('response.created', { type: 'response.created', response: responseBase });
  emit('response.in_progress', { type: 'response.in_progress', response: responseBase });
  const hasText = list.some((event) => (
    event
    && event.type === 'content_delta'
    && event.contentType === 'text'
    && toPlainText(event.text || '')
  ));
  const hasToolCall = list.some((event) => event && event.type === 'tool_call_start');
  const shouldEmitMessage = hasText || !hasToolCall;
  if (shouldEmitMessage) {
    emit('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: messageId, type: 'message', status: 'in_progress', role: 'assistant', content: [] }
    });
    emit('response.content_part.added', {
      type: 'response.content_part.added',
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] }
    });
  }
  let text = '';
  const toolCalls = new Map();
  let outputIndex = shouldEmitMessage ? 1 : 0;
  let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  list.forEach((event) => {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'content_delta' && event.contentType === 'text') {
      text += toPlainText(event.text || '');
      if (!shouldEmitMessage) return;
      emit('response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        delta: toPlainText(event.text || '')
      });
      return;
    }
    if (event.type === 'tool_call_start') {
      const itemId = toPlainText(event.id || '').trim() || `fc_${Date.now()}_${event.index || 0}`;
      const call = {
        itemId,
        outputIndex: outputIndex++,
        id: itemId,
        call_id: itemId,
        name: toPlainText(event.name || '').trim(),
        arguments: ''
      };
      toolCalls.set(Number(event.index || 0), call);
      emit('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: call.outputIndex,
        item: {
          id: call.id,
          type: 'function_call',
          status: 'in_progress',
          call_id: call.call_id,
          name: call.name,
          arguments: ''
        }
      });
      return;
    }
    if (event.type === 'tool_call_delta') {
      const call = toolCalls.get(Number(event.index || 0));
      if (!call) return;
      const delta = toPlainText(event.delta || '');
      call.arguments += delta;
      emit('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        item_id: call.itemId,
        output_index: call.outputIndex,
        delta
      });
      return;
    }
    if (event.type === 'tool_call_done') {
      const call = toolCalls.get(Number(event.index || 0));
      if (!call) return;
      emit('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        item_id: call.itemId,
        output_index: call.outputIndex,
        arguments: call.arguments
      });
      emit('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: call.outputIndex,
        item: {
          id: call.id,
          type: 'function_call',
          status: 'completed',
          call_id: call.call_id,
          name: call.name,
          arguments: call.arguments
        }
      });
      return;
    }
    if (event.type === 'message_stop' && event.usage) {
      usage = normalizeCanonicalUsage(event.usage);
    }
  });
  const output = [];
  if (shouldEmitMessage) {
    emit('response.output_text.done', {
      type: 'response.output_text.done',
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      text
    });
    emit('response.content_part.done', {
      type: 'response.content_part.done',
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text, annotations: [] }
    });
    emit('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: messageId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }]
      }
    });
    output.push({
      id: messageId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }]
    });
  }
  Array.from(toolCalls.values()).forEach((call) => {
    output.push({
      id: call.id,
      type: 'function_call',
      status: 'completed',
      call_id: call.call_id,
      name: call.name,
      arguments: call.arguments
    });
  });
  emit('response.completed', {
    type: 'response.completed',
    response: {
      ...responseBase,
      status: 'completed',
      output,
      usage
    }
  });
  return lines.join('');
}

module.exports = {
  toPlainText,
  stringifyJson,
  buildDataUrl,
  parseDataUrl,
  createTextPart,
  createImagePart,
  readTextFromCanonicalParts,
  normalizeOpenAIContentParts,
  normalizeAnthropicContentParts,
  normalizeGeminiContentParts,
  canonicalPartsToOpenAIContent,
  canonicalPartsToAnthropicContent,
  canonicalPartsToGeminiParts,
  parseSseJsonEvents,
  parseOpenAIChatSseToCanonicalEvents,
  parseAnthropicSseToCanonicalEvents,
  normalizeCanonicalUsage,
  renderOpenAIChatSseFromCanonicalEvents,
  renderAnthropicSseFromCanonicalEvents,
  renderGeminiSseFromCanonicalEvents,
  renderOpenAIResponsesSseFromCanonicalEvents
};
