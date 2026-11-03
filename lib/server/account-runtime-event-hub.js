'use strict';

const {
  ACCOUNT_RUNTIME_CHANGED,
  normalizeAccountRuntimeEvent
} = require('./account-runtime-event-types');
const {
  ACCOUNT_LIFECYCLE_CHANGED,
  normalizeAccountLifecycleEvent
} = require('./account-lifecycle-event-types');

function normalizeEvent(type, event) {
  if (type === ACCOUNT_RUNTIME_CHANGED) return normalizeAccountRuntimeEvent(event);
  if (type === ACCOUNT_LIFECYCLE_CHANGED) return normalizeAccountLifecycleEvent(event);
  return event;
}

// 订阅模式：精确类型、`account.*` 前缀通配、`*` 全量。
// 新消费者只需要注册一个监听器，不必修改任何发布点（开闭原则）。
function matchesSubscription(pattern, type) {
  if (pattern === type) return true;
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return type.startsWith(pattern.slice(0, -1));
  return false;
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
    const results = [];
    // 同一个函数同时注册了精确类型与通配模式时，一次事件只调用一次。
    const invoked = new Set();
    listeners.forEach((set, pattern) => {
      if (!matchesSubscription(pattern, eventType)) return;
      Array.from(set).forEach((listener) => {
        if (invoked.has(listener)) return;
        invoked.add(listener);
        try {
          results.push(listener(normalized));
        } catch (error) {
          if (onError) onError(error, normalized);
        }
      });
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
