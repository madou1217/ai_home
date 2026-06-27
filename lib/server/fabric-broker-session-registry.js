'use strict';

const crypto = require('node:crypto');

function defaultSessionId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

function normalizeFabricServerId(value) {
  const raw = String(value || '').trim().toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .slice(0, 64);
  if (/^[a-z0-9][a-z0-9_.-]{1,63}$/.test(raw)) return raw;
  return '';
}

function serializeBrokerSession(session) {
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    serverId: session.serverId,
    remoteAddress: session.remoteAddress,
    connectedAt: session.connectedAt,
    lastSeenAt: session.lastSeenAt
  };
}

function createFabricBrokerSessionRegistry(options = {}) {
  const sessionsById = new Map();
  const sessionsByServer = new Map();
  const nowMs = typeof options.nowMs === 'function' ? options.nowMs : Date.now;
  const createSessionId = typeof options.createSessionId === 'function'
    ? options.createSessionId
    : defaultSessionId;

  function removeBrokerSession(sessionId, removeOptions = {}) {
    const id = String(sessionId || '').trim();
    const session = sessionsById.get(id);
    if (!session) return null;
    sessionsById.delete(id);
    if (sessionsByServer.get(session.serverId) === session) {
      sessionsByServer.delete(session.serverId);
    }
    if (removeOptions.closeSocket && session.socket && typeof session.socket.close === 'function') {
      try {
        session.socket.close(4000, 'broker_session_replaced');
      } catch (_error) {}
    }
    return serializeBrokerSession(session);
  }

  function registerBrokerSession(input = {}) {
    const serverId = normalizeFabricServerId(input.serverId);
    if (!serverId) {
      const error = new Error('invalid_broker_server_id');
      error.code = 'invalid_broker_server_id';
      throw error;
    }
    const sessionId = String(input.sessionId || createSessionId()).trim();
    if (!sessionId) {
      const error = new Error('invalid_broker_session_id');
      error.code = 'invalid_broker_session_id';
      throw error;
    }
    const previous = sessionsByServer.get(serverId);
    if (previous) removeBrokerSession(previous.sessionId, { closeSocket: true });

    const now = nowMs();
    const session = {
      sessionId,
      serverId,
      socket: input.socket || null,
      remoteAddress: String(input.remoteAddress || '').trim(),
      connectedAt: now,
      lastSeenAt: now
    };
    sessionsById.set(session.sessionId, session);
    sessionsByServer.set(serverId, session);
    return session;
  }

  function touchBrokerSession(sessionId) {
    const session = sessionsById.get(String(sessionId || '').trim());
    if (!session) return null;
    session.lastSeenAt = nowMs();
    return serializeBrokerSession(session);
  }

  function getBrokerSession(serverId) {
    return sessionsByServer.get(normalizeFabricServerId(serverId)) || null;
  }

  function listBrokerSessions() {
    return Array.from(sessionsById.values()).map(serializeBrokerSession);
  }

  function closeAll() {
    Array.from(sessionsById.keys()).forEach((sessionId) => {
      removeBrokerSession(sessionId, { closeSocket: true });
    });
  }

  return {
    registerBrokerSession,
    touchBrokerSession,
    getBrokerSession,
    listBrokerSessions,
    removeBrokerSession,
    closeAll
  };
}

module.exports = {
  createFabricBrokerSessionRegistry,
  normalizeFabricServerId,
  serializeBrokerSession
};
