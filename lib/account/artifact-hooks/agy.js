'use strict';

const { AccountArtifactHookStrategy } = require('./provider-strategy');

class AgyArtifactHookStrategy extends AccountArtifactHookStrategy {
  constructor(options = {}) {
    super({
      provider: 'agy',
      authArtifactRelativePaths: [
        '.gemini/antigravity-cli/antigravity-oauth-token',
        '.gemini/jetski-standalone-oauth-token',
        '.gemini/antigravity-cli/email.cache',
        '.gemini/oauth_creds.json',
        '.gemini/google_accounts.json'
      ],
      configArtifactRelativePaths: [
        '.gemini/antigravity-cli/keybindings.json'
      ],
      onDefaultAccountAuthUpdated: options.onDefaultAccountAuthUpdated,
      onAccountConfigUpdated: options.onAccountConfigUpdated
    });
  }
}

module.exports = {
  AgyArtifactHookStrategy
};
