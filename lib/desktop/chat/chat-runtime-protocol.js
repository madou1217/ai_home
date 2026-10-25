'use strict';

const MESSAGE_TYPES = new Set([
  'chat.open', 'chat.submit', 'chat.stop', 'chat.close', 'chat.event', 'chat.error'
]);

class DesktopChatProtocolError extends Error {
  constructor(code, details) {
    super(code);
    this.name = 'DesktopChatProtocolError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function encodeChatMessage(message) {
  const normalized = normalizeChatMessage(message);
  return `${JSON.stringify(normalized)}\n`;
}

function decodeChatLine(line) {
  if (typeof line !== 'string') throw new DesktopChatProtocolError('chat_protocol_line_invalid');
  const source = line.trim();
  if (!source) return null;
  let value;
  try {
    value = JSON.parse(source);
  } catch (_error) {
    throw new DesktopChatProtocolError('chat_protocol_json_invalid');
  }
  return normalizeChatMessage(value);
}

function normalizeChatMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new DesktopChatProtocolError('chat_protocol_message_invalid');
  }
  const normalized = { ...message };
  const type = requiredText(normalized.type, 'chat_protocol_type_invalid');
  if (!MESSAGE_TYPES.has(type)) throw new DesktopChatProtocolError('chat_protocol_type_unsupported', { type });
  normalized.type = type;
  if (normalized.requestId !== undefined) normalized.requestId = requiredText(normalized.requestId, 'chat_protocol_request_id_invalid');
  if (normalized.sessionId !== undefined) normalized.sessionId = requiredText(normalized.sessionId, 'chat_protocol_session_id_invalid');
  if (normalized.commandId !== undefined) normalized.commandId = requiredText(normalized.commandId, 'chat_protocol_command_id_invalid');
  if (type === 'chat.open') {
    if (normalized.requestId === undefined) throw new DesktopChatProtocolError('chat_protocol_request_id_required');
    if (!normalized.target || typeof normalized.target !== 'object' || Array.isArray(normalized.target)) {
      throw new DesktopChatProtocolError('chat_protocol_target_required');
    }
  } else if (type === 'chat.submit') {
    requireIdentity(normalized, true);
    normalized.text = requiredText(normalized.text, 'chat_protocol_text_required');
  } else if (type === 'chat.stop') {
    requireIdentity(normalized, true);
  } else if (type === 'chat.close') {
    if (normalized.requestId === undefined) throw new DesktopChatProtocolError('chat_protocol_request_id_required');
  } else if (type === 'chat.event') {
    requireIdentity(normalized, false);
    if (!normalized.event || typeof normalized.event !== 'object' || Array.isArray(normalized.event)) {
      throw new DesktopChatProtocolError('chat_protocol_event_required');
    }
  } else if (type === 'chat.error') {
    if (normalized.requestId === undefined) throw new DesktopChatProtocolError('chat_protocol_request_id_required');
    normalized.code = requiredText(normalized.code, 'chat_protocol_error_code_invalid');
    if (normalized.message !== undefined) normalized.message = String(normalized.message);
  }
  return normalized;
}

function requireIdentity(message, requireCommand) {
  if (message.requestId === undefined) throw new DesktopChatProtocolError('chat_protocol_request_id_required');
  if (message.sessionId === undefined) throw new DesktopChatProtocolError('chat_protocol_session_id_required');
  if (requireCommand && message.commandId === undefined) throw new DesktopChatProtocolError('chat_protocol_command_id_required');
}

function requiredText(value, code) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new DesktopChatProtocolError(code);
  return text;
}

function createChatJsonlParser() {
  let buffer = '';
  let ended = false;
  const messageListeners = new Set();
  const errorListeners = new Set();
  const emitError = (error) => { for (const listener of errorListeners) listener(error); };
  const emitLine = (line) => {
    try {
      const message = decodeChatLine(line);
      if (message !== null) for (const listener of messageListeners) listener(message);
    } catch (error) {
      emitError(error);
    }
  };
  const push = (chunk) => {
    if (ended) throw new DesktopChatProtocolError('chat_protocol_parser_closed');
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      emitLine(line);
    }
  };
  const end = () => {
    if (ended) return;
    ended = true;
    if (buffer.trim()) emitLine(buffer);
    buffer = '';
  };
  return {
    push,
    end,
    onMessage(listener) { if (typeof listener === 'function') messageListeners.add(listener); return this; },
    onError(listener) { if (typeof listener === 'function') errorListeners.add(listener); return this; },
    close: end
  };
}

function chatOpen(requestId, target) {
  return { type: 'chat.open', requestId, target };
}

function chatSubmit(requestId, sessionId, commandId, text, options = {}) {
  return {
    ...(options && typeof options === 'object' && !Array.isArray(options) ? options : {}),
    type: 'chat.submit', requestId, sessionId, commandId, text
  };
}

function chatStop(requestId, sessionId, commandId) {
  return { type: 'chat.stop', requestId, sessionId, commandId };
}

function chatClose(requestId) {
  return { type: 'chat.close', requestId };
}

function chatEvent(requestId, sessionId, event) {
  return { type: 'chat.event', requestId, sessionId, event };
}

function chatError(requestId, code, message, identity = {}) {
  return {
    ...(identity && typeof identity === 'object' && !Array.isArray(identity) ? identity : {}),
    type: 'chat.error', requestId, code, ...(message === undefined ? {} : { message })
  };
}

module.exports = {
  MESSAGE_TYPES,
  DesktopChatProtocolError,
  encodeChatMessage,
  decodeChatLine,
  normalizeChatMessage,
  createChatJsonlParser,
  chatOpen,
  chatSubmit,
  chatStop,
  chatClose,
  chatEvent,
  chatError,
  // Explicit aliases make the projection convenient to consume from helper code.
  encodeChatRuntimeMessage: encodeChatMessage,
  decodeChatRuntimeLine: decodeChatLine,
  createChatRuntimeJsonlParser: createChatJsonlParser
};
