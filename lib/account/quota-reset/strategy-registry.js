'use strict';

const { CodexQuotaResetStrategy } = require('./codex-strategy');
const { ClaudeQuotaResetStrategy } = require('./claude-strategy');
const { AgyQuotaResetStrategy } = require('./agy-strategy');
const { KimiQuotaResetStrategy } = require('./kimi-strategy');
const { ZCodeQuotaResetStrategy } = require('./zcode-strategy');
const { DefaultQuotaResetStrategy } = require('./default-strategy');

class QuotaResetStrategyRegistry {
  constructor() {
    this.strategies = new Map();
    this.register('codex', new CodexQuotaResetStrategy());
    this.register('claude', new ClaudeQuotaResetStrategy());
    this.register('agy', new AgyQuotaResetStrategy());
    this.register('kimi', new KimiQuotaResetStrategy());
    this.register('zcode', new ZCodeQuotaResetStrategy());
  }

  register(provider, strategy) {
    const key = String(provider || '').trim().toLowerCase();
    if (key && strategy) {
      this.strategies.set(key, strategy);
    }
  }

  getStrategy(provider) {
    const key = String(provider || '').trim().toLowerCase();
    if (this.strategies.has(key)) {
      return this.strategies.get(key);
    }
    return new DefaultQuotaResetStrategy(key);
  }
}

const defaultRegistry = new QuotaResetStrategyRegistry();

module.exports = {
  QuotaResetStrategyRegistry,
  defaultRegistry,
  getQuotaResetStrategy: (provider) => defaultRegistry.getStrategy(provider)
};
