'use strict';

const crypto = require('node:crypto');

const CHAT_RUNTIME_TRACE_STAGES = Object.freeze([
  'requestAccepted',
  'commandPersisted',
  'actorDequeued',
  'runtimeAcquired',
  'authReady',
  'sessionBound',
  'turnSubmitted',
  'firstProviderEvent',
  'firstVisibleItem',
  'firstTextDelta',
  'completed'
]);

const SAFE_ATTRIBUTE_KEYS = new Set([
  'provider',
  'sessionId',
  'commandId',
  'runId',
  'runtimeId',
  'runtimeGeneration',
  'transport',
  'warm',
  'status',
  'errorCode'
]);

function createTraceError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeAttributeValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  return value.slice(0, 160);
}

function sanitizeTraceAttributes(source = {}) {
  const attributes = {};
  for (const key of SAFE_ATTRIBUTE_KEYS) {
    const value = normalizeAttributeValue(source[key]);
    if (value !== undefined && value !== '') attributes[key] = value;
  }
  return attributes;
}

function normalizeTimestamp(value, fallback) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : fallback;
}

function durationBetween(marks, from, to) {
  const start = marks.get(from);
  const end = marks.get(to);
  if (!start || !end) return null;
  return Math.max(0, end.at - start.at);
}

function buildDurations(marks) {
  return {
    commandAckMs: durationBetween(marks, 'requestAccepted', 'commandPersisted'),
    runtimeAcquireMs: durationBetween(marks, 'actorDequeued', 'runtimeAcquired'),
    providerFirstEventMs: durationBetween(marks, 'turnSubmitted', 'firstProviderEvent'),
    providerToVisibleMs: durationBetween(marks, 'firstProviderEvent', 'firstVisibleItem'),
    firstVisibleItemMs: durationBetween(marks, 'requestAccepted', 'firstVisibleItem'),
    firstTextDeltaMs: durationBetween(marks, 'requestAccepted', 'firstTextDelta'),
    totalMs: durationBetween(marks, 'requestAccepted', 'completed')
  };
}

class ChatRuntimeTrace {
  constructor(attributes = {}, deps = {}) {
    this.now = typeof deps.now === 'function' ? deps.now : Date.now;
    const randomUUID = typeof deps.randomUUID === 'function' ? deps.randomUUID : crypto.randomUUID;
    this.traceId = randomUUID();
    this.attributes = sanitizeTraceAttributes(attributes);
    this.marks = new Map();
    this.mark('requestAccepted', { at: attributes.startedAt });
  }

  mark(stage, details = {}) {
    if (!CHAT_RUNTIME_TRACE_STAGES.includes(stage)) {
      throw createTraceError('invalid_chat_runtime_trace_stage');
    }
    if (this.marks.has(stage)) return this.marks.get(stage);
    const item = {
      stage,
      at: normalizeTimestamp(details.at, this.now()),
      ...sanitizeTraceAttributes(details)
    };
    this.marks.set(stage, item);
    return item;
  }

  snapshot() {
    const stages = CHAT_RUNTIME_TRACE_STAGES
      .map((stage) => this.marks.get(stage))
      .filter(Boolean);
    return {
      traceId: this.traceId,
      ...this.attributes,
      stages,
      durations: buildDurations(this.marks)
    };
  }
}

module.exports = {
  CHAT_RUNTIME_TRACE_STAGES,
  ChatRuntimeTrace,
  sanitizeTraceAttributes
};
