'use strict';

const { AccountArtifactHookStrategy } = require('./provider-strategy');

class GrokArtifactHookStrategy extends AccountArtifactHookStrategy {
  constructor(options = {}) {
    super({
      provider: 'grok',
      authArtifactRelativePaths: [
        '.grok/auth.json'
      ],
      configArtifactRelativePaths: [
        '.grok/config.toml'
      ],
      onDefaultAccountAuthUpdated: options.onDefaultAccountAuthUpdated,
      onAccountConfigUpdated: options.onAccountConfigUpdated
    });
  }
}

module.exports = {
  GrokArtifactHookStrategy
};
