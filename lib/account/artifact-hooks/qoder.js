'use strict';

const { AccountArtifactHookStrategy } = require('./provider-strategy');
const { getQoderVariant } = require('../qoder-auth-metadata');

function buildAuthArtifactRelativePaths(provider) {
  const variant = getQoderVariant(provider);
  if (!variant) return [];
  return [
    `${variant.credentialPrefix}-credentials.json`,
    '.keychain-salt'
  ];
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
