'use strict';

const { mapCodexAppServerMessage } = require('../codex-app-server-canonical');
const { ChatRuntimeError } = require('./contracts');
const { adaptCodexServerResponse } = require('./codex-server-response-adapters');
const { CodexInteractionReplayGate } = require('./codex-interaction-replay-gate');
const {
  readCodexInteractionEnvelope
} = require('./codex-interaction-request-adapter');

const TURN_EVENTS = new Set([
  'turn.started', 'turn.completed', 'turn.failed', 'turn.interrupted'
]);
const TIMELINE_ITEM_EVENTS = new Set([
  'timeline.item.started', 'timeline.item.updated', 'timeline.item.completed'
]);

class CodexSessionEventBridge {
  constructor(options = {}) {
    if (typeof options.eventSink !== 'function') {
      throw new ChatRuntimeError('codex_event_sink_required', 500);
    }
    this.eventSink = options.eventSink;
    this.transientEventSink = options.transientEventSink || (() => {});
    this.provider = String(options.provider || 'codex');
    this.sessionId = String(options.sessionId || '').trim();
    this.pendingInteractions = new Map();
    this.replayGate = new CodexInteractionReplayGate({
      provider: this.provider,
      sessionId: this.sessionId,
      timeoutMs: options.interactionReplayTimeoutMs
    });
    this.writeChain = Promise.resolve();
  }

  expectReplays(interactions = []) {
    this.replayGate.expect(interactions);
  }

  waitForExpectedReplays() { return this.replayGate.wait(); }

  cancelExpectedReplays() { this.replayGate.cancel(); }

  forwardNotification(message, context) {
    return this.forward(message, context, null);
  }

  forwardServerRequest(message, context, client) {
    return this.forward(message, context, client);
  }

  respond(interactionId, expectedKind, revision, resolution) {
    const pending = this.requirePending(interactionId, expectedKind, revision);
    const result = adaptCodexServerResponse(pending, resolution);
    if (!pending.client.respond(pending.envelope.requestId, result)) {
      throw new ChatRuntimeError('codex_app_server_disconnected', 503);
    }
    pending.response = structuredClone(result);
    return { interactionId, revision, responded: true };
  }

  forward(message, context, client) {
    const mapped = mapCodexAppServerMessage(message, {
      provider: this.provider,
      sessionId: this.sessionId
    });
    if (mapped.classification === 'known_noop') {
      return this.skipKnownNoop(mapped, context);
    }
    const providerTurnId = String(mapped.turnId || '');
    const shouldRoute = client
      ? this.captureServerRequest(message, mapped, client)
      : true;
    if (mapped.type === 'interaction.resolved') this.removeResolved(mapped);
    const event = canonicalize(mapped, context);
    const persisted = shouldRoute ? this.route(event) : this.writeChain;
    return { event, mapped, persisted, providerTurnId };
  }

  skipKnownNoop(mapped, context) {
    const event = canonicalize({
      type: 'provider.known_noop',
      payload: { method: mapped.method }
    }, context);
    return {
      event,
      mapped,
      persisted: this.writeChain,
      providerTurnId: ''
    };
  }

  captureServerRequest(message, mapped, client) {
    if (mapped.type !== 'interaction.requested') {
      client.respondError(
        message.id,
        -32601,
        `unsupported server request: ${String(message.method || '')}`
      );
      return true;
    }
    const interaction = mapped.payload.interaction;
    const envelope = readCodexInteractionEnvelope(mapped);
    if (!envelope) {
      client.respondError(message.id, -32602, 'missing private interaction envelope');
      return false;
    }
    const replay = this.replayGate.capture(interaction, envelope);
    if (replay.error) {
      client.respondError(message.id, -32602, 'replayed server request changed shape');
      return false;
    }
    const existing = this.pendingInteractions.get(interaction.interactionId);
    if (existing && existing.response) client.respond(message.id, existing.response);
    if (existing) return false;
    this.pendingInteractions.set(interaction.interactionId, {
      client,
      envelope,
      interactionId: interaction.interactionId,
      kind: interaction.kind,
      response: null,
      revision: interaction.revision
    });
    return !replay.replayed;
  }

  removeResolved(mapped) {
    const payload = mapped.payload || {};
    const interactionId = String(payload.interactionId || '');
    if (interactionId) this.pendingInteractions.delete(interactionId);
  }

  route(event) {
    if (TURN_EVENTS.has(event.type)) return this.writeChain;
    const sink = event.type === 'stream.error'
      ? this.transientEventSink
      : this.eventSink;
    const write = this.writeChain.then(() => sink(event));
    this.writeChain = write.catch(() => {});
    return write;
  }

  requirePending(interactionId, expectedKind, revision) {
    const id = String(interactionId || '').trim();
    const pending = this.pendingInteractions.get(id);
    if (!pending) {
      throw new ChatRuntimeError('codex_interaction_not_pending', 409, { interactionId: id });
    }
    if (pending.kind !== expectedKind) {
      throw new ChatRuntimeError('codex_interaction_kind_mismatch', 409, {
        actual: pending.kind,
        expected: expectedKind,
        interactionId: id
      });
    }
    if (Number(revision) !== pending.revision) {
      throw new ChatRuntimeError('stale_interaction', 409, { interactionId: id, revision });
    }
    return pending;
  }
}

function canonicalize(mapped, context = {}) {
  const event = { ...mapped };
  const turnId = String(context.turnId || '').trim();
  if (turnId) {
    event.turnId = turnId;
    event.payload = canonicalTimelinePayload(event, turnId, context.model);
  }
  if (context.runId) event.runId = String(context.runId);
  return event;
}

function canonicalTimelinePayload(event, turnId, model) {
  const payload = event.payload && typeof event.payload === 'object'
    ? event.payload
    : {};
  if (event.type === 'timeline.item.delta') {
    return {
      itemId: payload.itemId,
      chunk: payload.chunk,
      ...(payload.detail === undefined ? {} : { detail: payload.detail })
    };
  }
  if (!TIMELINE_ITEM_EVENTS.has(event.type)) return event.payload;
  const item = payload.item && typeof payload.item === 'object'
    ? payload.item
    : {};
  return { item: withMessageModel({ ...item, turnId }, model) };
}

function withMessageModel(item, model) {
  const normalizedModel = String(model || '').trim();
  if (item.kind !== 'message' || !normalizedModel) return item;
  const detail = item.detail && typeof item.detail === 'object' ? item.detail : {};
  return { ...item, detail: { ...detail, model: normalizedModel } };
}

module.exports = { CodexSessionEventBridge };
