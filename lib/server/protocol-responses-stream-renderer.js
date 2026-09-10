'use strict';

const { normalizeCanonicalUsage } = require('../protocol/token-usage');

function toPlainText(value) { return value == null ? '' : String(value); }
function writeSseJson(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function createOpenAIResponsesRenderer(emit, fallbackModel) {
  const state = {
    responseBase: null,
    messageId: `msg_${Date.now()}`,
    textStarted: false,
    textIndex: null,
    reasoning: null,
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
    state.textIndex = state.outputIndex++;
    emit(writeSseJson('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: state.textIndex,
      item: { id: state.messageId, type: 'message', status: 'in_progress', role: 'assistant', content: [] }
    }));
    emit(writeSseJson('response.content_part.added', {
      type: 'response.content_part.added',
      item_id: state.messageId,
      output_index: state.textIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] }
    }));
  };
  const finishText = () => {
    if (!state.textStarted) return;
    emit(writeSseJson('response.output_text.done', {
      type: 'response.output_text.done',
      item_id: state.messageId,
      output_index: state.textIndex,
      content_index: 0,
      text: state.text
    }));
    emit(writeSseJson('response.content_part.done', {
      type: 'response.content_part.done',
      item_id: state.messageId,
      output_index: state.textIndex,
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
      output_index: state.textIndex,
      item
    }));
    state.output[state.textIndex] = item;
  };

  const reasoningAddress = () => ({
    item_id: state.reasoning.id, output_index: state.reasoning.index, summary_index: 0
  });
  const finishReasoning = () => {
    const reasoning = state.reasoning;
    if (!reasoning) return;
    const part = { type: 'summary_text', text: reasoning.text };
    emit(writeSseJson('response.reasoning_summary_text.done', {
      type: 'response.reasoning_summary_text.done', ...reasoningAddress(), text: reasoning.text
    }));
    emit(writeSseJson('response.reasoning_summary_part.done', {
      type: 'response.reasoning_summary_part.done', ...reasoningAddress(), part
    }));
    const item = { id: reasoning.id, type: 'reasoning', summary: [part] };
    emit(writeSseJson('response.output_item.done', {
      type: 'response.output_item.done', output_index: reasoning.index, item
    }));
    state.output[reasoning.index] = item;
  };

  return {
    event(event) {
      if (state.completed || !event || typeof event !== 'object') return;
      if (event.type === 'message_start') {
        ensureStarted(event);
        return;
      }
      if (event.type === 'content_delta' && event.contentType === 'thinking') {
        const text = toPlainText(event.text || '');
        if (!text) return;
        ensureStarted();
        if (!state.reasoning) {
          state.reasoning = { id: `rs_${Date.now()}`, index: state.outputIndex++, text: '' };
          emit(writeSseJson('response.output_item.added', {
            type: 'response.output_item.added', output_index: state.reasoning.index,
            item: { id: state.reasoning.id, type: 'reasoning', summary: [] }
          }));
          emit(writeSseJson('response.reasoning_summary_part.added', {
            type: 'response.reasoning_summary_part.added', ...reasoningAddress(),
            part: { type: 'summary_text', text: '' }
          }));
        }
        state.reasoning.text += text;
        emit(writeSseJson('response.reasoning_summary_text.delta', {
          type: 'response.reasoning_summary_text.delta', ...reasoningAddress(), delta: text
        }));
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
          output_index: state.textIndex,
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
        state.output[call.outputIndex] = item;
        return;
      }
      if (event.type === 'message_stop') {
        ensureStarted(event);
        if (event.usage) state.usage = normalizeCanonicalUsage(event.usage);
        if (event.finishReason === 'length') {
          state.completed = true;
          emit(writeSseJson('response.failed', {
            type: 'response.failed',
            response: { ...state.responseBase, status: 'failed',
              error: { code: 'max_output_tokens', message: 'Upstream output token limit reached before completion' } }
          }));
          return;
        }
        finishReasoning();
        if (state.outputIndex === 0) ensureText();
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
    },
    end() {
      if (state.completed) return;
      ensureStarted();
      // EOF is transport state, not proof that the model finished its answer.
      // Preserve emitted deltas, but never turn a truncated upstream into success.
      state.completed = true;
      emit(writeSseJson('response.failed', {
        type: 'response.failed',
        response: {
          ...state.responseBase,
          status: 'failed',
          error: { code: 'stream_incomplete', message: 'Upstream stream ended before completion' }
        }
      }));
    }
  };
}

module.exports = { createOpenAIResponsesRenderer };
