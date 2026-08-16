'use strict';

const { AccountArtifactHookStrategy } = require('./provider-strategy');
const { getProviderAuthArtifacts, getProviderHostAuthRoot } = require('../../runtime/provider-storage-policy');

// Policy auth-artifact paths are relative to the provider's HOST auth root
// (empty for zcode — the native root IS ~/.zcode), so hook paths map directly:
// <runtimeDir>/.zcode/v2/credentials.json and config.json.
function buildAuthArtifactRelativePaths() {
  const hostRoot = getProviderHostAuthRoot('zcode') || [];
  return getProviderAuthArtifacts('zcode').map((artifact) => (
    hostRoot.concat(artifact.path).join('/')
  ));
}

class ZcodeArtifactHookStrategy extends AccountArtifactHookStrategy {
  constructor(options = {}) {
    super({
      provider: 'zcode',
      authArtifactRelativePaths: buildAuthArtifactRelativePaths(),
      configArtifactRelativePaths: ['.zcode/v2/config.json'],
      onDefaultAccountAuthUpdated: options.onDefaultAccountAuthUpdated,
      onAccountConfigUpdated: options.onAccountConfigUpdated
    });
  }
}

module.exports = {
  ZcodeArtifactHookStrategy,
  buildAuthArtifactRelativePaths
};
