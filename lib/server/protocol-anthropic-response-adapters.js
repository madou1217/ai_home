'use strict';

const {
  resolveOpenAIChatFinishReason,
  resolveGeminiFinishReason
} = require('./protocol-finish-reason');
const {
  mapAnthropicUsageToOpenAIChat
} = require('../protocol/token-usage');

function toPlainText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function readAnthropicMessageContent(payload) {
  return Array.isArray(payload && payload.content) ? payload.content : [];
}

function readAnthropicMessageModel(payload, fallbackModel) {
  return toPlainText(payload && payload.model || fallbackModel || '').trim();
}

function readAnthropicTextContent(content) {
  return (Array.isArray(content) ? content : [])
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text') return toPlainText(part.text || '');
      return '';
    })
    .filter(Boolean)
    .join('');
}

function convertAnthropicMessageToOpenAIChatCompletion(payload, fallbackModel) {
  const content = readAnthropicMessageContent(payload);
  const text = readAnthropicTextContent(content);
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
    model: readAnthropicMessageModel(payload, fallbackModel),
    choices: [{
      index: 0,
      message,
      finish_reason: resolveOpenAIChatFinishReason(payload && payload.stop_reason)
    }],
    usage: mapAnthropicUsageToOpenAIChat(payload && payload.usage)
  };
}

function convertAnthropicMessageToOpenAIResponse(payload, fallbackModel) {
  const content = readAnthropicMessageContent(payload);
  const output = [];
  const text = readAnthropicTextContent(content);
  if (text || content.every((part) => part && part.type !== 'tool_use')) {
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
  content.forEach((part, index) => {
    if (!part || part.type !== 'tool_use') return;
    const name = toPlainText(part.name || '').trim();
    if (!name) return;
    const callId = toPlainText(part.id || '').trim() || `call_${index + 1}`;
    output.push({
      id: `fc_${callId}`,
      type: 'function_call',
      status: 'completed',
      call_id: callId,
      name,
      arguments: JSON.stringify(part.input && typeof part.input === 'object' ? part.input : {})
    });
  });
  const usage = payload && payload.usage && typeof payload.usage === 'object' ? payload.usage : {};
  return {
    id: toPlainText(payload && payload.id || '').trim() || `resp_${Date.now()}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: readAnthropicMessageModel(payload, fallbackModel),
    output,
    usage: {
      input_tokens: Number(usage.input_tokens || 0),
      output_tokens: Number(usage.output_tokens || 0),
      total_tokens: Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0)
    }
  };
}

function convertAnthropicMessageToGeminiGenerateContent(payload, fallbackModel) {
  const parts = [];
  readAnthropicMessageContent(payload).forEach((part) => {
    if (!part || typeof part !== 'object') return;
    if (part.type === 'thinking') {
      const text = toPlainText(part.thinking || part.text || '');
      if (text) {
        parts.push({
          thought: true,
          text,
          ...(part.signature ? { thoughtSignature: part.signature } : {})
        });
      }
      return;
    }
    if (part.type === 'text') {
      const text = toPlainText(part.text || '');
      if (text) parts.push({ text });
      return;
    }
    if (part.type === 'tool_use') {
      const name = toPlainText(part.name || '').trim();
      if (!name) return;
      parts.push({
        functionCall: {
          ...(part.id ? { id: toPlainText(part.id).trim() } : {}),
          name,
          args: part.input && typeof part.input === 'object' ? part.input : {}
        }
      });
    }
  });
  const usage = payload && payload.usage && typeof payload.usage === 'object' ? payload.usage : {};
  return {
    candidates: [{
      content: {
        role: 'model',
        parts: parts.length > 0 ? parts : [{ text: '' }]
      },
      finishReason: resolveGeminiFinishReason(payload && payload.stop_reason),
      index: 0
    }],
    usageMetadata: {
      promptTokenCount: Number(usage.input_tokens || 0),
      candidatesTokenCount: Number(usage.output_tokens || 0),
      totalTokenCount: Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0)
    },
    modelVersion: readAnthropicMessageModel(payload, fallbackModel)
  };
}

module.exports = {
  convertAnthropicMessageToGeminiGenerateContent,
  convertAnthropicMessageToOpenAIChatCompletion,
  convertAnthropicMessageToOpenAIResponse,
  readAnthropicMessageContent,
  readAnthropicMessageModel,
  readAnthropicTextContent
};
