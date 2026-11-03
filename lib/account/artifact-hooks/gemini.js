'use strict';

const { AccountArtifactHookStrategy } = require('./provider-strategy');

class GeminiArtifactHookStrategy extends AccountArtifactHookStrategy {
  constructor(options = {}) {
    super({
      provider: 'gemini',
      authArtifactRelativePaths: [
        '.gemini/oauth_creds.json',
        '.gemini/google_accounts.json'
      ],
      configArtifactRelativePaths: [
        '.gemini/settings.json'
      ],
      onDefaultAccountAuthUpdated: options.onDefaultAccountAuthUpdated,
      onAccountConfigUpdated: options.onAccountConfigUpdated
    });
  }
}

module.exports = {
  GeminiArtifactHookStrategy
};
