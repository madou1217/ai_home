'use strict';

const {
  BoundedSseWriter,
  encodeSseEvent,
  normalizeSseSequence: normalizeCursor,
  openSseHeaders,
  writeSseEvent
} = require('./webui-chat-runtime-sse-writer');

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_REPLAY_BUFFER_LIMIT = 256;
const DEFAULT_PENDING_FRAME_LIMIT = 256;

function resolveAfterCursor(req) {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  const queryCursor = requestUrl.searchParams.get('after');
  if (queryCursor !== null) return normalizeCursor(queryCursor);
  return normalizeCursor(req.headers['last-event-id']);
}

async function openChatRuntimeEventStream(ctx, service, sessionId, injected = {}) {
  const { req, res } = ctx;
  const stream = createStream(ctx, sessionId, resolveAfterCursor(req), injected);
  openSseHeaders(res);
  try {
    startStream(stream, service);
    if (stream.closed) return true;
    const replay = await service.readEvents(sessionId, { after: stream.cursor });
    if (!stream.closed) finishReplay(stream, replay);
  } catch (error) {
    terminateStream(stream, error);
  }
  return true;
}

function createStream(ctx, sessionId, cursor, injected) {
  const config = resolveConfig(ctx, injected);
  const stream = {
    req: ctx.req,
    res: ctx.res,
    sessionId,
    cursor,
    config,
    replaying: true,
    buffered: [],
    bindings: [],
    unsubscribe: null,
    timer: null,
    closed: false,
    writer: null
  };
  stream.writer = new BoundedSseWriter(stream.res, {
    limit: config.pendingFrameLimit,
    onOverflow: () => terminateCode(stream, 'chat_runtime_backpressure_overflow'),
    onFailure: () => cleanupStream(stream)
  });
  return stream;
}

function startStream(stream, service) {
  bindTerminationSignals(stream);
  if (typeof service.subscribe === 'function') {
    const unsubscribe = service.subscribe(stream.sessionId, (event) => receiveEvent(stream, event));
    if (stream.closed) safeCall(unsubscribe);
    else stream.unsubscribe = unsubscribe;
  }
  if (stream.closed) return;
  stream.timer = stream.config.setInterval(() => {
    if (!stream.writer.send(': heartbeat\n\n')) cleanupStream(stream);
  }, stream.config.heartbeatMs);
  if (stream.timer && typeof stream.timer.unref === 'function') stream.timer.unref();
}

function receiveEvent(stream, event) {
  if (stream.closed) return;
  if (!stream.replaying) {
    emitAfterCursor(stream, event);
    return;
  }
  if (stream.buffered.length >= stream.config.replayBufferLimit) {
    terminateCode(stream, 'chat_runtime_replay_buffer_overflow');
    return;
  }
  stream.buffered.push(event);
}

function finishReplay(stream, replay = {}) {
  if (replay.gap && replay.snapshot) emitSnapshotReset(stream, replay.snapshot);
  if (!emitEventBatch(stream, replay.events || [])) return;
  stream.buffered.sort(compareEventSequence);
  if (!emitEventBatch(stream, stream.buffered)) return;
  stream.buffered.length = 0;
  stream.replaying = false;
}

function emitEventBatch(stream, events) {
  for (const event of events) {
    if (stream.closed || !emitAfterCursor(stream, event)) return false;
  }
  return true;
}

function compareEventSequence(left, right) {
  return normalizeCursor(left && left.seq) - normalizeCursor(right && right.seq);
}

function emitAfterCursor(stream, event) {
  const seq = normalizeCursor(event && event.seq);
  if (seq > 0 && seq <= stream.cursor) return true;
  if (!stream.writer.send(encodeSseEvent(event))) return false;
  if (seq > 0) stream.cursor = seq;
  return true;
}

function emitSnapshotReset(stream, snapshot) {
  const seq = normalizeCursor(snapshot && snapshot.throughSeq);
  const event = transportEvent(stream, 'session.snapshot.reset', seq, snapshot);
  if (stream.writer.send(encodeSseEvent(event))) stream.cursor = seq;
}

function terminateCode(stream, code) {
  const error = new Error(code);
  error.code = code;
  terminateStream(stream, error);
}

function terminateStream(stream, error) {
  if (stream.closed) return;
  const code = String((error && error.code) || 'chat_runtime_stream_failed');
  const payload = { error: code, message: String((error && error.message) || error || 'unknown') };
  const event = transportEvent(stream, 'stream.error', 0, payload);
  stream.writer.fail(encodeSseEvent(event));
  cleanupStream(stream);
}

function transportEvent(stream, type, seq, payload) {
  return {
    schema: 'aih.chat.event.v1',
    eventId: `${type}-${stream.sessionId}-${stream.config.now()}`,
    sessionId: stream.sessionId,
    seq,
    type,
    at: stream.config.now(),
    source: { provider: 'unknown', runtimeId: 'aih-chat-runtime' },
    payload
  };
}

function bindTerminationSignals(stream) {
  const cleanup = () => cleanupStream(stream);
  stream.bindings = [
    [stream.req, 'close', cleanup],
    [stream.req, 'error', cleanup],
    [stream.res, 'close', cleanup],
    [stream.res, 'error', cleanup]
  ];
  for (const [emitter, type, listener] of stream.bindings) emitter.once(type, listener);
}

function cleanupStream(stream) {
  if (stream.closed) return;
  stream.closed = true;
  stream.writer.close();
  stream.buffered.length = 0;
  for (const [emitter, type, listener] of stream.bindings) {
    emitter.removeListener(type, listener);
  }
  stream.bindings.length = 0;
  if (stream.timer !== null) safeCall(stream.config.clearInterval, stream.timer);
  stream.timer = null;
  safeCall(stream.unsubscribe);
  stream.unsubscribe = null;
}

function resolveConfig(ctx, injected) {
  const contextOptions = ctx.deps && ctx.deps.chatRuntimeSseOptions || {};
  const options = { ...contextOptions, ...injected };
  return {
    heartbeatMs: positiveInteger(options.heartbeatMs, DEFAULT_HEARTBEAT_MS),
    replayBufferLimit: positiveInteger(options.replayBufferLimit, DEFAULT_REPLAY_BUFFER_LIMIT),
    pendingFrameLimit: positiveInteger(options.pendingFrameLimit, DEFAULT_PENDING_FRAME_LIMIT),
    setInterval: options.setInterval || setInterval,
    clearInterval: options.clearInterval || clearInterval,
    now: options.now || Date.now
  };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function safeCall(callback, ...args) {
  if (typeof callback !== 'function') return;
  try { callback(...args); } catch (_error) {}
}

module.exports = {
  openChatRuntimeEventStream,
  resolveAfterCursor,
  writeSseEvent
};
