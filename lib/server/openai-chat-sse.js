'use strict';

function readFirstOpenAIChatChoice(payload) {
  return payload
    && Array.isArray(payload.choices)
    && payload.choices[0]
    ? payload.choices[0]
    : {};
}

function readOpenAIChatMessage(payload) {
  const choice = readFirstOpenAIChatChoice(payload);
  return choice && choice.message && typeof choice.message === 'object' ? choice.message : {};
}

function stringifyToolArguments(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value && typeof value === 'object' ? value : {});
  } catch (_error) {
    return '{}';
  }
}

function normalizeOpenAIChatToolCalls(toolCalls) {
  return (Array.isArray(toolCalls) ? toolCalls : [])
    .map((toolCall, index) => {
      if (!toolCall || typeof toolCall !== 'object') return null;
      const fn = toolCall.function && typeof toolCall.function === 'object' ? toolCall.function : {};
      const name = String(fn.name || '').trim();
      if (!name) return null;
      return {
        index,
        id: String(toolCall.id || `call_${index + 1}`).trim(),
        type: 'function',
        function: {
          name,
          arguments: stringifyToolArguments(fn.arguments)
        }
      };
    })
    .filter(Boolean);
}

function writeOpenAIChatCompletionPayloadAsSse(res, payload = {}, fallbackModel, meta = {}) {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');

  const choice = readFirstOpenAIChatChoice(payload);
  const message = readOpenAIChatMessage(payload);
  const id = String(payload.id || `chatcmpl-${Date.now()}`).trim();
  const created = Number(payload.created || Math.floor(Date.now() / 1000));
  const model = String(payload.model || fallbackModel || '').trim() || 'unknown';
  const sessionId = String(meta && (meta.session_id || meta.sessionId) || payload.session_id || payload.sessionId || '').trim();
  const base = sessionId ? { session_id: sessionId, sessionId } : {};
  const writeChunk = (delta, finishReason = null, extra = {}) => {
    res.write(`data: ${JSON.stringify({
      ...base,
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...extra
    })}\n\n`);
  };

  writeChunk({ role: 'assistant' });
  const reasoning = String(message.reasoning_content || '').trim();
  if (reasoning) writeChunk({ reasoning_content: reasoning });
  const content = typeof message.content === 'string' ? message.content : '';
  if (content) writeChunk({ content });
  const toolCalls = normalizeOpenAIChatToolCalls(message.tool_calls);
  if (toolCalls.length > 0) writeChunk({ tool_calls: toolCalls });
  const finishReason = String(
    choice.finish_reason
    || (toolCalls.length > 0 ? 'tool_calls' : 'stop')
  ).trim() || (toolCalls.length > 0 ? 'tool_calls' : 'stop');
  writeChunk({}, finishReason, payload.usage && typeof payload.usage === 'object' ? { usage: payload.usage } : {});
  res.write('data: [DONE]\n\n');
  res.end();
}

module.exports = {
  writeOpenAIChatCompletionPayloadAsSse,
  __private: {
    normalizeOpenAIChatToolCalls,
    readFirstOpenAIChatChoice,
    readOpenAIChatMessage,
    stringifyToolArguments
  }
};
