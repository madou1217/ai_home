'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { formatDiagnosticMessage } = require('../../runtime/diagnostic-message');
const { createDesktopChatRuntimeClient } = require('./chat-runtime-client');

// Native Chat is deliberately a projection over Go WebUI ChatRuntime via HTTP+SSE.
// This bridge owns only the JSONL identities and never creates a provider request
// outside /v0/webui/chat/sessions*.
function createDesktopChatRuntimeBridge(options = {}) {
  const { client, resolveTarget, onEvent } = options || {};
  let runtimeClient = null;
  let ownsClient = false;
  if (client) {
    if (
      typeof client !== 'object'
      || typeof client.createSession !== 'function'
      || typeof client.start !== 'function'
      || (typeof client.sendTurn !== 'function' && typeof client.dispatchCommand !== 'function')
      || (typeof client.stopTurn !== 'function' && typeof client.dispatchCommand !== 'function')
    ) {
      throw new TypeError('desktop chat bridge requires valid chat runtime client');
    }
    runtimeClient = client;
  } else {
    runtimeClient = createDesktopChatRuntimeClient(options);
    ownsClient = true;
  }

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
      if (error && error.__streamErrorAlreadyEmitted) return;
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
    const session = await runtimeClient.createSession({
      provider: target.provider,
      executionAccountRef: target.executionAccountRef || 'gateway',
      projectPath: '',
      policy: { approvalMode: 'confirm', model: target.model }
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
      streamErrorEmitted: false,
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
        type: 'chat.event',
        requestId,
        sessionId: entry.sessionId,
        event,
        ...(commandEvent && inCommandRange && binding && binding.id
          ? { commandId: binding.id, generation: binding.generation }
          : {})
      };
      if (entry.dispatching && binding && commandEvent && inCommandRange) {
        binding.buffer.push(wrapper);
      } else {
        send(wrapper, context);
        if (
          !entry.dispatching
          && ((commandEvent && isTerminalEvent(event.type)) || (event && event.type === 'session.closed'))
        ) {
          entry.activeCommandId = '';
        }
      }
    };
    const handleStreamError = (error) => {
      if (sessions.get(entry.sessionId) !== entry) return;
      if (error && error.retryable === true) return;
      entry.streamErrorEmitted = true;
      const errorMessage = entry.dispatching && entry.pendingCommand
        ? {
          requestId,
          sessionId: entry.sessionId,
          commandId: entry.pendingCommand.id,
          generation: entry.pendingCommand.generation
        }
        : entry.activeCommandId
          ? {
            requestId,
            sessionId: entry.sessionId,
            commandId: entry.activeCommandId,
            generation: entry.activeCommandGeneration
          }
          : {
            requestId,
            sessionId: entry.sessionId,
            generation: entry.generation
          };
      if (!entry.dispatching) entry.activeCommandId = '';
      sessions.delete(entry.sessionId);
      try { entry.unsubscribe?.(); } catch (_error) { /* best effort */ }
      emitError(errorMessage, error, context);
    };
    sessions.set(entry.sessionId, entry);
    const stream = runtimeClient.start(entry.sessionId, 0);
    if (!stream || typeof stream !== 'object') {
      sessions.delete(entry.sessionId);
      throw bridgeError('chat_runtime_event_stream_invalid');
    }
    entry.unsubscribe = () => {
      try { stream.close?.(); } catch (_error) { /* best effort */ }
    };
    if (typeof stream.onEvent === 'function') {
      stream.onEvent(forward);
    } else {
      stream.onmessage = (raw) => forward(raw && Object.prototype.hasOwnProperty.call(raw, 'data') ? raw.data : raw);
    }
    if (typeof stream.onError === 'function') {
      stream.onError(handleStreamError);
    } else {
      stream.onerror = handleStreamError;
    }
    return session;
  }

  async function submit(message, context) {
    const entry = sessionEntry(message);
    const commandId = required(message.commandId);
    const generation = integer(message.generation);
    if (entry.pendingCommand) throw bridgeError('chat_command_busy');
    if (generation === null || generation < entry.activeCommandGeneration) throw bridgeError('chat_command_generation_stale');
    // Events emitted concurrently over SSE during command submission belong to
    // this command once they advance beyond the last observed sequence.
    // Older events remain unbound until acceptedSeq replaces this provisional range.
    const pending = { id: commandId, generation, fromSeq: entry.lastSeq + 1, buffer: [], stopRequested: false };
    entry.pendingCommand = pending;
    entry.dispatching = true;
    let result;
    let temporaryReferencePath = '';
    try {
      try {
        const payload = { content: required(message.text), ...(entry.model ? { model: entry.model } : {}) };
        if (message.fileReference !== undefined) {
          if (typeof runtimeClient.uploadAttachments !== 'function') throw bridgeError('chat_file_reference_unavailable');
          const reference = message.fileReference;
          if (!reference || typeof reference !== 'object' || Array.isArray(reference)) {
            throw bridgeError('chat_file_reference_invalid');
          }
          let text = reference.text || '';
          if (reference.path) {
            await assertOwnedTemporaryReferencePath(reference.path);
            temporaryReferencePath = reference.path;
            try { text = await fs.readFile(reference.path, 'utf8'); }
            catch (_error) { throw bridgeError('chat_file_reference_read_failed'); }
          }
          const dataUrl = `data:${reference.mimeType};base64,${Buffer.from(text, 'utf8').toString('base64')}`;
          const uploaded = await runtimeClient.uploadAttachments(entry.sessionId, {
            attachments: [{ name: reference.name, mimeType: reference.mimeType, dataUrl }]
          });
          const attachmentId = uploaded && uploaded[0] && (uploaded[0].attachmentId || uploaded[0].id);
          if (typeof attachmentId !== 'string' || !attachmentId.trim()) throw bridgeError('chat_file_reference_upload_invalid');
          payload.attachmentIds = [attachmentId];
        }
        result = typeof runtimeClient.sendTurn === 'function'
          ? await runtimeClient.sendTurn(entry.sessionId, payload.content, {
            commandId,
            ...(payload.model !== undefined ? { model: payload.model } : {}),
            ...(payload.attachmentIds !== undefined ? { attachmentIds: payload.attachmentIds } : {})
          })
          : await runtimeClient.dispatchCommand(entry.sessionId, {
            commandId,
            type: 'turn.submit',
            payload
          });
      } catch (error) {
        entry.pendingCommand = null;
        if (entry.streamErrorEmitted && error && typeof error === 'object') {
          error.__streamErrorAlreadyEmitted = true;
        }
        throw error;
      } finally {
        entry.dispatching = false;
      }
      if (!Number.isSafeInteger(result && result.acceptedSeq) || result.acceptedSeq < 0) {
        entry.pendingCommand = null;
        throw bridgeError('chat_command_seq_invalid');
      }
      entry.activeCommandId = pending.id;
      entry.activeCommandGeneration = pending.generation;
      entry.activeFromSeq = result.acceptedSeq;
      entry.interruptRequested = false;
      entry.pendingCommand = null;
      if (sessions.get(entry.sessionId) !== entry) return;
      for (const wrapper of pending.buffer) {
        const bufferedSeq = Number(wrapper.event && wrapper.event.seq);
        if (
          Number.isSafeInteger(bufferedSeq)
          && wrapper.event.type !== 'stream.error'
          && bufferedSeq < result.acceptedSeq
        ) {
          delete wrapper.commandId;
          delete wrapper.generation;
        }
        send(wrapper, context);
        if (wrapper.commandId && isTerminalEvent(wrapper.event.type)) entry.activeCommandId = '';
      }
      if (pending.stopRequested && entry.activeCommandId === pending.id) await interrupt(entry, pending.id);
    } finally {
      if (temporaryReferencePath) { try { await fs.unlink(temporaryReferencePath); } catch (_error) { /* best effort */ } }
    }
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
    if (typeof runtimeClient.stopTurn === 'function') {
      await runtimeClient.stopTurn(entry.sessionId, `${commandId}:interrupt`);
      return;
    }
    await runtimeClient.dispatchCommand(entry.sessionId, {
      commandId: `${commandId}:interrupt`,
      type: 'turn.interrupt',
      payload: { reason: 'user_stop' }
    });
  }

  function close(message, _context) {
    const requestId = required(message.requestId);
    const opening = pendingOpens.get(requestId);
    if (opening) {
      opening.cancelled = true;
      pendingOpens.delete(requestId);
    }
    for (const [sessionId, entry] of sessions) {
      if (entry.requestId !== requestId) continue;
      sessions.delete(sessionId);
      try { entry.unsubscribe?.(); } catch (_error) { /* best effort */ }
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
      type: 'chat.error',
      requestId: String(message.requestId || ''),
      ...(message.sessionId ? { sessionId: message.sessionId } : {}),
      ...(message.commandId ? { commandId: message.commandId } : {}),
      ...(message.generation === undefined ? {} : { generation: message.generation }),
      code: String(error && error.code || 'chat_runtime_failed'),
      message: formatDiagnosticMessage(error && error.message ? error.message : error, 'Chat 运行失败').slice(0, 1000)
    }, context);
  }

  function closeBridge() {
    for (const opening of pendingOpens.values()) opening.cancelled = true;
    pendingOpens.clear();
    for (const entry of sessions.values()) {
      try { entry.unsubscribe?.(); } catch (_error) { /* best effort */ }
    }
    sessions.clear();
    if (ownsClient) {
      try { runtimeClient.close?.(); } catch (_error) { /* best effort */ }
    }
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

async function assertOwnedTemporaryReferencePath(value) {
  const target = String(value || '').trim();
  const tempRoot = path.resolve(os.tmpdir());
  const lexicalTarget = path.resolve(target);
  const relative = path.relative(tempRoot, lexicalTarget);
  const ownedName = /^aih-chat-[0-9a-f-]+\.txt$/i.test(path.basename(lexicalTarget));
  if (!path.isAbsolute(target) || !ownedName || (relative && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)))) {
    throw bridgeError('chat_file_reference_path_invalid');
  }
  try {
    const [realRoot, realTarget] = await Promise.all([fs.realpath(tempRoot), fs.realpath(lexicalTarget)]);
    const realRelative = path.relative(path.resolve(realRoot), path.resolve(realTarget));
    if (realRelative && (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative))) {
      throw bridgeError('chat_file_reference_path_invalid');
    }
    const stat = await fs.stat(realTarget);
    if (!stat.isFile()) throw bridgeError('chat_file_reference_path_invalid');
  } catch (error) {
    if (error && error.code === 'chat_file_reference_path_invalid') throw error;
    throw bridgeError('chat_file_reference_path_invalid');
  }
}

function bridgeError(code) { const error = new Error(code); error.code = code; return error; }

module.exports = { createDesktopChatRuntimeBridge };
