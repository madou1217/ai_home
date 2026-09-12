'use strict';

const { mapCodexAppServerMessage } = require('../codex-app-server-canonical');
const { ChatRuntimeError } = require('./contracts');
const { adaptCodexServerResponse } = require('./codex-server-response-adapters');
const { CodexInteractionReplayGate } = require('./codex-interaction-replay-gate');
const {
  readCodexInteractionEnvelope
} = require('./codex-interaction-request-adapter');
const {
  CodexToolOrderCoordinator
} = require('./codex-tool-order-coordinator');

const TURN_EVENTS = new Set([
  'turn.started', 'turn.completed', 'turn.failed', 'turn.interrupted'
]);
const TERMINAL_TURN_EVENTS = new Set([
  'turn.completed', 'turn.failed', 'turn.interrupted'
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
    this.compactionWaiters = new Set();
    const compactionTimeoutMs = Number(options.compactionTimeoutMs);
    this.compactionTimeoutMs = Number.isFinite(compactionTimeoutMs) && compactionTimeoutMs > 0
      ? compactionTimeoutMs : 120000;
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

  cancelCompactionWaiters(error = new ChatRuntimeError('codex_driver_closed', 410)) {
    for (const waiter of [...this.compactionWaiters]) this.finishCompactionWaiter(waiter, error);
  }

  /**
   * `thread/compact/start` acknowledges queueing Op::Compact, not completion.
   * Register before sending the request; current servers complete an item and
   * then the containing turn before the next input can safely be submitted.
   */
  waitForCompaction(threadId) {
    const expectedThreadId = String(threadId || '').trim();
    if (!expectedThreadId) {
      const failure = Promise.reject(new ChatRuntimeError('codex_native_session_missing', 422));
      failure.catch(() => {});
      return failure;
    }
    const completion = new Promise((resolve, reject) => {
      const waiter = {
        threadId: expectedThreadId, turnId: '', resolve, reject
      };
      waiter.timer = setTimeout(() => this.finishCompactionWaiter(waiter,
        new ChatRuntimeError('codex_compaction_timeout', 504, {
          threadId: expectedThreadId,
          timeoutMs: this.compactionTimeoutMs
        })), this.compactionTimeoutMs);
      this.compactionWaiters.add(waiter);
    });
    // The caller awaits the scheduling RPC first. Cancellation or failure can
    // arrive before that receipt; retain the rejection for its later await
    // without emitting an unhandled rejection in the intervening event loop.
    completion.catch(() => {});
    return completion;
  }

  forwardNotification(message, context) {
    return this.forward(message, context, null, context && context.toolOrder);
  }

  forwardServerRequest(message, context, client) {
    return this.forward(message, context, client, context && context.toolOrder);
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

  forward(message, context, client, toolOrder) {
    if (!client && toolOrder && toolOrder.accepts(message)) {
      return this.forwardRawToolOrder(message, context, toolOrder);
    }
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
    let persisted = this.writeChain;
    if (shouldRoute) {
      let flushed = Promise.resolve();
      if (TERMINAL_TURN_EVENTS.has(mapped.type) && toolOrder) {
        flushed = toolOrder.flush((ordered) => this.route(ordered));
      }
      const scheduled = toolOrder
        ? toolOrder.schedule(event, (ordered) => this.route(ordered))
        : this.route(event);
      persisted = Promise.all([flushed, scheduled]);
    }
    const compaction = this.observeCompaction(message, mapped, persisted);
    return { event, mapped, persisted, providerTurnId, compaction };
  }

  forwardRawToolOrder(message, context, toolOrder) {
    const mapped = { classification: 'known_noop', method: message.method, payload: {} };
    const event = canonicalize({
      type: 'provider.known_noop',
      payload: { method: message.method }
    }, context);
    const persisted = toolOrder.observe(message, (ordered) => this.route(ordered));
    return { event, mapped, persisted, providerTurnId: '' };
  }

  createToolOrder() { return new CodexToolOrderCoordinator(); }

  flushToolOrder(toolOrder) {
    if (!toolOrder) return this.writeChain;
    const flush = toolOrder.flush((ordered) => this.route(ordered));
    return Promise.all([flush, ...toolOrder.pending()]).then(() => this.writeChain);
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

  observeCompaction(message, mapped, persisted) {
    if (this.compactionWaiters.size === 0) return false;
    const threadId = String(message.params?.threadId || '').trim();
    if (!threadId) return false;
    const item = mapped.payload?.item;
    const code = String(item?.detail?.code || '');
    const isCompactionItem = code === 'contextCompaction' || code === 'context_compacted';
    const isStarted = isCompactionItem && mapped.type === 'timeline.item.started';
    const isCompleted = isCompactionItem && mapped.type === 'timeline.item.completed';
    const turnId = String(mapped.turnId || '').trim();
    let handled = false;
    for (const waiter of this.compactionWaiters) {
      if (waiter.threadId !== threadId) continue;
      if (waiter.turnId && turnId && waiter.turnId !== turnId) continue;
      const legacyCompleted = message.method === 'thread/compacted';
      if (!turnId && !legacyCompleted) continue;
      if (!waiter.turnId && !(isStarted || isCompleted || mapped.type === 'turn.started')) continue;
      if (!waiter.turnId) waiter.turnId = turnId;
      handled = true;
      const terminal = TERMINAL_TURN_EVENTS.has(mapped.type);
      const error = terminal && mapped.type !== 'turn.completed'
        ? compactionError(mapped, threadId) : null;
      if (terminal || legacyCompleted) {
        // Preserve the native completion and its canonical checkpoint as one
        // boundary. A slow/failed event sink must not release the next turn.
        Promise.resolve(persisted).then(
          () => this.finishCompactionWaiter(waiter, error),
          (failure) => this.finishCompactionWaiter(waiter, failure)
        );
      }
    }
    return handled;
  }

  finishCompactionWaiter(waiter, error) {
    if (!this.compactionWaiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    if (error) waiter.reject(error);
    else waiter.resolve();
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

function compactionError(mapped, threadId) {
  const error = new ChatRuntimeError('codex_compaction_failed', 502, { threadId });
  const message = mapped.payload && mapped.payload.error && mapped.payload.error.message;
  if (message) error.message = message;
  return error;
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
