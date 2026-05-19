import { resolveQueueMode as resolveProviderQueueMode } from './provider-capabilities.js';

export function appendQueuedMessage(queueByKey, sessionKey, item) {
  const current = queueByKey && typeof queueByKey === 'object' ? queueByKey : {};
  const nextList = [...(current[sessionKey] || []), item];
  return {
    ...current,
    [sessionKey]: nextList
  };
}

export function prependQueuedMessage(queueByKey, sessionKey, item) {
  const current = queueByKey && typeof queueByKey === 'object' ? queueByKey : {};
  const nextList = [item, ...(current[sessionKey] || [])];
  return {
    ...current,
    [sessionKey]: nextList
  };
}

export function removeQueuedMessage(queueByKey, sessionKey, messageId) {
  const current = queueByKey && typeof queueByKey === 'object' ? queueByKey : {};
  const currentList = current[sessionKey] || [];
  const nextList = currentList.filter((item) => item.id !== messageId);
  const next = { ...current };
  if (nextList.length > 0) next[sessionKey] = nextList;
  else delete next[sessionKey];
  return next;
}

export function shiftQueuedMessage(queueByKey, sessionKey) {
  const current = queueByKey && typeof queueByKey === 'object' ? queueByKey : {};
  const currentList = current[sessionKey] || [];
  if (currentList.length === 0) {
    return { nextState: current, shifted: null };
  }

  const [first, ...rest] = currentList;
  const next = { ...current };
  if (rest.length > 0) next[sessionKey] = rest;
  else delete next[sessionKey];
  return { nextState: next, shifted: first || null };
}

export function shiftQueuedMessageByMode(queueByKey, sessionKey, mode) {
  const current = queueByKey && typeof queueByKey === 'object' ? queueByKey : {};
  const currentList = current[sessionKey] || [];
  const targetIndex = currentList.findIndex((item) => item.mode === mode);
  if (targetIndex < 0) {
    return { nextState: current, shifted: null };
  }

  const shifted = currentList[targetIndex] || null;
  const nextList = currentList.filter((_, index) => index !== targetIndex);
  const next = { ...current };
  if (nextList.length > 0) next[sessionKey] = nextList;
  else delete next[sessionKey];
  return { nextState: next, shifted };
}

export function moveQueuedMessages(queueByKey, fromKey, toKey) {
  if (!fromKey || !toKey || fromKey === toKey) {
    return queueByKey && typeof queueByKey === 'object' ? queueByKey : {};
  }

  const current = queueByKey && typeof queueByKey === 'object' ? queueByKey : {};
  const fromList = current[fromKey] || [];
  if (fromList.length === 0) return current;

  const next = { ...current };
  next[toKey] = [...(next[toKey] || []), ...fromList];
  delete next[fromKey];
  return next;
}

export function moveQueuedMessageToFront(queueByKey, sessionKey, messageId) {
  const current = queueByKey && typeof queueByKey === 'object' ? queueByKey : {};
  const currentList = current[sessionKey] || [];
  const targetIndex = currentList.findIndex((item) => item.id === messageId);
  if (targetIndex < 0) {
    return {
      nextState: current,
      moved: null
    };
  }

  const moved = currentList[targetIndex] || null;
  const nextList = [
    moved,
    ...currentList.filter((_, index) => index !== targetIndex)
  ];
  return {
    nextState: {
      ...current,
      [sessionKey]: nextList
    },
    moved
  };
}

export function resolveQueuedMode(provider, apiKeyMode) {
  return resolveProviderQueueMode(provider, apiKeyMode);
}
