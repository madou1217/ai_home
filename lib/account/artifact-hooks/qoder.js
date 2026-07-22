'use strict';

const { AccountArtifactHookStrategy } = require('./provider-strategy');
const { getProviderAuthArtifacts } = require('../../runtime/provider-storage-policy');
const { getQoderVariant } = require('../qoder-auth-metadata');

function buildAuthArtifactRelativePaths(provider) {
  if (!getQoderVariant(provider)) return [];
  return getProviderAuthArtifacts(provider).map((artifact) => artifact.path.join('/'));
}

class QoderArtifactHookStrategy extends AccountArtifactHookStrategy {
  constructor(options = {}) {
    const provider = String(options.provider || 'qoder').trim().toLowerCase() || 'qoder';
    super({
      provider,
      authArtifactRelativePaths: buildAuthArtifactRelativePaths(provider),
      configArtifactRelativePaths: [],
      onDefaultAccountAuthUpdated: options.onDefaultAccountAuthUpdated,
      onAccountConfigUpdated: options.onAccountConfigUpdated
    });
  }
}

module.exports = {
  QoderArtifactHookStrategy,
  buildAuthArtifactRelativePaths
};