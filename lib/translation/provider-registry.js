'use strict';

const { validateTranslationProviderDescriptor } = require('./provider-contract');

function normalizeId(value) {
  return String(value === undefined || value === null ? '' : value).trim().toLowerCase();
}

function normalizeOperation(value) {
  return String(value === undefined || value === null ? '' : value).trim().toLowerCase();
}

/**
 * Build the translation provider index.  Descriptors are the source of truth;
 * consumers ask for an operation and never maintain a provider-name list.
 */
function createTranslationProviderRegistry(descriptors = []) {
  const byId = new Map();
  const operationIndex = new Map();

  function index(descriptor) {
    for (const operation of descriptor.operations) {
      if (!operationIndex.has(operation)) operationIndex.set(operation, new Set());
      operationIndex.get(operation).add(descriptor.id);
    }
  }

  function unindex(id) {
    for (const ids of operationIndex.values()) ids.delete(id);
  }

  function register(input) {
    const descriptor = validateTranslationProviderDescriptor(input);
    // Built-in descriptors are intentionally first-wins.  This makes a
    // duplicate from a loader harmless while still validating every input.
    if (byId.has(descriptor.id)) return byId.get(descriptor.id);
    byId.set(descriptor.id, descriptor);
    index(descriptor);
    return descriptor;
  }

  function unregister(id) {
    const key = normalizeId(id);
    if (!byId.has(key)) return false;
    byId.delete(key);
    unindex(key);
    return true;
  }

  function get(id) {
    return byId.get(normalizeId(id)) || null;
  }

  function has(id) {
    return byId.has(normalizeId(id));
  }

  function list() {
    return [...byId.values()];
  }

  function listIds() {
    return [...byId.keys()];
  }

  function listByOperation(operation) {
    const ids = operationIndex.get(normalizeOperation(operation));
    if (!ids) return [];
    return [...ids].map((id) => byId.get(id)).filter(Boolean);
  }

  function listOperationIds() {
    return [...operationIndex.keys()];
  }

  function listOperationIndex() {
    const result = {};
    for (const operation of listOperationIds()) {
      result[operation] = [...operationIndex.get(operation)].filter((id) => byId.has(id));
    }
    return result;
  }

  function supports(id, operation) {
    const descriptor = get(id);
    return Boolean(descriptor && descriptor.operations.includes(normalizeOperation(operation)));
  }

  /**
   * Find a descriptor by id, predicate, or a small declarative query.
   * Supported query keys are id, operation, authMode, and adapter.
   */
  function find(query) {
    if (typeof query === 'string') return get(query);
    if (typeof query === 'function') return list().find(query) || null;
    if (!query || typeof query !== 'object') return null;
    const id = query.id === undefined ? '' : normalizeId(query.id);
    const operation = query.operation === undefined ? '' : normalizeOperation(query.operation);
    const authMode = query.authMode === undefined ? '' : normalizeOperation(query.authMode);
    const adapter = query.adapter === undefined ? '' : normalizeId(query.adapter);
    return list().find((descriptor) => {
      if (id && descriptor.id !== id) return false;
      if (operation && !descriptor.operations.includes(operation)) return false;
      if (authMode && !descriptor.auth.modes.includes(authMode)) return false;
      if (adapter && descriptor.adapter !== adapter && descriptor.clientFreeAdapter !== adapter) return false;
      return true;
    }) || null;
  }

  for (const descriptor of (Array.isArray(descriptors) ? descriptors : [])) register(descriptor);

  return {
    register,
    unregister,
    get,
    has,
    list,
    listIds,
    find,
    supports,
    listByOperation,
    listOperationIds,
    listOperationIndex
  };
}

module.exports = {
  createTranslationProviderRegistry,
  __private: { normalizeId, normalizeOperation }
};
