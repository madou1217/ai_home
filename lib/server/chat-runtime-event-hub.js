'use strict';

function normalizeSessionId(value) {
  return String(value == null ? '' : value).trim();
}

function requireSessionId(value) {
  const sessionId = normalizeSessionId(value);
  if (sessionId) return sessionId;
  const error = new Error('chat_runtime_event_session_required');
  error.code = 'chat_runtime_event_session_required';
  throw error;
}

class ChatRuntimeEventHub {
  constructor() {
    this.listeners = new Map();
  }

  subscribe(sessionId, listener) {
    const normalizedId = requireSessionId(sessionId);
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    const listeners = this.listeners.get(normalizedId) || new Set();
    listeners.add(listener);
    this.listeners.set(normalizedId, listeners);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(normalizedId);
    };
  }

  publish(event) {
    const sessionId = requireSessionId(event && event.sessionId);
    const listeners = Array.from(this.listeners.get(sessionId) || []);
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (_error) {}
    }
    return listeners.length;
  }

  listenerCount(sessionId) {
    return (this.listeners.get(normalizeSessionId(sessionId)) || new Set()).size;
  }
}

module.exports = {
  ChatRuntimeEventHub
};
