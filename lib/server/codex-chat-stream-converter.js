'use strict';

const { toPlainText } = require('./protocol-canonical');

function createChunk(state, delta, finishReason = null, usage) {
  const chunk = {
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason
      }
    ]
  };
  if (usage && typeof usage === 'object') {
    chunk.usage = usage;
  }
  return chunk;
}

function readEventOutputIndex(event) {
  const value = Number(event && event.output_index);
  return Number.isFinite(value) ? value : null;
}

function readToolItemId(event, item) {
  return toPlainText(
    item && item.id
    || event && event.item_id
    || ''
  ).trim();
}

function readToolCallId(event, item) {
  return toPlainText(
    item && item.call_id
    || event && event.call_id
    || ''
  ).trim();
}

function rememberToolCall(state, call, event, item) {
  const outputIndex = readEventOutputIndex(event);
  if (outputIndex !== null) state.toolCallsByOutputIndex.set(outputIndex, call);
  const itemId = readToolItemId(event, item);
  if (itemId) state.toolCallsByItemId.set(itemId, call);
  const callId = readToolCallId(event, item);
  if (callId) state.toolCallsByCallId.set(callId, call);
}

function findToolCall(state, event, item) {
  const outputIndex = readEventOutputIndex(event);
  if (outputIndex !== null && state.toolCallsByOutputIndex.has(outputIndex)) {
    return state.toolCallsByOutputIndex.get(outputIndex);
  }
  const itemId = readToolItemId(event, item);
  if (itemId && state.toolCallsByItemId.has(itemId)) return state.toolCallsByItemId.get(itemId);
  const callId = readToolCallId(event, item);
  if (callId && state.toolCallsByCallId.has(callId)) return state.toolCallsByCallId.get(callId);
  return null;
}

function ensureToolCall(state, chunks, event, item) {
  const existing = findToolCall(state, event, item);
  if (existing) return existing;
  const index = state.nextToolIndex;
  state.nextToolIndex += 1;
  state.hasToolCall = true;
  const call = {
    index,
    id: toPlainText(item && (item.call_id || item.id) || '').trim() || `call_${index + 1}`,
    name: toPlainText(item && item.name || '').trim(),
    arguments: ''
  };
  rememberToolCall(state, call, event, item);
  chunks.push(createChunk(state, {
    tool_calls: [
      {
        index: call.index,
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: ''
        }
      }
    ]
  }));
  return call;
}

function appendToolArgumentsDelta(state, chunks, call, delta) {
  const text = toPlainText(delta || '');
  if (!call || !text) return;
  call.arguments += text;
  chunks.push(createChunk(state, {
    tool_calls: [
      {
        index: call.index,
        function: {
          arguments: text
        }
      }
    ]
  }));
}

function reconcileToolArguments(state, chunks, call, finalArguments) {
  const finalText = toPlainText(finalArguments || '');
  if (!call || !finalText || finalText === call.arguments) return;
  if (!call.arguments) {
    appendToolArgumentsDelta(state, chunks, call, finalText);
    return;
  }
  if (finalText.startsWith(call.arguments)) {
    appendToolArgumentsDelta(state, chunks, call, finalText.slice(call.arguments.length));
  }
}

function mapUsageFromCodexResponse(response) {
  const usage = response && typeof response === 'object' ? response.usage : null;
  if (!usage || typeof usage !== 'object') return null;
  const promptTokens = Number(usage.input_tokens || 0);
  const completionTokens = Number(usage.output_tokens || 0);
  const totalTokens = Number(usage.total_tokens || promptTokens + completionTokens);
  return {
    prompt_tokens: Number.isFinite(promptTokens) ? promptTokens : 0,
    completion_tokens: Number.isFinite(completionTokens) ? completionTokens : 0,
    total_tokens: Number.isFinite(totalTokens) ? totalTokens : 0
  };
}

function createCodexChatStreamConverter(requestedModel) {
  const now = Math.floor(Date.now() / 1000);
  const state = {
    id: `chatcmpl-${Date.now()}`,
    created: now,
    model: toPlainText(requestedModel || '').trim() || 'unknown',
    roleSent: false,
    nextToolIndex: 0,
    hasToolCall: false,
    toolCallsByOutputIndex: new Map(),
    toolCallsByItemId: new Map(),
    toolCallsByCallId: new Map()
  };
  let emittedText = false;
  function handleEvent(event, chunks) {
    if (!event || typeof event !== 'object') return;
    const type = toPlainText(event.type || '').trim();
    if (!type) return;
    if (type === 'response.created' && event.response && typeof event.response === 'object') {
      if (event.response.id) state.id = toPlainText(event.response.id);
      if (Number.isFinite(Number(event.response.created_at))) state.created = Number(event.response.created_at);
      if (event.response.model) state.model = toPlainText(event.response.model);
      if (!state.roleSent) {
        chunks.push(createChunk(state, { role: 'assistant' }));
        state.roleSent = true;
      }
      return;
    }
    if (type === 'response.output_text.delta') {
      if (!state.roleSent) {
        chunks.push(createChunk(state, { role: 'assistant' }));
        state.roleSent = true;
      }
      const text = toPlainText(event.delta || '');
      if (text) {
        emittedText = true;
        chunks.push(createChunk(state, { content: text }));
      }
      return;
    }
    if (type === 'response.reasoning_summary_text.delta') {
      if (!state.roleSent) {
        chunks.push(createChunk(state, { role: 'assistant' }));
        state.roleSent = true;
      }
      const text = toPlainText(event.delta || '');
      if (text) chunks.push(createChunk(state, { reasoning_content: text }));
      return;
    }
    if (type === 'response.output_item.added' && event.item && event.item.type === 'function_call') {
      const call = ensureToolCall(state, chunks, event, event.item);
      reconcileToolArguments(state, chunks, call, event.item.arguments);
      return;
    }
    if (type === 'response.function_call_arguments.delta') {
      const argsDelta = toPlainText(event.delta || '');
      if (!argsDelta) return;
      const call = findToolCall(state, event, null);
      if (!call) return;
      appendToolArgumentsDelta(state, chunks, call, argsDelta);
      return;
    }
    if (type === 'response.function_call_arguments.done') {
      const call = findToolCall(state, event, null);
      reconcileToolArguments(state, chunks, call, event.arguments);
      return;
    }
    if (type === 'response.output_item.done' && event.item && event.item.type === 'function_call') {
      const call = ensureToolCall(state, chunks, event, event.item);
      reconcileToolArguments(state, chunks, call, event.item.arguments);
      return;
    }
    if (type === 'response.completed') {
      const output = Array.isArray(event.response && event.response.output) ? event.response.output : [];
      if (!emittedText) {
        const text = output.filter((item) => item && item.type === 'message')
          .flatMap((item) => item.content || [])
          .filter((part) => part && part.type === 'output_text')
          .map((part) => toPlainText(part.text || '')).join('');
        if (text) chunks.push(createChunk(state, { content: text }));
      }
      output.forEach((item, outputIndex) => {
        if (!item || item.type !== 'function_call') return;
        const call = ensureToolCall(state, chunks, { output_index: outputIndex }, item);
        reconcileToolArguments(state, chunks, call, item.arguments);
      });
      const usage = event.response && typeof event.response === 'object'
        ? mapUsageFromCodexResponse(event.response)
        : null;
      chunks.push(createChunk(
        state,
        {},
        state.hasToolCall ? 'tool_calls' : 'stop',
        usage || undefined
      ));
    }
  }

  return {
    event(event) {
      const chunks = [];
      handleEvent(event, chunks);
      return chunks;
    }
  };
}

module.exports = { createCodexChatStreamConverter, mapUsageFromCodexResponse };
