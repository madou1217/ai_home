'use strict';

const { readTranslationProviderConfig } = require('../../account/translation-provider-config-store');
const { createTranslationAdapterRegistry } = require('../adapters');
const { createTranslationProviderFacade, getTranslationProviderFacade } = require('../provider-facade');
const { runTranslationRoutes } = require('../route-runner');

/**
 * Compose the local Provider execution lane.  Provider identities are resolved
 * by descriptors and the route runner; this adapter deliberately has no
 * provider-name dispatch.
 */
function createDirectProviderExecutor(options = {}) {
  const adapters = options.adapters || createTranslationAdapterRegistry(options);
  const facade = options.facade || createTranslationProviderFacade({
    registry: options.registry,
    adapters
  });
  const fallbackFacade = options.registry ? facade : getTranslationProviderFacade();
  const resolveFacade = () => facade || fallbackFacade;

  function resolveConfig(providerId, request, context, descriptor) {
    if (context.providerConfig && typeof context.providerConfig === 'object') {
      const byProvider = context.providerConfig[providerId];
      if (byProvider && typeof byProvider === 'object') return byProvider;
      if (context.providerConfig.apiKey || context.providerConfig.endpoint) return context.providerConfig;
    }
    if (typeof options.resolveProviderConfig === 'function') return options.resolveProviderConfig(providerId, context);
    if (request.providerConfig && typeof request.providerConfig === 'object') {
      const byProvider = request.providerConfig[providerId];
      if (byProvider && typeof byProvider === 'object') return byProvider;
      if (providerId === request.provider || request.providerConfig.apiKey || request.providerConfig.endpoint) return request.providerConfig;
    }
    if (options.providerConfig && typeof options.providerConfig === 'object') {
      const byProvider = options.providerConfig[providerId];
      if (byProvider && typeof byProvider === 'object') return byProvider;
      if (options.providerConfig.apiKey || options.providerConfig.endpoint) return options.providerConfig;
    }
    if (options.fs && options.aiHomeDir && descriptor) return readTranslationProviderConfig(options.fs, options.aiHomeDir, descriptor, options.deps || {});
    return {};
  }

  function describe() {
    return resolveFacade().list().map((descriptor) => {
      let config = {};
      try { config = resolveConfig(descriptor.id, {}, {}, descriptor) || {}; } catch (_error) { config = {}; }
      const definitions = descriptor.config && descriptor.config.fieldDefinitions || {};
      const required = Object.entries(definitions)
        .filter(([, field]) => field && field.required === true)
        .map(([field]) => field);
      const available = resolveFacade().canExecute({ provider: descriptor.id }, 'selection');
      return {
        id: descriptor.id,
        label: descriptor.label,
        available,
        operations: Array.isArray(descriptor.capabilities && descriptor.capabilities.operations)
          ? descriptor.capabilities.operations.slice()
          : [],
        streaming: descriptor.capabilities && descriptor.capabilities.streaming === true,
        configured: available && required.every((field) => String(config[field] || '').trim())
      };
    });
  }

  const execute = async function execute(request = {}, context = {}) {
    const activeFacade = resolveFacade();
    const routes = Array.isArray(request.routes) ? request.routes : [];
    return runTranslationRoutes({
      ...request,
      operation: String(request.operation || 'selection').trim().toLowerCase(),
      target: request.targetLanguage || request.languageTarget || request.to || request.translationTarget || 'zh-Hans',
      routes
    }, {
      ...context,
      routes,
      facade: activeFacade,
      fetch: context.fetch || options.fetch,
      resolveProviderConfig: (providerId, routeContext = context) => {
        const descriptor = activeFacade.get(providerId);
        return resolveConfig(providerId, request, routeContext, descriptor);
      }
    }, context.emit || (() => {}));
  };

  execute.describe = describe;
  execute.facade = resolveFacade();
  return execute;
}

module.exports = { createDirectProviderExecutor };
