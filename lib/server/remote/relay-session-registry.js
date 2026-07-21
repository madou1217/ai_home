'use strict';

const crypto = require('node:crypto');
const { normalizeId } = require('./node-registry');

function defaultSessionId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

function serializeSession(session) {
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    nodeId: session.nodeId,
    transportId: session.transportId,
    remoteAddress: session.remoteAddress,
    connectedAt: session.connectedAt,
    lastSeenAt: session.lastSeenAt
  };
}

function createRelaySessionRegistry(options = {}) {
  const sessionsById = new Map();
  const sessionsByNode = new Map();
  const nowMs = typeof options.nowMs === 'function' ? options.nowMs : Date.now;
  const createSessionId = typeof options.createSessionId === 'function'
    ? options.createSessionId
    : defaultSessionId;

  function removeRelaySession(sessionId, removeOptions = {}) {
    const id = String(sessionId || '').trim();
    const session = sessionsById.get(id);
    if (!session) return null;
    sessionsById.delete(id);
    if (sessionsByNode.get(session.nodeId) === session) {
      sessionsByNode.delete(session.nodeId);
    }
    if (removeOptions.closeSocket && session.socket && typeof session.socket.close === 'function') {
      try {
        session.socket.close(4000, 'relay_session_replaced');
      } catch (_error) {}
    }
    return serializeSession(session);
  }

  function registerRelaySession(input = {}) {
    const nodeId = normalizeId(input.nodeId);
    if (!nodeId) {
      const error = new Error('invalid_relay_node_id');
      error.code = 'invalid_relay_node_id';
      throw error;
    }
    const sessionId = String(input.sessionId || createSessionId()).trim();
    if (!sessionId) {
      const error = new Error('invalid_relay_session_id');
      error.code = 'invalid_relay_session_id';
      throw error;
    }
    const previous = sessionsByNode.get(nodeId);
    if (previous) removeRelaySession(previous.sessionId, { closeSocket: true });

    const now = nowMs();
    const session = {
      sessionId,
      nodeId,
      transportId: String(input.transportId || `${nodeId}-relay`).trim(),
      socket: input.socket || null,
      remoteAddress: String(input.remoteAddress || '').trim(),
      connectedAt: now,
      lastSeenAt: now
    };
    sessionsById.set(session.sessionId, session);
    sessionsByNode.set(nodeId, session);
    return session;
  }

  function touchRelaySession(sessionId) {
    const session = sessionsById.get(String(sessionId || '').trim());
    if (!session) return null;
    session.lastSeenAt = nowMs();
    return serializeSession(session);
  }

  function getRelaySession(nodeId) {
    return sessionsByNode.get(normalizeId(nodeId)) || null;
  }

  function listRelaySessions() {
    return Array.from(sessionsById.values()).map(serializeSession);
  }

  function closeAll() {
    Array.from(sessionsById.keys()).forEach((sessionId) => {
      removeRelaySession(sessionId, { closeSocket: true });
    });
  }

  return {
    registerRelaySession,
    touchRelaySession,
    getRelaySession,
    listRelaySessions,
    removeRelaySession,
    closeAll
  };
}

module.exports = {
  createRelaySessionRegistry,
  serializeSession
};
