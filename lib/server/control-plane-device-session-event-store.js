'use strict';

const sessionEventAcks = new Map();

function normalizeText(value, maxLength = 160) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeCursor(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}

function normalizeConsumerId(value) {
  return normalizeText(value, 128) || 'default';
}

function createSessionEventStoreError(code, statusCode = 400) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizeSessionId(value) {
  return normalizeText(value, 128);
}

function normalizeSessionAckPayload(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const sessionId = normalizeSessionId(source.sessionId || source.session_id || source.runId || source.run_id || source.sessionRef);
  if (!sessionId) throw createSessionEventStoreError('missing_session_id', 400);
  const cursor = source.cursor != null ? source.cursor : (source.seq != null ? source.seq : source.sequence);
  return {
    sessionId,
    cursor: normalizeCursor(cursor),
    consumerId: normalizeConsumerId(source.consumerId || source.consumer_id || source.clientId || source.client_id)
  };
}

function ackKey(sessionId, consumerId) {
  return `${sessionId}\n${consumerId}`;
}

function ackSessionEvents(payload = {}, deps = {}) {
  const input = normalizeSessionAckPayload(payload);
  const nowMs = Math.max(0, Math.floor(Number(deps.nowMs) || Date.now()));
  const ack = {
    accepted: true,
    sessionId: input.sessionId,
    consumerId: input.consumerId,
    cursor: input.cursor,
    ackedAt: nowMs
  };
  const key = ackKey(input.sessionId, input.consumerId);
  const previous = sessionEventAcks.get(key);
  if (!previous || input.cursor >= normalizeCursor(previous.cursor)) {
    sessionEventAcks.set(key, ack);
    return ack;
  }
  return {
    accepted: true,
    sessionId: input.sessionId,
    consumerId: input.consumerId,
    cursor: normalizeCursor(previous.cursor),
    ackedAt: normalizeCursor(previous.ackedAt),
    stale: true
  };
}

function getSessionEventAck(sessionId, consumerId = 'default') {
  const key = ackKey(normalizeSessionId(sessionId), normalizeConsumerId(consumerId));
  return sessionEventAcks.get(key) || null;
}

function clearSessionEventAcks() {
  sessionEventAcks.clear();
}

function eventSeq(value, fallbackSeq) {
  const source = value && typeof value === 'object' ? value : {};
  const seq = normalizeCursor(source.seq || source.cursor || source.sequence);
  return seq || normalizeCursor(fallbackSeq);
}

function applyEventSeq(events, cursor) {
  const source = Array.isArray(events) ? events : [];
  const endCursor = normalizeCursor(cursor);
  const firstFallback = Math.max(1, endCursor - source.length + 1);
  return source.map((event, index) => {
    const seq = eventSeq(event, firstFallback + index);
    return {
      ...event,
      seq,
      cursor: normalizeCursor(event && event.cursor) || seq
    };
  });
}

module.exports = {
  ackSessionEvents,
  applyEventSeq,
  clearSessionEventAcks,
  getSessionEventAck,
  normalizeCursor,
  normalizeSessionAckPayload
};
