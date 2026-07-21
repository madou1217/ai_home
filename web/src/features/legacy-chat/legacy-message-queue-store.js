import {
  appendQueuedMessage,
  moveQueuedMessageToFront,
  moveQueuedMessages,
  prependQueuedMessage,
  readPersistedQueue,
  removeQueuedMessage,
  shiftQueuedMessage,
  shiftQueuedMessageByMode,
  writePersistedQueue,
} from '@/components/chat/queue-state.js';

const listeners = new Set();
const hydratedKeys = new Set();
let state = {};

function publish(next, persistedKeys = []) {
  if (next === state) return;
  state = next;
  persistedKeys.forEach((key) => writePersistedQueue(key, state[key] || []));
  listeners.forEach((listener) => listener());
}

function ensureHydrated(sessionKey) {
  if (!sessionKey || hydratedKeys.has(sessionKey)) return;
  hydratedKeys.add(sessionKey);
  const persisted = readPersistedQueue(sessionKey);
  if (persisted.length > 0 && (state[sessionKey] || []).length === 0) {
    publish({ ...state, [sessionKey]: persisted });
  }
}

function enqueue(sessionKey, item) {
  publish(appendQueuedMessage(state, sessionKey, item), [sessionKey]);
}

function prepend(sessionKey, item) {
  publish(prependQueuedMessage(state, sessionKey, item), [sessionKey]);
}

function remove(sessionKey, messageId) {
  publish(removeQueuedMessage(state, sessionKey, messageId), [sessionKey]);
}

function shift(sessionKey) {
  const result = shiftQueuedMessage(state, sessionKey);
  publish(result.nextState, [sessionKey]);
  return result.shifted;
}

function shiftByMode(sessionKey, mode) {
  const result = shiftQueuedMessageByMode(state, sessionKey, mode);
  publish(result.nextState, [sessionKey]);
  return result.shifted;
}

function move(fromKey, toKey) {
  if (!fromKey || !toKey || fromKey === toKey) return;
  publish(moveQueuedMessages(state, fromKey, toKey), [fromKey, toKey]);
}

function prioritize(sessionKey, messageId) {
  const result = moveQueuedMessageToFront(state, sessionKey, messageId);
  publish(result.nextState, [sessionKey]);
  return result.moved;
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const legacyMessageQueueStore = {
  enqueue,
  ensureHydrated,
  getSnapshot: () => state,
  move,
  prepend,
  prioritize,
  remove,
  shift,
  shiftByMode,
  subscribe,
};
