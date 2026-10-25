'use strict';

// Native Chat is deliberately a projection over ChatRuntimeService. This
// adapter owns only the JSONL identities and never creates a provider request
// outside the existing session/command APIs.
function createDesktopChatRuntimeBridge({ runtime, resolveTarget, onEvent } = {}) {
  if (!runtime || typeof runtime.openChatSession !== 'function' || typeof runtime.dispatchCommand !== 'function') {
    throw new TypeError('desktop chat bridge requires chat runtime service');
  }
  if (typeof runtime.subscribe !== 'function') throw new TypeError('desktop chat bridge requires event subscription');
  const sessions = new Map();
  const targetResolver = typeof resolveTarget === 'function' ? resolveTarget : () => ({});
  const eventSink = typeof onEvent === 'function' ? onEvent : () => {};

  function send(message, context) {
    const sink = context && typeof context.send === 'function' ? context.send : eventSink;
    sink(message);
  }

  async function handle(message, context = {}) {
    if (!message || typeof message !== 'object') return;
    try {
      if (message.type === 'chat.open') return await open(message, context);
      if (message.type === 'chat.submit') return await submit(message, context);
      if (message.type === 'chat.stop') return await stop(message, context);
      if (message.type === 'chat.close') return close(message, context);
    } catch (error) {
      emitError(message, error, context);
    }
  }

  async function open(message, context) {
    const requestId = required(message.requestId);
    const existing = [...sessions.values()].find((entry) => entry.requestId === requestId);
    if (existing) return existing.session;
    const target = await targetResolver(message.target || {});
    if (!target || !target.provider || !target.model) throw bridgeError('chat_target_unconfigured');
    const session = await runtime.openChatSession({
      provider: target.provider,
      executionAccountRef: target.executionAccountRef || 'gateway',
      projectPath: '',
      policy: { workspaceMode: 'chat', approvalMode: 'confirm', model: target.model }
    });
    const entry = {
      requestId,
      sessionId: session.sessionId,
      generation: integer(message.generation) || 0,
      commandId: '',
      commandGeneration: 0,
      activeFromSeq: null,
      lastSeq: 0,
      model: target.model,
      unsubscribe: null
    };
    const forward = (event) => {
      const commandEvent = isCommandEvent(event && event.type);
      const seq = Number(event && event.seq);
      if (Number.isSafeInteger(seq) && seq > entry.lastSeq) entry.lastSeq = seq;
      const inCommandRange = event && event.type === 'stream.error'
        ? Boolean(entry.commandId)
        : Number.isSafeInteger(seq) && (entry.activeFromSeq === null || seq >= entry.activeFromSeq);
      const wrapper = {
        type: 'chat.event', requestId, sessionId: entry.sessionId,
        event,
        ...(commandEvent && inCommandRange && entry.commandId ? { commandId: entry.commandId, generation: entry.commandGeneration } : {})
      };
      send(wrapper, context);
      if (commandEvent && isTerminalEvent(event.type)) {
        entry.commandId = '';
      }
    };
    entry.unsubscribe = runtime.subscribe(entry.sessionId, forward);
    sessions.set(entry.sessionId, entry);
    if (typeof runtime.readEvents === 'function') {
      const replay = await runtime.readEvents(entry.sessionId, { after: 0 });
      for (const event of replay && replay.events || []) forward(event);
    }
    return session;
  }

  async function submit(message, context) {
    const entry = sessionEntry(message);
    const commandId = required(message.commandId);
    const generation = integer(message.generation);
    if (generation === null || generation < entry.commandGeneration) throw bridgeError('chat_command_generation_stale');
    entry.commandId = commandId;
    entry.commandGeneration = generation;
    // Events emitted synchronously by dispatch belong to this command once
    // they advance beyond the last observed sequence. Older events remain
    // unbound until the accepted sequence replaces this provisional range.
    entry.activeFromSeq = entry.lastSeq + 1;
    const payload = { content: required(message.text), ...(entry.model ? { model: entry.model } : {}) };
    const result = await runtime.dispatchCommand(entry.sessionId, { commandId, type: 'turn.submit', payload });
    if (!Number.isSafeInteger(result && result.acceptedSeq) || result.acceptedSeq < 0) throw bridgeError('chat_command_seq_invalid');
    entry.activeFromSeq = result.acceptedSeq;
  }

  async function stop(message, context) {
    const entry = sessionEntry(message);
    const commandId = required(message.commandId);
    if (entry.commandId && entry.commandId !== commandId) throw bridgeError('chat_command_identity_mismatch');
    const generation = integer(message.generation);
    if (generation === null || generation !== entry.commandGeneration) throw bridgeError('chat_command_generation_stale');
    await runtime.dispatchCommand(entry.sessionId, {
      commandId: `${commandId}:interrupt`, type: 'turn.interrupt', payload: { reason: 'user_stop' }
    });
  }

  function close(message, context) {
    const requestId = required(message.requestId);
    for (const [sessionId, entry] of sessions) {
      if (entry.requestId !== requestId) continue;
      try { entry.unsubscribe?.(); } catch (_error) { /* best effort */ }
      sessions.delete(sessionId);
    }
  }

  function sessionEntry(message) {
    const sessionId = required(message.sessionId);
    const entry = sessions.get(sessionId);
    if (!entry || entry.requestId !== required(message.requestId)) throw bridgeError('chat_session_identity_mismatch');
    return entry;
  }

  function emitError(message, error, context) {
    send({
      type: 'chat.error', requestId: String(message.requestId || ''),
      ...(message.sessionId ? { sessionId: message.sessionId } : {}),
      ...(message.commandId ? { commandId: message.commandId } : {}),
      ...(message.generation === undefined ? {} : { generation: message.generation }),
      code: String(error && error.code || 'chat_runtime_failed'),
      message: String(error && error.message || error || 'Chat 运行失败').slice(0, 1000)
    }, context);
  }

  function closeBridge() {
    for (const entry of sessions.values()) {
      try { entry.unsubscribe?.(); } catch (_error) { /* best effort */ }
    }
    sessions.clear();
  }

  return { handle, close: closeBridge };
}

function isCommandEvent(type) {
  return typeof type === 'string' && (type.startsWith('turn.') || type.startsWith('timeline.') || type === 'stream.error');
}

function isTerminalEvent(type) {
  return ['turn.completed', 'turn.failed', 'turn.interrupted'].includes(type);
}

function required(value) {
  const text = String(value || '').trim();
  if (!text) throw bridgeError('chat_identity_required');
  return text;
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function bridgeError(code) { const error = new Error(code); error.code = code; return error; }

module.exports = { createDesktopChatRuntimeBridge };
