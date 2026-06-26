'use strict';

const { EventEmitter } = require('node:events');
const { resolveSessionFilePath } = require('../sessions/session-reader');

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_POLL_INTERVAL_MS = 500;

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeProvider(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeSessionKey(input = {}) {
  const provider = normalizeProvider(input.provider);
  const sessionId = normalizeText(input.sessionId || input.session_id);
  const projectDirName = normalizeText(input.projectDirName || input.project_dir_name);
  const projectPath = normalizeText(input.projectPath || input.project_path);
  if (!provider || !sessionId) return '';
  return JSON.stringify({
    provider,
    sessionId,
    projectDirName,
    projectPath
  });
}

function normalizeSession(input = {}) {
  return {
    provider: normalizeProvider(input.provider),
    sessionId: normalizeText(input.sessionId || input.session_id),
    projectDirName: normalizeText(input.projectDirName || input.project_dir_name),
    projectPath: normalizeText(input.projectPath || input.project_path)
  };
}

function isCompatibleSession(session, candidate) {
  if (!session || !candidate) return false;
  if (!session.provider || !session.sessionId) return false;
  if (session.provider !== candidate.provider || session.sessionId !== candidate.sessionId) return false;
  if (session.projectDirName && candidate.projectDirName && session.projectDirName !== candidate.projectDirName) {
    return false;
  }
  if (session.projectPath && candidate.projectPath && session.projectPath !== candidate.projectPath) {
    return false;
  }
  return true;
}

function buildSessionEventPayload(session, event = {}) {
  const type = normalizeText(event.type) || 'session:update';
  const projectDirName = normalizeText(event.projectDirName || event.project_dir_name) || session.projectDirName;
  const projectPath = normalizeText(event.projectPath || event.project_path) || session.projectPath;
  const payload = {
    type,
    provider: session.provider,
    sessionId: session.sessionId,
    projectDirName,
    projectPath,
    source: normalizeText(event.source) || 'unknown',
    reason: normalizeText(event.reason) || '',
    at: Number(event.at) || Date.now()
  };
  const eventName = normalizeText(event.eventName || event.event_name);
  const phase = normalizeText(event.phase);
  const transcriptPath = normalizeText(event.transcriptPath || event.transcript_path);
  const cwd = normalizeText(event.cwd);
  const turnId = normalizeText(event.turnId || event.turn_id);
  if (eventName) payload.eventName = eventName;
  if (phase) payload.phase = phase;
  if (transcriptPath) payload.transcriptPath = transcriptPath;
  if (cwd) payload.cwd = cwd;
  if (turnId) payload.turnId = turnId;
  return payload;
}

function createSessionEventBus(options = {}) {
  const fs = options.fs || require('fs-extra');
  const resolvePath = typeof options.resolveSessionFilePath === 'function'
    ? options.resolveSessionFilePath
    : resolveSessionFilePath;
  const debounceMs = Math.max(0, Number(options.debounceMs) || DEFAULT_DEBOUNCE_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS);
  const emitter = new EventEmitter();
  const entries = new Map();

  function getOrCreateEntry(session) {
    const key = normalizeSessionKey(session);
    if (!key) return null;
    let entry = entries.get(key);
    if (entry) return entry;
    entry = {
      key,
      session: normalizeSession(session),
      subscribers: new Set(),
      watcher: null,
      poller: null,
      debounceTimer: null,
      watchPath: '',
      lastMtimeMs: 0
    };
    entries.set(key, entry);
    return entry;
  }

  function publish(session, event = {}) {
    const normalizedSession = normalizeSession(session);
    const key = normalizeSessionKey(normalizedSession);
    if (!key) return false;
    const matchingEntries = [...entries.values()]
      .filter((entry) => isCompatibleSession(normalizedSession, entry.session));
    const fallbackSession = matchingEntries[0] ? matchingEntries[0].session : normalizedSession;
    const payload = buildSessionEventPayload(fallbackSession, event);
    emitter.emit('session', payload);
    if (matchingEntries.length === 0) return true;
    for (const entry of matchingEntries) {
      const entryPayload = entry.session === fallbackSession
        ? payload
        : buildSessionEventPayload(entry.session, event);
      for (const listener of [...entry.subscribers]) {
        try {
          listener(entryPayload);
        } catch (_error) {
          entry.subscribers.delete(listener);
        }
      }
    }
    return true;
  }

  function emitFileChanged(entry) {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      publish(entry.session, {
        type: 'session:file-changed',
        source: 'watcher',
        reason: 'file_changed'
      });
    }, debounceMs);
    if (typeof entry.debounceTimer.unref === 'function') entry.debounceTimer.unref();
  }

  function statMtimeMs(filePath) {
    try {
      return Number(fs.statSync(filePath).mtimeMs) || 0;
    } catch (_error) {
      return 0;
    }
  }

  function startFileWatch(entry) {
    if (!entry || entry.watcher || entry.poller) return false;
    const watchPath = resolvePath(entry.session.provider, {
      sessionId: entry.session.sessionId,
      projectDirName: entry.session.projectDirName
    });
    if (!watchPath || !fs.existsSync(watchPath)) return false;

    entry.watchPath = watchPath;
    entry.lastMtimeMs = statMtimeMs(watchPath);
    try {
      entry.watcher = fs.watch(watchPath, () => {
        const nextMtimeMs = statMtimeMs(watchPath);
        if (nextMtimeMs > entry.lastMtimeMs) entry.lastMtimeMs = nextMtimeMs;
        emitFileChanged(entry);
      });
    } catch (_error) {
      entry.watcher = null;
    }

    entry.poller = setInterval(() => {
      const nextMtimeMs = statMtimeMs(watchPath);
      if (nextMtimeMs > entry.lastMtimeMs) {
        entry.lastMtimeMs = nextMtimeMs;
        emitFileChanged(entry);
      }
    }, pollIntervalMs);
    if (typeof entry.poller.unref === 'function') entry.poller.unref();
    return true;
  }

  function stopEntry(entry) {
    if (!entry) return;
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = null;
    if (entry.watcher) {
      try { entry.watcher.close(); } catch (_error) {}
      entry.watcher = null;
    }
    if (entry.poller) {
      clearInterval(entry.poller);
      entry.poller = null;
    }
    entries.delete(entry.key);
  }

  function subscribe(session, listener, options = {}) {
    const entry = getOrCreateEntry(session);
    if (!entry || typeof listener !== 'function') return () => {};
    entry.subscribers.add(listener);
    if (options.watchFile !== false) startFileWatch(entry);
    return () => {
      entry.subscribers.delete(listener);
      if (entry.subscribers.size === 0) stopEntry(entry);
    };
  }

  function getStats() {
    return {
      sessions: entries.size,
      subscribers: [...entries.values()].reduce((count, entry) => count + entry.subscribers.size, 0),
      watchedFiles: [...entries.values()].filter((entry) => entry.watcher || entry.poller).length
    };
  }

  function close() {
    for (const entry of [...entries.values()]) stopEntry(entry);
    emitter.removeAllListeners();
  }

  return {
    close,
    getStats,
    normalizeSessionKey,
    publish,
    subscribe,
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter)
  };
}

const defaultSessionEventBus = createSessionEventBus();

module.exports = {
  createSessionEventBus,
  defaultSessionEventBus,
  normalizeSessionKey
};
