'use strict';

const { CodexArtifactHookStrategy } = require('./codex');
const { ClaudeArtifactHookStrategy } = require('./claude');
const { GeminiArtifactHookStrategy } = require('./gemini');
const { AgyArtifactHookStrategy } = require('./agy');
const { OpenCodeArtifactHookStrategy } = require('./opencode');
const { QoderArtifactHookStrategy } = require('./qoder');

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
  },
  {
    provider: 'agy',
    create: (options) => new AgyArtifactHookStrategy(options)
  },
  {
    provider: 'opencode',
    create: (options) => new OpenCodeArtifactHookStrategy(options)
  },
  {
    provider: 'qoder',
    create: (options) => new QoderArtifactHookStrategy({ ...options, provider: 'qoder' })
  },
  {
    provider: 'qodercn',
    create: (options) => new QoderArtifactHookStrategy({ ...options, provider: 'qodercn' })
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
