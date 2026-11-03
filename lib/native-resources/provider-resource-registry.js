'use strict';

const { listProviderDefinitions } = require('../provider-catalog');
const { buildNativeResourceMatrix, RESOURCE_TYPES, validateNativeResourceMatrix } = require('./resource-status');

function createProviderResourceRegistry(options = {}) {
  const definitions = options.definitions || listProviderDefinitions();
  const matrix = buildNativeResourceMatrix(definitions);
  validateNativeResourceMatrix(matrix);
  return Object.freeze({
    listProviders: () => Object.keys(matrix),
    listResources: () => RESOURCE_TYPES.slice(),
    get(provider, resource) {
      const providerId = String(provider || '').trim().toLowerCase();
      const resourceId = String(resource || '').trim().toLowerCase();
      return matrix[providerId]?.[resourceId] || Object.freeze({ state: 'unsupported', reason: 'provider_or_resource_unknown' });
    },
    matrix() { return JSON.parse(JSON.stringify(matrix)); }
  });
}

const defaultProviderResourceRegistry = createProviderResourceRegistry();

module.exports = { createProviderResourceRegistry, defaultProviderResourceRegistry };
