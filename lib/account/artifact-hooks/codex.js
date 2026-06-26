'use strict';

const { AccountArtifactHookStrategy } = require('./provider-strategy');

class CodexArtifactHookStrategy extends AccountArtifactHookStrategy {
  constructor(options = {}) {
    super({
      provider: 'codex',
      authArtifactRelativePaths: [
        '.codex/auth.json',
        '.aih_env.json'
      ],
      configArtifactRelativePaths: [
        '.codex/config.toml'
      ],
      onDefaultAccountAuthUpdated: options.onDefaultAccountAuthUpdated,
      onAccountConfigUpdated: options.onAccountConfigUpdated
    });
  }
}

module.exports = {
  CodexArtifactHookStrategy
};
