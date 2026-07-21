'use strict';

const UNAVAILABLE_ERROR = 'chat_runtime_database_unavailable';

function createOptionalChatRuntime(options = {}, deps = {}) {
  const createComposition = deps.createComposition;
  if (typeof createComposition !== 'function') {
    throw new Error('chat_runtime_composition_required');
  }
  try {
    return createComposition(options);
  } catch (error) {
    if (!isUnavailable(error)) throw error;
    const warn = typeof deps.warn === 'function' ? deps.warn : () => {};
    warn('Chat runtime unavailable: this Node runtime does not provide node:sqlite');
    return null;
  }
}

function isUnavailable(error) {
  return String(error && (error.code || error.message) || '') === UNAVAILABLE_ERROR;
}

module.exports = { createOptionalChatRuntime };
