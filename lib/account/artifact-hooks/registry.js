'use strict';

const { CodexArtifactHookStrategy } = require('./codex');
const { ClaudeArtifactHookStrategy } = require('./claude');
const { GeminiArtifactHookStrategy } = require('./gemini');

const DEFAULT_PROVIDER_STRATEGY_FACTORIES = Object.freeze([
  {
    provider: 'codex',
    create: (options) => new CodexArtifactHookStrategy(options)
  },
  {
    provider: 'claude',
    create: (options) => new ClaudeArtifactHookStrategy(options)
  },
  {
    provider: 'gemini',
    create: (options) => new GeminiArtifactHookStrategy(options)
  }
]);

function createProviderArtifactHookRegistry(strategies = []) {
  const byProvider = new Map();
  strategies.forEach((strategy) => {
    const provider = String(strategy && strategy.provider || '').trim().toLowerCase();
    if (!provider) return;
    byProvider.set(provider, strategy);
  });
  return {
    get(provider) {
      return byProvider.get(String(provider || '').trim().toLowerCase()) || null;
    },
    list() {
      return Array.from(byProvider.values());
    }
  };
}

function createDefaultProviderArtifactHookRegistry(options = {}) {
  const providerOptions = options.providerOptions || {};
  const sharedOptions = {
    onDefaultAccountAuthUpdated: options.onDefaultAccountAuthUpdated,
    onAccountConfigUpdated: options.onAccountConfigUpdated
  };
  return createProviderArtifactHookRegistry(
    DEFAULT_PROVIDER_STRATEGY_FACTORIES.map((definition) => definition.create({
      ...sharedOptions,
      ...(providerOptions[definition.provider] || {})
    }))
  );
}

module.exports = {
  createProviderArtifactHookRegistry,
  createDefaultProviderArtifactHookRegistry
};
