'use strict';

const fs = require('node:fs/promises');

// Native Chat is deliberately a projection over ChatRuntimeService. This
// adapter owns only the JSONL identities and never creates a provider request
// outside the existing session/command APIs.
function createDesktopChatRuntimeBridge({ runtime, resolveTarget, onEvent } = {}) {
  if (!runtime || typeof runtime.openChatSession !== 'function' || typeof runtime.dispatchCommand !== 'function') {
    throw new TypeError('desktop chat bridge requires chat runtime service');
  }
  if (typeof runtime.subscribe !== 'function') throw new TypeError('desktop chat bridge requires event subscription');
  const sessions = new Map();
  const pendingOpens = new Map();
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
    if (pendingOpens.has(requestId)) return pendingOpens.get(requestId).promise;
    const opening = { cancelled: false, promise: null };
    pendingOpens.set(requestId, opening);
    opening.promise = openSession(message, context, opening);
    try { return await opening.promise; }
    catch (error) { if (!opening.cancelled) throw error; }
    finally { if (pendingOpens.get(requestId) === opening) pendingOpens.delete(requestId); }
  }

  async function openSession(message, context, opening) {
    const requestId = required(message.requestId);
    const target = await targetResolver(message.target || {});
    if (opening.cancelled) return;
    if (!target || !target.provider || !target.model) throw bridgeError('chat_target_unconfigured');
    const session = await runtime.openChatSession({
      provider: target.provider,
      executionAccountRef: target.executionAccountRef || 'gateway',
      projectPath: '',
      policy: { workspaceMode: 'chat', approvalMode: 'confirm', model: target.model }
    });
    if (opening.cancelled) return;
    const entry = {
      requestId,
      session,
      sessionId: session.sessionId,
      generation: integer(message.generation) || 0,
      activeCommandId: '',
      activeCommandGeneration: 0,
      activeFromSeq: null,
      lastSeq: 0,
      pendingCommand: null,
      interruptRequested: false,
      dispatching: false,
      model: target.model,
      unsubscribe: null
    };
    const forward = (event) => {
      if (sessions.get(entry.sessionId) !== entry) return;
      const commandEvent = isCommandEvent(event && event.type);
      const seq = Number(event && event.seq);
      if (Number.isSafeInteger(seq) && seq > entry.lastSeq) entry.lastSeq = seq;
      const binding = entry.dispatching ? entry.pendingCommand : {
        id: entry.activeCommandId, generation: entry.activeCommandGeneration, fromSeq: entry.activeFromSeq
      };
      const inCommandRange = event && event.type === 'stream.error'
        ? Boolean(binding && binding.id)
        : Number.isSafeInteger(seq) && binding && (binding.fromSeq === null || seq >= binding.fromSeq);
      const wrapper = {
        type: 'chat.event', requestId, sessionId: entry.sessionId,
        event,
        ...(commandEvent && inCommandRange && binding && binding.id ? { commandId: binding.id, generation: binding.generation } : {})
      };
      if (entry.dispatching && binding && commandEvent && inCommandRange) {
        binding.buffer.push(wrapper);
      } else {
        send(wrapper, context);
        if (!entry.dispatching && commandEvent && isTerminalEvent(event.type)) {
          entry.activeCommandId = '';
        }
      }
    };
    sessions.set(entry.sessionId, entry);
    entry.unsubscribe = runtime.subscribe(entry.sessionId, forward);
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
    if (entry.pendingCommand) throw bridgeError('chat_command_busy');
    if (generation === null || generation < entry.activeCommandGeneration) throw bridgeError('chat_command_generation_stale');
    // Events emitted synchronously by dispatch belong to this command once
    // they advance beyond the last observed sequence. Older events remain
    // unbound until the accepted sequence replaces this provisional range.
    const pending = { id: commandId, generation, fromSeq: entry.lastSeq + 1, buffer: [], stopRequested: false };
    entry.pendingCommand = pending;
    entry.dispatching = true;
    let result;
    let temporaryReferencePath = '';
    try {
      const payload = { content: required(message.text), ...(entry.model ? { model: entry.model } : {}) };
      if (message.fileReference !== undefined) {
        if (typeof runtime.uploadAttachments !== 'function') throw bridgeError('chat_file_reference_unavailable');
        const reference = message.fileReference;
        temporaryReferencePath = reference.path || '';
        let text = reference.text || '';
        if (reference.path) {
          try { text = await fs.readFile(reference.path, 'utf8'); }
          catch (_error) { throw bridgeError('chat_file_reference_read_failed'); }
        }
        const dataUrl = `data:${reference.mimeType};base64,${Buffer.from(text, 'utf8').toString('base64')}`;
        const uploaded = await runtime.uploadAttachments(entry.sessionId, {
          attachments: [{ name: reference.name, mimeType: reference.mimeType, dataUrl }]
        });
        const attachmentId = uploaded && uploaded[0] && (uploaded[0].attachmentId || uploaded[0].id);
        if (typeof attachmentId !== 'string' || !attachmentId.trim()) throw bridgeError('chat_file_reference_upload_invalid');
        payload.attachmentIds = [attachmentId];
      }
      result = await runtime.dispatchCommand(entry.sessionId, { commandId, type: 'turn.submit', payload });
    } catch (error) {
      entry.pendingCommand = null;
      throw error;
    } finally {
      entry.dispatching = false;
    }
    if (!Number.isSafeInteger(result && result.acceptedSeq) || result.acceptedSeq < 0) {
      entry.pendingCommand = null;
      throw bridgeError('chat_command_seq_invalid');
    }
    if (temporaryReferencePath) { try { await fs.unlink(temporaryReferencePath); } catch (_error) { /* best effort */ } }
    entry.activeCommandId = pending.id;
    entry.activeCommandGeneration = pending.generation;
    entry.activeFromSeq = result.acceptedSeq;
    entry.interruptRequested = false;
    entry.pendingCommand = null;
    if (sessions.get(entry.sessionId) !== entry) return;
    for (const wrapper of pending.buffer) {
      send(wrapper, context);
      if (isTerminalEvent(wrapper.event.type)) entry.activeCommandId = '';
    }
    if (pending.stopRequested && entry.activeCommandId === pending.id) await interrupt(entry, pending.id);
  }

  async function stop(message, context) {
    const entry = sessionEntry(message);
    const commandId = required(message.commandId);
    const generation = integer(message.generation);
    if (entry.pendingCommand) {
      const pending = entry.pendingCommand;
      if (pending.id !== commandId) throw bridgeError('chat_command_identity_mismatch');
      if (generation === null || generation !== pending.generation) throw bridgeError('chat_command_generation_stale');
      // Cold harness startup can keep submit pending. Remember the user's stop
      // until acceptance; never report failure while leaving that turn running.
      pending.stopRequested = true;
      return;
    }
    if (entry.activeCommandId && entry.activeCommandId !== commandId) throw bridgeError('chat_command_identity_mismatch');
    if (generation === null || generation !== entry.activeCommandGeneration) throw bridgeError('chat_command_generation_stale');
    if (!entry.activeCommandId) return;
    await interrupt(entry, commandId);
  }

  async function interrupt(entry, commandId) {
    if (entry.interruptRequested) return;
    entry.interruptRequested = true;
    await runtime.dispatchCommand(entry.sessionId, {
      commandId: `${commandId}:interrupt`, type: 'turn.interrupt', payload: { reason: 'user_stop' }
    });
  }

  function close(message, context) {
    const requestId = required(message.requestId);
    const opening = pendingOpens.get(requestId);
    if (opening) {
      opening.cancelled = true;
      pendingOpens.delete(requestId);
    }
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
    for (const opening of pendingOpens.values()) opening.cancelled = true;
    pendingOpens.clear();
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
