'use strict';

const { AccountArtifactHookStrategy } = require('./provider-strategy');
const { getProviderAuthArtifacts, getProviderHostAuthRoot } = require('../../runtime/provider-storage-policy');

// Policy auth-artifact paths are relative to the provider's HOST auth root
// (~/.kimi-code), but the runtime projection keeps that root directory, so
// hook paths must be re-anchored: <runtimeDir>/.kimi-code/credentials/...
function buildAuthArtifactRelativePaths() {
  const hostRoot = getProviderHostAuthRoot('kimi') || [];
  return getProviderAuthArtifacts('kimi').map((artifact) => (
    hostRoot.concat(artifact.path).join('/')
  ));
}

class KimiArtifactHookStrategy extends AccountArtifactHookStrategy {
  constructor(options = {}) {
    super({
      provider: 'kimi',
      authArtifactRelativePaths: buildAuthArtifactRelativePaths(),
      configArtifactRelativePaths: [],
      onDefaultAccountAuthUpdated: options.onDefaultAccountAuthUpdated,
      onAccountConfigUpdated: options.onAccountConfigUpdated
    });
  }
}

module.exports = {
  KimiArtifactHookStrategy,
  buildAuthArtifactRelativePaths
};
