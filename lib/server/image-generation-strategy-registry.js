'use strict';

// Registry for ImageGenerationStrategy implementations (see
// image-generation-strategy.js for the contract).
//
// The facade asks the registry for the strategy that serves a resolved
// (provider, account) pair. API-key accounts use their declared image dialect,
// defaulting to standard OpenAI passthrough. OAuth accounts use
// the provider's native strategy. Unknown providers resolve to null and the
// facade falls back to the explicit unsupported strategy (400).

const { getAccountImageApiProfile } = require('./image-generation-api-profiles');

function isApiKeyAccount(account) {
  return Boolean(account && (account.apiKeyMode || account.authType === 'api-key'));
}

/**
 * @param {Record<string, ImageGenerationStrategy>} entries - provider -> strategy
 */
function createImageGenerationStrategyRegistry(entries = {}) {
  const byProvider = new Map();
  Object.entries(entries || {}).forEach(([provider, strategy]) => {
    if (strategy && typeof strategy.generate === 'function') {
      byProvider.set(String(provider || '').trim().toLowerCase(), strategy);
    }
  });

  return {
    /**
     * Resolve the strategy for a (provider, account) pair.
     * @returns {ImageGenerationStrategy|null}
     */
    resolve(provider, account) {
      if (isApiKeyAccount(account)) {
        const profile = getAccountImageApiProfile(account);
        return profile && byProvider.get(profile.strategyId) || null;
      }
      const key = String(provider || '').trim().toLowerCase();
      return byProvider.get(key) || null;
    },
    /**
     * @param {string} provider
     * @returns {boolean}
     */
    has(provider) {
      return byProvider.has(String(provider || '').trim().toLowerCase());
    },
    /**
     * @returns {string[]} registered provider keys (lowercased)
     */
    providers() {
      return Array.from(byProvider.keys());
    }
  };
}

module.exports = {
  createImageGenerationStrategyRegistry,
  __private: {
    isApiKeyAccount
  }
};
