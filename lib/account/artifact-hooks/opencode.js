'use strict';

const { AccountArtifactHookStrategy } = require('./provider-strategy');

class OpenCodeArtifactHookStrategy extends AccountArtifactHookStrategy {
  constructor(options = {}) {
    super({
      provider: 'opencode',
      authArtifactRelativePaths: [
        '.local/share/opencode/auth.json'
      ],
      configArtifactRelativePaths: [],
      onDefaultAccountAuthUpdated: options.onDefaultAccountAuthUpdated,
      onAccountConfigUpdated: options.onAccountConfigUpdated
    });
  }
}

module.exports = {
  OpenCodeArtifactHookStrategy
};
