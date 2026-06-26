'use strict';

const path = require('node:path');
const { defaultSessionEventBus } = require('./session-event-bus');

const DEFAULT_QUEUE_FILE_NAME = 'codex-session-notifications.jsonl';
const DEFAULT_MAX_READ_BYTES = 256 * 1024;

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeEventType(value) {
  const type = normalizeText(value);
  return type || 'session:updated';
}

function resolveCodexSessionNotificationQueuePath(aiHomeDir) {
  const root = normalizeText(aiHomeDir);
  return root ? path.join(root, DEFAULT_QUEUE_FILE_NAME) : '';
}

function resolveCodexSessionNotificationQueuePathFromStateFile(stateFile) {
  const filePath = normalizeText(stateFile);
  return filePath ? path.join(path.dirname(filePath), DEFAULT_QUEUE_FILE_NAME) : '';
}

function sanitizeNotificationEvent(event = {}) {
  const provider = normalizeText(event.provider).toLowerCase();
  const sessionId = normalizeText(event.sessionId || event.session_id);
  if (provider !== 'codex' || !sessionId) return null;
  return {
    provider,
    sessionId,
    type: normalizeEventType(event.type),
    source: normalizeText(event.source) || 'unknown',
    reason: normalizeText(event.reason),
    eventName: normalizeText(event.eventName || event.event_name),
    phase: normalizeText(event.phase),
    at: Number(event.at) || Date.now()
  };
}

function appendCodexSessionNotification(fs, queueFile, event = {}) {
  const filePath = normalizeText(queueFile);
  const payload = sanitizeNotificationEvent(event);
  if (!filePath || !payload) return false;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
    if (typeof fs.chmodSync === 'function') {
      try { fs.chmodSync(filePath, 0o600); } catch (_chmodError) {}
    }
    return true;
  } catch (_error) {
    return false;
  }
}

function parseNotificationLine(line) {
  try {
    return sanitizeNotificationEvent(JSON.parse(line));
  } catch (_error) {
    return null;
  }
}

function readCodexSessionNotificationsSince(fs, queueFile, offset = 0, options = {}) {
  const filePath = normalizeText(queueFile);
  const previousOffset = Math.max(0, Number(offset) || 0);
  if (!filePath || !fs || typeof fs.existsSync !== 'function' || !fs.existsSync(filePath)) {
    return { offset: previousOffset, events: [] };
  }

  let size = 0;
  try {
    size = Number(fs.statSync(filePath).size) || 0;
  } catch (_error) {
    return { offset: previousOffset, events: [] };
  }
  if (size <= 0) return { offset: 0, events: [] };

  const start = previousOffset > size ? 0 : previousOffset;
  const maxReadBytes = Math.max(1024, Number(options.maxReadBytes) || DEFAULT_MAX_READ_BYTES);
  const bytesToRead = Math.min(size - start, maxReadBytes);
  if (bytesToRead <= 0) return { offset: start, events: [] };

  let fd = null;
  try {
    const buffer = Buffer.alloc(bytesToRead);
    fd = fs.openSync(filePath, 'r');
    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, start);
    const text = buffer.slice(0, bytesRead).toString('utf8');
    const events = text
      .split(/\r?\n/)
      .map((line) => normalizeText(line))
      .filter(Boolean)
      .map(parseNotificationLine)
      .filter(Boolean);
    return {
      offset: start + bytesRead,
      events
    };
  } catch (_error) {
    return { offset: start, events: [] };
  } finally {
    if (fd !== null && typeof fs.closeSync === 'function') {
      try { fs.closeSync(fd); } catch (_closeError) {}
    }
  }
}

function startCodexSessionNotificationBridge(options = {}) {
  const fs = options.fs || require('fs-extra');
  const bus = options.bus || defaultSessionEventBus;
  const queueFile = normalizeText(options.queueFile)
    || resolveCodexSessionNotificationQueuePath(options.aiHomeDir);
  if (!queueFile || !bus || typeof bus.on !== 'function') {
    return { stop() {} };
  }

  const listener = (event) => {
    appendCodexSessionNotification(fs, queueFile, event);
  };
  bus.on('session', listener);
  return {
    queueFile,
    stop() {
      if (bus && typeof bus.off === 'function') {
        bus.off('session', listener);
      }
    }
  };
}

module.exports = {
  DEFAULT_QUEUE_FILE_NAME,
  appendCodexSessionNotification,
  readCodexSessionNotificationsSince,
  resolveCodexSessionNotificationQueuePath,
  resolveCodexSessionNotificationQueuePathFromStateFile,
  sanitizeNotificationEvent,
  startCodexSessionNotificationBridge
};
