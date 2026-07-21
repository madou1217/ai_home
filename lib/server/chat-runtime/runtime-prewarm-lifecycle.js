'use strict';

const { ChatRuntimeError } = require('./contracts');

function createRuntimePrewarmHandler(providerEffect) {
  if (typeof providerEffect !== 'function') {
    throw new ChatRuntimeError('chat_runtime_prewarm_handler_required', 500);
  }
  return async (context) => {
    appendProjection(context, 'runtime.prewarm.started');
    try {
      const result = await providerEffect(context);
      appendProjection(context, 'runtime.prewarm.ready');
      return result;
    } catch (error) {
      appendFailure(context, error);
      throw error;
    }
  };
}

function withRuntimePrewarmLifecycle(entry) {
  const handlers = entry && entry.handlers || {};
  const providerEffect = handlers['runtime.prewarm'];
  if (typeof providerEffect !== 'function') return entry;
  return Object.freeze({
    ...entry,
    handlers: Object.freeze({
      ...handlers,
      'runtime.prewarm': createRuntimePrewarmHandler(providerEffect)
    })
  });
}

function appendProjection(context, type) {
  const { session, store } = sessionContext(context);
  return store.appendEvent(session.sessionId, {
    type,
    source: eventSource(session),
    payload: {
      runtimeBinding: structuredClone(session.runtimeBinding || {}),
      capabilitySnapshot: structuredClone(session.capabilitySnapshot || {})
    }
  });
}

function appendFailure(context, error) {
  const { session, store } = sessionContext(context);
  return store.appendEvent(session.sessionId, {
    type: 'runtime.prewarm.failed',
    source: eventSource(session),
    payload: { error: String(error && error.code || 'runtime_prewarm_failed') }
  });
}

function sessionContext(context = {}) {
  const store = context.store;
  const sessionId = String(context.sessionId || '').trim();
  const session = store && typeof store.getSession === 'function'
    ? store.getSession(sessionId)
    : null;
  if (!session || typeof store.appendEvent !== 'function') {
    throw new ChatRuntimeError('chat_runtime_prewarm_context_invalid', 500);
  }
  return { session, store };
}

function eventSource(session) {
  return {
    provider: session.provider,
    runtimeId: String(session.runtimeBinding && session.runtimeBinding.runtimeId || 'unbound')
  };
}

module.exports = {
  createRuntimePrewarmHandler,
  withRuntimePrewarmLifecycle
};
