'use strict';

const {
  toPlainText,
  normalizeCanonicalUsage,
  parseOpenAIChatSseToCanonicalEvents,
  parseAnthropicSseToCanonicalEvents,
  renderOpenAIChatSseFromCanonicalEvents,
  renderAnthropicSseFromCanonicalEvents,
  renderGeminiSseFromCanonicalEvents,
  renderOpenAIResponsesSseFromCanonicalEvents
} = require('./protocol-canonical');

const STREAM_PROTOCOLS = {
  openai_chat: {
    parse: parseOpenAIChatSseToCanonicalEvents,
    render: {
      anthropic_messages: renderAnthropicSseFromCanonicalEvents,
      gemini_generate_content: renderGeminiSseFromCanonicalEvents,
      gemini_stream_generate_content: renderGeminiSseFromCanonicalEvents,
      openai_responses: renderOpenAIResponsesSseFromCanonicalEvents
    }
  },
  anthropic_messages: {
    parse: parseAnthropicSseToCanonicalEvents,
    render: {
      openai_chat: renderOpenAIChatSseFromCanonicalEvents,
      openai_responses: renderOpenAIResponsesSseFromCanonicalEvents,
      gemini_generate_content: renderGeminiSseFromCanonicalEvents,
      gemini_stream_generate_content: renderGeminiSseFromCanonicalEvents
    }
  }
};

function normalizeProtocolId(value) {
  return String(value || '').trim();
}

function convertSseViaCanonical(sourceProtocol, targetProtocol, rawText, fallbackModel) {
  const source = STREAM_PROTOCOLS[normalizeProtocolId(sourceProtocol)];
  if (!source || typeof source.parse !== 'function') {
    throw new Error(`unsupported_stream_source_protocol:${sourceProtocol}`);
  }
  const render = source.render && source.render[normalizeProtocolId(targetProtocol)];
  if (typeof render !== 'function') {
    throw new Error(`unsupported_stream_target_protocol:${targetProtocol}`);
  }
  return render(source.parse(rawText, fallbackModel), fallbackModel);
}

function writeSseJson(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function writeOpenAIData(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function mapFinishReasonToOpenAI(reason) {
  const value = toPlainText(reason || '').trim();
  if (value === 'max_tokens' || value === 'length' || value === 'MAX_TOKENS') return 'length';
  if (value === 'tool_use' || value === 'tool_calls') return 'tool_calls';
  return 'stop';
}

function mapFinishReasonToAnthropic(reason) {
  const value = toPlainText(reason || '').trim();
  if (value === 'length' || value === 'max_tokens' || value === 'MAX_TOKENS') return 'max_tokens';
  if (value === 'tool_calls' || value === 'tool_use') return 'tool_use';
  return 'end_turn';
}

function mapFinishReasonToGemini(reason) {
  const value = toPlainText(reason || '').trim();
  if (value === 'length' || value === 'max_tokens' || value === 'MAX_TOKENS') return 'MAX_TOKENS';
  return 'STOP';
}

function createOpenAIChatParser(emit, fallbackModel) {
  const state = {
    buffer: '',
    dataLines: [],
    started: false,
    stopped: false,
    toolCalls: new Map(),
    completedToolCalls: new Set()
  };

  const emitStart = (chunk) => {
    if (state.started) return;
    state.started = true;
    emit({
      type: 'message_start',
      id: toPlainText(chunk && chunk.id || '').trim(),
      model: toPlainText(chunk && chunk.model || fallbackModel || '').trim(),
      created: Number(chunk && chunk.created || Math.floor(Date.now() / 1000))
    });
  };

  const flushFrame = () => {
    if (state.dataLines.length === 0) return;
    const data = state.dataLines.join('\n').trim();
    state.dataLines = [];
    if (!data || data === '[DONE]') return;
    let chunk = null;
    try {
      chunk = JSON.parse(data);
    } catch (_error) {
      return;
    }
    const choice = Array.isArray(chunk && chunk.choices) ? chunk.choices[0] : null;
    if (!choice) return;
    emitStart(chunk);
    const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta : {};
    const reasoningText = toPlainText(delta.reasoning_content || '');
    if (reasoningText) emit({ type: 'content_delta', contentType: 'thinking', text: reasoningText });
    const text = toPlainText(delta.content || '');
    if (text) emit({ type: 'content_delta', contentType: 'text', text });
    if (Array.isArray(delta.tool_calls)) {
      delta.tool_calls.forEach((toolCall) => {
        if (!toolCall || typeof toolCall !== 'object') return;
        const index = Number.isFinite(Number(toolCall.index)) ? Number(toolCall.index) : 0;
        const previous = state.toolCalls.get(index) || { id: '', name: '', arguments: '' };
        const fn = toolCall.function && typeof toolCall.function === 'object' ? toolCall.function : {};
        const next = {
          id: toPlainText(toolCall.id || previous.id || '').trim(),
          name: toPlainText(fn.name || previous.name || '').trim(),
          arguments: previous.arguments + toPlainText(fn.arguments || '')
        };
        if (!state.toolCalls.has(index)) {
          emit({ type: 'tool_call_start', index, id: next.id, name: next.name });
        }
        if (fn.arguments) {
          emit({ type: 'tool_call_delta', index, id: next.id, name: next.name, delta: toPlainText(fn.arguments || '') });
        }
        state.toolCalls.set(index, next);
      });
    }
    if (choice.finish_reason && !state.stopped) {
      state.toolCalls.forEach((toolCall, index) => {
        if (state.completedToolCalls.has(index)) return;
        emit({ type: 'tool_call_done', index, ...toolCall });
        state.completedToolCalls.add(index);
      });
      state.stopped = true;
      emit({ type: 'message_stop', finishReason: choice.finish_reason, usage: chunk.usage || null });
    }
  };

  const pushLine = (line) => {
    if (!line.trim()) {
      flushFrame();
      return;
    }
    if (line.startsWith('data:')) state.dataLines.push(line.slice(5).trimStart());
  };

  return {
    write(chunk) {
      state.buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
      const lines = state.buffer.split(/\r?\n/);
      state.buffer = lines.pop() || '';
      lines.forEach(pushLine);
    },
    end() {
      if (state.buffer) {
        pushLine(state.buffer);
        state.buffer = '';
      }
      flushFrame();
      if (state.started && !state.stopped) {
        state.stopped = true;
        emit({ type: 'message_stop', finishReason: 'stop', usage: null });
      }
    }
  };
}

function createAnthropicParser(emit, fallbackModel) {
  const state = {
    buffer: '',
    eventName: '',
    dataLines: [],
    blocks: new Map(),
    toolCalls: new Map(),
    completedToolCalls: new Set(),
    started: false,
    stopped: false,
    id: '',
    model: toPlainText(fallbackModel || '').trim(),
    usage: null,
    finishReason: 'end_turn'
  };

  const emitStart = () => {
    if (state.started) return;
    state.started = true;
    emit({
      type: 'message_start',
      id: state.id || `msg_${Date.now()}`,
      model: state.model,
      created: Math.floor(Date.now() / 1000)
    });
  };

  const flushFrame = () => {
    if (state.dataLines.length === 0) {
      state.eventName = '';
      return;
    }
    const dataText = state.dataLines.join('\n').trim();
    const eventName = state.eventName;
    state.dataLines = [];
    state.eventName = '';
    if (!dataText) return;
    let data = null;
    try {
      data = JSON.parse(dataText);
    } catch (_error) {
      return;
    }
    if (eventName === 'message_start' || data.type === 'message_start') {
      const message = data.message && typeof data.message === 'object' ? data.message : {};
      state.id = toPlainText(message.id || state.id || '').trim();
      state.model = toPlainText(message.model || state.model || '').trim();
      if (message.usage) {
        state.usage = {
          input_tokens: Number(message.usage.input_tokens || 0),
          output_tokens: Number(message.usage.output_tokens || 0)
        };
      }
      emitStart();
      return;
    }
    if (eventName === 'content_block_start' || data.type === 'content_block_start') {
      emitStart();
      const index = Number.isFinite(Number(data.index)) ? Number(data.index) : 0;
      const block = data.content_block && typeof data.content_block === 'object' ? data.content_block : {};
      const blockType = toPlainText(block.type || '').trim();
      state.blocks.set(index, blockType);
      if (blockType === 'tool_use') {
        const input = block.input && typeof block.input === 'object' ? block.input : {};
        const call = {
          index,
          id: toPlainText(block.id || '').trim(),
          name: toPlainText(block.name || '').trim(),
          arguments: Object.keys(input).length > 0 ? JSON.stringify(input) : ''
        };
        state.toolCalls.set(index, call);
        emit({ type: 'tool_call_start', index, id: call.id, name: call.name });
      }
      return;
    }
    if (eventName === 'content_block_delta' || data.type === 'content_block_delta') {
      emitStart();
      const index = Number.isFinite(Number(data.index)) ? Number(data.index) : 0;
      const delta = data.delta && typeof data.delta === 'object' ? data.delta : {};
      if (delta.type === 'text_delta') {
        const text = toPlainText(delta.text || '');
        if (text) emit({ type: 'content_delta', contentType: 'text', text });
        return;
      }
      if (delta.type === 'input_json_delta') {
        const call = state.toolCalls.get(index) || { index, id: '', name: '', arguments: '' };
        const partial = toPlainText(delta.partial_json || '');
        call.arguments += partial;
        state.toolCalls.set(index, call);
        if (partial) emit({ type: 'tool_call_delta', index, id: call.id, name: call.name, delta: partial });
      }
      return;
    }
    if (eventName === 'content_block_stop' || data.type === 'content_block_stop') {
      const index = Number.isFinite(Number(data.index)) ? Number(data.index) : 0;
      if (state.blocks.get(index) === 'tool_use') {
        const call = state.toolCalls.get(index) || { index, id: '', name: '', arguments: '' };
        emit({ type: 'tool_call_done', index, ...call });
        state.completedToolCalls.add(index);
      }
      return;
    }
    if (eventName === 'message_delta' || data.type === 'message_delta') {
      const delta = data.delta && typeof data.delta === 'object' ? data.delta : {};
      if (delta.stop_reason) state.finishReason = toPlainText(delta.stop_reason || '').trim() || state.finishReason;
      if (data.usage) {
        state.usage = {
          input_tokens: Number(state.usage && state.usage.input_tokens || 0),
          output_tokens: Number(data.usage.output_tokens || state.usage && state.usage.output_tokens || 0)
        };
      }
      return;
    }
    if (eventName === 'message_stop' || data.type === 'message_stop') {
      emitStart();
      state.toolCalls.forEach((call, index) => {
        if (state.completedToolCalls.has(index)) return;
        emit({ type: 'tool_call_done', index, ...call });
        state.completedToolCalls.add(index);
      });
      state.stopped = true;
      emit({ type: 'message_stop', finishReason: state.finishReason, usage: state.usage });
    }
  };

  const pushLine = (line) => {
    if (!line.trim()) {
      flushFrame();
      return;
    }
    if (line.startsWith('event:')) {
      state.eventName = line.slice(6).trim();
      return;
    }
    if (line.startsWith('data:')) state.dataLines.push(line.slice(5).trimStart());
  };

  return {
    write(chunk) {
      state.buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
      const lines = state.buffer.split(/\r?\n/);
      state.buffer = lines.pop() || '';
      lines.forEach(pushLine);
    },
    end() {
      if (state.buffer) {
        pushLine(state.buffer);
        state.buffer = '';
      }
      flushFrame();
      if (state.started && !state.stopped) {
        state.stopped = true;
        emit({ type: 'message_stop', finishReason: state.finishReason, usage: state.usage });
      }
    }
  };
}

function createOpenAIResponsesRenderer(emit, fallbackModel) {
  const state = {
    responseBase: null,
    messageId: `msg_${Date.now()}`,
    textStarted: false,
    text: '',
    outputIndex: 0,
    toolCalls: new Map(),
    output: [],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    completed: false
  };
  const ensureStarted = (event = {}) => {
    if (state.responseBase) return;
    state.responseBase = {
      id: toPlainText(event.id || '').trim() || `resp_${Date.now()}`,
      object: 'response',
      created_at: Number(event.created || Math.floor(Date.now() / 1000)),
      status: 'in_progress',
      model: toPlainText(event.model || fallbackModel || '').trim(),
      output: [],
      usage: null
    };
    emit(writeSseJson('response.created', { type: 'response.created', response: state.responseBase }));
    emit(writeSseJson('response.in_progress', { type: 'response.in_progress', response: state.responseBase }));
  };
  const ensureText = () => {
    ensureStarted();
    if (state.textStarted) return;
    state.textStarted = true;
    emit(writeSseJson('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: state.messageId, type: 'message', status: 'in_progress', role: 'assistant', content: [] }
    }));
    emit(writeSseJson('response.content_part.added', {
      type: 'response.content_part.added',
      item_id: state.messageId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] }
    }));
    state.outputIndex = Math.max(state.outputIndex, 1);
  };
  const finishText = () => {
    if (!state.textStarted) return;
    emit(writeSseJson('response.output_text.done', {
      type: 'response.output_text.done',
      item_id: state.messageId,
      output_index: 0,
      content_index: 0,
      text: state.text
    }));
    emit(writeSseJson('response.content_part.done', {
      type: 'response.content_part.done',
      item_id: state.messageId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: state.text, annotations: [] }
    }));
    const item = {
      id: state.messageId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: state.text, annotations: [] }]
    };
    emit(writeSseJson('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item
    }));
    state.output.push(item);
  };

  return {
    event(event) {
      if (!event || typeof event !== 'object') return;
      if (event.type === 'message_start') {
        ensureStarted(event);
        return;
      }
      if (event.type === 'content_delta' && event.contentType === 'text') {
        const text = toPlainText(event.text || '');
        if (!text) return;
        ensureText();
        state.text += text;
        emit(writeSseJson('response.output_text.delta', {
          type: 'response.output_text.delta',
          item_id: state.messageId,
          output_index: 0,
          content_index: 0,
          delta: text
        }));
        return;
      }
      if (event.type === 'tool_call_start') {
        ensureStarted(event);
        const index = Number.isFinite(Number(event.index)) ? Number(event.index) : 0;
        const itemId = toPlainText(event.id || '').trim() || `fc_${Date.now()}_${index}`;
        const call = {
          itemId,
          outputIndex: state.outputIndex++,
          id: itemId,
          call_id: itemId,
          name: toPlainText(event.name || '').trim(),
          arguments: ''
        };
        state.toolCalls.set(index, call);
        emit(writeSseJson('response.output_item.added', {
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
        }));
        return;
      }
      if (event.type === 'tool_call_delta') {
        const call = state.toolCalls.get(Number(event.index || 0));
        if (!call) return;
        const delta = toPlainText(event.delta || '');
        call.arguments += delta;
        emit(writeSseJson('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          item_id: call.itemId,
          output_index: call.outputIndex,
          delta
        }));
        return;
      }
      if (event.type === 'tool_call_done') {
        const call = state.toolCalls.get(Number(event.index || 0));
        if (!call) return;
        emit(writeSseJson('response.function_call_arguments.done', {
          type: 'response.function_call_arguments.done',
          item_id: call.itemId,
          output_index: call.outputIndex,
          arguments: call.arguments
        }));
        const item = {
          id: call.id,
          type: 'function_call',
          status: 'completed',
          call_id: call.call_id,
          name: call.name,
          arguments: call.arguments
        };
        emit(writeSseJson('response.output_item.done', {
          type: 'response.output_item.done',
          output_index: call.outputIndex,
          item
        }));
        state.output.push(item);
        return;
      }
      if (event.type === 'message_stop') {
        ensureStarted(event);
        if (event.usage) state.usage = normalizeCanonicalUsage(event.usage);
        this.end();
      }
    },
    end() {
      if (state.completed) return;
      ensureStarted();
      if (!state.textStarted && state.output.length === 0) ensureText();
      finishText();
      state.completed = true;
      emit(writeSseJson('response.completed', {
        type: 'response.completed',
        response: {
          ...state.responseBase,
          status: 'completed',
          output: state.output,
          usage: state.usage
        }
      }));
    }
  };
}

function createAnthropicRenderer(emit, fallbackModel) {
  const state = {
    started: false,
    textBlockIndex: null,
    nextBlockIndex: 0,
    toolBlockIndexes: new Map(),
    usage: { input_tokens: 0, output_tokens: 0 },
    finalReason: 'end_turn',
    completed: false
  };
  const ensureStarted = (event = {}) => {
    if (state.started) return;
    state.started = true;
    emit(writeSseJson('message_start', {
      type: 'message_start',
      message: {
        id: toPlainText(event.id || '').trim() || `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: toPlainText(event.model || fallbackModel || '').trim(),
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: state.usage
      }
    }));
  };
  const ensureTextBlock = () => {
    ensureStarted();
    if (state.textBlockIndex !== null) return state.textBlockIndex;
    state.textBlockIndex = state.nextBlockIndex++;
    emit(writeSseJson('content_block_start', {
      type: 'content_block_start',
      index: state.textBlockIndex,
      content_block: { type: 'text', text: '' }
    }));
    return state.textBlockIndex;
  };

  return {
    event(event) {
      if (!event || typeof event !== 'object') return;
      if (event.type === 'message_start') {
        ensureStarted(event);
        return;
      }
      if (event.type === 'content_delta' && event.contentType === 'text') {
        const text = toPlainText(event.text || '');
        if (!text) return;
        emit(writeSseJson('content_block_delta', {
          type: 'content_block_delta',
          index: ensureTextBlock(),
          delta: { type: 'text_delta', text }
        }));
        return;
      }
      if (event.type === 'tool_call_start') {
        ensureStarted(event);
        const index = Number.isFinite(Number(event.index)) ? Number(event.index) : 0;
        const blockIndex = state.nextBlockIndex++;
        state.toolBlockIndexes.set(index, blockIndex);
        emit(writeSseJson('content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: {
            type: 'tool_use',
            id: toPlainText(event.id || '').trim() || `toolu_${index + 1}`,
            name: toPlainText(event.name || '').trim(),
            input: {}
          }
        }));
        return;
      }
      if (event.type === 'tool_call_delta') {
        const blockIndex = state.toolBlockIndexes.get(Number(event.index || 0));
        if (blockIndex === undefined) return;
        const delta = toPlainText(event.delta || '');
        if (!delta) return;
        emit(writeSseJson('content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'input_json_delta', partial_json: delta }
        }));
        return;
      }
      if (event.type === 'tool_call_done') {
        const blockIndex = state.toolBlockIndexes.get(Number(event.index || 0));
        if (blockIndex === undefined) return;
        emit(writeSseJson('content_block_stop', { type: 'content_block_stop', index: blockIndex }));
        return;
      }
      if (event.type === 'message_stop') {
        const normalizedUsage = normalizeCanonicalUsage(event.usage);
        state.usage = {
          input_tokens: normalizedUsage.input_tokens,
          output_tokens: normalizedUsage.output_tokens
        };
        state.finalReason = mapFinishReasonToAnthropic(event.finishReason);
        this.end();
      }
    },
    end() {
      if (state.completed) return;
      ensureStarted();
      if (state.textBlockIndex !== null) {
        emit(writeSseJson('content_block_stop', { type: 'content_block_stop', index: state.textBlockIndex }));
      }
      state.completed = true;
      emit(writeSseJson('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: state.finalReason, stop_sequence: null },
        usage: state.usage
      }));
      emit(writeSseJson('message_stop', { type: 'message_stop' }));
    }
  };
}

function createGeminiRenderer(emit, fallbackModel) {
  const state = {
    modelVersion: toPlainText(fallbackModel || '').trim(),
    usage: null,
    finishReason: 'STOP',
    toolCalls: new Map(),
    completed: false
  };
  const emitPayload = (payload) => emit(writeOpenAIData(payload));
  return {
    event(event) {
      if (!event || typeof event !== 'object') return;
      if (event.type === 'message_start') {
        state.modelVersion = toPlainText(event.model || state.modelVersion || '').trim();
        return;
      }
      if (event.type === 'content_delta' && event.contentType === 'thinking') {
        const text = toPlainText(event.text || '');
        if (!text) return;
        emitPayload({
          candidates: [{
            content: { role: 'model', parts: [{ thought: true, text }] },
            index: 0
          }],
          modelVersion: state.modelVersion
        });
        return;
      }
      if (event.type === 'content_delta' && event.contentType === 'text') {
        const text = toPlainText(event.text || '');
        if (!text) return;
        emitPayload({
          candidates: [{
            content: { role: 'model', parts: [{ text }] },
            index: 0
          }],
          modelVersion: state.modelVersion
        });
        return;
      }
      if (event.type === 'tool_call_start') {
        const index = Number.isFinite(Number(event.index)) ? Number(event.index) : 0;
        state.toolCalls.set(index, {
          name: toPlainText(event.name || '').trim(),
          arguments: ''
        });
        return;
      }
      if (event.type === 'tool_call_delta') {
        const index = Number.isFinite(Number(event.index)) ? Number(event.index) : 0;
        const call = state.toolCalls.get(index) || { name: toPlainText(event.name || '').trim(), arguments: '' };
        call.arguments += toPlainText(event.delta || '');
        state.toolCalls.set(index, call);
        return;
      }
      if (event.type === 'tool_call_done') {
        const index = Number.isFinite(Number(event.index)) ? Number(event.index) : 0;
        const call = state.toolCalls.get(index) || {
          name: toPlainText(event.name || '').trim(),
          arguments: toPlainText(event.arguments || '')
        };
        let args = {};
        try {
          args = JSON.parse(toPlainText(call.arguments || '{}') || '{}');
        } catch (_error) {
          args = {};
        }
        emitPayload({
          candidates: [{
            content: { role: 'model', parts: [{ functionCall: { name: call.name, args } }] },
            index: 0
          }],
          modelVersion: state.modelVersion
        });
        return;
      }
      if (event.type === 'message_stop') {
        state.finishReason = mapFinishReasonToGemini(event.finishReason);
        if (event.usage) state.usage = normalizeCanonicalUsage(event.usage);
        this.end();
      }
    },
    end() {
      if (state.completed) return;
      state.completed = true;
      const payload = {
        candidates: [{
          content: { role: 'model', parts: [] },
          finishReason: state.finishReason,
          index: 0
        }],
        modelVersion: state.modelVersion
      };
      if (state.usage) {
        payload.usageMetadata = {
          promptTokenCount: state.usage.input_tokens,
          candidatesTokenCount: state.usage.output_tokens,
          totalTokenCount: state.usage.total_tokens
        };
      }
      emitPayload(payload);
    }
  };
}

function createOpenAIChatRenderer(emit, fallbackModel) {
  const state = {
    id: `chatcmpl_${Date.now()}`,
    model: toPlainText(fallbackModel || '').trim(),
    created: Math.floor(Date.now() / 1000),
    usage: null,
    finishReason: 'stop',
    started: false,
    completed: false
  };
  const emitPayload = (payload) => emit(writeOpenAIData(payload));
  const ensureStarted = (event = {}) => {
    if (state.started) return;
    state.started = true;
    state.id = toPlainText(event.id || state.id).trim() || state.id;
    state.model = toPlainText(event.model || state.model || '').trim();
    state.created = Number(event.created || state.created);
    emitPayload({
      id: state.id,
      object: 'chat.completion.chunk',
      created: state.created,
      model: state.model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
    });
  };
  return {
    event(event) {
      if (!event || typeof event !== 'object') return;
      if (event.type === 'message_start') {
        ensureStarted(event);
        return;
      }
      ensureStarted();
      if (event.type === 'content_delta' && event.contentType === 'thinking') {
        const text = toPlainText(event.text || '');
        if (!text) return;
        emitPayload({
          id: state.id,
          object: 'chat.completion.chunk',
          created: state.created,
          model: state.model,
          choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }]
        });
        return;
      }
      if (event.type === 'content_delta' && event.contentType === 'text') {
        const text = toPlainText(event.text || '');
        if (!text) return;
        emitPayload({
          id: state.id,
          object: 'chat.completion.chunk',
          created: state.created,
          model: state.model,
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
        });
        return;
      }
      if (event.type === 'tool_call_start') {
        const index = Number.isFinite(Number(event.index)) ? Number(event.index) : 0;
        emitPayload({
          id: state.id,
          object: 'chat.completion.chunk',
          created: state.created,
          model: state.model,
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
        emitPayload({
          id: state.id,
          object: 'chat.completion.chunk',
          created: state.created,
          model: state.model,
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index, function: { arguments: delta } }] },
            finish_reason: null
          }]
        });
        return;
      }
      if (event.type === 'message_stop') {
        state.finishReason = mapFinishReasonToOpenAI(event.finishReason);
        if (event.usage) state.usage = normalizeCanonicalUsage(event.usage);
        this.end();
      }
    },
    end() {
      if (state.completed) return;
      ensureStarted();
      state.completed = true;
      emitPayload({
        id: state.id,
        object: 'chat.completion.chunk',
        created: state.created,
        model: state.model,
        choices: [{ index: 0, delta: {}, finish_reason: state.finishReason }],
        ...(state.usage ? {
          usage: {
            prompt_tokens: state.usage.input_tokens,
            completion_tokens: state.usage.output_tokens,
            total_tokens: state.usage.total_tokens
          }
        } : {})
      });
      emit('data: [DONE]\n\n');
    }
  };
}

function createCanonicalRenderer(targetProtocol, emit, fallbackModel) {
  const target = normalizeProtocolId(targetProtocol);
  if (target === 'openai_responses') return createOpenAIResponsesRenderer(emit, fallbackModel);
  if (target === 'anthropic_messages') return createAnthropicRenderer(emit, fallbackModel);
  if (target === 'gemini_generate_content' || target === 'gemini_stream_generate_content') {
    return createGeminiRenderer(emit, fallbackModel);
  }
  if (target === 'openai_chat') return createOpenAIChatRenderer(emit, fallbackModel);
  throw new Error(`unsupported_stream_target_protocol:${targetProtocol}`);
}

function createSseTransformStream(sourceProtocol, targetProtocol, options = {}) {
  const chunks = [];
  const onChunk = typeof options.onChunk === 'function'
    ? options.onChunk
    : (chunk) => chunks.push(chunk);
  const renderer = createCanonicalRenderer(targetProtocol, onChunk, options.fallbackModel);
  const source = normalizeProtocolId(sourceProtocol);
  let parser = null;
  if (source === 'openai_chat') {
    parser = createOpenAIChatParser((event) => renderer.event(event), options.fallbackModel);
  } else if (source === 'anthropic_messages') {
    parser = createAnthropicParser((event) => renderer.event(event), options.fallbackModel);
  } else {
    throw new Error(`unsupported_stream_source_protocol:${sourceProtocol}`);
  }
  return {
    write(chunk) {
      parser.write(chunk);
    },
    end() {
      parser.end();
      if (typeof renderer.end === 'function') renderer.end();
      return chunks.join('');
    }
  };
}

function listStreamPipelines() {
  return Object.entries(STREAM_PROTOCOLS).flatMap(([source, descriptor]) => (
    Object.keys(descriptor.render || {}).map((target) => ({ source, target }))
  ));
}

module.exports = {
  convertSseViaCanonical,
  createSseTransformStream,
  listStreamPipelines
};
