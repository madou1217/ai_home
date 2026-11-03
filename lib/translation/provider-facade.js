'use strict';

const { BUILTIN_TRANSLATION_PROVIDER_DESCRIPTORS } = require('./builtins');
const { createTranslationProviderRegistry } = require('./provider-registry');

function normalizeId(value) {
  return String(value === undefined || value === null ? '' : value).trim().toLowerCase();
}

function normalizeOperation(value) {
  return String(value === undefined || value === null ? '' : value).trim().toLowerCase();
}

function adapterReference(descriptor) {
  return String(descriptor && (descriptor.clientFreeAdapter || descriptor.adapter) || '').trim();
}

/**
 * Translation facade: route consumers resolve descriptors and optional
 * adapters through this object.  Provider identities remain data in the
 * registry; this module contains no provider-name dispatch.
 */
function createTranslationProviderFacade(options = {}) {
  const registry = options.registry || createTranslationProviderRegistry(BUILTIN_TRANSLATION_PROVIDER_DESCRIPTORS);
  const adapters = options.adapters || {};

  function resolveAdapter(descriptor) {
    const reference = adapterReference(descriptor);
    if (!reference) return null;
    if (typeof adapters === 'function') return adapters(reference, descriptor) || null;
    return adapters[reference] || null;
  }

  function get(id) {
    return registry.get(id);
  }

  function list(operation) {
    return operation ? registry.listByOperation(operation) : registry.list();
  }

  function find(query) {
    return registry.find(query);
  }

  function resolve(input = {}, operation) {
    const requestedOperation = normalizeOperation(operation || input.operation || 'selection');
    const requestedId = normalizeId(typeof input === 'string' ? input : input.provider || input.id);
    if (requestedId) {
      const descriptor = registry.get(requestedId);
      return descriptor && descriptor.operations.includes(requestedOperation) ? descriptor : null;
    }
    return registry.listByOperation(requestedOperation)[0] || null;
  }

  function canExecute(input = {}, operation) {
    const descriptor = resolve(input, operation);
    if (!descriptor) return false;
    const requestedOperation = normalizeOperation(operation || input.operation || 'selection');
    const adapter = resolveAdapter(descriptor);
    const handler = typeof adapter === 'function'
      ? adapter
      : adapter && (adapter[requestedOperation] || adapter.translate || adapter.execute);
    return typeof handler === 'function';
  }

  async function execute(input = {}, context = {}) {
    const operation = normalizeOperation(input.operation || 'selection');
    const descriptor = resolve(input, operation);
    if (!descriptor) {
      return { ok: false, error: { code: 'translation_provider_unsupported', message: '翻译引擎不支持此操作', retryable: true }, operation };
    }
    const adapter = resolveAdapter(descriptor);
    if (!adapter) {
      return {
        ok: false,
        error: { code: 'translation_provider_unavailable', message: descriptor.clientFreeReason || '翻译适配器未接入', retryable: true },
        provider: descriptor.id,
        reason: descriptor.clientFreeReason || 'translation adapter unavailable'
      };
    }
    const handler = typeof adapter === 'function'
      ? adapter
      : adapter && (adapter[operation] || adapter.translate || adapter.execute);
    if (typeof handler !== 'function') {
      return { ok: false, error: { code: 'translation_provider_operation_unavailable', message: '翻译适配器不支持此操作', retryable: true }, provider: descriptor.id, operation };
    }
    return handler.call(adapter, input, context, descriptor);
  }

  return {
    registry,
    get,
    list,
    find,
    resolve,
    canExecute,
    execute,
    getAdapter: (id) => resolveAdapter(registry.get(id)),
    supports: (id, operation) => registry.supports(id, operation),
    listOperationIndex: () => registry.listOperationIndex()
  };
}

let defaultRegistry = null;
let defaultFacade = null;

function getTranslationProviderRegistry() {
  if (!defaultRegistry) defaultRegistry = createTranslationProviderRegistry(BUILTIN_TRANSLATION_PROVIDER_DESCRIPTORS);
  return defaultRegistry;
}

function getTranslationProviderFacade() {
  if (!defaultFacade) defaultFacade = createTranslationProviderFacade({ registry: getTranslationProviderRegistry() });
  return defaultFacade;
}

function resetTranslationProviderFacadeForTests() {
  defaultRegistry = null;
  defaultFacade = null;
}

module.exports = {
  createTranslationProviderFacade,
  getTranslationProviderRegistry,
  getTranslationProviderFacade,
  resetTranslationProviderFacadeForTests,
  __private: { normalizeId, normalizeOperation, adapterReference }
};
