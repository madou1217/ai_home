'use strict';

// Provider session state is the single in-process/persisted snapshot consumed by
// hooks, native observers, and terminal-title sources.  It deliberately knows
// event semantics, but not provider-specific transport details.

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { writeFileAtomic } = require('../runtime/atomic-file-write');

const STATE_DIR = ['run', 'provider-session-state'];
const CORRELATION_DIR = ['run', 'provider-session-correlations'];
const PENDING_DIR = ['run', 'provider-session-pending'];
const STATE_VERSION = 1;
const DEFAULT_MAX_RECENT_EVENTS = 32;
const DEFAULT_MAX_PENDING_EVENTS = 16;

function text(value) {
  return String(value == null ? '' : value).trim();
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeSession(input = {}) {
  return {
    provider: text(input.provider || input.providerId).toLowerCase(),
    sessionId: text(input.sessionId || input.session_id || input.nativeSessionId),
    projectPath: text(input.projectPath || input.project_path),
    projectDirName: text(input.projectDirName || input.project_dir_name)
  };
}

function sessionKey(session) {
  const normalized = normalizeSession(session);
  if (!normalized.provider || !normalized.sessionId) return '';
  return JSON.stringify(normalized);
}

function fileKey(key) {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function boundedText(value, max = 4096) {
  return text(value).slice(0, max);
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  return clone(payload);
}

function normalizeEvent(input = {}) {
  const session = normalizeSession(input);
  const rawType = text(input.type || input.eventType || input.phase).toLowerCase();
  const type = {
    'session:opened': 'session-opened',
    'session:closed': 'session-closed',
    'session:turn-started': 'turn-started',
    'session:turn-updated': 'turn-updated',
    'session:turn-completed': 'turn-completed',
    'session:turn-failed': 'turn-failed',
    'session:turn-interrupted': 'turn-interrupted',
    'session:question-opened': 'question-opened',
    'session:question-cleared': 'question-cleared',
    'session:retry-status': 'retry-updated',
    'session:statusline-updated': 'statusline-updated',
    'session:route-updated': 'route-updated'
  }[rawType] || rawType;
  const revision = Math.max(0, Math.floor(finiteNumber(input.revision, 0)));
  const at = Math.max(0, finiteNumber(input.at, Date.now()));
  const eventId = boundedText(input.eventId || input.id, 160)
    || crypto.createHash('sha256').update(JSON.stringify({
      session,
      type,
      revision,
      at,
      payload: input.payload || {}
    }), 'utf8').digest('hex');
  return {
    eventId,
    session,
    correlationId: boundedText(input.correlationId || input.correlation_id, 128),
    source: boundedText(input.source || 'unknown', 64),
    type,
    revision,
    at,
    payload: normalizePayload(input.payload)
  };
}

function initialState(session) {
  return {
    version: STATE_VERSION,
    session: normalizeSession(session),
    revision: 0,
    lastEventAt: 0,
    turnState: 'idle',
    question: null,
    error: null,
    retry: null,
    statusline: null,
    route: null,
    lastEvent: null,
    recentEventIds: []
  };
}

function normalizeError(payload) {
  if (!payload || typeof payload !== 'object') return { message: boundedText(payload) };
  const message = boundedText(payload.message || payload.error || payload.reason || '');
  return message ? { message, code: boundedText(payload.code, 128) } : null;
}

function normalizeQuestion(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const question = boundedText(payload.question || payload.text || payload.prompt);
  if (!question) return null;
  const options = Array.isArray(payload.options)
    ? payload.options.slice(0, 32).map((item) => boundedText(item, 512)).filter(Boolean)
    : [];
  return { question, ...(options.length ? { options } : {}) };
}

function applyTransition(previous, event) {
  const next = clone(previous);
  const payload = event.payload;
  switch (event.type) {
    case 'session-opened':
      next.turnState = 'idle';
      break;
    case 'session-closed':
      next.turnState = 'closed';
      next.question = null;
      break;
    case 'turn-started':
      next.turnState = 'working';
      next.error = null;
      next.question = null;
      break;
    case 'turn-updated':
      next.turnState = 'working';
      break;
    case 'turn-completed':
      next.turnState = 'completed';
      next.question = null;
      next.error = null;
      break;
    case 'turn-failed':
      next.turnState = 'failed';
      next.error = normalizeError(payload);
      next.question = null;
      break;
    case 'turn-interrupted':
      next.turnState = 'interrupted';
      next.error = normalizeError(payload) || { message: 'interrupted' };
      next.question = null;
      break;
    case 'question-opened':
      next.turnState = 'waiting';
      next.question = normalizeQuestion(payload);
      break;
    case 'question-cleared':
      next.question = null;
      next.turnState = previous.turnState === 'waiting' ? 'working' : previous.turnState;
      break;
    case 'retry-updated':
      next.retry = normalizePayload(payload);
      break;
    case 'statusline-updated':
      next.statusline = normalizePayload(payload);
      break;
    case 'route-updated':
      next.route = normalizePayload(payload);
      break;
    default:
      break;
  }
  next.revision = Math.max(previous.revision, event.revision);
  next.lastEventAt = Math.max(previous.lastEventAt, event.at);
  next.lastEvent = {
    eventId: event.eventId,
    type: event.type,
    source: event.source,
    at: event.at
  };
  next.recentEventIds = [...previous.recentEventIds.filter((id) => id !== event.eventId), event.eventId]
    .slice(-DEFAULT_MAX_RECENT_EVENTS);
  return next;
}

function createProviderSessionStateStore(options = {}) {
  const fs = options.fs || nodeFs;
  const path = options.path || nodePath;
  const aiHomeDir = text(options.aiHomeDir);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const maxRecentEvents = Math.max(1, Math.floor(finiteNumber(options.maxRecentEvents, DEFAULT_MAX_RECENT_EVENTS)));
  const maxPendingEvents = Math.max(1, Math.floor(finiteNumber(options.maxPendingEvents, DEFAULT_MAX_PENDING_EVENTS)));
  const states = new Map();
  const correlations = new Map();
  const pending = new Map();
  const subscribers = new Set();

  function stateDir() {
    return aiHomeDir ? path.join(aiHomeDir, ...STATE_DIR) : '';
  }

  function statePath(key) {
    const dir = stateDir();
    return dir ? path.join(dir, `${fileKey(key)}.json`) : '';
  }

  function correlationPath(correlationId) {
    const correlation = text(correlationId);
    return aiHomeDir && correlation
      ? path.join(aiHomeDir, ...CORRELATION_DIR, `${fileKey(correlation)}.json`)
      : '';
  }

  function pendingPath(correlationId) {
    const correlation = text(correlationId);
    return aiHomeDir && correlation
      ? path.join(aiHomeDir, ...PENDING_DIR, `${fileKey(correlation)}.json`)
      : '';
  }

  function readPersisted(key) {
    const filePath = statePath(key);
    if (!filePath) return null;
    try {
      const parsed = JSON.parse(String(fs.readFileSync(filePath, 'utf8')));
      return parsed && parsed.version === STATE_VERSION && parsed.session ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  function persist(key, state) {
    const filePath = statePath(key);
    if (!filePath) return false;
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const bounded = {
      ...state,
      recentEventIds: (Array.isArray(state.recentEventIds) ? state.recentEventIds : []).slice(-maxRecentEvents)
    };
    writeFileAtomic(fs, filePath, `${JSON.stringify(bounded)}\n`, { encoding: 'utf8', mode: 0o600 });
    return true;
  }

  function persistCorrelation(correlationId, key) {
    const filePath = correlationPath(correlationId);
    if (!filePath) return false;
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    writeFileAtomic(fs, filePath, `${JSON.stringify({ version: STATE_VERSION, key })}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    return true;
  }

  function readCorrelationKey(correlationId) {
    const filePath = correlationPath(correlationId);
    if (!filePath) return '';
    try {
      const parsed = JSON.parse(String(fs.readFileSync(filePath, 'utf8')));
      return parsed && parsed.version === STATE_VERSION ? text(parsed.key) : '';
    } catch (_error) {
      return '';
    }
  }

  function readPending(correlationId) {
    const correlation = text(correlationId);
    if (!correlation) return [];
    if (pending.has(correlation)) return clone(pending.get(correlation));
    const filePath = pendingPath(correlation);
    if (!filePath) return [];
    try {
      const parsed = JSON.parse(String(fs.readFileSync(filePath, 'utf8')));
      const events = parsed && parsed.version === STATE_VERSION && Array.isArray(parsed.events)
        ? parsed.events.slice(-maxPendingEvents)
        : [];
      pending.set(correlation, events);
      return clone(events);
    } catch (_error) {
      return [];
    }
  }

  function persistPending(correlationId, events) {
    const filePath = pendingPath(correlationId);
    if (!filePath) return false;
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    writeFileAtomic(fs, filePath, `${JSON.stringify({
      version: STATE_VERSION,
      events: events.slice(-maxPendingEvents)
    })}\n`, { encoding: 'utf8', mode: 0o600 });
    return true;
  }

  function queuePending(correlationId, input) {
    const correlation = text(correlationId);
    if (!correlation) return { accepted: false, reason: 'correlation_not_ready', state: null };
    const event = normalizeEvent({ ...input, correlationId });
    if (!event.type) return { accepted: false, reason: 'invalid_event', state: null };
    const events = readPending(correlation);
    if (events.some((candidate) => candidate.eventId === event.eventId)) {
      return { accepted: false, reason: 'duplicate_event', state: null };
    }
    events.push(event);
    const bounded = events.slice(-maxPendingEvents);
    try {
      persistPending(correlation, bounded);
    } catch (_error) {
      return { accepted: false, reason: 'pending_persist_failed', state: null };
    }
    pending.set(correlation, bounded);
    return { accepted: false, reason: 'pending_correlation', state: null };
  }

  function drainPending(correlationId, session) {
    const correlation = text(correlationId);
    const events = readPending(correlation);
    if (!events.length) return;
    pending.delete(correlation);
    try { persistPending(correlation, []); } catch (_error) {}
    for (const event of events) {
      apply({ ...event, ...session, correlationId: correlation });
    }
  }

  function get(input) {
    const key = sessionKey(input);
    if (!key) return null;
    if (!states.has(key)) {
      const persisted = readPersisted(key);
      states.set(key, persisted || initialState(input));
    }
    return clone(states.get(key));
  }

  function getByCorrelation(correlationId) {
    const correlation = text(correlationId);
    if (!correlation) return null;
    const key = correlations.get(correlation) || readCorrelationKey(correlation);
    if (!key) return null;
    let state = states.get(key);
    if (!state) {
      state = readPersisted(key);
      if (state) states.set(key, state);
    }
    return state ? clone(state) : null;
  }

  function applyByCorrelation(correlationId, input = {}) {
    const state = getByCorrelation(correlationId);
    if (!state) return queuePending(correlationId, input);
    return apply({
      ...state.session,
      ...input,
      correlationId
    });
  }

  function apply(input = {}) {
    const event = normalizeEvent(input);
    const key = sessionKey(event.session);
    if (!key || !event.type) return { accepted: false, reason: 'invalid_event', state: null };
    const existingCorrelation = event.correlationId
      && (correlations.get(event.correlationId) || readCorrelationKey(event.correlationId));
    if (existingCorrelation && existingCorrelation !== key) {
      return { accepted: false, reason: 'correlation_conflict', state: get(event.session) };
    }
    const previous = get(event.session) || initialState(event.session);
    if (previous.recentEventIds.includes(event.eventId)) {
      return { accepted: false, reason: 'duplicate_event', state: previous };
    }
    // Hook/runtime events may omit a revision.  Those events still carry an
    // event timestamp and must remain deliverable after a revisioned event;
    // only an explicitly positive, older revision is stale.
    if (
      (event.revision > 0 && previous.revision > 0 && event.revision < previous.revision)
      || (event.revision > 0 && event.revision === previous.revision && event.at < previous.lastEventAt)
    ) {
      return { accepted: false, reason: 'stale_event', state: previous };
    }
    const next = applyTransition(previous, event);
    try {
      persist(key, next);
    } catch (_error) {
      return { accepted: false, reason: 'persist_failed', state: previous };
    }
    states.set(key, next);
    if (event.correlationId) {
      correlations.set(event.correlationId, key);
      try { persistCorrelation(event.correlationId, key); } catch (_error) {}
      drainPending(event.correlationId, event.session);
    }
    for (const listener of [...subscribers]) {
      try { listener(clone(next), clone(event)); } catch (_error) {}
    }
    return { accepted: true, reason: 'accepted', state: clone(next) };
  }

  function resolveCorrelation(correlationId) {
    const state = getByCorrelation(correlationId);
    return state ? clone(state.session) : null;
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  }

  return { apply, applyByCorrelation, get, getByCorrelation, resolveCorrelation, subscribe, sessionKey, statePath };
}

module.exports = {
  DEFAULT_MAX_RECENT_EVENTS,
  DEFAULT_MAX_PENDING_EVENTS,
  STATE_DIR,
  CORRELATION_DIR,
  PENDING_DIR,
  STATE_VERSION,
  createProviderSessionStateStore,
  normalizeEvent,
  normalizeSession,
  sessionKey
};
