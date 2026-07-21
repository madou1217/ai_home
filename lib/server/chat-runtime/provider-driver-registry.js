'use strict';

const { ChatRuntimeError } = require('./contracts');

class ProviderSessionDriverRegistry {
  constructor() {
    this.factories = new Map();
  }

  register(input) {
    const registration = createProviderDriverRegistration(input);
    this.factories.set(registration.provider, registration.createEntry);
    return this;
  }

  resolve(provider, context = {}) {
    const key = normalizeProvider(provider);
    const factory = this.factories.get(key);
    if (!factory) return null;
    const entry = factory(context);
    if (!entry || !entry.driver || typeof entry.driver.startTurn !== 'function') {
      throw new ChatRuntimeError('provider_driver_entry_invalid', 500, { provider: key });
    }
    return entry;
  }
}

function createProviderDriverRegistration(input = {}) {
  const provider = normalizeProvider(input.provider);
  if (typeof input.createEntry !== 'function') {
    throw new ChatRuntimeError('provider_driver_factory_invalid', 500, { provider });
  }
  return Object.freeze({ provider, createEntry: input.createEntry });
}

function createProviderDriverRegistry(registrations = []) {
  const registry = new ProviderSessionDriverRegistry();
  for (const registration of registrations) registry.register(registration);
  return registry;
}

function normalizeProvider(provider) {
  const key = String(provider || '').trim().toLowerCase();
  if (!key) throw new ChatRuntimeError('provider_driver_provider_required', 422);
  return key;
}

module.exports = {
  createProviderDriverRegistration,
  ProviderSessionDriverRegistry,
  createProviderDriverRegistry
};
