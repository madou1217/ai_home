'use strict';

const { listProviderIds } = require('../../provider-catalog');

const OPERATIONS = Object.freeze(['archive', 'listArchived', 'unarchive']);

class SessionLifecycleError extends Error {
  constructor(code, statusCode, details = {}) {
    super(String(details.message || code));
    this.name = 'SessionLifecycleError';
    this.code = String(code || 'session_lifecycle_failed');
    this.statusCode = Number(statusCode) || 500;
    this.details = details && typeof details === 'object' ? { ...details } : {};
  }
}

class ProviderSessionLifecycleRegistry {
  constructor(strategies = []) {
    this.strategies = new Map();
    for (const strategy of strategies) this.register(strategy);
  }

  register(strategy) {
    const provider = normalizeProvider(strategy && strategy.provider);
    if (!provider || !strategy || typeof strategy.capabilities !== 'function') {
      throw new TypeError('session lifecycle strategy is invalid');
    }
    this.strategies.set(provider, strategy);
    return this;
  }

  resolve(provider) {
    return this.strategies.get(normalizeProvider(provider)) || null;
  }

  values() {
    return [...this.strategies.values()];
  }
}

class SessionLifecycleService {
  constructor(options = {}) {
    this.providers = Array.isArray(options.providers) ? options.providers.map(normalizeProvider).filter(Boolean) : listProviderIds();
    this.registry = options.registry || new ProviderSessionLifecycleRegistry();
    this.identityResolver = options.identityResolver || { resolve: (input) => ({ nativeSessionId: input.sessionId, active: false }) };
    this.legacyRecovery = options.legacyRecovery || null;
  }

  async getCapabilities() {
    const entries = await Promise.all(this.providers.map(async (provider) => {
      const strategy = this.registry.resolve(provider);
      if (!strategy) return [provider, unsupportedCapabilities(provider)];
      try {
        return [provider, normalizeCapabilities(await strategy.capabilities(), provider)];
      } catch (error) {
        return [provider, unavailableCapabilities(provider, error)];
      }
    }));
    return Object.fromEntries(entries);
  }

  async resolveNativeIdentity(request) {
    const identity = await Promise.resolve(this.identityResolver.resolve({
      provider: request.provider,
      sessionId: request.sessionId
    }));
    return {
      nativeSessionId: String(identity && identity.nativeSessionId || request.sessionId).trim(),
      active: identity && identity.active === true
    };
  }

  async archive(input = {}) {
    const request = requireLifecycleRequest(input);
    const strategy = this.registry.resolve(request.provider);
    const capabilities = strategy
      ? normalizeCapabilities(await strategy.capabilities(), request.provider)
      : unsupportedCapabilities(request.provider);
    requireOperation(capabilities, 'archive');
    const identity = await this.resolveNativeIdentity(request);
    if (identity.active) {
      throw new SessionLifecycleError('session_lifecycle_active', 409, {
        provider: request.provider,
        sessionId: request.sessionId,
        message: '会话正在运行，无法归档'
      });
    }
    await strategy.archive({
      provider: request.provider,
      sessionId: identity.nativeSessionId,
      requestedSessionId: request.sessionId
    });
    return {
      provider: request.provider,
      sessionId: request.sessionId,
      nativeSessionId: identity.nativeSessionId,
      origin: 'native'
    };
  }

  async unarchive(input = {}) {
    const request = requireLifecycleRequest(input);
    const useLegacy = String(input.origin || '').trim().toLowerCase() === 'legacy';
    if (useLegacy) return this.unarchiveLegacy(request);

    const strategy = this.registry.resolve(request.provider);
    if (!strategy) return this.unarchiveLegacy(request);
    const capabilities = normalizeCapabilities(await strategy.capabilities(), request.provider);
    requireOperation(capabilities, 'unarchive');
    const identity = await this.resolveNativeIdentity(request);
    await strategy.unarchive({
      provider: request.provider,
      sessionId: identity.nativeSessionId,
      requestedSessionId: request.sessionId
    });
    return {
      provider: request.provider,
      sessionId: request.sessionId,
      nativeSessionId: identity.nativeSessionId,
      origin: 'native'
    };
  }

  unarchiveLegacy(request) {
    if (!this.legacyRecovery || typeof this.legacyRecovery.unarchive !== 'function') {
      throw unsupportedOperation(request.provider, 'unarchive');
    }
    this.legacyRecovery.unarchive(request);
    return {
      provider: request.provider,
      sessionId: request.sessionId,
      origin: 'legacy'
    };
  }

  async listArchived() {
    const archived = [];
    const errors = [];
    for (const strategy of this.registry.values()) {
      try {
        const capabilities = normalizeCapabilities(await strategy.capabilities(), strategy.provider);
        if (!operationAvailable(capabilities, 'listArchived') || !capabilities.workflowAvailable) continue;
        const items = await strategy.listArchived();
        if (Array.isArray(items)) archived.push(...items);
      } catch (error) {
        errors.push(publicError(strategy.provider, error));
      }
    }
    try {
      if (this.legacyRecovery && typeof this.legacyRecovery.list === 'function') {
        const legacy = this.legacyRecovery.list();
        if (Array.isArray(legacy)) archived.push(...legacy);
      }
    } catch (error) {
      errors.push(publicError('legacy', error));
    }
    archived.sort((left, right) => itemTimestamp(right) - itemTimestamp(left));
    return { archived, errors };
  }

  close() {
    for (const strategy of this.registry.values()) {
      if (typeof strategy.close === 'function') strategy.close();
    }
  }
}

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase();
}

function requireLifecycleRequest(input) {
  const provider = normalizeProvider(input && input.provider);
  const sessionId = String(input && input.sessionId || '').trim();
  if (!provider || !sessionId) {
    throw new SessionLifecycleError('missing_params', 400, { message: 'provider 和 sessionId 必填' });
  }
  return { provider, sessionId };
}

function operationState(value) {
  const source = value && typeof value === 'object' ? value : {};
  const support = source.support === 'native' ? 'native' : 'unsupported';
  return Object.freeze({
    support,
    available: support === 'native' && source.available === true,
    ...(source.reason ? { reason: String(source.reason) } : {})
  });
}

function normalizeCapabilities(value, provider) {
  const source = value && typeof value === 'object' ? value : {};
  const operations = source.operations && typeof source.operations === 'object' ? source.operations : {};
  return Object.freeze({
    provider: normalizeProvider(provider || source.provider),
    workflowAvailable: source.workflowAvailable === true,
    operations: Object.freeze(Object.fromEntries(OPERATIONS.map((operation) => [
      operation,
      operationState(operations[operation])
    ]))),
    ...(source.reason ? { reason: String(source.reason) } : {})
  });
}

function unsupportedCapabilities(provider) {
  const normalized = normalizeProvider(provider);
  const reason = normalized === 'opencode'
    ? 'native_unarchive_unavailable'
    : 'native_archive_unsupported';
  return normalizeCapabilities({
    workflowAvailable: false,
    reason,
    operations: {}
  }, normalized);
}

function unavailableCapabilities(provider, error) {
  const reason = String(error && error.code || 'native_runtime_unavailable');
  return normalizeCapabilities({
    workflowAvailable: false,
    reason,
    operations: Object.fromEntries(OPERATIONS.map((operation) => [
      operation,
      { support: 'native', available: false, reason }
    ]))
  }, provider);
}

function operationAvailable(capabilities, operation) {
  const state = capabilities && capabilities.operations && capabilities.operations[operation];
  return Boolean(state && state.support === 'native' && state.available === true);
}

function requireOperation(capabilities, operation) {
  if (capabilities.workflowAvailable && operationAvailable(capabilities, operation)) return;
  throw unsupportedOperation(capabilities.provider, operation, capabilities.reason);
}

function unsupportedOperation(provider, operation, reason) {
  return new SessionLifecycleError(`session_${operation === 'unarchive' ? 'unarchive' : 'archive'}_unsupported`, 422, {
    provider: normalizeProvider(provider),
    reason: String(reason || 'native_archive_unsupported'),
    message: `${normalizeProvider(provider)} 不支持原生${operation === 'unarchive' ? '恢复' : '归档'}`
  });
}

function publicError(provider, error) {
  return {
    provider: normalizeProvider(provider),
    code: String(error && error.code || 'session_lifecycle_failed'),
    message: String(error && error.message || 'session lifecycle failed')
  };
}

function itemTimestamp(item) {
  return Number(item && (item.archivedAt || item.updatedAt)) || 0;
}

function createProviderSessionLifecycleRegistry(strategies) {
  return new ProviderSessionLifecycleRegistry(strategies);
}

function createSessionLifecycleService(options) {
  return new SessionLifecycleService(options);
}

module.exports = {
  ProviderSessionLifecycleRegistry,
  SessionLifecycleError,
  SessionLifecycleService,
  createProviderSessionLifecycleRegistry,
  createSessionLifecycleService,
  unsupportedCapabilities
};
