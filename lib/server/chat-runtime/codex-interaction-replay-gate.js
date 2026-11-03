'use strict';

const { ChatRuntimeError } = require('./contracts');
const { createNativeInteractionId } = require('./native-interaction-id');

class CodexInteractionReplayGate {
  constructor(options = {}) {
    const config = typeof options === 'number' ? { timeoutMs: options } : options;
    this.timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 5000;
    this.provider = String(config.provider || '').trim();
    this.sessionId = String(config.sessionId || '').trim();
    this.expected = new Map();
    this.failure = null;
    this.waiter = null;
  }

  expect(interactions = []) {
    this.cancel();
    this.failure = null;
    for (const interaction of interactions) {
      const id = this.requirePersistedIdentity(interaction);
      if (id) this.expected.set(id, structuredClone(interaction));
    }
  }

  capture(interaction, envelope) {
    let id;
    try {
      id = this.requireNativeIdentity(interaction, envelope);
    } catch (error) {
      this.fail(error);
      return { error, replayed: false };
    }
    const expected = this.expected.get(id);
    if (!expected) return { replayed: false };
    if (!sameInteraction(expected, interaction)) {
      const error = new ChatRuntimeError(
        'codex_pending_interaction_replay_mismatch', 409, { interactionId: id }
      );
      this.fail(error);
      return { error, replayed: true };
    }
    this.expected.delete(id);
    if (this.expected.size === 0) this.resolve();
    return { replayed: true };
  }

  wait() {
    if (this.failure) return Promise.reject(this.failure);
    if (this.expected.size === 0) return Promise.resolve();
    if (this.waiter) return this.waiter.promise;
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const timer = setTimeout(() => this.fail(new ChatRuntimeError(
      'codex_pending_interaction_replay_missing', 503,
      { interactionIds: [...this.expected.keys()] }
    )), this.timeoutMs);
    this.waiter = { promise, reject, resolve, timer };
    return promise;
  }

  cancel() {
    this.expected.clear();
    this.failure = null;
    this.resolve();
  }

  fail(error) {
    this.expected.clear();
    this.failure = error;
    if (!this.waiter) return;
    const waiter = this.takeWaiter();
    waiter.reject(error);
  }

  resolve() {
    if (!this.waiter) return;
    const waiter = this.takeWaiter();
    waiter.resolve();
  }

  takeWaiter() {
    const waiter = this.waiter;
    this.waiter = null;
    clearTimeout(waiter.timer);
    return waiter;
  }

  requirePersistedIdentity(interaction) {
    const interactionId = String(interaction && interaction.interactionId || '').trim();
    if (!interactionId) {
      throw new ChatRuntimeError('codex_interaction_identity_mismatch', 409);
    }
    return interactionId;
  }

  requireNativeIdentity(interaction, envelope = {}) {
    const interactionId = this.requirePersistedIdentity(interaction);
    const expectedId = createNativeInteractionId({
      provider: this.provider,
      sessionId: this.sessionId,
      nativeThreadId: envelope.nativeThreadId,
      nativeRequestId: envelope.requestId
    });
    if (interactionId !== expectedId) {
      throw new ChatRuntimeError('codex_interaction_identity_mismatch', 409);
    }
    return expectedId;
  }
}

function sameInteraction(expected, actual) {
  return expected.kind === actual.kind
    && Number(expected.revision) === Number(actual.revision)
    && String(expected.itemId || '') === String(actual.itemId || '')
    && stableJson(expected.payload) === stableJson(actual.payload);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

module.exports = { CodexInteractionReplayGate };
