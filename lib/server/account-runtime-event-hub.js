'use strict';

const {
  ACCOUNT_RUNTIME_CHANGED,
  normalizeAccountRuntimeEvent
} = require('./account-runtime-event-types');

function normalizeEvent(type, event) {
  return type === ACCOUNT_RUNTIME_CHANGED ? normalizeAccountRuntimeEvent(event) : event;
}

// 需求：提供轻量同步事件中心，让账号状态 producer 只发布事实，不直接调用 DB/pool/WebUI 副作用。
function createAccountRuntimeEventHub(options = {}) {
  const listeners = new Map();
  const onError = typeof options.onError === 'function' ? options.onError : null;

  function on(type, listener) {
    const eventType = String(type || '').trim();
    if (!eventType || typeof listener !== 'function') return () => {};
    if (!listeners.has(eventType)) listeners.set(eventType, new Set());
    listeners.get(eventType).add(listener);
    return () => {
      const set = listeners.get(eventType);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) listeners.delete(eventType);
    };
  }

  function emit(type, event) {
    const eventType = String(type || '').trim();
    const normalized = normalizeEvent(eventType, event);
    if (!eventType || !normalized) return [];
    const set = listeners.get(eventType);
    if (!set || set.size === 0) return [];
    const results = [];
    Array.from(set).forEach((listener) => {
      try {
        results.push(listener(normalized));
      } catch (error) {
        if (onError) onError(error, normalized);
      }
    });
    return results;
  }

  return {
    on,
    emit
  };
}

module.exports = {
  createAccountRuntimeEventHub
};
