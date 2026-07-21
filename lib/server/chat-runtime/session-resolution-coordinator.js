'use strict';

const { runtimeBindingPatch } = require('../chat-runtime-actor-registry');

class SessionResolutionCoordinator {
  constructor(options) {
    this.actors = options.actors;
    this.createDraft = options.createDraft;
    this.publisher = options.publisher;
    this.store = options.store;
  }

  async resolve(input = {}) {
    const sessionInput = toSessionInput(input);
    const existing = sessionInput.runtimeBinding.nativeSessionId
      ? this.store.findSessionByNativeIdentity(sessionInput)
      : null;
    if (existing) {
      if (existing.executionAccountRef === sessionInput.executionAccountRef) {
        return { status: 'adopted', session: existing };
      }
      return this.rebind(existing, sessionInput);
    }

    const draft = this.createDraft(sessionInput);
    let prepared;
    try {
      prepared = await this.actors.prepare(draft);
      draft.runtimeBinding = runtimeBindingPatch(draft, prepared.runtime);
      draft.capabilitySnapshot = prepared.entry.capabilities || {};

      const result = this.store.resolveSession(draft);
      if (result.status === 'created') {
        this.publisher.publishSince(result.session.sessionId, 0);
        this.actors.register(result.session, prepared);
      } else if (result.session.executionAccountRef !== draft.executionAccountRef) {
        return this.rebind(result.session, sessionInput);
      }
      return result;
    } finally {
      this.actors.disposePrepared(prepared);
    }
  }

  async rebind(existing, input) {
    this.actors.assertReplaceable(existing.sessionId);
    const candidate = {
      ...existing,
      executionAccountRef: input.executionAccountRef
    };
    let prepared;
    try {
      prepared = await this.actors.prepare(candidate);
      this.actors.assertReplaceable(existing.sessionId);
      const session = this.store.updateExecutionContext(existing.sessionId, {
        executionAccountRef: input.executionAccountRef,
        runtimeBinding: runtimeBindingPatch(candidate, prepared.runtime),
        capabilitySnapshot: prepared.entry.capabilities || existing.capabilitySnapshot
      });
      this.actors.replacePrepared(session, prepared);
      this.publisher.publishSince(session.sessionId, existing.lastEventSeq);
      return { status: 'adopted', session };
    } finally {
      this.actors.disposePrepared(prepared);
    }
  }
}

function toSessionInput(input) {
  const nativeSessionId = text(input.nativeSessionId);
  return {
    provider: input.provider,
    executionAccountRef: input.executionAccountRef,
    projectPath: text(input.projectPath),
    policy: record(input.policy),
    runtimeBinding: nativeSessionId ? { nativeSessionId } : {}
  };
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? structuredClone(value)
    : {};
}

function text(value) { return String(value || '').trim(); }

module.exports = { SessionResolutionCoordinator };
