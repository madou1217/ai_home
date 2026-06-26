'use strict';

const { AccountArtifactHookStrategy } = require('./provider-strategy');

class ClaudeArtifactHookStrategy extends AccountArtifactHookStrategy {
  constructor(options = {}) {
    super({
      provider: 'claude',
      authArtifactRelativePaths: [
        '.claude/.credentials.json',
        '.claude/credentials.json',
        '.aih_env.json'
      ],
      configArtifactRelativePaths: [
        '.claude/settings.json'
      ],
      onDefaultAccountAuthUpdated: options.onDefaultAccountAuthUpdated,
      onAccountConfigUpdated: options.onAccountConfigUpdated
    });
  }
}

module.exports = {
  ClaudeArtifactHookStrategy
};
