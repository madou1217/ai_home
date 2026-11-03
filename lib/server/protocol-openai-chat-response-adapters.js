'use strict';

const {
  resolveAnthropicStopReason,
  resolveGeminiFinishReason
} = require('./protocol-finish-reason');
const {
  mapOpenAIChatUsageToAnthropic
} = require('../protocol/token-usage');

function toPlainText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function readFirstOpenAIChatChoice(payload) {
  return payload
    && Array.isArray(payload.choices)
    && payload.choices[0]
    ? payload.choices[0]
    : null;
}

function readOpenAIChatChoiceMessage(choice) {
  return choice && choice.message && typeof choice.message === 'object'
    ? choice.message
    : {};
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

function readOpenAIChatCompletionModel(payload, fallbackModel) {
  return toPlainText(payload && payload.model || fallbackModel || '').trim();
}

function convertOpenAIChatCompletionToAnthropicMessage(payload, fallbackModel) {
  const choice = readFirstOpenAIChatChoice(payload);
  const message = readOpenAIChatChoiceMessage(choice);
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
  const hasToolUse = content.some((part) => part && part.type === 'tool_use');
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }
  return {
    id: toPlainText(payload && payload.id || '').trim() || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: readOpenAIChatCompletionModel(payload, fallbackModel),
    content,
    stop_reason: resolveAnthropicStopReason(choice && choice.finish_reason, { hasToolUse }),
    stop_sequence: null,
    usage: mapOpenAIChatUsageToAnthropic(payload && payload.usage)
  };
}

function convertOpenAIChatCompletionToGeminiGenerateContent(payload, fallbackModel) {
  const choice = readFirstOpenAIChatChoice(payload);
  const message = readOpenAIChatChoiceMessage(choice);
  const reasoningText = toPlainText(message.reasoning_content || '');
  const text = toPlainText(message.content || '');
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const parts = [];
  if (reasoningText) parts.push({ thought: true, text: reasoningText });
  if (text) parts.push({ text });
  toolCalls.forEach((toolCall) => {
    if (!toolCall || toolCall.type !== 'function') return;
    const fn = toolCall.function && typeof toolCall.function === 'object' ? toolCall.function : {};
    const name = toPlainText(fn.name || '').trim();
    if (!name) return;
    const id = toPlainText(toolCall.id || '').trim();
    parts.push({
      functionCall: {
        ...(id ? { id } : {}),
        name,
        args: parseToolArguments(fn.arguments)
      }
    });
  });
  const usage = payload && payload.usage && typeof payload.usage === 'object' ? payload.usage : {};
  return {
    candidates: [{
      content: {
        role: 'model',
        parts: parts.length > 0 ? parts : [{ text: '' }]
      },
      finishReason: resolveGeminiFinishReason(choice && choice.finish_reason),
      index: 0
    }],
    usageMetadata: {
      promptTokenCount: Number(usage.prompt_tokens || 0),
      candidatesTokenCount: Number(usage.completion_tokens || 0),
      totalTokenCount: Number(usage.total_tokens || 0)
    },
    modelVersion: readOpenAIChatCompletionModel(payload, fallbackModel)
  };
}

function convertOpenAIChatCompletionToOpenAIResponse(payload, fallbackModel) {
  const choice = readFirstOpenAIChatChoice(payload);
  const message = readOpenAIChatChoiceMessage(choice);
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
    model: readOpenAIChatCompletionModel(payload, fallbackModel),
    output,
    usage: {
      input_tokens: Number(usage.prompt_tokens || 0),
      output_tokens: Number(usage.completion_tokens || 0),
      total_tokens: Number(usage.total_tokens || 0)
    }
  };
}

module.exports = {
  convertOpenAIChatCompletionToAnthropicMessage,
  convertOpenAIChatCompletionToGeminiGenerateContent,
  convertOpenAIChatCompletionToOpenAIResponse,
  readFirstOpenAIChatChoice,
  readOpenAIChatCompletionModel,
  readOpenAIChatChoiceMessage,
  __private: {
    parseToolArguments
  }
};
