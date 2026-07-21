'use strict';

const { SessionActor } = require('./chat-runtime/session-actor');
const { ChatRuntimeError } = require('./chat-runtime/contracts');

class ChatRuntimeActorRegistry {
  constructor(options) {
    this.store = options.store;
    this.runtimeResolver = options.runtimeResolver;
    this.driverRegistry = options.driverRegistry;
    this.Actor = options.Actor || SessionActor;
    this.idFactory = options.idFactory;
    this.records = new Map();
    this.acquirePromises = new Map();
  }

  has(sessionId) { return this.records.has(sessionId); }

  async prepare(session) {
    const runtime = await this.resolveRuntime(session);
    this.retireStaleActors(runtime);
    const entry = await this.resolveDriver(session, runtime);
    return new PreparedDriverHandle(entry, runtime);
  }

  register(session, prepared) {
    const existing = this.records.get(session.sessionId);
    if (existing) {
      this.disposePrepared(prepared);
      return existing.actor;
    }
    try {
      const actor = this.createActor(session, prepared.entry);
      transferPreparedDriverOwnership(prepared);
      this.records.set(session.sessionId, { actor, runtime: prepared.runtime });
      return actor;
    } catch (error) {
      this.disposePrepared(prepared);
      throw error;
    }
  }

  assertReplaceable(sessionId) {
    const current = this.records.get(sessionId);
    if (current && isActive(current.actor)) {
      throw new ChatRuntimeError('chat_execution_credential_change_conflict', 409);
    }
  }

  replacePrepared(session, prepared) {
    this.assertReplaceable(session.sessionId);
    const current = this.records.get(session.sessionId);
    let actor;
    try {
      actor = this.createActor(session, prepared.entry);
      transferPreparedDriverOwnership(prepared);
      if (current) current.actor.dispose();
      this.records.set(session.sessionId, { actor, runtime: prepared.runtime });
      return actor;
    } catch (error) {
      if (actor) actor.dispose();
      throw error;
    }
  }

  disposePrepared(prepared) { return disposePreparedDriver(prepared); }

  async acquire(session, recovery) {
    const pinned = this.records.get(session.sessionId);
    if (pinned && isActive(pinned.actor)) return pinned.actor;
    const inFlight = this.acquirePromises.get(session.sessionId);
    if (inFlight) return inFlight;
    const acquisition = this.acquireAvailable(session, recovery);
    this.acquirePromises.set(session.sessionId, acquisition);
    try {
      return await acquisition;
    } finally {
      if (this.acquirePromises.get(session.sessionId) === acquisition) {
        this.acquirePromises.delete(session.sessionId);
      }
    }
  }

  async acquireAvailable(session, recovery) {
    const runtime = await this.resolveRuntime(session);
    assertRecoverableRuntime(session, runtime, recovery);
    let current = this.records.get(session.sessionId);
    if (current && isActive(current.actor)) return current.actor;
    if (current && sameRuntime(current.runtime, runtime)) return current.actor;
    this.retireStaleActors(runtime);
    current = this.records.get(session.sessionId);
    const entry = await this.resolveDriver(session, runtime);
    const prepared = new PreparedDriverHandle(entry, runtime);
    try {
      const latest = this.records.get(session.sessionId);
      if (latest && isActive(latest.actor)) return latest.actor;
      if (latest && sameRuntime(latest.runtime, runtime)) return latest.actor;
      return await this.replace(session, prepared, latest, recovery);
    } finally {
      this.disposePrepared(prepared);
    }
  }

  dispose(sessionId) {
    const record = this.records.get(sessionId);
    if (!record) return false;
    record.actor.dispose();
    this.records.delete(sessionId);
    return true;
  }

  close() {
    for (const record of this.records.values()) record.actor.dispose();
    this.records.clear();
  }

  retireStaleActors(runtime) {
    const stale = [...this.records.entries()].filter(([, record]) => (
      sameRuntimeTarget(record.runtime, runtime)
      && !sameRuntime(record.runtime, runtime)
    ));
    const active = stale.find(([, record]) => isActive(record.actor));
    if (active) {
      throw new ChatRuntimeError('chat_runtime_refresh_conflict', 409, {
        runtimeScope: runtime.runtimeScope
      });
    }
    for (const [sessionId, record] of stale) {
      record.actor.dispose();
      this.records.delete(sessionId);
    }
  }

  async resolveRuntime(session) {
    if (!this.runtimeResolver || typeof this.runtimeResolver.resolve !== 'function') {
      throw new ChatRuntimeError('chat_runtime_resolver_unavailable', 503);
    }
    const runtime = await this.runtimeResolver.resolve(session.provider, {
      runtimeScope: session.executionAccountRef
    });
    return {
      ...runtime,
      provider: runtime.provider || session.provider,
      runtimeScope: runtime.runtimeScope || session.executionAccountRef
    };
  }

  async resolveDriver(session, runtime) {
    if (!this.driverRegistry || typeof this.driverRegistry.resolve !== 'function') {
      throw driverUnavailable(session.provider);
    }
    const entry = await this.driverRegistry.resolve(session.provider, { session, runtime });
    if (!entry || !entry.driver || typeof entry.driver.startTurn !== 'function') {
      throw driverUnavailable(session.provider);
    }
    return entry;
  }

  async replace(session, prepared, current, recovery) {
    let actor;
    try {
      actor = this.createActor(session, prepared.entry);
      transferPreparedDriverOwnership(prepared);
      if (recovery && recovery.recoverable) await actor.rehydrate(recovery);
      const binding = runtimeBindingPatch(session, prepared.runtime);
      if (!sameBinding(session.runtimeBinding, binding)) {
        this.store.updateRuntimeBinding(session.sessionId, binding);
      }
      if (current) current.actor.dispose();
      this.records.set(session.sessionId, { actor, runtime: prepared.runtime });
      return actor;
    } catch (error) {
      if (actor) actor.dispose();
      throw error;
    }
  }

  createActor(session, entry) {
    return new this.Actor({
      sessionId: session.sessionId,
      store: this.store,
      driver: entry.driver,
      handlers: entry.handlers || {},
      composerCatalog: entry.composerCatalog,
      ...(this.idFactory ? { idFactory: this.idFactory } : {})
    });
  }
}

class PreparedDriverHandle {
  constructor(entry, runtime) {
    this.entry = entry;
    this.runtime = runtime;
    this.ownsDriver = true;
  }

  transfer() {
    if (!this.ownsDriver) return false;
    this.ownsDriver = false;
    return true;
  }

  dispose() {
    if (!this.transfer()) return false;
    const driver = this.entry && this.entry.driver;
    return driver && typeof driver.dispose === 'function'
      ? driver.dispose()
      : false;
  }
}

function transferPreparedDriverOwnership(prepared) {
  if (prepared && typeof prepared.transfer === 'function') prepared.transfer();
}

function disposePreparedDriver(prepared) {
  if (!prepared) return false;
  if (typeof prepared.dispose === 'function') return prepared.dispose();
  const driver = prepared.entry && prepared.entry.driver;
  return driver && typeof driver.dispose === 'function'
    ? driver.dispose()
    : false;
}

function runtimeBindingPatch(session, runtime = {}) {
  const provider = String(runtime.provider || session.provider);
  const scope = String(runtime.runtimeScope || session.executionAccountRef || 'global');
  const { projectPath: _projectPath, ...existingBinding } = session.runtimeBinding || {};
  const binding = { ...existingBinding, runtimeId: `${provider}:${scope}` };
  if (runtime.fingerprint) binding.fingerprint = String(runtime.fingerprint);
  if (Number.isSafeInteger(runtime.generation)) binding.runtimeGeneration = runtime.generation;
  if (runtime.version) binding.version = String(runtime.version);
  return binding;
}

function sameRuntime(left = {}, right = {}) {
  return left.fingerprint === right.fingerprint
    && Number(left.generation) === Number(right.generation);
}

function sameRuntimeTarget(left = {}, right = {}) {
  return left.provider === right.provider
    && left.runtimeScope === right.runtimeScope;
}

function sameBinding(left, right) {
  return ['runtimeId', 'fingerprint', 'runtimeGeneration', 'version']
    .every((key) => left && left[key] === right[key]);
}

function isActive(actor) { return Boolean(actor && actor.turn && actor.turn.active); }

function assertRecoverableRuntime(session, runtime, recovery) {
  if (!recovery || !recovery.recoverable) return;
  const binding = session.runtimeBinding || {};
  const fingerprintChanged = binding.fingerprint && runtime.fingerprint
    && binding.fingerprint !== runtime.fingerprint;
  if (fingerprintChanged) {
    throw new ChatRuntimeError('chat_runtime_changed_during_recovery', 409);
  }
}

function driverUnavailable(provider) {
  return new ChatRuntimeError('chat_provider_driver_unavailable', 422, { provider });
}

module.exports = {
  ChatRuntimeActorRegistry,
  runtimeBindingPatch
};
