'use strict';

const {
  toPlainText,
  readTextFromCanonicalParts,
  normalizeOpenAIContentParts,
  normalizeCanonicalUsage,
  parseOpenAIChatSseToCanonicalEvents,
  parseOpenAIResponsesSseToCanonicalEvents,
  parseAnthropicSseToCanonicalEvents,
  renderOpenAIChatSseFromCanonicalEvents,
  renderAnthropicSseFromCanonicalEvents,
  renderGeminiSseFromCanonicalEvents,
  renderOpenAIResponsesSseFromCanonicalEvents
} = require('./protocol-canonical');
const {
  resolveOpenAIChatFinishReason,
  resolveAnthropicStopReason,
  resolveGeminiFinishReason
} = require('./protocol-finish-reason');
const {
  normalizeProtocolId,
  resolveProtocolPath
} = require('./protocol-graph');
const {
  normalizeToolCallInput
} = require('../protocol/tool-call-normalization');

const STREAM_CANONICAL_EVENT_PROTOCOL = 'aih_canonical_events';

const STREAM_RAW_PARSERS = Object.freeze({
  openai_chat: parseOpenAIChatSseToCanonicalEvents,
  openai_responses: parseOpenAIResponsesSseToCanonicalEvents,
  anthropic_messages: parseAnthropicSseToCanonicalEvents,
  gemini_generate_content: parseGeminiSseToCanonicalEvents,
  gemini_stream_generate_content: parseGeminiSseToCanonicalEvents
});

const STREAM_BATCH_RENDERERS = Object.freeze({
  openai_chat: renderOpenAIChatSseFromCanonicalEvents,
  anthropic_messages: renderAnthropicSseFromCanonicalEvents,
  gemini_generate_content: renderGeminiSseFromCanonicalEvents,
  gemini_stream_generate_content: renderGeminiSseFromCanonicalEvents,
  openai_responses: renderOpenAIResponsesSseFromCanonicalEvents
});

function createStreamPipelineEdges() {
  return Object.freeze([
    ...Object.entries(STREAM_RAW_PARSERS).map(([sourceProtocol, parse]) => Object.freeze({
      id: `${sourceProtocol}->${STREAM_CANONICAL_EVENT_PROTOCOL}`,
      sourceProtocol,
      targetProtocol: STREAM_CANONICAL_EVENT_PROTOCOL,
      parse
    })),
    ...Object.entries(STREAM_BATCH_RENDERERS).map(([targetProtocol, render]) => Object.freeze({
      id: `${STREAM_CANONICAL_EVENT_PROTOCOL}->${targetProtocol}`,
      sourceProtocol: STREAM_CANONICAL_EVENT_PROTOCOL,
      targetProtocol,
      render
    }))
  ]);
}

const STREAM_PIPELINE_EDGES = createStreamPipelineEdges();

function resolveStreamPipeline(sourceProtocol, targetProtocol) {
  const source = normalizeProtocolId(sourceProtocol);
  const target = normalizeProtocolId(targetProtocol);
  if (!source || !target) return null;
  if (source === target) {
    return {
      id: `${source}->${source}`,
      source,
      target,
      sourceProtocol: source,
      targetProtocol: target,
      eventProtocol: STREAM_CANONICAL_EVENT_PROTOCOL,
      identity: true
    };
  }
  const path = resolveProtocolPath(STREAM_PIPELINE_EDGES, source, target);
  if (!path || path.length !== 2) return null;
  const parse = path[0] && path[0].parse;
  const render = path[1] && path[1].render;
  if (typeof parse !== 'function' || typeof render !== 'function') return null;
  return {
    id: `${source}->${STREAM_CANONICAL_EVENT_PROTOCOL}->${target}`,
    source,
    target,
    sourceProtocol: source,
    targetProtocol: target,
    eventProtocol: STREAM_CANONICAL_EVENT_PROTOCOL,
    identity: false,
    parse,
    render
  };
}

function shouldNormalizeGeminiToolInputs(sourceProtocol, targetProtocol) {
  const source = normalizeProtocolId(sourceProtocol);
  return (
    (source === 'gemini_generate_content' || source === 'gemini_stream_generate_content')
    && normalizeProtocolId(targetProtocol) === 'anthropic_messages'
  );
}

function createStreamParserOptions(sourceProtocol, targetProtocol) {
  return {
    normalizeToolInputs: shouldNormalizeGeminiToolInputs(sourceProtocol, targetProtocol)
  };
}

function convertSseViaCanonical(sourceProtocol, targetProtocol, rawText, fallbackModel) {
  const pipeline = resolveStreamPipeline(sourceProtocol, targetProtocol);
  if (!pipeline) {
    if (!STREAM_RAW_PARSERS[normalizeProtocolId(sourceProtocol)]) {
      throw new Error(`unsupported_stream_source_protocol:${sourceProtocol}`);
    }
    if (!STREAM_BATCH_RENDERERS[normalizeProtocolId(targetProtocol)]) {
      throw new Error(`unsupported_stream_target_protocol:${targetProtocol}`);
    }
    throw new Error(`unsupported_stream_pipeline:${sourceProtocol}->${targetProtocol}`);
  }
  if (pipeline.identity) return String(rawText || '');
  return pipeline.render(
    pipeline.parse(rawText, fallbackModel, createStreamParserOptions(sourceProtocol, targetProtocol)),
    fallbackModel
  );
}

function parseGeminiSseToCanonicalEvents(rawText, fallbackModel, options = {}) {
  const events = [];
  const parser = createGeminiParser((event) => events.push(event), fallbackModel, options);
  parser.write(rawText);
  parser.end();
  return events;
}

function createCanonicalParser(sourceProtocol, emit, fallbackModel, options = {}) {
  const source = normalizeProtocolId(sourceProtocol);
  if (source === 'openai_chat') {
    return createOpenAIChatParser(emit, fallbackModel);
  }
  if (source === 'openai_responses') {
    return createOpenAIResponsesParser(emit, fallbackModel);
  }
  if (source === 'anthropic_messages') {
    return createAnthropicParser(emit, fallbackModel);
  }
  if (source === 'gemini_generate_content' || source === 'gemini_stream_generate_content') {
    return createGeminiParser(emit, fallbackModel, options);
  }
  throw new Error(`unsupported_stream_source_protocol:${sourceProtocol}`);
}

function assertStreamPipeline(sourceProtocol, targetProtocol) {
  const pipeline = resolveStreamPipeline(sourceProtocol, targetProtocol);
  if (pipeline) return pipeline;
  if (!STREAM_RAW_PARSERS[normalizeProtocolId(sourceProtocol)]) {
    throw new Error(`unsupported_stream_source_protocol:${sourceProtocol}`);
  }
  if (!STREAM_BATCH_RENDERERS[normalizeProtocolId(targetProtocol)]) {
    throw new Error(`unsupported_stream_target_protocol:${targetProtocol}`);
  }
  throw new Error(`unsupported_stream_pipeline:${sourceProtocol}->${targetProtocol}`);
}

function writeSseJson(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function writeOpenAIData(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function mapFinishReasonToOpenAI(reason) {
  return resolveOpenAIChatFinishReason(reason);
}

function mapFinishReasonToAnthropic(reason) {
  return resolveAnthropicStopReason(reason);
}

function mapFinishReasonToGemini(reason) {
  return resolveGeminiFinishReason(reason);
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
        const previous = state.toolCalls.get(index) || { id: '', name: '', arguments: '', started: false };
        const fn = toolCall.function && typeof toolCall.function === 'object' ? toolCall.function : {};
        const argumentDelta = toPlainText(fn.arguments || '');
        const next = {
          id: toPlainText(toolCall.id || previous.id || '').trim(),
          name: toPlainText(fn.name || previous.name || '').trim(),
          arguments: previous.arguments + argumentDelta,
          started: previous.started
        };
        if (!next.started && next.name) {
          emit({ type: 'tool_call_start', index, id: next.id, name: next.name });
          next.started = true;
          if (next.arguments) {
            emit({ type: 'tool_call_delta', index, id: next.id, name: next.name, delta: next.arguments });
          }
        } else if (next.started && argumentDelta) {
          emit({ type: 'tool_call_delta', index, id: next.id, name: next.name, delta: argumentDelta });
        }
        state.toolCalls.set(index, next);
      });
    }
    if (choice.finish_reason && !state.stopped) {
      state.toolCalls.forEach((toolCall, index) => {
        if (state.completedToolCalls.has(index)) return;
        if (!toolCall.started) {
          emit({ type: 'tool_call_start', index, id: toolCall.id, name: toolCall.name });
          if (toolCall.arguments) {
            emit({ type: 'tool_call_delta', index, id: toolCall.id, name: toolCall.name, delta: toolCall.arguments });
          }
        }
        emit({ type: 'tool_call_done', index, ...toolCall });
        state.completedToolCalls.add(index);
      });
      state.stopped = true;
      emit({
        type: 'message_stop',
        finishReason: resolveOpenAIChatFinishReason(choice.finish_reason, {
          hasToolCalls: state.toolCalls.size > 0
        }),
        usage: chunk.usage || null
      });
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

function createOpenAIResponsesParser(emit, fallbackModel) {
  const state = {
    buffer: '',
    eventName: '',
    dataLines: [],
    started: false,
    stopped: false,
    emittedText: false,
    id: '',
    model: toPlainText(fallbackModel || '').trim(),
    created: Math.floor(Date.now() / 1000),
    toolCalls: new Map(),
    completedToolCalls: new Set()
  };

  const emitStart = (response = {}) => {
    if (response && typeof response === 'object') {
      state.id = toPlainText(response.id || state.id || '').trim();
      state.model = toPlainText(response.model || state.model || '').trim();
      state.created = Number(response.created_at || response.created || state.created);
    }
    if (state.started) return;
    state.started = true;
    emit({
      type: 'message_start',
      id: state.id || `resp_${Date.now()}`,
      model: state.model,
      created: state.created
    });
  };

  const rememberToolCall = (data = {}, item = {}) => {
    const index = Number.isFinite(Number(data.output_index)) ? Number(data.output_index) : state.toolCalls.size;
    const previous = state.toolCalls.get(index) || { id: '', name: '', arguments: '', started: false };
    const call = {
      id: toPlainText(item.call_id || item.id || previous.id || '').trim(),
      name: toPlainText(item.name || previous.name || '').trim(),
      arguments: toPlainText(previous.arguments || ''),
      started: previous.started
    };
    if (!call.started && call.name) {
      emit({ type: 'tool_call_start', index, id: call.id, name: call.name });
      call.started = true;
    }
    state.toolCalls.set(index, call);
    return { index, call };
  };

  const findToolCall = (data = {}) => {
    const outputIndex = Number(data.output_index);
    if (Number.isFinite(outputIndex) && state.toolCalls.has(outputIndex)) {
      return { index: outputIndex, call: state.toolCalls.get(outputIndex) };
    }
    const itemId = toPlainText(data.item_id || '').trim();
    if (itemId) {
      for (const [index, call] of state.toolCalls.entries()) {
        if (call && call.id === itemId) return { index, call };
      }
    }
    const index = Number.isFinite(outputIndex) ? outputIndex : state.toolCalls.size;
    const call = { id: itemId, name: '', arguments: '', started: false };
    state.toolCalls.set(index, call);
    return { index, call };
  };

  const emitToolDelta = (index, call, delta) => {
    const text = toPlainText(delta || '');
    if (!call || !text) return;
    call.arguments = toPlainText(call.arguments || '') + text;
    if (call.started) emit({ type: 'tool_call_delta', index, id: call.id, name: call.name, delta: text });
  };

  const completeToolCall = (data = {}, item = {}) => {
    const { index, call } = rememberToolCall(data, item);
    const finalArguments = toPlainText(item.arguments || '').trim();
    if (finalArguments && finalArguments !== call.arguments) {
      const delta = finalArguments.startsWith(call.arguments)
        ? finalArguments.slice(call.arguments.length)
        : finalArguments;
      emitToolDelta(index, call, delta);
      call.arguments = finalArguments;
    }
    emit({ type: 'tool_call_done', index, id: call.id, name: call.name, arguments: call.arguments });
    state.completedToolCalls.add(index);
  };

  const backfillCompletedOutput = (response = {}) => {
    (Array.isArray(response.output) ? response.output : []).forEach((item, outputIndex) => {
      if (!item || typeof item !== 'object') return;
      if (item.type === 'message' && !state.emittedText) {
        const text = readTextFromCanonicalParts(normalizeOpenAIContentParts(item.content));
        if (text) {
          state.emittedText = true;
          emit({ type: 'content_delta', contentType: 'text', text });
        }
        return;
      }
      if (item.type === 'function_call' && !state.completedToolCalls.has(outputIndex)) {
        completeToolCall({ output_index: outputIndex }, item);
      }
    });
  };

  const flushFrame = () => {
    if (state.dataLines.length === 0) {
      state.eventName = '';
      return;
    }
    const raw = state.dataLines.join('\n').trim();
    const eventName = state.eventName;
    state.dataLines = [];
    state.eventName = '';
    if (!raw || raw === '[DONE]') return;
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (_error) {
      return;
    }
    const type = toPlainText(data && data.type || eventName || '').trim();
    if (type === 'response.created' || type === 'response.in_progress') {
      emitStart(data.response);
      return;
    }
    if (type === 'response.output_item.added') {
      emitStart();
      const item = data.item && typeof data.item === 'object' ? data.item : {};
      if (item.type === 'function_call') rememberToolCall(data, item);
      return;
    }
    if (type === 'response.output_text.delta') {
      emitStart();
      const text = toPlainText(data.delta || '');
      if (text) {
        state.emittedText = true;
        emit({ type: 'content_delta', contentType: 'text', text });
      }
      return;
    }
    if (type === 'response.function_call_arguments.delta') {
      emitStart();
      const { index, call } = findToolCall(data);
      emitToolDelta(index, call, data.delta);
      return;
    }
    if (type === 'response.function_call_arguments.done') {
      emitStart();
      const { index, call } = findToolCall(data);
      const finalArguments = toPlainText(data.arguments || '').trim();
      if (finalArguments && finalArguments !== call.arguments) {
        const delta = finalArguments.startsWith(call.arguments)
          ? finalArguments.slice(call.arguments.length)
          : finalArguments;
        emitToolDelta(index, call, delta);
        call.arguments = finalArguments;
      }
      return;
    }
    if (type === 'response.output_item.done') {
      emitStart();
      const item = data.item && typeof data.item === 'object' ? data.item : {};
      if (item.type === 'function_call') completeToolCall(data, item);
      return;
    }
    if (type === 'response.completed') {
      const response = data.response && typeof data.response === 'object' ? data.response : {};
      emitStart(response);
      backfillCompletedOutput(response);
      state.stopped = true;
      emit({
        type: 'message_stop',
        finishReason: resolveOpenAIChatFinishReason('', { hasToolCalls: state.toolCalls.size > 0 }),
        usage: normalizeCanonicalUsage(response.usage)
      });
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
        state.toolCalls.forEach((call, index) => {
          if (state.completedToolCalls.has(index)) return;
          emit({ type: 'tool_call_done', index, id: call.id, name: call.name, arguments: call.arguments });
        });
        state.stopped = true;
        emit({
          type: 'message_stop',
          finishReason: resolveOpenAIChatFinishReason('', { hasToolCalls: state.toolCalls.size > 0 }),
          usage: null
        });
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
      if (delta.type === 'thinking_delta') {
        const text = toPlainText(delta.thinking || '');
        if (text) emit({ type: 'content_delta', contentType: 'thinking', text });
        return;
      }
      if (delta.type === 'signature_delta') {
        const signature = toPlainText(delta.signature || '').trim();
        if (signature) emit({ type: 'content_delta', contentType: 'thinking_signature', signature });
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

function mapGeminiUsageToCanonical(usageMetadata) {
  const usage = usageMetadata && typeof usageMetadata === 'object' ? usageMetadata : {};
  const inputTokens = Number(usage.promptTokenCount || usage.prompt_token_count || 0);
  const outputTokens = Number(usage.candidatesTokenCount || usage.candidates_token_count || 0);
  const totalTokens = Number(usage.totalTokenCount || usage.total_token_count || inputTokens + outputTokens);
  return {
    input_tokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    output_tokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    total_tokens: Number.isFinite(totalTokens) ? totalTokens : 0
  };
}

function createGeminiParser(emit, fallbackModel, options = {}) {
  const state = {
    buffer: '',
    dataLines: [],
    started: false,
    stopped: false,
    model: toPlainText(fallbackModel || '').trim(),
    finishReason: 'STOP',
    usage: null,
    nextToolIndex: 0,
    hasToolCalls: false
  };

  const emitStart = (payload = {}) => {
    const model = toPlainText(payload.modelVersion || payload.model || state.model || fallbackModel || '').trim();
    if (model) state.model = model;
    if (state.started) return;
    state.started = true;
    emit({
      type: 'message_start',
      id: toPlainText(payload.id || '').trim(),
      model: state.model,
      created: Number(payload.created || Math.floor(Date.now() / 1000))
    });
  };

  const emitFunctionCall = (functionCall) => {
    if (!functionCall || typeof functionCall !== 'object') return;
    const name = toPlainText(functionCall.name || '').trim();
    if (!name) return;
    const index = state.nextToolIndex++;
    const id = toPlainText(functionCall.id || '').trim() || `call_${index + 1}`;
    const rawArgs = functionCall.args && typeof functionCall.args === 'object' ? functionCall.args : {};
    const args = options.normalizeToolInputs ? normalizeToolCallInput(name, rawArgs).input : rawArgs;
    const argumentsText = JSON.stringify(args);
    state.hasToolCalls = true;
    emit({ type: 'tool_call_start', index, id, name });
    if (argumentsText && argumentsText !== '{}') {
      emit({ type: 'tool_call_delta', index, id, name, delta: argumentsText });
    }
    emit({ type: 'tool_call_done', index, id, name, arguments: argumentsText });
  };

  const flushFrame = () => {
    if (state.dataLines.length === 0) return;
    const data = state.dataLines.join('\n').trim();
    state.dataLines = [];
    if (!data || data === '[DONE]') return;
    let payload = null;
    try {
      payload = JSON.parse(data);
    } catch (_error) {
      return;
    }
    emitStart(payload);
    // cloudcode-pa(agy）流式分片把候选/用量包在 { response: { candidates, usageMetadata } } 里；
    // 公有 Gemini API 则直接平铺。两种都要认，否则 agy 流式 → anthropic 全程空（0 token）。
    const root = payload && payload.response && typeof payload.response === 'object'
      ? payload.response
      : payload;
    const usageMetadata = payload.usageMetadata || root.usageMetadata;
    if (usageMetadata) state.usage = mapGeminiUsageToCanonical(usageMetadata);
    const candidates = Array.isArray(root.candidates) ? root.candidates : [];
    candidates.forEach((candidate) => {
      const content = candidate && candidate.content && typeof candidate.content === 'object'
        ? candidate.content
        : {};
      const parts = Array.isArray(content.parts) ? content.parts : [];
      parts.forEach((part) => {
        if (!part || typeof part !== 'object') return;
        const functionCall = part.functionCall || part.function_call;
        if (functionCall && typeof functionCall === 'object') {
          emitFunctionCall(functionCall);
          return;
        }
        const text = toPlainText(part.text || '');
        if (!text) return;
        emit({
          type: 'content_delta',
          contentType: part.thought === true ? 'thinking' : 'text',
          text
        });
      });
      if (candidate && candidate.finishReason) {
        state.finishReason = toPlainText(candidate.finishReason || '').trim() || state.finishReason;
      }
    });
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
        emit({
          type: 'message_stop',
          finishReason: resolveOpenAIChatFinishReason(state.finishReason, {
            hasToolCalls: state.hasToolCalls
          }),
          usage: state.usage
        });
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
    thinkingBlockIndex: null,
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
  const ensureThinkingBlock = () => {
    ensureStarted();
    if (state.thinkingBlockIndex !== null) return state.thinkingBlockIndex;
    state.thinkingBlockIndex = state.nextBlockIndex++;
    emit(writeSseJson('content_block_start', {
      type: 'content_block_start',
      index: state.thinkingBlockIndex,
      content_block: { type: 'thinking', thinking: '' }
    }));
    return state.thinkingBlockIndex;
  };
  const finishTextBlock = () => {
    if (state.textBlockIndex === null) return;
    emit(writeSseJson('content_block_stop', { type: 'content_block_stop', index: state.textBlockIndex }));
    state.textBlockIndex = null;
  };
  const finishThinkingBlock = () => {
    if (state.thinkingBlockIndex === null) return;
    emit(writeSseJson('content_block_stop', { type: 'content_block_stop', index: state.thinkingBlockIndex }));
    state.thinkingBlockIndex = null;
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
        finishThinkingBlock();
        emit(writeSseJson('content_block_delta', {
          type: 'content_block_delta',
          index: ensureTextBlock(),
          delta: { type: 'text_delta', text }
        }));
        return;
      }
      if (event.type === 'content_delta' && event.contentType === 'thinking') {
        const text = toPlainText(event.text || '');
        if (!text) return;
        finishTextBlock();
        emit(writeSseJson('content_block_delta', {
          type: 'content_block_delta',
          index: ensureThinkingBlock(),
          delta: { type: 'thinking_delta', thinking: text }
        }));
        return;
      }
      if (event.type === 'content_delta' && event.contentType === 'thinking_signature') {
        const signature = toPlainText(event.signature || '').trim();
        if (!signature) return;
        finishTextBlock();
        emit(writeSseJson('content_block_delta', {
          type: 'content_block_delta',
          index: ensureThinkingBlock(),
          delta: { type: 'signature_delta', signature }
        }));
        return;
      }
      if (event.type === 'tool_call_start') {
        ensureStarted(event);
        finishTextBlock();
        finishThinkingBlock();
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
        state.finalReason = resolveAnthropicStopReason(event.finishReason, {
          hasToolCalls: state.toolBlockIndexes.size > 0
        });
        this.end();
      }
    },
    end() {
      if (state.completed) return;
      ensureStarted();
      finishTextBlock();
      finishThinkingBlock();
      state.completed = true;
      emit(writeSseJson('message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: resolveAnthropicStopReason(state.finalReason, {
            hasToolCalls: state.toolBlockIndexes.size > 0
          }),
          stop_sequence: null
        },
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
          id: toPlainText(event.id || '').trim(),
          name: toPlainText(event.name || '').trim(),
          arguments: ''
        });
        return;
      }
      if (event.type === 'tool_call_delta') {
        const index = Number.isFinite(Number(event.index)) ? Number(event.index) : 0;
        const call = state.toolCalls.get(index) || {
          id: toPlainText(event.id || '').trim(),
          name: toPlainText(event.name || '').trim(),
          arguments: ''
        };
        call.arguments += toPlainText(event.delta || '');
        state.toolCalls.set(index, call);
        return;
      }
      if (event.type === 'tool_call_done') {
        const index = Number.isFinite(Number(event.index)) ? Number(event.index) : 0;
        const call = state.toolCalls.get(index) || {
          id: toPlainText(event.id || '').trim(),
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
            content: {
              role: 'model',
              parts: [{
                functionCall: {
                  ...(call.id ? { id: call.id } : {}),
                  name: call.name,
                  args
                }
              }]
            },
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
  const pipeline = assertStreamPipeline(sourceProtocol, targetProtocol);
  if (pipeline.identity) {
    return {
      write(chunk) {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
        if (!text) return;
        if (typeof options.onChunk === 'function') onChunk(text);
        else chunks.push(text);
      },
      end() {
        return chunks.join('');
      }
    };
  }
  const renderer = createCanonicalRenderer(pipeline.targetProtocol, onChunk, options.fallbackModel);
  const parser = createCanonicalParser(
    pipeline.sourceProtocol,
    (event) => renderer.event(event),
    options.fallbackModel,
    createStreamParserOptions(pipeline.sourceProtocol, pipeline.targetProtocol)
  );
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
  return Object.keys(STREAM_RAW_PARSERS).flatMap((source) => (
    Object.keys(STREAM_BATCH_RENDERERS)
      .filter((target) => target !== source)
      .map((target) => ({
        id: `${source}->${STREAM_CANONICAL_EVENT_PROTOCOL}->${target}`,
        source,
        target,
        sourceProtocol: source,
        targetProtocol: target,
        eventProtocol: STREAM_CANONICAL_EVENT_PROTOCOL
      }))
  ));
}

module.exports = {
  convertSseViaCanonical,
  createSseTransformStream,
  createCanonicalRenderer,
  listStreamPipelines,
  resolveStreamPipeline
};
